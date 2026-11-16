// End-to-end test: loads the real extension into Chromium (Playwright) and drives a fake
// youtube.com page plus a local stand-in for GitHub. Screenshots go to test-results/.
//
//   npm run test:e2e            (headless)
//   HEADED=1 npm run test:e2e   (watch it)

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = path.join(ROOT, 'test-results');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ---------- fake GitHub (raw.githubusercontent.com stand-in) ----------
const bundled = JSON.parse(fs.readFileSync(path.join(EXT, 'config.conf'), 'utf8'));
const remoteConfig = {
  ...bundled,
  version: bundled.version + 1,
  settings: { ...bundled.settings, overlayFrequencyMinutes: 0.1, quizzesToUnlock: 2 },
  words: [
    ...bundled.words,
    // exists only on "GitHub" (not shipped in the extension folder)
    { word: 'yarn', distractors: ['barn', 'yard', 'year'], image: 'assets/images/yarn-remote-only.webp' },
    // picture missing on GitHub too -> must be dropped, not shown broken
    { word: 'yak', distractors: ['yap', 'oak', 'yes'], image: 'assets/images/missing.webp' },
  ],
};
const github = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/extension/config.conf') return res.end(JSON.stringify(remoteConfig));
  if (url.pathname === '/extension/manifest.json') return res.end(JSON.stringify({ version: '9.9.9' }));
  if (url.pathname === '/extension/assets/images/yarn-remote-only.webp') {
    res.setHeader('Content-Type', 'image/webp');
    return fs.createReadStream(path.join(EXT, 'assets/images/duck.webp')).pipe(res);
  }
  const file = path.join(EXT, url.pathname.replace(/^\/extension\//, ''));
  if (!file.startsWith(EXT) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => github.listen(0, '127.0.0.1', r));
const REMOTE = `http://127.0.0.1:${github.address().port}/extension/`;

// ---------- browser ----------
function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const def = chromium.executablePath();
  if (fs.existsSync(def)) return undefined;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytw-e2e-'));
const ctx = await chromium.launchPersistentContext(userData, {
  headless: !process.env.HEADED,
  executablePath: findChromium(),
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
});

const videoBytes = fs.readFileSync(path.join(ROOT, 'tests/fixtures/clip.webm'));
const ytHtml = `<!doctype html><html><head><title>Fake YouTube</title></head>
<body style="margin:0;background:#0f0f0f;color:#fff;font:16px sans-serif">
<div style="padding:12px 20px;font-weight:bold">▶ YouTube (test page)</div>
<video id="v" src="/clip.webm" loop muted autoplay playsinline style="width:960px;display:block;margin:0 auto"></video>
<p style="text-align:center">Some video description text</p>
<script>window.keys = 0; document.addEventListener('keydown', () => window.keys++);</script>
</body></html>`;
await ctx.route('https://www.youtube.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/clip.webm') return route.fulfill({ body: videoBytes, contentType: 'video/webm' });
  return route.fulfill({ body: ytHtml, contentType: 'text/html' });
});

let failures = 0;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  ok(`extension loaded (${extId})`);

  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);
  const msg = (m) => ext.evaluate((m) => chrome.runtime.sendMessage(m), m);
  const storage = (keys) => ext.evaluate((k) => chrome.storage.local.get(k), keys);
  const state = async () => (await storage('state')).state;

  // --------------------------------------------------------------
  step('GitHub update: new config.conf (6-second interval, 2 quizzes) + new extension version');
  await ext.evaluate((r) => chrome.storage.local.set({ remoteBase: r }), REMOTE);
  const meta = await msg({ type: 'checkUpdates' });
  assert.equal(meta.lastCheckOk, true, meta.lastError);
  const { config, configSource } = await storage(['config', 'configSource']);
  assert.equal(config.version, remoteConfig.version);
  assert.equal(config.settings.overlayFrequencyMinutes, 0.1);
  assert.equal(config.settings.quizzesToUnlock, 2);
  assert.equal(configSource, 'github');
  const assetKeys = Object.keys(await storage(null)).filter((k) => k.startsWith('asset:'));
  assert.ok(assetKeys.length >= 40, `downloaded ${assetKeys.length} assets`);
  const alarm = await sw.evaluate(() => chrome.alarms.get('github-check'));
  assert.equal(alarm.periodInMinutes, 30);
  ok(`config v${config.version} applied, ${assetKeys.length} assets cached, alarm every ${alarm.periodInMinutes} min`);
  const popupData = await msg({ type: 'getPopupData' });
  assert.equal(popupData.extUpdateAvailable, true);
  ok('popup reports newer extension version on GitHub');
  const words = config.words.map((w) => w.word);
  assert.ok(words.includes('yarn'), 'GitHub-only word added');
  assert.ok(!words.includes('yak'), 'word with missing picture dropped');
  assert.ok((await storage('asset:assets/images/yarn-remote-only.webp'))['asset:assets/images/yarn-remote-only.webp']?.startsWith('data:image/webp'));
  ok('new GitHub-only word + picture downloaded; word with a 404 picture skipped');
  const goodVersion = remoteConfig.version;
  remoteConfig.version = 1;
  remoteConfig.settings = { ...remoteConfig.settings, quizzesToUnlock: 9 };
  await msg({ type: 'checkUpdates' });
  const kept = (await storage('config')).config;
  assert.equal(kept.version, goodVersion);
  assert.equal(kept.settings.quizzesToUnlock, 2);
  remoteConfig.version = goodVersion;
  remoteConfig.settings = { ...remoteConfig.settings, quizzesToUnlock: 2 };
  ok('a stale (older) config from GitHub is ignored');

  // --------------------------------------------------------------
  step('Watching YouTube until the 6-second window runs out');
  const yt = await ctx.newPage();
  await yt.goto('https://www.youtube.com/watch?v=test');
  await yt.waitForFunction(() => document.getElementById('v').currentTime > 0.5, null, { timeout: 10000 });
  ok('video is playing');
  await yt.waitForFunction(() => !!document.querySelector('yw-reading-lock'), null, { timeout: 20000 });
  ok('overlay appeared');
  await sleep(1800);
  assert.equal(await yt.evaluate(() => document.getElementById('v').paused), true, 'video paused');
  ok('video paused');
  await yt.screenshot({ path: path.join(SHOTS, '1-quiz.png') });

  assert.equal(await yt.evaluate(() => document.querySelector('yw-reading-lock').shadowRoot), null);
  await yt.keyboard.press('k');
  await yt.keyboard.press('Space');
  await yt.keyboard.press('ArrowRight');
  assert.equal(await yt.evaluate(() => window.keys), 0, 'keys reach page');
  ok('keyboard shortcuts blocked; shadow root closed');

  await yt.evaluate(() => document.getElementById('v').play());
  await sleep(700);
  assert.equal(await yt.evaluate(() => document.getElementById('v').paused), true, 'replayed video paused again');
  ok('page cannot restart the video');

  await yt.evaluate(() => document.querySelector('yw-reading-lock').remove());
  await sleep(600);
  assert.ok(await yt.evaluate(() => !!document.querySelector('yw-reading-lock')), 'overlay re-attached');
  ok('removing the overlay from the DOM puts it straight back');

  // --------------------------------------------------------------
  // Overlay is a closed shadow root; use CDP (which can pierce it) to find the buttons.
  const cdp = await ctx.newCDPSession(yt);
  async function options() {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const found = [];
    const walk = (n) => {
      const a = n.attributes || [];
      const i = a.indexOf('data-word');
      if (i >= 0) found.push({ word: a[i + 1], id: n.backendNodeId, disabled: a.includes('disabled') });
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
    };
    walk(root);
    return found;
  }
  async function click(word) {
    let opt;
    for (let i = 0; i < 60; i++) {
      opt = (await options()).find((o) => o.word === word);
      if (opt && !opt.disabled) break;
      await sleep(150);
    }
    assert.ok(opt && !opt.disabled, `option ${word} clickable`);
    // Wait until the button has stopped animating into place.
    let prev = null;
    for (let i = 0; i < 30; i++) {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: opt.id });
      const q = model.border;
      // centre + size: a button still at scale(0) before its pop-in has the same centre but no size
      const pt = [(q[0] + q[4]) / 2, (q[1] + q[5]) / 2, q[4] - q[0], q[5] - q[1]];
      if (prev && pt[2] > 50 && pt.every((v, k) => Math.abs(prev[k] - v) < 0.5)) {
        const hit = await cdp.send('DOM.getNodeForLocation', { x: Math.round(pt[0]), y: Math.round(pt[1]) });
        assert.equal(hit.backendNodeId, opt.id, `click point for ${word} is not covered by anything`);
        await yt.mouse.click(pt[0], pt[1]);
        return;
      }
      prev = pt;
      await sleep(150);
    }
    throw new Error(`option ${word} never settled`);
  }

  step('Three wrong answers → move on to a new word');
  let s = await state();
  const firstQuiz = s.quiz;
  const wrongs = firstQuiz.options.filter((o) => o !== firstQuiz.word);
  assert.deepEqual((await options()).map((o) => o.word).sort(), [...firstQuiz.options].sort());
  await click(wrongs[0]);
  await sleep(700);
  await yt.screenshot({ path: path.join(SHOTS, '2-wrong.png') });
  await sleep(2500);
  s = await state();
  assert.deepEqual(s.quiz.wrongChoices, [wrongs[0]]);
  ok(`picked "${wrongs[0]}" for "${firstQuiz.word}" → try again (2 left)`);
  await click(wrongs[1]);
  await sleep(3000);
  await click(wrongs[2]);
  await sleep(2200);
  await yt.screenshot({ path: path.join(SHOTS, '3-reveal.png') });
  await yt.waitForFunction(() => true);
  for (let i = 0; i < 40; i++) {
    const opts = await options();
    if (!opts.some((o) => o.word === wrongs[2])) break;
    await sleep(250);
  }
  s = await state();
  assert.notEqual(s.quiz.id, firstQuiz.id);
  assert.notEqual(s.quiz.word, firstQuiz.word);
  assert.equal(s.locked, true);
  ok(`new word "${s.quiz.word}" after 3 misses; still locked`);

  step('Correct answer #1 of 2 → celebration, then another word');
  await sleep(800);
  await click(s.quiz.word);
  await sleep(900);
  await yt.screenshot({ path: path.join(SHOTS, '4-celebrate.png') });
  await sleep(4500);
  s = await state();
  assert.equal(s.passedThisLock, 1);
  assert.equal(s.locked, true);
  ok('1 of 2 done, still locked');

  step('Parent edits config.conf without bumping version (interval → 5 min) — still applied');
  remoteConfig.settings.overlayFrequencyMinutes = 5;
  await msg({ type: 'checkUpdates' });
  assert.equal((await storage('config')).config.settings.overlayFrequencyMinutes, 5);
  ok('settings change picked up mid-quiz');

  step('Correct answer #2 → unlock animation → video resumes');
  await click(s.quiz.word);
  await sleep(3400);
  await yt.screenshot({ path: path.join(SHOTS, '5-unlock.png') });
  await yt.waitForFunction(() => !document.querySelector('yw-reading-lock'), null, { timeout: 8000 });
  await sleep(500);
  assert.equal(await yt.evaluate(() => document.getElementById('v').paused), false, 'video resumed');
  s = await state();
  assert.equal(s.locked, false);
  assert.ok(s.usedSeconds < 12, `timer restarted (${s.usedSeconds}s)`);
  ok(`overlay gone, video playing again, timer restarted (${s.usedSeconds.toFixed(1)}s used)`);

  const { stats } = await storage('stats');
  assert.equal(stats[firstQuiz.word].wrong, 3);
  assert.equal(stats[firstQuiz.word].gaveUp, 1);
  assert.equal(stats[firstQuiz.word].confusions[wrongs[0]], 1);
  ok(`stats: "${firstQuiz.word}" wrong ×3, confused with ${Object.keys(stats[firstQuiz.word].confusions).join(', ')}`);


  // --------------------------------------------------------------
  step('New tab opened while locked is locked immediately; unlocking one tab unlocks all');
  await msg({ type: 'lockNow' });
  await yt.waitForFunction(() => !!document.querySelector('yw-reading-lock'), null, { timeout: 5000 });
  const yt2 = await ctx.newPage();
  const t0 = Date.now();
  await yt2.goto('https://www.youtube.com/watch?v=second');
  await yt2.waitForFunction(() => !!document.querySelector('yw-reading-lock'), null, { timeout: 5000 });
  ok(`second tab locked after ${Date.now() - t0} ms`);
  await sleep(1500);
  assert.equal(await yt2.evaluate(() => document.getElementById('v').paused), true);
  ok('second tab video never plays');
  // answer twice via the background (as if from tab 2) and both tabs unlock
  for (let i = 0; i < 2; i++) {
    s = await state();
    await msg({ type: 'answer', quizId: s.quiz.id, choice: s.quiz.word });
  }
  await yt.waitForFunction(() => !document.querySelector('yw-reading-lock'), null, { timeout: 8000 });
  await yt2.waitForFunction(() => !document.querySelector('yw-reading-lock'), null, { timeout: 8000 });
  ok('both tabs unlocked');

  // --------------------------------------------------------------
  step('Non-YouTube sites are never touched');
  const other = await ctx.newPage();
  await other.route('https://example.com/**', (r) => r.fulfill({ body: '<h1>hi</h1>', contentType: 'text/html' }));
  await msg({ type: 'lockNow' });
  await other.goto('https://example.com/');
  await sleep(1500);
  assert.equal(await other.evaluate(() => !!document.querySelector('yw-reading-lock')), false);
  ok('no overlay on example.com while locked');

  step('Short window: quiz still usable');
  await msg({ type: 'lockNow' });
  await yt.bringToFront();
  await yt.setViewportSize({ width: 1024, height: 420 });
  await sleep(2500);
  await yt.screenshot({ path: path.join(SHOTS, '7-short-window.png') });
  await yt.setViewportSize({ width: 1280, height: 800 });
  ok('screenshot saved');

  step('Popup');
  await ext.setViewportSize({ width: 380, height: 590 });
  await ext.reload();
  await sleep(800);
  await ext.screenshot({ path: path.join(SHOTS, '6-popup.png'), fullPage: true });
  ok('popup screenshot saved');
} catch (e) {
  failures++;
  console.error('\n✗ FAILED:', e.message);
  for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: path.join(SHOTS, `fail-${i}.png`) }).catch(() => {});
} finally {
  await ctx.close();
  github.close();
  fs.rmSync(userData, { recursive: true, force: true });
}
console.log(failures ? '\nE2E FAILED' : '\nE2E PASSED — screenshots in test-results/');
process.exit(failures ? 1 : 0);
