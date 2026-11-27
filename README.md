# PNG Squeeze — smallest lossless PNG for 1280×720 screenshots

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/feriyansyahlubis/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/feriyansyahlubis/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for the make.fun bounty **"Squeeze screenshots into the smallest PNG, 27 November 2026"**
(`png-squeeze-01-run-20261127`). A single self-contained `main.ts` (Node 22, no
dependencies, only built-in `node:zlib` / `node:fs` / `node:path`) that re-encodes
each 1280×720 RGBA screenshot losslessly — pixel-exact in every channel,
including the colour of fully transparent pixels — in as few bytes as possible.

## Approach

1. **Own PNG decoder** — parses IHDR/IDAT, inflates, and unfilters the stored
   input PNG back to RGBA.
2. **Image analysis** — opaque? grey (R = G = B on every pixel)? number of unique
   colours (≤ 256 → palette)? a single transparent value no opaque pixel uses
   (→ `tRNS` key instead of an alpha channel)?
3. **Colour-type screen** — palette (type 3, transparent entries first so `tRNS`
   stays short, remaining entries by count or by luminance) when ≤ 256 colours;
   grey (0) / grey+alpha (4) when grey; RGB (2) / RGBA (6) otherwise; `tRNS` key
   forms when applicable. Every candidate is first weighed by a fast level-1
   zlib size, the best five are re-weighed at level 6, and the winner is
   chosen by that size plus its PLTE/tRNS chunk overhead.
4. **Per-row filter choice** — for every row, all five PNG filters are tried and
   the best is kept by **brute force** (each trial compressed with the preceding
   32 KiB as dictionary), alongside the minimum-sum and fewest-distinct-pairs
   heuristics and the fixed filters.
5. **Deflate** — the best screened candidate(s) are re-compressed at zlib
   level 9 (a single memLevel-9 default-strategy variant) and the smallest
   stream wins.
   A **custom optimal-parse DEFLATE encoder** is then
   run on the winning candidate's filtered data and kept whenever it beats
   zlib-9. On small inputs (≤ 1 MiB of filtered data) it uses a Pareto-frontier
   matcher (up to 3 non-dominated (length, distance) pairs per position, from
   4-byte and 8-byte hash chains plus match propagation, with a shortest-path
   DP that tries each pair at full length and at length 3, and measures match
   lengths 4 bytes at a time); on larger inputs
   it uses the faster legacy single-best-match parser (3-byte hash, chain cap
   128). Both iterate Huffman length estimation over 2 global rounds plus 1
   warm-started per-block round, use
   length-limited Huffman codes capped at 15 bits and completed to Kraft = 1,
   and emit dynamic/fixed blocks. A single zlib stream is written into one
   IDAT chunk with a hand-rolled CRC-32. The candidate screen ranks all
   candidates with a fast level-1 deflate and re-ranks the best five at
   level 6; the final zlib stage tries a single level-9 variant. The
   hash-chain walk is capped at 128/16 links so a run stays well inside the
   grader's 60 s wall budget on a single CPU (Round 3 at cap 1024/128 was
   rejected for timeout on the grader despite taking ~53 s on the dev VM).
6. **Deterministic** — no clock, no randomness, fixed iteration order; two runs
   produce byte-identical outputs (verified with sha256).

## Run

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

One run answers all 8 instances (`<id>/image.png`) in ~42 s on the dev VM
(~54 s projected on the grader's single CPU), inside the 60 s wall budget.

## Practice-set results

Scored with the kit's own checker against `practice/reference/manifest.json`
(scale = make.fun's scale compressor; floor = 2× scale; target = scale/2;
points = 1000 × (floor − bytes) / (floor − target)):

| id | theme | bytes | scale | floor | target | points |
|----|-------|------:|------:|------:|------:|-------:|
| i001 | flat  | 12,119 | 13,547 | 27,094 | 6,773 | 736.90 |
| i002 | rich  | 50,402 | 55,063 | 110,126 | 27,531 | 723.10 |
| i003 | alpha | 99,572 | 107,892 | 215,784 | 53,946 | 718.10 |
| i004 | grey  | 98,001 | 110,521 | 221,042 | 55,260 | 742.20 |
| i005 | flat  | 16,408 | 18,669 | 37,338 | 9,334 | 747.40 |
| i006 | rich  | 171,685 | 185,295 | 370,590 | 92,647 | 715.60 |
| i007 | alpha | 60,379 | 64,285 | 128,570 | 32,142 | 707.20 |
| i008 | grey  | 24,390 | 26,807 | 53,614 | 13,403 | 726.80 |

**Total practice-set score: 727,200** (mean 727.2 points/instance) — below the
scale compressor's size on all 8 instances, and well above the house baseline
`fixed-paeth` (420,399 on the same set). The frontier optimal-parse DEFLATE
stage lifts the four smallest images (i001, i004, i005, i008) well above the
zlib-9-only result; the larger images keep the legacy optimal-parse result,
which still beats zlib-9 on i003 and i006. The hash-chain walk is capped at
128/16 links and the DP at 2 global + 1 per-block rounds so the run stays
~42 s on the dev VM and inside the grader's 60 s single-CPU budget — a
deeper walk (cap 1024/128, practice 735.8) scored higher locally but timed
out on the grader and was rejected, so this revision trades a few points
for a run that completes.

## License

MIT — see [LICENSE](LICENSE).
