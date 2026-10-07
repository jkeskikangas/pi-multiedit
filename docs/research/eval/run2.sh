#!/bin/sh
# usage: run2.sh <task> <tag> <harness: builtin|hashline|multi|native> <model> [rep]
E=$(cd "$(dirname "$0")" && pwd); T=$1; TAG=$2; H=$3; M=$4; R=${5:-1}; D=$E/runs/$T-$TAG-$H-r$R
rm -rf "$D" && git clone -q "$E/fixtures/$T" "$D"
P=$(cat "$E/prompts/$T.txt")
CS=~/.pi/agent/npm/node_modules/pi-claude-subscription/src/index.ts
ME=~/work/pi-multiedit/index.ts; HL=~/work/lh/pi-hashline-edit/index.ts
case $M in claude-*) PROV=claude-sdk; EXT="-e $CS" ;; *) PROV=openai-codex; EXT="" ;; esac
start=$(date +%s); cd "$D" || exit 1
case $H in
  builtin)  perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT --model $PROV/$M:low --mode json -p "$P" ;;
  hashline) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $HL --model $PROV/$M:low --mode json -p "$P" ;;
  multi)    perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  one)      TYPESAFE_API_KEY=$(cat ~/.config/typesafe/api_key) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  two)      PI_MULTIEDIT_GREP=1 TYPESAFE_API_KEY=$(cat ~/.config/typesafe/api_key) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  cur)      PI_MULTIEDIT_GREP=1 PI_MULTIEDIT_BASH_READS=1 TYPESAFE_API_KEY=$(cat ~/.config/typesafe/api_key) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  off)      PI_MULTIEDIT_GREP=1 PI_MULTIEDIT_BLAST=0 PI_MULTIEDIT_SHAPE=0 TYPESAFE_API_KEY=$(cat ~/.config/typesafe/api_key) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
  base|seed|cache|compact)
    case $H in seed) X="PI_MULTIEDIT_SEED=1" ;; cache) X="PI_MULTIEDIT_CACHE_KEY=1" ;; compact) X="PI_MULTIEDIT_COMPACT=1" ;; *) X="PI_MULTIEDIT_NONE=1" ;; esac
    env $X PI_MULTIEDIT_GREP=1 TYPESAFE_API_KEY=$(cat ~/.config/typesafe/api_key) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $ME --model $PROV/$M:low --mode json -p "$P" ;;
multi027) perl -e 'alarm 360; exec @ARGV' pi -ne -nc -ns -np --no-session $EXT -e $E/multiedit-027/index.ts --model $PROV/$M:low --mode json -p "$P" ;;
  native)
    case $M in
      claude-*) perl -e 'alarm 360; exec @ARGV' claude -p "$P" --model $M --effort low --output-format stream-json --verbose \
                  --setting-sources "" --strict-mcp-config --no-session-persistence \
                  --tools "Bash,Read,Edit,Write,Glob,Grep" --allowedTools "Bash,Read,Edit,Write,Glob,Grep" --permission-mode acceptEdits ;;
      *) CODEX_HOME=$E/codex-home perl -e 'alarm 360; exec @ARGV' codex exec --json -m $M -c model_reasoning_effort=low \
                  -s workspace-write --skip-git-repo-check --ephemeral "$P" ;;
    esac ;;
esac < /dev/null > "$D.jsonl" 2> "$D.err"
echo "$? $(( $(date +%s) - start ))" > "$D.exit"
