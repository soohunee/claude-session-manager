import os from 'node:os';
import path from 'node:path';

/** Root of the Claude Code config dir. Honors CLAUDE_CONFIG_DIR like the CLI does. */
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export const projectsDir = () => path.join(claudeHome(), 'projects');
export const historyFile = () => path.join(claudeHome(), 'history.jsonl');
export const settingsFile = () => path.join(claudeHome(), 'settings.json');
export const commandsDir = () => path.join(claudeHome(), 'commands');

/** Everything csm owns lives here, so uninstalling is `rm -rf`. */
export const csmHome = () => path.join(claudeHome(), 'csm');
export const tagsFile = () => path.join(csmHome(), 'tags.json');
export const archiveDir = () => path.join(csmHome(), 'archive');
export const currentDir = () => path.join(csmHome(), 'current');
export const indexFile = () => path.join(csmHome(), 'index.json');

/**
 * Claude Code names each project dir after its cwd with every non-alphanumeric
 * character replaced by a dash. The mapping is lossy, so csm only uses it to
 * *write* (restoring an archived transcript). To read a session's real cwd we
 * always take the `cwd` field recorded inside the transcript itself.
 */
export function encodeProjectPath(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
