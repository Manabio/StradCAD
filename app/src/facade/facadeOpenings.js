/**
 * 立面図の外壁の建具の姿図（S3）。入力は facadeInputs.js が階ごとに集めた外壁の建具（exteriorOpeningsOn の結果。graph は引かない）。
 *
 * - 対象: 外壁の外面の線分（axisCLId・向きが同じ）に乗り、中心（centerCoord）が線分の lo..hi の中にあり、wallSide が線分の
 *   outwardSign と同じ（＝外壁。generateExteriorWalls は外壁を常に室外側＝axisOffset が外向きに作る）建具。内壁の建具は対象外。
 * - 姿図: openings/openingElevationFigure.js buildOpeningElevation を展開図と同じ抑制（寸法・動作線・FL 線なし）で使う。
 *   三方枠（扉のない建具）は枠の三方の線だけ（展開図のアキ標記＝バツ・「ア キ」は描かない。立面では素通しの開口）。
 * - 左右: 姿図の正準向きは「壁の座標の昇順（coord1→coord2）＝図の x の昇順」（吊元 hingeSide<0＝coord1 側＝x=0。
 *   elevation/elevationPrimitives.js mirrorPrimitiveX の注記）で、見る側に依らない世界の向き。立面の u が壁の座標と逆向き
 *   （du/dc<0）の面だけ左右反転する（展開図の dirSign<0 と同じ規則）。
 * - 位置: 図の X＝u − uMin（姿図の x=0 を u の小さい端へ）、Y＝glZ − FL ＋ 姿図の y（姿図は FL=0・上が負）。
 * - 隠れ: 建具全体で判定する。中心と四隅の 5 点を壁の包絡＋屋根（facadeGeometry.js isHidden）で調べ、1 点でも見えれば
 *   丸ごと描き、全部隠れれば描かない（線ごとの切り欠きはしない。S3 の割り切り）。
 * - 内外の線種: 姿図をそのまま（鏡像に）するだけで、外開き／内開きの線種を入れ替えない（S3 の割り切り）。
 */
import { COORD_EPS_MM } from '../elevation/elevationStyle.js';
import { translatePrimitive, mirrorPrimitiveX } from '../elevation/elevationPrimitives.js';
import { buildOpeningElevation } from '../openings/openingElevationFigure.js';
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { effectiveHeight } from '../openings/openingNumbering.js';
import { OpeningCategory } from '../core.js';
import { projectToView, isFacingSegment, isHidden } from './facadeGeometry.js';
import { FACADE_OPENING_KIND } from './facadeStyle.js';

/**
 * 1階分の建具のうち外壁に乗るもの（facadeInputs.js が graph の読み取りスコープ内で呼ぶ）。
 * @param {Iterable<object>} openings - graph.openings（core/wall.js Opening）
 * @param {Array<{isVertical:boolean, value:number, lo:number, hi:number, outwardSign:number, axisCLId:string}>} segments
 * @param {number} flMm - その階の FL（世界 z）
 * @returns {Array<{opening:object, coord1:number, coord2:number, flMm:number, segment:object}>}
 */
export function exteriorOpeningsOn(openings, segments, flMm) {
  const out = [];
  for (const o of openings ?? []) {
    const axisId = o?.axisCL?.id;
    if (axisId == null) continue;
    const c = o.centerCoord;
    if (!Number.isFinite(c)) continue;
    const segment = segments.find(s => s.axisCLId === axisId && s.isVertical === o.isVertical
      && s.outwardSign === o.wallSide && c >= s.lo - COORD_EPS_MM && c <= s.hi + COORD_EPS_MM);
    if (!segment) continue;
    out.push({ opening: o, coord1: o.coord1, coord2: o.coord2, flMm, segment });
  }
  return out;
}

// 壁の座標 c の外面上の点を面へ投影する。
const projectAlong = (seg, normal, c) => (seg.isVertical
  ? projectToView(normal, seg.value, c)
  : projectToView(normal, c, seg.value));

/** 建具の窓台高さ（FL から。建具（fitting）は 0。姿図 buildOpeningElevation と同じ扱い）。 */
const sillOf = o => (o.category === OpeningCategory.WINDOW ? (o.sillHeight ?? 0) : 0);

/**
 * 1面分の建具の姿図（図の座標）と件数。
 * @param {object} inputs - buildFacadeInputs の返り値（floors[].openings）
 * @param {{normal:{x:number,y:number}}} view
 * @param {{uMin:number, profiles:Array<object>, minFaceMm?:number, entryOf?:((category:string, subType:string)=>object|null)|null}} opts
 *   profiles＝facadeFloorProfiles(inputs, normal)（隠れ判定の壁の包絡）。entryOf が null なら findCatalogEntry（テストで差し替え可）。
 * @returns {{primitives:object[], counts:{drawn:number, hidden:number, noEntry:number}}}
 */
export function buildFacadeOpenings(inputs, view, { uMin, profiles, minFaceMm = 0, entryOf = null }) {
  const { normal } = view;
  const resolveEntry = entryOf ?? findCatalogEntry;
  const glZ = inputs.glZMm;
  const roofs = inputs.roofs ?? [];
  const primitives = [];
  const counts = { drawn: 0, hidden: 0, noEntry: 0 };
  for (const f of inputs.floors ?? []) {
    for (const { opening: o, coord1, coord2, flMm, segment } of f.openings ?? []) {
      if (!isFacingSegment(segment, normal)) continue;
      const entry = resolveEntry(o.category, o.subType);
      if (!entry) { counts.noEntry++; continue; }
      const p1 = projectAlong(segment, normal, coord1), p2 = projectAlong(segment, normal, coord2);
      const uLo = Math.min(p1.u, p2.u), uHi = Math.max(p1.u, p2.u);
      const zLo = flMm + sillOf(o), zHi = zLo + effectiveHeight(o);
      const depth = p1.depth;
      const probes = [[(uLo + uHi) / 2, (zLo + zHi) / 2], [uLo, zLo], [uLo, zHi], [uHi, zLo], [uHi, zHi]];
      if (probes.every(([u, z]) => isHidden(profiles, u, z, depth, roofs, normal))) { counts.hidden++; continue; }
      const figure = buildOpeningElevation(o, {
        entry, includeDims: false, includeMotionArrows: false, includeLevelLine: false, minFaceMm,
      });
      // u が壁の座標と逆向き（coord1 の u が coord2 の u より大きい）なら姿図を左右反転する。
      const mirror = p1.u > p2.u;
      for (const p of figure) {
        const oriented = mirror ? mirrorPrimitiveX(p, o.width) : p;
        primitives.push({ ...translatePrimitive(oriented, uLo - uMin, glZ - flMm), kind: FACADE_OPENING_KIND, openingId: o.id });
      }
      counts.drawn++;
    }
  }
  return { primitives, counts };
}
