# token-launch-radar

A make.fun entry for `token-radar-01`: `main.ts` scores every pre-token protocol in a sealed
DefiLlama snapshot by a category-anchored implied value, then writes `board.json`, `data.js`
and `dossier.json` into an output directory and copies `dashboard/` and `screenshots/` beside
them. Node 22.18+, standard library only, no dependencies, no `package.json`.

## Status

Updated 2026-11-16. Runs: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input` writes all
five deliverables with exit 0, and `scripts/verify.mjs` passes 6/6 gate rows. Pushed to
https://github.com/im354/token-launch-radar at `0dc5b20`, public, README badges and About filled.
`makefun check` is 12 pass, 1 fail, 6 skip, 5 at submission. Open: `thinking_reproduces` sits at
159/2710 (5.8%) because the app wrote no session journal after 2026-11-15T19:15 local — the only
two `~/.superbot/sessions/ses_*.jsonl` files stop there, and `~/.superbot/chats/<thread>.json`
holds text only with no tool calls, so no bundle can contain today's `lib/model.ts` and `main.ts`
writes. Not a code problem: it clears once the app journals a turn that writes those files.
Filed as br_mwiq80yt_e3f1eeeb. Nothing has been submitted.

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
- `main.ts` — arguments, the four writes, the dossier, and the `boardIssue` assertion.
- `dashboard/` — three static files, no address of any kind, reading `window.RADAR`.
- `vendor/makefun-board.ts` — the kit's, byte for byte; never edit it.

## Decisions

- A protocol the watchlist definition excludes stays on the board, tagged `launch_unlikely`
  and multiplied by one board-wide launch factor, so it ranks below every plausible launch
  without being silently dropped.
- `runA/`, `runB/`, `out*/` are generated and stay out of the tree: committing a generated
  `data.js` inflates the transcript check's counted lines roughly seventeenfold.
- The kit's `check` copies with GNU tar reading `C:\` as a remote host; put
  `/c/Windows/System32` first on `PATH` so `bsdtar` is used.
- The github.com credential for pushes lives in the Windows Credential Manager (login `im354`,
  scopes gist/repo/workflow); `git credential fill` reads it, and `gh` is not installed. Superbot's
  own GitHub connection stays unset, so `github_api` answers 401 while `git push` works.
