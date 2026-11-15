// Coefficients of the learned heuristic. Written by scripts/learn-heuristic.mjs — do not edit by hand.
// Trained 2026-11-15T06:13:22.008Z on the 326040 non-goal reachable states of the 5×2 grid.
export const LEARNED = {
  trainedOn: '5×2',
  names: ["bias","sand (half-units)","columns with sand","closed gates with sand above","closed gates under a full box","open gates with sand above","boxes with sand","full sand boxes","half sand boxes","fall distance (half-units × closed gates below)","height of sand (rows from top sand box to bottom, both columns)","rows where a side gate can act","empty boxes below sand"],
  weights: [3.450978,15.181067,2.80852,-19.727164,1.28182,-21.4488,-7.736329,-26.704759,-9.463752,1.011256,23.088241,-0.263913,-0.87411],
  safeShift: 11.760448,
  metrics: {"r2":0.9208706747261508,"rmse":2.6154394598680564,"mae":2.0822563574424695,"overestimateShare":0.4864801864801865,"maxRatio":2.8709390669847754},
};
