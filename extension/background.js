// YouTube Words — background service worker.
// Owns the single source of truth (chrome.storage.local): usage timer, lock state, current quiz,
// statistics, active config and downloaded assets. YouTube tabs only render what is stored here.

import {
  normalizeConfig, configAssetPaths, initialState, tick, lock, answer, recordShown, compareVersions,
} from './lib/engine.js';

const DEFAULT_REMOTE_BASE = 'https://raw.githubusercontent.com/RidgebackZulu/youtube-words/main/extension/';
const ALARM = 'github-check';
const ASSET_PREFIX = 'asset:';

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };

// ---------- storage helpers ----------

const store = chrome.storage.local;
const get = async (key) => (await store.get(key))[key];
const set = (obj) => store.set(obj);

// All state mutations run one at a time so two tabs can't race each other.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- config ----------

let configCache = null;

async function bundledConfig() {
  const res = await fetch(chrome.runtime.getURL('config.conf'));
  return normalizeConfig(JSON.parse(await res.text()));
}

async function getConfig() {
  if (configCache) return configCache;
  let cfg = await get('config');
  if (!cfg) {
    cfg = await bundledConfig();
    await set({ config: cfg, configSource: 'bundled' });
  }
  configCache = cfg;
  return cfg;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) configCache = changes.config.newValue || null;
});

// ---------- assets ----------

function toDataUrl(buf, path) {
  const ext = path.split('.').pop().toLowerCase();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${MIME[ext] || 'application/octet-stream'};base64,${btoa(bin)}`;
}

const bundledCache = new Map();
async function bundledAsset(path) {
  if (bundledCache.has(path)) return bundledCache.get(path);
  try {
    const res = await fetch(chrome.runtime.getURL(path));
    if (!res.ok) throw new Error();
    const url = toDataUrl(await res.arrayBuffer(), path);
    bundledCache.set(path, url);
    return url;
  } catch {
    bundledCache.set(path, null);
    return null;
  }
}

/** Downloaded copy first, then the copy shipped inside the extension. */
async function resolveAsset(path) {
  if (!path) return null;
  return (await get(ASSET_PREFIX + path)) || (await bundledAsset(path));
}

// ---------- state ----------

async function load() {
  const [config, data] = await Promise.all([getConfig(), store.get(['state', 'stats'])]);
  return { config, state: data.state || initialState(), stats: data.stats || {} };
}

async function save(prev, state, stats) {
  // A brand-new quiz on screen counts as "shown" for that word.
  if (state.quiz && state.quiz.id !== prev.quiz?.id) stats = recordShown(stats, state.quiz.word, Date.now());
  await set({ state, stats });
  return { state, stats };
}

async function publicState(state, config) {
  const out = {
    locked: !!state.locked,
    usedSeconds: state.usedSeconds,
    settings: config.settings,
    quiz: null,
    sounds: null,
  };
  if (!state.locked || !state.quiz) return out;
  const entry = config.words.find((w) => w.word === state.quiz.word);
  const [image, wordAudio] = await Promise.all([resolveAsset(entry?.image), resolveAsset(entry?.audio)]);
  out.quiz = {
    id: state.quiz.id,
    options: state.quiz.options,
    wrongChoices: state.quiz.wrongChoices,
    image,
    wordAudio,
    triesPerWord: config.settings.triesPerWord,
    passed: state.passedThisLock,
    required: config.settings.quizzesToUnlock,
  };
  const sounds = {};
  for (const [name, list] of Object.entries(config.sounds)) {
    sounds[name] = (await Promise.all(list.map(resolveAsset))).filter(Boolean);
  }
  out.sounds = sounds;
  return out;
}

// ---------- GitHub updates ----------

async function remoteBase() {
  const override = await get('remoteBase');
  return typeof override === 'string' && /^https?:\/\//.test(override) ? override.replace(/\/?$/, '/') : DEFAULT_REMOTE_BASE;
}

async function fetchText(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('/').pop()}`);
  return res.text();
}

async function ensureAlarm(minutes) {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing || existing.periodInMinutes !== minutes) {
    await chrome.alarms.create(ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  }
}

// Checks run one after another (a click on "Check for updates" during an alarm check gets its own fresh run).
let updating = Promise.resolve();
function checkForUpdates() {
  updating = updating.catch(() => {}).then(doCheckForUpdates);
  return updating;
}

async function doCheckForUpdates() {
  const meta = (await get('meta')) || {};
  meta.lastCheck = Date.now();
  try {
    const base = await remoteBase();
    const remote = normalizeConfig(JSON.parse(await fetchText(base + 'config.conf')));

    try {
      meta.remoteExtensionVersion = JSON.parse(await fetchText(base + 'manifest.json')).version || null;
    } catch {
      meta.remoteExtensionVersion = remote.latestExtensionVersion;
    }

    const active = await getConfig();
    const changed = JSON.stringify(remote) !== JSON.stringify(active);
    if (changed) {
      // New version number => refresh every asset (pictures may have been redrawn under the same name).
      // Same version => only fetch assets we don't already have.
      const refreshAll = remote.version > active.version;
      const downloads = {};
      const missing = new Set();
      for (const path of configAssetPaths(remote)) {
        const have = (await get(ASSET_PREFIX + path)) || (await bundledAsset(path));
        if (have && !refreshAll) continue;
        try {
          const res = await fetch(base + path, { cache: 'no-store' });
          if (!res.ok) throw new Error();
          downloads[ASSET_PREFIX + path] = toDataUrl(await res.arrayBuffer(), path);
        } catch {
          if (!have) missing.add(path);
        }
      }
      remote.words = remote.words
        .filter((w) => !missing.has(w.image))
        .map((w) => (missing.has(w.audio) ? { ...w, audio: null } : w));
      if (!remote.words.length) throw new Error('no word pictures could be downloaded');

      await set(downloads);
      const keep = new Set(configAssetPaths(remote).map((p) => ASSET_PREFIX + p));
      const stale = Object.keys(await store.get(null)).filter((k) => k.startsWith(ASSET_PREFIX) && !keep.has(k));
      if (stale.length) await store.remove(stale);
      await set({ config: remote, configSource: 'github' });
      configCache = remote;
      meta.lastUpdate = Date.now();
      meta.lastUpdateNote = `config v${remote.version}, ${Object.keys(downloads).length} file(s) downloaded` +
        (missing.size ? `, ${missing.size} missing` : '');
    }
    meta.lastCheckOk = true;
    meta.lastError = null;
  } catch (e) {
    meta.lastCheckOk = false;
    meta.lastError = String(e.message || e);
  }
  await set({ meta });
  await ensureAlarm((await getConfig()).settings.githubCheckIntervalMinutes);
  return meta;
}

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  // A newer config shipped inside the extension (after a git pull) wins over an older stored one.
  try {
    const bundled = await bundledConfig();
    const stored = await get('config');
    if (!stored || bundled.version > stored.version) {
      // Older downloads would otherwise shadow the newer files that shipped with this version.
      const old = Object.keys(await store.get(null)).filter((k) => k.startsWith(ASSET_PREFIX));
      if (old.length) await store.remove(old);
      await set({ config: bundled, configSource: 'bundled' });
      configCache = bundled;
    }
  } catch (e) {
    console.error('bundled config.conf is invalid', e);
  }
  // YouTube tabs that were already open don't get the content script automatically; add it now.
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    await Promise.all(tabs.map((t) => chrome.scripting
      .executeScript({ target: { tabId: t.id }, files: ['content.js'] })
      .catch(() => {})));
  } catch {}
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(() => { checkForUpdates(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) checkForUpdates();
});

// ---------- messages ----------

const handlers = {
  async heartbeat() {
    return serial(async () => {
      const { config, state, stats } = await load();
      const next = tick(state, config, stats, Date.now());
      if (next !== state) await save(state, next, stats);
      return { locked: next.locked, quizId: next.quiz?.id ?? null };
    });
  },

  async getState() {
    const { config, state } = await load();
    return publicState(state, config);
  },

  async answer(msg) {
    return serial(async () => {
      const { config, state, stats } = await load();
      const r = answer(state, config, stats, msg.quizId, msg.choice, Date.now());
      if (r.state !== state) await save(state, r.state, r.stats);
      const result = { ...r.result };
      if (result.outcome === 'correct') {
        const entry = config.words.find((w) => w.word === result.word);
        result.wordAudio = await resolveAsset(entry?.audio);
      } else if (result.outcome === 'out-of-tries') {
        const entry = config.words.find((w) => w.word === result.word);
        result.wordAudio = await resolveAsset(entry?.audio);
      }
      return { result, next: await publicState(r.state, config) };
    });
  },

  async lockNow() {
    return serial(async () => {
      const { config, state, stats } = await load();
      await save(state, lock(state, config, stats, Date.now()), stats);
      return { ok: true };
    });
  },

  async resetStats() {
    await set({ stats: {} });
    return { ok: true };
  },

  async checkUpdates() {
    return checkForUpdates();
  },

  async getPopupData(msg) {
    const { config, state, stats } = await load();
    const data = await store.get(['meta', 'configSource']);
    const meta = data.meta || {};
    const extVersion = chrome.runtime.getManifest().version;
    const latest = meta.remoteExtensionVersion || config.latestExtensionVersion;
    const words = await Promise.all(config.words.map(async (w) => ({
      word: w.word,
      image: msg.light ? null : await resolveAsset(w.image),
    })));
    return {
      locked: state.locked,
      usedSeconds: state.usedSeconds,
      passedThisLock: state.passedThisLock,
      settings: config.settings,
      configVersion: config.version,
      configSource: data.configSource || 'bundled',
      extVersion,
      extUpdateAvailable: latest ? compareVersions(latest, extVersion) > 0 : false,
      latestExtensionVersion: latest,
      meta,
      words,
      stats,
    };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
