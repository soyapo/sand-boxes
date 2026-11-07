# Sand Boxes — the original problem

*(نسخهٔ فارسی: [01-problem-original.fa.md](01-problem-original.fa.md))*

## 1. Informal description

A tower of boxes is arranged in **n rows and 2 columns**. Each box is empty, half full or full of
sand. Gravity acts downward. Neighbouring boxes are separated by spring-loaded gates:

- one **top-down gate** under every box. The gates under the bottom row lead outside (outlets);
- one **side gate** between the two boxes of every row.

A closed gate stays closed until the agent opens it. A top-down gate, once opened, stays open as
long as there is material directly above it and snaps shut by itself when that box is empty. A side
gate closes again right after use. Everything that can flow through the open gates flows at the
same moment.

The task is to **empty the whole grid** as cheaply as possible.

```
        col 0   col 1
row 1  [  1  |  0  ]      | = side gate (action b)
        --v-----v--       v = top-down gate (action a)
row 2  [  0  |  1  ]
        --v-----v--
row 3  [  0  |  1  ]
        --v-----v--
row 4  [  1  |  0  ]
        --v-----v--       bottom gates = outlets
```

## 2. Formal model

| Element | Definition |
|---|---|
| **State** | The level of each of the 2n boxes, each in {0, ½, 1}, plus the set of top-down gates that are open. |
| **Initial states** | Every gate closed; each box independently empty with probability 0.5, full 0.3, half 0.2. There are 3^(2n) of them: 59,049 for the 5×2 grid used in the evaluation. |
| **Reachable states** | Gate bits make the graph larger than the set of initial states: 326,041 states are reachable from the 59,049 initial states of the 5×2 grid. |
| **Actions** | Open one gate: n side gates + 2n top-down gates = 3n actions (15 for n = 5). An action that would change nothing is not applicable. |
| **Goal test** | Every box is empty (open gates do not matter). |
| **Step cost** | Action a: `1 + 4·(s + s′)`. Action b: `1`. |
| **Path cost** | Sum of step costs. |

### Action a — top-down gate under box U (lower box L)

1. The gate must be closed and U must hold sand; otherwise the action does nothing and is not
   applicable. The gate opens, even if L is full and nothing can move yet.
2. **Everything flows at the same moment.** Through every open gate of the grid, the box above
   pours into the box below until the lower box is full or the upper one is empty; through an open
   outlet the bottom box drains out. This repeats until nothing moves any more.
3. **Gates close when their box empties.** Every open gate whose box above is now empty closes.
   A gate with material still above it stays open, whether or not anything moved through it.
4. Cost `1 + 4·(s + s′)`, where `s` is the level of U before the action and `s′` its level after
   everything has settled.

Some single actions on one column (top to bottom, `-` marks an open gate under that box):

| Before | Gate opened | After | s → s′ | Cost |
|---|---|---|---|---|
| 1, 0, 0 | under box 1 | 0, 1, 0 | 1 → 0 | 5 (gate closes again) |
| 1, ½, 0 | under box 1 | ½⁻, 1, 0 | 1 → ½ | 7 (gate stays open) |
| 1, 1, 0 | under box 1 | 1⁻, 1, 0 | 1 → 1 | 9 (nothing moves, gate stays open) |
| 1⁻, 1, 0 | under box 2 | 0, 1⁻, 1 | 1 → 1 | 9 (box 1 follows through its open gate) |
| 1⁻, 1⁻, 1 | outlet | 0, 0, 0 | 1 → 0 | 5 (the whole column drains) |
| ½, 1, ½ | under box 1 | ½⁻, 1, ½ | ½ → ½ | 5 (nothing moves, gate stays open) |

The last two rows are the heart of the cost function: opening a gate under a loaded box is
expensive, but once gates are open the material that falls through them later costs nothing, so
one outlet action can empty a whole column for 5.

### Action b — side gate of a row

Sand moves only when one box is full and the other empty; both end up half full. Any other pair
would have to settle on a level that is not allowed (for example ¾ and ¾), so nothing moves and the
action is not applicable. Cost 1. The side gate closes at once; what moved may then flow on through
open top-down gates.

### Properties of the state graph

- Sand only moves down or levels out, and a gate closes only when sand has left the box above it,
  so the graph is **acyclic** and every path is finite.
- Without water every state is **solvable** (flush every box straight down).
- The branching factor is at most 3n.

## 3. The worked example of the assignment

```
1 0
0 1
0 1
1 0
```

| Plan | Costs as printed in the assignment | Total |
|---|---|---|
| Greedy approach (section 4.1) | left 5+5+9+5 = 24, right 9+9+5 = 23 | **47** |
| Side gates (“might be optimum”) | 1+1 = 2, then 7+9+9+5 = 30 and 3+5+5 = 13 | **45** |
| Other alternative | 1+1 = 2, then 3+5+9+9+5 = 31 and 3+5+5 = 13 | **46** |

All three are correct under the rules above; the implementation reproduces every step cost and
the test-suite checks the side-gate plan state by state, open gates included. That plan shows the
spring gates at work in the left column (`-` = open gate under the box):

```
start      S2        S3        L1        L2        L3        L⤓        R2        R3        R⤓
1 0       1 0       1 0       ½ 0       0 0       0 0       0 0       0 0       0 0       0 0
          .         .         -         .         .         .         .         .         .
0 1   →   ½ ½   →   ½ ½   →   1 ½   →   1 ½   →   1 ½   →   0 ½   →   0 0   →   0 0   →   0 0
          .         .         .         -         -         .         .         .         .
0 1       0 1       ½ ½       ½ ½       1 ½       1 ½       0 ½       0 1       0 0       0 0
          .         .         .         .         -         .         .         .         .
1 0       1 0       1 0       1 0       1 0       1 0       0 0       0 0       0 1       0 0
cost       1         1         7         9         9         5         3         5         5    = 45
```

- **L1 (7):** the top box pours half into the half box below; it keeps half, so its gate stays open.
- **L2 (9):** the second box pours half into the half box below it and is refilled at the same
  moment by the half box above through the open gate: s = s′ = 1.
- **L3 (9):** the gate between two full boxes opens; nothing moves, but it is now open.
- **L⤓ (5):** the outlet opens, the bottom box drains, and the two boxes above follow through
  their open gates — three units leave for the price of one.

The search finds a cheaper plan, **38**, which every exact algorithm (UCS, A*, IDA*, RBFS) agrees on:

```
start      S1        L1        L2        S4        L3        R3        R2        R1        L⤓        R⤓
1 0       ½ ½       0 ½       0 ½       0 ½       0 ½       0 ½       0 ½       0 0       0 0       0 0
0 1       0 1       ½ 1       0 1       0 1       0 1       0 1       0 ½⁻      0 1⁻      0 1⁻      0 0
0 1       0 1       0 1       ½ 1       ½ 1       0 1       0 ½⁻      0 1⁻      0 1⁻      0 1⁻      0 0
1 0       1 0       1 0       1 0       ½ ½       1 ½       1 1       1 1       1 1       0 1       0 0
cost       1         3         3         1         3         7         7         3         5         5    = 38
```

Half boxes are cheap to carry down (3 a step), and the right column's gates are opened from the
bottom up while the boxes above them are only half loaded (7, 7, 3), so that in the end each
outlet drains its whole column for 5. All four plans can be replayed from the *Rules* tab.

## 4. Algorithms

### 4.1 The greedy approach (required)

“Greedy” in this assignment does **not** mean greedy best-first search from the informed-search
chapter; that algorithm needs a heuristic. It is the procedure proposed in class, which looks
reasonable and, with an ordinary cost of one unit per opened gate, gives the optimum:

1. Never open a side gate. Treat the two columns separately and independently.
2. In a column, go to the **topmost box that contains sand** and open the gate under it. The sand
   either moves down or stays stuck where it is (the box below is full). Either way, move on to the
   box below and do the same, down to the outlet.
3. Repeat such top-to-bottom sweeps until the column is empty.

A gate that would move nothing is not an action in this model, so a stuck box is simply skipped and
costs nothing. On the worked example the procedure produces exactly the sequence quoted in the
assignment, in the same order: left column 5, 5, 9, 5, then right column 9, 9, 5, total 47.

The procedure is not a search: it follows one fixed path, expands as many states as it takes
actions, and holds a single state in memory. Its cost is the **“cost by greedy solution”** used in
`Greedy_opt_ratio` and in the first scatter plot.

Two facts about it, both checked on every state (see the report):

- with **one unit per gate** it always uses the fewest possible actions, so it is optimal for that
  cost function, as was said in class;
- with the cost function `1 + 4·(s + s′)` it is optimal on only a small share of the states.

### 4.2 The four main searches (required)

| Algorithm | Order of expansion | Optimal cost? | Remarks |
|---|---|---|---|
| BFS | FIFO | no (fewest actions) | graph search, goal test on generation |
| DFS | LIFO | no | graph search, first solution found |
| IDS | depth-limited DFS, limit 0, 1, 2… | no (fewest actions) | per-iteration transposition table |
| UCS | lowest g | **yes** | Dijkstra |

### 4.3 Informed searches (bonus)

| Algorithm | Order of expansion | Optimal cost? | Remarks |
|---|---|---|---|
| A* | lowest g + h | **yes** (admissible h) | reopens states on a cheaper path |
| RBFS | best f first, f-values backed up | **yes** (admissible h) | pure tree search, memory linear in the depth |
| IDA* | DFS inside growing f-contours | **yes** (admissible h) | per-iteration transposition table |
| Weighted A* | lowest g + 2h | no (≤ 2 × optimum) | |
| Greedy best-first | lowest h | no | the textbook “greedy”, guided by h₃; kept for comparison only |

**Transpositions.** The two columns are largely independent, so the actions of any plan can be
interleaved in a combinatorial number of ways, all leading through the same states. A pure tree
search re-explores them again and again. IDS and IDA* therefore keep a transposition table that
lives for one iteration. RBFS is left as the textbook algorithm, with no table, precisely to show
the effect: on the 4×2 example above A* expands about 1,700 states and RBFS about 2,000,000, while
holding fewer than 100 states in memory. In the benchmark RBFS gets a budget of 500,000 expansions
per instance.

## 5. Heuristics

**h₁ — columns.** `h₁ = 3 · (number of columns that still hold sand)`.
A side gate always leaves half a box behind, so sand never leaves a column sideways; every column
with sand needs at least one more paid action of its own — a top-down gate opened under a box with
sand (s ≥ ½, cost ≥ 3) or, with water, a flow that sets the sand into concrete (≥ 10). The actions
of different columns are different actions. *Admissible and consistent*, but weak.

Note that a bound by the amount of sand (as in “each unit must be flushed”) is **not** valid in
this model: one outlet action can drain a whole column for 5.

**h₂ — closed gates.** `h₂ = 3 · (number of closed top-down gates with sand above them in their column)`.
Some of the sand above such a gate stays in the column until it has passed the gate, and a gate
only opens by a paid action on that very gate with sand above it, which costs at least 3. The gates
are distinct, so the 3s add up. Open gates cost nothing more. *Admissible and consistent.*
With water or concrete the argument no longer holds (sand may be concreted in place), so h₂ falls
back to h₁.

**h₃ — fall distance.** `h₃ = 5 · Σ (units of sand × closed gates still below it)`.
The cost of carrying every unit down alone through gates that must each be opened for it. Open
gates let a whole pile drop for one action, so h₃ overestimates: it is **not admissible**. It never
rewards a side gate, which makes greedy best-first search behave much like the greedy approach of
section 4.1.

Both admissibility and consistency of h₁ and h₂ are verified by the test-suite on *every*
reachable state and transition of the 1×2 … 5×2 grids (326,041 states and 2.3 million transitions
for 5×2). On the 5×2 initial states the mean ratio h/h* is given in the report.
