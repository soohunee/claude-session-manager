# Contributing

## Branches

| Branch | What it is |
| --- | --- |
| `develop` | Where work lands. The default branch; base every feature branch here. |
| `master` | Released code only. A push here publishes a release. |
| `feature/<name>` | One branch per change, cut from `develop`. |

```
feature/preview-panel ──┐
feature/tag-filter ─────┼──▶ develop ──▶ master ──▶ npm + GitHub Release
```

Nothing is committed straight to `master`. It only ever receives a merge from
`develop`, and that merge is the act of releasing.

## Working on a change

```bash
git checkout develop && git pull
git checkout -b feature/what-it-does

npm test                      # node:test, no dependencies
node bin/csm.js --help

git push -u origin feature/what-it-does
gh pr create --base develop
```

CI runs the suite on Ubuntu and macOS across Node 18, 20, 22, and 24. Keep the
dependency count at zero, and add a test for anything that touches tags,
archives, or `settings.json` — those three write to files a user cares about.

A change to what the tool does is not finished until the docs match it. Before
opening the PR, check every place the behaviour is described:

- `README.md` — the feature list, the command and option tables, the picker
  key table, and the sample screen near the top
- `HELP` in `src/cli.js` — usage, options, and picker keys
- `CONTRIBUTING.md`, if the workflow itself changed

A new picker key goes in `ACTIONS` in `src/tui.js` first. That list drives the
on-screen menu, the `?` overlay, and which keys are dimmed for the highlighted
session, so a key added anywhere else will not appear in any of them.

The sample screen in the README is real output, not something written by hand:
take it from a run at 100 columns with the preview panel open, rather than
editing the columns to fit. The screen and the key tables go stale most easily,
because nothing fails when they drift.

Set `CLAUDE_CONFIG_DIR` to experiment without touching your real `~/.claude`:

```bash
export CLAUDE_CONFIG_DIR=/tmp/csm-sandbox
```

## Releasing

1. Bump `version` in `package.json` on `develop` and merge that in.
2. Merge `develop` into `master` and push.

The `Release` workflow takes it from there: it runs the tests, verifies the npm
credentials, publishes the package, tags the commit `v<version>`, and creates
the GitHub Release with generated notes.

Pushing `master` without bumping the version is harmless — the workflow sees
the existing tag and does nothing.

### One-time setup

Publishing from CI needs an npm **granular access token** with *Read and write*
on packages and **Bypass 2FA** enabled, stored as the `NPM_TOKEN` repository
secret (Settings → Secrets and variables → Actions). Without it the workflow
stops at the credentials check, before tagging anything.
