#!/usr/bin/env bash
# Drive a real interactive `claude` with this checkout's footprint plugin, inside tmux.
# Usage: drive.sh <subcommand> <name> [args]   (name: short tag, e.g. run1)
#   launch <name>            start tmux session fpv-<name>, wait for the prompt
#   doctor <name>            read-only health check of that instance
#   send <name> <text>       type text into the prompt and press Enter
#   wait <name> [secs]       wait until the turn ends (default 180s); exit 3 on a permission prompt
#   keys <name> <key>...     send tmux keys one by one; `focus` = ctrl+x tab (focus the pane)
#   pane <name>              print only the footprint pane column of the screen
#   capture <name> <label>   save the full screen to the evidence dir as <label>.txt
#   export <name>            run /map export, copy the trace into the evidence dir
#   teardown <name>          kill only fpv-<name> and its scratch dir; evidence stays
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cmd="${1:?subcommand}"
name="${2:?name}"
sess="fpv-${name}"
scratch="${TMPDIR:-/tmp}/fpv-${name}"
evidence="${HOME}/.claude/footprint/verify/${name}"

screen() { tmux capture-pane -p -J -t "$sess"; }
nap() { perl -e "select(undef,undef,undef,$1)"; }
# A custom statusline can hide "esc to interrupt"; the spinner line ("Musing… (8s ·") stays.
# Also "Shimmying… (running Stop hooks… 2/3", so match any "… (".
# The spinner blinks off between tool calls, so `wait` needs 3 quiet seconds in a row.
busy() { screen | grep -Eq 'esc to interrupt|… \(|Running [0-9]+ shell command'; }

case "$cmd" in
launch)
  if tmux has-session -t "$sess" 2>/dev/null; then
    echo "refusing: $sess already exists (teardown it or pick another name)" >&2
    exit 1
  fi
  mkdir -p "$scratch" "$evidence"
  # Empty AWS/kube config: every aws/kubectl call, the nested Claude's and the mod's own
  # account/context lookups, fails locally and can never reach a real account or cluster.
  : >"$scratch/aws-config"
  : >"$scratch/aws-credentials"
  : >"$scratch/kubeconfig"
  uuidgen | tr 'A-Z' 'a-z' >"$scratch/session-id"
  cp "$scratch/session-id" "$evidence/session-id"
  tmux new-session -d -s "$sess" -x 220 -y 60 -c "$REPO" \
    -e CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
    -e AWS_CONFIG_FILE="$scratch/aws-config" \
    -e AWS_SHARED_CREDENTIALS_FILE="$scratch/aws-credentials" \
    -e KUBECONFIG="$scratch/kubeconfig"
  # Typed into the interactive shell on purpose: the user's `claude` alias carries auth env.
  tmux send-keys -t "$sess" "claude --plugin-dir '$REPO' --session-id $(cat "$scratch/session-id") --model haiku" Enter
  # Startup waits on the user's MCP servers; 30s was not always enough.
  for _ in $(seq 1 90); do
    nap 1
    if screen | grep -q '^❯'; then echo "ready: $sess (session $(cat "$scratch/session-id"))"; exit 0; fi
  done
  echo "not ready after 90s (still in tmux; inspect, then teardown); screen:" >&2
  screen | tail -20 >&2
  exit 1
  ;;
doctor)
  tmux has-session -t "$sess" 2>/dev/null || { echo "FAIL no tmux session $sess"; exit 1; }
  echo "ok   tmux session $sess"
  echo "info pane command: $(tmux display -p -t "$sess" '#{pane_current_command}')"
  [ -f "$scratch/session-id" ] && echo "ok   session id $(cat "$scratch/session-id")" || echo "FAIL no session id in $scratch"
  echo "info env: $(tmux show-environment -t "$sess" CLAUDE_CODE_ENABLE_FUNCTION_HOOKS 2>&1) $(tmux show-environment -t "$sess" AWS_CONFIG_FILE 2>&1)"
  screen | grep -q 'Claude Code v' && echo "ok   claude banner: $(screen | grep -o 'Claude Code v[0-9.]*' | head -1)" || echo "warn no claude banner on screen (scrolled off or not started)"
  screen | grep -q '\[ all \] \[ write \] \[ turn \]' && echo "ok   footprint pane is open" || echo "info footprint pane not open (send /map)"
  busy && echo "info a turn is running" || echo "ok   idle at prompt"
  ;;
send)
  text="${3:?text}"
  tmux send-keys -t "$sess" -l "$text"
  # Slash commands open an autocomplete menu; give it a beat before Enter.
  nap 0.8
  tmux send-keys -t "$sess" Enter
  ;;
wait)
  limit="${3:-180}"
  # The spinner can take a while to show (user's UserPromptSubmit hooks ran 5s+); then wait for it to go.
  for _ in $(seq 1 60); do busy && break; screen | grep -q 'Do you want' && break; nap 0.5; done
  quiet=0
  for _ in $(seq 1 "$limit"); do
    if screen | grep -q 'Do you want'; then
      echo "permission prompt is up; answer it or deny it:" >&2
      screen | tail -15 >&2
      exit 3
    fi
    if busy; then quiet=0; else quiet=$((quiet + 1)); fi
    [ "$quiet" -ge 3 ] && { echo "idle"; exit 0; }
    nap 1
  done
  echo "still busy after ${limit}s" >&2
  exit 1
  ;;
keys)
  # tmux key names, one at a time: `focus` (= ctrl+x tab, focuses the pane), Tab, Enter, Escape, l, w, ...
  shift 2
  for k in "$@"; do
    if [ "$k" = focus ]; then tmux send-keys -t "$sess" C-x; nap 0.3; k=Tab; fi
    tmux send-keys -t "$sess" "$k"
    nap 0.3
  done
  nap 0.5
  ;;
pane)
  # Just the footprint pane column (right of the vertical divider), blank lines dropped.
  screen | grep -o '│.*' | grep -v '^│[[:space:]]*$' || true
  ;;
capture)
  label="${3:?label}"
  mkdir -p "$evidence"
  screen >"$evidence/$label.txt"
  echo "$evidence/$label.txt"
  ;;
export)
  id="$(cat "$scratch/session-id")"
  trace="${HOME}/.claude/footprint/trace-${id}.jsonl"
  # A second export in one session overwrites the file: wait for a new mtime, not just a file.
  before="$(stat -f %m "$trace" 2>/dev/null || echo 0)"
  "$0" send "$name" "/map export"
  for _ in $(seq 1 20); do [ "$(stat -f %m "$trace" 2>/dev/null || echo 0)" != "$before" ] && break; nap 0.5; done
  [ "$(stat -f %m "$trace" 2>/dev/null || echo 0)" != "$before" ] || { echo "no new trace written at $trace" >&2; exit 1; }
  cp "$trace" "$evidence/trace.jsonl"
  echo "$evidence/trace.jsonl"
  ;;
teardown)
  tmux kill-session -t "$sess" 2>/dev/null && echo "killed $sess" || echo "no session $sess"
  rm -rf "$scratch"
  echo "evidence kept: $evidence"
  ;;
*)
  echo "unknown subcommand: $cmd" >&2
  exit 2
  ;;
esac
