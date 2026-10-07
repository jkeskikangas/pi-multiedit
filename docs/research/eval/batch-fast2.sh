#!/bin/sh
E=$(cd "$(dirname "$0")" && pwd)
{ for r in 3 4 5 6; do for t in e1 e2 e3 e4; do for h in multifast_med jev3fast_med multifast_high jev3fast_high; do echo "$t luna $h gpt-6-luna $r"; done; done; done; } | xargs -P 4 -L 1 sh -c 'sh "'$E'/run_l.sh" $0 $1 $2 $3 $4; echo "done $0 $1 $2 r$4 $(cat '$E'/runs/$0-$1-$2-r$4.exit)"'
