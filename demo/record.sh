#!/usr/bin/env bash
#
# Record demo/demo.gif for the README.
#
#   brew install asciinema agg tmux
#   ./demo/record.sh
#
# The picker runs against demo/demo.mjs, which supplies a fixture, so the
# recording never contains real sessions. tmux provides the terminal that
# asciinema records and that the keystrokes below are typed into; asciinema is
# the session's only command, so no shell prompt ends up in the frame.
set -euo pipefail

cd "$(dirname "$0")/.."

COLS=${COLS:-104}
ROWS=${ROWS:-27}
SESSION=csm-demo
CAST=${CAST:-$(mktemp -u -t csm-demo-XXXXXX).cast}
GIF=demo/demo.gif

for tool in tmux asciinema agg; do
  command -v "$tool" >/dev/null || { echo "missing: $tool (brew install asciinema agg tmux)" >&2; exit 1; }
done

key() { tmux send-keys -t "$SESSION" "$@"; }
# Type a string one character at a time, so the recording shows it being typed.
type_out() {
  local text=$1 i
  for ((i = 0; i < ${#text}; i++)); do
    tmux send-keys -t "$SESSION" -l "${text:i:1}"
    sleep 0.07
  done
}

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$PWD" -e CSM_DEMO_PROMPT=1 \
  "asciinema rec -q --overwrite -f asciicast-v2 --window-size ${COLS}x${ROWS} -c 'node demo/demo.mjs' '$CAST'"

# Every session on the machine, whichever directory it came from.
sleep 3.0
sleep 3.0

# The preview panel tells two similar titles apart.
key p
sleep 3.0
key p
sleep 1.0

# Search across all of them, not just the current directory.
tmux send-keys -t "$SESSION" -l "/"
sleep 0.5
type_out "billing"
sleep 2.5
key Enter
sleep 1.5

# Drop onto the infra session, which lives in a different directory entirely.
key j
sleep 2.2

# And resume it.
key Enter
sleep 2.5

# asciinema is the session's only command, so the session ends when it does.
for _ in $(seq 1 40); do
  tmux has-session -t "$SESSION" 2>/dev/null || break
  sleep 0.5
done
tmux kill-session -t "$SESSION" 2>/dev/null || true

[ -s "$CAST" ] || { echo "no recording was produced" >&2; exit 1; }

agg --theme asciinema --font-size 16 --line-height 1.35 --fps-cap 20 \
    --idle-time-limit 1.5 --last-frame-duration 2 \
    "$CAST" "$GIF"

if [ -z "${KEEP_CAST:-}" ]; then rm -f "$CAST"; fi
echo "wrote $GIF ($(du -h "$GIF" | cut -f1))"
