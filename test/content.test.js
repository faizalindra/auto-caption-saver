// Runs content.js in a vm against a tiny fake DOM shaped like the ADAPTERS selectors.
// It checks the generic logic (dedupe, session lifecycle, frames), not real Meet/Zoom markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// A fake page (one frame). `ui` holds what the page currently shows.
function page({ host = 'meet.google.com', pathname = '/abc-defg-hij', title = 'Meet - abc-defg-hij', ui = {} } = {}) {
  const st = { inCall: false, captionsOn: false, clicks: 0, blocks: [], ...ui };
  const document = {
    title,
    body: {},
    querySelector(sel) {
      if (/Leave/.test(sel)) return st.inCall ? {} : null;
      if (/Turn off captions/.test(sel)) return st.inCall && st.captionsOn ? {} : null;
      if (/Turn on captions/.test(sel)) {
        return st.inCall && !st.captionsOn ? { click: () => { st.clicks++; st.captionsOn = true; } } : null;
      }
      if (/role="region"/.test(sel)) return { querySelectorAll: () => st.blocks };
      return null;
    },
    querySelectorAll: (sel) => (/subtitle__item/.test(sel) ? st.blocks : []),
  };
  const win = { document, frames: [], location: { hostname: host, pathname, href: `https://${host}${pathname}` } };
  win.top = win;
  return { st, win };
}

// Runs content.js inside `frame` (defaults to the top window of `pg`) and returns controls.
function run(pg, frame = pg.win) {
  let now = 1_000_000;
  const sent = [], intervals = [], listeners = {};
  const FakeDate = class extends Date { static now() { return now; } };
  const ctx = vm.createContext({
    window: frame, document: frame.document, location: frame.location,
    Date: FakeDate, crypto: { randomUUID: () => Math.random().toString(16).slice(2) + 'abcdefgh' },
    MutationObserver: class { observe() {} },
    setTimeout: () => 0, setInterval: (fn) => intervals.push(fn),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    chrome: { runtime: { sendMessage: async (m) => { sent.push(structuredClone(m)); } } },
  });
  vm.runInContext(SRC, ctx);
  return {
    sent, active: intervals.length > 0,
    // Advance the clock in 2s interval ticks.
    advance(ms) { for (let t = 0; t < ms; t += 2000) { now += 2000; intervals.forEach((f) => f()); } },
    fire: (type) => listeners[type]?.(),
    saves: () => sent.filter((m) => m.type === 'save'),
    finals: () => sent.filter((m) => m.type === 'finalize'),
  };
}

const block = (speaker, text) => ({ innerText: speaker ? `${speaker}\n${text}` : text, querySelector: () => null });
const lastSession = (cs) => cs.saves().at(-1).session;
const lines = (cs) => lastSession(cs).entries.map((e) => [e.speaker, e.text]);

test('does nothing on non-meeting Meet pages', () => {
  assert.equal(run(page({ pathname: '/landing' })).active, false);
});

test('turns captions on once and does not fight the user afterwards', () => {
  const pg = page({ ui: { inCall: true } });
  const cs = run(pg);
  cs.advance(2000);
  assert.equal(pg.st.clicks, 1);
  pg.st.captionsOn = false; // user turned them off
  cs.advance(10000);
  assert.equal(pg.st.clicks, 1);
});

test('growing caption lines are deduped into one entry; speakers split entries', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const b1 = block('Ann', 'hel');
  pg.st.blocks = [b1];
  cs.advance(2000);
  b1.innerText = 'Ann\nhello world';
  cs.advance(2000);
  // Meet re-renders the same utterance into a new element.
  pg.st.blocks = [block('Ann', 'hello world, how are you')];
  cs.advance(2000);
  pg.st.blocks.push(block('Bob', 'fine thanks'));
  cs.advance(4000);
  const s = cs.saves().at(-1).session;
  assert.deepEqual(s.entries.map((e) => [e.speaker, e.text]),
    [['Ann', 'hello world, how are you'], ['Bob', 'fine thanks']]);
  assert.equal(s.platform, 'meet');
  assert.equal(s.title, 'Meet - abc-defg-hij');
});

test('saves are throttled to one per 3s and skipped when nothing changed', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const b = block('Ann', 'a');
  pg.st.blocks = [b];
  for (let i = 0; i < 6; i++) { b.innerText += 'a'; cs.advance(2000); }
  assert.ok(cs.saves().length <= 4, `got ${cs.saves().length} saves in 12s`);
  cs.advance(4000); // the last change is still pending behind the throttle
  const n = cs.saves().length;
  assert.equal(cs.saves().at(-1).session.entries[0].text, 'a'.repeat(7));
  cs.advance(10000);
  assert.equal(cs.saves().length, n);
});

test('leaving the call finalizes after 10s and leftover captions do not start a new session', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  pg.st.blocks = [block('Ann', 'bye')];
  cs.advance(2000);
  pg.st.inCall = false; // call UI gone, caption DOM still there
  cs.advance(8000);
  assert.equal(cs.finals().length, 0, 'brief UI flicker must not end the session');
  cs.advance(6000);
  assert.equal(cs.finals().length, 1);
  assert.equal(cs.finals()[0].session.entries[0].text, 'bye');
  cs.advance(20000);
  assert.equal(cs.finals().length, 1);
  assert.equal(cs.saves().filter((m) => m.session.id !== cs.finals()[0].id).length, 0);
});

test('joining a different meeting in the same tab starts a new session', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  pg.st.blocks = [block('Ann', 'first meeting')];
  cs.advance(4000);
  pg.win.location.pathname = '/xyz-wxyz-xyz';
  pg.st.blocks = [block('Bob', 'second meeting')];
  cs.advance(4000);
  assert.equal(cs.finals().length, 1);
  assert.deepEqual(cs.finals()[0].session.entries.map((e) => e.text), ['first meeting']);
  const second = cs.saves().at(-1).session;
  assert.notEqual(second.id, cs.finals()[0].id);
  assert.equal(second.key, 'xyz-wxyz-xyz');
  assert.deepEqual(second.entries.map((e) => e.text), ['second meeting']);
});

test('pagehide finalizes with the newest captions, even unsaved ones', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  pg.st.blocks = [block('Ann', 'last words')];
  cs.advance(2000);
  cs.fire('pagehide');
  assert.equal(cs.finals().length, 1);
  assert.equal(cs.finals()[0].session.entries[0].text, 'last words');
});

test('Zoom: only the caption frame reports, and Leave in another same-origin frame counts as in call', () => {
  const top = page({ host: 'app.zoom.us', pathname: '/wc/123456789/join', title: 'Zoom Meeting', ui: { inCall: true } });
  const inner = page({ host: 'app.zoom.us', pathname: '/wc/123456789/join', title: '' });
  const other = page({ host: 'app.zoom.us', pathname: '/wc/123456789/join', title: '' });
  for (const f of [inner, other]) { f.win.top = top.win; top.win.frames.push(f.win); }

  const csTop = run(top), csInner = run(top, inner.win), csOther = run(top, other.win);
  inner.st.blocks = [block('Ann', 'zoom caption')];
  for (const cs of [csTop, csInner, csOther]) cs.advance(30000);

  assert.equal(csTop.sent.length + csOther.sent.length, 0);
  assert.equal(csInner.finals().length, 0, 'session must stay alive while the top frame shows Leave');
  const s = csInner.saves().at(-1).session;
  assert.equal(s.platform, 'zoom');
  assert.equal(s.key, '123456789');
  assert.equal(s.title, 'Zoom Meeting');
  assert.equal(s.entries[0].text, 'zoom caption');
});

test('Meet UI inside the captions region (Jump to bottom) is ignored', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const jump = { innerText: 'arrow_downward\nJump to bottom', querySelector: (sel) => (sel === 'button' ? {} : null) };
  pg.st.blocks = [block('Zaki', 'progress update'), jump];
  cs.advance(4000);
  assert.deepEqual(lines(cs), [['Zaki', 'progress update']]);
});

test('long monologue keeps the words Meet trims from the start of the block', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const b = block('Zaki', 'one two three four five six seven eight nine ten');
  pg.st.blocks = [b];
  cs.advance(2000);
  b.innerText = 'Zaki\nfive six seven eight nine ten eleven twelve';
  cs.advance(2000);
  b.innerText = 'Zaki\nnine ten eleven twelve thirteen fourteen';
  cs.advance(4000);
  assert.deepEqual(lines(cs),
    [['Zaki', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen']]);
});

test('recognition revisions replace earlier words, even when shorter', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const b = block('Ann', 'the meeting is at two thousand hours');
  pg.st.blocks = [b];
  cs.advance(2000);
  b.innerText = 'Ann\nthe meeting is at 2000 hours';
  cs.advance(4000);
  assert.deepEqual(lines(cs), [['Ann', 'the meeting is at 2000 hours']]);
});

test('a block element reused for another speaker starts a new entry', () => {
  const pg = page({ ui: { inCall: true, captionsOn: true } });
  const cs = run(pg);
  const b = block('Ann', 'my turn');
  pg.st.blocks = [b];
  cs.advance(2000);
  b.innerText = 'Bob\nnow mine';
  cs.advance(4000);
  assert.deepEqual(lines(cs), [['Ann', 'my turn'], ['Bob', 'now mine']]);
});
