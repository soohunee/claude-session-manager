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
  key table, and the recording near the top
- `HELP` in `src/cli.js` — usage, options, and picker keys
- `CONTRIBUTING.md`, if the workflow itself changed
- the plugin, if a hook or the `/persist` command changed: `hooks/hooks.json`
  and `commands/persist.md` are its copies of the pair that `csm init` writes,
  and `claude plugin validate . --strict` checks the manifest

A new picker key goes in `ACTIONS` in `src/tui.js` first. That list drives the
on-screen menu, the `?` overlay, and which keys are dimmed for the highlighted
session, so a key added anywhere else will not appear in any of them.

The recording near the top of the README is real output rather than a drawing
of one, so it goes stale the moment the picker's layout or its menu changes.
Re-record it with `./demo/record.sh` when that happens; the recording and the
key tables drift most easily, because nothing fails when they do.

Set `CLAUDE_CONFIG_DIR` to experiment without touching your real `~/.claude`:

```bash
export CLAUDE_CONFIG_DIR=/tmp/csm-sandbox
```

## The README recording

`demo/demo.gif` is generated, not hand-made. Re-record it whenever the picker's
layout or its menu changes:

```bash
brew install asciinema agg tmux
./demo/record.sh
```

The picker is driven against `demo/demo.mjs`, which hands it a fixture instead
of the sessions on the machine running the script, so the recording stays the
same between runs and never publishes anyone's real projects. Change what the
recording shows by editing the keystrokes at the bottom of `demo/record.sh`.

## Releasing

1. Bump `version` in `package.json` on `develop` and merge that in.
2. Merge `develop` into `master` and push.

Release assets are built by the workflow from `npm pack`, so `files` in
`package.json` is the one place that decides what ships. The install text on the
release page comes from `.github/release-notes.md`, where `__VERSION__` is
substituted; edit that file rather than the workflow.

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
