// YouTube Words — content script (runs on *.youtube.com, top frame only, at document_start).
// Renders the lock overlay + word quiz. All decisions are made by the background worker;
// this script reports "I'm being watched" heartbeats and draws whatever state it is told.
// Note: YouTube enforces Trusted Types, so the DOM here is built with createElement only (no innerHTML).

(() => {
  if (window.top !== window) return;

  // If an older copy of this script is still running (extension was reloaded), retire it.
  try { window.__ywTeardown?.(); } catch {}

  const HEARTBEAT_MS = 5000;
  const ENFORCE_MS = 400;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let alive = true;
  let locked = false;
  let busy = false;          // an answer animation is playing in this tab
  let lastState = null;
  let quizId = null;
  let ui = null;             // overlay elements
  let enforceTimer = null;
  const resumeVideos = new Set();
  const timers = new Set();

  // ---------------------------------------------------------------- messaging

  function send(msg) {
    if (!alive) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(msg).catch((e) => { checkDead(e); return null; });
    } catch (e) {
      checkDead(e);
      return Promise.resolve(null);
    }
  }

  function checkDead(e) {
    if (!chrome.runtime?.id || /context invalidated/i.test(String(e?.message || e))) teardown();
  }

  async function refresh() {
    if (busy) return;
    const state = await send({ type: 'getState' });
    if (!state || state.error || busy) return;
    apply(state);
  }

  function apply(state) {
    lastState = state;
    if (state.locked) {
      lockPage();
      renderQuiz(state);
    } else if (locked) {
      unlockPage({ animate: true, celebrate: false });
    }
  }

  // ---------------------------------------------------------------- heartbeat

  // "Being watched" = the tab is on screen, OR something is playing even though the tab is hidden
  // (picture-in-picture, a covered window, YouTube playing in a background tab).
  function inUse() {
    if (document.visibilityState === 'visible') return true;
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused && !m.ended && m.readyState > 2) return true;
    }
    return !!document.pictureInPictureElement;
  }

  async function heartbeat() {
    if (!inUse()) return;
    const r = await send({ type: 'heartbeat' });
    if (!r || r.error) return;
    if (r.locked !== locked || (r.locked && r.quizId !== quizId)) refresh();
  }

  const hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  const onVisibility = () => { if (document.visibilityState === 'visible') { heartbeat(); refresh(); } };
  document.addEventListener('visibilitychange', onVisibility);

  const onStorage = (changes, area) => {
    if (area === 'local' && changes.state) refresh();
  };
  try { chrome.storage.onChanged.addListener(onStorage); } catch {}

  // ---------------------------------------------------------------- page control

  function pauseMedia() {
    for (const v of document.querySelectorAll('video, audio')) {
      if (!v.paused) {
        resumeVideos.add(v);
        try { v.pause(); } catch {}
      }
    }
  }

  // Videos that start (autoplay, next video, media keys) while locked are stopped immediately.
  const onPlay = (e) => {
    if (!locked) return;
    const t = e.target;
    if (t instanceof HTMLMediaElement) {
      resumeVideos.add(t);
      try { t.pause(); } catch {}
    }
  };
  document.addEventListener('play', onPlay, true);
  document.addEventListener('playing', onPlay, true);

  // Block every key from reaching YouTube (space, k, arrows, f, etc.) while locked.
  // Enter / Space / Tab still work on our own buttons.
  const onKey = (e) => {
    if (!locked) return;
    const inside = ui && e.composedPath().includes(ui.host);
    if (inside && (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ')) {
      e.stopImmediatePropagation();
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, onKey, true);

  // Scrolling is allowed inside the quiz card (small windows) but never reaches the page.
  const onWheel = (e) => {
    if (!locked) return;
    if (ui && e.composedPath().includes(ui.host)) { e.stopImmediatePropagation(); return; }
    e.preventDefault();
  };
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('touchmove', onWheel, { capture: true, passive: false });

  function exitFullscreen() {
    try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
    try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch {}
  }

  function enforce() {
    if (!locked) return;
    pauseMedia();
    exitFullscreen();
    if (ui && !ui.host.isConnected) (document.documentElement || document).appendChild(ui.host);
  }

  const observer = new MutationObserver(() => {
    if (locked && ui && !ui.host.isConnected) document.documentElement.appendChild(ui.host);
  });

  function lockPage() {
    if (locked) return;
    locked = true;
    buildOverlay();
    enforce();
    enforceTimer = setInterval(enforce, ENFORCE_MS);
    observer.observe(document.documentElement, { childList: true });
    document.documentElement.style.setProperty('overflow', 'hidden', 'important');
  }

  async function unlockPage({ animate, celebrate }) {
    if (!locked) return;
    busy = true;
    if (animate && ui) await playUnlock(celebrate);
    locked = false;
    clearInterval(enforceTimer);
    observer.disconnect();
    document.documentElement.style.removeProperty('overflow');
    ui?.host.remove();
    ui = null;
    quizId = null;
    busy = false;
    for (const v of resumeVideos) {
      if (v.isConnected) v.play().catch(() => {});
    }
    resumeVideos.clear();
  }

  // ---------------------------------------------------------------- sound

  const audio = (() => {
    let ctx = null;
    const cache = new Map();
    let voice = null;

    function context() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    async function decode(dataUrl) {
      if (cache.has(dataUrl)) return cache.get(dataUrl);
      const c = context();
      if (!c) return null;
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const p = c.decodeAudioData(bytes.buffer).catch(() => null);
      cache.set(dataUrl, p);
      return p;
    }

    // Plays a spoken clip; resolves when it finishes (or immediately if it can't play).
    async function say(dataUrl) {
      if (!dataUrl) return;
      const c = context();
      const buf = await decode(dataUrl);
      // Before the child has clicked anything, Chrome may keep audio suspended; skip rather than play late.
      if (!c || !buf || !alive || c.state !== 'running') return;
      try { voice?.stop(); } catch {}
      return new Promise((resolve) => {
        const src = c.createBufferSource();
        const gain = c.createGain();
        gain.gain.value = 1;
        src.buffer = buf;
        src.connect(gain).connect(c.destination);
        src.onended = () => resolve();
        src.start();
        voice = src;
        setTimeout(resolve, buf.duration * 1000 + 300);
      });
    }

    function tone(freq, start, dur, type = 'sine', vol = 0.18) {
      const c = context();
      if (!c) return;
      const t = c.currentTime + start;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
      return o;
    }

    const fx = {
      pop() { tone(660, 0, 0.12, 'triangle', 0.12); },
      whoosh() {
        const c = context();
        if (!c) return;
        const o = tone(300, 0, 0.45, 'sine', 0.08);
        o?.frequency.exponentialRampToValueAtTime(900, c.currentTime + 0.4);
      },
      correct() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.35, 'triangle', 0.16)); },
      wrong() {
        const c = context();
        if (!c) return;
        const o1 = tone(392, 0, 0.3, 'sine', 0.14);
        const o2 = tone(330, 0.28, 0.5, 'sine', 0.14);
        o2?.frequency.exponentialRampToValueAtTime(262, c.currentTime + 0.75);
        return o1;
      },
      fanfare() {
        [523, 659, 784].forEach((f, i) => tone(f, i * 0.12, 0.2, 'square', 0.06));
        tone(1047, 0.38, 0.7, 'triangle', 0.16);
        tone(784, 0.38, 0.7, 'triangle', 0.1);
      },
    };

    return { say, fx, warm: context };
  })();

  const pick = (list) => (list && list.length ? list[Math.floor(Math.random() * list.length)] : null);

  // ---------------------------------------------------------------- font

  (async () => {
    const family = 'YW Andika';
    try {
      const res = await fetch(chrome.runtime.getURL('assets/fonts/Andika-Bold.woff2'));
      const face = new FontFace(family, await res.arrayBuffer(), { weight: '700' });
      document.fonts.add(await face.load());
    } catch {
      try {
        const face = new FontFace(family, `url(${chrome.runtime.getURL('assets/fonts/Andika-Bold.woff2')})`, { weight: '700' });
        document.fonts.add(await face.load());
      } catch {}
    }
  })();

  // ---------------------------------------------------------------- DOM helpers

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.setAttribute('class', v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  }

  const wait = (ms) => new Promise((r) => { const id = setTimeout(() => { timers.delete(id); r(); }, ms); timers.add(id); });

  // ---------------------------------------------------------------- artwork

  function heart(full) {
    return s('svg', { viewBox: '0 0 24 24', class: `yw-heart${full ? '' : ' yw-heart-empty'}` },
      s('path', { d: 'M12 21s-7.5-4.6-9.6-9.3C.8 8 3 4 6.8 4c2.2 0 3.6 1.2 4.2 2.3h2C13.6 5.2 15 4 17.2 4 21 4 23.2 8 21.6 11.7 19.5 16.4 12 21 12 21z' }));
  }

  function star(full) {
    return s('svg', { viewBox: '0 0 24 24', class: `yw-star${full ? '' : ' yw-star-empty'}` },
      s('path', { d: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z' }));
  }

  function speakerIcon() {
    return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      s('path', { d: 'M4 9h4l5-4v14l-5-4H4z', fill: 'currentColor' }),
      s('path', { d: 'M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  }

  function sadFace() {
    return s('svg', { viewBox: '0 0 120 120', class: 'yw-sad-svg' },
      s('circle', { cx: '60', cy: '60', r: '54', fill: '#7cc6ff', stroke: '#2d7fc1', 'stroke-width': '5' }),
      s('ellipse', { cx: '42', cy: '50', rx: '6', ry: '8', fill: '#1d3557', class: 'yw-blink' }),
      s('ellipse', { cx: '78', cy: '50', rx: '6', ry: '8', fill: '#1d3557', class: 'yw-blink' }),
      s('path', { d: 'M30 38 l14 -6 M90 38 l-14 -6', stroke: '#1d3557', 'stroke-width': '4', 'stroke-linecap': 'round' }),
      s('path', { d: 'M40 88 q20 -18 40 0', fill: 'none', stroke: '#1d3557', 'stroke-width': '5', 'stroke-linecap': 'round' }),
      s('path', { d: 'M84 58 q6 10 0 16 q-6 -6 0 -16z', fill: '#ffffff', stroke: '#2d7fc1', 'stroke-width': '2', class: 'yw-tear' }));
  }

  function padlock() {
    return s('svg', { viewBox: '0 0 120 140', class: 'yw-lock-svg' },
      s('path', { d: 'M32 64 V42 a28 28 0 0 1 56 0 V64', fill: 'none', stroke: '#ffd166', 'stroke-width': '12', 'stroke-linecap': 'round', class: 'yw-shackle' }),
      s('rect', { x: '16', y: '60', width: '88', height: '70', rx: '16', fill: '#ff8fab', stroke: '#c9184a', 'stroke-width': '5' }),
      s('circle', { cx: '60', cy: '90', r: '9', fill: '#590d22' }),
      s('rect', { x: '56', y: '92', width: '8', height: '20', rx: '4', fill: '#590d22' }));
  }

  function balloon(color) {
    return s('svg', { viewBox: '0 0 60 130', class: 'yw-balloon-svg' },
      s('path', { d: 'M30 82 C 28 95, 34 105, 28 128', fill: 'none', stroke: '#888', 'stroke-width': '1.5' }),
      s('path', { d: 'M30 4 C 6 4 0 26 4 42 C 8 62 22 76 30 80 C 38 76 52 62 56 42 C 60 26 54 4 30 4z', fill: color }),
      s('path', { d: 'M26 80 L34 80 L30 86z', fill: color }),
      s('ellipse', { cx: '20', cy: '24', rx: '6', ry: '10', fill: 'rgba(255,255,255,.55)', transform: 'rotate(-20 20 24)' }));
  }

  // ---------------------------------------------------------------- overlay

  function buildOverlay() {
    if (ui) return;
    const host = document.createElement('yw-reading-lock');
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'z-index: 2147483647 !important; display: block !important; pointer-events: auto !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.append(h('style', { text: CSS }));

    const bubbles = h('div', { class: 'yw-bubbles' },
      Array.from({ length: 14 }, (_, i) => h('span', {
        style: `left:${(i * 7.3) % 100}%; width:${30 + (i * 17) % 70}px; height:${30 + (i * 17) % 70}px;` +
          `animation-delay:${-(i * 1.7)}s; animation-duration:${12 + (i % 5) * 3}s;`,
      })));

    const title = h('div', { class: 'yw-title', text: 'Reading Time!' });
    const progress = h('div', { class: 'yw-progress', 'aria-label': 'quiz progress' });
    const hearts = h('div', { class: 'yw-hearts', 'aria-label': 'tries left' });
    const img = h('img', { class: 'yw-img', alt: 'What is this?', draggable: 'false' });
    const picture = h('div', { class: 'yw-picture' }, img);
    const speak = h('button', { class: 'yw-speak', 'aria-label': 'Hear the question again', title: 'Hear it again' }, speakerIcon());
    const question = h('div', { class: 'yw-question' }, h('span', { text: 'Which word matches the picture?' }), speak);
    const options = h('div', { class: 'yw-options' });
    const msg = h('div', { class: 'yw-msg', 'aria-live': 'polite' });
    const card = h('div', { class: 'yw-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reading quiz' },
      h('div', { class: 'yw-top' }, progress, title, hearts), picture, question, options, msg);

    const canvas = h('canvas', { class: 'yw-confetti' });
    const balloons = h('div', { class: 'yw-balloons' });
    const party = h('div', { class: 'yw-party' });
    const lockLayer = h('div', { class: 'yw-unlock' }, padlock(), h('div', { class: 'yw-unlock-text', text: 'Unlocked!' }));
    const wrap = h('div', { class: 'yw-root yw-enter' }, h('div', { class: 'yw-bg' }), bubbles, card, balloons, canvas, party, lockLayer);

    root.append(wrap);
    // Swallow clicks / context menus so nothing reaches the page underneath.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'dblclick', 'contextmenu']) {
      wrap.addEventListener(type, (e) => { e.stopPropagation(); if (type === 'contextmenu') e.preventDefault(); });
    }
    speak.addEventListener('click', () => { audio.warm(); audio.say(pick(lastState?.sounds?.prompt)); });

    (document.documentElement || document).appendChild(host);
    ui = { host, root, wrap, card, title, progress, hearts, img, picture, options, msg, canvas, balloons, party, lockLayer };
  }

  function renderHearts(total, left) {
    ui.hearts.replaceChildren(...Array.from({ length: total }, (_, i) => heart(i < left)));
  }

  function renderProgress(passed, required) {
    if (required <= 1) { ui.progress.replaceChildren(); return; }
    ui.progress.replaceChildren(...Array.from({ length: required }, (_, i) => star(i < passed)));
  }

  function renderQuiz(state) {
    const q = state.quiz;
    if (!ui || !q) return;
    const triesLeft = q.triesPerWord - q.wrongChoices.length;
    renderHearts(q.triesPerWord, triesLeft);
    renderProgress(q.passed, q.required);

    if (q.id === quizId) {
      // Same quiz (e.g. another tab answered wrong) — just sync the disabled buttons.
      for (const b of ui.options.children) if (q.wrongChoices.includes(b.dataset.word)) b.disabled = true;
      return;
    }
    const first = quizId === null;
    quizId = q.id;
    ui.msg.replaceChildren();
    ui.msg.className = 'yw-msg';
    ui.img.src = q.image || '';
    ui.picture.classList.remove('yw-pic-in');
    void ui.picture.offsetWidth;
    ui.picture.classList.add('yw-pic-in');
    ui.card.classList.toggle('yw-card-next', !first);

    const colors = ['coral', 'sky', 'lime', 'sun'];
    ui.options.replaceChildren(...q.options.map((word, i) => h('button', {
      class: `yw-opt yw-${colors[i % 4]}`,
      style: `animation-delay:${(first ? 650 : 150) + i * 110}ms`,
      'data-word': word,
      disabled: q.wrongChoices.includes(word),
      text: word,
      onclick: (e) => choose(e.currentTarget, word),
    })));

    setTimeout(() => { if (quizId === q.id && !busy) audio.say(pick(state.sounds?.prompt)); }, first ? 700 : 250);
  }

  function setButtons(enabled) {
    for (const b of ui.options.children) {
      if (!enabled) b.disabled = true;
      else b.disabled = (lastState?.quiz?.wrongChoices || []).includes(b.dataset.word);
    }
  }

  function message(kind, ...parts) {
    ui.msg.className = `yw-msg yw-msg-${kind}`;
    ui.msg.replaceChildren(...parts);
    void ui.msg.offsetWidth;
    ui.msg.classList.add('yw-msg-in');
  }

  async function choose(btn, word) {
    if (busy || !ui) return;
    busy = true;
    audio.warm();
    audio.fx.pop();
    setButtons(false);
    btn.classList.add('yw-picked');
    const resp = await send({ type: 'answer', quizId, choice: word });
    if (!resp || resp.error || !ui) { busy = false; if (ui) setButtons(true); return; }
    const { result, next } = resp;
    lastState = next;

    try {
      if (result.outcome === 'stale') {
        // another tab moved on; fall through to refresh
      } else if (result.outcome === 'wrong') {
        await showWrong(btn, result);
      } else if (result.outcome === 'out-of-tries') {
        await showWrong(btn, result);
        await revealAnswer(result);
      } else if (result.outcome === 'correct') {
        await celebrate(btn, result);
        if (result.unlocked) {
          busy = false;
          await unlockPage({ animate: true, celebrate: true });
          return;
        }
      }
    } finally {
      busy = false;
    }
    if (next.locked) {
      apply(next);
      setButtons(true);
    } else {
      unlockPage({ animate: true, celebrate: false });
    }
  }

  async function showWrong(btn, result) {
    btn.classList.remove('yw-picked');
    btn.classList.add('yw-wrong');
    audio.fx.wrong();
    const left = result.triesLeft;
    renderHearts(lastState?.quiz?.triesPerWord || left + 1, left);
    const face = h('div', { class: 'yw-sad' }, sadFace());
    const text = left > 0
      ? h('div', {}, h('div', { class: 'yw-big', text: 'Oops! Try again!' }),
          h('div', { text: `You can do it! ${left} ${left === 1 ? 'try' : 'tries'} left.` }))
      : h('div', {}, h('div', { class: 'yw-big', text: 'Good try!' }));
    message('wrong', face, text);
    if (left > 0) {
      await Promise.all([wait(1600), audio.say(pick(lastState?.sounds?.tryAgain))]);
    } else {
      await wait(1200);
    }
  }

  async function revealAnswer(result) {
    for (const b of ui.options.children) {
      if (b.dataset.word === result.word) b.classList.add('yw-reveal');
      else b.classList.add('yw-fade');
    }
    message('reveal', h('div', {},
      h('div', { class: 'yw-big' }, 'This one says ', h('span', { class: 'yw-answer', text: result.word }), '!'),
      h('div', { text: "Let's try a new word." })));
    await audio.say(result.wordAudio);
    await Promise.all([wait(1800), audio.say(pick(lastState?.sounds?.newWord))]);
  }

  async function celebrate(btn, result) {
    btn.classList.remove('yw-picked');
    btn.classList.add('yw-right');
    for (const b of ui.options.children) if (b !== btn) b.classList.add('yw-fade');
    audio.fx.correct();
    const cheers = ['Great job!', 'You got it!', 'Super reader!', 'Awesome!', 'Woo-hoo!'];
    ui.party.replaceChildren(h('div', { class: 'yw-party-text', text: pick(cheers) }));
    ui.party.classList.add('yw-party-on');
    confetti(ui.canvas);
    launchBalloons(result.unlocked ? 14 : 7);
    renderProgress(result.passed, result.required);
    await Promise.all([
      wait(result.unlocked ? 2600 : 2200),
      (async () => {
        await audio.say(pick(lastState?.sounds?.correct));
        await audio.say(result.wordAudio);
        if (!result.unlocked) await audio.say(pick(lastState?.sounds?.anotherOne));
      })(),
    ]);
    ui.party.classList.remove('yw-party-on');
  }

  async function playUnlock(withSound) {
    if (!ui) return;
    if (withSound) {
      audio.fx.fanfare();
      audio.say(pick(lastState?.sounds?.unlocked));
    } else {
      audio.fx.whoosh();
    }
    ui.wrap.classList.add('yw-unlocking');
    await wait(1500);
    ui.wrap.classList.add('yw-leaving');
    await wait(750);
  }

  function launchBalloons(n) {
    const colors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff70a6', '#ff924c'];
    for (let i = 0; i < n; i++) {
      const b = h('div', {
        class: 'yw-balloon',
        style: `left:${5 + Math.random() * 88}%; animation-duration:${3.2 + Math.random() * 2}s; ` +
          `animation-delay:${Math.random() * 0.6}s; --sway:${(Math.random() * 60 - 30).toFixed(0)}px; ` +
          `--scale:${(0.7 + Math.random() * 0.6).toFixed(2)};`,
      }, balloon(colors[i % colors.length]));
      ui.balloons.append(b);
      setTimeout(() => b.remove(), 6500);
    }
  }

  function confetti(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || window.innerWidth;
    const H = canvas.clientHeight || window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const colors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff70a6', '#ffffff'];
    const parts = [];
    const burst = (x, y, n, spread, power) => {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
        const v = power * (0.5 + Math.random());
        parts.push({
          x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          w: 6 + Math.random() * 8, h: 4 + Math.random() * 6,
          r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          c: colors[(Math.random() * colors.length) | 0], shape: Math.random() < 0.3 ? 'circle' : 'rect',
        });
      }
    };
    burst(W / 2, H * 0.55, 160, Math.PI * 0.9, 17);
    burst(0, H, 70, Math.PI * 0.5, 20);
    burst(W, H, 70, Math.PI * 0.5, 20);
    for (const p of parts.slice(-70)) p.vx = -Math.abs(p.vx);
    for (const p of parts.slice(160, 230)) p.vx = Math.abs(p.vx);
    const start = performance.now();
    const frame = (now) => {
      if (!ui || !alive) return;
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.38; p.vx *= 0.99; p.vy *= 0.99;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t / 3200);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2.5, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1);
        ctx.restore();
      }
      if (t < 3300) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- teardown

  function teardown() {
    if (!alive) return;
    alive = false;
    clearInterval(hbTimer);
    clearInterval(enforceTimer);
    timers.forEach(clearTimeout);
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('play', onPlay, true);
    document.removeEventListener('playing', onPlay, true);
    for (const type of ['keydown', 'keyup', 'keypress']) window.removeEventListener(type, onKey, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('touchmove', onWheel, true);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    if (locked) document.documentElement.style.removeProperty('overflow');
    locked = false;
    ui?.host.remove();
    ui = null;
  }
  window.__ywTeardown = teardown;

  // ---------------------------------------------------------------- styles

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.yw-root {
  --font: 'YW Andika', 'Andika', 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', 'Trebuchet MS', system-ui, sans-serif;
  position: fixed; inset: 0; display: grid; place-items: center; overflow: hidden;
  font-family: var(--font); color: #2b2d42; user-select: none; -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.yw-bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 15% 20%, rgba(255,210,120,.55), transparent 40%),
    radial-gradient(circle at 85% 30%, rgba(255,120,180,.5), transparent 45%),
    radial-gradient(circle at 50% 100%, rgba(80,200,255,.55), transparent 50%),
    linear-gradient(135deg, rgba(110,72,220,.93), rgba(52,108,230,.93));
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  background-size: 160% 160%;
  animation: yw-bg-in .6s ease-out both, yw-bg-move 14s ease-in-out infinite alternate;
}
@keyframes yw-bg-in { from { opacity: 0; backdrop-filter: blur(0); } to { opacity: 1; } }
@keyframes yw-bg-move { from { background-position: 0% 0%; } to { background-position: 100% 100%; } }

.yw-bubbles { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.yw-bubbles span {
  position: absolute; bottom: -120px; border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,.55), rgba(255,255,255,.08));
  animation: yw-float linear infinite;
}
@keyframes yw-float { from { transform: translateY(0) } to { transform: translateY(-125vh) } }

.yw-card {
  position: relative; z-index: 2;
  width: min(680px, 94vw); max-height: 96vh; overflow: auto;
  padding: clamp(14px, 2.6vh, 26px) clamp(16px, 3vw, 34px) clamp(14px, 2.4vh, 24px);
  background: #fffdf7; border-radius: 34px;
  border: 6px solid #fff; outline: 6px solid #ffd166;
  box-shadow: 0 24px 60px rgba(20,10,60,.45), 0 0 0 14px rgba(255,255,255,.25);
  text-align: center;
  animation: yw-drop .9s cubic-bezier(.2,1.4,.4,1) .15s both;
}
.yw-card-next { animation: yw-swap .6s cubic-bezier(.2,1.3,.4,1) both; }
@keyframes yw-drop {
  0% { transform: translateY(-120vh) rotate(-10deg) scale(.7); }
  70% { transform: translateY(14px) rotate(2deg) scale(1.02); }
  100% { transform: none; }
}
@keyframes yw-swap {
  0% { transform: scale(.85) rotate(-3deg); opacity: .4; }
  100% { transform: none; opacity: 1; }
}

.yw-top { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; }
.yw-title {
  font-size: clamp(24px, 4.2vh, 40px); font-weight: 700; color: #6a4c93; letter-spacing: .5px;
  text-shadow: 0 3px 0 #ffd166;
  animation: yw-title 2.4s ease-in-out infinite;
}
@keyframes yw-title { 50% { transform: rotate(-2deg) scale(1.04); } }
.yw-progress { display: flex; gap: 4px; justify-content: flex-start; }
.yw-hearts { display: flex; gap: 4px; justify-content: flex-end; }
.yw-heart, .yw-star { width: clamp(22px, 3.4vh, 32px); height: clamp(22px, 3.4vh, 32px); transition: transform .3s; }
.yw-heart path { fill: #ff4d6d; stroke: #c9184a; stroke-width: 1.5; }
.yw-heart-empty path { fill: #e9ecef; stroke: #adb5bd; }
.yw-heart-empty { animation: yw-lose .5s ease-out; }
@keyframes yw-lose { 30% { transform: scale(1.5) rotate(-15deg); } }
.yw-star path { fill: #ffca3a; stroke: #e09f00; stroke-width: 1.5; }
.yw-star-empty path { fill: #e9ecef; stroke: #adb5bd; }

.yw-picture {
  margin: clamp(8px, 1.6vh, 16px) auto;
  width: clamp(150px, 34vh, 300px); aspect-ratio: 1; border-radius: 28px; overflow: hidden;
  background: #fff; border: 5px solid #ffd166; box-shadow: 0 8px 0 #f4a261, 0 14px 24px rgba(0,0,0,.15);
}
.yw-pic-in { animation: yw-pic .8s cubic-bezier(.2,1.6,.4,1) .35s both, yw-bob 3.2s ease-in-out 1.2s infinite; }
@keyframes yw-pic { 0% { transform: scale(0) rotate(-20deg); } 100% { transform: none; } }
@keyframes yw-bob { 50% { transform: translateY(-6px) rotate(1.5deg); } }
.yw-img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }

.yw-question {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  font-size: clamp(18px, 2.8vh, 26px); color: #3d405b; margin-bottom: clamp(8px, 1.6vh, 16px);
}
.yw-speak {
  all: unset; cursor: pointer; display: grid; place-items: center;
  width: 44px; height: 44px; border-radius: 50%; color: #fff; background: #8338ec;
  box-shadow: 0 4px 0 #5a189a; transition: transform .1s;
}
.yw-speak svg { width: 24px; height: 24px; }
.yw-speak:hover { transform: scale(1.08); }
.yw-speak:active { transform: translateY(3px); box-shadow: 0 1px 0 #5a189a; }
.yw-speak:focus-visible { outline: 4px solid #ffd166; outline-offset: 3px; }

.yw-options { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(10px, 1.8vh, 18px); }
.yw-opt {
  all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
  font-family: var(--font); font-weight: 700; font-size: clamp(30px, 6vh, 56px); line-height: 1.1;
  padding: clamp(8px, 1.6vh, 16px) 10px; border-radius: 22px; color: #fff;
  text-shadow: 0 3px 0 rgba(0,0,0,.18); letter-spacing: 2px;
  transition: transform .12s, box-shadow .12s, opacity .3s, filter .3s;
  animation: yw-pop .55s cubic-bezier(.2,1.6,.4,1) both;
}
@keyframes yw-pop { 0% { transform: scale(0); opacity: 0; } 100% { transform: none; opacity: 1; } }
.yw-coral { background: #ff6b6b; box-shadow: 0 8px 0 #c44545; }
.yw-sky   { background: #4dabf7; box-shadow: 0 8px 0 #1c7ed6; }
.yw-lime  { background: #51cf66; box-shadow: 0 8px 0 #2f9e44; }
.yw-sun   { background: #fcc419; box-shadow: 0 8px 0 #e67700; }
.yw-opt:not(:disabled):hover { transform: translateY(-3px) scale(1.03); filter: brightness(1.06); }
.yw-opt:not(:disabled):active { transform: translateY(6px); box-shadow: 0 2px 0 rgba(0,0,0,.25); }
.yw-opt:focus-visible { outline: 5px solid #6a4c93; outline-offset: 3px; }
.yw-opt:disabled { cursor: default; }
.yw-picked { transform: scale(1.06); }
.yw-wrong { background: #adb5bd !important; box-shadow: 0 8px 0 #868e96 !important; animation: yw-shake .5s; opacity: .55; }
@keyframes yw-shake {
  15%, 55% { transform: translateX(-12px) rotate(-3deg); }
  35%, 75% { transform: translateX(12px) rotate(3deg); }
}
.yw-right {
  background: #2fbf71 !important; box-shadow: 0 8px 0 #1b8a4f, 0 0 0 8px rgba(47,191,113,.35) !important;
  animation: yw-win 1s ease-in-out infinite; position: relative; z-index: 3;
}
@keyframes yw-win { 50% { transform: scale(1.12) rotate(-2deg); } }
.yw-reveal {
  background: #2fbf71 !important; box-shadow: 0 8px 0 #1b8a4f, 0 0 0 8px rgba(255,209,102,.8) !important;
  animation: yw-win 1s ease-in-out infinite;
}
.yw-fade { opacity: .25; filter: grayscale(.6); }

.yw-msg { min-height: 0; margin-top: 10px; font-size: clamp(16px, 2.4vh, 22px); color: #3d405b; }
.yw-msg:empty { margin: 0; }
.yw-msg-in { animation: yw-msg .5s cubic-bezier(.2,1.5,.4,1) both; }
@keyframes yw-msg { from { transform: translateY(16px) scale(.8); opacity: 0; } }
.yw-msg-wrong, .yw-msg-reveal { display: flex; align-items: center; justify-content: center; gap: 14px; text-align: left; }
.yw-big { font-size: clamp(20px, 3.2vh, 30px); font-weight: 700; color: #6a4c93; }
.yw-answer { color: #2fbf71; font-size: 1.2em; padding: 0 4px; }
.yw-sad { width: clamp(56px, 9vh, 84px); flex: none; animation: yw-sad-in .7s cubic-bezier(.2,1.6,.4,1) both, yw-droop 2s ease-in-out .7s infinite; }
.yw-sad-svg { width: 100%; height: auto; display: block; }
@keyframes yw-sad-in { 0% { transform: scale(0) rotate(30deg); } 100% { transform: none; } }
@keyframes yw-droop { 50% { transform: rotate(-8deg) translateY(3px); } }
.yw-tear { animation: yw-tear 1.4s ease-in .4s infinite; transform-box: fill-box; }
@keyframes yw-tear { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(40px); opacity: 0; } }

.yw-confetti { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5; }
.yw-balloons { position: absolute; inset: 0; pointer-events: none; z-index: 4; overflow: hidden; }
.yw-balloon {
  position: absolute; bottom: -180px; width: 70px;
  animation: yw-rise linear both;
}
.yw-balloon-svg { width: 100%; height: auto; transform: scale(var(--scale, 1)); animation: yw-sway 1.6s ease-in-out infinite alternate; }
@keyframes yw-rise { to { transform: translateY(-135vh); } }
@keyframes yw-sway { from { translate: calc(var(--sway) * -1) 0; rotate: -6deg; } to { translate: var(--sway) 0; rotate: 6deg; } }

.yw-party { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 6; }
.yw-party-text {
  font-size: clamp(48px, 11vh, 120px); font-weight: 700; color: #fff;
  text-shadow: 0 6px 0 #ff006e, 0 12px 30px rgba(0,0,0,.35);
  -webkit-text-stroke: 3px #ff006e; opacity: 0;
}
.yw-party-on .yw-party-text { animation: yw-cheer 2.2s cubic-bezier(.2,1.5,.4,1) both; }
@keyframes yw-cheer {
  0% { transform: scale(0) rotate(-20deg); opacity: 0; }
  25% { transform: scale(1.15) rotate(4deg); opacity: 1; }
  40% { transform: scale(1) rotate(-2deg); }
  85% { opacity: 1; transform: scale(1.04); }
  100% { opacity: 0; transform: scale(1.3) translateY(-40px); }
}

.yw-unlock {
  position: absolute; inset: 0; z-index: 7; display: grid; place-content: center; justify-items: center; gap: 10px;
  pointer-events: none; opacity: 0;
}
.yw-lock-svg { width: clamp(110px, 22vh, 190px); height: auto; overflow: visible; }
.yw-shackle { transform-box: fill-box; transform-origin: 85% 100%; }
.yw-unlock-text { font-size: clamp(36px, 7vh, 72px); font-weight: 700; color: #fff; text-shadow: 0 5px 0 #6a4c93; opacity: 0; }
.yw-unlocking .yw-card { animation: yw-card-out .5s ease-in both; }
@keyframes yw-card-out { to { transform: scale(.6) translateY(40px); opacity: 0; } }
.yw-unlocking .yw-unlock { animation: yw-fade-in .3s ease-out .3s both; }
.yw-unlocking .yw-lock-svg { animation: yw-lock-pop .5s cubic-bezier(.2,1.6,.4,1) .3s both, yw-lock-jiggle .3s ease-in-out .8s 2; }
.yw-unlocking .yw-shackle { animation: yw-shackle .5s cubic-bezier(.2,1.6,.4,1) 1.05s both; }
.yw-unlocking .yw-unlock-text { animation: yw-msg .5s cubic-bezier(.2,1.5,.4,1) 1.1s both; }
@keyframes yw-fade-in { to { opacity: 1; } }
@keyframes yw-lock-pop { from { transform: scale(0); } }
@keyframes yw-lock-jiggle { 25% { transform: rotate(-8deg); } 75% { transform: rotate(8deg); } }
@keyframes yw-shackle { to { transform: translateY(-22px) rotate(-28deg); } }
.yw-leaving { animation: yw-out .75s cubic-bezier(.6,0,.4,1) both; }
@keyframes yw-out {
  from { clip-path: circle(150% at 50% 50%); }
  to { clip-path: circle(0% at 50% 50%); }
}
@media (prefers-reduced-motion: reduce) {
  .yw-bubbles, .yw-balloons { display: none; }
  .yw-pic-in, .yw-title, .yw-right, .yw-reveal, .yw-sad { animation-iteration-count: 1 !important; }
}
`;

  // ---------------------------------------------------------------- go

  refresh();
  heartbeat();
})();
