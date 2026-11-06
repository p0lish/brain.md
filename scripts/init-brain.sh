#!/bin/bash
# Initialize a blank BRAIN.md structure
# Usage: ./init-brain.sh [path]

BRAIN_DIR="${1:-./brain}"

echo "🧠 Initializing BRAIN.md at: $BRAIN_DIR"

mkdir -p "$BRAIN_DIR"/{reflexes,habits,skills,weights,cortex,mutations,memory}

# Create blank pathways file
cat > "$BRAIN_DIR/weights/pathways.json" << 'EOF'
{
  "version": 1,
  "created": "",
  "description": "Pathway strength tracker. Higher weight = more reinforced behavior.",
  "pathways": {}
}
EOF

# Stamp creation time
# (portable: GNU and BSD sed disagree on -i)
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sed "s/\"created\": \"\"/\"created\": \"$STAMP\"/" "$BRAIN_DIR/weights/pathways.json" > "$BRAIN_DIR/weights/pathways.json.tmp" \
  && mv "$BRAIN_DIR/weights/pathways.json.tmp" "$BRAIN_DIR/weights/pathways.json"

# Create blank preferences
cat > "$BRAIN_DIR/habits/preferences.json" << 'EOF'
{
  "version": 1,
  "description": "Learned preferences. Evolves with each interaction.",
  "communication": {},
  "lifestyle": {},
  "technical": {}
}
EOF

# Copy cortex engine
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$SCRIPT_DIR/scripts/cortex-review.js" ]; then
  cp "$SCRIPT_DIR/scripts/cortex-review.js" "$BRAIN_DIR/cortex/review.js"
  chmod +x "$BRAIN_DIR/cortex/review.js"
fi

# Copy the dream (memory consolidation) and sleep scripts next to the cortex.
# They require ./cortex-review.js, so the cortex is also copied under that name.
for f in cortex-review.js dream.js sleep.js; do
  [ -f "$SCRIPT_DIR/scripts/$f" ] && cp "$SCRIPT_DIR/scripts/$f" "$BRAIN_DIR/cortex/$f"
done

# Copy reflex templates
if [ -f "$SCRIPT_DIR/scripts/reflex-timing.js" ]; then
  cp "$SCRIPT_DIR/scripts/reflex-timing.js" "$BRAIN_DIR/reflexes/timing.js"
  chmod +x "$BRAIN_DIR/reflexes/timing.js"
fi

# Create README
cat > "$BRAIN_DIR/README.md" << 'EOF'
# BRAIN.md

*Self-modifying file system mimicking neuroplasticity.*

See SKILL.md for full documentation.

## Quick Commands

```bash
# Record an outcome
node cortex/review.js record "reflex:my-pattern" true "What happened"

# Run self-review
node cortex/review.js review

# Check status
node cortex/review.js status
```

## Getting Started

1. Observe your agent's behavior for a session
2. Identify patterns that worked or failed
3. Record them as pathways
4. Wire cortex review into your heartbeat/cron
5. Let it evolve
EOF

echo "✅ BRAIN.md initialized"
echo ""
echo "Next steps:"
echo "  1. Seed pathways: node $BRAIN_DIR/cortex/review.js record 'reflex:my-pattern' true 'Description'"
echo "  2. Run review:    node $BRAIN_DIR/cortex/review.js review"
echo "  3. Check status:  node $BRAIN_DIR/cortex/review.js status"
