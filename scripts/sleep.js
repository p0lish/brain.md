#!/usr/bin/env node
/**
 * sleep.js — one full sleep cycle: cortex review (behaviour) then dream
 * (memory + learned rules). Run nightly from cron or a scheduled task, or let
 * the SessionStart hook run it when the last sleep is older than ~20 hours.
 *
 *   node sleep.js [--brain <dir>] [--if-due]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cortex = require('./cortex-review.js');
const { dream, config } = require('./dream.js');

const DUE_HOURS = 20;

function sleepState(P) { return path.join(P.root, 'memory', 'sleep-state.json'); }

function isDue(P, now = Date.now()) {
  const s = cortex.readJson(sleepState(P), {});
  return !s.lastSleep || now - s.lastSleep > DUE_HOURS * 3600000;
}

function sleep(args = process.argv.slice(2), now = new Date()) {
  const P = cortex.paths(cortex.resolveBrainRoot(args));
  if (args.includes('--if-due') && !isDue(P, now.getTime())) return { skipped: true };
  if (!fs.existsSync(P.weights)) return { skipped: true, reason: 'no brain' };
  const mutations = cortex.review(P, now.getTime());
  const cfg = config(args);
  const quiet = args.includes('--quiet');
  const origLog = console.log;
  if (quiet) console.log = () => {};
  let result;
  try { result = dream({ ...cfg, force: true }, now); } finally { console.log = origLog; }
  cortex.writeJsonAtomic(sleepState(P), { lastSleep: now.getTime(), lastSleepAt: now.toISOString(), mutations: mutations.length, facts: result.facts ? result.facts.length : 0 });
  return { mutations, facts: result.facts || [] };
}

module.exports = { sleep, isDue };

if (require.main === module) {
  const r = sleep();
  if (r.skipped) console.log(`💤 Sleep skipped${r.reason ? ` (${r.reason})` : ' (not due)'}.`);
  else console.log(`💤 Slept: ${r.mutations.length} pathway mutation(s), ${r.facts.length} fact(s) consolidated.`);
}
