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
 csm 0.2.3              enter  Resume           a      Archive          c      This dir only
 4 shown · 54 expired   f      Resume a copy    /      Filter           g      Tree
 sort time              r      Remote control   s      Sort             u      Go to parent
 filter ref             y      Print cmd        t      Tag filter       p      Preview
                        n      New from this    .      Show expired     ?      Help
                        d      Untag            ,      Show unnamed     esc    Quit
────────────────────────────────────────────────────────────────────────────────────────────────────
  when     msgs title                                             directory                      tags
> 2h ago   144  Billing refactor — split invoice service          ~/work/api                     #billing
  1d ago   88   Terraform for the new billing queue               ~/work/infra                   #billing
  4d ago   31   Refactor the auth middleware                      ~/work/api
  1w ago   459  Refactoring notes and cleanup pass                ~/scratch
────────────────────────────────────────────────────────────────────────────────────────────────────
Billing refactor — split invoice service
2026-09-01 07:31 · 144 messages · main · archived
~/work/api
0a1b2c3d-4e5f-6789-abcd-ef0123456789 #billing

› extract the token check into middleware
‹ Moving it into `requireToken` and wiring it ahead of the billing routes.
‹ The invoice service no longer imports the auth module directly.


────────────────────────────────────────────────────────────────────────────────────────────────────
 NORMAL  [1/4]
```

Press <kbd>Enter</kbd> and you are back in that conversation, in the right
directory. Everything else it can do is in the menu on the right, and the menu
follows the highlighted session: keys that do not apply to it go dim rather than
disappearing, so there is nothing to look up.

## Features

- **Archives that outlive cleanup.** Tagged sessions are copied out of Claude
  Code's reach and restored in place when you resume them, and refreshed each
  time the session ends so the copy never falls behind.
- **Conversations, not leftovers.** Running `/plugins` or `/login` leaves a
  session behind too. Claude Code writes a title into a transcript once there is
  an actual conversation in it, so csm lists the ones it named and keeps the
  rest a keypress away. On this machine that is 13 rows instead of 29.
- **Cross-directory search.** One picker over every session on the machine, not
  just the current project.
- **Full-text search.** `csm search "rate limit"` looks inside the conversations
  themselves, not just their titles — for when you remember what was said but
  not where.
- **Hand a full session to a fresh one.** `csm derive` asks a session to write
  down where things stand, opens a new session on that document, and remembers
  which came from which — the thing you would otherwise do by hand every time a
  conversation fills up.
- **Session trees.** `csm tree` shows what grew out of what, so a chain of
  handoffs stays legible instead of looking like unrelated sessions.
- **Tags from inside Claude Code.** `/persist billing` marks the running session
  without leaving it.
- **A picker that explains itself.** Every action is a single letter listed on
  screen, and the list follows the highlighted session, so nothing has to be
  learned before it can be used. Correct column alignment for wide characters.
- **Preview panel.** <kbd>Tab</kbd> shows the tail of the conversation, led by
  the last prompt you typed — the fastest way to tell two similar titles apart.
- **Everything is reachable while browsing.** Sort, filter by tag, narrow to one
  directory, show expired sessions, tag, untag, archive, derive: all of it is a
  keypress inside the picker rather than a flag you have to know before you
  start. The flags remain, for scripts.
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

If you cannot reach the npm registry, every
[release](https://github.com/soohunee/claude-session-manager/releases) carries
two downloads. `claude-sessions-cli-<version>.tgz` installs with
`npm i -g ./claude-sessions-cli-<version>.tgz`, and `csm-<version>.tar.gz` needs
no npm at all:

```bash
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf csm-<version>.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/csm-<version>/bin/csm.js ~/.local/bin/csm
csm init
```

There are no dependencies and no build step, so the files are the whole install.
Leave the extracted directory where it is: `csm init` records its absolute path
in the hooks, and re-run `csm init` after upgrading this way.

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
| `csm derive [id\|query]` | Start a fresh session carrying a handoff from this one |
| `csm tree [query]` | Show sessions as the tree of what was derived from what |
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
| `-a, --all` | Everything csm knows of, expired and unnamed included |
| `--unnamed` | Include sessions Claude Code never named (slash commands) |
| `-s, --sort <time\|title\|dir>` | Order sessions (default: `time`) |
| `-p, --preview` | Open the picker with the preview panel already on |
| `--remote` | Resume with Remote Control, to continue on mobile |
| `--fork` | Resume into a new session id, leaving the original untouched |
| `--print-cmd` | Print the resume command instead of running it |
| `--json` | Machine-readable output |
| `--session <id>` | Target this session id, matched on an id prefix |
| `--fast` | With `derive`: build the handoff without asking a model |
| `-y, --yes` | With `derive`: do not ask before spending on the model |
| `--note <text>` | With `derive`: extra instructions for the new session |
| `--model <name>` | Model to write the handoff with (default: your usual one) |
| `--no-archive` | With `tag`: record the tag but do not archive |
| `--refresh` | Ignore the metadata cache and re-read every file |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Keys in the picker

The picker lists these on screen, so this table is a reference rather than
something to learn. Keys that do not apply to the highlighted session are shown
dim, and <kbd>?</kbd> explains every one of them in a sentence.

| Key | Action |
| --- | --- |
| <kbd>Enter</kbd> | Resume the selected session |
| <kbd>f</kbd> | Resume a copy: branch under a new id, leaving this one as it is |
| <kbd>r</kbd> | Resume with Remote Control, to carry on from your phone |
| <kbd>y</kbd> | Print the resume command and exit |
| <kbd>n</kbd> | Derive a fresh session carrying a handoff from this one |
| <kbd>d</kbd> | Remove its tags, and its archive with them (asks first) |
| <kbd>a</kbd> | Archive it now |
| <kbd>/</kbd> | Filter; <kbd>Enter</kbd> keeps the filter, <kbd>Esc</kbd> clears it |
| <kbd>s</kbd> | Cycle the sort: time, title, directory |
| <kbd>t</kbd> | Cycle the tag filter: off, any tag, then each tag in turn |
| <kbd>.</kbd> | Show expired sessions |
| <kbd>,</kbd> | Show unnamed sessions — what running a slash command left behind |
| <kbd>c</kbd> | Narrow to the selected session's directory |
| <kbd>g</kbd> | Nest derived sessions under the ones they came from |
| <kbd>u</kbd> | Go to the parent of the selected session |
| <kbd>p</kbd> | Toggle the preview panel |
| <kbd>j</kbd> <kbd>k</kbd> / <kbd>↑</kbd> <kbd>↓</kbd> | Move the selection |
| <kbd>Ctrl</kbd>+<kbd>d</kbd> <kbd>Ctrl</kbd>+<kbd>u</kbd> | Half a page down / up |
| <kbd>G</kbd> / <kbd>Home</kbd> <kbd>End</kbd> | Jump to the end or the start |
| <kbd>?</kbd> | Show every key |
| <kbd>Esc</kbd> <kbd>q</kbd> | Quit |

Anything that removes something or spends money asks in a dialog over the list,
with the session still in view. Pick a button with <kbd>←</kbd> <kbd>→</kbd> and
run it with <kbd>Enter</kbd>; <kbd>Esc</kbd> backs out. The safe button starts
selected, so the reflex to hit <kbd>Enter</kbd> is never the one that deletes an
archive or starts a billed call.

Letters act on the session under the cursor, which is why filtering lives behind
<kbd>/</kbd>. An unrecognised key does nothing rather than falling through to the
filter: a <kbd>d</kbd> that sometimes untagged and sometimes searched would be
worse than either rule on its own.

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

### Continuing a session that filled up

When a conversation runs out of room, the usual move is to ask it for a summary,
open a new session, and paste in the path to that summary. `csm derive` does the
whole thing:

```bash
csm derive                    # from the session running in this directory
csm derive 557dac2e           # or any session, matched on an id prefix
csm derive --fast             # skip the model, build the handoff from the transcript
csm derive --note "Start with the failing test."
```

Writing the handoff replays the whole parent conversation through the model in
one API call, billed to your Claude account, so `derive` says what it is about
to spend on and asks first. From the picker, <kbd>n</kbd> asks in a box over the
list and waits there too — only the handover to Claude Code itself takes the
screen, the same way k9s keeps its own UI until you shell into something. `--yes` skips the question. While it runs it reports
which phase it is in — reading the conversation, the model reading it, writing
the handoff — because loading a multi-megabyte transcript happens before the
model is reached, and a silent run looks the same whether it is working or hung.

It forks the parent to write the handoff, so the parent transcript is left
exactly as it was — the summary request never becomes part of the conversation
you are trying to preserve. The handoff lands in `~/.claude/csm/handoff/`, the
parent is archived so it outlives Claude Code's cleanup, and the new session
opens already pointed at the document.

Either way, shapes that are always a secret — npm tokens, GitHub and Anthropic
keys, AWS access keys, private keys, JWTs — are cut out on the way into the
handoff. A transcript records verbatim whatever was pasted into the
conversation, and a handoff would put that in a second file and then into a
fresh session's context. It is a net rather than a guarantee, and it does not
touch the transcript itself, which is Claude Code's own file.

`--fast` skips the model entirely and assembles the handoff from the transcript:
what was asked, which files were touched, which commands ran. It is instant and
free, but it records what happened rather than why. csm also falls back to it on
its own if the parent's context is too full for a summary to come back.

Because the link between the two is written down, the chain stays visible:

```
$ csm tree
A 557dac2e 3h ago   412  Billing auth refactor            ~/work/api  #billing
  0ddad746 1h ago   180  └ ↑ Billing auth refactor        ~/work/api
    9c1f22ae 4m ago  22  ​  └ ↑ Billing auth refactor      ~/work/api
```

A derived session whose parent is filtered out of the view is listed at the top
level rather than hidden, and `csm untag` and `csm prune` leave the archive of
any session a tree hangs off alone — dropping it would strand the branches under
a root that no longer exists.

### What the list leaves out

Two kinds of session are hidden until you ask for them, and the header says how
many of each.

Sessions whose transcript Claude Code has already deleted are listed only with
<kbd>.</kbd> or `-a`; nothing is left to restore, so they are there to show you
what was lost rather than to resume.

Sessions Claude Code never named are hidden by <kbd>,</kbd>. It writes an
`ai-title` once a session has a conversation in it, so the unnamed ones are what
`/plugins`, `/login` or a stray keystroke left behind. This is Claude Code's own
judgement rather than a threshold csm invented, and it separates cleanly: across
94 sessions here, the named ones had a median of 198 messages and the unnamed a
median of 2, with no named session under 7.

Two things are never treated as unnamed: a session from the last hour, which has
not been titled *yet* rather than never, and one csm derived from another, which
carries csm's own label and a recorded parent.

## How it works

Everything comes from files Claude Code already writes:

| Source | What csm reads from it |
| --- | --- |
| `~/.claude/projects/<dir>/<session>.jsonl` | Title, working directory, git branch, message count, timestamps |
| `~/.claude/history.jsonl` | The global, cross-directory list of session ids |
| `~/.claude/csm/` | Tags, session lineage, handoff documents, archived transcripts, metadata cache — everything csm owns |

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
- Session lineage is csm's own record, kept in `~/.claude/csm/links.json`.
  Claude Code stores nothing we could use instead: forking rewrites every record
  in the copied transcript with the new session id, so a derived session carries
  no trace of where it came from. The link exists only because csm writes it
  down, and it is kept apart from tags so that untagging a session cannot take
  the tree with it.
- `csm derive` without `--fast` makes one API call that re-reads the whole parent
  conversation, so deriving from a very large session is not free. The cost is
  printed when the handoff is written.
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
