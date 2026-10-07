#!/bin/sh
E=$(cd "$(dirname "$0")" && pwd)
{ for r in 3 4 5 6; do for t in e1 e2 e3 e4; do for m in "opus claude-opus-5-5" "sonnet claude-sonnet-5-5" "sol61 gpt-6.1-sol" "luna gpt-6-luna"; do for h in multi jev3; do set -- $m; echo "$t $1 $h $2 $r"; done; done; done; done; } | xargs -P 4 -L 1 sh -c 'sh "'$E'/run_l.sh" $0 $1 $2 $3 $4; echo "done $0 $1 $2 r$4 $(cat '$E'/runs/$0-$1-$2-r$4.exit)"'
