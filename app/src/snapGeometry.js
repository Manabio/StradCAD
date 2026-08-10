// CL（中心線・補助線・通り芯・梁芯）に関する純粋なジオメトリ計算のうち、spatialIndex/store に
// 依存しないもの。snap.js から分離した理由: snap.js は './store.js'（spatialIndex）を静的 import
// しており、その連鎖で localStorage 等ブラウザ専有APIに触れるため node:test 単体では import できない
// （transform/centerLineOps.js 等、graph実体のみで完結する純関数を node:test から直接検証したいモジュールが
// これらの関数を必要とするケースがある）。snap.js は本モジュールを import して同名を再エクスポートし、
// 既存の import 元（App.jsx・CenterLinesLayer.jsx 等）を壊さない。
import { CenterLineType, DimensionKind, DimensionSide, centerLineKind } from './core.js';

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

// ----------------------------------------------------------------
// CENTER寸法（中心線寸法）「到達」判定・非ラベルCLの描画延伸範囲。
// renderer/CenterLinesLayer.jsx の clExtent（非labeled分岐）と renderer/GutterLayer.jsx の
// buildRowAnchors（centerBoundary到達判定）が使う純ロジックをここへ集約する。
// findNearestCenterLineEndpoint（下記）が「外寸法側のはね出し線分」を同じ基準で判定するため、
// および node:test から実PlanGraphで検証するため。
// ----------------------------------------------------------------

/**
 * 中心線・補助線（labeled:false）の描画延伸範囲 [lo, hi] を返す（オーバーハング込み）。
 * renderer/CenterLinesLayer.jsx の clExtent は、これに labeled:true 分岐（ガター座標=width/height
 * 依存のため純関数化できない）を足したもの——重複実装を避けるため clExtent 側はこの関数へ委譲する。
 * extentLo/Hi 未確定の古いデータは labeled 直交CLのmin/maxへフォールバックする（clExtentと同じ挙動）。
 */
export function nonLabeledClExtent(cl, graph, viewport) {
  const isV      = cl.centerLineType === CenterLineType.VERTICAL;
  const perpType = isV ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  const overhang = overhangMm(viewport, cl.trim);
  if (cl.extentLo == null || cl.extentHi == null) {
    const vals = graph.centerLines
      .filter(p => p.centerLineType === perpType && p.labeled)
      .map(p => p.effectiveValue);
    if (vals.length === 0) return null;
    return [Math.min(...vals) - overhang, Math.max(...vals) + overhang];
  }
  return [cl.extentLo - overhang, cl.extentHi + overhang];
}

/**
 * 非ラベルCL（中心線・補助線・梁芯）の side端（'lo'|'hi'）が、直交方向の最外通り芯
 * （CENTER寸法の基準＝DimensionLine.centerBoundary）へ「到達」しているか。
 * renderer/GutterLayer.jsx buildRowAnchors の到達判定（ext[0] <= boundary <= ext[1]）と
 * 同じ基準を再利用する（別基準を発明しない）。
 * side='lo'（extentLo・Y/X座標の小さい側）はTOP(isV)/LEFT(isH)行、side='hi'（extentHi・大きい側）は
 * BOTTOM(isV)/RIGHT(isH)行に対応する（y軸下向き正）。
 * 対応するCENTER寸法行（4行）が graph に無い場合・直交グリッドが無い場合は false（到達なし扱い）。
 */
export function clSideReachesCenterBoundary(cl, side, graph, viewport) {
  const isV = cl.centerLineType === CenterLineType.VERTICAL;
  const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
  if (!isV && !isH) return false;
  const dimSide = isV
    ? (side === 'lo' ? DimensionSide.TOP  : DimensionSide.BOTTOM)
    : (side === 'lo' ? DimensionSide.LEFT : DimensionSide.RIGHT);
  const row = graph.dimensionLines.find(d => d.dimensionKind === DimensionKind.CENTER && d.side === dimSide);
  const boundary = row?.centerBoundary;
  if (boundary == null) return false;
  const ext = nonLabeledClExtent(cl, graph, viewport);
  return !!ext && ext[0] <= boundary && boundary <= ext[1];
}

/**
 * カーソルに最も近い、非ラベルCL（中心・補助線・梁芯）の端点を返す（延長/短縮メニュー用）。
 * ヒット域は2種類:
 *   1) 突端（extentLo-overhang / extentHi+overhang）の8px円——到達可否に関わらず常時（従来どおり）。
 *   2) 外寸法側のはね出し線分上（extent〜突端。clSideReachesCenterBoundary が true の側のみ）——
 *      垂直距離判定は findNearestCenterLine の線上ヒットと同じ式。到達していない側・extent内側の
 *      線上ヒットは変更しない（findNearestCenterLine 側の挙動のまま）。
 * 通り芯（labeled:true）・RADIAL・extentLo/Hi未確定のCLは対象外。kindFilterは findNearestCenterLine
 * と同じ規約（既定は梁芯を除外、構造モードは `k => k === 'beam'` で梁芯だけに絞る）。
 * @returns {{cl, side:'lo'|'hi'}|null}
 */
export function findNearestCenterLineEndpoint(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport, kindFilter = k => k !== 'beam') {
  if (!graph) return null;
  let nearest = null, minDist = Infinity;
  for (const cl of graph.centerLines) {
    if (cl.labeled || !kindFilter(centerLineKind(cl))) continue;
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const isH = cl.centerLineType === CenterLineType.HORIZONTAL;
    if (!isV && !isH) continue;
    if (cl.extentLo == null || cl.extentHi == null) continue;
    const overhang = overhangMm(viewport, cl.trim);

    // 1) 突端の8px円判定（従来どおり）
    const tips = [
      { side: 'lo', along: cl.extentLo - overhang },
      { side: 'hi', along: cl.extentHi + overhang },
    ];
    for (const { side, along } of tips) {
      const tx = isV ? cl.value : along;
      const ty = isV ? along    : cl.value;
      const dist = Math.hypot((tx - wx) * scaleX, (ty - wy) * scaleY);
      if (dist < thresholdPx && dist < minDist) { minDist = dist; nearest = { cl, side }; }
    }

    // 2) 外寸法側のはね出し線分上（extent〜突端）。
    // along===extentLo/extentHi ちょうど（extent内側の線上ヒットとの境界点）は意図的にこちら
    // （端点ラジアル）側に含める——lo/hiの範囲を [extentLo, extentHi] のように閉区間で取るため。
    if (overhang > 0) {
      const perp = isV ? Math.abs(cl.value - wx) * scaleX : Math.abs(cl.value - wy) * scaleY;
      if (perp < thresholdPx && perp < minDist) {
        const along = isV ? wy : wx;
        const segs = [
          { side: 'lo', lo: cl.extentLo - overhang, hi: cl.extentLo },
          { side: 'hi', lo: cl.extentHi,             hi: cl.extentHi + overhang },
        ];
        for (const { side, lo, hi } of segs) {
          if (along < lo || along > hi) continue;
          if (!clSideReachesCenterBoundary(cl, side, graph, viewport)) continue;
          minDist = perp; nearest = { cl, side };
        }
      }
    }
  }
  return nearest;
}
