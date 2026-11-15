// Token Launch Radar: the entry program.
//
// One sealed snapshot in, one artifact out. The program reads the snapshot (--input <snapshot.json|dir>),
// scores every pre-token protocol with the model in lib/model.ts, then writes, in this order:
//
//   board.json      the ranked board the gate reads (rows: rank, slug, name, implied_value_usd, farm_steps)
//   data.js         the dashboard's whole dataset, as one script, beside the page
//   dashboard/      index.html, app.css, app.js copied whole
//   screenshots/    the three views of this dashboard, copied whole
//   dossier.json    buildDossier of the two directories above, written last and byte for byte
//
// Nothing here reads the clock, the network or the environment beyond MAKEFUN_OUTPUT_DIR, so two runs on the
// same snapshot write the same bytes. Outside the grader's container:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, MODEL, MODEL_VERSION } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps, from reference/gate.json: the text cap shapes bytes, the rest refuse. */
const DOSSIER_TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAP_BYTES = 524_288;
const SCREENSHOT_MIN = 3;
const SCREENSHOT_MAX = 4;
const DASHBOARD_MAX_FILES = 400;
const DASHBOARD_MAX_BYTES = 4_194_304;
const ARTIFACT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Report progress on stdout, one line per stage, and stop the run on a refusal. */
function log(line: string): void {
  process.stdout.write(`radar: ${line}\n`);
}

function die(line: string): never {
  process.stderr.write(`radar: ${line}\n`);
  process.exit(1);
}

/** --name <value> or --name=<value>, else the fallback. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? fallback : inline.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  die(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory>, or mount the sealed /input`);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// 1. Read and score.
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
log(`${snapshot.protocols.length} protocols in the snapshot, ${snapshot.watchlist.length} on the watchlist, as_of ${snapshot.as_of}`);

const { board, radar } = buildRadar(snapshot, MODEL);
const issue = boardIssue(board, snapshot);
if (issue !== null) die(`the model wrote a board the gate refuses: ${issue}`);
log(
  `${board.length} rows scored: ${radar.counts.plausible} plausible launches, ${radar.counts.launch_unlikely} launch_unlikely, ` +
    `${radar.counts.watchlist_covered}/${radar.counts.watchlist_size} watchlist covered, ${radar.live_size} already trading set aside`,
);

// 2. Write the gate's two data files.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));
log(`wrote board.json and data.js (model ${MODEL_VERSION})`);

// 3. Copy the page and the screenshots, refusing anything the gate would refuse.
/** Copy one directory's regular files into `to`, skipping dot names. Returns the names copied. */
function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyDir(join(HERE, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDir(join(HERE, 'screenshots'), join(outDir, 'screenshots'));

if (!dashboardFiles.includes('index.html')) die('dashboard/ holds no index.html');
if (!dashboardFiles.some((n) => n.endsWith('.css'))) die('dashboard/ holds no stylesheet');
if (!dashboardFiles.some((n) => n.endsWith('.js'))) die('dashboard/ holds no script');
if (dashboardFiles.length > DASHBOARD_MAX_FILES) die(`dashboard/ holds ${dashboardFiles.length} files, past the ${DASHBOARD_MAX_FILES} the gate takes`);
const dashboardBytes = dashboardFiles.reduce((sum, n) => sum + statSync(join(outDir, 'dashboard', n)).size, 0);
if (dashboardBytes > DASHBOARD_MAX_BYTES) die(`dashboard/ is ${dashboardBytes} bytes, past the ${DASHBOARD_MAX_BYTES} the gate takes`);
for (const name of dashboardFiles) {
  if (!ARTIFACT_NAME.test(name)) die(`dashboard/${name}: a file name is letters, digits and . _ -, 1 to 128 characters`);
}
log(`copied dashboard/ (${dashboardFiles.length} files, ${dashboardBytes} bytes)`);

if (shots.length < SCREENSHOT_MIN || shots.length > SCREENSHOT_MAX) {
  die(`screenshots/ holds ${shots.length} images: hand in ${SCREENSHOT_MIN} to ${SCREENSHOT_MAX}, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!ARTIFACT_NAME.test(name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') ? name : '')) {
    die(`screenshots/${name}: a screenshot is named .png, .jpg or .jpeg, letters, digits and . _ - only`);
  }
  const bytes = statSync(join(outDir, 'screenshots', name)).size;
  if (bytes > SCREENSHOT_CAP_BYTES) die(`screenshots/${name} is ${bytes} bytes, past the ${SCREENSHOT_CAP_BYTES} the gate takes`);
}
log(`copied screenshots/ (${shots.join(', ')})`);

// 4. The dossier last: the scorer rebuilds it from this output directory and compares bytes.
const dossier = buildDossier(outDir, {
  text_max_bytes: DOSSIER_TEXT_MAX_BYTES,
  screenshots: { max: SCREENSHOT_MAX, max_bytes: SCREENSHOT_CAP_BYTES },
  dashboard: { max_files: DASHBOARD_MAX_FILES, max_bytes: DASHBOARD_MAX_BYTES },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

const dossierBytes = Buffer.byteLength(dossier, 'utf8');
log(`wrote dossier.json (${dossierBytes} bytes)`);
log(
  `top of the board: ${board
    .slice(0, 3)
    .map((r) => `${r.rank}. ${r.name} $${r.implied_value_usd.toLocaleString('en-US')}`)
    .join(' | ')}`,
);
log(`done: ${relative(process.cwd(), outDir) || '.'} holds board.json, data.js, dashboard/, screenshots/ and dossier.json`);
