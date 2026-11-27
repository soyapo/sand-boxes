# Assignment 3 — a genetic algorithm over action sequences: our choices for the seven steps

The project brief ("Designing and implementing a genetic algorithm for path-search problems")
describes the method in seven steps and asks for the choice or design made at each step, with
enough detail and with reasons. This document is that account. The measured results are in
[a3-results.md](a3-results.md); the code is in [`js/core/genetic.js`](../js/core/genetic.js) and
the live page at [soyapo.github.io/sand-boxes/assignment-3/](https://soyapo.github.io/sand-boxes/assignment-3/).

Where the brief leaves a choice, the alternatives are implemented too and compared in the
evaluation, so that every default below is backed by a measurement rather than a preference.

| Step | Brief | Our choice | Where |
|---|---|---|---|
| 1 | Define the problem | the Sandbox of Assignment 1; three classes | `Problem`, `Environment`, `SolverAgent` |
| 2 | State = sequence of actions, fixed maximum length | array of action ids, bound 4 per row, cut at the goal | individuals; `Problem.maxLength` |
| 3 | Path_Goal_Test / Successful_Path_Test | replay and test | `successfulPath` (= `pathGoalTest`, `successfulPathTest`) |
| 4 | Conflict Number: approximate distance to the goal, smallest along the sequence | closed gates with sand above them, × 9; min along the path | `CONFLICTS`, `Problem.conflictNumbers`, `Problem.pathConflicts`, `conflictNumber` |
| 5 | Fitness = L − w₁·f(conflict) − w₂·g(cost), successful paths far above | that form, f = g = identity, w₁ = 9, w₂ = 1, L derived | `FITNESS`, `fitnessValue`, `fitness` |
| 6 | Initial population; mutation (replace / swap / reverse, lethal if illegal); single- or double-point crossover | random legal walks; the three mutations + insert / delete / regrow; repair, retry (lethal) or keep; single and double point | `SolverAgent.randomIndividual`, `.mutate`, `.crossover`, `.build` |
| 7 | Selection: fitness → probability; a mating pool of the population's size with repeats; pairs (i, i+1) | roulette on f − f_min (default), plain roulette, ranking, tournament; 2 elites | `selection`, `selectionProbabilities`, `SolverAgent.run` |

## Step 1 — The problem

The problem is the Sandbox of Assignment 1: a tower of *n*×2 boxes with sand (0, ½, 1 per box),
spring-loaded top-down gates that stay open while sand is above them, side gates that level a
full box with an empty neighbour, action costs `1 + 4·(s + s′)` for a top-down gate and 1 for a
side gate, and the goal "no sand left". Everything about the environment (physics, costs, goal
test, legal actions) is the model of Assignment 1, `js/core/model.js`, unchanged; the genetic
algorithm sees it through the problem interface the other algorithms use (`start`, `isGoal(s)`,
`succ(s)` = the legal actions with their outcome and cost).

The task, in the brief's words, is to find a *successful path*, a sequence of actions from the
initial state to a goal state, and, since every state of this puzzle can be emptied, to find a
cheap one. The three classes:

* **Problem** — the start state, the goal test, the action list, the length bound of a sequence,
  the conflict function and how it is read along a sequence, and `large_number`.
* **Environment** — applies an action to a state and returns the next state and its cost, or
  `null` if the action is illegal there (it would move nothing: the gate is already open, the box
  above it is empty, the side gate is not between a full box and an empty one); lists the legal
  actions; replays a whole sequence. It counts the actions it applied, the "states generated" of
  this algorithm.
* **SolverAgent** — the genetic algorithm. It only touches the problem through the environment.

## Step 2 — A state is a sequence of actions

An individual is an array of action ids (`S2 L1 R4 …`: side gate of row 2, left gate under
row 1, right outlet), read from the initial state; the state it "is" is whatever the environment
reaches after applying it. Its length is bounded by `maxLength`.

**Choice of the bound.** 4 actions per row: 20 for the 5×2 grid, 24 for 6×2. The longest optimal
plan of any 5×2 initial state has 18 actions (value iteration, Assignment 1), so every optimal
plan is representable with room to spare; a looser bound only lengthens the random walks.

**Actions after the goal.** As the brief says, if the goal is reached before the last action the
rest of the sequence is ignored: the replay stops at the first goal state, the later actions are
neither applied nor paid for, and the individual is stored cut to its useful prefix. So the
sequences in the population have different lengths, which the operators have to accept.

## Step 3 — Path_Goal_Test

`successfulPath(problem, env, sequence)` (also exported under the brief's names `pathGoalTest`
and `successfulPathTest`): replay the sequence from the initial state and return `true` if a goal
state is reached at any point, `false` otherwise (also `false` if an action is illegal before the
goal). Nothing else is needed here; the work is in the environment's `replay`.

## Step 4 — Conflict Number

### 4.1 What is scored

A function that scores one state by how far it seems from the goal, 0 at a goal state. The brief
suggests, for the Sandbox, the number of boxes that are still full. We implemented that and seven
other counts (table below) and chose as default **the number of closed top-down gates that still
have sand above them in their column**, multiplied in the fitness by 9. Reasons:

* It is a genuine count of *conflicts*: each of these gates stands between some sand and the
  outlet and has to be opened by one paid action before the goal can be reached. A box count or a
  sand count does not see how deep the sand sits, and depth is what costs.
* Multiplied by the largest possible action cost (9 = 1 + 4·(1 + 1)) it is **never below the true
  remaining cost** on any of the 326,041 reachable states of the 5×2 grid (the largest observed
  h\* ÷ (3·gates) is 2.73 < 3; the test-suite checks the inequality on every reachable state up
  to 4×2). Step 5 explains why this property, the opposite of admissibility, is what the fitness
  needs.
* It is cheap: one pass over the grid.

| Key | Count | Weight w₁ | Why this weight |
|---|---|---:|---|
| `gates` (default) | closed top-down gates with sand above them (= h₂ ÷ 3) | 9 | the largest action cost; 9·gates ≥ h\* on every reachable 5×2 state |
| `boxes` | boxes that still hold sand (the brief's example) | 9 | same scale; blind to depth, so it can be far below h\* |
| `sand` | half-units of sand left | 9 | same; h\* ÷ sand reaches 15 |
| `fall` | h₃ of Assignment 2: 2.5 per half-unit per closed gate below it | 1.2 | overestimates on 99.7% of states; h\*/h₃ ≤ 1.2 |
| `sweep` | cost of the greedy approach (Assignment 1) run from the state | 1 | an exact upper bound on h\*, tight on 10% of states |
| `h2` | h₂ unweighted | 1 | the admissible bound: the failure case of 5.2 |
| `learned` | h₄ of Assignment 2 | 1.35 | h\*/h₄ ≤ 1.34 on the training states where h₄ > 0 |
| `zero` | nothing | — | fitness = L − cost; only meaningful with the strict form |

### 4.2 How a sequence is scored: the smallest value along it

The brief is explicit: the sequence is executed from `problem.initial_state`, the state after
every action is scored, and the **smallest Conflict Number observed during the execution** is
reported. That is what `Problem.pathConflicts` does (the start state included; a goal state gives
0 and ends the scan). The end-state value is kept as an option (`conflictMode: 'end'`) because the
first version of this project used it and the large 59,049-state run was made with it.

The two differ in this puzzle: a side gate spreads sand into a column that may have had none, so
the gate count can rise along a path and the minimum sits at an earlier prefix. Measured on 100
random 5×2 problems, the brief's rule gives more optimal plans than the end-state rule (sections
1.3 and 1.4 of the results), so the brief's rule is also the better one here; the margins between
configurations on 100 problems are a few problems wide, so small differences there are not
conclusive.

## Step 5 — Fitness

### 5.1 The form

```
fitness(sequence) = large_number − w₁ · f(conflict_number) − w₂ · g(path_cost)
                  = 0                                   if an action of the sequence is illegal
```

This is the brief's general form. `f` and `g` are increasing functions, chosen from identity, √x
and ln(1 + x); w₁ and w₂ are positive weights. Defaults: f = g = identity, w₂ = 1, w₁ = 9 (the
weight of the default conflict count). The brief's two criteria hold:

* a **successful** sequence has conflict number 0 and scores `large_number − w₂·g(path_cost)`:
  far above any unsuccessful one (next paragraph), and the cheaper the better;
* an **unsuccessful** sequence is not scored 0, as the brief requires: its fitness falls with the
  smallest conflict number it reached, so a sequence that came close is preferred to one that did
  not, and selection has a slope to climb even before the first solution appears.

Two other forms are implemented for comparison. *Strict*: `large_number − w₂·g(path_cost)` at
the goal and 0 otherwise, the literal reading of the earlier project description. *Ratio*:
`large_number ÷ (1 + w₁·f(c) + w₂·g(cost))`, division instead of subtraction.

### 5.2 Why the conflict term must be pessimistic

Let a sequence end in state *s* with cost *g*. The best plan that continues it costs
*g* + h\*(*s*) and has fitness `L − g − h*(s)`. The unfinished sequence itself scores
`L − g − w₁·c(s)`. If `w₁·c(s) < h*(s)`, the unfinished sequence is **fitter than every way of
finishing it**, and the fittest individual of all is the empty sequence. The population then
converges to doing nothing.

This is exactly what happens when the admissible heuristic h₂ of Assignment 2 is used as the
conflict number with weight 1 (`h2` in the table): h₂ is below h\* by half on average, the fittest
individual is a short unfinished path, goal paths survive only as by-products of the random
walks, and the plans returned are no better than the greedy approach's. A good A\* heuristic is a
bad conflict number: the conflict number has to err on the high side, `w₁·c(s) ≥ h*(s)`. Then
every unfinished sequence is dominated by its own optimal completion and improving fitness means
finishing, then finishing cheaper. The weights in the table above are set for this.

With the smallest-along-the-sequence rule the penalty is weaker (it is at most the end-state
value), but the same argument applies to the prefix at which the minimum occurs: that prefix,
completed optimally, scores at least as much as the whole sequence, so completing still pays.

### 5.3 large_number

The brief treats it as a hyperparameter (100, 1000, …) that must keep every fitness positive.
We derive it instead of choosing it: a legal sequence has at most `maxLength` actions of at most
`maxStepCost` each (9 on a sand-only grid; more with water, where a box can set into concrete),
and the weighted conflict term is a remaining-cost estimate bounded the same way, so

```
large_number = 2 · maxLength · maxStepCost + 1          (= 361 for 20 actions of at most 9)
```

makes the fitness of every legal sequence positive, which roulette selection needs. The constant
cancels in every comparison of two fitness values but not in the roulette wheel, which is why the
default selection subtracts it again (step 7).

### 5.4 f, g, w₂, and the other forms, measured

With f = g = identity the differences in fitness are the differences in cost, which is what a
wheel should see; ln(1 + x) compresses them. Measured on all 59,049 5×2 states with the first
version (end-state conflicts): the ratio form is as good as the default (27.4% optimal against
26.9%), most likely because the default wheel subtracts the worst fitness first, which undoes
most of the compression; the strict form costs three points (24.2%), because selection then has
nothing to prefer among unfinished sequences and relies on the random walks reaching the goal,
which they do on this puzzle. On the 100 random problems with the current defaults the strict
form is within noise of the default (45% optimal against 48% on 5×2, 26% against 25% on 6×2).
Subtraction with the identity stays the default because it is the brief's formula and the
simplest to reason about.

## Step 6 — The genetic algorithm

### 6.1 Initial population

`population` individuals (60 by default), each a random sequence of `maxLength` actions from the
initial state, as the brief says, cut at the first goal state.

**The one design decision that decides everything else.** In this puzzle most actions are illegal
in most states: a top-down gate only opens under a box that holds sand and is not already open, a
side gate only between a full box and an empty one. A uniformly random sequence of 20 action ids
is therefore almost never legal, and under the brief's rule (illegal → fitness 0) a population of
them is all zeros. So the initial individuals are **random legal walks**: at every step a legal
action of the current state is drawn uniformly. This is exactly what rejection sampling of random
sequences would produce (draw, discard if illegal, repeat), at a fraction of the cost. The
baseline with uniformly random ids is kept (`illegal: 'zero'`): it reaches the goal on 7 of 100
random 5×2 problems, all with optimal plans of at most six actions, and on none of the 6×2 ones.

### 6.2a Mutation

One random edit at a random position, then the rest of the sequence is replayed from there.

| Kind | Edit | Origin |
|---|---|---|
| replace | one position gets another action (when repairing, another action that is legal at that point) | the brief, method 1 |
| swap | two positions exchange their actions | the brief, method 2 |
| reverse | the actions between two positions are reversed | the brief, method 3 |
| insert | a (legal) action is inserted; the sequence grows by one | ours |
| delete | one action is removed; the sequence shrinks by one | ours |
| regrow | the sequence is cut and continued with a fresh random legal walk | ours |

All six are enabled by default, one is drawn uniformly per mutation; any subset can be chosen.
The additions exist because our sequences have different lengths (step 2): a plan that is one
action too long or too short cannot be fixed by replace, swap or reverse alone, and regrow is the
large jump that lets a population leave a local optimum. Measured on 100 random problems the
difference is within noise: the brief's three alone give 47% optimal plans on 5×2 and 24% on 6×2,
against 48% and 25% with all six. The additions are kept because they are the only way the length
of a sequence can change once it has been cut at the goal, not because the measurement demands
them.

### 6.2b Crossover

**Single-point** (default): child 1 = prefix of A up to its cut + suffix of B from its cut;
child 2 = prefix of B + suffix of A. The cut points are drawn independently in each parent,
because the parents differ in length, and so that at least one action of the prefix is kept. The
prefix is inherited exactly, so whatever the first parent achieved up to the cut is kept; the
suffix inherits the second parent's *intention* (which gates it opens, in which order) and is
repaired only where it no longer fits the state the prefix ends in. **Double-point**: two cut
points in each parent; the middle segments are exchanged. Two parents give two children, so the
population size stays constant. Measured: double point 50% against 48% on 5×2, 21% against 25%
on 6×2, within noise either way; single point stays the default as the simpler operator.

### 6.3 Illegal children: repair, lethal, or keep

After a mutation or a crossover the actions after the edit meet states they were not chosen for,
so some are illegal. The brief's rule is the *lethal mutation*: such a child is discarded and the
operator is drawn again. Three behaviours are implemented (`illegal`):

* **repair** (default) — `SolverAgent.build` replays the sequence; the first action that is
  illegal in the state it now meets is replaced by a random legal one and the replay continues.
  Every individual stays legal, and the parts of the child that still make sense are kept.
* **retry** — the brief's lethal mutation: the operator is redrawn up to 20 times until the child
  is legal; if none is, the parent is kept, so the population size stays constant. Measured: it
  costs about three times the evaluations and clearly fewer optimal plans than repair (the
  results, section 1.3). The likely reason is that most redraws of a swap or a reverse are illegal,
  so the children that survive are mostly the small edits.
* **zero** — the illegal child stays with fitness 0: the baseline of 6.1.

Repair is the default because it turns every draw of an operator into a useful individual; the
brief's rule is available and reported.

### 6.4 One generation

1. The `elite` fittest individuals (2 by default; 0 switches elitism off) are copied unchanged.
2. `population − elite` parents are drawn by the selection of step 7: the mating pool.
3. The pool is shuffled and mated in pairs (i, i+1): with probability `crossoverRate` (0.9) the
   pair is crossed, otherwise copied.
4. Each child is mutated with probability `mutationRate` (0.3).
5. The run stops after `generations` generations (150) or after `stagnation` generations (50)
   without a higher best fitness.

The reported solution is the cheapest goal path seen in any generation; the fittest sequence is
reported separately (when no goal path was found, its path cost is the `GA_Path_cost` of the
evaluation).

## Step 7 — Selection

`selection(population, n, method)` turns fitness into a probability and draws *n* individuals
with replacement. Its output is the mating pool the brief describes: a list of sequences, the
size of the population minus the elites, with repeats allowed, returned sorted by fitness (the
earlier project description asked for the sorted order). The pool is shuffled before the pairs
(i, i+1) are mated, because a sorted pool mated in order would always cross the fittest with the
fittest.

| Method | Probability | Note |
|---|---|---|
| plain roulette | pᵢ = fᵢ ÷ Σf | the textbook wheel. Because `large_number` is inside every fᵢ, the best and the worst legal individual differ by a few percent and the wheel is nearly uniform |
| roulette on f − f_min (default) | pᵢ ∝ fᵢ − f_min + 1 | the same wheel after subtracting the worst fitness: the constant cancels and the cost differences remain |
| linear ranking | pᵢ ∝ N − rankᵢ | depends only on the order |
| tournament of 3 | best of 3 uniform picks | no explicit probabilities |

If every individual is illegal (total weight 0) the draw is uniform. Measured on 100 random
problems: plain roulette 36% optimal plans, the default 48%, tournament 48% (5×2); on 6×2
tournament is best (30% against 25%). The default stays the wheel on f − f_min because it is the
brief's "fitness turned into a probability" with the one correction that `large_number` makes
necessary; the tournament is one click away on the page.

## Parameters, with their defaults

| Parameter | Default | Meaning |
|---|---:|---|
| `population` | 60 | individuals per generation |
| `generations` | 150 | at most |
| `maxLength` | 4 per row | the length bound of a sequence |
| `elite` | 2 | fittest individuals copied unchanged |
| `crossoverRate` | 0.9 | probability that a pair of parents is crossed |
| `mutationRate` | 0.3 | probability that a child is mutated |
| `stagnation` | 50 | stop after this many generations without a better fitness (0 = never) |
| `seed` | 1 | random generator; mixed with the start state in batch runs |
| `selection` | `windowed` | step 7 |
| `fitness` | `graded` | step 5: the general form |
| `conflicts`, `conflictWeight` | `gates`, 9 | step 4 |
| `conflictMode` | `min` | smallest along the sequence (brief) or end state |
| `conflictTransform`, `costTransform`, `costWeight` | identity, identity, 1 | f, g, w₂ |
| `illegal` | `repair` | 6.3: repair, retry (lethal) or zero |
| `crossover` | `single` | 6.2b |
| `mutations` | all six | 6.2a; `brief` = replace, swap, reverse |

## Files

| | |
|---|---|
| `js/core/genetic.js` | the three classes and every function above |
| `js/core/search.js`, `js/core/analysis.js` | `ga` registered next to the searches; the variants of the evaluation |
| `js/ui/app3.js`, `assignment-3/index.html` | the page: Evolve (live population), Operators (every step on a sample population), Evaluation, Design |
| `scripts/evaluate-ga.mjs` | deliverable 6: 100 random problems against A\* and UCS → `data/a3-random100.json` |
| `scripts/evolve.mjs` | one run with a log of every generation; `--compare` |
| `scripts/analyze.mjs --only a3-5x2.json` | the exhaustive run (first version) → `data/a3-5x2.json` |
| `tests/sandbox.test.mjs` | fitness at the goal, with an illegal action, with the smallest-along-the-sequence rule; 9·gates ≥ h\* on every reachable state up to 4×2; selection probabilities; legality and length of the children of every operator in every illegal-handling mode; swap and reverse preserve the actions; reproducibility per seed; the two failure modes |
