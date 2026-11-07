# Sand Boxes — proposed variant with water and concrete

*(نسخهٔ فارسی: [02-problem-water-variant.fa.md](02-problem-water-variant.fa.md))*

This is the extended form of the problem. Everything in
[01-problem-original.md](01-problem-original.md) still holds; this document only lists what changes.

## 1. Idea

Some boxes start with **water** instead of sand. Water obeys the same gates and the same level
rules as sand. When sand and water meet inside a box they set into **concrete**: the box is blocked
for good. Creating concrete does not end the problem; it is charged a penalty and the search goes
on. The goal is still *“no box contains sand”*.

That one addition changes the character of the problem:

- concrete can cut a column off, so sand above it must leave **sideways** or not at all;
- some instances have **no solution** (sand trapped with no water able to reach it);
- concrete is also a **tool**: pouring water on trapped sand turns it into concrete, which removes
  the sand from the grid at a price. The optimal plan sometimes makes concrete on purpose.

## 2. Formal model

| Element | Definition |
|---|---|
| **State** | 2n boxes, each one of six values: empty, ½ sand, full sand, ½ water, full water, concrete, plus the set of open top-down gates. A box never holds sand and water at once. |
| **State space** | 6^(2n) cell configurations (about 6.0 · 10⁷ for the 5×2 grid) times the gate bits. |
| **Initial state** | Each box independently: empty 0.40, ½ sand 0.15, full sand 0.20, ½ water 0.10, full water 0.15 (adjustable). No concrete initially, although the simulator lets you place some. |
| **Actions** | The same 3n gates. |
| **Goal test** | No box contains sand. Water and concrete may remain. |
| **Step cost** | Action a: `1 + 4·(s + s′)`; action b: `1`; **plus 10 for every box that turns into concrete** during the action. |

`s` and `s′` are fill levels regardless of material; a concrete box counts as full.

### Action a — top-down gate under box U (lower box L)

- U empty or concrete, or L concrete: nothing moves (not applicable).
- L empty or holding the **same material**: as before, `p = min(U, 1 − L)` flows down.
- L holding the **other material** and not full: `p = min(U, 1 − L)` flows down and reacts —
  **L becomes concrete**, U keeps the remainder.
- L full: nothing moves, so nothing reacts.
- Through an outlet, sand or water simply leaves. Concrete never leaves.
- **Spring gates** work as in the original problem, for sand and water alike: an open gate stays
  open while sand *or water* is above it, and everything flows through the open gates at the same
  moment. If sand lands on water or water on sand while flowing, that box becomes concrete too
  (each one costs 10). A concrete box never moves and never lets anything through, and a gate under
  a concrete box cannot be opened; a gate above one can, but it leads nowhere.

### Action b — side gate

Flow needs pressure, i.e. a **full** box on one side.

| Pair | Result |
|---|---|
| full X, empty | ½ X, ½ X (levelling, as before) |
| full X, ½ X | nothing (¾ + ¾ is not an allowed level) |
| full X, ½ Y (other material) | half of X spills over and sets: **½ X, concrete** |
| full X, full Y | nothing (no room) |
| ½ X, ½ Y | nothing (equal levels, no flow, no contact) |
| anything, concrete | nothing |

### Why these rules

They are the smallest extension that keeps the original mechanics intact: the same quantity
`min(U, 1 − L)` flows in every case, a reaction happens exactly when a real flow brings the two
materials into the same box, and the reacting box is the one the material flowed *into*. Sand-only
instances behave exactly as in the original problem.

## 3. Cost function

I kept the suggested function: `1 + 4·(s + s′)` for top-down gates, `1` for side gates, and a flat
**+10 per concrete box**. With 10, making concrete is clearly worse than flushing (a unit of sand
leaves through an outlet for 5 to 9) but still affordable when it is the only way out, which is
what makes the trade-off interesting. The penalty is a parameter of the model
(`concretePenalty`, adjustable in the simulator under *Physics options*).

## 4. Examples

**Trapped sand (3×2).** The half box of sand sits on concrete and can never be flushed.

```
0 W        w w        0 w
½ 0   S1   ½ 0   L1↓  # 0      cost 1 + (3 + 10) = 14
# 0   →    # 0   →    # 0
```

Levelling the water across row 1 puts half a box of water above the sand; dropping it turns the
sand into concrete. Goal reached: no sand is left. Remove the water from the start state and the
instance has no solution — every algorithm reports that after exhausting the reachable states.

**Mixed 5×2.** For `W 1 / 1 ½ / 0 w / ½ 0 / 1 0` the optimal plan costs 52 (10 actions, 2 side
gates) and makes concrete **exactly once, on purpose**: its last action drops the remaining half box
of sand onto water (3 + 10) because that is cheaper than carrying it out. The greedy approach of
the assignment cannot solve this instance at all: flushing straight down it lets sand and water
meet, the column is sealed with concrete and the sand above it is stuck. BFS finds a plan of cost
75 and greedy best-first search one of 77. All of them can be replayed from the *Rules* tab or with

```bash
node scripts/solve.mjs "W 1 / 1 ½ / 0 w / ½ 0 / 1 0" --all
```

## 5. Consequences for the search

- **Solvability is no longer guaranteed.** The state graph is still finite and acyclic (material
  only moves down, levels out or sets), so every algorithm terminates and reports failure when the
  reachable states are exhausted.
- **The greedy approach is no longer safe.** On sand-only grids the straight-down sweep always
  finishes. With water it can seal a column with concrete and get stuck: on the 1,000 random
  instances of the report it fails on 327, of which 312 are solvable.
- **Heuristics.** h₁ (3 per column with sand) stays admissible: the column's sand still needs a
  paid action of its own, either a gate opened under sand (≥ 3) or a flow that sets it into concrete
  (≥ 10 + 1). The closed-gate count of h₂ is no longer valid (sand above a closed gate may be
  concreted in place), so h₂ reduces to h₁ whenever water or concrete is present.
- **The state space cannot be enumerated** (6¹⁰ ≈ 60 million for 5×2), so this variant is evaluated
  on 1,000 random instances instead; see the report.
