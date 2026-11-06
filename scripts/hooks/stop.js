#!/usr/bin/env node
/**
 * Stop hook: credit assignment. When new external signals include a failure
 * or user feedback, ask Claude once to attribute them to a pathway (or ack).
 * Pure "tests passed" batches wait silently and ride along with the next nudge.
 *
 * Loop safety: each signal triggers at most one nudge (tracked on disk), and
 * the hook never blocks when stop_hook_active is set.
 * Disable with BRAINMD_STOP_NUDGE=0.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { run, cortex, CLI, q } = require('./_io.js');

if (require.main === module) run('Stop', (input, P) => {
  if (process.env.BRAINMD_STOP_NUDGE === '0' || input.stop_hook_active) return;
  const stateFile = path.join(path.dirname(P.signals), 'nudged.json');
  const nudged = new Set(cortex.readJson(stateFile, { ids: [] }).ids);
  const pending = cortex.pendingSignals(P);
  const fresh = pending.filter(s => !nudged.has(s.id));
  if (!fresh.some(s => s.ok === false || s.kind === 'user-feedback')) return;

  const ids = new Set(pending.map(s => s.id));
  cortex.writeJsonAtomic(stateFile, { ids: [...nudged].filter(id => ids.has(id)).concat(fresh.map(s => s.id)) });

  const shown = pending.slice(-8);
  const list = shown.map(s => `- ${s.id}: ${s.summary}`).join('\n');
  const reason =
    `brainmd: ${pending.length} external outcome signal(s) are waiting for attribution` +
    `${pending.length > shown.length ? ` (latest ${shown.length} shown)` : ''}:\n${list}\n\n` +
    `If a signal reflects a behaviour choice you made in this session, record it against that pathway, e.g.\n` +
    `node ${q(CLI)} record habit:<name> <true|false> "<what happened>" --source external --signals <signal-ids or all>\n` +
    `If none of them relate to a behaviour worth tracking: node ${q(CLI)} ack\n` +
    `Then finish your turn as normal.`;
  return { decision: 'block', reason };
});
