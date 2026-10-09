# Auto Caption Saver

Chrome extension (Manifest V3) that records live captions from Google Meet and Zoom Web, saves them continuously, and writes a `.txt` transcript automatically when the meeting ends. No manual save step.

## Goal

The existing extension "Google Meet CC Capturer" only saves if the user clicks save before the call closes. That fails when:
- The user forgets.
- The admin ends the meeting for everyone.
- The tab or browser crashes.

This project removes the manual step: persist captions continuously, finalize on any exit signal.

## Requirements

1. Capture captions on `meet.google.com` and Zoom web client (`*.zoom.us/wc/*`).
2. Persist captions to `chrome.storage.local` every few seconds while the call runs.
3. Finalize and download a `.txt` when ANY of these happens:
   - User leaves the call.
   - Admin ends the meeting (in-call UI disappears for 10 seconds).
   - Tab is closed or navigated away (`pagehide`, `tabs.onRemoved`).
   - Browser restarts after a crash (recover orphaned sessions on `onStartup`).
4. Output path: `Downloads/MeetingCaptions/<YYYY-MM-DD-HH-mm>_<platform>_<title>.txt`
5. Line format: `[HH:MM:SS] Speaker: text`
6. Auto-enable captions on Meet when possible.
7. Platform-specific DOM selectors must live in one `ADAPTERS` object so fixes are one-place edits.

## Architecture

- `content.js`: runs in the page. Observes caption DOM, dedupes growing caption lines, sends `save` messages (throttled to 3s) and a `finalize` message on end.
- `background.js` (service worker): owns storage and downloads. A page cannot reliably download during teardown, so all finalization happens here.
- `manifest.json`: MV3, permissions `storage`, `downloads`, `tabs`.

## Tasks for Claude Code

1. Create the three files below exactly as given.
2. Validate: `manifest.json` is valid JSON, JS has no syntax errors (`node --check`).
3. Fix known weaknesses:
   - **Data URL download limit.** Long meetings can exceed data URL limits. Replace with an offscreen document (`chrome.offscreen`, reason `BLOBS`) that builds a Blob and returns an object URL, then pass that to `chrome.downloads.download`. Add the `offscreen` permission.
   - **Zoom iframes.** Zoom web client may render inside frames. Confirm `all_frames: true` works and that only the frame with captions reports sessions (avoid duplicate sessions from multiple frames).
   - **Duplicate finalize.** Make sure `finalize` is idempotent across content script, `tabs.onRemoved`, and `onStartup` paths. Service worker memory (`done` Set) is lost on restart, so also guard with a persisted flag or by relying on removal of the storage key.
   - **Session splitting.** If the user stays on the same tab and joins a second meeting, a new session must start.
4. Add an options-free popup or badge showing "recording" state when a session is active (optional, low priority).
5. Write a `TESTING.md` with the manual test steps below.

## Manual test plan

1. Solo Meet call, speak 30s, click Leave. File appears.
2. Solo Meet call, speak 30s, close the tab without leaving. File appears.
3. Solo Meet call, speak 30s, kill the browser process. Reopen Chrome. File appears.
4. Two-account Meet call, host ends meeting for all. File appears within ~15s.
5. Zoom web client (`Join from your browser`) with host live transcription on. File appears on leave.
6. Open `chrome://extensions`, inspect the service worker, confirm no errors.

## Known fragility

Meet and Zoom obfuscate and change class names and ARIA labels often. If nothing is captured, inspect a caption line in DevTools and update the matching function in `ADAPTERS` (`blocks`, `inCall`, `enableCaptions`). Do not rewrite anything else for a selector problem.

Limits:
- Zoom desktop app cannot be captured by an extension.
- If the Zoom host disables live transcription, there are no captions to read.

## Future ideas (not in scope yet)

- Fallback: capture tab audio via `chrome.tabCapture` and transcribe locally with Whisper (independent of captions).
- Post-meeting step: send the transcript to an LLM API and save a summary with action items next to the `.txt`.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked, select this folder.

## Files

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Auto Caption Saver",
  "version": "1.0",
  "permissions": ["storage", "downloads", "tabs"],
  "host_permissions": ["https://meet.google.com/*", "https://*.zoom.us/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://meet.google.com/*", "https://*.zoom.us/wc/*"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": true
  }]
}
```

### content.js

```js
(() => {
  const isMeet = location.host === 'meet.google.com';
  const platform = isMeet ? 'meet' : 'zoom';
  if (isMeet && !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname)) return;

  // The only part that breaks when Google/Zoom change their UI. Adjust selectors here.
  const ADAPTERS = {
    meet: {
      inCall: () => !!document.querySelector('button[aria-label*="Leave call" i]'),
      enableCaptions: () =>
        document.querySelector('button[aria-label*="Turn on captions" i]')?.click(),
      blocks: () => {
        const r = document.querySelector('[role="region"][aria-label*="aption" i]');
        return r ? [...r.querySelectorAll(':scope > div > div')] : [];
      },
    },
    zoom: {
      inCall: () => !!document.querySelector('[class*="footer__leave-btn"], button[aria-label*="Leave" i]'),
      enableCaptions: () => {},
      blocks: () => [...document.querySelectorAll('[class*="live-transcription-subtitle__item"]')],
    },
  };
  const A = ADAPTERS[platform];

  let session = null, dirty = false, missingSince = 0, lastFlush = 0, scanTimer = 0;
  const seen = new WeakMap();

  const parse = (el) => {
    const lines = el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    return lines.length > 1
      ? { speaker: lines[0], text: lines.slice(1).join(' ') }
      : { speaker: '', text: lines[0] };
  };

  function scan() {
    for (const el of A.blocks()) {
      const p = parse(el);
      if (!p) continue;
      if (!session) {
        session = { id: String(Date.now()), platform, title: document.title,
                    url: location.href, start: Date.now(), entries: [] };
      }
      let entry = seen.get(el);
      if (!entry) {
        const l = session.entries.at(-1);
        const same = l && l.speaker === p.speaker && Date.now() - l.t < 15000 &&
          (p.text.startsWith(l.text) || l.text.startsWith(p.text));
        entry = same ? l : { t: Date.now(), speaker: p.speaker, text: '' };
        if (!same) session.entries.push(entry);
        seen.set(el, entry);
      }
      if (p.text.length >= entry.text.length && p.text !== entry.text) {
        entry.text = p.text;
        dirty = true;
      }
    }
  }

  const send = (msg) => { try { chrome.runtime.sendMessage(msg); } catch (e) {} };

  function flush() {
    if (!session || !dirty || Date.now() - lastFlush < 3000) return;
    send({ type: 'save', session });
    dirty = false;
    lastFlush = Date.now();
  }

  function end() {
    if (!session) return;
    send({ type: 'finalize', id: session.id, session });
    session = null;
    missingSince = 0;
  }

  new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    if (A.inCall()) { missingSince = 0; A.enableCaptions(); }
    else if (session && !missingSince) missingSince = Date.now();
    scan();
    flush();
    if (session && missingSince && Date.now() - missingSince > 10000) end();
  }, 2000);

  addEventListener('pagehide', end);
})();
```

### background.js

```js
const key = (id) => `s_${id}`;
const done = new Set();
const clean = (s) => s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

async function finalize(id, latest) {
  const k = key(id);
  const stored = (await chrome.storage.local.get(k))[k];
  if ((!stored && !latest) || done.has(id)) return;
  done.add(id);
  await chrome.storage.local.remove(k);
  const s = latest || stored;
  if (!s.entries?.length) return;

  const d = new Date(s.start);
  const stamp = d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const body = s.entries
    .map(e => `[${new Date(e.t).toLocaleTimeString()}] ${e.speaker ? e.speaker + ': ' : ''}${e.text}`)
    .join('\n');
  const text = `${s.title}\n${s.url}\nStarted: ${d.toLocaleString()}\n\n${body}\n`;

  await chrome.downloads.download({
    url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text),
    filename: `MeetingCaptions/${stamp}_${s.platform}_${clean(s.title)}.txt`,
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'save' && !done.has(msg.session.id)) {
    chrome.storage.local.set({ [key(msg.session.id)]: { ...msg.session, tabId: sender.tab?.id } });
  } else if (msg.type === 'finalize') {
    finalize(msg.id, msg.session);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('s_') && v.tabId === tabId) finalize(v.id);
  }
});

// Recovery: browser crashed or closed mid-meeting
chrome.runtime.onStartup.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('s_')) finalize(v.id);
});
```
