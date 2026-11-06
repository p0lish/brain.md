#!/usr/bin/env node
/**
 * dream.js — memory consolidation ("sleep") for brainmd.
 *
 * Reads the daily episodic logs (memory/YYYY-MM-DD.md), extracts the signal,
 * and folds it into long-term MEMORY.md. Also regenerates a managed "rules"
 * block from the pathway weights: proven habits become written rules,
 * failing ones become warnings, pruned ones disappear.
 *
 * Usage:
 *   node dream.js                 consolidate everything since the last dream
 *   node dream.js --dry           preview only, no writes
 *   node dream.js --days 7        max lookback window (also --days=7; default 7)
 *   node dream.js --force         run even if it already ran today
 *   node dream.js --max-facts 20  facts per consolidation (default 20)
 *
 * Locations:
 *   workspace = $BRAIN_WORKSPACE, else the brain directory itself
 *   (see cortex-review.js for how the brain directory is resolved).
 *   Inside it: MEMORY.md, memory/YYYY-MM-DD.md, memory/archive.md, memory/dream-state.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cortex = require('./cortex-review.js');

const MAX_MEMORY_LINES = 300;
const SEEN_CAP = 5000;
const RULES_START = '<!-- brainmd:rules:start -->';
const RULES_END = '<!-- brainmd:rules:end -->';
const SECTION_RE = /^## Memory Consolidation — /;

// --- Args -------------------------------------------------------------------
function argNum(args, flag, dflt) {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return parseInt(args[i + 1], 10);
  const eq = args.find(a => a.startsWith(flag + '='));
  return eq ? parseInt(eq.split('=')[1], 10) : dflt;
}

function config(args = process.argv.slice(2)) {
  const brain = cortex.resolveBrainRoot(args);
  const workspace = path.resolve(process.env.BRAIN_WORKSPACE || brain);
  const memoryDir = path.join(workspace, 'memory');
  return {
    brain, workspace, memoryDir,
    memoryFile: path.join(workspace, 'MEMORY.md'),
    archiveFile: path.join(memoryDir, 'archive.md'),
    stateFile: path.join(memoryDir, 'dream-state.json'),
    dry: args.includes('--dry'),
    force: args.includes('--force'),
    days: argNum(args, '--days', 7),
    maxFacts: argNum(args, '--max-facts', 20),
  };
}

// --- Helpers ----------------------------------------------------------------
const log = msg => console.log(`[dream] ${msg}`);
const isoDate = d => d.toISOString().split('T')[0];

function dateRange(days, now) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(isoDate(d));
  }
  return out;
}

// Normalized fingerprint: same fact with different bullets / bold / trailing
// date stamp / whitespace hashes the same.
function fingerprint(text) {
  const norm = text
    .replace(/\*\(\d{4}-\d{2}-\d{2}[^)]*\)\*\s*$/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

// --- Phase 1: orientation ---------------------------------------------------
function orientation(cfg) {
  const memory = fs.existsSync(cfg.memoryFile) ? fs.readFileSync(cfg.memoryFile, 'utf8') : '';
  const state = cortex.readJson(cfg.stateFile, { lastRunDate: null, seen: [] });
  state.seen = state.seen || [];
  // Everything already in MEMORY.md counts as seen, even facts written by hand.
  const seen = new Set(state.seen);
  for (const line of memory.split('\n')) if (/^[-*]\s+/.test(line)) seen.add(fingerprint(line));
  log(`Phase 1: orientation — MEMORY.md ${memory ? memory.split('\n').length : 0} lines, ${seen.size} known facts, last dream ${state.lastRunDate || 'never'}`);
  return { memory, state, seen };
}

// --- Phase 2: gather signal -------------------------------------------------
const SIGNAL_PATTERNS = [
  /remember\s+this/i,
  /important[:\s]/i,
  /lesson(s)?\s+learned/i,
  /don'?t\s+forget/i,
  /\bnote[:\s]/i,
  /key\s+(finding|decision|insight)/i,
  /\bdecided\b|\bdecision\b/i,
  /\*\*[^*]+\*\*/,      // bold = emphasis
  /(✅|❌|⚠️)/,           // status markers
];
const NOISE_PATTERNS = [/heartbeat_ok/i, /^HEARTBEAT/i];

const scoreText = t => SIGNAL_PATTERNS.filter(p => p.test(t)).length;

function gatherSignal(cfg, state, now) {
  // Incremental: only days since the last dream (inclusive — today's log may
  // have grown), capped by --days. v0.1 rescanned the full window every run
  // and re-appended the same facts each day.
  let dates = dateRange(cfg.days, now);
  if (state.lastRunDate && !cfg.force) dates = dates.filter(d => d >= state.lastRunDate);
  log(`Phase 2: gather signal — scanning ${dates.length} day(s)`);

  const sections = [];
  for (const date of dates) {
    const file = path.join(cfg.memoryDir, `${date}.md`);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const raw of content.split(/^##\s+/m).filter(Boolean)) {
      const lines = raw.split('\n');
      const header = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      if (!body || NOISE_PATTERNS.some(p => p.test(body) || p.test(header))) continue;
      const score = scoreText(body) + scoreText(header);
      if (score > 0 || body.length > 200) sections.push({ date, header, body, score });
    }
  }
  log(`  ${sections.length} signal section(s)`);
  return sections;
}

// --- Phase 3: consolidation -------------------------------------------------
function resolveRelativeDates(text, fileDate) {
  const d = new Date(`${fileDate}T12:00:00Z`);
  const y = new Date(d); y.setUTCDate(d.getUTCDate() - 1);
  const t = new Date(d); t.setUTCDate(d.getUTCDate() + 1);
  return text
    .replace(/\byesterday\b/gi, isoDate(y))
    .replace(/\btomorrow\b/gi, isoDate(t))
    .replace(/\btoday\b/gi, fileDate)
    .replace(/\bthis morning\b/gi, `morning of ${fileDate}`)
    .replace(/\btonight\b/gi, `night of ${fileDate}`)
    .replace(/\blast week\b/gi, `week before ${fileDate}`);
}

function extractFacts(sections, seen, maxFacts) {
  const facts = [];
  const batch = new Set();
  for (const s of sections) {
    const resolved = resolveRelativeDates(s.body, s.date);
    for (const bullet of resolved.match(/^[-*]\s+.+/gm) || []) {
      if (bullet.length <= 20 || bullet.length >= 500) continue;
      const fp = fingerprint(bullet);
      if (seen.has(fp) || batch.has(fp)) continue;
      batch.add(fp);
      // A fact's score: its own markers plus its section's, so a plain bullet
      // under "## Lessons learned" outranks one under "## Misc".
      facts.push({ date: s.date, section: s.header, text: bullet.trim(), fp, score: scoreText(bullet) * 2 + s.score });
    }
  }
  // Rank by score, then recency. v0.1 computed a score and then ignored it.
  facts.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
  const kept = facts.slice(0, maxFacts);
  log(`Phase 3: consolidation — ${facts.length} new fact(s), keeping top ${kept.length}`);
  return kept;
}

// --- Phase 4: rules from pathways -------------------------------------------
function buildRulesBlock(brain) {
  const P = cortex.paths(brain);
  if (!fs.existsSync(P.weights)) return null;
  const all = cortex.statusLines(P);
  const proven = cortex.promoteCandidates(P);
  const caution = all.filter(d => d.fires >= 3 && d.weight < 0.35 && !d.id.startsWith('instinct:'));
  const instincts = all.filter(d => d.id.startsWith('instinct:'));
  let out = `${RULES_START}\n## Learned rules (generated by brainmd — edits here are overwritten)\n\n`;
  if (!proven.length && !caution.length && !instincts.length) out += '_No pathway is proven yet._\n';
  if (instincts.length) {
    out += '**Instincts (never relax these):**\n';
    for (const d of instincts) out += `- ${d.notes || d.id} \`${d.id}\`\n`;
    out += '\n';
  }
  if (proven.length) {
    out += '**Proven — do this:**\n';
    for (const d of proven) out += `- ${d.notes || d.id} \`${d.id}\` (${d.successes}/${d.fires})\n`;
    out += '\n';
  }
  if (caution.length) {
    out += '**Repeatedly failed — be careful:**\n';
    for (const d of caution) out += `- ${d.notes || d.id} \`${d.id}\` (${d.successes}/${d.fires})${d.lastOutcome?.notes ? ` — last: ${d.lastOutcome.notes}` : ''}\n`;
    out += '\n';
  }
  return out + RULES_END;
}

function upsertRules(memory, block) {
  if (!block) return memory;
  const re = new RegExp(`${RULES_START}[\\s\\S]*?${RULES_END}`);
  if (re.test(memory)) return memory.replace(re, block);
  // Place the rules after the hand-written header, before consolidation sections.
  const lines = memory.split('\n');
  const at = lines.findIndex(l => SECTION_RE.test(l));
  if (at === -1) return (memory.trimEnd() ? memory.trimEnd() + '\n\n' : '# MEMORY\n\n') + block + '\n';
  const before = lines.slice(0, at).join('\n').replace(/\n---\s*$/, '').trimEnd();
  return `${before}\n\n${block}\n\n---\n${lines.slice(at).join('\n')}`;
}

// --- Phase 5: write + prune -------------------------------------------------
function buildSection(facts, today, scanned) {
  let s = `## Memory Consolidation — ${today}\n\n*dream.js — ${scanned} section(s) scanned, ${facts.length} new fact(s)*\n\n`;
  for (const f of facts) s += `${f.text} *(${f.date}${f.section ? `, ${f.section}` : ''})*\n`;
  return s;
}

// Over the line cap, the oldest consolidation sections move to archive.md.
// Nothing is deleted — v0.1 dropped them outright.
function pruneMemory(memory, maxLines) {
  const lines = memory.split('\n');
  if (lines.length <= maxLines) return { memory, evicted: [] };
  const first = lines.findIndex(l => SECTION_RE.test(l));
  if (first === -1) return { memory, evicted: [] };
  const head = lines.slice(0, first);
  const sections = [];
  for (const l of lines.slice(first)) {
    if (SECTION_RE.test(l)) sections.push([]);
    sections[sections.length - 1].push(l);
  }
  // Newest sections are appended last; keep from the end until the cap.
  const kept = [];
  let count = head.length;
  for (let i = sections.length - 1; i >= 0; i--) {
    const n = sections[i].length;
    if (count + n > maxLines && kept.length) break;
    kept.unshift(sections[i]);
    count += n;
  }
  const evicted = sections.slice(0, sections.length - kept.length);
  return { memory: [...head, ...kept.flat()].join('\n'), evicted };
}

function dream(cfg, now = new Date()) {
  const today = isoDate(now);
  const { memory, state, seen } = orientation(cfg);
  if (state.lastRunDate === today && !cfg.dry && !cfg.force) {
    log('Already dreamed today. Use --force to override.');
    return { skipped: true };
  }
  const sections = gatherSignal(cfg, state, now);
  const facts = extractFacts(sections, seen, cfg.maxFacts);
  const rules = buildRulesBlock(cfg.brain);
  log(`Phase 4: rules — ${rules ? 'regenerated from pathways' : 'no pathways found'}`);

  let updated = upsertRules(memory, rules);
  if (facts.length) {
    const sep = updated.trimEnd() ? '\n\n---\n' : '';
    updated = updated.trimEnd() + sep + buildSection(facts, today, sections.length);
  }
  const { memory: pruned, evicted } = pruneMemory(updated, MAX_MEMORY_LINES);
  log(`Phase 5: write — ${facts.length} fact(s) added, ${evicted.length} old section(s) archived`);

  if (cfg.dry) {
    console.log('\n--- PREVIEW (MEMORY.md) ---\n' + pruned + '\n--- END PREVIEW ---\n');
    return { facts, evicted, dry: true };
  }

  fs.mkdirSync(cfg.memoryDir, { recursive: true });
  if (evicted.length) {
    fs.appendFileSync(cfg.archiveFile, evicted.map(s => s.join('\n').trimEnd()).join('\n\n') + '\n\n');
  }
  if (pruned !== memory) fs.writeFileSync(cfg.memoryFile, pruned.trimEnd() + '\n');
  const newSeen = [...state.seen, ...facts.map(f => f.fp)].slice(-SEEN_CAP);
  cortex.writeJsonAtomic(cfg.stateFile, { lastRun: now.getTime(), lastRunDate: today, seen: newSeen });
  log(`✅ MEMORY.md: ${memory ? memory.split('\n').length : 0} → ${pruned.split('\n').length} lines`);
  return { facts, evicted };
}

module.exports = { dream, config, fingerprint, pruneMemory, upsertRules, resolveRelativeDates };

if (require.main === module) {
  const cfg = config();
  console.log(`\n🌙 brainmd dream — ${cfg.dry ? 'DRY RUN' : 'LIVE'} — ${cfg.workspace}\n`);
  try { dream(cfg); console.log('\n🌙 Dream complete.\n'); } catch (e) { console.error('Dream failed:', e); process.exit(1); }
}
