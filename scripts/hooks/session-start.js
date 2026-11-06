#!/usr/bin/env node
/**
 * SessionStart hook: sleep if due, then load the brain into context.
 * Output is factual (what the brain holds), not imperative — hook text that
 * reads like a system instruction can trip prompt-injection defences.
 */
'use strict';
const { run, cortex, CLI, q } = require('./_io.js');
const { sleep } = require('../sleep.js');

const STALE_SIGNAL_DAYS = 3;

if (require.main === module) run('SessionStart', (input, P) => {
  let slept = null;
  if (input.source === undefined || input.source === 'startup' || input.source === 'resume') {
    try { slept = sleep(['--brain', P.root, '--if-due', '--quiet']); } catch {}
  }

  // Signals nobody attributed for days are noise by now.
  const cutoff = Date.now() - STALE_SIGNAL_DAYS * 86400000;
  const stale = cortex.pendingSignals(P).filter(s => Date.parse(s.at) < cutoff).map(s => s.id);
  if (stale.length) cortex.consumeSignals(P, stale.join(','), 'expired');

  const all = cortex.statusLines(P);
  const fmt = d => `- \`${d.id}\` w=${d.weight} (${d.successes}/${d.fires})${d.notes ? `: ${d.notes}` : ''}`;
  const instincts = all.filter(d => d.id.startsWith('instinct:'));
  const proven = all.filter(d => !d.id.startsWith('instinct:') && d.weight >= 0.75);
  const caution = all.filter(d => d.fires >= 2 && d.weight < 0.4);
  const developing = all.filter(d => !instincts.includes(d) && !proven.includes(d) && !caution.includes(d));
  const pending = cortex.pendingSignals(P);

  let ctx = `brainmd behavioural memory for this project (${P.root}).\n`;
  if (slept && !slept.skipped && (slept.mutations.length || slept.facts.length)) ctx += `A sleep cycle ran at session start: ${slept.mutations.length} pathway change(s), ${slept.facts.length} fact(s) consolidated into MEMORY.md.\n`;
  if (!all.length) ctx += 'No pathways recorded yet.\n';
  if (instincts.length) ctx += `\nInstincts (floored, never decay):\n${instincts.map(fmt).join('\n')}\n`;
  if (proven.length) ctx += `\nProven pathways (high weight, repeatedly worked):\n${proven.map(fmt).join('\n')}\n`;
  if (caution.length) ctx += `\nWeak pathways (have failed here before):\n${caution.map(fmt).join('\n')}\n`;
  if (developing.length) ctx += `\nDeveloping pathways: ${developing.map(d => `\`${d.id}\` w=${d.weight}`).join(', ')}\n`;
  if (pending.length) ctx += `\n${pending.length} external signal(s) are pending attribution (\`node ${q(CLI)} signals\`).\n`;
  ctx += `\nOutcomes are recorded with: node ${q(CLI)} record <type:name> <true|false> "<what happened>" [--source external] [--ctx <situation>]`;

  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
});
