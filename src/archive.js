import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, projectsDir, encodeProjectPath } from './paths.js';

export function archivePathFor(id) {
  return path.join(archiveDir(), id + '.jsonl');
}

export function isArchived(id) {
  return fs.existsSync(archivePathFor(id));
}

/**
 * Copy a live transcript into csm's archive.
 *
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by
 * default), which is what makes a months-old session unresumable. Keeping our
 * own copy is what lets `/persist` actually persist.
 */
export function archiveSession(session) {
  if (!session.file || !fs.existsSync(session.file)) return { ok: false, reason: 'no-transcript' };
  const dest = archivePathFor(session.id);
  if (path.resolve(session.file) === path.resolve(dest)) return { ok: true, skipped: 'already-archive' };
  fs.mkdirSync(archiveDir(), { recursive: true });
  const src = fs.statSync(session.file);
  if (fs.existsSync(dest)) {
    // Transcripts are append-only, so equal size means equal content. Comparing
    // mtimes instead would re-copy megabytes after every restore, which rewrites
    // the live file with a fresh timestamp.
    if (fs.statSync(dest).size === src.size) return { ok: true, skipped: 'up-to-date' };
  }
  const tmp = dest + '.tmp-' + process.pid;
  fs.copyFileSync(session.file, tmp);
  fs.renameSync(tmp, dest);
  return { ok: true, bytes: src.size };
}

/**
 * Put an archived transcript back where Claude Code expects to find it, so
 * `claude --resume` can pick it up. No-op when the live transcript still exists.
 */
export function restoreSession(session) {
  const cwd = session.cwd;
  if (!cwd) return { ok: false, reason: 'unknown-cwd' };
  const dir = path.join(projectsDir(), encodeProjectPath(cwd));
  const live = path.join(dir, session.id + '.jsonl');
  if (fs.existsSync(live)) return { ok: true, skipped: 'already-live' };
  const archived = archivePathFor(session.id);
  if (!fs.existsSync(archived)) return { ok: false, reason: 'not-archived' };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = live + '.tmp-' + process.pid;
  fs.copyFileSync(archived, tmp);
  fs.renameSync(tmp, live);
  // Deliberately not preserving the archive's mtime: the restored file needs a
  // fresh timestamp or Claude Code's cleanup sweep would delete it again.
  return { ok: true, restoredTo: live };
}

export function removeArchive(id) {
  try {
    fs.unlinkSync(archivePathFor(id));
    return true;
  } catch {
    return false;
  }
}

export function archiveStats() {
  let files = [];
  try {
    files = fs.readdirSync(archiveDir()).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { count: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(archiveDir(), f)).size;
    } catch {
      /* ignore */
    }
  }
  return { count: files.length, bytes };
}
