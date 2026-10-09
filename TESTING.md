# Testing

## Automated

```sh
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
node --check content.js && node --check background.js && node --check offscreen.js
node --test                                   # all tests
node --test --test-name-pattern="idempotent"  # one test by name
```

`test/background.test.js` runs the service worker against an in-memory fake of `chrome.*`. It covers file format and naming, the offscreen blob download, idempotent finalize across all three paths and across worker restarts, crash recovery and session cleanup.

`test/content.test.js` runs the content script against a fake DOM shaped like the `ADAPTERS` selectors. It covers dedupe, the save throttle, end-of-call detection, session splitting, `pagehide` and Zoom frames.

These tests do **not** check that the selectors match real Meet or Zoom markup. Only the manual tests below can verify that.

## Setup for manual tests

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Click **service worker** on the extension card to open its DevTools. Keep it open to watch for errors.
3. To see stored state, run this in the service worker console: `chrome.storage.local.get(null).then(console.log)`
   - `s_<id>` = session being recorded, `d_<id>` = session already finalized.
4. Files land in `Downloads/MeetingCaptions/<YYYY-MM-DD-HH-mm>_<platform>_<title>.txt`.

After reloading the extension, reload any open Meet/Zoom tabs. Content scripts from the previous version can no longer reach the extension.

## Manual test plan

| # | Steps | Expected |
|---|-------|----------|
| 1 | Solo Meet call, speak 30s, click **Leave**. | File appears within ~12s. Badge shows `REC` during the call and clears afterwards. |
| 2 | Solo Meet call, speak 30s, close the tab without leaving. | File appears within a few seconds. |
| 3 | Solo Meet call, speak 30s, kill the browser process (`pkill -9 chrome`). Reopen Chrome. | File appears shortly after startup. It contains everything up to ~3s before the kill. |
| 4 | Two-account Meet call, host ends the meeting for all. | The guest's file appears within ~15s. |
| 5 | Zoom web client (**Join from your browser**) with host live transcription on and captions shown. Leave. | File appears on leave. Only **one** file, even with several frames. |
| 6 | Open `chrome://extensions` and inspect the service worker. | No errors. |

## Extra checks

| # | Steps | Expected |
|---|-------|----------|
| 7 | Meet call → leave → join a **different** meeting in the same tab. Speak and leave. | Two files, one per meeting, with no mixed lines. |
| 8 | Meet call: captions are auto-enabled. Turn them off manually. | They stay off (the extension clicks only once per call). |
| 9 | Long call (or paste a long monologue) for 1h+. | File downloads normally. The worker console shows no data-URL errors. |
| 10 | Leave a call, then reopen Chrome normally. | No duplicate file for the already-saved meeting. |
| 11 | Calendar meeting whose title contains `/`, `:` or `?`. | Filename has `_` in place of those characters, and the download succeeds. |

## When nothing is captured

Meet and Zoom change their markup often. Inspect a caption line in DevTools and update the matching function in `ADAPTERS` in `content.js`: `blocks`, `inCall`, `enableCaptions` or `meetingKey`. Don't change other code for a selector problem.
