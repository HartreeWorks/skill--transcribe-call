---
name: transcribe-call
description: 'This skill should be used when the user says "transcribe call", "transcribe my call", "start recording", "record this call", "stop recording", or "end recording". Handles manual recording start/stop and full post-processing of recorded calls: transcription → tidied transcript → summary → project filing + email/Slack.'
---

# Transcribe call

Record and post-process calls. The Chrome extension handles Google Meet automatically.
For other call types (WhatsApp, Zoom, phone), use the manual start/stop commands in this
skill. Post-processing (transcription, summary, filing) is always Claude-driven.

## Architecture

```
Chrome extension (extension/)          ← automatic, Google Meet only
  └── Detects join/leave → calls /start and /stop on the server

Manual commands (this skill)           ← for WhatsApp, Zoom, phone, etc.
  └── "start recording" → POST /start
  └── "stop recording"  → POST /stop → hands off to "Process call notes"

Local HTTP server (server/server.py) on port 7777
  └── Records via ScreenCaptureKit binary → M4A
  └── On manual stop: Claude runs post-processing in the same session

This skill (Claude-driven)
  └── Transcription pipeline → speaker ID → tidy → summary → file → share
```

## File locations

```
~/.agents/skills/transcribe-call/
├── audio/              <slug>.m4a                  recorded audio
├── transcripts/        <slug>.md                   raw speaker-labelled transcript
│                       <slug>.raw.md               filler-word backup (kept)
├── tidied-transcripts/ <new-slug>--transcript.md   tidied version
└── summaries/          <new-slug>--summary.md      summary

~/.agents/data/people.json                          shared people registry
```

Filename format: `YYYY-MM-DD-HHMM-<slug>` (meeting title lowercased, punctuation → hyphens,
or Meet code e.g. `abc-defg-hij`).

---

## Workflow: Process call notes

Triggered by: "transcribe call", "transcribe my call"

### Step 1: Find the recording

```bash
ls -t ~/.agents/skills/transcribe-call/audio/*.m4a 2>/dev/null | head -5
```

Check whether a transcript already exists for the most recent M4A:

```bash
ls ~/.agents/skills/transcribe-call/transcripts/ 2>/dev/null
```

If a `.md` transcript already exists for this recording, skip to Step 3.

### Step 1b: Trim silence

Before transcribing, trim silence from the start and end of the audio file. This is important when recording was accidentally left running after the call ended.

```bash
# Get duration before trimming
duration_before=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 <audio_path>)

# Back up original before modifying it
cp <audio_path> <audio_path>.backup.m4a

# Trim silence using double-reverse technique:
# - Start: removes leading silence (>0.5s below -40dB)
# - End: reverses audio, removes the FIRST (and only the first) silence block
#   from the start of the reversed audio = the LAST trailing silence in the original.
#   start_periods=1 ensures only the final silence is removed — any silence
#   in the middle of the recording (e.g. bathroom break) is left intact.
#   30s threshold: enough to distinguish a genuine end-of-call from a brief
#   trailing pause, without needing a large threshold (start_periods=1 already
#   ensures mid-recording silences are never touched).
ffmpeg -y -i <audio_path> \
  -af "silenceremove=start_periods=1:start_silence=0.5:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_silence=30:start_threshold=-40dB,areverse" \
  -c:a aac -b:a 128k \
  /tmp/trimmed_audio.m4a

# Get duration after trimming
duration_after=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 /tmp/trimmed_audio.m4a)

# Replace original with trimmed file
mv /tmp/trimmed_audio.m4a <audio_path>
```

Report duration before and after (in minutes), e.g.: "Trimmed 34 min 12 sec → 28 min 45 sec (removed 5 min 27 sec of silence). Backup saved at `<audio_path>.backup.m4a`."

If ffmpeg is not available (`command -v ffmpeg` returns nothing), skip this step and warn Peter.

### Step 2: Run transcription pipeline

Execute all four stages, reporting progress at each step.

**Stage 1 — Parakeet speech-to-text:**

```bash
~/.local/bin/parakeet-mlx --output-format srt \
  --output-dir ~/.agents/skills/transcribe-call/transcripts/ \
  <audio_path>
```

**Stage 2 — FluidAudio speaker diarisation:**

```bash
~/.local/bin/fluidaudio process <audio_path> \
  --output <transcripts_dir>/<basename>_speakers.json \
  --threshold 0.5
```

If FluidAudio fails, fall back to SRT-only (no speaker labels) and skip Stage 3.

**Stage 3 — Align speakers with transcript:**

```bash
python3 ~/.claude/skills/transcribe-audio/scripts/align_speakers.py \
  <srt_path> <speakers_json> <transcript_md_path>
```

**Stage 4 — Clean filler words:**

```bash
python3 ~/.claude/skills/transcribe-audio/scripts/cleanup_filler_words.py \
  <transcript_md_path> --backup
```

The `--backup` flag saves `<basename>.raw.md` before editing in-place.

After all stages, remove intermediate files:
```bash
trash <srt_path> <speakers_json>
```

### Step 3: Identify participants

**Delegate the research part to a Sonnet subagent** — pass the transcript, the recording timestamp, and the calendar date. The subagent should run the calendar lookup, scan the transcript for name mentions, and return a proposed speaker mapping. Opus then presents the mapping for confirmation (AskUserQuestion) before proceeding.

Use three sources in order:

**1. Calendar lookup:**

```bash
gog cal events --from <date> --to <date+1> --account pete.hartree@gmail.com
```

Find the event closest to the recording's `started_at` timestamp (from
`~/.agents/skills/transcribe-call/recording-session.json` if present, else M4A mtime).
Extract attendees.

**2. Transcript scanning:**

Read the transcript for name mentions (introductions, direct address).

**3. Fallback:** Ask Peter directly.

Show a brief excerpt and proposed mapping:

```
"Speaker 1" → Peter Hartree (your voice, microphone)
"Speaker 2" → Valerie Richmond (from calendar: Montpellier UX call)
```

Ask for confirmation or corrections before proceeding.

### Step 4: Rename files to descriptive slug

Once participants are confirmed, generate a new slug:

```
YYYY-MM-DD-HHMM-<other-person-firstname>-<other-person-lastname>-and-peter-hartree
```

Rename (not copy) the M4A and transcript `.md` to the new slug. Keep the `.raw.md`
backup with its original name.

### Step 5: Create tidied transcript

**Delegate this step to a Sonnet subagent** — it is a mechanical rewriting task that does not require Opus-level reasoning. Pass the full raw transcript and the rules below. The subagent should write the output file directly.

Save to `~/.agents/skills/transcribe-call/tidied-transcripts/<new-slug>--transcript.md`

**Preserve exact wording (in quotation marks) for:**
- Expressions of certainty/uncertainty ("very confident", "probably", "70% sure", "I think")
- Commitments and decisions ("I will", "we've decided", "I promise")
- Memorable or distinctive phrasing
- Technical specifications, numbers, data points
- Emotional or emphatic statements

**For everything else:**
- Lightly paraphrase for clarity and concision
- Combine fragmented thoughts into coherent points
- Group related back-and-forth exchanges
- Fix transcription errors

**Format:**
- `**First Name:**` speaker labels (bold name, first name only for 1:1 calls)
- Separate each conversation turn with a new paragraph (not just a line break)
- Direct quotes in "quotation marks"
- Bullet points for lists or multiple related points

### Step 6: Create summary

Save to `~/.agents/skills/transcribe-call/summaries/<new-slug>--summary.md`

Use this structure:

```markdown
# Meeting summary: [Title]

**Date:** YYYY-MM-DD

**Participants:** [Full names with roles if relevant]

---

## Summary

[3–5 sentence overview of what the call was about and what was concluded.]

---

## Part 1: [Opening topic/context]

[Chronological narrative...]

---

## Part N: The path forward

[Clear statement of decisions and actions]

**Specific actions agreed:**
1. First action
2. Second action

---

## Appendix 1: Open questions

- Question 1

---

## Appendix 2: Key quotes

| Speaker | Quote | Context |
|---------|-------|---------|
| Name | "Quote text" | Brief context |

---

## Appendix 3: Underlying dynamics

[Optional — include when there's important subtext. Skip if not applicable.]
```

**Depth:** Match to the richness of the conversation. A substantive 45-minute discussion
warrants 150–200+ lines; a brief check-in might need only 50.

**Chronological narrative:** Tell the story of how the conversation unfolded, including the
reasoning and realisations that led to conclusions.

### Step 7: Associate with project

**Step 7a: Check the people registry**

1. Extract the other participant's name
2. Convert to key format: lowercase, hyphenated (e.g., "Jane Smith" → "jane-smith")
3. Check the registry:
   ```bash
   cat ~/.agents/data/people.json
   ```
4. If `default_project` exists → auto-associate silently (note in final output)

**Step 7b: If not registered → show project list**

```bash
python3 "/Users/ph/Documents/www/Claude Plugins/plugins/plugin--project-management/scripts/list_projects.py" --format json
```

Filter to `status: "active"` projects. Use AskUserQuestion to let Peter choose, or select "None".

**Step 7c: Copy files to project**

```bash
mkdir -p ~/Documents/Projects/{folder}/calls/summaries
mkdir -p ~/Documents/Projects/{folder}/calls/transcripts
cp ~/.agents/skills/transcribe-call/summaries/<slug>--summary.md \
   ~/Documents/Projects/{folder}/calls/summaries/
cp ~/.agents/skills/transcribe-call/tidied-transcripts/<slug>--transcript.md \
   ~/Documents/Projects/{folder}/calls/transcripts/
```

Then open the summary file:

```bash
open "/Users/ph/Documents/Projects/{folder}/calls/summaries/<slug>--summary.md"
```

### Step 8: Google Doc, then Email / Slack

**Skip for group calls (>2 participants).**

**Step 8a: Add summary to Google Doc** (always do this first, automatically)

If a meeting doc exists for this person, add the summary to it **before** asking about
email/Slack. This is not optional — do it automatically whenever a meeting doc is available.

- Look up meeting doc in `people.json` (field: `meeting_doc`) or via `gdoc find "ph-{initials}" --title`
  (IMPORTANT: always use `--title` flag — without it, short queries like "ph-ps" trigger full-text
  content search which hangs indefinitely)
- Check if a "Call summaries" tab exists:
  ```bash
  gdoc tabs <doc_id> --json
  ```
  If no tab with title exactly "Call summaries" exists, create it:
  ```bash
  gdoc add-tab <doc_id> --title "Call summaries"
  ```
- Read the summary from the **summary file on disk** (e.g.
  `~/.agents/skills/transcribe-call/summaries/<slug>--summary.md`). Do NOT write a new or
  condensed version — always use the full summary text from the file.
- Transform the summary for the Google Doc:
  - Strip `---` dividers
  - Replace `# Meeting summary: [title]\n\n**Date:** YYYY-MM-DD\n\n**Participants:** ...` with just `# YYYY-MM-DD`
  - No blank line between `# YYYY-MM-DD` and first `## Summary`
  - Proper markdown (`##`, `**bold**`, `- bullets`, `| tables |`)
- Read the "Call summaries" tab to find anchor text:
  ```bash
  gdoc cat <doc_id> --tab "Call summaries" > /tmp/gdoc-tab-content.txt
  ```
- Prepare `/tmp/gdoc-old.txt` (first line of existing tab content as anchor)
- Prepare `/tmp/gdoc-new.txt` (transformed summary + anchor — append anchor text as final line)
- Push: `gdoc edit <doc_id> --tab "Call summaries" --old-file /tmp/gdoc-old.txt --new-file /tmp/gdoc-new.txt`

**Step 8b: Ask about email / Slack**

After the Google Doc is updated (or if no meeting doc exists), use `AskUserQuestion` with
`multiSelect: true`:
- "Send call notes email to [Name]"
- "Send call notes Slack DM to [Name]"
- "Skip"

**Step 8c: Send call notes email** (if selected)

1. Find tab URL: `gdoc tabs <doc_id> --json` → find "Call summaries" tab → construct URL
2. Find email: check `people.json` → else search Gmail → else ask Peter
3. Ask if Peter wants to add a comment (optional free text)
4. Preview and confirm, then send:
   ```bash
   cd ~/.agents/skills/send-email && node send-email.js "<to>" "Call notes" "<message>"
   ```
   Message format:
   ```
   Hi <first name>,

   Summary of our call here:
   <call_summaries_tab_url>

   [<optional comment>]

   All the best,
   Peter
   ```

**Step 8d: Send call notes Slack DM** (if selected)

1. Find channel: check `people.json` (`slack_dm_channel`) → else `python3 ~/.agents/skills/slack/scripts/slack_client.py channels "im"`
2. Compose message (no greeting/sign-off):
   ```
   Summary of our call here:
   <call_summaries_tab_url>

   [<optional comment>]
   ```
3. Preview and confirm, then send:
   ```bash
   python3 ~/.agents/skills/slack/scripts/slack_client.py send "<channel_id>" "<message>"
   ```

### Step 9: Offer to register new person

If the participant wasn't in `people.json`, offer to add them:

> "Would you like me to register [Name] with [Project] for future calls?"

If yes, update `~/.agents/data/people.json`:

```json
{
  "people": {
    "firstname-lastname": {
      "full_name": "First Last",
      "initials": "fl",
      "email": null,
      "slack_dm_channel": null,
      "default_project": "<project-folder-name>",
      "meeting_doc": null
    }
  }
}
```

---

## Report saved files

Always use **full expanded paths** (not `~` or relative) so Peter can command-click them.

If auto-associated via registry:
```
Auto-associated with **Project Name** (Person Name is registered to this project)
```

---

## Workflow: Start recording manually

Triggered by: "start recording", "record this call", "record call"

Use when the Chrome extension can't auto-detect the call (WhatsApp, Zoom, phone, etc.).

**Step 1: Check the server is running**

```bash
curl -s http://localhost:7777/status | python3 -m json.tool
```

If it returns an error (connection refused), tell Peter to start the server:
```bash
python3 ~/.agents/skills/transcribe-call/server/server.py
```

**Step 2: Start recording immediately**

Do not ask for a title — just start recording straight away. The file will be renamed to a
descriptive slug later during post-processing (Step 4).

```bash
curl -s -X POST http://localhost:7777/start \
  -H "Content-Type: application/json" \
  -d '{"meeting_title": "", "meeting_url": ""}' | python3 -m json.tool
```

Report the response to Peter. A successful response looks like:
```json
{"status": "recording", "file": "...", "started_at": "..."}
```

Tell Peter: "Recording started. Say 'stop recording' when the call ends."

---

## Workflow: Stop recording manually

Triggered by: "stop recording", "end recording", "stop the recording"

**Step 1: Stop the recording**

```bash
curl -s -X POST http://localhost:7777/stop | python3 -m json.tool
```

A successful response:
```json
{"status": "stopped", "audio_file": "...", "duration_seconds": 142.3}
```

Report the duration to Peter, then immediately proceed to the **"Process call notes"**
workflow (Step 1 onwards) in this same session — no need to open a new Warp window.

---

## Workflow: Check recording status

```bash
curl -s http://localhost:7777/status | python3 -m json.tool
```

Responses:
- `{"status": "idle"}` — nothing running
- `{"status": "recording", "meeting_title": "...", "duration_seconds": 142.3, ...}`

---

## Setup

### Prerequisites

- macOS (ScreenCaptureKit required)
- Chrome browser
- `parakeet-mlx` at `~/.local/bin/parakeet-mlx`
- `fluidaudio` at `~/.local/bin/fluidaudio`
- `transcribe-audio` skill installed (provides `align_speakers.py` and `cleanup_filler_words.py`)

### Install Chrome extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `~/.agents/skills/transcribe-call/extension/`

### Start the server

**Manual (testing):**

```bash
python3 ~/.agents/skills/transcribe-call/server/server.py
```

**launchd (auto-start on login):**

```bash
# Edit plist to use correct python3 path
nano ~/.agents/skills/transcribe-call/server/com.hartreeworks.meet-recorder.plist

# Install
cp ~/.agents/skills/transcribe-call/server/com.hartreeworks.meet-recorder.plist \
   ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hartreeworks.meet-recorder.plist

# Verify
curl -s http://localhost:7777/status
tail -f /tmp/meet-recorder-server.log
```

---

## Troubleshooting

### Extension shows "server not running" overlay

```bash
python3 ~/.agents/skills/transcribe-call/server/server.py
```

Then click "Retry recording" in the overlay, or rejoin the call.

### Audio file is tiny (<100KB)

Verify ScreenCaptureKit permissions: System Settings → Privacy & Security → Screen Recording.

### Stale session file after a crash

```bash
trash ~/.agents/skills/transcribe-call/recording-session.json
```

### Server restart during an active recording

On restart, `server.py` reads `recording-session.json` and reattaches to the recorder
process by PID. Use `GET /status` after restart to confirm.

---

## People registry

`~/.agents/data/people.json` — shared registry used by both `transcribe-call` and
`summarise-granola`.

**Format:**
```json
{
  "people": {
    "rob-long": {
      "full_name": "Rob Long",
      "initials": "rl",
      "email": "rob@example.com",
      "slack_dm_channel": "D01234567",
      "default_project": "coaching-rob",
      "meeting_doc": {
        "url": "https://docs.google.com/document/d/...",
        "title": "ph-rl Peter Hartree & Rob Long meetings",
        "cached_at": "2026-01-20"
      }
    }
  }
}
```

**Key format:** Lowercase, hyphenated full name (e.g., "Rob Long" → "rob-long")

**Lookups:**
- **By name:** convert to hyphenated key, check `people`
- **By initials:** scan `people` for matching `initials` field
