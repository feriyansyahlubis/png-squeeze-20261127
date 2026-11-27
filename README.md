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
   the smallest stream wins. A **custom optimal-parse DEFLATE encoder** (hash-chain
   longest-match finder + shortest-path dynamic-programming parse, iterated
   Huffman length estimation over 5 rounds, length-limited Huffman codes capped
   at 15 bits and completed to Kraft = 1, dynamic/fixed blocks) is then run on
   the winning candidate's filtered data and kept whenever it beats zlib-9.
   A single zlib stream is written into one IDAT chunk with a hand-rolled
   CRC-32.
6. **Deterministic** — no clock, no randomness, fixed iteration order; two runs
   produce byte-identical outputs (verified with sha256).

## Run

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

One run answers all 8 instances (`<id>/image.png`) in ~36 s on one CPU,
inside the 60 s wall budget.

## Practice-set results

Scored with the kit's own checker against `practice/reference/manifest.json`
(scale = make.fun's scale compressor; floor = 2× scale; target = scale/2;
points = 1000 × (floor − bytes) / (floor − target)):

| id | theme | bytes | scale | floor | target | points |
|----|-------|------:|------:|------:|------:|-------:|
| i001 | flat  | 12,496 | 13,547 | 27,094 | 6,773 | 718.37 |
| i002 | rich  | 51,391 | 55,063 | 110,126 | 27,531 | 711.12 |
| i003 | alpha | 100,757 | 107,892 | 215,784 | 53,946 | 710.79 |
| i004 | grey  | 102,344 | 110,521 | 221,042 | 55,260 | 715.99 |
| i005 | flat  | 16,528 | 18,669 | 37,338 | 9,334 | 743.11 |
| i006 | rich  | 171,294 | 185,295 | 370,590 | 92,647 | 717.04 |
| i007 | alpha | 60,724 | 64,285 | 128,570 | 32,142 | 703.59 |
| i008 | grey  | 24,835 | 26,807 | 53,614 | 13,403 | 715.70 |

**Total practice-set score: 717,000** (mean 717.0 points/instance) — below the
scale compressor's size on all 8 instances, and well above the house baseline
`fixed-paeth` (420,399 on the same set). The optimal-parse DEFLATE stage is
what lifts the three largest images (i003, i004, i006) above the zlib-9-only
result; the other five instances keep their zlib-9 stream.

## License

MIT — see [LICENSE](LICENSE).
