(() => {
  const isMeet = location.hostname === 'meet.google.com';
  const platform = isMeet ? 'meet' : 'zoom';

  // The only part that breaks when Google/Zoom change their UI. Adjust selectors here.
  // inCall/enableCaptions/blocks take the document to query; meetingKey takes a Location.
  const ADAPTERS = {
    meet: {
      meetingKey: (loc) => loc.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] ?? null,
      inCall: (doc) => !!doc.querySelector('button[aria-label*="Leave call" i]'),
      // Returns true once captions are on, so we only click once per call and
      // never fight a user who turns them off afterwards.
      enableCaptions: (doc) => {
        if (doc.querySelector('button[aria-label*="Turn off captions" i]')) return true;
        const b = doc.querySelector('button[aria-label*="Turn on captions" i]');
        if (b) { b.click(); return true; }
        return false;
      },
      // Each direct child of the captions region is one block (speaker name + text).
      // Children with a button are UI, e.g. "Jump to bottom".
      blocks: (doc) => {
        const r = doc.querySelector('[role="region"][aria-label*="aption" i]');
        return r ? [...r.querySelectorAll(':scope > div')].filter((el) => !el.querySelector('button')) : [];
      },
    },
    zoom: {
      meetingKey: (loc) => loc.pathname.match(/\/wc\/(?:join\/)?(\d+)/)?.[1] ?? '',
      inCall: (doc) => !!doc.querySelector('[class*="footer__leave-btn"], button[aria-label*="Leave" i]'),
      enableCaptions: () => false,
      blocks: (doc) => [...doc.querySelectorAll('[class*="live-transcription-subtitle__item"]')],
    },
  };
  const A = ADAPTERS[platform];

  // Meet only has captions in the top frame of a meeting URL; skip its helper iframes.
  if (isMeet && (window !== window.top || !A.meetingKey(location))) return;

  // Zoom may split the call UI across same-origin frames (captions in one, Leave button
  // in another), so "in call" is checked across every frame we can reach.
  function docs() {
    const out = [];
    const walk = (w) => {
      try { out.push(w.document); } catch (e) { /* cross-origin frame */ }
      for (let i = 0; i < w.frames.length; i++) walk(w.frames[i]);
    };
    walk(window.top);
    return out;
  }
  const inCall = () => docs().some((d) => { try { return A.inCall(d); } catch (e) { return false; } });
  const pageTitle = () => { try { return window.top.document.title || document.title; } catch (e) { return document.title; } };

  let session = null, dirty = false, missingSince = 0, lastFlush = 0, scanTimer = 0, captionsOn = false;
  let seen = new WeakMap();

  const parse = (el) => {
    const lines = el.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    return lines.length > 1
      ? { speaker: lines[0], text: lines.slice(1).join(' ') }
      : { speaker: '', text: lines[0] };
  };

  // Combines the text we have with what the block shows now. Captions grow, get revised as
  // recognition improves, and in long monologues lose their start while the speaker keeps talking.
  function merge(old, cur) {
    if (!old || cur.startsWith(old)) return cur;
    if (old.startsWith(cur)) return old; // momentary shrink while re-rendering
    if (cur.length >= 12 && old.startsWith(cur.slice(0, 12))) return cur; // revision
    // Start was trimmed: line the visible text up with the end of what we have.
    for (const w of [...cur.matchAll(/\S+/g)].slice(0, 6)) {
      const tail = cur.slice(w.index), probe = tail.slice(0, 12);
      if (probe.length < 12) break;
      for (let at = old.lastIndexOf(probe); at >= 0; at = at ? old.lastIndexOf(probe, at - 1) : -1) {
        const m = Math.min(24, old.length - at, tail.length);
        if (old.slice(at, at + m) === tail.slice(0, m)) return old.slice(0, at) + tail;
      }
    }
    // No overlap: a short rewrite, or trimmed past what we saw. Never drop words in the latter.
    return cur.length >= old.length ? cur : `${old} ${cur}`;
  }

  // Only the frame whose own document shows captions ever creates a session, so
  // all_frames does not produce duplicate sessions.
  function scan() {
    const els = A.blocks(document);
    if (!els.length) return;
    const key = A.meetingKey(location);
    if (session && session.key !== key) end(); // same tab, different meeting
    if (!session && !inCall()) return;          // leftover captions after leaving
    for (const el of els) {
      const p = parse(el);
      if (!p) continue;
      if (!session) {
        session = { id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, key, platform,
                    title: pageTitle(), url: location.href, start: Date.now(), entries: [] };
      }
      let entry = seen.get(el);
      if (!entry || entry.speaker !== p.speaker) { // new block, or Meet reused one for someone else
        const l = session.entries.at(-1);
        const same = l && l.speaker === p.speaker && Date.now() - l.t < 15000 &&
          (p.text.startsWith(l.text) || l.text.startsWith(p.text));
        entry = same ? l : { t: Date.now(), speaker: p.speaker, text: '' };
        if (!same) session.entries.push(entry);
        seen.set(el, entry);
      }
      const text = merge(entry.text, p.text);
      if (text !== entry.text) {
        entry.text = text;
        dirty = true;
      }
    }
  }

  const send = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {} };

  function flush() {
    if (!session || !dirty || Date.now() - lastFlush < 3000) return;
    session.title = pageTitle() || session.title;
    send({ type: 'save', session });
    dirty = false;
    lastFlush = Date.now();
  }

  function end() {
    if (!session) return;
    send({ type: 'finalize', id: session.id, session });
    session = null;
    seen = new WeakMap();
    dirty = false;
    missingSince = 0;
  }

  new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 300);
  }).observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });

  setInterval(() => {
    if (inCall()) {
      missingSince = 0;
      if (!captionsOn) captionsOn = A.enableCaptions(document);
    } else {
      captionsOn = false;
      if (session && !missingSince) missingSince = Date.now();
    }
    scan();
    flush();
    if (session && missingSince && Date.now() - missingSince > 10000) end();
  }, 2000);

  addEventListener('pagehide', end);
})();
