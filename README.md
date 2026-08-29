<h1 align="center">csm</h1>

<p align="center">
  <b>Find and resume any Claude Code session, from any directory.</b><br>
  Tag the ones that matter and they survive Claude Code's 30-day cleanup.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-sessions-cli"><img alt="npm" src="https://img.shields.io/npm/v/claude-sessions-cli.svg"></a>
  <a href="https://github.com/soohunee/claude-session-manager/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/soohunee/claude-session-manager/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/node/v/claude-sessions-cli.svg">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen.svg">
</p>

---

`claude --resume` only lists sessions from the directory you happen to be standing
in. Work doesn't stay in one directory: you start something in `~/work/api`,
follow it into `~/work/infra`, and a week later you cannot remember where you
were when you had that conversation — so you cannot get back to it.

`csm` indexes every Claude Code session on your machine, whichever directory it
came from, and resumes the one you pick.

```
Claude sessions  29 sessions shown · 54 expired, transcript gone (-a to list)
search> refactor
──────────────────────────────────────────────────────────────────────────────
> 2h ago   144  Billing refactor — split invoice service   ~/work/api   #billing
  1d ago    88  Terraform for the new billing queue        ~/work/infra #billing
  4d ago    31  Refactor the auth middleware               ~/work/api
  1w ago   459  Refactoring notes and cleanup pass         ~/scratch
──────────────────────────────────────────────────────────────────────────────
↑↓/^n^p move · enter resume · ^u clear · esc quit   [1/4]
```

Press <kbd>Enter</kbd> and you are back in that conversation, in the right
directory.

## Features

- **Cross-directory search.** One picker over every session on the machine, not
  just the current project.
- **Archives that outlive cleanup.** Tagged sessions are copied out of Claude
  Code's reach and restored in place when you resume them.
- **Tags from inside Claude Code.** `/persist billing` marks the running session
  without leaving it.
- **Fuzzy interactive picker.** Type to filter, arrow keys to move, Enter to
  resume. Correct column alignment for wide characters.
- **Zero dependencies.** No network calls, no API keys; it only reads files
  Claude Code already writes.
- **Scriptable.** `--json` on every listing command, and anything after `--` is
  forwarded to `claude`.

## Why archiving matters

Claude Code deletes transcripts older than `cleanupPeriodDays` — **30 days by
default**. Run `csm doctor` and you will probably see something like this:

```
  sessions        83 across 5 directories
  resumable       29
  expired         54  (transcript deleted by Claude Code cleanup)
```

Those 54 conversations are listed only because Claude Code's global prompt
history still mentions them. The transcripts themselves are gone, and no tool can
bring them back.

So `csm` does more than label sessions: tagging one **copies its transcript into
an archive** that cleanup does not touch. Months later `csm` puts the file back
where Claude Code expects it and resumes the session as if nothing had happened.

## Installation

```bash
npm install -g claude-sessions-cli
csm init
```

`csm init` installs the `/persist` slash command and two hooks (`SessionStart`
and `UserPromptSubmit`) that record which session is live in which directory. It
merges into an existing `settings.json` and backs the file up first;
`csm uninstall` reverses both changes.

Try it without installing:

```bash
npx claude-sessions-cli
```

Requires Node.js 18 or newer. Tested on macOS and Linux against Claude Code 2.x.

## Usage

```bash
csm                       # browse every session, fuzzy-search, Enter to resume
csm -t billing            # only sessions tagged #billing
csm resume billing        # resume the newest match without opening the picker
csm ls --dir --json       # this directory's sessions as JSON
csm resume billing -- --model opus   # extra flags go straight to claude
```

### Commands

| Command | Description |
| --- | --- |
| `csm [query]` | Interactive picker over every session (default) |
| `csm ls [query]` | Print sessions instead of opening the picker |
| `csm resume <id\|query>` | Resume directly, skipping the picker |
| `csm tag <tag...>` | Tag the session in this directory and archive it |
| `csm untag <tag...>` | Remove tags (omit tags to clear the session) |
| `csm tags` | List every tag with its session count |
| `csm archive` | Archive all tagged sessions now |
| `csm prune` | Delete archives of sessions that are no longer tagged |
| `csm init` | Install the `/persist` command and session hooks |
| `csm uninstall` | Remove them again |
| `csm doctor` | Show what csm sees and whether it is wired up |

### Options

| Option | Description |
| --- | --- |
| `-t, --tag <tag>` | Only sessions carrying this tag (repeatable) |
| `-d, --dir [path]` | Only sessions from this directory (default: cwd) |
| `-n, --limit <n>` | Cap the number of sessions shown |
| `-a, --all` | Include expired sessions with no transcript left |
| `--json` | Machine-readable output |
| `--session <id>` | Target this session id instead of the current one |
| `--no-archive` | With `tag`: record the tag but do not archive |
| `--refresh` | Ignore the metadata cache and re-read every file |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Keys in the picker

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>Ctrl</kbd>+<kbd>p</kbd> <kbd>Ctrl</kbd>+<kbd>n</kbd> | Move the selection |
| <kbd>PgUp</kbd> <kbd>PgDn</kbd> / <kbd>Home</kbd> <kbd>End</kbd> | Jump |
| any character | Filter |
| <kbd>Ctrl</kbd>+<kbd>u</kbd> | Clear the query |
| <kbd>Enter</kbd> | Resume the selected session |
| <kbd>Esc</kbd> | Quit |

### Tagging from inside Claude Code

When a conversation turns into something you will want back, tag it without
leaving the session:

```
/persist billing-refactor
```

Then, from anywhere:

```bash
csm -t billing-refactor
```

A session can carry several tags, and tags may be written in any language.

## How it works

Everything comes from files Claude Code already writes:

| Source | What csm reads from it |
| --- | --- |
| `~/.claude/projects/<dir>/<session>.jsonl` | Title, working directory, git branch, message count, timestamps |
| `~/.claude/history.jsonl` | The global, cross-directory list of session ids |
| `~/.claude/csm/` | Tags, archived transcripts, metadata cache — everything csm owns |

Claude Code writes an `ai-title` record into each transcript, so the titles in
the picker are its own rather than something csm generates. Session metadata is
cached by modification time and size, so repeat runs read almost nothing: a cold
scan of 78 sessions takes about 95 ms.

Uninstalling is `csm uninstall` followed by `rm -rf ~/.claude/csm`. Nothing else
on disk is modified, and csm never writes to Claude Code's own transcripts.

## Configuration

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Points csm at a different Claude Code config directory, exactly as the Claude Code CLI uses it. Useful for trying destructive commands against a sandbox. |
| `NO_COLOR` | Disables ANSI colors. |

To keep untagged sessions around longer, raise `cleanupPeriodDays` in
`~/.claude/settings.json`.

## Notes and limits

- Resuming runs `claude --resume <id>` with the session's original working
  directory. If that directory has been deleted or moved, csm says so instead of
  guessing.
- Sessions marked `x` in `csm ls -a` are known only from prompt history. Nothing
  is left to restore; they are listed so you can see what was lost.
- If `csm tag` reports "matched by recency", the hooks are not installed yet —
  run `csm init`. Without them csm falls back to the most recently written
  transcript in the current directory, which is right nearly always but not
  guaranteed when two sessions share one directory.
- csm reads Claude Code's on-disk formats, which are not a public API. A Claude
  Code update could change them; parsing failures are skipped quietly and
  `csm doctor` is the place to look when numbers seem wrong.
- Windows is untested.

## Development

```bash
git clone https://github.com/soohunee/claude-session-manager
cd claude-session-manager
npm test                      # node:test, no dependencies
node bin/csm.js --help

export CLAUDE_CONFIG_DIR=/tmp/csm-sandbox   # experiment without touching ~/.claude
```

Issues and pull requests are welcome. Please keep the dependency count at zero
and add a test for anything that touches tags, archives, or `settings.json`.

## License

[MIT](LICENSE)
