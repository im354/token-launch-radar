// The entry program. One sealed snapshot in, one artifact directory out.
//
//   --input   a snapshot.json, or a directory holding one   (default /input)
//   --output  the directory to write                        (default $MAKEFUN_OUTPUT_DIR, else /output)
//
// In order, it writes:
//
//   board.json    the ranked board, the file the gate reads
//   data.js       the page's whole dataset, as one script beside the page
//   dashboard/    index.html, app.css and app.js, copied whole
//   screenshots/  the three views of this dashboard, copied whole
//   dossier.json  buildDossier of the two directories above, written last, byte for byte
//
// Before any of that it scores the board and audits it against the gate's limits, so a board the gate
// would refuse stops the run here with the reason instead of being written.
//
// The program reads no clock, no network and no environment beyond MAKEFUN_OUTPUT_DIR, so two runs on
// one snapshot write the same bytes:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, MODEL, MODEL_VERSION } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes bytes, the rest refuse. */
const DOSSIER_TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAP_BYTES = 524_288;
const SCREENSHOT_MIN = 3;
const SCREENSHOT_MAX = 4;
const DASHBOARD_MAX_FILES = 400;
const DASHBOARD_MAX_BYTES = 4_194_304;
/** A file name the gate will take: a letter or digit first, then letters, digits, dots, dashes, underscores. */
const ARTIFACT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SHOT_NAME = /\.(?:png|jpe?g)$/i;

/** One progress line per stage. */
function say(line: string): void {
  process.stdout.write(`radar: ${line}\n`);
}

/** Say why the run stopped, and stop. */
function stop(line: string): never {
  process.stderr.write(`radar: ${line}\n`);
  process.exit(1);
}

/** `--name value` or `--name=value`, else the fallback. */
function option(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

const inputArgument = option('input', '/input');
const snapshotPath = inputArgument.endsWith('.json') ? inputArgument : join(inputArgument, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  stop(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory>, or mount the sealed /input`);
}
const outputDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------- 1. read, score, audit
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
say(`${snapshot.protocols.length} protocols in the snapshot, ${snapshot.watchlist.length} on the watchlist, as_of ${snapshot.as_of}`);

const { board, radar } = buildRadar(snapshot, MODEL);
const complaint = boardIssue(board, snapshot);
if (complaint !== null) stop(`the model wrote a board the gate refuses: ${complaint}`);
say(
  `${board.length} rows scored: ${radar.counts.plausible} plausible launches, ${radar.counts.launch_unlikely} launch_unlikely, ` +
    `${radar.counts.watchlist_covered}/${radar.counts.watchlist_size} watchlist covered, ${radar.live_size} already trading set aside, ` +
    `launch factor ${radar.assumptions.launch_likelihood}`,
);

// ---------------------------------------------------------------- 2. the gate's two data files
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));
say(`wrote board.json and data.js (model ${MODEL_VERSION})`);

// ---------------------------------------------------------------- 3. the page and the screenshots
/** Copy one directory's regular files into `to`, skipping dot names. Answers the names copied. */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    copied.push(name);
  }
  return copied;
}

const pageFiles = copyDirectory(join(HERE, 'dashboard'), join(outputDir, 'dashboard'));
const shots = copyDirectory(join(HERE, 'screenshots'), join(outputDir, 'screenshots'));

if (!pageFiles.includes('index.html')) stop('dashboard/ holds no index.html');
if (!pageFiles.some((n) => n.endsWith('.css'))) stop('dashboard/ holds no stylesheet');
if (!pageFiles.some((n) => n.endsWith('.js'))) stop('dashboard/ holds no script');
if (pageFiles.length > DASHBOARD_MAX_FILES) stop(`dashboard/ holds ${pageFiles.length} files, past the ${DASHBOARD_MAX_FILES} the gate takes`);
for (const name of pageFiles) {
  if (!ARTIFACT_NAME.test(name)) stop(`dashboard/${name}: a file name is letters, digits and . _ -, 1 to 128 characters`);
}
const pageBytes = pageFiles.reduce((sum, name) => sum + statSync(join(outputDir, 'dashboard', name)).size, 0);
if (pageBytes > DASHBOARD_MAX_BYTES) stop(`dashboard/ is ${pageBytes} bytes, past the ${DASHBOARD_MAX_BYTES} the gate takes`);
say(`copied dashboard/ (${pageFiles.length} files, ${pageBytes} bytes)`);

if (shots.length < SCREENSHOT_MIN || shots.length > SCREENSHOT_MAX) {
  stop(`screenshots/ holds ${shots.length} images: hand in ${SCREENSHOT_MIN} to ${SCREENSHOT_MAX}, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name) || !ARTIFACT_NAME.test(name)) {
    stop(`screenshots/${name}: a screenshot is named .png, .jpg or .jpeg, letters, digits and . _ - only`);
  }
  const bytes = statSync(join(outputDir, 'screenshots', name)).size;
  if (bytes > SCREENSHOT_CAP_BYTES) stop(`screenshots/${name} is ${bytes} bytes, past the ${SCREENSHOT_CAP_BYTES} the gate takes`);
}
say(`copied screenshots/ (${shots.join(', ')})`);

// ---------------------------------------------------------------- 4. the dossier, last
const dossier = buildDossier(outputDir, {
  text_max_bytes: DOSSIER_TEXT_MAX_BYTES,
  screenshots: { max: SCREENSHOT_MAX, max_bytes: SCREENSHOT_CAP_BYTES },
  dashboard: { max_files: DASHBOARD_MAX_FILES, max_bytes: DASHBOARD_MAX_BYTES },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);
say(`wrote dossier.json (${Buffer.byteLength(dossier, 'utf8')} bytes)`);

const top = board
  .slice(0, 3)
  .map((row) => `${row.rank}. ${row.name} $${row.implied_value_usd.toLocaleString('en-US')}`)
  .join(' | ');
say(`top of the board: ${top}`);
say(`done: ${relative(process.cwd(), outputDir) || '.'} holds board.json, data.js, dashboard/, screenshots/ and dossier.json`);
