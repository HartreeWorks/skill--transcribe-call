---
name: transcribe-call
description: Record and transcribe meetings/calls. Use when user says "transcribe call", "transcribe meeting", "record call", "start transcription", "start recording". To stop recording and get transcript, user says "end transcription", "stop recording", "summarize call", "end call", "done with call".
---

# Transcribe Call Skill

Record system audio during meetings/calls, then transcribe and summarize.

## Directory Structure

```
~/.claude/skills/transcribe-call/
├── recording-session.json  # Active recording state (transient)
├── audio/                  # Recorded audio files (MP3)
├── transcripts/            # Raw transcription text files
└── summaries/              # Markdown summaries
```

## Prerequisites

- **BlackHole 2ch** virtual audio driver installed:
  ```bash
  brew install --cask blackhole-2ch
  ```
- **Multi-Output Device** configured in Audio MIDI Setup:
  1. Open Audio MIDI Setup (Spotlight: "Audio MIDI Setup")
  2. Click "+" → "Create Multi-Output Device"
  3. Check both your speakers/headphones AND "BlackHole 2ch"
  4. Right-click → "Use This Device For Sound Output"
- `ffmpeg` for recording
- **transcribe-audio skill** for transcription

## State File

Recording state is stored in `~/.claude/skills/transcribe-call/recording-session.json`:

```json
{
  "task_id": "background_task_id",
  "started_at": "2025-12-23T10:30:00Z",
  "output_file": "/Users/ph/.claude/skills/transcribe-call/audio/2025-12-23-1030-meeting-title.mp3",
  "meeting_title": "Q4 Planning Call"
}
```

---

## Workflow: Start Recording

Use this workflow when user says: "transcribe call", "transcribe meeting", "record call", "start transcription"

### Step 1: Check for existing recording

```bash
cat ~/.claude/skills/transcribe-call/recording-session.json 2>/dev/null
```

If file exists and contains valid data, inform user: "A recording is already in progress: '[meeting_title]'. Say 'end transcription' to stop it first."

### Step 2: Get meeting title from Google Calendar

Use the **browser-automation** skill to check Google Calendar:

1. Navigate to https://calendar.google.com
2. Look for a current event (happening now) or an event starting within the next 10 minutes
3. Extract the event title

If browser-automation is unavailable or no event found, use fallback: `YYYY-MM-DD-HHMM-meeting`

### Step 3: Generate filename

```bash
DATETIME=$(date +%Y-%m-%d-%H%M)
# If meeting title found, create slug
SLUG=$(echo "$MEETING_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
FILENAME="${DATETIME}-${SLUG}"
OUTPUT_FILE="$HOME/.claude/skills/transcribe-call/audio/${FILENAME}.mp3"
```

### Step 4: Start ffmpeg recording in background

Run ffmpeg with `run_in_background: true`:

```bash
ffmpeg -f avfoundation -i ":BlackHole 2ch" \
  -c:a libmp3lame -q:a 2 \
  -y "${OUTPUT_FILE}"
```

Note the task_id returned from the background execution.

### Step 5: Save recording state

Write to `~/.claude/skills/transcribe-call/recording-session.json`:

```json
{
  "task_id": "<task_id_from_step_4>",
  "started_at": "<ISO_timestamp>",
  "output_file": "<full_path_to_mp3>",
  "meeting_title": "<extracted_or_default_title>"
}
```

### Step 6: Confirm to user

Display: "Recording '[meeting_title]' started. Say 'end transcription' or 'stop recording' when your call is done."

---

## Workflow: End Recording

Use this workflow when user says: "end transcription", "stop recording", "summarize call", "end call", "done with call"

### Step 1: Check recording state

```bash
cat ~/.claude/skills/transcribe-call/recording-session.json
```

If file doesn't exist or is empty, inform user: "No recording in progress. Say 'transcribe call' to start one."

### Step 2: Stop the ffmpeg process

Use the KillShell tool with the task_id from recording-session.json to stop the recording gracefully. This allows ffmpeg to finalize the MP3 file properly.

Wait a moment for the file to be finalized.

### Step 3: Verify recording file

```bash
ls -la "${OUTPUT_FILE}"
ffprobe -hide_banner "${OUTPUT_FILE}" 2>&1 | head -5
```

Check duration and file size to confirm recording was captured.

### Step 4: Invoke transcribe-audio skill

Invoke the **transcribe-audio** skill:
- **Audio file**: The output_file from recording-session.json
- **Output directory**: `~/.claude/skills/transcribe-call/transcripts`

Read the generated transcript.

### Step 5: Calculate duration

```bash
# Get duration from ffprobe
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${OUTPUT_FILE}" 2>/dev/null)
# Convert to minutes
MINUTES=$(echo "scale=0; $DURATION / 60" | bc)
```

### Step 6: Generate full structured summary

Read the transcript and create a markdown summary at:
`~/.claude/skills/transcribe-call/summaries/${FILENAME}.md`

**Summary Template:**

```markdown
# [Meeting Title]

**Date:** YYYY-MM-DD HH:MM
**Duration:** X minutes
**Audio:** [relative path to audio file]
**Transcript:** [relative path to transcript file]

## Summary

[2-3 paragraph overview of the meeting/call content]

## Key Points

- [Main point 1]
- [Main point 2]
- [Main point 3]
...

## Decisions Made

- [Decision 1]
- [Decision 2]
(If no clear decisions, note "No explicit decisions recorded")

## Action Items

- [ ] [Action item 1] (Owner if identifiable)
- [ ] [Action item 2]
(If no clear action items, note "No explicit action items identified")

## Questions Raised

- [Question 1]
- [Question 2]
(If no questions, omit this section)

## Participants

[List participants if identifiable from the conversation, otherwise note "Participants not clearly identifiable from audio"]
```

### Step 7: Cleanup recording state

```bash
rm ~/.claude/skills/transcribe-call/recording-session.json
```

### Step 8: Display summary to user

Display the full markdown summary content directly in the chat so the user can:
- Read the summary immediately
- Discuss the content
- Ask follow-up questions

Also report file locations:
- Audio: `~/.claude/skills/transcribe-call/audio/${FILENAME}.mp3`
- Transcript: `~/.claude/skills/transcribe-call/transcripts/${FILENAME}.txt`
- Summary: `~/.claude/skills/transcribe-call/summaries/${FILENAME}.md`

---

## Troubleshooting

### "No audio device found" or silent recording

1. Verify BlackHole is installed: `brew list --cask | grep blackhole`
2. Check Audio MIDI Setup has Multi-Output Device configured
3. Verify Multi-Output Device is set as system output
4. Test with: `ffmpeg -f avfoundation -list_devices true -i ""`

### Recording is silent

- Ensure your meeting audio is playing through the Multi-Output Device
- Some apps (like Zoom, Teams) may need their audio output explicitly set

### Short/truncated recording

- The KillShell command sends SIGTERM which should allow ffmpeg to finalize
- If issues persist, try waiting a few seconds after stopping before processing

## Notes

- Recordings are in MP3 format for reasonable file sizes
- Transcription uses Parakeet MLX via the transcribe-audio skill
- English only (Parakeet is optimized for English)
- First transcription run downloads the Parakeet model (~1.2GB)

## Update check

This is a shared skill. Before executing, check `~/.claude/skills/.update-config.json`.
If `auto_check_enabled` is true and `last_checked_timestamp` is older than `check_frequency_days`,
mention: "It's been a while since skill updates were checked. Run `/update-skills` to see available updates."
Do NOT perform network operations - just check the local timestamp.
