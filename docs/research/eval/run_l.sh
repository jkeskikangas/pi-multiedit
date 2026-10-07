#!/bin/sh
# usage: run_l.sh <task> <tag> <arm: multi|retire|builtin|native> <model> [rep]   arms: retire = multi + retire extension (PI_RETIRE_K/N/B from env)
E=$(cd "$(dirname "$0")" && pwd); T=$1; TAG=$2; H=$3; M=$4; R=${5:-1}; D=$E/runs/$T-$TAG-$H-r$R
rm -rf "$D" && git clone -q "$E/fixtures/$T" "$D"
P=$(cat "$E/prompts/$T.txt")
CS=~/.pi/agent/npm/node_modules/pi-claude-subscription/src/index.ts
ME=~/work/pi-multiedit/index.ts; RT=$E/retire/index.ts; S=$E
case $M in claude-*) PROV=claude-sdk; EXT="-e $CS" ;; *) PROV=openai-codex; EXT="" ;; esac
start=$(date +%s); cd "$D" || exit 1
case $H in
  builtin) perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT --model $PROV/$M:low --mode json -p "$P" ;;
  multi)   perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  multifast_med) perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/fast/index.ts --model $PROV/$M:medium --mode json -p "$P" ;;
  jev3fast_med)  PI_JEV_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/jevseed/index.ts -e $S/fast/index.ts --model $PROV/$M:medium --mode json -p "$P" ;;
  multifast_high) perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/fast/index.ts --model $PROV/$M:high --mode json -p "$P" ;;
  jev3fast_high)  PI_JEV_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/jevseed/index.ts -e $S/fast/index.ts --model $PROV/$M:high --mode json -p "$P" ;;
  multifast) perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/fast/index.ts --model $PROV/$M:max --mode json -p "$P" ;;
  jev3fast)  PI_JEV_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/jevseed/index.ts -e $S/fast/index.ts --model $PROV/$M:max --mode json -p "$P" ;;
  jev|jev2|jev3)     PI_JEV_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/jevseed/index.ts --model $PROV/$M:low --mode json -p "$P" ;;
  ctx|ctx2)     PI_CONTEXT_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $S/context/index.ts --model $PROV/$M:low --mode json -p "$P" ;;
  retire)  PI_RETIRE_LOG=1 perl -e 'alarm 900; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME -e $RT --model $PROV/$M:low --mode json -p "$P" ;;
  native)  perl -e 'alarm 900; exec @ARGV' claude -p "$P" --model $M --effort low --output-format stream-json --verbose \
             --setting-sources "" --strict-mcp-config --no-session-persistence \
             --tools "Bash,Read,Edit,Write,Glob,Grep" --allowedTools "Bash,Read,Edit,Write,Glob,Grep" --permission-mode acceptEdits ;;
esac < /dev/null > "$D.jsonl" 2> "$D.err"
echo "$? $(( $(date +%s) - start ))" > "$D.exit"
