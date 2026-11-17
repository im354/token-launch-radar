// Entry point for the token launch radar.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input
//
// Reads the sealed snapshot, scores every pre-token protocol, then writes all five
// deliverables into the output directory:
//
//   board.json     the ranked board, 100 to 4,000 rows
//   data.js        the same data as window.RADAR, beside the page
//   dashboard/     the static page, copied as it is in this repository
//   screenshots/   the three captures of that page, copied as they are
//   dossier.json   the judge's file, written by the kit's own buildDossier
//
// Nothing here reads a clock or a random number: two runs over one snapshot write the
// same bytes. The program only ever writes inside the output directory.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { auditSensitivity, renderTable, sensitivityIssue, stabilityLine } from './lib/sensitivity.ts';

const HERE = import.meta.dirname;
const TEXT_MAX_BYTES = 65_536;

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at < 0) return null;
  const value = process.argv[at + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function snapshotPath(): string {
  const given = flag('--input') ?? '/input';
  return given.endsWith('.json') ? resolve(given) : resolve(given, 'snapshot.json');
}

function replaceDir(source: string, target: string): void {
  if (!existsSync(source)) throw new Error('missing ' + source + ': the entry ships it beside main.ts');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

// Rank stability is a check on the model, not a sixth deliverable: the audit is printed and
// the board on disk is untouched. --audit asks for the whole table instead of one line.
function reportStability(radar: ReturnType<typeof buildRadar>): void {
  const audit = auditSensitivity(radar.rows);
  const issue = sensitivityIssue(audit, radar.rows);
  if (issue !== null) throw new Error('the stability audit fails its own check: ' + issue);
  process.stdout.write(stabilityLine(audit) + '\n');
  if (process.argv.includes('--audit')) process.stdout.write(renderTable(audit));
}

function main(): void {
  const input = snapshotPath();
  if (!existsSync(input)) throw new Error('no snapshot at ' + input + ' (pass --input <snapshot.json|dir>)');

  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
  mkdirSync(outDir, { recursive: true });

  const snapshot = parseSnapshot(readFileSync(input, 'utf8'));
  const radar = buildRadar(snapshot);

  const issue = boardIssue(radar);
  if (issue !== null) throw new Error('the board fails its own gate check: ' + issue);

  const board = {
    as_of: radar.as_of,
    source: radar.source,
    model_version: radar.model_version,
    model_summary: radar.model_summary,
    rows: radar.rows,
  };
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n');
  writeFileSync(join(outDir, 'data.js'), dataScript(radar));

  replaceDir(join(HERE, 'dashboard'), join(outDir, 'dashboard'));
  replaceDir(join(HERE, 'screenshots'), join(outDir, 'screenshots'));

  const dossier = buildDossier(outDir, { text_max_bytes: TEXT_MAX_BYTES });
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const plausible = radar.rows.filter((r) => !r.launch_unlikely).length;
  process.stdout.write(
    'wrote ' + outDir + ': ' +
      radar.rows.length + ' rows (' + plausible + ' plausible, ' + (radar.rows.length - plausible) + ' tagged), ' +
      radar.counts.watchlist_covered + '/' + radar.watchlist_size + ' watchlist, ' +
      radar.live.length + ' trading reference, launch factor ' + radar.assumptions.launch_factor.toFixed(6) + '\n',
  );

  reportStability(radar);
}

try {
  main();
} catch (err) {
  process.stderr.write('token-launch-radar: ' + (err as Error).message + '\n');
  process.exitCode = 1;
}
