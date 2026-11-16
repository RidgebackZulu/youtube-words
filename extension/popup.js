const $ = (id) => document.getElementById(id);
const send = (type) => chrome.runtime.sendMessage({ type });

let data = null;
let sortMode = 'hard';

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((k) => k != null));
  return e;
}

const fmtClock = (sec) => {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const minutes = (m) => (m < 1 ? `${Math.round(m * 60)} sec` : `${+m.toFixed(2)} min`);

function renderStatus() {
  const d = data;
  const total = d.settings.overlayFrequencyMinutes * 60;
  $('version').textContent = `Extension v${d.extVersion} · words v${d.configVersion} (${d.configSource})`;
  const pill = $('pill');
  if (d.locked) {
    pill.textContent = 'Quiz time';
    pill.className = 'pill locked';
    const req = d.settings.quizzesToUnlock;
    $('status-text').textContent = req > 1
      ? `YouTube is locked — ${d.passedThisLock} of ${req} words read`
      : 'YouTube is locked until a word is read';
    $('bar').style.width = '100%';
  } else {
    pill.textContent = 'Watching';
    pill.className = 'pill';
    $('status-text').textContent = `Next quiz in ${fmtClock(total - d.usedSeconds)} of YouTube time`;
    $('bar').style.width = `${Math.min(100, (d.usedSeconds / total) * 100)}%`;
  }
  $('lock-now').disabled = d.locked;

  const m = d.meta || {};
  const note = $('update-note');
  note.className = `note${m.lastCheckOk === false ? ' err' : ''}`;
  note.textContent = m.lastCheckOk === false
    ? `Last GitHub check ${ago(m.lastCheck)} failed: ${m.lastError}`
    : `Last GitHub check ${ago(m.lastCheck)}${m.lastUpdate ? ` · last update ${ago(m.lastUpdate)}` : ''}`;

  const banner = $('ext-update');
  banner.hidden = !d.extUpdateAvailable;
  if (d.extUpdateAvailable) {
    banner.replaceChildren(
      `New extension version ${d.latestExtensionVersion} is on GitHub. Run `,
      el('code', { text: 'git pull' }),
      ' in the folder, then press reload on chrome://extensions.',
    );
  }
}

function renderSettings() {
  const s = data.settings;
  const rows = [
    ['Quiz every', `${minutes(s.overlayFrequencyMinutes)} of YouTube`],
    ['Words to unlock', s.quizzesToUnlock],
    ['Tries per word', s.triesPerWord],
    ['GitHub check every', minutes(s.githubCheckIntervalMinutes)],
    ['Words in rotation', data.words.length],
  ];
  $('settings').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));
}

function renderStats() {
  const stats = data.stats || {};
  const images = Object.fromEntries(data.words.map((w) => [w.word, w.image]));
  const rows = Object.entries(stats)
    .filter(([, s]) => s.correct + s.wrong > 0)
    .map(([word, s]) => ({ word, ...s, acc: s.correct / Math.max(1, s.correct + s.wrong) }));

  const correct = rows.reduce((a, r) => a + r.correct, 0);
  const wrong = rows.reduce((a, r) => a + r.wrong, 0);
  const firstTry = rows.reduce((a, r) => a + (r.firstTry || 0), 0);
  $('summary').replaceChildren(
    el('div', {}, el('b', { text: String(correct) }), el('span', { text: 'words read' })),
    el('div', {}, el('b', { text: correct + wrong ? `${Math.round((correct / (correct + wrong)) * 100)}%` : '–' }), el('span', { text: 'accuracy' })),
    el('div', {}, el('b', { text: correct ? `${Math.round((firstTry / correct) * 100)}%` : '–' }), el('span', { text: 'first try' })),
  );

  rows.sort(sortMode === 'hard'
    ? (a, b) => a.acc - b.acc || b.wrong - a.wrong
    : (a, b) => b.acc - a.acc || b.correct - a.correct);

  $('empty').hidden = rows.length > 0;
  $('words').replaceChildren(...rows.map((r) => {
    const mix = Object.entries(r.confusions || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return el('li', {},
      el('img', { src: images[r.word] || 'icons/icon48.png', alt: '' }),
      el('div', {},
        el('div', { class: 'w-name', text: r.word }),
        mix.length
          ? el('div', { class: 'w-mix' }, 'mixed up with ', ...mix.flatMap(([w, n], i) => [i ? ', ' : '', el('b', { text: w }), n > 1 ? ` ×${n}` : '']))
          : el('div', { class: 'w-mix', text: r.gaveUp ? `missed ${r.gaveUp}×` : 'no mix-ups' })),
      el('div', { class: 'w-acc' },
        el('div', { class: 'w-counts' }, el('span', { class: 'ok', text: `✓ ${r.correct}` }), '  ', el('span', { class: 'no', text: `✗ ${r.wrong}` })),
        el('div', { class: 'acc-bar' }, el('div', { style: `width:${Math.round(r.acc * 100)}%` }))));
  }));
}

async function load() {
  data = await send('getPopupData');
  if (!data || data.error) return;
  renderStatus();
  renderSettings();
  renderStats();
}

$('lock-now').addEventListener('click', async () => {
  await send('lockNow');
  load();
});

$('check').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  await send('checkUpdates');
  btn.textContent = 'Check for updates';
  btn.disabled = false;
  load();
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Reset all word statistics?')) return;
  await send('resetStats');
  load();
});

for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => {
    sortMode = b.dataset.sort;
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    renderStats();
  });
}

load();
setInterval(async () => {
  if (!data) return load();
  const fresh = await chrome.runtime.sendMessage({ type: 'getPopupData', light: true });
  if (!fresh || fresh.error) return;
  if (fresh.configVersion !== data.configVersion || fresh.words.length !== data.words.length) return load();
  const statsChanged = JSON.stringify(fresh.stats) !== JSON.stringify(data.stats);
  data = { ...fresh, words: data.words };
  renderStatus();
  if (statsChanged) renderStats();
}, 1000);
