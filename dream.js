#!/usr/bin/env node
/**
 * dream.js — Memory consolidation for HAL 9000
 * 
 * Inspired by Claude Code's Auto-dream feature.
 * Scans recent daily memory files, extracts signal,
 * and consolidates into MEMORY.md.
 * 
 * Usage:
 *   node dream.js          — full consolidation
 *   node dream.js --dry    — preview only, no writes
 *   node dream.js --days 7 — scan last N days (default: 7)
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const MEMORY_FILE = path.join(WORKSPACE, 'MEMORY.md');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');
const STATE_FILE = path.join(WORKSPACE, 'memory', 'dream-state.json');
const MAX_MEMORY_LINES = 300;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '7');

// --- Helpers ---

function log(msg) { console.log(`[dream] ${msg}`); }

function today() {
  return new Date().toISOString().split('T')[0];
}

function dateRange(days) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastRun: null, lastRunDate: null };
  }
}

function saveState() {
  const state = { lastRun: Date.now(), lastRunDate: today() };
  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Phase 1: Orientation ---

function orientation() {
  log('Phase 1: Orientation');
  const memory = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : '';
  const lines = memory.split('\n').length;
  log(`  MEMORY.md: ${lines} lines`);
  return { memory, lines };
}

// --- Phase 2: Gather Signal ---

// Patterns that indicate high-value content
const SIGNAL_PATTERNS = [
  /remember\s+this/i,
  /important[:\s]/i,
  /lesson learned/i,
  /don't\s+forget/i,
  /note[:\s]/i,
  /key\s+(finding|decision|insight)/i,
  /\*\*[^*]+\*\*/,          // bold text = emphasis
  /^#+\s+/m,                 // headers
  /^-\s+(✅|❌|⚠️)/m,      // status markers
];

// Patterns to skip (noise)
const NOISE_PATTERNS = [
  /heartbeat_ok/i,
  /^HEARTBEAT/i,
  /^\s*$/,
];

function gatherSignal(days) {
  log(`Phase 2: Gather Signal (last ${days} days)`);
  const dates = dateRange(days);
  const signals = [];

  for (const date of dates) {
    const file = path.join(MEMORY_DIR, `${date}.md`);
    if (!fs.existsSync(file)) continue;

    const content = fs.readFileSync(file, 'utf8');
    const sections = content.split(/^##\s+/m).filter(Boolean);

    for (const section of sections) {
      const lines = section.split('\n');
      const header = lines[0]?.trim();
      const body = lines.slice(1).join('\n').trim();

      if (!body) continue;
      if (NOISE_PATTERNS.some(p => p.test(body))) continue;

      // Score by signal density
      const score = SIGNAL_PATTERNS.filter(p => p.test(body)).length;
      if (score > 0 || body.length > 200) {
        signals.push({ date, header, body, score });
      }
    }

    // Also grab the whole file if it has meaningful content
    if (content.trim().length > 100) {
      signals.push({ date, header: `[${date} full log]`, body: content, score: 0, raw: true });
    }
  }

  log(`  Found ${signals.filter(s => !s.raw).length} signal sections across ${dates.length} dates`);
  return signals;
}

// --- Phase 3: Consolidation ---

function resolveRelativeDates(text, fileDate) {
  // Convert "yesterday", "today", "last week" to absolute dates where possible
  const d = new Date(fileDate);
  
  const yesterday = new Date(d);
  yesterday.setDate(d.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  return text
    .replace(/\byesterday\b/gi, yesterdayStr)
    .replace(/\btoday\b/gi, fileDate)
    .replace(/\bthis morning\b/gi, `morning of ${fileDate}`)
    .replace(/\blast week\b/gi, `week of ${fileDate}`);
}

function extractKeyFacts(signals) {
  log('Phase 3: Consolidation');
  const facts = [];

  for (const signal of signals) {
    if (signal.raw) continue; // skip raw dumps
    
    const resolved = resolveRelativeDates(signal.body, signal.date);
    
    // Extract bullet points and headers as discrete facts
    const bullets = resolved.match(/^[-*]\s+.+/gm) || [];
    const headers = resolved.match(/^#+\s+.+/gm) || [];
    
    for (const bullet of bullets) {
      if (bullet.length > 20 && bullet.length < 500) {
        facts.push({ date: signal.date, text: bullet, type: 'bullet' });
      }
    }
  }

  log(`  Extracted ${facts.length} discrete facts`);
  return facts;
}

// --- Phase 4: Prune & Index ---

function buildConsolidationReport(signals, facts) {
  log('Phase 4: Building consolidation report');
  
  const byDate = {};
  for (const signal of signals) {
    if (signal.raw) continue;
    if (!byDate[signal.date]) byDate[signal.date] = [];
    byDate[signal.date].push(signal);
  }

  const dates = Object.keys(byDate).sort().reverse();
  
  let report = `\n---\n\n## Memory Consolidation — ${today()}\n\n`;
  report += `*Auto-generated by dream.js — ${dates.length} days scanned, ${facts.length} facts extracted*\n\n`;

  // Group new insights
  if (facts.length > 0) {
    const recentFacts = facts.slice(0, 20); // top 20 most recent
    report += `### Recent Learnings (${today()})\n\n`;
    for (const fact of recentFacts) {
      report += `${fact.text} *(${fact.date})*\n`;
    }
    report += '\n';
  }

  return report;
}

function pruneMemory(memory, maxLines) {
  const lines = memory.split('\n');
  if (lines.length <= maxLines) return memory;

  log(`  Pruning: ${lines.length} → ${maxLines} lines`);
  
  // Keep the header section (first 30 lines)
  const header = lines.slice(0, 30);
  
  // Keep the most recent consolidation sections (work backwards)
  const body = lines.slice(30);
  const sections = body.join('\n').split(/^---$/m);
  
  // Take most recent sections until we hit the limit
  const kept = [];
  let lineCount = header.length;
  
  for (const section of sections.reverse()) {
    const sLines = section.split('\n').length;
    if (lineCount + sLines < maxLines) {
      kept.unshift(section);
      lineCount += sLines;
    }
  }

  return header.join('\n') + '\n' + kept.join('\n---\n');
}

// --- Main ---

async function main() {
  console.log(`\n🔴 HAL dream.js — Memory Consolidation`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`   Scanning: last ${DAYS} days\n`);

  const state = loadState();
  if (state.lastRunDate === today() && !DRY_RUN && !args.includes('--force')) {
    log('Already ran today. Use --force to override.');
    process.exit(0);
  }

  // Phase 1
  const { memory } = orientation();

  // Phase 2
  const signals = gatherSignal(DAYS);
  if (signals.length === 0) {
    log('No signal found. Nothing to consolidate.');
    process.exit(0);
  }

  // Phase 3
  const facts = extractKeyFacts(signals);

  // Phase 4
  const report = buildConsolidationReport(signals, facts);
  
  if (DRY_RUN) {
    console.log('\n--- PREVIEW ---');
    console.log(report);
    console.log('--- END PREVIEW ---\n');
    log('Dry run complete. No files written.');
    return;
  }

  // Write consolidated section to MEMORY.md
  let updated = memory + report;
  updated = pruneMemory(updated, MAX_MEMORY_LINES);
  
  fs.writeFileSync(MEMORY_FILE, updated);
  saveState();

  const newLines = updated.split('\n').length;
  log(`✅ Done. MEMORY.md: ${memory.split('\n').length} → ${newLines} lines`);
  console.log('\n🔴 Dream complete.\n');
}

main().catch(err => {
  console.error('Dream failed:', err);
  process.exit(1);
});
