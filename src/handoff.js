import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { textOf } from './scan.js';
import { handoffDir, projectsDir, encodeProjectPath } from './paths.js';

/**
 * The instruction sent to the forked parent session.
 *
 * It has to be explicit that the reader shares none of the context, because the
 * model writing the summary still has all of it and will otherwise leave out
 * exactly the background that made the conversation make sense.
 */
const SUMMARY_PROMPT = `Write a handoff document, in Markdown, for a fresh session that will continue this work with none of this conversation in its context.

Cover, in this order:
1. The goal — what this work is trying to achieve.
2. Decisions made and the reasoning behind them, including options that were considered and rejected.
3. What is already done, with the concrete files and identifiers involved.
4. What is left to do, in the order it should be tackled.
5. Constraints, gotchas, and anything that was expensive to discover.

Be specific: name real file paths, functions, commands and values rather than describing them. Assume the reader is competent but knows nothing about this particular conversation.

Output only the document. Do not greet, do not ask questions, do not offer to continue.`;

/** Pull the pieces of a transcript that describe what happened in it. */
function digest(file) {
  const out = { prompts: [], tools: new Map(), files: new Map(), commands: [], turns: 0 };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (line.length < 2) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    if (d.type === 'user' && !d.isMeta) {
      const text = textOf(d.message).trim();
      if (text && !text.startsWith('<')) {
        out.prompts.push(text.replace(/\s+/g, ' ').slice(0, 500));
        out.turns++;
      }
    }
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      out.tools.set(b.name, (out.tools.get(b.name) || 0) + 1);
      const fp = b.input?.file_path;
      if (fp) out.files.set(fp, (out.files.get(fp) || 0) + 1);
      if (b.name === 'Bash' && b.input?.command) {
        out.commands.push(String(b.input.command).split('\n')[0].slice(0, 120));
      }
    }
  }
  return out;
}

function bullets(items, limit) {
  const shown = items.slice(0, limit).map((t) => `- ${t}`);
  if (items.length > limit) shown.push(`- _…and ${items.length - limit} more_`);
  return shown.join('\n');
}

/**
 * Build a handoff document from the transcript alone, with no model involved.
 *
 * This is the fallback for when the parent's context is too full to summarise,
 * and the default when the caller does not want to pay for a summary. It says
 * what happened, but not why — that part only the model can supply.
 */
export function extractHandoff(session) {
  const d = session.file ? digest(session.file) : { prompts: [], tools: new Map(), files: new Map(), commands: [], turns: 0 };
  const parts = [];
  parts.push(`# Handoff — ${session.label || session.id}`);
  parts.push('');
  parts.push(
    `Derived from session \`${session.id}\`${session.cwd ? ` in \`${session.cwd}\`` : ''}` +
      `${session.gitBranch ? ` on branch \`${session.gitBranch}\`` : ''}.`
  );
  parts.push(
    `${session.messages || 0} messages` +
      (session.firstSeen ? `, from ${session.firstSeen.slice(0, 16).replace('T', ' ')}` : '') +
      (session.lastSeen ? ` to ${session.lastSeen.slice(0, 16).replace('T', ' ')}` : '') +
      '.'
  );
  parts.push('');
  parts.push(
    '> Assembled from the transcript without a model reading it, so it records what was' +
      ' asked and done, not why. Treat it as an index into the work, not as a summary of it.'
  );

  if (d.prompts.length) {
    parts.push('', '## What was asked', '', bullets(d.prompts, 40));
  }
  if (d.files.size) {
    const files = [...d.files.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `\`${f}\` (${n}×)`);
    parts.push('', '## Files touched', '', bullets(files, 30));
  }
  if (d.commands.length) {
    parts.push('', '## Commands run', '', bullets(d.commands.map((cmd) => `\`${cmd}\``), 30));
  }
  if (d.tools.size) {
    const tools = [...d.tools.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}×`);
    parts.push('', '## Tools used', '', tools.join(' · '));
  }
  return parts.join('\n') + '\n';
}

/**
 * Ask the parent session itself to write the handoff.
 *
 * The call runs against a fork, so the parent transcript is left byte for byte
 * as it was: forking gives the model the entire conversation to summarise
 * without the summary request becoming part of the conversation. The fork is a
 * throwaway, so its transcript is deleted once the answer is out.
 */
export function summarizeHandoff(session, { model = null, timeoutMs = 20 * 60 * 1000, onPhase = () => {} } = {}) {
  return new Promise((resolve) => {
    const args = ['--resume', session.id, '--fork-session', '-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    args.push(SUMMARY_PROMPT);

    const child = spawn('claude', args, { cwd: session.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let payload = null;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ ok: false, reason: `gave up after ${Math.round(timeoutMs / 60000)} minutes` });
    }, timeoutMs);

    // The stream is what makes the wait legible. Loading a multi-megabyte
    // transcript happens before the model is even reached, so without this the
    // whole call looks identical whether it is working or hung.
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        if (d.type === 'system' && d.subtype === 'init') onPhase('waiting');
        else if (d.type === 'assistant') onPhase('writing');
        else if (d.type === 'result') payload = d;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) =>
      finish({ ok: false, reason: err.code === 'ENOENT' ? 'claude is not on your PATH' : String(err.message) })
    );
    child.on('close', () => {
      // The fork exists whether or not the call succeeded, so clean it up
      // before deciding what to report.
      if (payload?.session_id) discardFork(session.cwd, payload.session_id);
      if (!payload || payload.is_error || typeof payload.result !== 'string' || !payload.result.trim()) {
        const why = payload?.result || stderr.trim().split('\n').pop() || 'the summary came back empty';
        return finish({ ok: false, reason: why.slice(0, 200) });
      }
      finish({ ok: true, text: payload.result.trim(), cost: payload.total_cost_usd ?? null });
    });
  });
}

/** Delete the transcript of a fork that only existed to answer one question. */
export function discardFork(cwd, id) {
  if (!cwd || !id) return false;
  try {
    fs.unlinkSync(path.join(projectsDir(), encodeProjectPath(cwd), id + '.jsonl'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Put one consistent header on a model-written handoff.
 *
 * The model reliably opens with an H1 of its own, which would leave the file
 * with two competing titles once the provenance header goes on. Its heading
 * says nothing ours does not, so it is dropped rather than demoted.
 */
export function frameHandoff(session, text) {
  const body = text.replace(/^\s*#\s+[^\n]*\n+/, '').trim();
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return (
    [
      `# Handoff — ${session.label || session.id}`,
      '',
      `_Written by session \`${session.id}\` in \`${session.cwd}\` on ${when}._`,
      '',
      body,
    ].join('\n') + '\n'
  );
}

export function handoffPathFor(id) {
  return path.join(handoffDir(), id + '.md');
}

export function writeHandoff(id, text) {
  const dest = handoffPathFor(id);
  fs.mkdirSync(handoffDir(), { recursive: true });
  fs.writeFileSync(dest, text.endsWith('\n') ? text : text + '\n');
  return dest;
}
