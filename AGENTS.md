# token-launch-radar

A make.fun entry for `token-radar-01`: `main.ts` scores every pre-token protocol in a sealed
DefiLlama snapshot by a category-anchored implied value, then writes `board.json`, `data.js`
and `dossier.json` into an output directory and copies `dashboard/` and `screenshots/` beside
them. Node 22.18+, standard library only, no dependencies, no `package.json`.

## Status

Updated 2026-11-16. Runs: `MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input` writes all
five deliverables with exit 0, and `scripts/verify.mjs` passes 6/6 gate rows. `makefun check`
is 12 pass, 1 fail, 6 skip, 5 at submission. Open: no GitHub remote, so `repo_public`,
`repo_created_after_open` and `commit_in_repo` cannot pass, and the README badges still carry
`{owner}`; and `thinking_reproduces` is stuck at 159/2706 (5.8%) because this chat has no
journal at all — the only two `~/.superbot/sessions/ses_*.jsonl` files stop at 2026-11-15T12:15Z,
before the model was rewritten, and the live chat record under `~/.superbot/chats/` holds text
only, no tool calls, so no bundle can show the code being written. Filed as br_mwiq80yt_e3f1eeeb.

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
