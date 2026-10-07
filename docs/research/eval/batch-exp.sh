#!/bin/sh
cd "$(dirname "$0")"
m() { case $1 in opus) echo claude-opus-5-5;; sonnet) echo claude-sonnet-5-5;; sol) echo gpt-6-sol;; luna) echo gpt-6-luna;; esac; }
# cache arm: sequential per GPT model, so each session can reuse the previous one's prefix
for mod in sol luna; do (for r in 1 2; do for t in x1 x2 x3 x4 r1 r2 r3 r4; do sh run2.sh $t $mod cache $(m $mod) $r; done; done) & done
for r in 1 2; do for t in x1 x2 x3 x4 r1 r2 r3 r4; do for mod in opus sonnet sol luna; do for a in base seed compact; do
  echo "$t $mod $a $(m $mod) $r"; done; done; done; done | xargs -P 8 -n 5 sh run2.sh
wait
echo done
