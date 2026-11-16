import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  normalizeConfig, initialState, tick, lock, answer, pickWord, buildOptions,
  configAssetPaths, compareVersions, MAX_HEARTBEAT_GAP_MS, applyIntervalChange,
} from '../extension/lib/engine.js';

const bundled = JSON.parse(readFileSync(new URL('../extension/config.conf', import.meta.url), 'utf8'));
const cfg = (settings = {}) => normalizeConfig({ ...bundled, settings: { ...bundled.settings, ...settings } });

// Deterministic RNG
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('bundled config.conf is valid; every word is short with a picture and audio on disk', () => {
  const c = normalizeConfig(bundled);
  assert.equal(c.words.length, bundled.words.length, 'no words dropped');
  assert.ok(c.words.length >= 40);
  for (const w of c.words) {
    assert.ok(w.word.length <= 5, `${w.word} too long`);
    assert.ok(w.distractors.length >= 3, `${w.word} needs 3 distractors`);
    assert.ok(!w.distractors.includes(w.word));
    for (const f of [w.image, w.audio]) assert.ok(existsSync(new URL(`../extension/${f}`, import.meta.url)), `${f} missing`);
  }
  assert.deepEqual(c.settings, { githubCheckIntervalMinutes: 30, overlayFrequencyMinutes: 3, quizzesToUnlock: 1, triesPerWord: 3 });
});

test('normalizeConfig clamps bad settings and rejects unsafe paths', () => {
  const c = normalizeConfig({
    settings: { githubCheckIntervalMinutes: -5, overlayFrequencyMinutes: 'x', quizzesToUnlock: 99, triesPerWord: 0 },
    words: [
      { word: 'Dog', image: 'assets/images/dog.webp', distractors: ['dog', 'bog'] },
      { word: 'evil', image: 'https://evil.example/x.png' },
      { word: 'up', image: '../../secret' },
    ],
  });
  assert.equal(c.settings.githubCheckIntervalMinutes, 1);
  assert.equal(c.settings.overlayFrequencyMinutes, 5);
  assert.equal(c.settings.quizzesToUnlock, 20);
  assert.equal(c.settings.triesPerWord, 1);
  assert.deepEqual(c.words.map((w) => w.word), ['dog']);
  assert.deepEqual(c.words[0].distractors, ['bog']);
  assert.throws(() => normalizeConfig({ words: [] }));
});

test('usage accumulates from heartbeats and locks at the interval', () => {
  const c = cfg({ overlayFrequencyMinutes: 1 });
  let s = initialState();
  let t = 1_000_000;
  s = tick(s, c, {}, t);
  for (let i = 0; i < 11; i++) { t += 5000; s = tick(s, c, {}, t); }
  assert.equal(s.locked, false);
  assert.equal(Math.round(s.usedSeconds), 55);
  t += 5000; s = tick(s, c, {}, t);
  assert.equal(s.locked, true);
  assert.ok(s.quiz, 'a quiz starts on lock');
  assert.equal(s.quiz.options.length, 4);
  assert.ok(s.quiz.options.includes(s.quiz.word));
});

test('long gaps (tab hidden / browser closed) are not counted', () => {
  const c = cfg();
  let s = tick(initialState(), c, {}, 1000);
  s = tick(s, c, {}, 1000 + MAX_HEARTBEAT_GAP_MS + 1);
  assert.equal(s.usedSeconds, 0);
});

test('time spent on the quiz does not count toward the next window', () => {
  const c = cfg({ overlayFrequencyMinutes: 0.1 });
  let s = lock(initialState(), c, {}, 0, seeded());
  for (let t = 5000; t < 120_000; t += 5000) s = tick(s, c, {}, t);
  assert.equal(s.locked, true);
  const { state } = answer(s, c, {}, s.quiz.id, s.quiz.word, 120_000);
  assert.equal(state.locked, false);
  assert.equal(state.usedSeconds, 0, 'window restarts after unlock');
});

test('three wrong answers move on to a new word; stats record confusions', () => {
  const c = cfg();
  const rng = seeded(7);
  let s = lock(initialState(), c, {}, 0, rng);
  let stats = {};
  const first = s.quiz;
  const wrong = first.options.filter((o) => o !== first.word);
  let r;
  ({ state: s, stats, result: r } = answer(s, c, stats, first.id, wrong[0], 1, rng));
  assert.equal(r.outcome, 'wrong'); assert.equal(r.triesLeft, 2);
  ({ state: s, stats, result: r } = answer(s, c, stats, first.id, wrong[0], 1, rng));
  assert.equal(r.outcome, 'stale', 'same wrong choice twice is ignored');
  ({ state: s, stats, result: r } = answer(s, c, stats, first.id, wrong[1], 2, rng));
  assert.equal(r.triesLeft, 1);
  ({ state: s, stats, result: r } = answer(s, c, stats, first.id, wrong[2], 3, rng));
  assert.equal(r.outcome, 'out-of-tries');
  assert.equal(s.locked, true, 'still locked');
  assert.notEqual(s.quiz.id, first.id, 'new quiz');
  assert.notEqual(s.quiz.word, first.word, 'new word');
  assert.equal(stats[first.word].wrong, 3);
  assert.equal(stats[first.word].gaveUp, 1);
  assert.equal(stats[first.word].confusions[wrong[0]], 1);
});

test('quizzesToUnlock = 2 needs two correct answers, not necessarily in a row', () => {
  const c = cfg({ quizzesToUnlock: 2 });
  const rng = seeded(3);
  let s = lock(initialState(), c, {}, 0, rng);
  let stats = {};
  let r;
  ({ state: s, stats, result: r } = answer(s, c, stats, s.quiz.id, s.quiz.word, 1, rng));
  assert.equal(r.outcome, 'correct'); assert.equal(r.unlocked, false); assert.equal(s.locked, true);
  // miss a whole word in between
  for (const o of s.quiz.options.filter((o) => o !== s.quiz.word)) {
    ({ state: s, stats } = answer(s, c, stats, s.quiz.id, o, 2, rng));
  }
  assert.equal(s.passedThisLock, 1, 'progress kept after a failed word');
  ({ state: s, stats, result: r } = answer(s, c, stats, s.quiz.id, s.quiz.word, 3, rng));
  assert.equal(r.unlocked, true);
  assert.equal(s.locked, false);
});

test('a second tab answering an old quiz id is ignored', () => {
  const c = cfg();
  const s = lock(initialState(), c, {}, 0, seeded());
  const { state, result } = answer(s, c, {}, s.quiz.id - 1, s.quiz.word, 1);
  assert.equal(result.outcome, 'stale');
  assert.equal(state, s);
});

test('lock is idempotent while a quiz is running', () => {
  const c = cfg();
  const s = lock(initialState(), c, {}, 0, seeded());
  assert.equal(lock(s, c, {}, 5), s);
});

test('pickWord avoids recent words and favours missed ones', () => {
  const c = cfg();
  const recent = ['dog', 'cat', 'bed'];
  for (let i = 0; i < 200; i++) assert.ok(!recent.includes(pickWord(c, {}, recent).word));
  const stats = Object.fromEntries(c.words.map((w) => [w.word, { shown: 10, correct: 10, wrong: 0 }]));
  stats.bath = { shown: 10, correct: 0, wrong: 10 };
  let bath = 0;
  for (let i = 0; i < 2000; i++) if (pickWord(c, stats, []).word === 'bath') bath++;
  assert.ok(bath > (2000 / c.words.length) * 2.5, `bath picked ${bath} times`);
});

test('buildOptions tops up when distractors are short', () => {
  const c = cfg();
  const opts = buildOptions({ word: 'zz', distractors: [] }, c);
  assert.equal(opts.length, 4);
  assert.equal(new Set(opts).size, 4);
});

test('asset paths and version compare', () => {
  const paths = configAssetPaths(cfg());
  assert.ok(paths.includes('assets/images/dog.webp'));
  assert.ok(paths.includes('assets/audio/phrases/prompt.mp3'));
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

test('changing the quiz interval restarts the countdown (but never interrupts a quiz)', () => {
  const c = cfg({ overlayFrequencyMinutes: 5 });
  let s = initialState();
  for (let t = 1000; t <= 151_000; t += 5000) s = tick(s, c, {}, t);
  assert.equal(Math.round(s.usedSeconds), 150);
  const r = applyIntervalChange(s, 5, 1, 200_000);
  assert.equal(r.usedSeconds, 0, 'fresh 1-minute window');
  assert.equal(applyIntervalChange(s, 5, 5, 1), s, 'same interval: untouched');
  const locked = lock(s, c, {}, 1, seeded());
  assert.equal(applyIntervalChange(locked, 5, 1, 2), locked, 'locked: untouched');
});
