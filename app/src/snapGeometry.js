// CL（中心線・補助線・通り芯・梁芯）に関する純粋なジオメトリ計算のうち、spatialIndex/store に
// 依存しないもの。snap.js から分離した理由: snap.js は './store.js'（spatialIndex）を静的 import
// しており、その連鎖で localStorage 等ブラウザ専有APIに触れるため node:test 単体では import できない
// （transform/centerLineOps.js 等、graph実体のみで完結する純関数を node:test から直接検証したいモジュールが
// この2関数だけを必要とするケースがある）。snap.js は本モジュールを import して同名を再エクスポートし、
// 既存の import 元（App.jsx 等）を壊さない。

// 中心線の端のはね出し量 (mm)。区分線形:
//   denom <  BASE_DENOM         : (LOW_DENOM, LOW_MM) → (BASE_DENOM, BASE_MM) の直線
//   BASE_DENOM ≤ denom ≤ ZERO_DENOM: (BASE_DENOM, BASE_MM) → (ZERO_DENOM, 0) の直線
//   denom >  ZERO_DENOM         : 0
const OVERHANG_LOW_DENOM  = 50;
const OVERHANG_LOW_MM     = 200;
const OVERHANG_BASE_DENOM = 100;
const OVERHANG_BASE_MM    = 300;
const OVERHANG_ZERO_DENOM = 500;
export function overhangMm(viewport, trim) {
  if (trim) return 0;
  const denom = viewport.scaleDenominator;
  if (denom >= OVERHANG_ZERO_DENOM) return 0;
  if (denom >= OVERHANG_BASE_DENOM) {
    const t = (denom - OVERHANG_BASE_DENOM) / (OVERHANG_ZERO_DENOM - OVERHANG_BASE_DENOM);
    return OVERHANG_BASE_MM * (1 - t);
  }
  const t = (denom - OVERHANG_LOW_DENOM) / (OVERHANG_BASE_DENOM - OVERHANG_LOW_DENOM);
  return Math.max(0, OVERHANG_LOW_MM + (OVERHANG_BASE_MM - OVERHANG_LOW_MM) * t);
}

/**
 * coord を挟む CL ペアを返す。
 */
export function findBracketingCLs(cls, coord) {
  let lo = null, hi = null;
  let loDist = Infinity, hiDist = Infinity;
  for (const cl of cls) {
    const d = cl.value - coord;
    if (d <= 0 && -d < loDist) { loDist = -d; lo = cl; }
    if (d > 0  && d  < hiDist) { hiDist = d;  hi = cl; }
  }
  return [lo, hi];
}
