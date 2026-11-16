#!/usr/bin/env node
// Generates the cartoon word pictures and the spoken audio listed in extension/config.conf.
// Runs on the parent's computer only. Reads OPENAI_KEY from .env; the key is never shipped.
//
//   node scripts/generate-assets.mjs                 # generate anything missing
//   node scripts/generate-assets.mjs --only=dog,cat  # just these words
//   node scripts/generate-assets.mjs --images        # images only (or --audio)
//   node scripts/generate-assets.mjs --force         # regenerate even if the file exists
//
// To add a word: add an entry to extension/config.conf (word, distractors, image, audio, prompt),
// run this script, bump "version" in config.conf, commit and push.

import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const RAW = path.join(ROOT, 'scripts', '.raw');

const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'coral';
const IMAGE_PX = 512;

const PHRASES = {
  'phrases/prompt': 'Which word matches the picture?',
  'phrases/correct-1': 'Great job!',
  'phrases/correct-2': 'You got it! Awesome reading!',
  'phrases/correct-3': 'Yes! You are a super reader!',
  'phrases/try-again': 'Oops! Try again. You can do it!',
  'phrases/new-word': "Good try! Let's try a new word.",
  'phrases/another-one': "Great job! Let's do another one!",
  'phrases/unlocked': 'Hooray! YouTube is unlocked!',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const force = flag('force');
const doImages = flag('images') || !flag('audio');
const doAudio = flag('audio') || !flag('images');

async function loadKey() {
  if (process.env.OPENAI_KEY) return process.env.OPENAI_KEY;
  const env = await readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  const m = env.match(/^\s*(?:OPENAI_KEY|OPENAI_LLM|OPENAI_API_KEY)\s*=\s*"?([^"\n]+)"?/m);
  if (!m) throw new Error('No OPENAI_KEY found in .env');
  return m[1].trim();
}

const exists = (p) => access(p).then(() => true, () => false);

function imagePrompt(entry) {
  return [
    `A cute, bright, friendly cartoon illustration of ${entry.prompt || 'a ' + entry.word}.`,
    'Made for a picture-word reading game for a 7-year-old child.',
    'One single subject, centered, large and instantly recognizable.',
    'Thick clean outlines, simple flat cheerful colors, soft plain pastel background.',
    'Absolutely NO text, NO letters, NO numbers, NO words, NO writing, NO labels anywhere in the image.',
  ].join(' ');
}

async function openai(key, endpoint, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://api.openai.com/v1/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    const text = await res.text();
    if (attempt === 3 || res.status < 500 && res.status !== 429) {
      throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function makeImage(key, entry) {
  const out = path.join(EXT, entry.image);
  if (!force && (await exists(out))) return `skip  ${entry.image}`;
  const res = await openai(key, 'images/generations', {
    model: IMAGE_MODEL,
    prompt: imagePrompt(entry),
    size: '1024x1024',
    quality: 'medium',
    n: 1,
  });
  const json = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`no image data for ${entry.word}`);
  await mkdir(RAW, { recursive: true });
  await mkdir(path.dirname(out), { recursive: true });
  const raw = path.join(RAW, `${entry.word}.png`);
  await writeFile(raw, Buffer.from(b64, 'base64'));
  await run('magick', [raw, '-resize', `${IMAGE_PX}x${IMAGE_PX}`, '-quality', '82', out]);
  return `image ${entry.image}`;
}

async function makeSpeech(key, text, relPath) {
  const out = path.join(EXT, relPath);
  if (!force && (await exists(out))) return `skip  ${relPath}`;
  const res = await openai(key, 'audio/speech', {
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    response_format: 'mp3',
    instructions:
      'You are a warm, cheerful teacher talking to a 7-year-old. Speak slowly and very clearly, with a smile.',
  });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return `audio ${relPath}`;
}

async function pool(items, size, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        const msg = await fn(item);
        console.log(msg);
        results.push({ ok: true });
      } catch (e) {
        console.error(`FAIL  ${e.message}`);
        results.push({ ok: false });
      }
    }
  });
  await Promise.all(workers);
  return results.filter((r) => !r.ok).length;
}

async function main() {
  const key = await loadKey();
  const config = JSON.parse(await readFile(path.join(EXT, 'config.conf'), 'utf8'));
  const words = config.words.filter((w) => !only.length || only.includes(w.word));
  let failures = 0;

  if (doImages) failures += await pool(words, 4, (w) => makeImage(key, w));
  if (doAudio) {
    const jobs = words.map((w) => [w.word, w.audio]);
    if (!only.length) {
      for (const [name, text] of Object.entries(PHRASES)) jobs.push([text, `assets/audio/${name}.mp3`]);
    }
    failures += await pool(jobs, 6, ([text, rel]) => makeSpeech(key, text, rel));
  }
  if (!only.length && !failures) await rm(RAW, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} item(s) failed. Re-run to retry just the missing ones.`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
