/**
 * 立面図（外壁立面4面）の 1 面へ、屋外の姿図の配置（階レコードの placedFigures。facadeInputs.js exteriorPlacedFiguresOf）の
 * 正面図・背面図・側面図を足す（部分詳細図 S10 P6）。向きの約束・view の選び方は finish/placedFigure/placedFigureViews.js
 * （展開図 elevation/elevationPlacedFigures.js と同じ純関数を共用）。
 *
 * 見る向き（R2）: d＝−n（n＝面の法線＝建物から見る人へ）。見る人は建物の外から配置を見るので、展開図の「部屋側から壁へ」と同じ形。
 * 位置（R3）: 図の X＝u0 − uMin（u0＝配置点を面へ投影した u。面の向きで反転しない＝配置図は見る人の右が u 正）。
 *   図の Y＝glZ − flMm − zMm ＋ 図の t（t 正＝下。zMm は配置した階の FL からの高さ）。s 反転は P5 と同じ（配置の鏡像 XOR 左右の代用）。
 * 隠れ（R4）: 建具と同じ isHidden を 5 点（中心＋外接の四隅）で試し、すべて隠れたら描かない。一部でも見えれば全部描く。
 * 線の語彙（R5）: detailStrokesToElevationPrimitives（line／polyline だけ）。建具の FACADE_OPENING_KIND のような kind は付けない。
 * 図の fit は図キーごとに 1 回（この呼出し内のキャッシュ）。
 */
import { translatePrimitive } from '../elevation/elevationPrimitives.js';
import { detailStrokesToElevationPrimitives } from '../openings/openingDetailFit.js';
import { detailFigureEntry } from '../openings/openingCatalog.js';
import {
  viewForFace, resolvePlacedView, fitPlacedView, sRangeOf, placeViewStrokes,
} from '../finish/placedFigure/placedFigureViews.js';
import { projectToView, isHidden } from './facadeGeometry.js';

/** fit 済みの図の局所 t の範囲。点が無ければ null。 */
function tRangeOf(strokes) {
  let min = Infinity;
  let max = -Infinity;
  for (const st of strokes) {
    for (const p of st.points) {
      if (p.t < min) min = p.t;
      if (p.t > max) max = p.t;
    }
  }
  return min <= max ? { min, max } : null;
}

// 1面分の描く配置（隠れないもの）。strokes＝配置原点を 0 とした fit 済みの座標列、u0＝配置点の u、dy＝図の Y の原点（glZ − FL − zMm）、
// uLo〜uHi・zLo〜zHi＝外接（u・世界 z）。uMin（図の X の原点）に依らないので、面の範囲（faceExtent）の算出にも使える。
function placedFigureItems(inputs, view, { profiles, figureOf }) {
  const { normal } = view;
  // 見る向き d＝−n（0 − で -0 を作らない）
  const d = [0 - normal.x, 0 - normal.y];
  const glZ = inputs.glZMm;
  const roofs = inputs.roofs ?? [];
  const fitCache = new Map();
  const fitOnce = (key, figV) => {
    if (!fitCache.has(key)) fitCache.set(key, fitPlacedView(figV));
    return fitCache.get(key);
  };
  const items = [];
  for (const f of inputs.floors ?? []) {
    for (const pf of f.placedFigures ?? []) {
      if (pf === null || typeof pf !== 'object') continue;
      const fig = figureOf(pf.figureKey);
      if (!fig) continue;
      const { view: placedView, mirrorS } = viewForFace(pf, d);
      const resolved = resolvePlacedView(fig, placedView, figureOf);
      if (resolved === null) continue;
      const fitted = fitOnce(resolved.key, resolved.fig);
      if (fitted.error) continue;
      const sRange = sRangeOf(fitted.strokes);
      const tRange = tRangeOf(fitted.strokes);
      if (sRange === null || tRange === null) continue;
      const flip = mirrorS !== resolved.mirrorS;
      const { u: u0, depth } = projectToView(normal, pf.x, pf.y);
      const uLo = u0 + (flip ? -sRange.max : sRange.min);
      const uHi = u0 + (flip ? -sRange.min : sRange.max);
      // 図の t 正＝下。世界 z（上向き）は FL＋zMm − t
      const zBase = f.flMm + pf.zMm;
      const zLo = zBase - tRange.max;
      const zHi = zBase - tRange.min;
      const probes = [[(uLo + uHi) / 2, (zLo + zHi) / 2], [uLo, zLo], [uLo, zHi], [uHi, zLo], [uHi, zHi]];
      if (probes.every(([u, z]) => isHidden(profiles, u, z, depth, roofs, normal))) continue;
      items.push({ strokes: placeViewStrokes(fitted, flip), u0, dy: glZ - f.flMm - pf.zMm, uLo, uHi, zLo, zHi });
    }
  }
  return items;
}

/**
 * 1面分の屋外の姿図の配置（図の座標のプリミティブ）。
 * @param {object} inputs - buildFacadeInputs の返り値（glZMm・roofs・floors[].flMm／placedFigures）
 * @param {{normal:{x:number,y:number}}} view
 * @param {{uMin:number, profiles:Array<object>, figureOf?:(key:string)=>(object|null)}} opts
 *   profiles＝facadeFloorProfiles(inputs, normal)（隠れ判定の壁の包絡）。figureOf は詳細図の解決（テストで差し替え可）。
 * @returns {object[]}
 */
export function buildFacadePlacedFigures(inputs, view, { uMin, profiles, figureOf = detailFigureEntry }) {
  return placedFigureItems(inputs, view, { profiles, figureOf }).flatMap(it => (
    detailStrokesToElevationPrimitives(it.strokes).map(p => translatePrimitive(p, it.u0 - uMin, it.dy))
  ));
}

/**
 * 1面分の描く配置の外接（u の最小・最大と世界 z の最大）。面の範囲（facadeFigure.js faceExtent）へ足す。配置が無ければ null。
 * @returns {{uMin:number, uMax:number, zTop:number}|null}
 */
export function facadePlacedFiguresExtent(inputs, view, { profiles, figureOf = detailFigureEntry }) {
  const items = placedFigureItems(inputs, view, { profiles, figureOf });
  if (items.length === 0) return null;
  return {
    uMin: Math.min(...items.map(it => it.uLo)),
    uMax: Math.max(...items.map(it => it.uHi)),
    zTop: Math.max(...items.map(it => it.zHi)),
  };
}
