# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What it is

Chrome MV3 extension (Chrome 116+) that captures live captions from Google Meet (`meet.google.com`) and Zoom Web (`*.zoom.us/wc/*`), persists them continuously to `chrome.storage.local`, and writes a `.txt` to `Downloads/MeetingCaptions/<YYYY-MM-DD-HH-mm>_<platform>_<title>.txt` when the meeting ends — with no manual save step. Line format: `[HH:MM:SS] Speaker: text`. `readme.md` holds the original spec and the original (pre-fix) code.

## Commands

No build step, package manager, or dependencies. Plain JS loaded unpacked.

- Tests: `node --test` (all) / `node --test --test-name-pattern="<name>"` (one)
- Syntax check: `node --check content.js && node --check background.js && node --check offscreen.js`
- Manifest check: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`
- Run: `chrome://extensions` → Developer mode → Load unpacked → this folder. Reload open Meet/Zoom tabs after reloading the extension.
- Manual test plan: `TESTING.md`.

Tests load the real source files into `node:vm` with hand-written fakes (`chrome.*` in `test/background.test.js`, a selector-shaped fake DOM in `test/content.test.js`). Values crossing the vm boundary have a different realm, so `assert.deepEqual` on vm-created arrays/objects fails on prototype — compare via JSON or by mapping to fresh values.

## Architecture

Key constraint: a page cannot reliably download during teardown, so **the content script never writes files** — the service worker owns storage and downloads.

- `content.js` (all frames): MutationObserver + 2s interval scan the caption DOM. Dedupes growing caption lines by mapping each DOM element to an entry (`WeakMap`) and merging into the previous entry when same speaker, <15s apart, and prefix-related. `merge()` reconciles an entry with its block's current text: growth, ASR revisions, and Meet trimming the start of long monologues (realigned by overlap so no words are lost). Sends `save` (throttled 3s, only when dirty) and `finalize` (carries the newest session). A session starts lazily on the first caption *while in call*. It ends when the in-call UI is gone for >10s, on `pagehide`, or when `meetingKey` changes (new meeting in the same tab).
- Zoom frames: only the frame whose own document has captions creates a session. "In call" is checked across all same-origin frames reachable from `window.top`, because the Leave button may be in a different frame.
- `background.js` (service worker): `s_<id>` = live session (with `tabId`, `frameId`, `saved`), `d_<id>` = persisted "finalized" marker (pruned after 7 days). All storage read-modify-write goes through the `serial()` promise queue. Finalize paths: content `finalize` message, `tabs.onRemoved` (1.5s grace so the content copy wins), `onStartup`/`onInstalled` (sessions saved before this worker booted), a tab-gone sweep on every worker wake, and a new session in the same tab+frame closing the previous one. The `d_` marker makes all of these idempotent and blocks late `save`s from resurrecting a session.
- `offscreen.html/js`: downloads use a blob URL built in an offscreen document (reason `BLOBS`), not a data URL (size limits). The worker revokes the URL and closes the document on `downloads.onChanged`. The offscreen doc also revokes after 10 min as a fallback.
- Badge: `REC` on the tab while a session is saved; cleared on finalize. Needs the `action` key in the manifest.

## Platform selectors

All Meet/Zoom DOM/URL specifics live in the `ADAPTERS` object in `content.js` (`meetingKey`, `inCall`, `enableCaptions`, `blocks`). Meet and Zoom change markup often. For a "nothing captured" bug, edit only the relevant `ADAPTERS` function. The automated tests can't validate real selectors.

Out of scope (readme "future ideas"): tabCapture + local Whisper fallback, LLM summary step. Can't be captured at all: the Zoom desktop app, and Zoom meetings where the host disabled transcription.
