#!/bin/bash
# Capture → mock plugin → preview/original diff for a list of "name url viewport" lines.
cd "$(dirname "$0")/.."
mkdir -p .exp/batch
while read -r name url vp; do
  [ -z "$name" ] && continue
  out=".exp/batch/$name"
  if ! timeout 150 node scripts/capture-cli.js "$url" "$vp" "$out.json" > "$out.log" 2>&1; then echo "$name: CAPTURE FAILED ($(tail -1 $out.log))"; continue; fi
  plugin=$(node test/run-plugin.js "$out.json" 2>&1 | grep -E '"errors"|created' | tr -d '\n ')
  timeout 200 node scripts/preview.js "$out.json" "$out" --original > /dev/null 2>&1
  diff=$(python3 scripts/compare.py "$out" 2>/dev/null | head -1)
  echo "$name: $(grep -o '"stats":{[^}]*}' $out.log) | $plugin | $diff"
done
