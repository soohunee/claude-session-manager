<h1 align="center">csm</h1>

<p align="center">
  <b>Claude Code deletes your conversations after 30 days.</b><br>
  <code>csm</code> keeps the ones that matter — and finds them again from any directory.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-sessions-cli"><img alt="npm" src="https://img.shields.io/npm/v/claude-sessions-cli.svg"></a>
  <a href="https://github.com/soohunee/claude-session-manager/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/soohunee/claude-session-manager/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/node/v/claude-sessions-cli.svg">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen.svg">
</p>

---

Claude Code removes transcripts older than `cleanupPeriodDays` — **30 days by
default**. Run `csm doctor` on a machine you have been working on for a while
and the number is usually worse than you expect:

```
  sessions        83 across 5 directories
  resumable       29
  expired         54  (transcript deleted by Claude Code cleanup)
```

Fifty-four of those conversations still appear in Claude Code's prompt history,
so you can see that they happened. The transcripts are gone. Nothing can bring
them back, and nothing warned you.

**`csm` is the copy that survives.** Tag a session — from the shell, or with
`/persist` without leaving Claude Code — and its transcript is copied somewhere
cleanup does not reach, then refreshed every time you close the session. Months
later `csm` puts the file back where Claude Code expects it and resumes the
conversation as if nothing had happened.

Finding it again is the other half of the problem, because `claude --resume`
only lists sessions from the directory you happen to be standing in. Work does
not stay in one directory: you start something in `~/work/api`, follow it into
`~/work/infra`, and a week later you cannot remember where you were. So `csm`
indexes every session on the machine, whichever directory it came from, and
lets you search what was actually said in them.

```
Claude sessions  29 sessions shown · 54 expired, transcript gone (-a to list)
search> refactor
──────────────────────────────────────────────────────────────────────────────
> 2h ago   144  Billing refactor — split invoice service   ~/work/api   #billing
  1d ago    88  Terraform for the new billing queue        ~/work/infra #billing
  4d ago    31  Refactor the auth middleware               ~/work/api
  1w ago   459  Refactoring notes and cleanup pass         ~/scratch
──────────────────────────────────────────────────────────────────────────────
Billing refactor — split invoice service
2026-08-29 14:08 · 144 messages · main
~/work/api
0a1b2c3d-4e5f-6789-abcd-ef0123456789

› extract the token check into middleware
‹ Moving it into `requireToken` and wiring it ahead of the billing routes.
‹ The invoice service no longer imports the auth module directly.
──────────────────────────────────────────────────────────────────────────────
↑↓ move · enter resume · tab hide · ^r remote · ^f fork · ^y cmd  sort:time  [1/4]
```

Press <kbd>Enter</kbd> and you are back in that conversation, in the right
directory.

## Features

- **Archives that outlive cleanup.** Tagged sessions are copied out of Claude
  Code's reach and restored in place when you resume them, and refreshed each
  time the session ends so the copy never falls behind.
- **Cross-directory search.** One picker over every session on the machine, not
  just the current project.
- **Full-text search.** `csm search "rate limit"` looks inside the conversations
  themselves, not just their titles — for when you remember what was said but
  not where.
- **Tags from inside Claude Code.** `/persist billing` marks the running session
  without leaving it.
- **Fuzzy interactive picker.** Type to filter, arrow keys to move, Enter to
  resume. Correct column alignment for wide characters.
- **Preview panel.** <kbd>Tab</kbd> shows the tail of the conversation, led by
  the last prompt you typed — the fastest way to tell two similar titles apart.
- **Sort as you browse.** By recency, title, or working directory, without
  leaving the picker.
- **Resume however you need.** In place, as a fork that leaves the original
  untouched, or with Remote Control so you can carry on from your phone.
- **Zero dependencies.** No network calls, no API keys; it only reads files
  Claude Code already writes.
- **Scriptable.** `--json` on every listing command, `--print-cmd` to get the
  command instead of running it, and anything after `--` is forwarded to
  `claude`.

## Installation

```bash
npm install -g claude-sessions-cli
csm init
```

`csm init` installs the `/persist` slash command and three hooks. `SessionStart`
and `UserPromptSubmit` record which session is live in which directory, so
`/persist` always tags the session that ran it; `SessionEnd` re-archives a
tagged session as it closes. It merges into an existing `settings.json` and
backs the file up first; `csm uninstall` reverses every change.

Try it without installing:

```bash
npx claude-sessions-cli
```

Requires Node.js 18 or newer. Tested on macOS and Linux against Claude Code 2.x.

## Usage

```bash
csm                       # browse every session, fuzzy-search, Enter to resume
csm --tagged              # everything you have tagged, whatever the tag
csm -t billing            # only sessions tagged #billing
csm resume billing        # resume the newest match without opening the picker
csm resume billing --remote          # ...with Remote Control, to continue on mobile
csm resume billing --fork            # ...into a new session, leaving the original
csm resume billing --print-cmd       # print the command instead of running it
csm search "rate limit"   # find the conversation where you discussed it
csm ls --sort dir         # group the listing by working directory
csm ls --dir --json       # this directory's sessions as JSON
csm resume billing -- --model opus   # extra flags go straight to claude
```

### Commands

| Command | Description |
| --- | --- |
| `csm [query]` | Interactive picker over every session (default) |
| `csm ls [query]` | Print sessions instead of opening the picker |
| `csm resume <id\|query>` | Resume directly, skipping the picker |
| `csm search <text>` | Search what was said, across every session |
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
| `-t, --tag <tag>` | Only sessions carrying this tag (repeatable, AND) |
| `--tagged` | Only sessions carrying at least one tag |
| `-d, --dir [path]` | Only sessions from this directory (default: cwd) |
| `-n, --limit <n>` | Cap the number of sessions shown |
| `-a, --all` | Include expired sessions with no transcript left |
| `-s, --sort <time\|title\|dir>` | Order sessions (default: `time`) |
| `-p, --preview` | Open the picker with the preview panel already on |
| `--remote` | Resume with Remote Control, to continue on mobile |
| `--fork` | Resume into a new session id, leaving the original untouched |
| `--print-cmd` | Print the resume command instead of running it |
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
| <kbd>Tab</kbd> | Toggle the preview panel |
| <kbd>Ctrl</kbd>+<kbd>t</kbd> / <kbd>Ctrl</kbd>+<kbd>o</kbd> / <kbd>Ctrl</kbd>+<kbd>g</kbd> | Sort by time / title / directory |
| <kbd>Enter</kbd> | Resume the selected session |
| <kbd>Ctrl</kbd>+<kbd>r</kbd> | Resume it with Remote Control |
| <kbd>Ctrl</kbd>+<kbd>f</kbd> | Resume it as a fork |
| <kbd>Ctrl</kbd>+<kbd>y</kbd> | Print the resume command and exit |
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
- The hooks pin the absolute path of the Node build that installed them, since
  a hook runs with a minimal environment and cannot rely on `node` being on
  PATH. If a version manager later retires that build the hooks stop doing
  anything; `csm doctor` reports it and `csm init` repairs them in place.
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

Issues and pull requests are welcome. Work is based on `develop`; `master` only
holds released code. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branching
model and the release flow.

## License

[MIT](LICENSE)
