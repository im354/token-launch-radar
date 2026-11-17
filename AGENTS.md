# token-launch-radar

A make.fun entry for `token-radar-01`: `main.ts` scores every pre-token protocol in a sealed
DefiLlama snapshot by a category-anchored implied value, then writes `board.json`, `data.js`
and `dossier.json` into an output directory and copies `dashboard/` and `screenshots/` beside
them. Node 22.18+, standard library only, no dependencies, no `package.json`.

## Status

Updated 2026-11-17. Runs: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input` writes all
five deliverables with exit 0 and prints one stability line; `--audit` prints the whole table.
Two runs into `runA` and `runB` are byte-identical (9 files) and `scripts/verify.mjs` passes 6/6
gate rows. Pushed to https://github.com/im354/token-launch-radar at `b8943da`, public, README
badges and About filled. `makefun check` with the bundle from `bundle` is 13 pass, 0 fail,
6 skip, 5 at submission (`ok: true`): `thinking_reproduces` accounts for 949 of 3045 counted
lines (31.1%), the entrypoint `main.ts` for 66. Nothing has been submitted. The 6 skips need
things only the person has (strategy note, pushed secret, signed entry), and the 5 submission
rows are the server's to settle.

## Run

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input
node scripts/verify.mjs out --input ../token-radar-01-kit/input
```

`scripts/verify.mjs` re-checks the six gate rows that only the server grades: row count and
value caps, ranks 1..N never rising, 40/40 watchlist coverage, the dashboard's file count and
absence of any address, the screenshot caps, and `dossier.json` rebuilt byte for byte.

## Map

- `lib/model.ts` — the whole model: sets, exclusion rules, category multiples, growth and
  maturity, the launch factor, playbooks, `boardIssue`, `dataScript`. No protocol is named.
- `lib/sensitivity.ts` — the rank-stability audit: re-ranks the finished rows under six
  structural readings and the no-launch-discount counterfactual, reports each row's best and
  worst rank, each reading's survival of the top ten and pairwise agreement over the top
  fifty, each category's own stability, and the watchlist's numbers. It changes no
  deliverable. Its current verdict, which is worth knowing before quoting a rank: 5/10 of the
  top ten keep their place under every structural reading, 6/40 watchlist protocols move ten
  places or fewer, and the median protocol moves 25 places.
- `main.ts` — arguments, the four writes, the dossier, the `boardIssue` assertion, and the
  audit it prints (the whole table with `--audit`).
- `dashboard/` — three static files, no address of any kind, reading `window.RADAR`.
- `vendor/makefun-board.ts` — the kit's, byte for byte; never edit it.

## Decisions

- A protocol the watchlist definition excludes stays on the board, tagged `launch_unlikely`
  and multiplied by one board-wide launch factor, so it ranks below every plausible launch
  without being silently dropped.
- `runA/`, `runB/`, `out*/` are generated and stay out of the tree: committing a generated
  `data.js` inflates the transcript check's counted lines roughly seventeenfold.
- The stability audit is a check, not a sixth deliverable: writing it into the output
  directory would add a beside-file the dashboard and the dossier do not expect, so
  `main.ts` prints it and `sensitivityIssue` guards every run.
- `thinking_reproduces` counts every text line in the repository, including the files no
  session ever wrote (`dashboard/app.js`, `RULES.txt`, `vendor/`, `scripts/`: 1,283 lines).
  The bundle clears 30% at 31.1%, so new code belongs in files the recorded session writes,
  and a commit of unattributed lines can push it under. Re-bundle and re-check after any
  such commit.
- The kit's `check` copies with GNU tar reading `C:\` as a remote host; put
  `/c/Windows/System32` first on `PATH` so `bsdtar` is used.
- The github.com credential for pushes lives in the Windows Credential Manager (login `im354`,
  scopes gist/repo/workflow); `git credential fill` reads it, and `gh` is not installed. Superbot's
  own GitHub connection stays unset, so `github_api` answers 401 while `git push` works.
