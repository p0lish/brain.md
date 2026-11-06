---
name: brainmd
description: "Behavioural memory that learns across sessions: pathways (habits, reflexes, skills, instincts) weighted by real outcomes, a nightly sleep cycle that consolidates daily notes into MEMORY.md and turns proven habits into written rules. Use when recording whether an approach worked or failed, when hooks report pending outcome signals, when checking what has worked in this project before, or when setting up adaptive agent behaviour."
---

# brainmd

*Behaviours that work get stronger. Behaviours that fail get weaker. Unused patterns decay. Mistakes leave scars.*

brainmd tracks **how** you behave in this project, not what you know. Each behaviour is a **pathway** (`habit:check-files-first`) with a weight between 0 and 1, moved by recorded outcomes. A sleep cycle reviews the weights and consolidates daily notes into long-term memory.

The CLI is `node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js`. The brain lives in `.brain/` at the project root.

## Reading the brain

The SessionStart hook already put the current pathways in your context. For details:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js status            # all pathways
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js get habit:<name>   # one pathway, with per-context stats
```

| Weight | Meaning | How to act |
|---|---|---|
| 0.8–0.95 | Proven | Follow it without second-guessing |
| 0.5–0.8 | Developing | Use it, verify the result |
| 0.3–0.5 | New or mixed | Proceed carefully |
| < 0.3 | Has failed here before | Read its `lastOutcome` before repeating it |

`instinct:*` pathways are safety rules with a floor of 0.8. They never decay and are never pruned.

## Recording outcomes

Record when a deliberate behaviour choice clearly worked or clearly failed — not for every action.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js record habit:run-migrations-dry-first true "Dry run caught a bad FK before staging"
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js record habit:bulk-rename-with-sed false "Rewrote vendored files too" --source external
```

- **Naming:** `<type>:<kebab-name>`, types `habit`, `reflex`, `skill`, `instinct`. Reuse an existing pathway name before inventing a new one; run `status` if unsure.
- **`--source external`** only when the verdict came from outside you: a test/build result, or the user's reaction. It counts double. Your own judgement of your own work is `self` (the default) and counts half — self-assessment is biased toward success.
- **`--ctx <situation>`** when a behaviour's value depends on the situation, e.g. `habit:concise-answers --ctx quick-question` vs `--ctx design-review`.
- **Failures are the most valuable records.** Record them honestly; that is how the weak-pathway warnings get built.

## Pending signals (the Stop hook)

Hooks turn test/build/lint results and clear user corrections or praise into **signals**. When new ones include a failure or user feedback, the Stop hook asks you once to attribute them:

1. Run `node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js signals` to see them.
2. If a signal reflects a behaviour choice you made, record it against that pathway with `--source external --signals <ids|all>` (this also clears them).
3. If none relate to a behaviour worth tracking (a typo, an unrelated flaky test), clear them: `node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js ack`.

Don't invent a pathway just to absorb a signal. `ack` is a fine answer.

## Daily notes and sleep

Episodic notes go in `.brain/memory/YYYY-MM-DD.md` under `## ` headings, as `- ` bullets. Append when something is worth remembering beyond this session: a decision, a gotcha, a lesson. Mark importance with words like `Important:`, `Lesson learned`, `Decision`, or **bold** — the consolidator ranks by these.

The sleep cycle (`node ${CLAUDE_SKILL_DIR}/scripts/sleep.js`) runs automatically at session start when the last one is >20 h old, or from cron. It:

1. **Reviews pathways** — weights move toward the evidence only when there is new evidence; unused pathways decay per day; dead ones are archived to `weights/pruned.json`.
2. **Dreams** — new facts from daily notes go into `.brain/MEMORY.md` (deduplicated, ranked); proven pathways become a generated "Learned rules" block; old sections over the cap move to `memory/archive.md`.

If `CLAUDE.md` imports `@.brain/MEMORY.md`, the consolidated memory and rules load in every session.

## Other commands

```bash
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js review    # one review cycle now
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js promote   # pathways proven enough to become written rules (JSON)
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js prune     # archive dead pathways now
node ${CLAUDE_SKILL_DIR}/scripts/cortex-review.js where     # which brain directory is in use
```

## Setup (if `.brain/` doesn't exist yet)

```bash
node ${CLAUDE_SKILL_DIR}/scripts/install.js --claude-md
```

Creates `.brain/`, adds the hooks to `.claude/settings.json` (merging, never overwriting), and imports MEMORY.md into CLAUDE.md. Ask the user before running it.

## Files

```
.brain/
├── weights/pathways.json   # core state (commit it)
├── weights/pruned.json     # archive of pruned pathways
├── mutations/*.jsonl       # append-only audit log of every change — never edit or delete
├── MEMORY.md               # consolidated long-term memory + generated rules
├── memory/YYYY-MM-DD.md    # daily episodic notes
├── memory/archive.md       # evicted old consolidations
└── signals/                # pending outcome signals (local, gitignored)
```

Using brainmd outside Claude Code (OpenClaw, LangChain, a raw API loop)? See the README's Integration section; the CLI is the same.
