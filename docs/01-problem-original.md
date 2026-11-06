# Sand Boxes — the original problem

*(نسخهٔ فارسی: [01-problem-original.fa.md](01-problem-original.fa.md))*

## 1. Informal description

A tower of boxes is arranged in **n rows and 2 columns**. Each box is empty, half full or full of
sand. Gravity acts downward. Neighbouring boxes are separated by spring-loaded gates:

- one **top-down gate** under every box. The gates under the bottom row lead outside (outlets);
- one **side gate** between the two boxes of every row.

A gate stays shut until the agent opens it. The weight of the sand then pushes through, the sand
settles as far as the allowed levels (0, ½, 1) permit, and the gate springs shut again.

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
| **State** | A vector of 2n levels, one per box, each in {0, ½, 1}. |
| **State space** | 3^(2n) states: 59,049 for the 5×2 grid used in the evaluation. |
| **Initial state** | Each box independently: empty with probability 0.5, full 0.3, half 0.2. |
| **Actions** | Open one gate: n side gates + 2n top-down gates = 3n actions (15 for n = 5). Gates that would move nothing are not applicable. |
| **Goal test** | Every box is empty. |
| **Step cost** | Action a: `1 + 4·(s + s′)`. Action b: `1`. |
| **Path cost** | Sum of step costs. |

### Action a — top-down gate under box U (lower box L)

1. Sand falls from U into L until L is full or U is empty: `p = min(U, 1 − L)`.
   Through an outlet the whole content of U leaves the grid.
2. **Doors pressed from both sides.** A spring door opens by itself only when material presses on
   it from both sides: the box above it holds sand (pressing down) and the box below it is *full*
   (its sand touches the door from underneath). So if U is full when its gate is opened, the door
   on top of U opens as well and the box above pours into U; if that box was full too, the door on
   top of *it* opens, and so on up the pile. The chain stops at the first box that is empty, and
   right after the first box that is only half full — a half box does not reach the door above it,
   so whatever lies on that door stays where it is.
3. **Everything falls at the same moment.** All these doors are open together; each box passes its
   sand to the box below as far as there is room.
4. Cost `1 + 4·(s + s′)`, where `s` is the level of U before the action and `s′` its level after
   everything has fallen.

`s′` is therefore non-zero in two situations: L could not take everything, or U was refilled from
above at the same moment. Flushing a full box with sand resting on it costs 9 (or 7 if only half a
box rests on it); flushing a lone full box costs 5.

Some single actions on one column (top to bottom), to make the rule concrete:

| Before | Gate opened | After | s → s′ | Cost |
|---|---|---|---|---|
| 0, 1, 1, 1 | outlet | 0, 0, 1, 1 | 1 → 1 | 9 |
| ½, 1, 1, 1 | outlet | 0, ½, 1, 1 | 1 → 1 | 9 |
| ½, 1, ½, 1 | outlet | ½, 1, 0, ½ | 1 → ½ | 7 |
| ½, 1, ½, 1 | under box 2 | 0, 1, 1, 1 | 1 → 1 | 9 |
| 1, ½, ½, 1 | under box 2 | 1, 0, 1, 1 | ½ → 0 | 3 |
| 1, 0, 1, 1 | outlet | 1, 0, 0, 1 | 1 → 1 | 9 |

In the third row the half box (box 3) follows the flushed full box, but the full box above it does
not: the door between boxes 2 and 3 has only half a box underneath. In the fifth row a half box
drains, so nothing follows at all.

### Action b — side gate of a row

Sand moves only when one box is full and the other empty; both end up half full. Any other pair
would have to settle on a level that is not allowed (for example ¾ and ¾), so nothing moves and the
action is not applicable. Cost 1. A side gate never makes the doors above open.

### Properties of the state graph

- Sand only moves down or levels out, so the graph is **acyclic** and every path is finite.
- Without water every state is **solvable** (flush every box straight down).
- The branching factor is at most 3n.

## 3. The worked example of the assignment

```
1 0
0 1
0 1
1 0
```

| Plan | Costs as printed in the assignment | Printed total | Actual cost |
|---|---|---|---|
| Greedy approach (section 4.1) | left 5+5+9+5 = 24, right 9+9+5 = 23 | 47 | **47** |
| Side gates (“might be optimum”) | 1+1 = 2, then 7+9+9+5 = 30 and 3+5+5 = 13 | 45 | **54** |
| Other alternative | 1+1 = 2, then 3+5+9+9+5 = 31 and 3+5+5 = 13 | 46 | **46** |

The first and third plans are correct as printed. **The second one misses a 9.** After the two side
gates the left column is 1, ½, ½, 1. The action that costs 7 opens the gate under the top box and
leaves ½, 1, ½, 1. That column cannot be flushed in three actions: the half box in the third row
does not press on the door above it, so opening the outlet now only lets that half box follow
(cost 7, leaving ½, 1, 0, ½). The pile first has to be packed by opening the gate under the second
box — the full box pours half its sand down and the half box above follows at the same moment, so
s = s′ = 1 and the action costs 9 — and only then come the three flushes 9 + 9 + 5:

```
start      S2        S3        L1        L2        L⤓        L⤓        L⤓        R2        R3        R⤓
1 0       1 0       1 0       ½ 0       0 0       0 0       0 0       0 0       0 0       0 0       0 0
0 1   →   ½ ½   →   ½ ½   →   1 ½   →   1 ½   →   0 ½   →   0 ½   →   0 ½   →   0 0   →   0 0   →   0 0
0 1       0 1       ½ ½       ½ ½       1 ½       1 ½       0 ½       0 ½       0 1       0 0       0 0
1 0       1 0       1 0       1 0       1 0       1 0       1 0       0 0       0 0       0 1       0 0
cost       1         1         7         9         9         9         5         3         5         5    = 54
```

(S = side gate of that row, L/R = gate under that box in the left/right column, ⤓ = outlet.)

So the side-gate plan is in fact *worse* than going straight down. The printed total of 45 is
nevertheless the true optimum — reached by a different plan that the search finds: open the side
gate of the **top** row only.

```
start      S1        L1        L2        L⤓        L⤓        R3        R⤓        R⤓        R⤓
1 0       ½ ½       0 ½       0 ½       0 ½       0 ½       0 0       0 0       0 0       0 0
0 1   →   0 1   →   ½ 1   →   0 1   →   0 1   →   0 1   →   0 ½   →   0 0   →   0 0   →   0 0
0 1       0 1       0 1       ½ 1       0 1       0 1       0 1       0 ½       0 0       0 0
1 0       1 0       1 0       1 0       ½ 0       0 0       0 1       0 1       0 ½       0 0
cost       1         3         3         7         3         9         9         7         3    = 45
```

Half boxes are cheap to carry down (3 instead of 5), the half box on top of the right-hand pile
rides down for free with the full boxes under it, and the last two flushes of each column cost
7 + 3 instead of 9 + 5.

All four plans can be replayed from the *Rules* tab of the site; the test-suite checks each cost
sequence, and checks the 54-plan state by state on the 5×2 grid (with an empty top row).

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
the effect: on the 4×2 example above A* expands about 1,000 states and RBFS about 1,000,000, while
holding fewer than 100 states in memory. In the benchmark RBFS gets a budget of 500,000 expansions
per instance.

## 5. Heuristics

Let T be the amount of sand left, in units.

**h₁ — sand volume.** `h₁ = 4T + ⌈T⌉`.
Sand leaves only through an outlet. An outlet action that removes `s` units costs at least
`1 + 4s` and removes at most one unit, so the outlet actions alone cost at least `4T + ⌈T⌉`.
*Admissible and consistent.*

**h₂ — volume + gates.** `h₂ = h₁ + 3 · (number of boxes that are not full and have sand above them in the same column)`.
Take such a box E. Some of the sand above it stays in that column until it has crossed the gate on
top of E (a side gate always leaves half a box behind). The first crossing cannot be a free ride:
the door only opens by itself when E is full, and E cannot become full without sand crossing that
gate first, because a side gate only flows into an empty box and brings just half a box. So the
gate on top of E must be opened by a paid action with s ≥ ½, which costs at least 3. That gate is
not an outlet and belongs to E alone, so the 3s add up with each other and with h₁.
*Admissible and consistent.*

**h₃ — fall distance.** `h₃ = 5 · Σ (units of sand × gates still below it)`.
The cost of carrying every unit down alone. Pressed doors let a whole stack drop for one action, so
h₃ overestimates: it is **not admissible**. It never rewards a side gate, which makes greedy
best-first search behave much like the greedy approach of section 4.1; on the example above
it also returns 47.

Both admissibility and consistency of h₁ and h₂ are verified by the test-suite on *every* state and
transition of the 1×2 … 5×2 grids. On the 5×2 grid the mean ratio h/h* is 0.41 for h₁ and 0.64
for h₂.

## 6. Alternative door rules

The rule above is the default. Two alternatives can be selected in the simulator
(*Physics options*) and in the scripts (`--chain always|none`), for comparison:

- **always** — every non-empty box of the unbroken pile above follows, whether the boxes under it
  are full or not (the example's optimum drops to 36);
- **none** — only the two boxes joined by the opened gate change (the example's optimum is 50).
