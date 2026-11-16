// Pure state machine for YouTube Words. No chrome.* calls here so it can be unit-tested in Node.

export const DEFAULT_SETTINGS = Object.freeze({
  githubCheckIntervalMinutes: 30,
  overlayFrequencyMinutes: 5,
  quizzesToUnlock: 1,
  triesPerWord: 3,
});

// Usage is counted from heartbeats sent every few seconds by visible YouTube tabs.
// A gap longer than this means nobody was watching in between, so it counts as zero.
export const MAX_HEARTBEAT_GAP_MS = 15_000;

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

const isStr = (s) => typeof s === 'string' && s.trim().length > 0;
const cleanWord = (s) => String(s).trim().toLowerCase();
// Asset paths must be plain relative paths inside the extension / repo folder.
const safePath = (p) => isStr(p) && !p.includes('..') && !/^[a-z]+:/i.test(p) && !p.startsWith('/');

/**
 * Validate and clamp a parsed config.conf. Throws if it is unusable.
 * Words with missing images are dropped; at least 1 word must survive.
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('config is not an object');
  const s = raw.settings || {};
  const settings = {
    githubCheckIntervalMinutes: clamp(s.githubCheckIntervalMinutes, 1, 1440, DEFAULT_SETTINGS.githubCheckIntervalMinutes),
    // Fractions allowed (0.1 = 6 seconds) so it can be tested quickly.
    overlayFrequencyMinutes: clamp(s.overlayFrequencyMinutes, 0.05, 1440, DEFAULT_SETTINGS.overlayFrequencyMinutes),
    quizzesToUnlock: Math.round(clamp(s.quizzesToUnlock, 1, 20, DEFAULT_SETTINGS.quizzesToUnlock)),
    triesPerWord: Math.round(clamp(s.triesPerWord, 1, 10, DEFAULT_SETTINGS.triesPerWord)),
  };

  const seen = new Set();
  const words = [];
  for (const w of Array.isArray(raw.words) ? raw.words : []) {
    if (!w || !isStr(w.word) || !safePath(w.image)) continue;
    const word = cleanWord(w.word);
    if (seen.has(word)) continue;
    seen.add(word);
    const distractors = [...new Set((Array.isArray(w.distractors) ? w.distractors : [])
      .filter(isStr).map(cleanWord).filter((d) => d !== word))];
    words.push({ word, distractors, image: w.image, audio: safePath(w.audio) ? w.audio : null });
  }
  if (!words.length) throw new Error('config has no usable words');

  const sounds = {};
  const rs = raw.sounds || {};
  for (const [k, v] of Object.entries(rs)) {
    const list = (Array.isArray(v) ? v : [v]).filter(safePath);
    if (list.length) sounds[k] = list;
  }

  return {
    version: clamp(raw.version, 0, Number.MAX_SAFE_INTEGER, 0),
    latestExtensionVersion: isStr(raw.latestExtensionVersion) ? raw.latestExtensionVersion.trim() : null,
    settings,
    sounds,
    words,
  };
}

/** Every asset path a config needs, deduplicated. */
export function configAssetPaths(config) {
  const out = new Set();
  for (const w of config.words) {
    out.add(w.image);
    if (w.audio) out.add(w.audio);
  }
  for (const list of Object.values(config.sounds)) list.forEach((p) => out.add(p));
  return [...out];
}

export function initialState() {
  return {
    usedSeconds: 0,
    lastTick: 0,
    locked: false,
    lockedAt: null,
    passedThisLock: 0,
    quiz: null,
    recentWords: [],
    quizSeq: 0,
  };
}

/**
 * A visible YouTube tab is reporting that it is in use.
 * Returns a new state; may flip to locked (and start a quiz).
 */
export function tick(state, config, stats, now, rng = Math.random) {
  const s = { ...state };
  if (s.locked) {
    // Time spent on the quiz does not count toward the next window.
    s.lastTick = now;
    return s;
  }
  const gap = now - (s.lastTick || 0);
  if (s.lastTick && gap > 0 && gap <= MAX_HEARTBEAT_GAP_MS) s.usedSeconds += gap / 1000;
  s.lastTick = now;
  if (s.usedSeconds >= config.settings.overlayFrequencyMinutes * 60) return lock(s, config, stats, now, rng);
  return s;
}

export function lock(state, config, stats, now, rng = Math.random) {
  if (state.locked && state.quiz) return state;
  const s = { ...state, locked: true, lockedAt: now, passedThisLock: 0, lastTick: now };
  return startQuiz(s, config, stats, rng);
}

export function unlock(state, now) {
  return { ...state, locked: false, lockedAt: null, passedThisLock: 0, quiz: null, usedSeconds: 0, lastTick: now };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Words the child gets wrong more often are picked more often; the last few are avoided. */
export function pickWord(config, stats, recent, rng = Math.random) {
  const avoid = new Set(recent.slice(-Math.min(3, config.words.length - 1)));
  const pool = config.words.filter((w) => !avoid.has(w.word));
  const weights = pool.map((w) => {
    const st = stats[w.word];
    if (!st || !st.shown) return 2; // new words get a boost
    const miss = (st.wrong || 0) / Math.max(1, (st.wrong || 0) + (st.correct || 0));
    return 1 + 3 * miss;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

export function buildOptions(entry, config, rng = Math.random) {
  const opts = [entry.word];
  for (const d of shuffle(entry.distractors, rng)) {
    if (opts.length >= 4) break;
    if (!opts.includes(d)) opts.push(d);
  }
  // Top up from other words if a word has fewer than 3 distractors.
  for (const w of shuffle(config.words, rng)) {
    if (opts.length >= 4) break;
    if (!opts.includes(w.word)) opts.push(w.word);
  }
  return shuffle(opts, rng);
}

export function startQuiz(state, config, stats, rng = Math.random) {
  const entry = pickWord(config, stats, state.recentWords || [], rng);
  const quizSeq = (state.quizSeq || 0) + 1;
  return {
    ...state,
    quizSeq,
    recentWords: [...(state.recentWords || []), entry.word].slice(-5),
    quiz: { id: quizSeq, word: entry.word, options: buildOptions(entry, config, rng), wrongChoices: [] },
  };
}

function bumpStats(stats, word, fn) {
  const cur = stats[word] || { shown: 0, correct: 0, wrong: 0, firstTry: 0, gaveUp: 0, confusions: {} };
  const next = { ...cur, confusions: { ...cur.confusions } };
  fn(next);
  return { ...stats, [word]: next };
}

export function recordShown(stats, word, now) {
  return bumpStats(stats, word, (s) => { s.shown += 1; s.lastSeen = now; });
}

/**
 * The child picked an answer.
 * result.outcome: 'correct' | 'wrong' | 'out-of-tries' | 'stale'
 * result.unlocked: true when this answer finished the lock.
 * The returned state already contains the next quiz when one is needed.
 */
export function answer(state, config, stats, quizId, choice, now, rng = Math.random) {
  const q = state.quiz;
  if (!state.locked || !q || q.id !== quizId) {
    return { state, stats, result: { outcome: 'stale' } };
  }
  choice = cleanWord(choice);
  if (!q.options.includes(choice) || q.wrongChoices.includes(choice)) {
    return { state, stats, result: { outcome: 'stale' } };
  }
  const tries = config.settings.triesPerWord;

  if (choice === q.word) {
    const firstTry = q.wrongChoices.length === 0;
    stats = bumpStats(stats, q.word, (s) => { s.correct += 1; if (firstTry) s.firstTry += 1; });
    const passed = state.passedThisLock + 1;
    const required = config.settings.quizzesToUnlock;
    if (passed >= required) {
      return { state: unlock(state, now), stats, result: { outcome: 'correct', word: q.word, unlocked: true, passed, required } };
    }
    const next = startQuiz({ ...state, passedThisLock: passed }, config, stats, rng);
    return { state: next, stats, result: { outcome: 'correct', word: q.word, unlocked: false, passed, required } };
  }

  stats = bumpStats(stats, q.word, (s) => {
    s.wrong += 1;
    s.confusions[choice] = (s.confusions[choice] || 0) + 1;
  });
  const wrongChoices = [...q.wrongChoices, choice];
  if (wrongChoices.length >= tries) {
    stats = bumpStats(stats, q.word, (s) => { s.gaveUp += 1; });
    const next = startQuiz(state, config, stats, rng);
    return { state: next, stats, result: { outcome: 'out-of-tries', word: q.word, choice, triesLeft: 0 } };
  }
  return {
    state: { ...state, quiz: { ...q, wrongChoices } },
    stats,
    result: { outcome: 'wrong', word: q.word, choice, triesLeft: tries - wrongChoices.length },
  };
}

/** Compare dotted versions: returns >0 if a is newer than b. */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
