// Entry point: turns the sealed snapshot into everything the entry hands over.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input
//
// It writes board.json and data.js (the model's two outputs), copies the dashboard and the
// screenshots beside them, and builds dossier.json from what it just wrote. Every file is
// a pure function of the snapshot plus the files in this repository, so two runs into two
// directories produce byte-identical trees.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSnapshot,
  buildRadar,
  boardIssue,
  dataScript,
  MODEL_VERSION,
  SnapshotError,
} from './lib/model.ts';
import { buildDossier, DossierError } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  input: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let input = '';
  let out = process.env.MAKEFUN_OUTPUT_DIR || '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') {
      input = argv[++i] || '';
    } else if (a.startsWith('--input=')) {
      input = a.slice('--input='.length);
    } else if (a === '--out') {
      out = argv[++i] || '';
    } else if (a.startsWith('--out=')) {
      out = a.slice('--out='.length);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: MAKEFUN_OUTPUT_DIR=<dir> node main.ts --input <kit>/input\n');
      process.exit(0);
    } else {
      throw new Error('unrecognised argument: ' + a);
    }
  }
  if (!input) throw new Error('no --input directory given: point it at the kit\'s input/ folder');
  if (!out) throw new Error('no output directory: set MAKEFUN_OUTPUT_DIR or pass --out');
  return { input: resolve(input), out: resolve(out) };
}

function readSnapshot(inputDir: string): string {
  const path = join(inputDir, 'snapshot.json');
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new SnapshotError('cannot read ' + path + ': ' + (err as Error).message);
  }
}

// Copy a directory of plain files one level deep, which is all the dashboard and the
// screenshots are. Byte for byte, so the dossier describes what the entry actually ships.
function copyFlat(fromDir: string, toDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(fromDir).sort();
  } catch {
    return [];
  }
  mkdirSync(toDir, { recursive: true });
  const copied: string[] = [];
  for (const name of names) {
    const from = join(fromDir, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(toDir, name));
    copied.push(name);
  }
  return copied;
}

function writeJson(path: string, value: unknown): number {
  const text = JSON.stringify(value, null, 1) + '\n';
  writeFileSync(path, text, 'utf8');
  return Buffer.byteLength(text);
}

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = parseSnapshot(readSnapshot(args.input));

  process.stdout.write(
    'radar: ' + snapshot.protocols.length + ' protocols in the snapshot, ' +
    snapshot.watchlist.length + ' on the watchlist, as_of ' + snapshot.as_of + '\n'
  );

  const radar = buildRadar(snapshot);

  // The gate's own limits, asserted here so a broken board never reaches a file.
  const issue = boardIssue(radar);
  if (issue) throw new Error('the board fails its own gate: ' + issue);

  process.stdout.write(
    'radar: ' + radar.rows.length + ' rows scored: ' + radar.counts.plausible + ' plausible launches, ' +
    radar.counts.launch_unlikely + ' launch_unlikely, ' + radar.counts.watchlist_covered + '/' +
    radar.counts.watchlist_size + ' watchlist covered, ' + radar.counts.already_trading +
    ' already trading set aside, launch factor ' + radar.assumptions.launch_likelihood + '\n'
  );

  mkdirSync(args.out, { recursive: true });

  // 1. board.json: the rows, plus the context a reader needs to check them.
  const boardBytes = writeJson(join(args.out, 'board.json'), {
    as_of: radar.as_of,
    source: radar.source,
    model_version: radar.model_version,
    model: radar.model,
    counts: radar.counts,
    assumptions: radar.assumptions,
    exclusions: radar.exclusions,
    multiples: radar.multiples,
    global_multiple: radar.global_multiple,
    rows: radar.rows,
  });

  // 2. data.js: the same record, as the static page's only input.
  const dataText = dataScript(radar);
  writeFileSync(join(args.out, 'data.js'), dataText, 'utf8');

  process.stdout.write(
    'radar: wrote board.json (' + boardBytes + ' bytes) and data.js (' +
    Buffer.byteLength(dataText) + ' bytes) (model ' + MODEL_VERSION + ')\n'
  );

  // 3. The dashboard and the screenshots, copied as they are.
  const dashboard = copyFlat(join(HERE, 'dashboard'), join(args.out, 'dashboard'));
  let dashboardBytes = 0;
  for (const name of dashboard) dashboardBytes += statSync(join(args.out, 'dashboard', name)).size;
  process.stdout.write('radar: copied dashboard/ (' + dashboard.length + ' files, ' + dashboardBytes + ' bytes)\n');

  const shots = copyFlat(join(HERE, 'screenshots'), join(args.out, 'screenshots'));
  process.stdout.write('radar: copied screenshots/ (' + (shots.join(', ') || 'none') + ')\n');

  // 4. dossier.json: what the judge reads without running anything. Built from the output
  // directory, so it describes exactly the files being handed over.
  let dossier: Uint8Array;
  try {
    dossier = buildDossier(args.out, { text_max_bytes: 65536 });
  } catch (err) {
    if (err instanceof DossierError) throw new Error('the dossier could not be built: ' + err.message);
    throw err;
  }
  writeFileSync(join(args.out, 'dossier.json'), dossier);
  process.stdout.write('radar: wrote dossier.json (' + dossier.length + ' bytes)\n');

  const top = radar.rows.slice(0, 3)
    .map((r) => r.rank + '. ' + r.name + ' ' + money(r.implied_value_usd))
    .join(' | ');
  process.stdout.write('radar: top of the board: ' + top + '\n');
  process.stdout.write(
    'radar: done: ' + basename(args.out) + ' holds board.json, data.js, dashboard/, screenshots/ and dossier.json\n'
  );
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write('radar: ' + message + '\n');
  process.exit(1);
}
