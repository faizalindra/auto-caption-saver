// Runs background.js in a vm against an in-memory fake of the chrome.* APIs it uses.
// Usage: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const tick = () => new Promise(setImmediate);

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)) };
}

function fakeChrome({ store = {}, tabs = [], rejectFilename } = {}) {
  const state = {
    store, tabs: new Set(tabs), downloads: [], blobs: new Map(), revoked: [],
    offscreenOpen: false, offscreenCreates: 0, badges: {},
  };
  const keys = (k) => k == null ? Object.keys(state.store) : [].concat(k);
  const chrome = {
    storage: { local: {
      get: async (k) => Object.fromEntries(keys(k).filter((x) => x in state.store)
        .map((x) => [x, structuredClone(state.store[x])])),
      set: async (o) => { for (const [k, v] of Object.entries(o)) state.store[k] = structuredClone(v); },
      remove: async (k) => { for (const x of [].concat(k)) delete state.store[x]; },
    } },
    offscreen: {
      hasDocument: async () => state.offscreenOpen,
      createDocument: async (o) => {
        assert.equal(JSON.stringify(o.reasons), '["BLOBS"]');
        state.offscreenCreates++; state.offscreenOpen = true;
      },
      closeDocument: async () => { state.offscreenOpen = false; },
    },
    runtime: {
      onMessage: event(), onStartup: event(), onInstalled: event(),
      sendMessage: async (m) => {
        assert.equal(m.target, 'offscreen');
        assert.ok(state.offscreenOpen, 'offscreen document must exist');
        if (m.type === 'blob') {
          const url = `blob:chrome-extension://x/${state.blobs.size}`;
          state.blobs.set(url, m.text);
          return { url };
        }
        if (m.type === 'revoke') state.revoked.push(m.url);
      },
    },
    downloads: {
      onChanged: event(),
      download: async (o) => {
        if (rejectFilename && rejectFilename(o.filename)) throw new Error('Invalid filename');
        state.downloads.push({ ...o, text: state.blobs.get(o.url) });
        return state.downloads.length;
      },
    },
    tabs: {
      onRemoved: event(),
      get: async (id) => { if (!state.tabs.has(id)) throw new Error('No tab'); return { id }; },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => { state.badges[tabId] = text; },
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
  };
  return { chrome, state };
}

// Boots a fresh "service worker" over the given fake. Returns helpers to drive it.
function boot(fake) {
  const ctx = vm.createContext({
    chrome: fake.chrome, console: { ...console, error() {}, warn() {} }, structuredClone,
    setTimeout: (fn) => setImmediate(fn), // collapse the 1.5s grace delays
  });
  vm.runInContext(SRC, ctx);
  const settle = async () => {
    for (let i = 0; i < 10; i++) { await tick(); await vm.runInContext('chain', ctx); }
  };
  const msg = (m, sender = { tab: { id: 1 }, frameId: 0 }) => fake.chrome.runtime.onMessage.fire(m, sender);
  return { ctx, settle, msg };
}

const session = (over = {}) => ({
  id: 'a1', key: 'abc-defg-hij', platform: 'meet', title: 'Meet - abc-defg-hij',
  url: 'https://meet.google.com/abc-defg-hij', start: new Date(2026, 9, 9, 9, 5, 7).getTime(),
  entries: [
    { t: new Date(2026, 9, 9, 9, 5, 8).getTime(), speaker: 'Ann', text: 'hello there' },
    { t: new Date(2026, 9, 9, 14, 30, 0).getTime(), speaker: '', text: 'no speaker line' },
  ],
  ...over,
});

test('save then finalize writes one correctly formatted file via a blob URL', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session() });
  await settle();
  assert.equal(fake.state.store.s_a1.tabId, 1);
  assert.equal(fake.state.badges[1], 'REC');

  msg({ type: 'finalize', id: 'a1', session: session() });
  await settle();
  assert.equal(fake.state.downloads.length, 1);
  const d = fake.state.downloads[0];
  assert.equal(d.filename, 'MeetingCaptions/2026-10-09-09-05_meet_Meet - abc-defg-hij.txt');
  assert.match(d.url, /^blob:/);
  assert.equal(d.saveAs, false);
  assert.equal(d.text,
    'Meet - abc-defg-hij\nhttps://meet.google.com/abc-defg-hij\nStarted: 2026-10-09 09:05:07\n\n' +
    '[09:05:08] Ann: hello there\n[14:30:00] no speaker line\n');
  assert.ok(!('s_a1' in fake.state.store));
  assert.ok('d_a1' in fake.state.store);
  assert.equal(fake.state.badges[1], '');
});

test('finalize uses the content script copy, which is newer than storage', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session({ entries: [session().entries[0]] }) });
  await settle();
  msg({ type: 'finalize', id: 'a1', session: session() });
  await settle();
  assert.match(fake.state.downloads[0].text, /no speaker line/);
});

test('finalize is idempotent across message, tabs.onRemoved and onStartup', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session() });
  await settle();
  msg({ type: 'finalize', id: 'a1', session: session() });
  msg({ type: 'finalize', id: 'a1', session: session() });
  fake.chrome.tabs.onRemoved.fire(1);
  fake.chrome.runtime.onStartup.fire();
  await settle();
  assert.equal(fake.state.downloads.length, 1);
});

test('idempotency survives a service worker restart', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const w1 = boot(fake);
  w1.msg({ type: 'save', session: session() });
  await w1.settle();
  w1.msg({ type: 'finalize', id: 'a1', session: session() });
  await w1.settle();

  const w2 = boot(fake); // fresh memory, same storage
  w2.msg({ type: 'finalize', id: 'a1', session: session() });
  w2.msg({ type: 'save', session: session() }); // late throttled save
  fake.chrome.runtime.onStartup.fire();
  await w2.settle();
  assert.equal(fake.state.downloads.length, 1);
  assert.ok(!('s_a1' in fake.state.store), 'late save must not resurrect the session');
});

test('onStartup recovers sessions orphaned by a crash, but not live ones', async () => {
  const fake = fakeChrome({
    tabs: [7],
    store: { s_old: { ...session({ id: 'old' }), tabId: 7, frameId: 0, saved: 1 } },
  });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session({ id: 'live' }) }, { tab: { id: 7 }, frameId: 3 });
  await settle();
  fake.chrome.runtime.onStartup.fire();
  await settle();
  assert.equal(fake.state.downloads.length, 1);
  assert.ok(!('s_old' in fake.state.store));
  assert.ok('s_live' in fake.state.store);
});

test('tabs.onRemoved finalizes only that tab\'s session', async () => {
  const fake = fakeChrome({ tabs: [1, 2] });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session({ id: 'x' }) }, { tab: { id: 1 }, frameId: 0 });
  msg({ type: 'save', session: session({ id: 'y' }) }, { tab: { id: 2 }, frameId: 0 });
  await settle();
  fake.state.tabs.delete(1);
  fake.chrome.tabs.onRemoved.fire(1);
  await settle();
  assert.equal(fake.state.downloads.length, 1);
  assert.ok(!('s_x' in fake.state.store));
  assert.ok('s_y' in fake.state.store);
});

test('worker wake-up finalizes sessions whose tab is gone', async () => {
  const fake = fakeChrome({
    tabs: [2],
    store: {
      s_gone: { ...session({ id: 'gone' }), tabId: 1, frameId: 0, saved: Date.now() },
      s_here: { ...session({ id: 'here' }), tabId: 2, frameId: 0, saved: Date.now() },
    },
  });
  const { settle } = boot(fake);
  await settle();
  assert.equal(fake.state.downloads.length, 1);
  assert.deepEqual(Object.keys(fake.state.store).sort(), ['d_gone', 's_here']);
});

test('a new session in the same tab and frame closes the previous one', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  msg({ type: 'save', session: session({ id: 'first' }) });
  await settle();
  msg({ type: 'save', session: session({ id: 'second', key: 'zzz-zzzz-zzz' }) });
  await settle();
  assert.equal(fake.state.downloads.length, 1);
  assert.ok('d_first' in fake.state.store);
  assert.ok('s_second' in fake.state.store);
  // A different frame in the same tab is left alone.
  msg({ type: 'save', session: session({ id: 'other' }) }, { tab: { id: 1 }, frameId: 5 });
  await settle();
  assert.ok('s_second' in fake.state.store);
});

test('titles are sanitized, and a rejected filename falls back to no title', async () => {
  const fake = fakeChrome({ tabs: [1], rejectFilename: (f) => f.includes('Weekly') });
  const { settle, msg } = boot(fake);
  msg({ type: 'finalize', id: 'a', session: session({ id: 'a', title: ' ..Q3: plan/review? <draft>. ' }) });
  msg({ type: 'finalize', id: 'b', session: session({ id: 'b', title: 'Weekly sync' }) });
  msg({ type: 'finalize', id: 'c', session: session({ id: 'c', title: '' }) });
  await settle();
  assert.deepEqual(fake.state.downloads.map((d) => d.filename), [
    'MeetingCaptions/2026-10-09-09-05_meet_Q3_ plan_review_ _draft_.txt',
    'MeetingCaptions/2026-10-09-09-05_meet.txt',
    'MeetingCaptions/2026-10-09-09-05_meet_meeting.txt',
  ]);
});

test('sessions without captions are closed without a download', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  msg({ type: 'finalize', id: 'e', session: session({ id: 'e', entries: [] }) });
  await settle();
  assert.equal(fake.state.downloads.length, 0);
  assert.ok('d_e' in fake.state.store);
});

test('a failed download keeps the session for a later retry', async () => {
  const fake = fakeChrome({ tabs: [1], rejectFilename: () => true });
  const { settle, msg } = boot(fake);
  msg({ type: 'finalize', id: 'f', session: session({ id: 'f' }) });
  await settle();
  assert.ok('s_f' in fake.state.store);
  assert.ok(!('d_f' in fake.state.store));
});

test('long transcripts work and blob URLs are revoked once the download completes', async () => {
  const fake = fakeChrome({ tabs: [1] });
  const { settle, msg } = boot(fake);
  const entries = Array.from({ length: 50000 }, (_, i) => ({ t: i * 1000, speaker: 'S', text: 'x'.repeat(100) }));
  msg({ type: 'finalize', id: 'big', session: session({ id: 'big', entries }) });
  await settle();
  const d = fake.state.downloads[0];
  assert.ok(d.text.length > 5_000_000);
  assert.equal(fake.state.offscreenCreates, 1);

  fake.chrome.downloads.onChanged.fire({ id: 1, state: { current: 'complete' } });
  await settle();
  assert.deepEqual(fake.state.revoked, [d.url]);
  assert.equal(fake.state.offscreenOpen, false);
});

test('old finalized markers are pruned', async () => {
  const fake = fakeChrome({ store: { d_ancient: 1, d_recent: Date.now() } });
  const { settle } = boot(fake);
  fake.chrome.runtime.onStartup.fire();
  await settle();
  assert.deepEqual(Object.keys(fake.state.store), ['d_recent']);
});
