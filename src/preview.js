import fs from 'node:fs';
import { textOf } from './scan.js';

/** Parse one tail window into readable turns, oldest first. */
function turnsIn(fd, size, bytes) {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  let text = buf.toString('utf8');
  if (start > 0) {
    // The seek lands mid-record almost every time; drop the partial line.
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }

  const out = [];
  for (const line of text.split('\n')) {
    if (line.length < 2) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain || d.isMeta) continue;
    const role = d.type === 'user' ? 'user' : d.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    // Tool results arrive as user records whose content holds only
    // `tool_result` blocks, so textOf yields nothing and they drop out here.
    // Claude Code's own command envelopes are wrapped in angle brackets.
    const body = textOf(d.message).replace(/\s+/g, ' ').trim();
    if (!body || body.startsWith('<')) continue;
    out.push({ role, text: body });
  }
  return out;
}

/**
 * Read the tail of a transcript as a handful of readable turns.
 *
 * Transcripts reach several megabytes and the picker re-reads one on every
 * cursor move, so we seek rather than load the whole file. In an agentic
 * session a single exchange can span tens of KB of tool traffic, which means a
 * small window often holds no user prompt at all — and the prompt is the part
 * that actually identifies a conversation. So the window grows until a couple
 * of user turns are in view, and the returned slice is shifted back far enough
 * to include the most recent one.
 */
export function tailMessages(file, { limit = 6, bytes = 96 * 1024, minUser = 2, maxBytes = 4 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    let window = bytes;
    let turns = [];
    for (;;) {
      turns = turnsIn(fd, size, window);
      const users = turns.filter((t) => t.role === 'user').length;
      if (users >= minUser || window >= size || window >= maxBytes) break;
      window *= 4;
    }

    const lastUser = turns.findLastIndex((t) => t.role === 'user');
    const tailStart = turns.length - limit;
    const start = Math.max(0, lastUser === -1 ? tailStart : Math.min(lastUser, tailStart));
    return turns.slice(start, start + limit);
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}
