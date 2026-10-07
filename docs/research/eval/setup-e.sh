#!/bin/sh
# usage: setup-e.sh <dir> <sha>
set -e
d=$1; sha=$2
git clone -q --shared /Users/pyykkis/work/treat "$d"
git -C "$d" checkout -q "$sha"
cd "$d"
find . -path ./.git -prune -o \( -name AGENTS.md -o -name CLAUDE.md \) -print | xargs rm -f
rm -rf .claude .codex .pi opencode.json
git add -A
git -c user.name=eval -c user.email=eval@local commit -q -m "eval: strip agent config" || true
git status --porcelain | head
