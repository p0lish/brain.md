#!/usr/bin/env node
// Run: node --test test/   (or: npm test)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cortex = require(path.join(ROOT, 'scripts', 'cortex-review.js'));
const dreamMod = require(path.join(ROOT, 'scripts', 'dream.js'));
const install = require(path.join(ROOT, 'scripts', 'install.js'));
const { outcome } = require(path.join(ROOT, 'scripts', 'hooks', 'post-tool-use.js'));
const { classify } = require(path.join(ROOT, 'scripts', 'hooks', 'user-prompt.js'));

const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brainmd-'));
function brain() {
  const project = tmp();
  install.initBrain(project, false);
  return { project, P: cortex.paths(path.join(project, '.brain')) };
}
const silent = fn => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };

// --- cortex -----------------------------------------------------------------
test('reinforcement only happens on new evidence', () => {
  const { P } = brain();
  for (let i = 0; i < 4; i++) cortex.record(P, 'habit:a', true, 'x', { source: 'external' });
  const m1 = cortex.review(P);
  assert.equal(m1.filter(m => m.target === 'habit:a')[0].type, 'strengthen');
  const w = cortex.loadWeights(P).pathways['habit:a'].weight;
  assert.equal(cortex.review(P).filter(m => m.target === 'habit:a').length, 0, 'second review with no new evidence must not move the weight');
  assert.equal(cortex.loadWeights(P).pathways['habit:a'].weight, w);
});

test('failures weaken, external evidence outweighs self-grading', () => {
  const { P } = brain();
  for (let i = 0; i < 4; i++) cortex.record(P, 'habit:self', true, '', { source: 'self' });
  for (let i = 0; i < 4; i++) cortex.record(P, 'habit:ext', true, '', { source: 'external' });
  for (let i = 0; i < 4; i++) cortex.record(P, 'habit:bad', false, '', { source: 'external' });
  cortex.review(P);
  const pw = cortex.loadWeights(P).pathways;
  assert.ok(pw['habit:ext'].weight > pw['habit:self'].weight);
  assert.ok(pw['habit:bad'].weight < cortex.T.newPathwayWeight);
});

test('decay is per day of disuse, not per review run', () => {
  const { P } = brain();
  cortex.record(P, 'habit:old', true);
  const now = Date.now() + 10 * DAY;
  cortex.review(P, now);
  const w1 = cortex.loadWeights(P).pathways['habit:old'].weight;
  assert.ok(Math.abs(w1 - (0.30 - 3 * 0.02)) < 1e-9, `3 days past onset → -0.06 (got ${w1})`);
  cortex.review(P, now + 1000);
  cortex.review(P, now + 2000);
  assert.equal(cortex.loadWeights(P).pathways['habit:old'].weight, w1, 'repeated reviews on the same day do not decay again');
  cortex.review(P, now + DAY);
  assert.ok(Math.abs(cortex.loadWeights(P).pathways['habit:old'].weight - (w1 - 0.02)) < 1e-9);
});

test('floors hold and pruned pathways are archived, not lost', () => {
  const { P } = brain();
  for (let i = 0; i < 6; i++) cortex.record(P, 'instinct:safe', false, '', { source: 'external' });
  cortex.record(P, 'habit:dying', true);
  const later = Date.now() + 40 * DAY;
  cortex.review(P, later);
  const pw = cortex.loadWeights(P).pathways;
  assert.ok(pw['instinct:safe'].weight >= 0.8);
  assert.equal(pw['habit:dying'], undefined);
  assert.ok(cortex.readJson(P.pruned, {}).pathways['habit:dying']);
  const log = fs.readdirSync(P.mutations).filter(f => f.endsWith('.jsonl'))
    .flatMap(f => fs.readFileSync(path.join(P.mutations, f), 'utf8').trim().split('\n')).map(JSON.parse);
  assert.ok(log.some(m => m.type === 'prune' && m.target === 'habit:dying'));
});

test('v0.1 pathways migrate without losing history', () => {
  const { P } = brain();
  cortex.writeJsonAtomic(P.weights, { version: 7, pathways: { 'habit:legacy': { weight: 0.95, fires: 13, successes: 11, lastFired: new Date().toISOString() } } });
  const p = cortex.loadWeights(P).pathways['habit:legacy'];
  assert.equal(p.failures, 2);
  assert.equal(p.evidence.s, 11 * cortex.T.selfWeight);
  assert.equal(cortex.review(P).length, 0, 'migration alone is not new evidence');
});

test('per-context stats and promotion', () => {
  const { P } = brain();
  for (let i = 0; i < 10; i++) cortex.record(P, 'habit:concise', true, 'Short answers', { source: 'external', ctx: 'quick-question' });
  for (let i = 0; i < 3; i++) cortex.record(P, 'habit:concise', false, '', { source: 'external', ctx: 'design-review' });
  const d = cortex.describe('habit:concise', cortex.loadWeights(P).pathways['habit:concise']);
  assert.ok(d.contexts['quick-question'].mean > 0.85 && d.contexts['design-review'].mean < 0.3);
  for (let i = 0; i < 15; i++) cortex.record(P, 'habit:tests-first', true, 'Run tests before claiming done', { source: 'external' });
  for (let i = 0; i < 12; i++) cortex.review(P);
  for (let r = 0; r < 12; r++) { cortex.record(P, 'habit:tests-first', true, '', { source: 'external' }); cortex.review(P); }
  assert.ok(cortex.promoteCandidates(P).some(c => c.id === 'habit:tests-first'));
});

// --- dream ------------------------------------------------------------------
function dreamFixture() {
  const { project, P } = brain();
  const memDir = path.join(P.root, 'memory');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(memDir, `${today}.md`), [
    '## Lessons learned', '- Always run the migration dry-run before applying it to staging', '- **Important:** the CI cache key includes the lockfile hash',
    '## Misc', '- Had coffee and thought about the refactor for a while today', '- ' + 'Long rambling notes about nothing in particular. '.repeat(5), '',
    '## Chatter', '- Short low-signal line that should not be consolidated', '',
  ].join('\n'));
  return { project, P, cfg: dreamMod.config(['--brain', P.root]), memDir };
}

test('dream consolidates, ranks by score and does not duplicate on re-run', () => {
  const { P, cfg } = dreamFixture();
  silent(() => dreamMod.dream(cfg));
  silent(() => dreamMod.dream({ ...cfg, force: true }));
  silent(() => dreamMod.dream({ ...cfg, force: true }));
  const mem = fs.readFileSync(path.join(P.root, 'MEMORY.md'), 'utf8');
  assert.equal(mem.split('migration dry-run').length - 1, 1, 'fact appears exactly once');
  assert.ok(mem.includes('Had coffee'), 'long sections count as signal');
  assert.ok(mem.indexOf('CI cache key') < mem.indexOf('migration dry-run'), 'marked fact outranks plain one');
  assert.ok(mem.indexOf('migration dry-run') < mem.indexOf('Had coffee'), 'signal section outranks long noise');
  assert.ok(!mem.includes('Short low-signal line'), 'short unmarked sections are skipped');
  assert.ok(mem.includes('Long-term memory for this project'), 'hand-written header kept');
  assert.equal(mem.split('brainmd:rules:start').length - 1, 1, 'one rules block');
});

test('--days accepts both "--days 3" and "--days=3"', () => {
  assert.equal(dreamMod.config(['--days', '3']).days, 3);
  assert.equal(dreamMod.config(['--days=4']).days, 4);
  assert.equal(dreamMod.config([]).days, 7);
});

test('relative dates resolve against the log date', () => {
  assert.equal(dreamMod.resolveRelativeDates('fixed it yesterday', '2026-03-10'), 'fixed it 2026-03-09');
});

test('over the cap, old sections move to the archive', () => {
  const head = '# MEMORY\nheader';
  const sec = d => `## Memory Consolidation — ${d}\n` + Array.from({ length: 120 }, (_, i) => `- fact ${d} ${i}`).join('\n');
  const { memory, evicted } = dreamMod.pruneMemory([head, sec('2026-01-01'), sec('2026-01-02'), sec('2026-01-03')].join('\n'), 300);
  assert.equal(evicted.length, 1);
  assert.ok(evicted[0][0].includes('2026-01-01'));
  assert.ok(memory.startsWith('# MEMORY') && memory.includes('2026-01-03'));
});

// --- hooks ------------------------------------------------------------------
function hook(name, input, env = {}) {
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'hooks', name)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('test-output parsing', () => {
  assert.equal(outcome({ stdout: '=== 3 failed, 10 passed in 2.1s ===' }), false);
  assert.equal(outcome({ stdout: '=== 12 passed in 2.1s ===' }), true);
  assert.equal(outcome({ stdout: 'Tests: 0 failed, 40 passed' }), true);
  assert.equal(outcome({ exit_code: 1, stdout: '12 passed' }), false, 'exit code wins when present');
  assert.equal(outcome({ stdout: 'hello' }), undefined);
  assert.equal(outcome({ interrupted: true, stdout: '1 failed' }), undefined);
});

test('user feedback classification is conservative', () => {
  assert.equal(classify("no, that's not what I asked"), false);
  assert.equal(classify('I told you to use pnpm'), false);
  assert.equal(classify('perfect, thanks'), true);
  assert.equal(classify('ok it works now!'), true);
  assert.equal(classify('add a login page with no external deps'), undefined);
  assert.equal(classify('can you write tests for the parser'), undefined);
});

test('hooks: signals flow from tool use and prompts into a one-time Stop nudge', () => {
  const { project, P } = brain();
  const env = { CLAUDE_PROJECT_DIR: project };
  const ctx = JSON.parse(hook('session-start.js', { source: 'startup' }, env));
  assert.equal(ctx.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx.hookSpecificOutput.additionalContext, /instinct:confirm-destructive-actions/);

  assert.equal(hook('post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'pytest -q' }, tool_response: { stdout: '2 failed, 5 passed' } }, env), '');
  hook('post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: { stdout: '1 failed' } }, env);
  hook('user-prompt.js', { prompt: 'no, you forgot the migration' }, env);
  const pending = cortex.pendingSignals(P);
  assert.equal(pending.length, 2, 'pytest failure + correction; ls ignored');

  const stop1 = JSON.parse(hook('stop.js', { stop_hook_active: false }, env));
  assert.equal(stop1.decision, 'block');
  assert.match(stop1.reason, /pytest -q/);
  assert.equal(hook('stop.js', { stop_hook_active: false }, env), '', 'same signals never nudge twice');

  hook('post-tool-use.js', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '3 failing' } }, env);
  assert.equal(hook('stop.js', { stop_hook_active: true }, env), '', 'never blocks while stop_hook_active');

  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'cortex-review.js'), 'record', 'habit:run-migrations', 'false', 'forgot migration', '--source', 'external', '--signals', 'all', '--brain', P.root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cortex.pendingSignals(P).length, 0);
  assert.equal(cortex.loadWeights(P).pathways['habit:run-migrations'].lastOutcome.source, 'external');
  assert.equal(cortex.loadWeights(P).pathways['habit:run-migrations'].lastOutcome.notes, 'forgot migration', '--signals value is not swallowed into notes');
});

test('hooks are silent no-ops in projects without a brain', () => {
  const env = { CLAUDE_PROJECT_DIR: tmp() };
  assert.equal(hook('session-start.js', { source: 'startup' }, env), '');
  assert.equal(hook('stop.js', {}, env), '');
});

test('session start sleeps when due and consolidates memory', () => {
  const { project, P } = dreamFixture();
  const out = JSON.parse(hook('session-start.js', { source: 'startup' }, { CLAUDE_PROJECT_DIR: project }));
  assert.match(out.hookSpecificOutput.additionalContext, /sleep cycle ran.*1|sleep cycle ran/);
  assert.ok(fs.readFileSync(path.join(P.root, 'MEMORY.md'), 'utf8').includes('migration dry-run'));
  const again = JSON.parse(hook('session-start.js', { source: 'startup' }, { CLAUDE_PROJECT_DIR: project }));
  assert.doesNotMatch(again.hookSpecificOutput.additionalContext, /sleep cycle ran/, 'not due again');
});

// --- install ----------------------------------------------------------------
test('install merges idempotently and uninstall leaves other hooks alone', () => {
  const project = tmp();
  const settingsFile = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const mine = { permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(mine));
  const run = (...a) => spawnSync('node', [path.join(ROOT, 'scripts', 'install.js'), '--project', project, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run('--claude-md').status, 0);
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(s.permissions, mine.permissions);
  assert.equal(s.hooks.Stop.length, 2, 'ours once + theirs');
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Bash');
  assert.ok(fs.existsSync(path.join(project, '.brain', 'weights', 'pathways.json')));
  assert.match(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'), /@\.brain\/MEMORY\.md/);
  assert.equal(run('--uninstall').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks, mine.hooks);
});
