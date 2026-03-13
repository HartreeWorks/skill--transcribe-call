#!/usr/bin/env python3
"""Meet Recorder — local HTTP server that records calls via ScreenCaptureKit.
Recording stops automatically when the call ends; post-processing (transcription,
summary, filing) is handled interactively by Claude via the transcribe-call skill."""

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 7777
TRANSCRIPT_DIR = os.path.expanduser("~/.agents/skills/transcribe-call/transcripts")
AUDIO_DIR = os.path.expanduser("~/.agents/skills/transcribe-call/audio")
SESSION_FILE = os.path.expanduser("~/.agents/skills/transcribe-call/recording-session.json")
RECORDER_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "meet-recorder-audio")
CLAUDE_PROMPT_SCRIPT = os.path.expanduser("~/.agents/scripts/raycast/claude-prompt.sh")

# Ensure subprocesses can find tools (launchd has minimal PATH)
SUBPROCESS_ENV = {**os.environ, "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.environ.get("PATH", "")}

# Global state
recorder_process = None
recording_info = None


def slugify(text):
    """Convert text to a filename-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    return text or "meeting"


def extract_meet_code(url):
    """Extract the meeting code from a Google Meet URL."""
    match = re.search(r"meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})", url or "")
    return match.group(1) if match else None


def generate_basename(title, url):
    """Generate a timestamped base filename (no extension)."""
    dt = datetime.now().strftime("%Y-%m-%d-%H%M")
    if title and title.strip():
        slug = slugify(title)
    else:
        code = extract_meet_code(url)
        slug = code if code else "meeting"
    return f"{dt}-{slug}"


def start_recording(meeting_title, meeting_url):
    global recorder_process, recording_info

    if recorder_process and recorder_process.poll() is None:
        return None, "Already recording"

    basename = generate_basename(meeting_title, meeting_url)
    audio_path = os.path.join(AUDIO_DIR, f"{basename}.m4a")
    transcript_path = os.path.join(TRANSCRIPT_DIR, f"{basename}.md")
    os.makedirs(AUDIO_DIR, exist_ok=True)
    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)

    started_at = datetime.now(timezone.utc).isoformat()

    # Record system audio + mic via ScreenCaptureKit
    recorder_process = subprocess.Popen(
        [RECORDER_BIN, audio_path],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    # Check for immediate failure
    time.sleep(1.0)
    if recorder_process.poll() is not None:
        stderr_out = recorder_process.stderr.read().decode() if recorder_process.stderr else ""
        recorder_process = None
        return None, f"Recorder failed to start: {stderr_out.strip()}"

    recording_info = {
        "file": transcript_path,
        "audio_file": audio_path,
        "started_at": started_at,
        "meeting_title": meeting_title or "",
        "meeting_url": meeting_url or "",
        "pid": recorder_process.pid,
    }

    with open(SESSION_FILE, "w") as f:
        json.dump({
            "pid": recorder_process.pid,
            "started_at": started_at,
            "audio_file": audio_path,
            "transcript_file": transcript_path,
            "meeting_title": meeting_title or "",
        }, f, indent=2)

    return recording_info, None


def stop_recording():
    global recorder_process, recording_info

    if not recorder_process or recorder_process.poll() is not None:
        cleanup_state()
        return None, "Not recording"

    info = recording_info.copy()
    started = datetime.fromisoformat(info["started_at"])
    duration = (datetime.now(timezone.utc) - started).total_seconds()

    # SIGINT triggers graceful shutdown (finalises M4A container)
    recorder_process.send_signal(signal.SIGINT)
    try:
        recorder_process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        recorder_process.kill()
        recorder_process.wait(timeout=2)

    cleanup_state()
    _launch_process_notes()

    audio_path = info["audio_file"]
    return {
        "status": "stopped",
        "audio_file": audio_path,
        "duration_seconds": round(duration, 1),
    }, None


def _launch_process_notes():
    """Open Warp with Claude Code ready to process the call notes."""
    subprocess.Popen([
        "/bin/bash",
        CLAUDE_PROMPT_SCRIPT,
        "transcribe call",
    ])


def cleanup_state():
    global recorder_process, recording_info
    recorder_process = None
    recording_info = None
    try:
        os.remove(SESSION_FILE)
    except FileNotFoundError:
        pass


def get_status():
    global recorder_process, recording_info

    if recorder_process and recorder_process.poll() is not None:
        cleanup_state()

    if not recorder_process or not recording_info:
        return {"status": "idle"}

    started = datetime.fromisoformat(recording_info["started_at"])
    duration = (datetime.now(timezone.utc) - started).total_seconds()

    return {
        "status": "recording",
        "file": recording_info["file"],
        "started_at": recording_info["started_at"],
        "duration_seconds": round(duration, 1),
        "meeting_title": recording_info.get("meeting_title", ""),
    }


class Handler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json_response(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            self._json_response(200, get_status())
        else:
            self._json_response(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/start":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length)) if content_length else {}

            info, err = start_recording(
                body.get("meeting_title", ""),
                body.get("meeting_url", ""),
            )
            if err:
                self._json_response(409, {"error": err})
            else:
                self._json_response(200, {
                    "status": "recording",
                    "file": info["file"],
                    "started_at": info["started_at"],
                })

        elif self.path == "/stop":
            result, err = stop_recording()
            if err:
                self._json_response(404, {"error": err})
            else:
                self._json_response(200, result)

        else:
            self._json_response(404, {"error": "Not found"})

    def log_message(self, format, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {format % args}")


def restore_state():
    """On startup, check if there's an existing recorder process from a previous session."""
    global recorder_process, recording_info
    try:
        with open(SESSION_FILE) as f:
            session = json.load(f)
        pid = session.get("pid")
        if pid:
            os.kill(pid, 0)
            recorder_process = subprocess.Popen.__new__(subprocess.Popen)
            recorder_process.pid = pid
            recorder_process.returncode = None
            recorder_process._child_created = True
            recording_info = {
                "file": session.get("transcript_file", ""),
                "audio_file": session.get("audio_file", ""),
                "started_at": session["started_at"],
                "meeting_title": session.get("meeting_title", ""),
                "meeting_url": "",
                "pid": pid,
            }
            print(f"Recovered existing recording session (PID {pid})")
    except (FileNotFoundError, json.JSONDecodeError, ProcessLookupError, KeyError):
        cleanup_state()


if __name__ == "__main__":
    # Ensure print output is visible in launchd logs
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    os.makedirs(AUDIO_DIR, exist_ok=True)
    restore_state()

    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True

    server = ReusableHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Meet Recorder server listening on http://127.0.0.1:{PORT}")

    def handle_signal(sig, frame):
        print("\nShutting down...")
        if recorder_process and recorder_process.poll() is None:
            recorder_process.send_signal(signal.SIGINT)
            try:
                recorder_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                recorder_process.kill()
        server.shutdown()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        handle_signal(None, None)
