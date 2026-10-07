#!/bin/sh
E=$(cd "$(dirname "$0")" && pwd)
{ for r in 1 2; do for t in e1 e2 e3 e4 x1 x2 x3 x4 b1 b2; do for m in "sonnet claude-sonnet-5-5" "opus claude-opus-5-5"; do set -- $m; echo "$t $1 jev $2 $r"; done; done; done; } | xargs -P 4 -L 1 sh -c 'sh "'$E'/run_l.sh" $0 $1 $2 $3 $4; echo "done $0 $1 $2 r$4 $(cat '$E'/runs/$0-$1-$2-r$4.exit)"'
