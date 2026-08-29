# claude-session-manager

**Find and resume any Claude Code session, from any directory.**

`claude --resume` only shows you sessions from the directory you happen to be
standing in. But work doesn't stay in one directory. You start something in
`~/work/api`, follow it into `~/work/infra`, and a week later you can't remember
where you were when you had that conversation — so you can't resume it.

`csm` indexes every Claude Code session on your machine, no matter which
directory it came from, and resumes the one you pick.

```
$ csm

Claude sessions  80 sessions · 27 resumable · 53 expired
search> refactor
────────────────────────────────────────────────────────────────────────────
> 2h ago   144  Billing refactor — split invoice svc   ~/work/api      #billing
  1d ago    88  Terraform for the new billing queue    ~/work/infra    #billing
  4d ago    31  Refactor the auth middleware           ~/work/api
  1w ago   459  Refactoring notes and cleanup pass     ~/scratch
────────────────────────────────────────────────────────────────────────────
↑↓/^n^p move · enter resume · ^u clear · esc quit   [1/4]
```

Hit enter and you're back in that conversation, in the right directory.

## The other half: your sessions are being deleted

Claude Code removes transcripts older than `cleanupPeriodDays` — **30 days by
default**. Run `csm doctor` and you will probably find a number like this:

```
  sessions        80 across 4 directories
  resumable       27
  expired         53  (transcript deleted by Claude Code cleanup)
```

53 of those conversations are listed only because Claude Code's global prompt
history still mentions them. The transcripts are gone; they can never be resumed.

So `csm` doesn't just tag sessions — it **archives** them. Tag a session and its
transcript is copied somewhere Claude Code's cleanup will not touch. Months
later, `csm` restores it in place and resumes it as if nothing happened.

## Install

```bash
npm install -g claude-session-manager
csm init
```

`csm init` installs a `/persist` slash command and two hooks (`SessionStart`,
`UserPromptSubmit`) that record which session is live in which directory. It
merges into your existing `settings.json` and backs it up first. `csm uninstall`
reverses it.

Or run it without installing:

```bash
npx claude-session-manager
```

## Usage

```
csm                     Interactive picker over every session
csm ls [query]          Print sessions instead of opening the picker
csm resume <id|query>   Resume directly, skipping the picker
csm tag <tag...>        Tag the session in this directory and archive it
csm untag <tag...>      Remove tags (omit tags to clear the session)
csm tags                List every tag with its session count
csm archive             Archive all tagged sessions now
csm prune               Delete archives of sessions that are no longer tagged
csm doctor              Show what csm sees and whether it is wired up
```

Useful flags: `-t/--tag` to filter by tag, `-d/--dir` to scope to a directory,
`-n/--limit`, `-a/--all` to include expired sessions, `--json` for scripting.
Anything after `--` is passed straight to `claude`:

```bash
csm resume billing -- --model opus
```

### Tagging from inside Claude Code

When a conversation turns into something you'll want back, tag it without
leaving the session:

```
/persist billing-refactor
```

Then, from anywhere:

```bash
csm -t billing-refactor
```

Tags are just labels — a session can carry several, and they work in any
language (`/persist 입시` is fine).

## How it works

Everything comes from files Claude Code already writes:

| Source | What csm takes from it |
| --- | --- |
| `~/.claude/projects/<dir>/<session>.jsonl` | Title, cwd, git branch, message count, timestamps |
| `~/.claude/history.jsonl` | The global, cross-directory list of session ids |
| `~/.claude/csm/` | Tags, archived transcripts, metadata cache — everything csm owns |

Claude Code already writes an `ai-title` record into each transcript, so the
titles in the picker are its own, not something csm generates. No API calls, no
network, no dependencies. Session metadata is cached by mtime and size, so
repeat runs read almost nothing.

Uninstalling is `csm uninstall` plus `rm -rf ~/.claude/csm`. Nothing else on
disk is modified — `csm` never writes to Claude Code's own transcripts.

## Notes and limits

- Resuming runs `claude --resume <id>` with the session's original working
  directory. If that directory has been deleted or moved, csm tells you instead
  of guessing.
- Sessions marked `x` in `csm ls -a` are known only from prompt history. There
  is nothing left to restore; they are shown so you can see what was lost.
- If `csm tag` reports "matched by recency", the hooks aren't installed yet —
  run `csm init`. Without them csm falls back to the most recently written
  transcript in the current directory, which is right almost always but not
  guaranteed when two sessions share a directory.
- `CLAUDE_CONFIG_DIR` is honored, same as the Claude Code CLI.

## Development

```bash
npm test          # node:test, no dependencies
node bin/csm.js --help
```

## License

MIT
