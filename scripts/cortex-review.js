#!/usr/bin/env node
/**
 * brainmd cortex — the self-review engine.
 *
 * Commands:
 *   record <id> <true|false> [notes...] [--source self|external] [--ctx <context>] [--signals]
 *   review                  run one review cycle (evidence-gated reinforcement, decay, prune)
 *   status [--compact] [--json] [--min <w>] [--top <n>]
 *   get <id> [--ctx <context>]   one pathway (with per-context stats) as JSON
 *   promote                 pathways stable enough to become plain written rules (JSON)
 *   prune                   remove dead pathways now (archived, not lost)
 *   signals                 list pending external signals (from hooks)
 *   ack [all|<signal-id>]   mark pending signals as handled without recording
 *   where                   print the resolved brain directory
 *
 * Brain location (first match wins):
 *   --brain <dir>  >  $BRAIN_ROOT  >  parent of this script if it holds weights/
 *   (legacy init-brain.sh layout)  >  $CLAUDE_PROJECT_DIR/.brain  >  ./.brain
 */

'use strict';

const fs = require('fs');
const path = require('path');

// === Tunables ==============================================================
const T = {
  newPathwayWeight: 0.30,
  maxWeight: 0.95,
  minWeight: 0.05,          // at or below this a pathway is pruned (unless floored)
  instinctFloor: 0.80,
  reflexFloor: 0.20,
  skillFloor: 0.10,
  // Weight moves toward the evidence (posterior mean) only when there is NEW
  // evidence since the last review. Step size grows with the amount of new
  // evidence: rate = n_new / (n_new + learnK).
  learnK: 3,
  minEvidence: 2,           // effective outcomes needed before weight moves at all
  // A self-graded outcome counts for less than one coming from an external
  // signal (tests, user reaction). Agents are biased toward grading themselves well.
  selfWeight: 0.5,
  externalWeight: 1.0,
  // Decay is per day of disuse, not per review run.
  decayOnsetDays: 7,
  decayPerDay: 0.02,
  // Promotion to a written rule.
  promoteMinWeight: 0.85,
  promoteMinEvidence: 8,
  promoteMinMean: 0.85,
};

// === Brain location ========================================================
function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i !== -1 && i + 1 < args.length) return args[i + 1];
  const eq = args.find(a => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function resolveBrainRoot(args = process.argv.slice(2)) {
  const explicit = argValue(args, '--brain');
  if (explicit) return path.resolve(explicit);
  if (process.env.BRAIN_ROOT) return path.resolve(process.env.BRAIN_ROOT);
  const legacy = path.join(__dirname, '..');
  if (fs.existsSync(path.join(legacy, 'weights', 'pathways.json'))) return legacy;
  const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(base, '.brain');
}

function paths(root) {
  return {
    root,
    weights: path.join(root, 'weights', 'pathways.json'),
    pruned: path.join(root, 'weights', 'pruned.json'),
    mutations: path.join(root, 'mutations'),
    signals: path.join(root, 'signals', 'pending.jsonl'),
    signalsDone: path.join(root, 'signals', 'handled.jsonl'),
    lock: path.join(root, '.lock'),
  };
}

// === File helpers ==========================================================
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic write: hooks can fire concurrently, a half-written pathways.json would
// wipe the brain.
function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Simple cross-process lock (O_EXCL), with stale-lock recovery.
function withLock(P, fn) {
  ensureDir(P.root);
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(P.lock, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(P.lock).mtimeMs > 10000) { fs.unlinkSync(P.lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`brainmd: lock busy (${P.lock})`);
      sleepMs(50);
    }
  }
  try { return fn(); } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(P.lock); } catch {}
  }
}

// === State =================================================================
function loadWeights(P) {
  const data = readJson(P.weights, null) || { version: 1, created: new Date().toISOString(), pathways: {} };
  data.pathways = data.pathways || {};
  for (const p of Object.values(data.pathways)) migrate(p);
  return data;
}

// Bring v0.1 pathways up to the v0.2 shape without losing their history.
function migrate(p) {
  p.fires = p.fires || 0;
  p.successes = p.successes || 0;
  p.failures = p.failures ?? (p.fires - p.successes);
  if (!p.evidence) {
    // Legacy outcomes have unknown provenance: treat them as self-graded.
    p.evidence = { s: p.successes * T.selfWeight, f: p.failures * T.selfWeight };
  }
  if (!p.reviewed) p.reviewed = { s: p.evidence.s, f: p.evidence.f };
  p.contexts = p.contexts || {};
  if (typeof p.weight !== 'number') p.weight = T.newPathwayWeight;
  return p;
}

function saveWeights(P, data) {
  data.version = (data.version || 0) + 1;
  data.schema = 2;
  writeJsonAtomic(P.weights, data);
}

// Append-only daily JSONL: no filename collisions, nothing rewritten.
function logMutation(P, mutation) {
  ensureDir(P.mutations);
  const ts = new Date().toISOString();
  const file = path.join(P.mutations, `${ts.slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ ...mutation, timestamp: ts }) + '\n');
}

// === Evidence model ========================================================
// Beta(1 + s, 1 + f) over weighted successes / failures.
function posterior(e) {
  const a = 1 + e.s, b = 1 + e.f;
  const n = e.s + e.f;
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { mean, n, sd };
}

function floorFor(id, p) {
  if (typeof p.floor === 'number') return p.floor;
  if (id.startsWith('instinct:')) return T.instinctFloor;
  if (id.startsWith('reflex:')) return T.reflexFloor;
  if (id.startsWith('skill:')) return T.skillFloor;
  return 0;
}

const round = x => Math.round(x * 1000) / 1000;

// === Commands ==============================================================
function record(P, id, success, notes = '', opts = {}) {
  if (!id || !/^[\w.-]+:[\w./@-]+$/.test(id)) {
    throw new Error(`brainmd: pathway id must look like "habit:check-files-first" (got "${id}")`);
  }
  const source = opts.source === 'external' ? 'external' : 'self';
  const w = source === 'external' ? T.externalWeight : T.selfWeight;
  return withLock(P, () => {
    const data = loadWeights(P);
    const now = new Date().toISOString();
    let created = false;
    if (!data.pathways[id]) {
      data.pathways[id] = migrate({
        weight: id.startsWith('instinct:') ? Math.max(0.85, T.instinctFloor) : T.newPathwayWeight,
        created: now,
        notes,
      });
      created = true;
    }
    const p = data.pathways[id];
    p.fires++;
    if (success) { p.successes++; p.evidence.s += w; } else { p.failures++; p.evidence.f += w; }
    p.lastFired = now;
    p.lastOutcome = { ok: !!success, source, notes, at: now };
    if (notes && created) p.notes = notes;
    if (opts.ctx) {
      const c = p.contexts[opts.ctx] = p.contexts[opts.ctx] || { s: 0, f: 0, fires: 0 };
      c.fires++;
      if (success) c.s += w; else c.f += w;
    }
    saveWeights(P, data);
    if (created) logMutation(P, { type: 'neurogenesis', target: id, to: p.weight, reason: notes || 'new pathway' });
    logMutation(P, { type: 'outcome', target: id, ok: !!success, source, ctx: opts.ctx, reason: notes });
    if (opts.consumeSignals) consumeSignals(P, opts.consumeSignals, `recorded as ${id}`);
    return { id, created, pathway: p };
  });
}

function review(P, now = Date.now()) {
  return withLock(P, () => {
    const data = loadWeights(P);
    const mutations = [];
    const prunedArchive = readJson(P.pruned, { pathways: {} });

    for (const [id, p] of Object.entries(data.pathways)) {
      const floor = floorFor(id, p);
      const newS = p.evidence.s - p.reviewed.s;
      const newF = p.evidence.f - p.reviewed.f;
      const nNew = newS + newF;
      const post = posterior(p.evidence);

      // 1. Reinforcement — only on evidence that arrived since the last review.
      //    (v0.1 re-applied +0.05 on every run, so a pathway with 3 lucky
      //    outcomes kept climbing forever without any new data.)
      if (nNew > 0 && post.n >= T.minEvidence) {
        const rate = nNew / (nNew + T.learnK);
        const target = Math.min(T.maxWeight, post.mean);
        const next = Math.max(floor, Math.min(T.maxWeight, p.weight + rate * (target - p.weight)));
        if (Math.abs(next - p.weight) >= 0.005) {
          mutations.push({
            type: next > p.weight ? 'strengthen' : 'weaken', target: id,
            from: round(p.weight), to: round(next),
            reason: `evidence ${round(p.evidence.s)}✓/${round(p.evidence.f)}✗ → mean ${round(post.mean)} (±${round(post.sd)}), +${round(nNew)} new`,
          });
          p.weight = next;
        }
      }
      if (nNew > 0 && post.n >= T.minEvidence) p.reviewed = { s: p.evidence.s, f: p.evidence.f };

      // 2. Decay — per day of disuse past the onset, applied once per day.
      const last = Date.parse(p.lastFired || p.created || 0) || now;
      const onset = last + T.decayOnsetDays * 86400000;
      const from = Math.max(onset, Date.parse(p.lastDecayAt || 0) || 0);
      const days = Math.floor((now - from) / 86400000);
      if (now > onset && days >= 1 && p.weight > floor) {
        const next = Math.max(floor, p.weight - days * T.decayPerDay);
        mutations.push({
          type: 'decay', target: id, from: round(p.weight), to: round(next),
          reason: `${Math.floor((now - last) / 86400000)} days since last use`,
        });
        p.weight = next;
        p.lastDecayAt = new Date(from + days * 86400000).toISOString();
      }

      // 3. Prune — dead pathways leave weights/ but are archived, never lost.
      if (p.weight <= T.minWeight && floor <= T.minWeight) {
        mutations.push({ type: 'prune', target: id, from: round(p.weight), to: 0, reason: 'weight at or below minimum' });
        prunedArchive.pathways[id] = { ...p, prunedAt: new Date(now).toISOString() };
        delete data.pathways[id];
      }
    }

    data.lastReview = new Date(now).toISOString();
    saveWeights(P, data);
    if (mutations.some(m => m.type === 'prune')) writeJsonAtomic(P.pruned, prunedArchive);
    for (const m of mutations) logMutation(P, m);
    return mutations;
  });
}

function prune(P) {
  return withLock(P, () => {
    const data = loadWeights(P);
    const archive = readJson(P.pruned, { pathways: {} });
    const pruned = [];
    for (const [id, p] of Object.entries(data.pathways)) {
      if (p.weight <= T.minWeight && floorFor(id, p) <= T.minWeight) {
        archive.pathways[id] = { ...p, prunedAt: new Date().toISOString() };
        delete data.pathways[id];
        logMutation(P, { type: 'prune', target: id, from: round(p.weight), to: 0, reason: 'manual prune' });
        pruned.push(id);
      }
    }
    if (pruned.length) { saveWeights(P, data); writeJsonAtomic(P.pruned, archive); }
    return pruned;
  });
}

function describe(id, p) {
  const post = posterior(p.evidence);
  const contexts = Object.fromEntries(Object.entries(p.contexts || {}).map(([k, c]) => {
    const cp = posterior(c);
    return [k, { mean: round(cp.mean), evidence: round(cp.n), fires: c.fires }];
  }));
  return {
    id, weight: round(p.weight), mean: round(post.mean), sd: round(post.sd), evidence: round(post.n),
    fires: p.fires, successes: p.successes, failures: p.failures,
    lastFired: p.lastFired, notes: p.notes, lastOutcome: p.lastOutcome, contexts,
  };
}

function promoteCandidates(P) {
  const data = loadWeights(P);
  return Object.entries(data.pathways)
    .map(([id, p]) => describe(id, p))
    .filter(d => d.weight >= T.promoteMinWeight && d.evidence >= T.promoteMinEvidence && d.mean >= T.promoteMinMean);
}

function statusLines(P, opts = {}) {
  const data = loadWeights(P);
  let list = Object.entries(data.pathways).map(([id, p]) => describe(id, p))
    .sort((a, b) => b.weight - a.weight);
  if (opts.min !== undefined) list = list.filter(d => d.weight >= opts.min);
  if (opts.top) list = list.slice(0, opts.top);
  return list;
}

function bar(w) {
  const n = Math.max(0, Math.min(10, Math.round(w * 10)));
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

function printStatus(P, opts) {
  const list = statusLines(P, opts);
  if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
  if (!list.length) { console.log('🧠 No pathways yet. Record outcomes to start learning.'); return; }
  if (!opts.compact) console.log('🧠 Neural Pathway Status\n');
  for (const d of list) {
    const rate = d.fires ? `${Math.round(d.successes / d.fires * 100)}%` : 'new';
    if (opts.compact) {
      console.log(`- ${d.id} w=${d.weight} (${rate} of ${d.fires}${d.notes ? `; ${d.notes}` : ''})`);
    } else {
      console.log(`  ${bar(d.weight)} ${d.weight.toFixed(2)} ${d.id} (${rate}, ${d.fires} fires, evidence ${d.evidence}, ±${d.sd})`);
      if (d.notes) console.log(`             ${d.notes}`);
      for (const [k, c] of Object.entries(d.contexts)) {
        console.log(`             @${k}: mean ${c.mean} over ${c.fires} fires`);
      }
    }
  }
}

// === External signals (written by hooks) ===================================
function addSignal(P, signal) {
  ensureDir(path.dirname(P.signals));
  const s = { id: `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...signal };
  fs.appendFileSync(P.signals, JSON.stringify(s) + '\n');
  return s;
}

function pendingSignals(P) {
  try {
    return fs.readFileSync(P.signals, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function consumeSignals(P, which, how) {
  const pending = pendingSignals(P);
  const ids = which === 'all' || which === true ? null : new Set(String(which).split(','));
  const keep = [], done = [];
  for (const s of pending) ((ids && !ids.has(s.id)) ? keep : done).push(s);
  ensureDir(path.dirname(P.signals));
  for (const s of done) fs.appendFileSync(P.signalsDone, JSON.stringify({ ...s, handledAt: new Date().toISOString(), how }) + '\n');
  fs.writeFileSync(P.signals, keep.map(s => JSON.stringify(s)).join('\n') + (keep.length ? '\n' : ''));
  return done.length;
}

// === CLI ===================================================================
const isSignalArg = v => typeof v === 'string' && (v === 'all' || /^sig-[\w-]+(,sig-[\w-]+)*$/.test(v));

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(['--brain', '--source', '--ctx', '--min', '--top', '--signals']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (a === '--signals') { if (isSignalArg(args[i + 1])) i++; continue; }
      if (flags.has(a)) i++;
      continue;
    }
    positional.push(a);
  }
  const P = paths(resolveBrainRoot(args));
  const cmd = positional[0];

  switch (cmd) {
    case 'record': {
      const [, id, outcome, ...notes] = positional;
      if (!['true', 'false'].includes(outcome)) throw new Error('usage: record <id> <true|false> [notes]');
      const si = args.indexOf('--signals');
      const consume = si === -1 ? null : (isSignalArg(args[si + 1]) ? args[si + 1] : 'all');
      const r = record(P, id, outcome === 'true', notes.join(' '), {
        source: argValue(args, '--source'), ctx: argValue(args, '--ctx'), consumeSignals: consume,
      });
      const d = describe(id, r.pathway);
      console.log(`📊 ${id}: ${outcome === 'true' ? '✅' : '❌'} (${r.pathway.lastOutcome.source}) weight ${d.weight}, mean ${d.mean}, ${d.successes}/${d.fires}${r.created ? ' — new pathway' : ''}`);
      break;
    }
    case 'review': {
      const m = review(P);
      for (const x of m) console.log(`📝 ${x.type} ${x.target}: ${x.from} → ${x.to} (${x.reason})`);
      console.log(m.length ? `\n🧠 Cortex review: ${m.length} mutations` : '🧠 Cortex review: no mutations needed');
      break;
    }
    case 'status':
      printStatus(P, {
        compact: args.includes('--compact'), json: args.includes('--json'),
        min: argValue(args, '--min') !== undefined ? parseFloat(argValue(args, '--min')) : undefined,
        top: argValue(args, '--top') ? parseInt(argValue(args, '--top'), 10) : undefined,
      });
      break;
    case 'get': {
      const data = loadWeights(P);
      const p = data.pathways[positional[1]];
      if (!p) { console.log('null'); process.exitCode = 1; break; }
      const d = describe(positional[1], p);
      const ctx = argValue(args, '--ctx');
      if (ctx && d.contexts[ctx]) d.inContext = { ctx, ...d.contexts[ctx] };
      console.log(JSON.stringify(d, null, 2));
      break;
    }
    case 'promote':
      console.log(JSON.stringify(promoteCandidates(P), null, 2));
      break;
    case 'prune': {
      const pruned = prune(P);
      console.log(pruned.length ? `🪓 Pruned (archived): ${pruned.join(', ')}` : '🧠 No pathways to prune');
      break;
    }
    case 'signals': {
      const s = pendingSignals(P);
      console.log(s.length ? s.map(x => `${x.id}  [${x.kind}] ${x.ok === false ? '❌' : x.ok === true ? '✅' : '•'} ${x.summary}`).join('\n') : 'No pending signals.');
      break;
    }
    case 'ack': {
      const n = consumeSignals(P, positional[1] || 'all', 'acknowledged, no pathway');
      console.log(`Acknowledged ${n} signal(s).`);
      break;
    }
    case 'where':
      console.log(P.root);
      break;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  }
}

module.exports = {
  T, paths, resolveBrainRoot, loadWeights, record, review, prune, promoteCandidates,
  statusLines, describe, posterior, addSignal, pendingSignals, consumeSignals, readJson, writeJsonAtomic,
};

if (require.main === module) {
  try { main(process.argv); } catch (e) { console.error(e.message); process.exit(1); }
}
