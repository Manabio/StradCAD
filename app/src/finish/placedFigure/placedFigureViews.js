// ================================================================
// 姿図の配置（PlacedFigure）を展開図（室内）へ出すときの「どの面にどの図か」の純関数群（部分詳細図 S10 P5）。
// 向きの約束: 平面の姿図は正面を図の下（局所 +t）に向けて描く。正面の世界方向 f は回転 θ で回した (0,1)＝(−sin θ, cos θ)（y 下向き正。
// 描画 renderer/placedFigureDrawPlan.js の frame の t 列と同じ）。鏡像は f を変えない。
// 見る向き d（部屋側から壁へ）に対し、f＝−d なら正面・f＝d なら背面・見る人が図の右手側（−d＝右手 ρ）なら右側面・左手側なら左側面。
// 右手 ρ は y 下向き座標で (−f_y, f_x)。回転は 90° 刻みなので比較は整数で厳密。
// 依存は constants・placedFigureTargets・detail/detailPlacement（fitLocal・placeStrokes）だけ（store.js・snap.js・.jsx・react を引かない）。
// ================================================================

import { DetailPlacementView, DETAIL_VIEWS_FIELD, PLACED_FIGURE_WEIGHT_ROLE } from '../../core/constants.js';
import { fitLocal, placeStrokes } from '../../detail/detailPlacement.js';
import { placedFigureTargets, isPlaceableViewFigure } from './placedFigureTargets.js';

const toRad = deg => (deg * Math.PI) / 180;
// 90° の整数倍の cos・sin は 0／±1 に丸める（+ 0 で -0 を 0 にそろえる）
const unit = v => Math.round(v) + 0;

/** 配置の正面の世界方向 [fx, fy]（整数）。 */
export function frontDirOf(pf) {
  return [unit(-Math.sin(toRad(pf.rotationDeg))), unit(Math.cos(toRad(pf.rotationDeg)))];
}

/** 正面方向 f の右手側の世界方向（y 下向き座標で (−fy, fx)）。 */
export function rightHandOf([fx, fy]) {
  return [-fy + 0, fx + 0];
}

/**
 * 見る向き d（部屋側から壁へ。整数 [dx, dy]）で見た配置が、どの view の図か。
 * mirrorS＝図の s を反転して置くか（配置の鏡像のとき。FRONT／BACK も同様。鏡像は LEFT↔RIGHT も入れ替える）。
 * @returns {{view: string, mirrorS: boolean}}
 */
export function viewForFace(pf, d) {
  const f = frontDirOf(pf);
  const mirrored = pf.mirror === true;
  let view;
  if (f[0] === -d[0] && f[1] === -d[1]) view = DetailPlacementView.FRONT;
  else if (f[0] === d[0] && f[1] === d[1]) view = DetailPlacementView.BACK;
  else {
    const rho = rightHandOf(f);
    const viewerIsRight = rho[0] === -d[0] && rho[1] === -d[1];
    view = viewerIsRight === mirrored ? DetailPlacementView.LEFT : DetailPlacementView.RIGHT;
  }
  return { view, mirrorS: mirrored };
}

const isSetKey = key => typeof key === 'string' && key !== '';

/**
 * 平面の配置図 fig の views から view の図を引く。左右は片方が未設定なら他方の鏡像で代用する（左右対称の前提）。
 * 設定されているのに参照切れ・分類違いの図は null（代用しない。通知は placedFigureFitCheck）。FRONT・BACK が未設定なら null。
 * @param {object} fig 平面の配置図エントリ
 * @param {string} view DetailPlacementView の front〜right
 * @param {(key:string)=>(object|null)} figureOf
 * @returns {{key:string, fig:object, mirrorS:boolean}|null} mirrorS＝代用による反転（配置の鏡像は含まない）
 */
export function resolvePlacedView(fig, view, figureOf) {
  const views = fig?.[DETAIL_VIEWS_FIELD];
  const pick = (v, mirrorS) => {
    const key = views?.[v];
    if (!isSetKey(key)) return undefined;
    const figV = figureOf(key);
    return isPlaceableViewFigure(figV, v) ? { key, fig: figV, mirrorS } : null;
  };
  const own = pick(view, false);
  if (own !== undefined) return own;
  const opposite = view === DetailPlacementView.LEFT ? DetailPlacementView.RIGHT
    : view === DetailPlacementView.RIGHT ? DetailPlacementView.LEFT : null;
  if (opposite === null) return null;
  return pick(opposite, true) ?? null;
}

/** 立面側の姿図 1 枚を配置原点を 0 として fit する。{strokes} | {error}（図キーごとにキャッシュできる） */
export function fitPlacedView(figV) {
  const t = placedFigureTargets(figV);
  if (t.error) return { error: t.error };
  return fitLocal(figV, t.targets);
}

/** fit 済みの図の局所 s の範囲。点が無ければ null。 */
export function sRangeOf(strokes) {
  let min = Infinity;
  let max = -Infinity;
  for (const st of strokes) {
    for (const p of st.points) {
      if (p.s < min) min = p.s;
      if (p.s > max) max = p.s;
    }
  }
  return min <= max ? { min, max } : null;
}

/**
 * fit 済みの図を (s, t)→[ms·s, t] の座標列へ写す（ms＝反転なら −1。原点は図の配置原点のまま）。
 * 展開・立面の配置専用（建具の姿図は通らない）。線の太さの指定は PLACED_FIGURE_WEIGHT_ROLE へ置き換える（破線などの dashRole は図のまま）。
 */
export function placeViewStrokes(fitted, mirrorS) {
  return placeStrokes(fitted, { ox: 0, oy: 0, sx: mirrorS ? -1 : 1, sy: 0, tx: 0, ty: 1 })
    .map(st => ({ ...st, line: { ...st.line, weightRole: PLACED_FIGURE_WEIGHT_ROLE } }));
}
