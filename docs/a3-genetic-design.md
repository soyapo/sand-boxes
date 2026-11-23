# Assignment 3 — a genetic algorithm over action sequences: design notes

These notes describe how the genetic algorithm of the third project is built and why, point by
point against the brief. The measured results are in [a3-results.md](a3-results.md); the code is
in [`js/core/genetic.js`](../js/core/genetic.js). The live page is
[soyapo.github.io/sand-boxes/assignment-3/](https://soyapo.github.io/sand-boxes/assignment-3/).

The brief ends by asking the students to write the report themselves once they have understood the
method. This document is not that report: it is the record of the design decisions, with their
reasons, and of what was measured, for the report to draw on.

## 1. The brief, item by item

| The brief asks for | Where it is |
|---|---|
| Three classes, defined generally: **Problem**, **Environment**, **Solver agent** | `Problem`, `Environment`, `SolverAgent` in `genetic.js` (section 2) |
| A state is the **sequence of actions** from the start state to now, with a fixed upper bound on its length | an individual is an array of action ids; `maxLength` bounds it (section 3) |
| **successful_path**: has the path (the "gene") reached the goal — true or false | `successfulPath(problem, env, genes)` |
| **fitness**: a number per path; `large_number − path_cost` if the goal is satisfied, else 0; 0 if an action is illegal; general formula `large_number − conflict_numbers − path_cost`; other forms allowed with a justification, but these three variables must appear | `fitness(problem, env, genes, form)`: the forms `graded`, `strict`, `ratio` (section 4) |
| **conflict_numbers**: a heuristic, approximate estimate of the distance of a state from the goal | `Problem.conflictNumbers(s)`; seven choices, the default counts the closed gates that still have sand above them (section 5) |
| An **optimal mutation and crossover** | `SolverAgent.mutate`, `SolverAgent.crossover`: both built around legality (section 6) |
| A **selection** function: which individuals (the fitter ones) go to the crossover; takes the set of paths, returns a list (repeats allowed) sorted by fitness; converts fitness to a probability with a formula | `selection(population, n, method, rng)` and `selectionProbabilities` (section 7) |
| An initial population of random sequences | `SolverAgent.randomIndividual` (section 3) |

The environment, the cost function and the heuristics are the ones of Assignments 1 and 2; the
genetic algorithm is registered as the algorithm `ga` next to the searches, so every tool of the
project (the solver panel, the comparison table, the batch evaluation, the command line) runs it on
the same instances as the others.

## 2. The three classes

All three work on the problem interface shared with the other algorithms (`js/core/problem.js`):
an encoded state `s`, `isGoal(s)`, `succ(s)` = the legal actions in `s` with their outcome
`{ a, s′, c }`, and `h(s)`.

**Problem** holds what has to be solved: the start state, the goal test, the action list, the
length bound of a path, the choice and weight of `conflict_numbers`, and `large_number`
(derived from the other constants, see section 4).

**Environment** is the world the agent acts in. `legal(s)` lists the applicable actions,
`step(s, a)` applies one and returns its cost and the next state, or `null` when the action is
illegal in `s` (it would move nothing: the gate is already open, the box above it is empty, the
side gate is not between a full box and an empty one). `replay(problem, genes)` runs a whole
sequence from the start, stopping at the first goal state or at the first illegal action, and
returns the cost, the states passed through and whether the goal was reached. The environment
also counts the actions it applied, which is the "states generated" of this algorithm.

**SolverAgent** is the genetic algorithm. It only talks to the problem through the environment.
Its parameters, with their defaults:

| Parameter | Default | Meaning |
|---|---:|---|
| `population` | 60 | individuals per generation |
| `generations` | 150 | at most |
| `maxLength` | 20 | the length bound of a sequence |
| `elite` | 2 | fittest individuals copied unchanged into the next generation |
| `crossoverRate` | 0.9 | probability that a pair of parents is crossed (otherwise copied) |
| `mutationRate` | 0.3 | probability that a child is mutated |
| `selection` | `windowed` | how fitness becomes a probability (section 7) |
| `fitness` | `graded` | the form of the fitness function (section 4) |
| `conflicts` | `gates` | the conflict function (section 5) |
| `conflictWeight` | 9 for `gates` | the weight of the conflict term |
| `repair` | on | replace illegal actions after an operator instead of leaving them |
| `stagnation` | 50 | stop after this many generations without a better fitness (0 = never) |
| `seed` | 1 | of the random generator, mixed with the start state in batch runs |

## 3. Representation: a path is an individual

An individual is a sequence of action ids (`S2 L1 R4 …`: side gate of row 2, left gate under
row 1, right outlet). It is read from the start state; the state it "is" is whatever the
environment reaches after applying it. This is the brief's "seq or path": a state defined by the
actions from the start to now.

`maxLength` = 20 by default. The longest optimal plan of any 5×2 initial state has 18 actions
(value iteration, Assignment 1), so every optimal plan is representable with room to spare; the
bound mostly matters for random walks, which would otherwise wander.

**Illegal actions.** The brief gives fitness 0 to a sequence with an illegal action. In this
puzzle most actions are illegal in most states, so the point that decides whether the algorithm
works at all is how individuals are created and changed:

* The **initial population** is made of random *legal walks*: from the start, pick a legal action
  uniformly, apply it, repeat, for a random length between 1 and `maxLength`, stopping early at a
  goal state. Every initial individual is legal by construction.
* After **crossover or mutation** the new sequence is replayed from the start by
  `SolverAgent.build`. The first action that is illegal in the state it now meets is replaced by a
  random legal one, and the replay continues with the changed state; this is the **repair**. The
  same pass cuts the sequence at the first goal state (what follows is not needed and not paid
  for) and at `maxLength`.

With `repair` switched off (the ablation `GA, no repair`: uniformly random action ids, no repair,
illegal → fitness 0) the algorithm reaches the goal on 644 of the 59,049 states (1.1%); 470 of
those have an optimal plan of at most seven actions and 596 of at most nine, where a short random
sequence happens to be legal. The literal rule is kept — an illegal action still scores 0 — but the
operators never produce one.

## 4. The fitness function

### 4.1 The default form

```
fitness(path) = large_number − weight · conflict_numbers(end state) − path_cost
              = 0                                   if an action of the path is illegal
```

At a goal state `conflict_numbers` is 0, so a successful path scores exactly
`large_number − path_cost`, the brief's goal case. The three required variables are all there.

### 4.2 Why the conflict term must be pessimistic

Let a path end in state *s* with cost *g*. The best plan that continues it costs *g* + h\*(*s*),
and has fitness `L − g − h*(s)`. The unfinished path itself scores `L − g − w·c(s)`. If
`w·c(s) < h*(s)`, the unfinished path is **fitter than every way of finishing it**, and the
fittest individual of all is the empty path. The population then converges to doing nothing.

This is exactly what happens when the admissible heuristic h₂ of Assignment 2 is used as
`conflict_numbers` with weight 1 (variant `GA, conflicts = h₂ unweighted`): h₂ is below h\* by half
on average, so the fittest individual is a short unfinished path; goal paths still appear in the
population as by-products of random walks, but nothing improves them, and the plans returned are
no better than the greedy approach (optimal on 7.1% of states, mean ratio 1.173 against 1.066
for the default). A good A\* heuristic is a bad conflict count. The conflict estimate has to err on the high side: `w·c(s) ≥ h*(s)`. Then any path that
stops short is dominated by its own optimal completion, and improving fitness means finishing and
then finishing cheaper.

### 4.3 large_number

Not chosen by hand. A legal path has at most `maxLength` actions of at most `maxStepCost` each
(9 on a sand-only grid: 1 + 4·(1 + 1)); the weighted conflict term is a remaining-cost estimate
and is bounded the same way. So

```
large_number = 2 · maxLength · maxStepCost + 1        (= 361 for maxLength 20)
```

makes the fitness of every legal path positive, which a roulette wheel needs. With water in the
grid `maxStepCost` grows by the concrete penalty per box.

### 4.4 Other forms, and why subtraction

The brief allows a different formula with a justification. Three forms are implemented and
compared:

| Form | Formula | Behaviour |
|---|---|---|
| `graded` (default) | `L − w·c − cost`, 0 if illegal | partial paths are ranked by an upper estimate of their finished cost: the population has a slope to climb |
| `strict` | `L − cost` at the goal, 0 otherwise | the literal reading; works here only because random legal walks reach the goal often, and gives selection nothing to prefer among unfinished paths |
| `ratio` | `L ÷ (1 + w·c + cost)` | same ranking as `graded`, with the differences between good and bad paths compressed; measured as good as the default (27.4% optimal against 26.9%) |

Subtraction keeps the *differences* in fitness equal to the differences in cost, which is what a
roulette wheel should see; division turns a cost difference of 10 into a fitness ratio of a few
percent. The expected penalty for the ratio form did not appear in the measurements, most likely
because the default selection subtracts the worst fitness before spinning the wheel, which undoes
much of the compression. Subtraction stays the default because it is the brief's formula and the
simplest to reason about.

## 5. conflict_numbers

Seven choices, all 0 at the goal, each with a default weight chosen so that `w·c ≥ h*` as far as
could be checked:

| Key | Count | Weight | Why this weight |
|---|---|---:|---|
| `gates` (default) | closed top-down gates that still have sand above them in their column (= h₂ ÷ 3) | 9 | the largest cost of one action; on every one of the 326,041 reachable states of the 5×2 grid, 9·gates ≥ h\* (the largest h\* ÷ (3·gates) is 2.73). Checked by the test-suite on all reachable states up to 4×2 |
| `sand` | half-units of sand left in the grid | 9 | the naive conflict count; it does not see how deep the sand sits, so 9·sand can be far below h\* (h\* ÷ sand reaches 15) |
| `fall` | h₃ of Assignment 2: 2.5 per half-unit per closed gate below it | 1.2 | overestimates on 99.7% of states already; h\*/h₃ ≤ 1.2 |
| `sweep` | the cost of the greedy approach (Assignment 1) run from the state | 1 | an exact upper bound on h\* (the greedy approach always finishes on sand); tight on 10% of states |
| `h2` | h₂ unweighted | 1 | the admissible bound: the failure case of 4.2 |
| `learned` | h₄ of Assignment 2 | 1.35 | h\*/h₄ ≤ 1.34 on the training states where h₄ > 0 (h₄ is clamped to 0 on a few, where no weight helps) |
| `zero` | nothing | — | fitness = L − cost; only meaningful with the `strict` form |

`gates` is the default because it is a genuine *count of conflicts* — the gates that still stand
between the sand and the outlets, each of which has to be opened by one paid action — and because
multiplying it by the maximal action cost gives the pessimistic estimate of 4.2 with an argument
rather than a fitted constant. The alternatives are all run in the evaluation.

## 6. Crossover and mutation

Both are designed for the one property that matters here: the child must be a legal path. Both
end with the repair pass of `SolverAgent.build`.

**Crossover.** One-point, with *independent* cut points because the parents differ in length:
child 1 = head of A up to its cut + tail of B from its cut; child 2 = head of B + tail of A. The
head is kept intact, so everything the first parent achieved up to the cut is inherited exactly.
The tail inherits the *intention* of the second parent — which gates it opens, in which order —
and is repaired only where that no longer fits the state the head ends in. Cut points are drawn
so that at least one action of the head is kept.

**Mutation.** One edit at a random position, then repair of what follows:

| Kind | Edit | Role |
|---|---|---|
| `point` | replace the action by another action that is legal at that point | the smallest change |
| `insert` | insert a legal action | lengthens the path by one |
| `delete` | remove the action | shortens it by one |
| `regrow` | cut the path there and continue it with a fresh random legal walk | the large jump that lets the population leave a local optimum |

The first three are the moves of edit distance on sequences; one of the four is drawn uniformly.

**Why these are the right operators for this problem.** A plan for the sand boxes has a strong
prefix structure: what is possible later depends entirely on what was opened earlier. Operators
that preserve a prefix and repair the rest keep the part of a plan that is known to work and
explore only from the point of change. The evaluation shows that removing crossover changes
nothing measurable and removing mutation costs three points of optimality (either operator alone,
with the repair, keeps the population moving), while removing the repair leaves 1.1% of the
states solved.

## 7. Selection

`selection(population, n, method)` turns fitness into a probability, draws *n* individuals with
replacement, and returns them **sorted by fitness, best first**, as the brief asks. The
probabilities themselves are available from `selectionProbabilities`, and the Operators tab shows
them for a sample population. Four methods:

| Method | Probability | Note |
|---|---|---|
| `roulette` | pᵢ = fᵢ ÷ Σf | the textbook wheel. Because `large_number` is inside every fᵢ, the best and the worst legal individual differ by a few percent, so the wheel is nearly uniform and the pressure is weak |
| `windowed` (default) | pᵢ ∝ fᵢ − f_min + 1 | the same wheel after subtracting the worst fitness: the constant cancels and the cost differences are what remain |
| `rank` | pᵢ ∝ N − rankᵢ | linear ranking: depends only on the order |
| `tournament` | best of 3 uniform picks | no explicit probability; included for comparison |

If the total weight is 0 (every individual illegal) the draw is uniform.

Each generation: the `elite` fittest individuals are copied unchanged; `population − elite`
parents are selected; the selected list is shuffled and mated in pairs (mating the sorted list in
order would always pair the best with the best); each pair is crossed with probability
`crossoverRate`, otherwise copied; each child is mutated with probability `mutationRate`. The run
stops after `generations` generations or after `stagnation` generations without a higher best
fitness. The solution reported is the cheapest goal path seen in any generation.

## 8. What is measured

Every variant is run once on each of the 59,049 initial states of the 5×2 grid with the same seed
per state (`scripts/analyze.mjs --only a3-5x2.json`), and compared with the optimum from value
iteration over the whole state graph: the share of states where a goal path is found, the share
where the plan is optimal, the distribution of `GA_opt_ratio` = GA cost ÷ optimum (histogram,
bins of 0.05), the scatter of GA cost against the optimum, the scatter of plan length against the
number of side-gate actions, fitness evaluations, actions applied and time. The greedy approach
and A\* with h₂ are run on the same states for reference. See [a3-results.md](a3-results.md).

## 9. Files

| | |
|---|---|
| `js/core/genetic.js` | `Problem`, `Environment`, `SolverAgent`, `successfulPath`, `fitness` (+ `FITNESS`), `CONFLICTS`, `selection`, `selectionProbabilities` (+ `SELECTION`), `geneticSearch` |
| `js/core/search.js` | registers `ga` next to the other algorithms |
| `js/core/analysis.js` | the variants `ga`, `ga-roulette`, … and the batch evaluation |
| `js/ui/app3.js`, `assignment-3/index.html` | the page: Evolve, Operators, Evaluation, Design |
| `scripts/evolve.mjs` | command line: one run with a log of every generation; `--compare` |
| `tests/sandbox.test.mjs` | fitness at the goal / on an illegal action / on a partial path; 9·gates ≥ h\* on all reachable states up to 4×2; selection probabilities; legality and length of children; reproducibility; the two failure modes |
