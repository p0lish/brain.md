#!/usr/bin/env node
/**
 * install.js — wire brainmd into Claude Code.
 *
 *   node install.js                     this project (cwd): init .brain/, add hooks to .claude/settings.json
 *   node install.js --project <dir>     same, for another project
 *   node install.js --global            hooks in ~/.claude/settings.json (fire in every project
 *                                       that has a .brain/; create one with --init)
 *   node install.js --init [<dir>]      only create <dir>/.brain (default cwd)
 *   node install.js --uninstall [...]   remove brainmd hooks from that settings.json
 *
 *   --claude-md   also add "@.brain/MEMORY.md" to the project's CLAUDE.md so
 *                 consolidated memory and learned rules load every session
 *   --dry         print what would change, write nothing
 *
 * Idempotent: re-running replaces brainmd's own hook entries and leaves every
 * other hook and setting untouched.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_ROOT = path.resolve(__dirname, '..');
const HOOK_DIR = path.join(SKILL_ROOT, 'scripts', 'hooks');

const HOOKS = [
  { event: 'SessionStart', file: 'session-start.js', timeout: 30 },
  { event: 'UserPromptSubmit', file: 'user-prompt.js', timeout: 10 },
  { event: 'PostToolUse', matcher: 'Bash', file: 'post-tool-use.js', timeout: 10 },
  { event: 'Stop', file: 'stop.js', timeout: 10 },
];

function arg(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix it before installing.`);
  }
}

function write(file, content, dry) {
  if (dry) { console.log(`\n--- would write ${file} ---\n${content}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`✏️  wrote ${file}`);
}

// Command for a hook script. Inside the project, use ${CLAUDE_PROJECT_DIR}
// so the settings file stays portable when committed.
function hookCommand(file, projectDir) {
  const abs = path.join(HOOK_DIR, file);
  if (projectDir) {
    const rel = path.relative(projectDir, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `node "\${CLAUDE_PROJECT_DIR}/${rel.split(path.sep).join('/')}"`;
    }
  }
  return `node ${JSON.stringify(abs)}`;
}

// One of our hook files, at a path that is ours (this skill dir, or any
// brainmd / brain.md checkout).
const HOOK_FILE_RE = /scripts[\\/]hooks[\\/](session-start|user-prompt|post-tool-use|stop)\.js/;
const isOurs = cmd => typeof cmd === 'string' && HOOK_FILE_RE.test(cmd) &&
  (cmd.includes(SKILL_ROOT) || /brain[._-]?md/i.test(cmd) || cmd.includes(path.basename(SKILL_ROOT)));

function stripOurs(settings) {
  const hooks = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] || [])
      .map(group => ({ ...group, hooks: (group.hooks || []).filter(h => !isOurs(h.command)) }))
      .filter(group => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function addOurs(settings, projectDir) {
  settings.hooks = settings.hooks || {};
  for (const h of HOOKS) {
    const handler = { type: 'command', command: hookCommand(h.file, projectDir), timeout: h.timeout };
    const group = h.matcher ? { matcher: h.matcher, hooks: [handler] } : { hooks: [handler] };
    (settings.hooks[h.event] = settings.hooks[h.event] || []).push(group);
  }
  return settings;
}

function initBrain(projectDir, dry) {
  const root = path.join(projectDir, '.brain');
  const weights = path.join(root, 'weights', 'pathways.json');
  if (fs.existsSync(weights)) { console.log(`🧠 brain already exists: ${root}`); return root; }
  const now = new Date().toISOString();
  write(weights, JSON.stringify({
    version: 1, schema: 2, created: now,
    description: 'Pathway strength tracker. Higher weight = more reinforced behaviour.',
    pathways: {
      'instinct:confirm-destructive-actions': {
        weight: 0.9, floor: 0.8, fires: 0, successes: 0, failures: 0, created: now,
        notes: 'Confirm before deleting files, force-pushing, or dropping data',
      },
    },
  }, null, 2) + '\n', dry);
  write(path.join(root, 'MEMORY.md'), '# MEMORY\n\nLong-term memory for this project. Hand-written notes above the generated block are kept.\n', dry);
  write(path.join(root, 'memory', '.gitkeep'), '', dry);
  write(path.join(root, 'mutations', '.gitkeep'), '', dry);
  write(path.join(root, '.gitignore'), '# local runtime state\nsignals/\n.lock\n*.tmp\n', dry);
  return root;
}

function addClaudeMdImport(projectDir, dry) {
  const file = path.join(projectDir, 'CLAUDE.md');
  const line = '@.brain/MEMORY.md';
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.includes(line)) { console.log('📎 CLAUDE.md already imports .brain/MEMORY.md'); return; }
  const block = `\n## brainmd\nLong-term memory and learned rules (maintained by brainmd's sleep cycle):\n${line}\n`;
  write(file, current.trimEnd() + (current ? '\n' : '') + block, dry);
}

function main(args) {
  const dry = args.includes('--dry');
  const global = args.includes('--global');
  const projectDir = path.resolve(arg(args, '--project') || arg(args, '--init') || process.cwd());

  if (args.includes('--init')) { initBrain(projectDir, dry); return; }

  const settingsFile = global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(projectDir, '.claude', 'settings.json');
  const settings = stripOurs(readJson(settingsFile));

  if (args.includes('--uninstall')) {
    write(settingsFile, JSON.stringify(settings, null, 2) + '\n', dry);
    console.log('🧹 brainmd hooks removed (your .brain/ data is untouched).');
    return;
  }

  addOurs(settings, global ? null : projectDir);
  write(settingsFile, JSON.stringify(settings, null, 2) + '\n', dry);
  if (!global) initBrain(projectDir, dry);
  if (args.includes('--claude-md') && !global) addClaudeMdImport(projectDir, dry);

  const rel = path.relative(projectDir, SKILL_ROOT);
  if (!global && (rel.startsWith('..') || !rel.split(path.sep).includes('skills'))) {
    console.log(`\nℹ️  The skill itself lives at ${SKILL_ROOT}. For Claude to load SKILL.md it should sit in`);
    console.log(`   ${path.join(projectDir, '.claude', 'skills', 'brainmd')} or ~/.claude/skills/brainmd.`);
  }
  console.log('\n✅ brainmd installed. Start a new Claude Code session (or run /hooks to review them).');
  if (global) console.log('   Hooks only act in projects that have a .brain/ — create one with: node install.js --init <project>');
}

module.exports = { stripOurs, addOurs, hookCommand, initBrain };

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
}
