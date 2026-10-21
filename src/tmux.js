import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeHome } from './paths.js';
import { readJson } from './store.js';

/**
 * Which sessions are open in a tmux pane right now, by session id.
 *
 * Claude Code keeps a file per running process in `~/.claude/sessions`, naming
 * the session it holds and whether it is working. The pane is found by walking
 * up from that process to a pane's shell rather than by trusting the file's own
 * `tmux` field, which some processes never write and which keeps the session
 * name from when Claude Code started, not the one it has now.
 */
export function tmuxSessions() {
  const dir = path.join(claudeHome(), 'sessions');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return new Map();
  }
  const running = files.map((f) => readJson(path.join(dir, f), null)).filter((r) => r && r.pid && r.sessionId);
  if (!running.length) return new Map();
  try {
    const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{session_name}'], quiet);
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], quiet);
    return matchPanes(running, panes, ps);
  } catch {
    // No tmux, or no server running: nothing is open in a pane.
    return new Map();
  }
}

/** The pure half of `tmuxSessions`, over the text `tmux` and `ps` print. */
export function matchPanes(running, panes, ps) {
  const byShell = new Map();
  for (const line of panes.split('\n')) {
    const [pid, pane, ...name] = line.split(' ');
    if (pane) byShell.set(Number(pid), { pane, name: name.join(' ') });
  }
  const parent = new Map();
  for (const line of ps.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    parent.set(pid, ppid);
  }
  const found = new Map();
  for (const r of running) {
    // A process that has exited is not in `ps`, so its stale file matches
    // nothing. The hop limit only guards against a cycle in bad input.
    for (let pid = r.pid, hops = 0; pid > 1 && hops < 16; pid = parent.get(pid), hops++) {
      const hit = byShell.get(pid);
      if (hit) {
        found.set(r.sessionId, { ...hit, status: r.status || null });
        break;
      }
    }
  }
  return found;
}
