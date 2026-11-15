# Assignment 2 — designing the heuristic function

*(نسخهٔ فارسی: [a2-heuristic-design.fa.md](a2-heuristic-design.fa.md))*

This project continues [Assignment 1](01-problem-original.md): same environment (sand boxes,
spring-loaded gates, cost `1 + 4·(s + s′)` for a top-down gate and 1 for a side gate), same
implementation of A* and RBFS. What is new is the heuristic function:

1. **h₂, designed by relaxation**, with a proof of admissibility and consistency (section 2), and
   its weaker sibling h₁;
2. **h₄, learned by linear regression** on the true cost-to-go of every reachable state, and its
   safe version h₅ (section 3);
3. an evaluation of what each buys A* and RBFS, in the [report](a2-report.md).

The notation h* denotes the optimal remaining cost of a state, which we can compute exactly for the
5×2 grid by value iteration over its whole reachable state graph (326,041 states).

## 1. What a heuristic can use

A state is the level of each box (0, ½, 1) plus the set of open top-down gates. Two facts about
the physics drive everything that follows:

- **Sand never leaves a column sideways.** A side gate levels a full box with an empty neighbour,
  so half a box stays behind. Whatever is above a gate in a column must, at least in part, pass
  that gate to reach the goal.
- **A gate is opened only by a paid action on that gate**, taken while a box with material sits
  above it. The action costs `1 + 4·(s + s′)` with `s ≥ ½`, so at least 3. Once open, a gate stays
  open while there is material above it, and everything flows through open gates for free.

The second fact also kills the most natural idea, a bound by the amount of sand (“each unit must be
flushed”): once the gates above an outlet are open, one outlet action drains the whole column for 5.
A bound such as “4 per unit of sand” is therefore **not admissible** here — the mechanical check of
section 2.3 rejects it immediately.

## 2. Heuristics by relaxation

### 2.1 The relaxed problem behind h₂

Let *G(n)* be the set of **closed** top-down gates of state *n* that have sand somewhere above them
in their own column (outlets included).

**Relaxed problem R.** A state is a set of gates *G*. The only action is *open g* for some
*g ∈ G*, which removes *g* from *G* and costs **3**. The goal is *G = ∅*.

R is obtained from the real problem by relaxing three things at once: the sand itself is ignored
(only the gates matter), the cost of opening a gate is lowered to the smallest value it can take in
the real problem, and all other actions are made free and useless. The optimal cost of R from the
set *G(n)* is simply 3·|G(n)|, because every gate must be opened once and nothing else helps. This
defines

> **h₂(n) = 3 · |G(n)|**, three times the number of closed top-down gates with sand above them.

**h₁** is the same idea one level coarser: a column that holds sand needs at least one more paid
action of its own (a gate opened under sand, or — in the water variant — a flow that sets the
sand into concrete), so **h₁(n) = 3 · (number of columns with sand)**.

### 2.2 Proof of admissibility and consistency of h₂

**Lemma 1.** In any solution from *n*, every gate *g ∈ G(n)* is opened by some action of that
solution.

*Proof.* Let *g* be under box *U* in column *c*, and let *x > 0* be the amount of sand in column *c*
above *g* (in or above *U*). Sand moves only through open top-down gates (down) or through side
gates (which move half a box out of a full box and leave the other half in place). So the amount
of sand in column *c* above *g* can only fall below *x/2* … in fact can only reach 0 … by passing
through *g*: side gates never empty a box, and no other gate leads out of that region. Since the
goal has no sand anywhere, some sand must pass *g*, which is closed in *n*. A closed gate changes
state only through the action *open g*. ∎

**Lemma 2.** Any action that opens a gate costs at least 3.

*Proof.* The action is applicable only when the box above the gate holds sand, so `s ≥ ½`, and
`s′ ≥ 0`; hence `1 + 4·(s + s′) ≥ 3`. ∎

**Theorem (admissibility).** h₂(n) ≤ h*(n) for every state *n*.

*Proof.* Take an optimal solution from *n*. By Lemma 1 it contains, for each *g ∈ G(n)*, an action
that opens *g*; these actions are distinct, since one action opens one gate. By Lemma 2 each costs
at least 3. So the solution costs at least 3·|G(n)| = h₂(n). ∎

**Theorem (consistency).** For every transition *n → n′* with cost *c*: h₂(n) ≤ c + h₂(n′).

*Proof.* It suffices to show |G(n)| − |G(n′)| ≤ c / 3. A gate leaves *G* either because it was
opened — only the gate acted on, cost ≥ 3 — or because the sand above it disappeared; but sand
above a closed gate cannot leave that region (Lemma 1's argument), so that never happens. A side
gate (cost 1) opens nothing, so it removes nothing from *G* (it may add gates in the other column,
which only increases h₂). Hence at most one gate leaves *G* per action, and only for an action of
cost ≥ 3. ∎

Consistency means A* with h₂ never has to reopen a state and that h₂ along any path is
non-decreasing in *f*; admissibility means A*, RBFS and IDA* with h₂ return optimal plans.

### 2.3 Mechanical check

Proofs can hide mistakes about the rules, so the test-suite (`npm test`) also checks both bounds
against the exact h* on **every reachable state and every transition** of the 1×2 … 5×2 grids
(326,041 states and 2.3 million transitions for 5×2): no state has h₁ or h₂ above h*, and no
transition violates consistency. The same check reports, on the 5×2 initial states, a mean h/h* of
**0.12 for h₁** and **0.54 for h₂**.

### 2.4 What h₂ misses

h₂ charges 3 per closed gate, the price of opening it under half a box. It ignores that a gate
under a *full* box costs at least 5 unless the box is first split sideways; that a box refilled
from above makes `s′ > 0`; and that two gates may have to be opened under the same pile. The
largest gaps are therefore on tall, full piles. Tightening these bounds by hand is possible but
every refinement needs a new proof; the learned heuristic of the next section takes the other
road.

## 3. A heuristic learned by linear regression

### 3.1 Data

Value iteration over the whole reachable state graph of the 5×2 grid gives h* for all 326,041
states (326,040 of them non-goal). That is the training set: every state, not a sample, so the
model sees the full distribution it will be used on. `scripts/learn-heuristic.mjs` builds it in
about three seconds.

### 3.2 Features

Thirteen counts, chosen so that each has a reading in the physics (`js/core/features.js`):

| # | Feature | Why it should matter |
|---|---|---|
| 0 | bias | |
| 1 | sand, in half-units | more sand, more to move |
| 2 | columns with sand | h₁ |
| 3 | closed gates with sand above them | h₂ |
| 4 | closed gates whose own box is full | opening those costs ≥ 5, not 3 |
| 5 | open gates with sand above them | work already paid for |
| 6 | boxes with sand | |
| 7 | full sand boxes | |
| 8 | half sand boxes | halves are cheap to move |
| 9 | fall distance: Σ level × closed gates below | h₃ without its factor |
| 10 | height of sand: rows from the top sand box to the bottom, both columns | |
| 11 | rows where a side gate can act | cheap splits available |
| 12 | empty boxes below sand | gaps the sand still has to cross |

### 3.3 Fit

Ordinary least squares (the normal equations, 13 unknowns), target h*. The result and its
diagnostics are in `data/a2-regression.json` and on the *Learned* tab of the page:

| | h₄ (regression) | h₅ = max(h₂, h₄ − δ) | h₂ (proven) |
|---|---:|---:|---:|
| R² against h* | 0.921 | −0.67 | −5.99 |
| RMSE | 2.62 | 12.0 | 24.6 |
| Mean absolute error | 2.08 | 11.7 | 23.7 |
| States where h > h* | 48.6 % | 0 % | 0 % |
| Largest overestimate | +11.76 | 0 | 0 |
| Mean h / h* | 1.004 | 0.741 | 0.497 |

(R² is negative for h₅ and h₂ because they are bounds, not estimates: they sit far below h* on
purpose.) Over all reachable states; the figures on the 59,049 initial states alone are within a
few hundredths of these.

The weights themselves are not separately meaningful — the features are strongly correlated and
the model balances large positive and negative terms — but the picture is: h₄ tracks h* with a
typical error of about 2 on costs that run from 3 to 76, and it is **above h* on half of the
states**. It is an estimate, not a bound.

### 3.4 Making it safe: h₅

Let δ be the largest amount by which h₄ exceeds h* on any training state (δ = 11.76). Then

> **h₅(n) = max( h₂(n), h₄(n) − δ )**

is at most h* on every training state, by construction, and at least h₂, so it is never less
informed than the proven bound: its mean h/h* is 0.74 against 0.50 for h₂. It is *not* proven
admissible — a state outside the training set (a larger grid, say) could break it — and the shift
δ is set by the single worst state, so it is probably more cautious than necessary. Both facts are
measured rather than assumed in the report.

### 3.5 Generalisation

A model trained on the 4×2 grid (23,409 states) and applied to 5×2 reaches R² 0.83 with RMSE 3.9,
but overestimates 74 % of the states, by up to +19.8. The features carry over; the calibration does
not, because the cost of a plan grows faster than any single count when the tower gets taller.

## 4. Effective branching factor

For a run that generates *N* states and returns a plan of *d* actions, the effective branching
factor b* is the branching factor of the uniform tree of depth *d* with *N + 1* nodes:

> 1 + b* + b*² + … + b*^d = N + 1

(Russell & Norvig, §3.6.1). It is computed by bisection in `effectiveBranchingFactor()` and
reported for every run; the report averages it per heuristic over the 59,049 initial states. A
heuristic is better the closer it brings b* to 1 while keeping the plans optimal.

## 5. Files

| | |
|---|---|
| `js/core/heuristics.js` | h₀ … h₅ |
| `js/core/features.js` | the 13 features |
| `js/core/learned.js` | the fitted weights and δ (generated) |
| `scripts/learn-heuristic.mjs` | training, diagnostics, the 4×2 → 5×2 transfer, sample points for the plots |
| `js/core/analysis.js` | value iteration (h*), b*, the batch evaluation |
| `tests/sandbox.test.mjs` | the mechanical admissibility and consistency check, b*, the features |
