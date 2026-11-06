'use strict';
/**
 * Shared plumbing for the Claude Code hooks. Hooks must never break a
 * session: every failure exits 0 silently (set BRAINMD_DEBUG=1 to see why).
 */
const fs = require('fs');
const path = require('path');
const cortex = require('../cortex-review.js');

const CLI = path.resolve(__dirname, '..', 'cortex-review.js');

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// The brain for this project, or null when brainmd isn't initialised here.
// Hooks never create a brain on their own — run install.js / init-brain.sh.
function brainFor(input) {
  const root = process.env.BRAIN_ROOT
    ? path.resolve(process.env.BRAIN_ROOT)
    : path.join(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), '.brain');
  const P = cortex.paths(root);
  return fs.existsSync(P.weights) ? P : null;
}

function debug(P, event, input) {
  if (!process.env.BRAINMD_DEBUG || !P) return;
  try {
    fs.mkdirSync(path.dirname(P.signals), { recursive: true });
    fs.appendFileSync(path.join(path.dirname(P.signals), 'debug.jsonl'), JSON.stringify({ event, at: new Date().toISOString(), input }) + '\n');
  } catch {}
}

function run(event, fn) {
  let P = null;
  try {
    const input = readInput();
    P = brainFor(input);
    if (!P) return;
    debug(P, event, input);
    const out = fn(input, P);
    if (out) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    if (process.env.BRAINMD_DEBUG) process.stderr.write(`brainmd ${event} hook: ${e.stack}\n`);
  }
}

const q = s => JSON.stringify(s);

module.exports = { run, cortex, CLI, q };
