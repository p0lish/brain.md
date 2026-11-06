#!/usr/bin/env node
// Moved to scripts/dream.js — this shim keeps `node dream.js` working.
// Set BRAIN_WORKSPACE to your workspace (the folder holding MEMORY.md) if it
// is not the brain directory itself.
const path = require('path');
const { dream, config } = require(path.join(__dirname, 'scripts', 'dream.js'));
const cfg = config();
console.log(`\n🌙 brainmd dream — ${cfg.dry ? 'DRY RUN' : 'LIVE'} — ${cfg.workspace}\n`);
try { dream(cfg); } catch (e) { console.error('Dream failed:', e); process.exit(1); }
