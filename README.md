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
   forms when applicable. Every candidate is weighed by its real zlib size plus
   its PLTE/tRNS chunk overhead.
4. **Per-row filter choice** — for every row, all five PNG filters are tried and
   the best is kept by **brute force** (each trial compressed with the preceding
   32 KiB as dictionary), alongside the minimum-sum and fewest-distinct-pairs
   heuristics and the fixed filters.
5. **Deflate** — the two best screened candidates are re-compressed at zlib
   level 9 with several variants (memLevel 7/8/9, default/filtered strategy) and
   the smallest stream wins. A **custom optimal-parse DEFLATE encoder** is then
   run on the winning candidate's filtered data and kept whenever it beats
   zlib-9. On small inputs (≤ 1 MiB of filtered data) it uses a Pareto-frontier
   matcher (up to 3 non-dominated (length, distance) pairs per position, from
   4-byte and 8-byte hash chains plus match propagation, with a shortest-path
   DP that tries each pair at full length and at length 3); on larger inputs
   it uses the faster legacy single-best-match parser (3-byte hash, chain cap
   128). Both iterate Huffman length estimation over 5 rounds, use
   length-limited Huffman codes capped at 15 bits and completed to Kraft = 1,
   and emit dynamic/fixed blocks. A single zlib stream is written into one
   IDAT chunk with a hand-rolled CRC-32.
6. **Deterministic** — no clock, no randomness, fixed iteration order; two runs
   produce byte-identical outputs (verified with sha256).

## Run

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

One run answers all 8 instances (`<id>/image.png`) in ~50 s on one CPU,
inside the 60 s wall budget.

## Practice-set results

Scored with the kit's own checker against `practice/reference/manifest.json`
(scale = make.fun's scale compressor; floor = 2× scale; target = scale/2;
points = 1000 × (floor − bytes) / (floor − target)):

| id | theme | bytes | scale | floor | target | points |
|----|-------|------:|------:|------:|------:|-------:|
| i001 | flat  | 12,106 | 13,547 | 27,094 | 6,773 | 737.64 |
| i002 | rich  | 51,391 | 55,063 | 110,126 | 27,531 | 711.12 |
| i003 | alpha | 100,757 | 107,892 | 215,784 | 53,946 | 710.79 |
| i004 | grey  | 99,048 | 110,521 | 221,042 | 55,260 | 735.89 |
| i005 | flat  | 15,709 | 18,669 | 37,338 | 9,334 | 772.42 |
| i006 | rich  | 171,294 | 185,295 | 370,590 | 92,647 | 717.04 |
| i007 | alpha | 60,724 | 64,285 | 128,570 | 32,142 | 703.59 |
| i008 | grey  | 23,871 | 26,807 | 53,614 | 13,403 | 739.68 |

**Total practice-set score: 728,500** (mean 728.5 points/instance) — below the
scale compressor's size on all 8 instances, and well above the house baseline
`fixed-paeth` (420,399 on the same set). The frontier optimal-parse DEFLATE
stage lifts the four smallest images (i001, i004, i005, i008) well above the
zlib-9-only result; the larger images keep the legacy optimal-parse result,
which still beats zlib-9 on i003 and i006.

## License

MIT — see [LICENSE](LICENSE).
