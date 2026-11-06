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
| **State** | 2n boxes, each one of six values: empty, ½ sand, full sand, ½ water, full water, concrete. A box never holds sand and water at once. |
| **State space** | 6^(2n): about 6.0 · 10⁷ for the 5×2 grid. |
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
- **Doors pressed from both sides** work as in the original problem, for sand and water alike:
  when the gate under a *full* box is opened, the door on top of that box opens at the same moment
  and the box above pours in, and so on up the pile through full boxes. If sand lands on water or
  water on sand while everything falls, that box becomes concrete too (each one costs 10) and
  blocks whatever is still above it. A concrete box never moves and never lets anything through.

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

**Mixed 5×2.** For `W 1 / 1 ½ / 0 w / ½ 0 / 1 0` the optimal plan costs 71 (17 actions, 4 side
gates) and makes concrete **exactly once, on purpose**: its last action drops the remaining half box
of sand onto water (3 + 10) because that is cheaper than carrying it out. Greedy best-first search
pours sand onto the water in its very first action, ends up with three concrete boxes and pays 75;
BFS finds a shortest plan (9 actions) that also costs 75. All of them can be replayed from the
*Rules* tab or with

```bash
node scripts/solve.mjs "W 1 / 1 ½ / 0 w / ½ 0 / 1 0" --all
```

## 5. Consequences for the search

- **Solvability is no longer guaranteed.** The state graph is still finite and acyclic (material
  only moves down, levels out or sets), so every algorithm terminates and reports failure when the
  reachable states are exhausted.
- **Heuristics.** h₁ (sand volume) stays admissible as long as the concrete penalty is at least 5:
  a concrete box absorbs at most one unit of sand for at least 10, which is never cheaper than the
  `4T + ⌈T⌉` charged for flushing. For smaller penalties the implementation falls back to
  `T · min(5, penalty)`. The gap term of h₂ is no longer valid (sand above an empty box may be
  concreted in place), so h₂ reduces to h₁ whenever water or concrete is present.
- **The state space cannot be enumerated** (6¹⁰ ≈ 60 million for 5×2), so this variant is evaluated
  on 1,000 random instances instead; see the report.
