# Sand Boxes — execution report and evaluation of the algorithms

*(نسخهٔ فارسی: [03-report.fa.md](03-report.fa.md))*

All numbers in this report are read from the JSON files in [`data/`](../data), which are produced
by `npm run analyze`; the figures and tables are generated from the same files by
`node scripts/figures.mjs`. The interactive versions are in the *Analysis* tab of the site.

## 1. What was run

| | |
|---|---|
| Main experiment | **every one of the 3¹⁰ = 59,049 initial states** of the 5×2 sand grid |
| Also | all states of the 2×2, 3×2 and 4×2 grids; 1,000 random 5×2 instances of the water variant |
| Required algorithms | the greedy approach of the assignment; BFS, DFS, IDS, UCS |
| Bonus algorithms | A* (h₁), A* (h₂), RBFS (h₂), IDA* (h₂), Weighted A* (w = 2, h₂), greedy best-first (h₃) |
| Runs | 11 runs per state: 649,539 for the main experiment |
| Machine | Apple M5 (10 logical cores), Node.js 26.10, 4 worker threads |
| Wall time | 2,007 s for the main experiment (8,018 s of search time in total: IDA* 35 %, RBFS 25 %) |

Definitions (see [01-problem-original.md](01-problem-original.md) for the model):

- **Door rule.** A door above an opened gate opens by itself only when it is pressed from both
  sides (sand on top of it, a full box under it); all opened doors act at the same moment, and
  `s′` in the cost `1 + 4·(s + s′)` is read after everything has fallen.
- **Greedy approach** is the procedure defined in class, not greedy best-first search: no side
  gates, each column on its own; start at the topmost box holding sand, open the gate under it,
  move on to the box below, down to the outlet; repeat until the column is empty. Its cost is the
  “cost by greedy solution” of the histogram and of the first scatter plot.
- **Optimum cost** is computed twice, independently: by dynamic programming over the whole state
  graph (value iteration on the transition table), and by the exact searches (UCS, A*, IDA*).
- **Time** is the wall-clock time of one run, measured with `performance.now()`. Successors and
  heuristic values are precomputed, so the time is pure search effort.
- **Memory** is the peak number of states held at once: the frontier plus the explored set (BFS,
  DFS, UCS, A*, greedy best-first), the transposition table plus the recursion stack (IDS, IDA*),
  the current path with its sibling lists (RBFS), or just the current state (greedy approach).
- **Expanded / generated** count states whose successors were produced / successor states produced.
- **Budgets.** 2,000,000 expansions per run; RBFS, a pure tree search, gets 500,000.

## 2. Correctness checks

| Check | Result |
|---|---|
| Greedy approach on the assignment's example | 5, 5, 9, 5 then 9, 9, 5 = 47: the sequence given in class, in the same order |
| “Other alternative” of the assignment, 1+1, 3+5+9+9+5, 3+5+5 | 46, every step cost as printed |
| Side-gate plan printed as 1+1, 7+9+9+5, 3+5+5 = 45 | not playable as printed; the corrected plan 1+1, 7+9+9+9+5, 3+5+5 costs **54** and matches the state-by-state trace on the 5×2 grid |
| Optimum of the assignment example | **45** with UCS, A* (h₁), A* (h₂), IDA* and RBFS, by a different plan (one side gate, on the top row) |
| Exact searches against the dynamic-programming optimum, all 59,049 states | **0 mismatches** (UCS, both A*, IDA* on every state; RBFS on every state it finished) |
| h₁ and h₂ admissible and consistent, every state and every transition of the 1×2 … 5×2 grids | no violation |
| Every returned path replayed through the model ends in a goal state with the reported cost | yes (test-suite) |
| Unsolvable water instance | every algorithm terminates and reports “no solution” |

`npm test` runs these checks (the heuristics on all grids up to 5×2); the comparison with dynamic
programming on all 59,049 states is part of `npm run analyze`, which records the number of
mismatches in the dataset.

## 3. Results on all 59,049 states

### 3.1 Optimal solutions

| Quantity | Mean | Median | 95th percentile | Maximum |
|---|---:|---:|---:|---:|
| Optimum cost | 62.1 | 63 | 81 | 98 |
| Actions in the optimal plan | 11.6 | 12 | — | 20 |

![Distribution of the optimum cost](figures/exhaustive-5x2-opt-cost.svg)

- The most expensive state is **not** the completely full grid (optimum 82: eight flushes at 9 and
  two at 5) but `1 1 / 1 1 / ½ ½ / 1 1 / ½ ½`, with optimum 98: the half boxes break the chain of
  pressed doors, so the piles above them have to be packed by extra actions.
- **64.1 % of all states have an optimal plan that uses at least one side gate.**

| Side gates in the optimal plan | 0 | 1 | 2 | 3 | 4 |
|---|---:|---:|---:|---:|---:|
| States | 21,207 | 23,293 | 11,748 | 2,673 | 128 |
| Share | 35.9 % | 39.4 % | 19.9 % | 4.5 % | 0.2 % |

Where several plans share the optimum cost, the one with the fewest actions is counted, then the
one with the fewest side gates.

### 3.2 The greedy approach against the optimum — histogram of `Greedy_opt_ratio`

`Greedy_opt_ratio = cost by greedy solution / optimum cost`, over the 59,048 states that contain
sand.

![Histogram of Greedy_opt_ratio](figures/exhaustive-5x2-ratio-hist.svg)

| Ratio | States | Share |
|---|---:|---:|
| exactly 1 (greedy is optimal) | 8,081 | 13.7 % |
| (1.00, 1.05) | 8,074 | 13.7 % |
| [1.05, 1.10) | 12,917 | 21.9 % |
| [1.10, 1.15) | 12,056 | 20.4 % |
| [1.15, 1.20) | 8,949 | 15.2 % |
| [1.20, 1.25) | 5,402 | 9.1 % |
| [1.25, 1.30) | 2,518 | 4.3 % |
| [1.30, 1.35) | 826 | 1.4 % |
| [1.35, 1.40) | 217 | 0.4 % |
| [1.40, 1.45) | 8 | 0.01 % |

Mean 1.110, median 1.101, 95th percentile 1.257, maximum 1.419.

- The greedy approach is optimal on 13.7 % of the states and pays on average **11 % more** than
  necessary; it never pays more than 42 % extra.
- The worst case is `0 0 / 0 1 / 0 ½ / 1 ½ / ½ ½`: greedy pays 61, the optimum is 43.
- It loses for two separate reasons:
  1. **It never opens a side gate**, while 64.1 % of the optimal plans need one.
  2. **Its top-to-bottom order is itself costly.** At least 35.9 % of the states have an optimal
     plan without any side gate, yet greedy is optimal on only 13.7 %. The smallest example is one
     column holding `1` over `½`: greedy opens the top gate first (7), then flushes 7 and 3, total
     17; flushing the half box first costs 3 + 5 + 5 = 13. Sweeping from the top packs sand onto
     the boxes below, and every flush of a loaded box pays for the load.

### 3.3 The claim from class: optimal when every gate costs one unit

In class the greedy approach was said to give the optimum under the ordinary cost function, one
unit per opened gate. With unit costs the optimum is the fewest number of actions, which is what
BFS finds. Comparing the two on every state:

| Grid | States | Greedy approach uses the fewest actions |
|---|---:|---:|
| 2×2 | 81 | 81 (100 %) |
| 3×2 | 729 | 729 (100 %) |
| 4×2 | 6,561 | 6,561 (100 %) |
| 5×2 | 59,049 | **59,049 (100 %)** |

**The claim holds on every state**: under unit costs the greedy approach is optimal, and side gates
are never needed to save an action. The whole gap measured in section 3.2 is therefore created by
the cost function `1 + 4·(s + s′)`, which is exactly what makes this version of the problem
interesting. (The greedy approach and BFS return plans of the same length everywhere — 10.2 actions
on average — but not always the same plan: their mean cost ratios are 1.110 and 1.108.)

### 3.4 Scatter plot 1 — greedy cost against optimum cost

![Greedy cost against optimum cost](figures/exhaustive-5x2-greedy-vs-opt.svg)

Every point lies on or to the right of the diagonal (greedy can never beat the optimum). The cloud
is a narrow band that widens slowly as the optimum grows: the overpayment stays roughly
proportional, at most 42 %.

### 3.5 Scatter plot 2 — number of actions against number of type-b actions

Optimal plans:

![Actions against side-gate actions, optimal plans](figures/exhaustive-5x2-actions-vs-sides.svg)

Optimal plans have between 0 and 20 actions, of which 0 to 4 are side gates. Plans with more side
gates are longer — a plan with one side gate has at least 7 actions, one with four at least 16 —
but the relation is loose: there are 14-action plans with no side gate at all. The plans of the
greedy approach all sit on the horizontal axis
([figure](figures/exhaustive-5x2-actions-vs-sides-greedy.svg)): 10.2 actions on average, none of
type b. Optimal plans are *longer* than greedy ones (11.6 actions against 10.2): the cheapest plan
spends extra, cheap actions to avoid expensive ones.

### 3.6 Solution quality of all algorithms

| Algorithm | Heuristic | Optimal on | Mean cost ÷ optimum | Worst cost ÷ optimum | Mean actions |
|---|---|---:|---:|---:|---:|
| Greedy approach | — | 13.7 % | 1.110 | 1.42 | 10.2 |
| BFS | — | 14.3 % | 1.108 | 1.49 | 10.2 |
| DFS | — | 0.1 % | 1.442 | 2.46 | 26.7 |
| IDS | — | 14.3 % | 1.108 | 1.49 | 10.2 |
| UCS | — | **100 %** | 1.000 | 1.00 | 11.7 |
| A* | h₁ sand volume | **100 %** | 1.000 | 1.00 | 11.9 |
| A* | h₂ volume + gates | **100 %** | 1.000 | 1.00 | 11.9 |
| RBFS | h₂ | optimal on all 8,921 states it finished (15.1 %) | 1.000 | 1.00 | — |
| IDA* | h₂ | **100 %** | 1.000 | 1.00 | 11.9 |
| Weighted A* (w = 2) | h₂ | 35.7 % | 1.038 | 1.26 | 10.7 |
| Greedy best-first | h₃ fall distance | 8.1 % | 1.128 | 1.40 | 12.0 |

- The greedy approach, BFS and IDS are almost equally good: all three produce fewest-action plans,
  about 11 % above the optimum.
- Greedy best-first search, the textbook “greedy”, is slightly *worse* than the simple greedy
  approach (12.8 % above the optimum against 11.0 %), as was predicted in class.
- Weighted A* stays within 3.8 % of the optimum on average and never exceeds 1.26.
- DFS returns whatever it finds first: 27 actions on average, 44 % too expensive.

### 3.7 Time

![Mean time per instance](figures/exhaustive-5x2-time.svg)

| Algorithm | Mean (ms) | Median (ms) | 95th pct (ms) | Max (ms) | Total over 59,049 states (s) |
|---|---:|---:|---:|---:|---:|
| Greedy approach | 0.0065 | 0.0063 | 0.0093 | 0.34 | 0.38 |
| BFS | 4.28 | 2.86 | 13.1 | 63.0 | 253 |
| DFS | 0.016 | 0.016 | 0.023 | 0.81 | 0.93 |
| IDS | 15.5 | 7.38 | 58.8 | 453 | 913 |
| UCS | 12.0 | 7.37 | 36.8 | 119 | 708 |
| A* (h₁) | 13.4 | 8.45 | 41.1 | 167 | 793 |
| A* (h₂) | 8.38 | 4.72 | 27.8 | 84.7 | 495 |
| RBFS (budget 500,000) | 34.4 | 37.8 | 47.5 | 322 | 2,032 |
| IDA* | 47.8 | 16.4 | 203 | 784 | 2,821 |
| Weighted A* | 0.017 | 0.015 | 0.037 | 0.43 | 1.03 |
| Greedy best-first | 0.016 | 0.015 | 0.025 | 2.67 | 0.92 |

### 3.8 Memory and search effort

![Mean states expanded per instance](figures/exhaustive-5x2-expanded.svg)

![Mean peak memory per instance](figures/exhaustive-5x2-memory.svg)

| Algorithm | Mean expanded | Median | Max expanded | Mean generated | Mean peak memory (states) | Median | Max peak memory |
|---|---:|---:|---:|---:|---:|---:|---:|
| Greedy approach | 10.2 | 10 | 14 | 62.3 | 1 | 1 | 1 |
| BFS | 9,363 | 6,797 | 44,032 | 53,500 | 11,200 | 8,282 | 47,402 |
| DFS | 26.7 | 28 | 36 | 115 | 116 | 126 | 177 |
| IDS | 40,200 | 24,900 | 359,540 | 235,000 | 8,717 | 6,229 | 43,103 |
| UCS | 12,791 | 9,446 | 50,034 | 71,500 | 12,800 | 9,447 | 50,035 |
| A* (h₁) | 12,664 | 9,340 | 49,882 | 71,000 | 12,800 | 9,442 | 50,023 |
| A* (h₂) | 7,273 | 4,724 | 40,339 | 41,800 | 10,200 | 7,169 | 45,469 |
| RBFS | 440,000 | 500,000 | 500,000 (budget) | 2,100,000 | **87.5** | 91 | **122** |
| IDA* | 109,701 | 48,200 | 1,420,304 | 635,000 | 7,486 | 4,901 | 40,826 |
| Weighted A* | 14.3 | 12 | 138 | 61.0 | 58.7 | 52 | 446 |
| Greedy best-first | 12.0 | 12 | 24 | 49.4 | 50.4 | 50 | 124 |

RBFS exhausted its budget on 50,128 states (84.9 %). No other run hit a limit.

### 3.9 Discussion

- **The problem is “wide”, not deep.** Plans are at most 20 actions long, yet UCS expands 12,800
  states on average — 22 % of the entire state space — and up to 50,034 (85 %). From a full grid
  most states are reachable, and the two columns can be worked on in any interleaving.
- **The quality of the heuristic decides everything.** h₁ (sand volume) is nearly useless here: it
  saves 1 % of the expansions of UCS and, because of its overhead, A* (h₁) is actually *slower*
  than UCS. h₂ (volume + gates) saves 43 % of the expansions and 30 % of the time. h₁ only counts
  the cost of getting sand out through the outlets (mean h/h* of 0.41), while much of the cost
  comes from carrying sand down to where it can be flushed, which is what the gate term of h₂
  measures (mean h/h* of 0.64).
- **RBFS shows what linear memory costs on this problem.** It never holds more than 122 states,
  against tens of thousands for A*, and it finds the optimum whenever it finishes — but within
  500,000 expansions it finishes on only 15.1 % of the states. The cut-off is sharp in the length
  of the optimal plan:

  | Actions in the optimal plan | ≤ 6 | 7 | 8 | 9 | 10 | 11 | 12 | ≥ 13 |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|
  | States | 1,498 | 1,768 | 3,106 | 4,916 | 7,010 | 8,859 | 9,925 | 21,967 |
  | Finished by RBFS | 100 % | 95 % | 72 % | 42 % | 17 % | 2.7 % | 0.1 % | 0 % |

  RBFS is a tree search, and here every plan can be interleaved between the two columns in a
  combinatorial number of ways, all passing through the same states. Without a transposition
  table those states are expanded over and over.
- **IDA\* avoids that only because it was given a transposition table**, and is still the slowest
  exact algorithm that finishes everywhere: 5.7 times slower than A* (h₂). Step costs take the
  values 1, 3, 5, 7, 9, so there are many distinct f-contours and each iteration repeats most of
  the previous one (110,000 expansions against 7,300). Its memory advantage is small (7,500 states
  against 10,200) because the table is nearly as large as A*'s open and closed lists.
- **IDS shows the same pattern against BFS**: 4.3 times the expansions for 78 % of the memory.
- **Weighted A\* is the best compromise.** With h₂ and w = 2 it expands 14 states on average,
  takes 17 microseconds, and returns plans 3.8 % above the optimum (worst case 26 %): nearly as
  cheap as the greedy approach and three times closer to the optimum.
- **The greedy approach is by far the cheapest**: 10 expansions, one state in memory, 6.5
  microseconds — several hundred times faster than BFS for the same solution quality.
- **Fewest actions is not cheapest**: BFS and the greedy approach are optimal in cost on only 14 %
  of the states, because a short plan flushes loaded piles (cost 9) where a longer one splits or
  unloads them first.

How the effort grows with the length of the optimal plan (mean states expanded):

| Actions in the optimal plan | 2 | 6 | 10 | 14 | 18 | 20 |
|---|---:|---:|---:|---:|---:|---:|
| States with that length | 14 | 908 | 7,010 | 6,298 | 242 | 10 |
| UCS | 10 | 1,212 | 7,511 | 18,845 | 30,063 | 41,418 |
| A* (h₂) | 2 | 114 | 2,968 | 12,207 | 22,910 | 32,750 |

The interactive line chart in the Analysis tab shows this for every algorithm, for expansions,
memory and time. The advantage of A* over UCS shrinks from a factor of 10 on six-action plans to
2.5 at ten actions and 1.3 on the longest ones, where most of the reachable space must be
examined either way.

## 4. Effect of the grid size

Every state of each grid, same algorithms.

| Grid | States | Mean optimum | Optimal plans with a side gate | Greedy approach optimal | Mean greedy ÷ opt | Worst | Greedy optimal at unit cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2×2 | 81 | 15.3 | 0 % | 79.0 % | 1.046 | 1.31 | 100 % |
| 3×2 | 729 | 29.2 | 6.0 % | 49.5 % | 1.070 | 1.36 | 100 % |
| 4×2 | 6,561 | 45.2 | 37.5 % | 28.3 % | 1.090 | 1.42 | 100 % |
| 5×2 | 59,049 | 62.1 | 64.1 % | 13.7 % | 1.110 | 1.42 | 100 % |

| Grid | BFS expanded | UCS expanded | A* (h₂) expanded | IDA* expanded | RBFS expanded | RBFS finished | Weighted A* expanded |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2×2 | 13 | 27 | 6 | 14 | 10 | 100 % | 3 |
| 3×2 | 118 | 202 | 81 | 402 | 3,963 | 100 % | 6 |
| 4×2 | 1,062 | 1,583 | 824 | 7,529 | 236,605 | 62.4 % | 9 |
| 5×2 | 9,363 | 12,791 | 7,273 | 109,701 | 440,344 | 15.1 % | 14 |

- Already on the 2×2 grid, where no optimal plan uses a side gate, the greedy approach is
  suboptimal on a fifth of the states: its order of flushing is enough to lose. Each extra row
  adds the side-gate effect on top and greedy gets worse.
- Each extra row multiplies the state space by 9 and the expansions of UCS and A* by 7 to 14: the
  exact searches grow with the state space itself. RBFS grows by a factor of 400 from the 2×2 to
  the 3×2 grid and then runs into its budget.
- Weighted A* grows almost linearly with the height of the grid: 3, 6, 9, 14 expansions.

## 5. The water variant (proposed form)

1,000 random 5×2 instances (empty 0.40, ½ sand 0.15, full sand 0.20, ½ water 0.10, full water
0.15; seed 1), concrete penalty 10, expansion limit 300,000 per run. The state space has
6¹⁰ ≈ 60 million states, so it is sampled rather than enumerated; the reference optimum of each
instance comes from A*.

| Quantity | Value |
|---|---|
| Solvable instances | 1,000 of 1,000 (11 contain no sand at all) |
| Optimum cost | mean 43.4, median 44, maximum 89 |
| Actions in the optimal plan | mean 7.8, maximum 17 |
| Optimal plans using a side gate | 63.6 % |
| Greedy approach | **gets stuck on 302 instances**; optimal on 245; mean ratio 1.145 where it finishes, maximum 3.18 |

![Histogram of Greedy_opt_ratio, water variant](figures/water-5x2-ratio-hist.svg)

| Algorithm | Solved | Optimal on | Mean cost ÷ opt | Worst | Mean time (ms) | Mean expanded | Mean peak memory | Hit the limit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Greedy approach | 698 | 24.5 % | 1.145 | 3.18 | 0.012 | 5.7 | 1 | 0 |
| BFS | 1,000 | 24.4 % | 1.207 | 3.67 | 3.91 | 3,917 | 6,326 | 0 |
| DFS | 1,000 | 2.3 % | 1.734 | 12.00 | 0.68 | 887 | 933 | 0 |
| IDS | 999 | 24.4 % | 1.208 | 3.67 | 8.38 | 11,100 | 3,483 | 1 |
| UCS | 989 | 98.9 % | 1.000 | 1.00 | 72.4 | 29,400 | 43,200 | 11 |
| A* (h₁) | 1,000 | 100 % | 1.000 | 1.00 | 51.6 | 15,000 | 26,400 | 0 |
| A* (h₂) | 1,000 | 100 % | 1.000 | 1.00 | 52.0 | 14,200 | 26,000 | 0 |
| RBFS | 275 | 27.5 % | 1.000 | 1.00 | 47.6 | 227,000 | 78 | 725 |
| IDA* | 785 | 78.5 % | 1.000 | 1.00 | 100 | 101,000 | 7,966 | 215 |
| Weighted A* | 1,000 | 68.5 % | 1.024 | 1.29 | 14.6 | 4,210 | 9,594 | 0 |
| Greedy best-first | 1,000 | 21.1 % | 1.194 | 3.17 | 0.39 | 366 | 391 | 0 |

(“Optimal on” is a share of all 1,000 instances; every run of an exact algorithm that finished is
optimal.)

- **The greedy approach stops being a method.** It pours whatever is in a column straight down, so
  sand meets water, a box sets into concrete and the column is sealed: on 30 % of the instances it
  cannot finish at all, although every one of them is solvable. Where it does finish it is
  optimal on 35 % (245 of 698) — the easy instances.
- **Mistakes get much more expensive.** Without water the worst plan of the greedy approach costs
  1.42 times the optimum; with water 3.18, BFS 3.67 and DFS 12. One careless action creates
  concrete (+10) and can force the remaining sand to be concreted as well.
- **A\* is the only exact algorithm that finishes every instance** within the limit; it expands
  about half as many states as UCS, which runs out on 11 instances. h₂ falls back to h₁ whenever
  water is present, which is why the two A* rows nearly coincide.
- **IDA\* and RBFS are not viable here**: they exhaust the limit on 21.5 % and 72.5 % of the
  instances.
- None of the 1,000 random instances is unsolvable: a random start state contains no concrete,
  and the exact searches can usually avoid creating any. Hand-made cases with concrete in the
  start state, such as `0 0 / ½ 0 / # 0`, are detected by every algorithm (see the tests).

## 6. Conclusions

1. **The greedy approach is optimal for unit costs and not for this cost function.** With one unit
   per gate it uses the fewest actions on all 59,049 states, as claimed in class. With
   `1 + 4·(s + s′)` it is optimal on 13.7 % of them and overpays by 11 % on average and at most
   42 %. Two things cost it: it never uses a side gate (64 % of the optimal plans do), and its
   top-to-bottom order loads the lower boxes before flushing them.
2. On the assignment's own example the side-gate plan printed as 45 really costs 54 — one action
   of cost 9 is missing — which makes it worse than the greedy approach (47). The optimum is
   nevertheless 45, by a plan that opens only the side gate of the top row.
3. Of the four main searches only UCS is optimal in cost. BFS and IDS match the greedy approach in
   quality at several hundred times its cost; DFS is fast and poor.
4. UCS, A* and IDA* agree with the dynamic-programming optimum on all 59,049 states. A* with the
   volume + gates heuristic is the fastest exact algorithm; the weaker volume heuristic gives A*
   no advantage over UCS, which shows that designing the heuristic is the real work.
5. RBFS runs in under 125 states of memory but finishes on only 15 % of the states: the state
   graph is full of transpositions, and a linear-memory tree search pays for every one of them.
6. Weighted A* with the strong heuristic gives near-optimal plans (+3.8 %) for about 14 expansions
   per instance.
7. Adding water and concrete keeps the model small but makes it harsher: errors become
   irreversible, the greedy approach fails outright on 30 % of the instances, and informed exact
   search (A*) becomes the only dependable exact method.

## 7. Reproducing the numbers

```bash
npm test
```

```bash
npm run analyze
```

```bash
node scripts/figures.mjs
```

Timings depend on the machine; costs, counts of expanded states and memory figures are
deterministic and should match exactly.
