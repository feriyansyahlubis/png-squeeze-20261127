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
   zlib-9. On small inputs (≤ 1 MiB of filtered data) it uses a **hybrid
   Pareto-frontier matcher** (up to 3 non-dominated (length, distance) pairs
   per position, from a short 4-byte/8-byte hash-chain walk for NEAR matches
   plus a suffix-array + LCP scan for LONG matches, with match propagation,
   and a shortest-path DP that tries each pair at full length and at length 3,
   measuring match lengths 4 bytes at a time); on larger inputs
   it uses the faster legacy single-best-match parser (3-byte hash, chain cap
   128). Both iterate Huffman length estimation over 2 global rounds plus 1
   warm-started per-block round, use
   length-limited Huffman codes capped at 15 bits and completed to Kraft = 1,
   and emit dynamic/fixed blocks. **Adaptive block splitting (zopfli-style)**
   runs inside `bestOfBoth`: each of the 4 blocks is tested for a split at
   1/16-token intervals (plus a recursive second pass on the sub-blocks)
   using a token-frequency + header-bit estimate, and a block is split only
   when the estimated gain clears 96 bits; the per-block refine then
   re-parses each half with its own warm-start Huffman table, and the
   smaller of the global / split streams wins. A single zlib stream is
   written into one
   IDAT chunk with a hand-rolled CRC-32. The candidate screen ranks all
   candidates with a fast level-1 deflate and re-ranks the best five at
   level 6; the final zlib stage tries a single level-9 variant. The hybrid
   matcher (short chain cap 16/4 + SA scan of 16 neighbours per direction)
   replaces the plain hash-chain walk on small inputs: a pure SA scan alone
   misses near matches and scores far worse, and a pure chain walk misses
   long far matches — together they beat either alone. The run stays ~40 s
   on the dev VM and inside the grader's 60 s single-CPU budget (Round 3 at
   cap 1024/128 was rejected for timeout on the grader despite taking ~53 s
   on the dev VM).
   Three further structural changes (Round 7): (a) in the DP's last round,
   the longest frontier pair also tries **every** match length 3..L (not just
   the DEFLATE base lengths) when L ≤ 128 — the landing position matters,
   and lengths inside one length symbol cost the same bits (+3.1 mean at
   ~zero time cost); (b) the large-input reference parse runs **without**
   full-length tries, so its token starts cover more useful positions for
   the sparse frontier's deep walk, and it saves ~1 s per large input;
   (c) **rank-64 long matches** on large inputs: prefix-doubling ranks
   stopped after the k=32 iteration distinguish suffixes by their first 64
   bytes, so a sweep keeping the nearest two previous positions per rank
   finds far ≥64-byte matches the hash-chain walk misses (true lengths
   always measured directly, never trusted from the rank), at ~0.5 s per
   large input.
6. **Deterministic** — no clock, no randomness, fixed iteration order; two runs
   produce byte-identical outputs (verified with sha256).

## Run

```sh
node main.ts   # reads $MAKEFUN_INPUT_DIR (default /input), writes $MAKEFUN_OUTPUT_DIR (default /output)
```

One run answers all 8 instances (`<id>/image.png`) in ~40 s on the dev VM
(~51 s projected on the grader's single CPU), inside the 60 s wall budget.

## Practice-set results

Scored with the kit's own checker against `practice/reference/manifest.json`
(scale = make.fun's scale compressor; floor = 2× scale; target = scale/2;
points = 1000 × (floor − bytes) / (floor − target)):

| id | theme | bytes | scale | floor | target | points |
|----|-------|------:|------:|------:|------:|-------:|
| i001 | flat  | 11,101 | 13,547 | 27,094 | 6,773 | 787.00 |
| i002 | rich  | 49,340 | 55,063 | 110,126 | 27,531 | 736.00 |
| i003 | alpha | 97,925 | 107,892 | 215,784 | 53,946 | 728.30 |
| i004 | grey  | 96,559 | 110,521 | 221,042 | 55,260 | 750.90 |
| i005 | flat  | 14,886 | 18,669 | 37,338 | 9,334 | 801.70 |
| i006 | rich  | 169,528 | 185,295 | 370,590 | 92,647 | 723.40 |
| i007 | alpha | 58,000 | 64,285 | 128,570 | 32,142 | 731.80 |
| i008 | grey  | 22,632 | 26,807 | 53,614 | 13,403 | 770.50 |

**Total practice-set score: 753,700** (mean 753.7 points/instance) — below the
scale compressor's size on all 8 instances, and well above the house baseline
`fixed-paeth` (420,399 on the same set). Round 7 adds three structural
changes on top of the Round 6 block splitting (747.8): all-lengths DP for
the longest frontier pair (+3.1 mean), a short reference parse plus rank-64
long matches on the large inputs (i002 +10.4, i003 +4.3, i007 +18.9 points;
i006 +0.5), for +5.9 mean at 2.2 s *less* wall time (~40 s on the dev VM,
inside the grader's 60 s single-CPU budget). Round 6 adds adaptive block
splitting à la zopfli on top of the Round 5 hybrid matcher (744.7): splitting
the four large images' blocks where the token statistics change lifts i002
+2.4, i003 +5.9, i004 +3.8, i006 +7.3 and i007 +5.7 points (i001, i005, i008
unchanged), for +3.1 mean points at no extra wall time (~41 s on the dev VM,
inside the grader's 60 s single-CPU budget). The hybrid suffix-array matcher
lifts the four smallest images (i001, i004, i005, i008) well above the
plain hash-chain result (727.2): i001 +47 points, i005 +50, i008 +40,
i004 +4. The larger images keep the legacy + sparse-frontier result, which
still beats zlib-9 on i002, i003 and i006. The hybrid matcher (short chain
16/4 + SA scan K=16) costs ~1 s more than the plain chain walk on the small
inputs, so the run stays ~41 s on the dev VM and inside the grader's 60 s
single-CPU budget — a deeper walk (cap 1024/128, practice 735.8) scored
lower than this hybrid and timed out on the grader, so this revision trades
the deep walk for a structurally better matcher that is also faster. A
suffix-array scan alone (no chains) scores far worse (~716) because it
misses near matches; the hybrid is what makes the SA useful. (Measured on
the dev VM: 6029.6 summed points over the 8 instances, wall 39.8 s, two runs
byte-identical.)

## License

MIT — see [LICENSE](LICENSE).
