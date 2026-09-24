/**
 * Demo harness for the README recording.
 *
 * The picker is driven against a fixture rather than the machine it runs on,
 * so the GIF shows the same six sessions every time and no real project
 * names, paths, or conversations end up in a published image. Everything else
 * is the real thing: this imports `pick` from src and renders through it.
 *
 *   node demo/demo.mjs        # play with it by hand
 *   ./demo/record.sh          # re-record demo/demo.gif
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pick } from '../src/tui.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// Paths sit under the real home so the picker abbreviates them to ~/… exactly
// as it does for a real session. Nothing is read from or written to them.
const home = (rel) => path.join(os.homedir(), rel);
const tilde = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

/** Sessions as they would look on a machine a few weeks into a project. */
const FIXTURE = [
  {
    id: '0a1b2c3d-4e5f-6789-abcd-ef0123456789',
    label: 'Billing refactor — split invoice service',
    cwd: home('work/api'),
    gitBranch: 'main',
    tags: ['billing'],
    archived: true,
    messages: 144,
    contextTokens: 412_000,
    updatedAt: ago(2 * HOUR),
    turns: [
      ['user', 'extract the token check into middleware'],
      ['assistant', 'Moving it into `requireToken` and wiring it ahead of the billing routes.'],
      ['assistant', 'The invoice service no longer imports the auth module directly.'],
    ],
  },
  {
    id: '7c6b5a49-3827-1605-f4e3-d2c1b0a99887',
    label: 'Bump the CI matrix to Node 22',
    cwd: home('ops/ci'),
    gitBranch: 'main',
    tags: [],
    messages: 27,
    contextTokens: 58_000,
    updatedAt: ago(6 * HOUR),
    turns: [
      ['user', 'drop node 18 from the matrix and add 22'],
      ['assistant', 'Updated `.github/workflows/ci.yml`; the 22 job passes, 18 is gone.'],
    ],
  },
  {
    id: '9f8e7d6c-5b4a-3928-1716-0504f3e2d1c0',
    label: 'Terraform for the new billing queue',
    cwd: home('work/infra'),
    gitBranch: 'main',
    tags: ['billing'],
    archived: true,
    messages: 88,
    contextTokens: 96_000,
    updatedAt: ago(DAY),
    turns: [
      ['user', 'the queue needs a dead letter target before we ship'],
      ['assistant', 'Added `aws_sqs_queue.billing_dlq` and pointed the redrive policy at it after 5 receives.'],
    ],
  },
  {
    id: '3e4f5a6b-7c8d-9e0f-1a2b-3c4d5e6f7a8b',
    label: 'Invoice PDF renderer drops the tax line',
    cwd: home('work/billing-pdf'),
    gitBranch: 'fix/tax-line',
    tags: ['billing'],
    messages: 51,
    contextTokens: 120_000,
    updatedAt: ago(2 * DAY),
    turns: [
      ['user', 'the tax row is missing whenever the total is rounded down'],
      ['assistant', 'The template skipped zero-valued rows. Rounding produced 0.00 tax, so the row vanished.'],
    ],
  },
  {
    id: '1122abcd-3344-5566-7788-99aabbccddee',
    label: 'Refactor the auth middleware',
    cwd: home('work/api'),
    gitBranch: 'main',
    tags: [],
    messages: 31,
    contextTokens: 31_000,
    updatedAt: ago(4 * DAY),
    turns: [
      ['user', 'can requireToken and requireScope share a path?'],
      ['assistant', 'Yes — both resolve the bearer token first, so that half lifts into `readToken`.'],
    ],
  },
  {
    id: 'deadbeef-0000-1111-2222-333344445555',
    label: 'Refactoring notes and cleanup pass',
    cwd: home('scratch'),
    tags: [],
    messages: 459,
    contextTokens: 178_000,
    updatedAt: ago(7 * DAY),
    turns: [
      ['user', 'summarise what we changed this week'],
      ['assistant', 'Three themes: auth middleware, the billing split, and the CI matrix.'],
    ],
  },
];

/**
 * The preview panel reads the tail of a real transcript off disk, so the
 * fixture needs files to point at. They are written to a temp directory and
 * left there; nothing outside it is touched.
 */
function materialise(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-demo-'));
  return sessions.map(({ turns, ...session }) => {
    const file = path.join(dir, `${session.id}.jsonl`);
    const lines = (turns || []).map(([role, text], i) =>
      JSON.stringify({
        type: role,
        message: { role, content: text },
        cwd: session.cwd,
        timestamp: new Date(Date.parse(session.updatedAt) - (turns.length - i) * 60_000).toISOString(),
      })
    );
    fs.writeFileSync(file, lines.join('\n') + '\n');
    // `title` is what Claude Code writes once a session holds a real
    // conversation; without it the picker treats the row as unnamed and hides it.
    return { ...session, title: session.label, file, resumable: true, parent: null };
  });
}

const sessions = materialise(FIXTURE);
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// The recording opens on a bare terminal, so the harness draws the prompt the
// real command would have been typed at before handing over to the picker.
if (process.env.CSM_DEMO_PROMPT) {
  process.stdout.write('$ csm\n');
  await new Promise((r) => setTimeout(r, 1200));
}

const chosen = await pick(sessions, {
  version,
  subtitle: '54 expired',
  sort: 'time',
  actions: {
    reload: () => sessions,
    untag: (s) => `untagged ${s.id.slice(0, 8)} · archive removed`,
    archive: () => 'archived 1.2MB',
  },
});

// The real CLI hands the terminal to `claude` here. The demo prints the
// command instead, which is what actually needs to be legible in a GIF.
if (chosen) {
  const { session, action } = chosen;
  const flag = action === 'fork' ? ' --fork' : action === 'remote' ? ' --remote' : '';
  process.stdout.write(`\n  ${tilde(session.cwd)}\n  $ claude --resume ${session.id}${flag}\n\n`);
}
