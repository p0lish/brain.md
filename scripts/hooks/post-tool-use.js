#!/usr/bin/env node
/**
 * PostToolUse hook (matcher: Bash): turns test / build / lint / typecheck
 * runs into external signals. These are outcomes the agent didn't grade
 * itself, which is what makes them worth more than self-reports.
 */
'use strict';
const { run, cortex } = require('./_io.js');

const KINDS = [
  ['tests', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|jest|vitest|mocha|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+(-\S+\s+)*test\b|\bgradlew?\s+test\b|\bdotnet\s+test\b|\bmake\s+(test|check)\b|\bnode\s+--test\b/],
  ['typecheck', /\btsc\b|\bmypy\b|\bpyright\b/],
  ['lint', /\b(eslint|ruff|flake8|pylint|golangci-lint|clippy|rubocop)\b|\b(npm|pnpm|yarn)\s+(run\s+)?lint\b/],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b(?!\s+(test|check))|\bdocker\s+build\b|\bmvn\s+(-\S+\s+)*(package|install)\b|\bgradlew?\s+build\b/],
];

const FAIL = [
  /\b([1-9]\d*)\s+(failed|failing|failures?|errors?)\b/i,
  /^\s*FAIL\b/m, /\bFAILED\b/, /\bnpm ERR!/, /^Traceback \(most recent call last\)/m,
  /\berror(\[E\d+\])?:/, /\bBUILD FAILED\b/i, /\bexit (code|status) [1-9]/i, /\bcommand failed\b/i,
  /\bpanicked at\b/, /\bcompilation failed\b/i,
];
const PASS = [
  /\b\d+\s+(passed|passing)\b/i, /\b0\s+(failed|failures|errors)\b/i, /\ball tests passed\b/i,
  /^\s*ok\b/m, /^OK\b/m, /\bbuild succeeded\b/i, /\bcompiled successfully\b/i, /\bFound 0 errors\b/i,
  /\bAll checks passed\b/i, /\btest result: ok\b/,
];

function exitCode(resp) {
  if (!resp || typeof resp !== 'object') return undefined;
  for (const k of ['exit_code', 'exitCode', 'returnCode', 'return_code', 'code', 'status']) {
    if (typeof resp[k] === 'number') return resp[k];
  }
  return undefined;
}

// Exit code if the hook input carries one; otherwise read the output.
function outcome(resp) {
  if (resp && resp.interrupted) return undefined;
  const code = exitCode(resp);
  if (code !== undefined) return code === 0;
  const text = typeof resp === 'string' ? resp
    : [resp && resp.stdout, resp && resp.stderr, resp && resp.output].filter(Boolean).join('\n');
  if (!text) return undefined;
  if (FAIL.some(r => r.test(text))) return false;
  if (PASS.some(r => r.test(text))) return true;
  return undefined;
}

if (require.main === module) run('PostToolUse', (input, P) => {
  if (input.tool_name && input.tool_name !== 'Bash') return;
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!cmd || (input.tool_input && input.tool_input.run_in_background)) return;
  const kind = (KINDS.find(([, re]) => re.test(cmd)) || [])[0];
  if (!kind) return;
  const ok = outcome(input.tool_response);
  if (ok === undefined) return;

  const short = cmd.replace(/\s+/g, ' ').slice(0, 120);
  const last = cortex.pendingSignals(P).slice(-1)[0];
  if (last && last.kind === kind && last.cmd === short && last.ok === ok) return; // same result again
  cortex.addSignal(P, { kind, ok, cmd: short, summary: `${kind} ${ok ? 'passed' : 'failed'}: ${short}`, session: input.session_id });
});

module.exports = { outcome };
