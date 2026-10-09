# Auto Caption Saver

A Chrome extension that saves the live captions from **Google Meet** and **Zoom Web** meetings to a `.txt` transcript, automatically. You never have to click a save button.

Other caption-saving extensions only save if you click save before the call closes. You lose the transcript if you forget, the host ends the meeting for everyone, or the tab or browser crashes. Auto Caption Saver saves captions continuously while the call runs. It writes the file no matter how the meeting ends.

## Features

- **Zero clicks.** Join a meeting and the transcript downloads when it ends.
- **Saves on every kind of exit**:
  - you click Leave
  - the host ends the meeting for everyone (the call UI disappears for 10 seconds)
  - you close the tab or navigate away
  - the browser crashes or is killed: the transcript is recovered the next time Chrome starts
- **Turns on Meet captions automatically** once per call. If you turn them off, they stay off.
- **Clean transcripts.** Captions that grow word by word, get corrected by speech recognition, or get trimmed during long monologues are merged into one line per utterance.
- **One file per meeting**, even if you join several meetings in the same tab.
- **Recording indicator.** The toolbar icon shows a red `REC` badge while captions are being saved.
- **Local only.** No servers and no analytics. Transcripts stay in your browser's storage until they're written to your Downloads folder.

## Install

The extension isn't on the Chrome Web Store. Load it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.

Requires Chrome 116 or newer.

## Usage

1. Join a meeting on `meet.google.com`, or on Zoom using **Join from your browser**.
2. Make sure captions are visible:
   - **Meet:** they are turned on for you.
   - **Zoom:** the host must enable live transcription, and you must turn on **Show Captions**.
3. When the meeting ends, the transcript is saved to:

```
Downloads/MeetingCaptions/<YYYY-MM-DD-HH-mm>_<platform>_<title>.txt
```

Example output:

```
Meet - abc-defg-hij
https://meet.google.com/abc-defg-hij
Started: 2026-10-09 12:57:27

[12:57:27] Ann: Quick update from last week, the audit trail now records request context.
[12:59:20] Bob: Thanks. On my side the risk-based audit report is ready for review.
```

## How it works

| File | Role |
|------|------|
| `content.js` | Runs in the meeting page. Reads the caption elements, merges updates into entries, and sends them to the background worker every 3 seconds. Sends a final copy when the call ends. |
| `background.js` | Service worker. Owns storage and downloads, and finalizes each session exactly once. A session can end through the page, `tabs.onRemoved`, or startup recovery. A page can't reliably download a file while it is closing, so all finalization happens here. |
| `offscreen.html` / `offscreen.js` | Builds the transcript into a blob URL for `chrome.downloads`. This avoids the size limits of `data:` URLs on long meetings. |

Permissions: `storage` holds the in-progress transcript. `downloads` writes the file. `tabs` notices when a tab closes. `offscreen` builds the file. Host access is limited to `meet.google.com` and `*.zoom.us`.

## Troubleshooting

**Nothing is captured.** Meet and Zoom change their page markup often, and that breaks caption reading. Open DevTools on the meeting tab and inspect a caption line. Then update the matching function in the `ADAPTERS` object at the top of `content.js`:

| Function | What it does |
|----------|--------------|
| `blocks` | Finds the caption elements |
| `inCall` | Detects whether you're in the call |
| `enableCaptions` | Turns Meet captions on |
| `meetingKey` | Tells meetings apart by URL |

All platform-specific selectors live in `ADAPTERS`. A fix there doesn't need changes anywhere else. Pull requests with updated selectors are welcome.

**Captured but no file.** Open `chrome://extensions`, click **service worker** on the extension card, and check the console for errors.

**After updating or reloading the extension**, reload any open meeting tabs.

## Limitations

- Only the browser versions of Meet and Zoom are supported. The Zoom desktop app can't be read by an extension.
- On Zoom, captions only exist if the host enables live transcription.
- Transcript quality is only as good as the platform's captions. Speaker names are shown exactly as the platform displays them.
- A browser crash can lose up to the last ~3 seconds of captions.

Recording other people's speech may require their consent where you live or under your organization's policy. You are responsible for using this extension appropriately.

## Development

There's no build step and there are no dependencies. Tests use Node's built-in test runner. They run the real source files against fake `chrome.*` APIs and a fake DOM:

```sh
node --test                                   # all tests
node --test --test-name-pattern="idempotent"  # one test by name
```

The automated tests can't check that the selectors match the live Meet or Zoom page. See [TESTING.md](TESTING.md) for the manual test plan.

## Ideas

- Fallback when captions are unavailable: capture tab audio with `chrome.tabCapture` and transcribe locally with Whisper.
- After the meeting: send the transcript to an LLM and save a summary with action items next to the `.txt`.

## License

[MIT](LICENSE)
