# 🧠 brainmd

**Neuroplastic runtime for AI agents.** File-based behavioral learning.

An AI agent's memory resets every session. brainmd gives it scar tissue.

---

## What is this?

brainmd is a lightweight system that lets AI agents learn from their own behavior over time. No ML pipeline, no vector database, no training runs — just JSON files, shell scripts, and a self-review loop.

Every behavior becomes a **pathway** with a weight between 0 and 1. Pathways that succeed get stronger. Pathways that fail get weaker. Unused pathways decay. New situations create new pathways automatically (neurogenesis). Everything is logged.

Think of it as a nervous system made of files.

## Architecture

```
brain/
├── reflexes/       # Fast-path automatic responses
│   └── timing.js   # When to notify vs stay quiet
├── habits/         # Learned behavioral patterns
│   └── preferences.json
├── skills/         # Self-generated micro-scripts
├── weights/        # Pathway strength tracking
│   └── pathways.json     # ← the core state
├── cortex/         # Meta-scripts that modify everything else
│   └── review.js         # ← the self-review engine
└── mutations/      # Immutable audit log (never delete this)
```

## Quick Start

### 1. Initialize

```bash
./scripts/init-brain.sh ~/my-agent/brain
```

This creates the directory structure with empty state files.

### 2. Record behaviors

When something works:
```bash
node cortex/review.js record "reflex:night-silence" true "Didn't ping user at 3 AM — correct call"
```

When something fails:
```bash
node cortex/review.js record "habit:check-files-first" false "Searched the web for info that was already in local files"
```

New pathways are created automatically (neurogenesis) when you record a behavior that doesn't exist yet. Starting weight: 0.30.

### 3. Self-review

Run periodically (heartbeat, cron, whatever):
```bash
node cortex/review.js review
```

The cortex will:
- **Reinforce** — move each weight toward its evidence (a Beta posterior over outcomes), but only when there is *new* evidence since the last review, and with a step that grows with the amount of it. Re-running review never inflates a weight.
- **Decay** pathways unused for 7+ days (−0.02 per day of disuse, applied once per day however often review runs)
- **Prune** pathways at the minimum weight — archived to `weights/pruned.json`, never lost

Outcomes from outside the agent (`--source external`: tests, the user's reaction) count double; the agent grading itself counts half.

### 4. Check status

```bash
node cortex/review.js status
```

```
🧠 Neural Pathway Status

  ██████████ 0.95 reflex:morning-briefing (100%, 3 fires)
             Batch overnight findings, present at reasonable hour
  ██████████ 0.95 reflex:night-silence (100%, 5 fires)
             Don't notify between 23:00-08:00 unless urgent
  ██████░░░░ 0.60 habit:check-files-before-search (75%, 4 fires)
             Check local files before web searching
  █░░░░░░░░░ 0.10 reflex:fallback-on-ratelimit (0%, 5 fires)
             Keep failing — indicates a bug, not a behavior problem
```

## Pathway Types

| Prefix | Purpose | Decay | Min Weight |
|--------|---------|-------|------------|
| `reflex:` | Automatic, fast-path behaviors | Slow | 0.20 |
| `habit:` | Learned patterns from interaction | Normal | 0 (prunable) |
| `skill:` | Acquired capabilities | Slow | 0.10 |
| `instinct:` | Safety behaviors (hardcoded high) | None | 0.80 |

## Claude Code

brainmd ships as a Claude Code skill with hooks, so the loop runs without the agent having to remember it.

```bash
# in your project
git clone https://github.com/p0lish/brain.md .claude/skills/brainmd
node .claude/skills/brainmd/scripts/install.js --claude-md
```

(Or clone to `~/.claude/skills/brainmd` and run `install.js --global`, then `install.js --init <project>` per project.)

`install.js` creates `.brain/`, merges four hooks into `.claude/settings.json` (your existing settings and hooks are kept; re-running is safe; `--uninstall` removes only ours), and with `--claude-md` imports `.brain/MEMORY.md` into `CLAUDE.md`. See [`examples/settings.json`](examples/settings.json) for the result.

| Hook | What it does |
|---|---|
| `SessionStart` | Runs a sleep cycle if the last one is >20 h old, then loads instincts, proven and weak pathways into context — the session-boundary problem, solved |
| `PostToolUse` (Bash) | Test / build / lint / typecheck results become **external signals** |
| `UserPromptSubmit` | Clear corrections ("no, I told you…") and clear praise become external signals |
| `Stop` | When new signals include a failure or feedback, asks Claude once to attribute them to a pathway or `ack` them — credit assignment from real outcomes, not self-grading |

Hooks are silent no-ops in projects without a `.brain/`, never block twice on the same signals, and never crash a session (`BRAINMD_DEBUG=1` logs their input to `.brain/signals/debug.jsonl`; `BRAINMD_STOP_NUDGE=0` turns the Stop nudge off).

### Sleep

`scripts/sleep.js` = cortex review + dream. It runs from the SessionStart hook when due; for a fixed schedule add a cron line:

```
30 3 * * *  cd /path/to/project && node .claude/skills/brainmd/scripts/sleep.js
```

`dream.js` folds new facts from `.brain/memory/YYYY-MM-DD.md` into `.brain/MEMORY.md` — incremental, deduplicated, ranked by signal markers — and regenerates a **Learned rules** block: proven pathways become written rules, repeatedly failing ones become warnings, pruned ones disappear. Old sections over the 300-line cap move to `memory/archive.md`.

## Mutation Log

Every change is appended to `mutations/YYYY-MM-DD.jsonl` (one JSON object per line) with timestamp, type, and reason:

- `neurogenesis` — new pathway created
- `strengthen` — weight increased (good outcomes)
- `weaken` — weight decreased (bad outcomes)
- `decay` — faded from disuse
- `prune` — moved to `weights/pruned.json` (weight hit the minimum)
- `outcome` — an outcome was recorded (with its source and context)

The mutation log is the one immutable thing. It's your audit trail. Don't delete it.

## Integration

brainmd has zero dependencies beyond Node.js (18+). It works with any agent framework — or no framework at all.

### With OpenClaw

Add a self-check to your `HEARTBEAT.md`:

```markdown
## 🧠 brainmd Self-Check

node ~/brain/cortex/review.js review
node ~/brain/cortex/review.js status

Ask yourself:
1. Did I make a mistake since last check? → record it
2. Did something work well? → record it
3. New pattern emerging? → let neurogenesis handle it
```

Also available as a skill on [ClawHub](https://clawhub.ai/skills/brainmd):
```bash
clawhub install brainmd
```

### With LangChain / CrewAI / AutoGPT

Wire recording into your agent's task completion callback:

```python
import subprocess

def on_task_complete(task, success, notes):
    outcome = "true" if success else "false"
    subprocess.run([
        "node", "cortex/review.js", "record",
        f"habit:{task.name}", outcome, notes
    ])
```

Add `review.js review` to your agent loop or a cron job.

### With any LLM API (OpenAI, Anthropic, etc.)

1. Read `weights/pathways.json` and inject relevant pathways into your system prompt
2. After each interaction, record outcomes via CLI
3. Run `review` on a schedule (cron, webhook, timer)

```bash
# After a good interaction
node cortex/review.js record "habit:concise-answers" true "User thanked for brevity"

# After a bad one
node cortex/review.js record "habit:concise-answers" false "User said answer was too long"

# Periodic review (cron every 30min, hourly, whatever fits)
node cortex/review.js review
```

### Without any AI at all

brainmd is just a behavioral reinforcement tracker. You can use it for:
- Personal habit tracking with weighted outcomes
- Team process improvement (record what works, what doesn't)
- Any system where you want patterns to emerge from data, not theory

This closes the loop: **behavior → outcome → record → review → adjust → behavior**.

## Design Principles

1. **Everything is mutable** except the audit log
2. **Use strengthens, disuse weakens** — pathways that fire together wire together
3. **Seed from real behavior, not theory** — observe first, codify second
4. **Failures create pathways** — mistakes are the most valuable learning data
5. **Start small** — 5-10 pathways, let it grow organically
6. **No dependencies** — plain Node.js + JSON + filesystem

## What it's not

- Not a vector database or RAG system
- Not prompt engineering (it modifies behavior files, not prompts)
- Not ML training (no gradients, no epochs, no GPU)
- Not a replacement for memory — it's a complement to it

brainmd tracks *how* an agent behaves, not *what* it knows.

## Current Limitations

- **Recording still needs judgement** — hooks capture external signals, but mapping a signal to the behaviour that caused it is the agent's call
- **No associative learning** — pathways don't influence each other yet
- **Context is opt-in** — per-context stats exist (`--ctx`), but the headline weight is global
- **Heuristic signal detection** — test-result and feedback parsing is regex-based and deliberately conservative
- **Session boundary** — solved in Claude Code by the SessionStart hook; other frameworks still need to load the brain themselves

These are feature gaps, not design flaws. The architecture supports all of them — they just need building.

## Origin

Built in a single session on March 7, 2026 by an AI agent and its human. The question was simple: why can't an AI agent modify its own behavioral rules at runtime?

Turns out it can.

## License

MIT — see [LICENSE](LICENSE).
