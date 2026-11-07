# Sand Boxes — execution report and evaluation of the algorithms

*(نسخهٔ فارسی: [03-report.fa.md](03-report.fa.md))*

All numbers in this report are read from the JSON files in [`data/`](../data), which are produced
by `npm run analyze`; the figures and tables are generated from the same files by
`node scripts/figures.mjs`. The interactive versions are in the *Analysis* tab of the site.

## 1. What was run

| | |
|---|---|
| Main experiment | **every one of the 3¹⁰ = 59,049 initial states** of the 5×2 sand grid (326,041 reachable states once the gate bits are counted) |
| Also | all initial states of the 2×2, 3×2 and 4×2 grids; 1,000 random 5×2 instances of the water variant |
| Required algorithms | the greedy approach of the assignment; BFS, DFS, IDS, UCS |
| Bonus algorithms | A* (h₁), A* (h₂), RBFS (h₂), IDA* (h₂), Weighted A* (w = 2, h₂), greedy best-first (h₃) |
| Runs | 11 runs per state: 649,539 for the main experiment |
| Machine | Apple M5 (10 logical cores), Node.js 26.10, 6 worker threads |
| Wall time | 3,194 s for the main experiment (19,101 s of search time in total: IDA* 39 %, RBFS 17 %, UCS 16 %) |

Definitions (see [01-problem-original.md](01-problem-original.md) for the model):

- **Spring gates.** A top-down gate opened by an action stays open as long as there is material
  above it and closes by itself when that box empties; everything flows through the open gates at
  the same moment. `s′` in the cost `1 + 4·(s + s′)` is read after everything has settled.
- **Greedy approach** is the procedure defined in class, not greedy best-first search: no side
  gates, each column on its own; start at the topmost box holding sand, open the gate under it,
  move on to the box below, down to the outlet; repeat until the column is empty. Its cost is the
  “cost by greedy solution” of the histogram and of the first scatter plot.
- **Optimum cost** is computed twice, independently: by value iteration over the whole reachable
  state graph, and by the exact searches (UCS, A*, IDA*, RBFS).
- **Time** is the wall-clock time of one run, measured with `performance.now()`. Successors and
  heuristic values are precomputed, so the time is pure search effort. Six workers ran at once on
  a machine with four performance cores, so absolute times are a little pessimistic; the ratios
  between algorithms are not affected, since every state runs all eleven on the same worker.
- **Memory** is the peak number of states held at once: the frontier plus the explored set (BFS,
  DFS, UCS, A*, greedy best-first), the transposition table plus the recursion stack (IDS, IDA*),
  the current path with its sibling lists (RBFS), or just the current state (greedy approach).
- **Expanded / generated** count states whose successors were produced / successor states produced.
- **Budgets.** 2,000,000 expansions per run; RBFS, a pure tree search, gets 500,000.

## 2. Correctness checks

| Check | Result |
|---|---|
| Greedy approach on the assignment's example | 5, 5, 9, 5 then 9, 9, 5 = 47: the sequence given in class, in the same order |
| Side-gate plan of the assignment, 1+1, 7+9+9+5, 3+5+5 | 45, every step cost as printed, and the state-by-state trace on the 5×2 grid matches, open gates included |
| “Other alternative” of the assignment, 1+1, 3+5+9+9+5, 3+5+5 | 46, every step cost as printed |
| Optimum of the assignment example | **38** with UCS, A* (h₁), A* (h₂), IDA* and RBFS |
| Exact searches against the value-iteration optimum, all 59,049 states | **0 mismatches** (UCS and both A* on every state; IDA* and RBFS on every state they finished) |
| h₁ and h₂ admissible and consistent, every reachable state and transition of the 1×2 … 5×2 grids | no violation (326,041 states, 2.3 million transitions for 5×2) |
| Every returned path replayed through the model ends in a goal state with the reported cost | yes (test-suite) |
| Unsolvable water instance | every algorithm terminates and reports “no solution” |

`npm test` runs these checks; the comparison with value iteration on all 59,049 states is part of
`npm run analyze`, which records the number of mismatches in the dataset.

## 3. Results on all 59,049 states

### 3.1 Optimal solutions

| Quantity | Mean | Median | 95th percentile | Maximum |
|---|---:|---:|---:|---:|
| Optimum cost | 51.0 | 52 | 65 | 76 |
| Actions in the optimal plan | 11.2 | 11 | — | 18 |

![Distribution of the optimum cost](figures/exhaustive-5x2-opt-cost.svg)

- The most expensive state is `1 1 / 1 1 / 1 1 / 0 0 / 0 0`, optimum 76: six full boxes hanging
  at the top with nothing under them, so every gate has to be opened under a loaded box. The
  completely full grid costs 72 (the greedy approach pays 82 for it).
- **78.3 % of all states have an optimal plan that uses at least one side gate.**

| Side gates in the optimal plan | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---:|---:|---:|---:|---:|---:|
| States | 12,838 | 24,579 | 16,807 | 4,557 | 264 | 4 |
| Share | 21.7 % | 41.6 % | 28.5 % | 7.7 % | 0.4 % | 0.01 % |

Where several plans share the optimum cost, the one with the fewest actions is counted, then the
one with the fewest side gates.

### 3.2 The greedy approach against the optimum — histogram of `Greedy_opt_ratio`

`Greedy_opt_ratio = cost by greedy solution / optimum cost`, over the 59,048 states that contain
sand.

![Histogram of Greedy_opt_ratio](figures/exhaustive-5x2-ratio-hist.svg)

| Ratio | States | Share |
|---|---:|---:|
| exactly 1 (greedy is optimal) | 1,488 | 2.5 % |
| (1.00, 1.05) | 934 | 1.6 % |
| [1.05, 1.10) | 4,464 | 7.6 % |
| [1.10, 1.15) | 9,304 | 15.8 % |
| [1.15, 1.20) | 18,342 | 31.1 % |
| [1.20, 1.25) | 16,546 | 28.0 % |
| [1.25, 1.30) | 6,504 | 11.0 % |
| [1.30, 1.35) | 1,310 | 2.2 % |
| [1.35, 1.40) | 149 | 0.3 % |
| [1.40, 1.45) | 7 | 0.01 % |

Mean 1.180, median 1.186, 95th percentile 1.279, maximum 1.413.

- The greedy approach is optimal on only 2.5 % of the states and pays on average **18 % more**
  than necessary; it never pays more than 42 % extra.
- The worst case is `1 0 / 1 ½ / 0 1 / ½ 0 / 1 0`: greedy pays 65, the optimum is 46.
- The distribution is a narrow bell around 1.19: greedy is almost never right, but it is never
  disastrously wrong on sand-only grids.
- It loses for two reasons: it never opens a side gate, while 78 % of the optimal plans do; and it
  opens every gate while the box above is loaded (cost 9 for a full box), whereas the optimal
  plans move halves first (cost 3) and open gates when they are cheap.

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
never save an action. The whole gap measured in section 3.2 is created by the cost function
`1 + 4·(s + s′)`, which is what makes this version of the problem interesting. (The greedy approach
and BFS return plans of the same length everywhere — 9.0 actions on average — and here even of the
same cost: both are optimal on 2.5 % of the states with a mean ratio of 1.180.)

### 3.4 Scatter plot 1 — greedy cost against optimum cost

![Greedy cost against optimum cost](figures/exhaustive-5x2-greedy-vs-opt.svg)

Every point lies on or to the right of the diagonal (greedy can never beat the optimum). The cloud
is a narrow band: the overpayment is roughly proportional to the optimum, between 5 % and 30 % for
almost every state.

### 3.5 Scatter plot 2 — number of actions against number of type-b actions

Optimal plans:

![Actions against side-gate actions, optimal plans](figures/exhaustive-5x2-actions-vs-sides.svg)

Optimal plans have between 0 and 18 actions, of which 0 to 5 are side gates. Plans with more side
gates are longer — a plan with one side gate has at least 5 actions, one with four at least 13 —
but the relation is loose: there are 12-action plans with no side gate at all. The plans of the
greedy approach all sit on the horizontal axis
([figure](figures/exhaustive-5x2-actions-vs-sides-greedy.svg)): 9.0 actions on average, none of
type b. Optimal plans are *longer* than greedy ones (11.2 actions against 9.0): the cheapest plan
spends extra, cheap actions to avoid expensive ones.

### 3.6 Solution quality of all algorithms

| Algorithm | Heuristic | Optimal on | Mean cost ÷ optimum | Worst cost ÷ optimum | Mean actions |
|---|---|---:|---:|---:|---:|
| Greedy approach | — | 2.5 % | 1.180 | 1.41 | 9.0 |
| BFS | — | 2.5 % | 1.180 | 1.41 | 9.0 |
| DFS | — | 0.1 % | 1.614 | 2.81 | 26.2 |
| IDS | — | 2.5 % | 1.180 | 1.41 | 9.0 |
| UCS | — | **100 %** | 1.000 | 1.00 | 11.2 |
| A* | h₁ columns | **100 %** | 1.000 | 1.00 | 11.2 |
| A* | h₂ closed gates | **100 %** | 1.000 | 1.00 | 11.2 |
| RBFS | h₂ | optimal on all 7,227 states it finished (12.2 %) | 1.000 | 1.00 | — |
| IDA* | h₂ | 99.8 % (101 states hit the 2,000,000 budget) | 1.000 | 1.00 | 11.5 |
| Weighted A* (w = 2) | h₂ | 44.7 % | 1.033 | 1.25 | 10.3 |
| Greedy best-first | h₃ fall distance | 4.9 % | 1.251 | 1.81 | 12.1 |

- The greedy approach, BFS and IDS are equally good: all three produce fewest-action plans, 18 %
  above the optimum.
- Greedy best-first search, the textbook “greedy”, is clearly *worse* than the simple greedy
  approach (25 % above the optimum, worst case 1.81), as was predicted in class.
- Weighted A* stays within 3.3 % of the optimum on average and never exceeds 1.25.
- DFS returns whatever it finds first: 26 actions on average, 61 % too expensive.

### 3.7 Time

![Mean time per instance](figures/exhaustive-5x2-time.svg)

| Algorithm | Mean (ms) | Median (ms) | 95th pct (ms) | Max (ms) | Total over 59,049 states (s) |
|---|---:|---:|---:|---:|---:|
| Greedy approach | 0.009 | 0.009 | 0.013 | 0.81 | 0.53 |
| BFS | 6.99 | 4.57 | 20.8 | 93.0 | 413 |
| DFS | 0.021 | 0.022 | 0.031 | 1.82 | 1.26 |
| IDS | 14.3 | 9.03 | 44.8 | 117 | 844 |
| UCS | 51.0 | 21.1 | 205 | 489 | 3,010 |
| A* (h₁) | 50.4 | 21.2 | 203 | 472 | 2,976 |
| A* (h₂) | 21.9 | 9.84 | 87.9 | 213 | 1,295 |
| RBFS (budget 500,000) | 53.6 | 56.9 | 77.7 | 215 | 3,166 |
| IDA* | 125 | 39.0 | 561 | 1,640 | 7,382 |
| Weighted A* | 0.22 | 0.073 | 0.88 | 69.1 | 12.9 |
| Greedy best-first | 0.019 | 0.019 | 0.030 | 1.56 | 1.14 |

### 3.8 Memory and search effort

![Mean states expanded per instance](figures/exhaustive-5x2-expanded.svg)

![Mean peak memory per instance](figures/exhaustive-5x2-memory.svg)

| Algorithm | Mean expanded | Median | Max expanded | Mean generated | Mean peak memory (states) | Median | Max peak memory |
|---|---:|---:|---:|---:|---:|---:|---:|
| Greedy approach | 9.0 | 9 | 10 | 50.0 | 1 | 1 | 1 |
| BFS | 10,718 | 7,860 | 47,237 | 71,600 | 16,800 | 11,700 | 75,854 |
| DFS | 26.1 | 27 | 34 | 122 | 123 | 130 | 200 |
| IDS | 27,700 | 20,700 | 126,457 | 188,000 | 9,324 | 6,653 | 45,562 |
| UCS | 34,994 | 19,600 | 205,709 | 224,000 | 35,300 | 19,800 | 214,737 |
| A* (h₁) | 33,132 | 18,600 | 188,058 | 215,000 | 34,900 | 19,500 | 204,927 |
| A* (h₂) | 13,976 | 7,781 | 98,506 | 95,400 | 22,200 | 13,100 | 130,701 |
| RBFS | 453,000 | 500,000 | 500,000 (budget) | 2,900,000 | **95** | 99 | **130** |
| IDA* | 213,112 | 84,300 | 2,000,000 (budget) | 1,500,000 | 14,400 | 8,084 | 90,085 |
| Weighted A* | 144 | 56 | 3,596 | 924 | 572 | 250 | 11,940 |
| Greedy best-first | 12.1 | 12 | 21 | 53.7 | 54.7 | 55 | 114 |

RBFS exhausted its budget on 51,822 states (87.8 %); IDA* on 101 (0.2 %). No other run hit a limit.

### 3.9 Discussion

- **The problem is wide, and the gate bits make it wider.** Plans are at most 18 actions long, yet
  UCS expands 35,000 states on average and up to 205,709 — far more than the 59,049 initial
  states, because the open-gate bits multiply the reachable states (326,041 in all) and the two
  columns can be worked on in any interleaving.
- **The quality of the heuristic decides everything.** h₁ (3 per column with sand) is nearly
  useless: it saves 5 % of the expansions of UCS and no time at all (mean h/h* of 0.12). h₂
  (3 per closed gate with sand above it, mean h/h* of 0.54) saves 60 % of the expansions and 57 %
  of the time. Neither is strong in absolute terms: a bound by the amount of sand, the natural
  first idea, is not even admissible here, because one outlet action can drain a whole column.
- **RBFS shows what linear memory costs on this problem.** It never holds more than 130 states,
  against tens of thousands for A*, and it finds the optimum whenever it finishes — but within
  500,000 expansions it finishes on only 12.2 % of the states. The cut-off is sharp in the length
  of the optimal plan:

  | Actions in the optimal plan | ≤ 6 | 7 | 8 | 9 | 10 | 11 | 12 | ≥ 13 |
  |---|---:|---:|---:|---:|---:|---:|---:|---:|
  | States | 1,788 | 1,803 | 3,388 | 5,789 | 9,155 | 10,496 | 9,646 | 16,984 |
  | Finished by RBFS | 97 % | 77 % | 48 % | 24 % | 8.9 % | 2.4 % | 0.3 % | 0 % |

  RBFS is a tree search, and here every plan can be interleaved between the two columns in a
  combinatorial number of ways, all passing through the same states. Without a transposition
  table those states are expanded over and over.
- **IDA\* avoids that only because it was given a transposition table**, and is still the slowest
  exact algorithm: 5.7 times slower than A* (h₂), with 101 states left unfinished at 2 million
  expansions. Step costs take the values 1, 3, 5, 7, 9, so there are many distinct f-contours and
  each iteration repeats most of the previous one (213,000 expansions against 14,000). Its memory
  advantage is modest (14,400 states against 22,200) because the table is nearly as large as A*'s
  open and closed lists.
- **IDS shows the same pattern against BFS**: 2.6 times the expansions for 55 % of the memory.
- **Weighted A\* is the best compromise.** With h₂ and w = 2 it expands 144 states on average,
  takes 0.22 ms, and returns plans 3.3 % above the optimum (worst case 25 %): a hundred times
  faster than A* for a sixth of the greedy approach's error.
- **The greedy approach is by far the cheapest**: 9 expansions, one state in memory, 9
  microseconds — nearly a thousand times faster than BFS for the same solution.
- **Fewest actions is not cheapest**: BFS and the greedy approach are optimal in cost on only
  2.5 % of the states, because a short plan opens every gate under a loaded box (cost 9) where a
  longer one splits boxes sideways and opens gates while they are light.

How the effort grows with the length of the optimal plan (mean states expanded):

| Actions in the optimal plan | 2 | 6 | 10 | 14 | 18 |
|---|---:|---:|---:|---:|---:|
| States with that length | 16 | 973 | 9,155 | 5,327 | 26 |
| UCS | 12 | 2,103 | 33,181 | 50,379 | 63,881 |
| A* (h₂) | 3 | 310 | 10,831 | 23,568 | 35,982 |

The interactive line chart in the Analysis tab shows this for every algorithm, for expansions,
memory and time. The advantage of A* over UCS shrinks from a factor of 7 on six-action plans to 3
at ten actions and 1.8 on the longest ones.

## 4. Effect of the grid size

Every initial state of each grid, same algorithms.

| Grid | States | Mean optimum | Optimal plans with a side gate | Greedy approach optimal | Mean greedy ÷ opt | Worst | Greedy optimal at unit cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2×2 | 81 | 15.1 | 0 % | 100 % | 1.000 | 1.00 | 100 % |
| 3×2 | 729 | 26.0 | 37.2 % | 38.7 % | 1.078 | 1.31 | 100 % |
| 4×2 | 6,561 | 38.0 | 62.4 % | 10.7 % | 1.141 | 1.40 | 100 % |
| 5×2 | 59,049 | 51.0 | 78.3 % | 2.5 % | 1.180 | 1.41 | 100 % |

| Grid | BFS expanded | UCS expanded | A* (h₂) expanded | IDA* expanded | RBFS expanded | RBFS finished | Weighted A* expanded |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2×2 | 11 | 31 | 16 | 64 | 111 | 100 % | 3 |
| 3×2 | 103 | 303 | 139 | 864 | 9,385 | 100 % | 8 |
| 4×2 | 1,047 | 3,189 | 1,335 | 13,026 | 271,755 | 56.6 % | 26 |
| 5×2 | 10,718 | 34,994 | 13,976 | 213,112 | 453,344 | 12.2 % | 144 |

- On the 2×2 grid no optimal plan uses a side gate and the greedy approach is always optimal.
  Each extra row makes side gates more valuable and greedy worse.
- Each extra row multiplies the initial states by 9 and the expansions of UCS and A* by about 10:
  the exact searches grow with the state space itself. RBFS grows by a factor of 85 from the 2×2 to
  the 3×2 grid and then runs into its budget.
- Weighted A* grows slowly: 3, 8, 26, 144 expansions.

## 5. The water variant (proposed form)

1,000 random 5×2 instances (empty 0.40, ½ sand 0.15, full sand 0.20, ½ water 0.10, full water
0.15; seed 1), concrete penalty 10, expansion limit 300,000 per run. The state space cannot be
enumerated (6¹⁰ cell configurations times the gate bits), so it is sampled; the reference optimum
of each instance comes from the exact algorithms that finished.

| Quantity | Value |
|---|---|
| Solvable instances | 985 of 1,000 (11 contain no sand at all); 15 are unsolvable |
| Optimum cost | mean 38.9, median 40, maximum 78 |
| Actions in the optimal plan | mean 7.7, maximum 17 |
| Optimal plans using a side gate | 63.2 % |
| Greedy approach | **gets stuck on 327 instances** (312 of them solvable); optimal on 200; mean ratio 1.176 where it finishes, maximum 4.09 |

![Histogram of Greedy_opt_ratio, water variant](figures/water-5x2-ratio-hist.svg)

| Algorithm | Solved | Optimal on | Mean cost ÷ opt | Worst | Mean time (ms) | Mean expanded | Mean peak memory | Hit the limit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Greedy approach | 673 | 20.3 % | 1.176 | 4.09 | 0.024 | 5.7 | 1 | 0 |
| BFS | 1,000 | 22.3 % | 1.217 | 3.67 | 21.8 | 6,353 | 10,900 | 0 |
| DFS | 1,000 | 2.1 % | 1.940 | 14.00 | 6.51 | 2,632 | 2,688 | 0 |
| IDS | 996 | 22.3 % | 1.217 | 3.67 | 21.5 | 15,400 | 5,458 | 4 |
| UCS | 962 | 97.7 % | 1.000 | 1.00 | 250 | 43,300 | 77,400 | 38 |
| A* (h₁) | 983 | 99.8 % | 1.000 | 1.00 | 202 | 30,400 | 58,400 | 17 |
| A* (h₂) | 985 | 100 % | 1.000 | 1.00 | 192 | 29,000 | 57,800 | 15 |
| RBFS | 239 | 24.3 % | 1.000 | 1.00 | 105 | 236,000 | 83 | 761 |
| IDA* | 683 | 69.3 % | 1.000 | 1.00 | 235 | 131,000 | 10,400 | 317 |
| Weighted A* | 996 | 94.0 % | 1.004 | 1.22 | 125 | 18,400 | 40,600 | 4 |
| Greedy best-first | 1,000 | 17.9 % | 1.278 | 2.83 | 2.72 | 979 | 1,014 | 0 |

(“Solved” counts the instances on which the algorithm returned a plan; BFS, DFS and greedy
best-first also “solve” the 15 unsolvable instances in the sense that they exhaust the reachable
states and report failure, which is counted as a run that finished. “Optimal on” is a share of all
1,000 instances; every run of an exact algorithm that finished is optimal.)

- **The greedy approach stops being a method.** It pours whatever is in a column straight down, so
  sand meets water, a box sets into concrete and the column is sealed: on a third of the instances
  it cannot finish, and 312 of those are solvable. Where it does finish it is often optimal (200 of
  673) — the easy instances — but its worst plan costs four times the optimum.
- **Mistakes get much more expensive.** Without water the worst plan of the greedy approach costs
  1.41 times the optimum; with water 4.09, BFS 3.67 and DFS 14. One careless action creates
  concrete (+10) and can force the remaining sand to be concreted as well.
- **A\* (h₂) is the only exact algorithm that finishes every solvable instance** within the limit;
  UCS runs out on 38, and the open-gate bits make the reachable space much larger than without
  water (water moves and keeps gates open too). h₂ falls back to h₁ whenever water is present,
  which is why the two A* rows nearly coincide.
- **Weighted A\* is now almost as expensive as A\*** (18,400 expansions against 29,000), because
  with h₂ reduced to the weak column bound there is little left to weight.
- **IDA\* and RBFS are not viable here**: they exhaust the limit on 31.7 % and 76.1 % of the
  instances.
- 15 instances are unsolvable although no start state contains concrete: the exact searches
  exhaust every reachable state without meeting the goal, because every way of moving the sand
  makes it meet water and the concrete that forms seals the rest in. Hand-made cases such as
  `0 0 / ½ 0 / # 0` are detected by every algorithm (see the tests).

## 6. Conclusions

1. **The greedy approach is optimal for unit costs and not for this cost function.** With one unit
   per gate it uses the fewest actions on all 59,049 states, as claimed in class. With
   `1 + 4·(s + s′)` it is optimal on 2.5 % of them and overpays by 18 % on average and at most
   41 %. It never uses a side gate (78 % of the optimal plans do), and it opens every gate under a
   loaded box.
2. On the assignment's own example all three printed plans are correct (47, 45, 46); the optimum
   is 38, by a plan that splits the top and bottom rows sideways and opens the right column's
   gates while they are only half loaded, so that each outlet drains its whole column for 5.
3. Of the four main searches only UCS is optimal in cost. BFS and IDS return exactly the quality
   of the greedy approach at a thousand times its cost; DFS is fast and poor.
4. UCS, A*, IDA* and RBFS agree with value iteration on every state they finish. A* with the
   closed-gate heuristic is the fastest exact algorithm; the column heuristic gives A* no advantage
   over UCS, which shows that designing the heuristic is the real work — and that the obvious
   “amount of sand” bound is not even admissible once gates stay open.
5. RBFS runs in 130 states of memory but finishes on only 12 % of the states: the state graph is
   full of transpositions, and a linear-memory tree search pays for every one of them.
6. Weighted A* with the closed-gate heuristic gives near-optimal plans (+3.3 %) for about 144
   expansions per instance.
7. Adding water and concrete keeps the model small but makes it harsher: errors become
   irreversible, some instances have no solution, the greedy approach fails outright on a third
   of them, and informed exact search (A*) becomes the only dependable exact method.

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
