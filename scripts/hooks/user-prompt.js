#!/usr/bin/env node
/**
 * UserPromptSubmit hook: catches clear corrections and clear praise in the
 * user's message as external signals. Deliberately conservative — a missed
 * signal costs nothing, a false one teaches the wrong lesson.
 */
'use strict';
const { run, cortex } = require('./_io.js');

const CORRECTION = [
  /^\s*(no|nope|wrong)\b\s*[,.!]/i,
  /\bthat'?s (wrong|incorrect|not (it|right|what i (asked|wanted|meant)))\b/i,
  /\bi (already )?(said|told you|asked( you)?)\b/i,
  /\byou (forgot|ignored|missed|didn'?t (read|listen|check))\b/i,
  /\b(stop|quit) (doing|adding|using|changing)\b/i,
  /\bdon'?t (do|add|use|change) that\b/i,
  /\b(way )?too (long|verbose|wordy)\b/i,
  /\bwhy (did|would) you\b/i,
];
const PRAISE = [
  /^\s*(perfect|exactly|awesome|excellent|great job|nice work|well done)\b/i,
  /\b(that|it|this) (works|worked)( now| perfectly| great)?\s*[.!]*\s*$/i,
  /\bthanks?\b.{0,40}\b(works|worked|fixed it|perfect)\b/i,
];

function classify(prompt) {
  if (!prompt || prompt.length > 2000) return undefined; // long prompts are tasks, not reactions
  if (CORRECTION.some(r => r.test(prompt))) return false;
  if (PRAISE.some(r => r.test(prompt))) return true;
  return undefined;
}

if (require.main === module) run('UserPromptSubmit', (input, P) => {
  const prompt = String(input.prompt || '');
  const ok = classify(prompt);
  if (ok === undefined) return;
  const excerpt = prompt.replace(/\s+/g, ' ').slice(0, 140);
  cortex.addSignal(P, { kind: 'user-feedback', ok, summary: `user ${ok ? 'approved' : 'corrected'}: "${excerpt}"`, session: input.session_id });
});

module.exports = { classify };
