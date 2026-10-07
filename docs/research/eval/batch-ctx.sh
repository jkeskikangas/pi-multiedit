#!/bin/sh
E=$(cd "$(dirname "$0")" && pwd)
{ for r in 1 2; do for t in e1 e2 e3 e4; do echo "$t sonnet ctx claude-sonnet-5-5 $r"; done; done; for t in e1 e2 e3 e4; do echo "$t opus ctx claude-opus-5-5 1"; done; } | xargs -P 4 -L 1 sh -c 'sh "'$E'/run_l.sh" $0 $1 $2 $3 $4; echo "done $0 $1 $2 r$4 $(cat '$E'/runs/$0-$1-$2-r$4.exit)"'
