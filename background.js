// Storage layout:
//   s_<id>  live session { id, key, platform, title, url, start, entries, tabId, frameId, saved }
//   d_<id>  finalized marker (timestamp). Survives service worker restarts, so finalize is
//           idempotent across the content script, tabs.onRemoved and onStartup paths, and late
//           `save` messages cannot resurrect a finished session.
const sKey = (id) => `s_${id}`;
const dKey = (id) => `d_${id}`;
const BOOT = Date.now();
const DONE_TTL = 7 * 24 * 3600 * 1000;

// All storage read-modify-write runs through one queue; the async listeners would race otherwise.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch((e) => console.error('[auto-caption-saver]', e));
  return run;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const clean = (s) => (s || '')
  .replace(/[\\/:*?"<>|~\x00-\x1f\x7f]/g, '_')
  .replace(/\s+/g, ' ')
  .slice(0, 80)
  .replace(/^[\s.]+|[\s.]+$/g, '') || 'meeting';

function render(s) {
  const body = s.entries
    .filter((e) => e.text)
    .map((e) => `[${hms(new Date(e.t))}] ${e.speaker ? e.speaker + ': ' : ''}${e.text}`)
    .join('\n');
  const d = new Date(s.start);
  return `${s.title}\n${s.url}\nStarted: ${ymd(d)} ${hms(d)}\n\n${body}\n`;
}

// --- Downloads via offscreen blob URLs ---------------------------------------

const blobs = new Map(); // downloadId -> blob URL awaiting revocation
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Build the transcript file for chrome.downloads',
  }).finally(() => { creating = null; });
  await creating;
}

async function download(s) {
  await ensureOffscreen();
  const { url } = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob', text: render(s) });
  const d = new Date(s.start);
  const base = `MeetingCaptions/${ymd(d)}-${pad(d.getHours())}-${pad(d.getMinutes())}_${s.platform}`;
  const opts = { url, saveAs: false, conflictAction: 'uniquify' };
  let id;
  try {
    id = await chrome.downloads.download({ ...opts, filename: `${base}_${clean(s.title)}.txt` });
  } catch (e) {
    console.warn('[auto-caption-saver] filename rejected, retrying without title', e);
    id = await chrome.downloads.download({ ...opts, filename: `${base}.txt` });
  }
  blobs.set(id, url);
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!blobs.has(id) || !state || state.current === 'in_progress') return;
  const url = blobs.get(id);
  blobs.delete(id);
  if (state.current === 'interrupted') console.error('[auto-caption-saver] download interrupted', id);
  serial(async () => {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
    if (!blobs.size) await chrome.offscreen.closeDocument().catch(() => {});
  });
});

// --- Badge -------------------------------------------------------------------

function setBadge(tabId, on) {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: on ? 'Recording captions' : 'Auto Caption Saver' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' }).catch(() => {});
}

// --- Sessions ----------------------------------------------------------------

async function storedSessions() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith('s_')).map(([, v]) => v);
}

// Must run inside serial().
async function doFinalize(id, latest) {
  const k = sKey(id), dk = dKey(id);
  const got = await chrome.storage.local.get([k, dk]);
  if (got[dk]) return;
  const s = latest ? { ...got[k], ...latest } : got[k];
  if (!s) return;
  await chrome.storage.local.set({ [dk]: Date.now() });
  await chrome.storage.local.remove(k);
  setBadge(s.tabId, false);
  if (!s.entries?.length) return;
  try {
    await download(s);
  } catch (e) {
    // Put the session back so the next startup sweep retries it.
    console.error('[auto-caption-saver] download failed', e);
    await chrome.storage.local.set({ [k]: s });
    await chrome.storage.local.remove(dk);
  }
}

const finalize = (id, latest) => serial(() => doFinalize(id, latest));

function save(session, sender) {
  const tabId = sender.tab?.id, frameId = sender.frameId;
  return serial(async () => {
    const k = sKey(session.id), dk = dKey(session.id);
    const got = await chrome.storage.local.get([k, dk]);
    if (got[dk]) return;
    if (!got[k] && tabId != null) {
      // A new session in this frame means any older one there lost its finalize
      // (e.g. in-tab navigation where the pagehide message never arrived).
      for (const old of await storedSessions()) {
        if (old.tabId === tabId && old.frameId === frameId) await doFinalize(old.id);
      }
    }
    await chrome.storage.local.set({ [k]: { ...session, tabId, frameId, saved: Date.now() } });
    setBadge(tabId, true);
  });
}

// Finalize every stored session matching pred, and prune old finalized markers.
function sweep(pred) {
  return serial(async () => {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith('d_') && Date.now() - all[k] > DONE_TTL);
    if (stale.length) await chrome.storage.local.remove(stale);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('s_') && await pred(v)) await doFinalize(v.id);
    }
  });
}

const tabGone = (tabId) => tabId == null ? Promise.resolve(true) : chrome.tabs.get(tabId).then(() => false, () => true);

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.target === 'offscreen') return;
  if (msg?.type === 'save' && msg.session?.id) save(msg.session, sender);
  else if (msg?.type === 'finalize' && msg.id) finalize(msg.id, msg.session);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Give the content script's pagehide finalize (which carries the newest captions) a head start.
  setTimeout(() => sweep((v) => v.tabId === tabId), 1500);
});

// Recovery: browser crashed or closed mid-meeting, or the extension was reloaded/updated
// (old content scripts are cut off then). Sessions saved since this worker booted are live.
chrome.runtime.onStartup.addListener(() => sweep((v) => !(v.saved >= BOOT)));
chrome.runtime.onInstalled.addListener(() => sweep((v) => !(v.saved >= BOOT)));

// Any wake-up: catch sessions whose tab disappeared while the worker missed the event.
// Delayed so a pagehide finalize that woke the worker is handled first.
setTimeout(() => sweep((v) => tabGone(v.tabId)), 1500);
