#!/usr/bin/env node
// Check an output directory against every limit the gate publishes.
//
//   node scripts/verify.mjs <out dir> [--input <snapshot.json|dir>]
//
// The gate itself runs on make.fun's server and cannot be run here, so this script repeats its rules
// from RULES.txt locally: the board's shape and order, the watchlist floor, the dashboard's files and
// its no-address rule, the screenshots' count, bytes and pixels, and the dossier's byte-for-byte
// match. It exits 1 on the first failing row and prints every row's result either way.
//
// It reads the snapshot only to check that a board slug exists in it, so an entry can be checked
// without the sealed input by passing --no-input, in which case that one row is skipped.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const args = process.argv.slice(2);
const outDir = args[0] ?? 'out';
const inputFlag = args.indexOf('--input');
const skipInput = args.includes('--no-input');
const inputArgument = inputFlag >= 0 ? args[inputFlag + 1] : '/input';
const snapshotPath =
  skipInput ? null : inputArgument.endsWith('.json') ? inputArgument : join(inputArgument, 'snapshot.json');

const BOARD_MAX_BYTES = 8 * 1024 * 1024;
const BOARD_MIN_ROWS = 100;
const BOARD_MAX_ROWS = 4000;
const IMPLIED_MAX = 100_000_000_000_000;
const FARM_STEPS_MIN = 3;
const FARM_STEPS_MAX = 12;
const STEP_MIN_CHARS = 20;
const STEP_MAX_CHARS = 600;
const DASHBOARD_MAX_FILES = 400;
const DASHBOARD_MAX_BYTES = 4 * 1024 * 1024;
const SHOT_MIN = 3;
const SHOT_MAX = 4;
const SHOT_MAX_BYTES = 524_288;
const SHOT_LONG_MAX = 1440;
const SHOT_SHORT_MIN = 800;
const DOSSIER_TEXT_MAX_BYTES = 65_536;
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,128}$/;

const results = [];
/** Record one row: a name, ok or not, and a line saying what was measured. */
function row(name, ok, detail) {
  results.push({ name, ok, detail });
}

/** Read a PNG's or JPEG's pixel size without a decoder: the two header shapes only. */
function imageSize(bytes) {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      const length = bytes.readUInt16BE(at + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { format: 'jpeg', height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      at += 2 + length;
    }
    return { format: 'jpeg', width: null, height: null };
  }
  return null;
}

// ------------------------------------------------------------------ board.json
const boardPath = join(outDir, 'board.json');
if (!existsSync(boardPath)) {
  row('board_file', false, `no board.json at ${boardPath}`);
} else {
  const raw = readFileSync(boardPath);
  const parsed = JSON.parse(raw.toString('utf8'));
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : null;
  if (rows === null) {
    row('board_file', false, 'board.json holds neither an array nor a rows array');
  } else {
    const problems = [];
    if (raw.length > BOARD_MAX_BYTES) problems.push(`${raw.length} bytes past the ${BOARD_MAX_BYTES} cap`);
    if (rows.length < BOARD_MIN_ROWS || rows.length > BOARD_MAX_ROWS) problems.push(`${rows.length} rows outside ${BOARD_MIN_ROWS}..${BOARD_MAX_ROWS}`);
    const slugs = new Set();
    for (const [index, r] of rows.entries()) {
      const at = `row ${index + 1}`;
      if (typeof r.slug !== 'string' || r.slug.trim() === '') problems.push(`${at}: no slug`);
      else if (/\s/.test(r.slug)) problems.push(`${at}: slug carries whitespace`);
      else if (slugs.has(r.slug)) problems.push(`${at}: slug ${r.slug} twice`);
      else slugs.add(r.slug);
      if (typeof r.name !== 'string' || r.name.trim() === '') problems.push(`${at}: no name`);
      if (!Number.isInteger(r.rank) || r.rank <= 0) problems.push(`${at}: rank ${r.rank} is not a positive whole number`);
      if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > IMPLIED_MAX) {
        problems.push(`${at}: implied value ${r.implied_value_usd} outside 1..${IMPLIED_MAX}`);
      }
      if (!Array.isArray(r.farm_steps) || r.farm_steps.length < FARM_STEPS_MIN || r.farm_steps.length > FARM_STEPS_MAX) {
        problems.push(`${at}: ${Array.isArray(r.farm_steps) ? r.farm_steps.length : 'no'} farm steps`);
      } else {
        for (const [stepIndex, step] of r.farm_steps.entries()) {
          const length = typeof step === 'string' ? step.trim().length : -1;
          if (length < STEP_MIN_CHARS || length > STEP_MAX_CHARS) problems.push(`${at}: step ${stepIndex + 1} is ${length} characters`);
        }
      }
      if (problems.length > 3) break;
    }
    row('board_file', problems.length === 0, problems.length === 0 ? `${rows.length} rows, ${raw.length} bytes` : problems.join('; '));

    // sorted_by_value: ranks exactly 1..N once each, and implied value never rises as rank ascends.
    const order = [];
    if (rows.length !== slugs.size) order.push('ranks and slugs disagree: a slug is missing or repeated');
    const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1)) order.push('ranks are not exactly 1..N once each');
    let previous = Number.POSITIVE_INFINITY;
    for (const [index, r] of rows.entries()) {
      if (r.implied_value_usd > previous) order.push(`row ${index + 1} (${r.slug}) implies more than the row above it`);
      previous = r.implied_value_usd;
      if (order.length > 3) break;
    }
    if (rows.length > 1 && new Set(rows.map((r) => r.implied_value_usd)).size === 1) order.push('every row carries the same value');
    row('sorted_by_value', order.length === 0, order.length === 0 ? 'ranks 1..N, value never rises, more than one value' : order.join('; '));

    // coverage: every watchlist slug is on the board.
    if (snapshotPath !== null) {
      if (!existsSync(snapshotPath)) {
        row('coverage', false, `no snapshot at ${snapshotPath}: pass --input, or --no-input to skip this row`);
      } else {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        const watchlist = Array.isArray(snapshot.watchlist) ? snapshot.watchlist : [];
        const missing = watchlist.filter((slug) => !slugs.has(slug));
        const unknown = [...slugs].filter((slug) => !snapshot.protocols.some((p) => p.slug === slug));
        const trouble = [];
        if (missing.length > 0) trouble.push(`${missing.length} watchlist slugs missing: ${missing.slice(0, 5).join(', ')}`);
        if (unknown.length > 0) trouble.push(`${unknown.length} board slugs are not in the snapshot: ${unknown.slice(0, 5).join(', ')}`);
        row('coverage', trouble.length === 0, trouble.length === 0 ? `${watchlist.length}/${watchlist.length} watchlist slugs on the board` : trouble.join('; '));
      }
    } else {
      row('coverage', true, 'skipped: --no-input');
    }
  }
}

// ------------------------------------------------------------------ dashboard/
const pageDir = join(outDir, 'dashboard');
const address = /(?:https?:)?\/\/[A-Za-z0-9]/;
if (!existsSync(pageDir)) {
  row('dashboard_files', false, 'no dashboard/ directory');
} else {
  const names = readdirSync(pageDir).filter((n) => !n.startsWith('.'));
  const trouble = [];
  if (!names.includes('index.html')) trouble.push('no index.html');
  if (!names.some((n) => n.endsWith('.css'))) trouble.push('no stylesheet');
  if (!names.some((n) => n.endsWith('.js'))) trouble.push('no script');
  if (names.length > DASHBOARD_MAX_FILES) trouble.push(`${names.length} files past ${DASHBOARD_MAX_FILES}`);
  let bytes = 0;
  for (const name of names) {
    const path = join(pageDir, name);
    if (!statSync(path).isFile()) trouble.push(`${name} is not a regular file`);
    if (!PLAIN_NAME.test(name)) trouble.push(`${name} is not a plain name`);
    bytes += statSync(path).size;
    if (!/\.(?:html|css|js)$/i.test(name)) continue;
    const source = readFileSync(path, 'utf8');
    if (address.test(source)) {
      const line = source.split('\n').findIndex((l) => address.test(l)) + 1;
      trouble.push(`${name}: an address on line ${line}`);
    }
  }
  if (bytes > DASHBOARD_MAX_BYTES) trouble.push(`${bytes} bytes past ${DASHBOARD_MAX_BYTES}`);
  row('dashboard_files', trouble.length === 0, trouble.length === 0 ? `${names.length} files, ${bytes} bytes, no address` : trouble.join('; '));
}

// ------------------------------------------------------------------ screenshots/
const shotDir = join(outDir, 'screenshots');
if (!existsSync(shotDir)) {
  row('screenshots', false, 'no screenshots/ directory');
} else {
  const names = readdirSync(shotDir).filter((n) => !n.startsWith('.'));
  const trouble = [];
  if (names.length < SHOT_MIN || names.length > SHOT_MAX) trouble.push(`${names.length} images outside ${SHOT_MIN}..${SHOT_MAX}`);
  for (const name of names) {
    const path = join(shotDir, name);
    const size = statSync(path).size;
    if (size > SHOT_MAX_BYTES) trouble.push(`${name} is ${size} bytes past ${SHOT_MAX_BYTES}`);
    const size2 = imageSize(readFileSync(path));
    if (size2 === null) {
      trouble.push(`${name} is not a PNG or JPEG`);
      continue;
    }
    const long = Math.max(size2.width, size2.height);
    const short = Math.min(size2.width, size2.height);
    if (long > SHOT_LONG_MAX) trouble.push(`${name} long side ${long} past ${SHOT_LONG_MAX}`);
    if (short < SHOT_SHORT_MIN) trouble.push(`${name} short side ${short} under ${SHOT_SHORT_MIN}`);
  }
  row('screenshots', trouble.length === 0, trouble.length === 0 ? `${names.length} images inside every cap` : trouble.join('; '));
}

// ------------------------------------------------------------------ dossier.json
const dossierPath = join(outDir, 'dossier.json');
if (!existsSync(dossierPath)) {
  row('dossier_matches', false, 'no dossier.json');
} else {
  const fresh = Buffer.from(
    buildDossier(outDir, {
      text_max_bytes: DOSSIER_TEXT_MAX_BYTES,
      screenshots: { max: SHOT_MAX, max_bytes: SHOT_MAX_BYTES },
      dashboard: { max_files: DASHBOARD_MAX_FILES, max_bytes: DASHBOARD_MAX_BYTES },
    }),
  );
  const onDisk = readFileSync(dossierPath);
  const same = fresh.length === onDisk.length && createHash('sha256').update(fresh).digest('hex') === createHash('sha256').update(onDisk).digest('hex');
  row('dossier_matches', same, same ? `${onDisk.length} bytes, byte for byte what buildDossier writes` : 'the file on disk is not what buildDossier writes from this output directory');
}

// ------------------------------------------------------------------ report
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  process.stdout.write(`${r.ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(16)} ${r.detail}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} rows pass\n`);
process.exit(failed === 0 ? 0 : 1);
