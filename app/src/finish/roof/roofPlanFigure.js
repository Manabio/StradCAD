/**
 * 下屋の平面表示の図形（軒先の線・棟木・隅木・谷木と傾斜ラベル）の純モジュール。
 * plan/planSolids.js roofSolids が屋根立体の innerLines・marks として使い、平面の断面解決（plan/planSectionFigure.js）が
 * 壁立体の遮蔽で外壁面どまりにして、renderer/PlanSolidsLayer.jsx が描く。store.js・snap.js・.jsx・react-konva・graphDerived を
 * 静的に import しない（node:test から単体で import できる）。
 *
 * 対象は下屋（RoomFeature.ROOF の部屋）だけ。主屋根は対象外。全構造種別で出す（structural/roofFramingRegions.js
 * leanToPlanRegions。構造ゲートなし）。母屋・束・小屋梁は描かない。線は細い実線1本で、全 LOD で同じ。
 *
 * 線の role: outline＝軒先・けらばの外形線、ridge＝棟木（切妻はけらばの外形線まで・寄棟は延ばさない。
 *   L字の下屋の片流れ・切妻は水下の場の線＝伏図と同じ線。片流れは向かい合う水下があるときだけ）、
 *   hip＝隅木（軒の角まで）、valley＝谷木（軒先の線の入隅の角まで。伏図と違い平面だけ延ばす）。
 * L字の切妻は腕ごとに棟木（軒・けらばは gableArmDrainsOf。水下を持つ region）。水下は屋内に接する部分を除く（壁へ下る面は作らない。
 * 振り分けは leanToDrainRoute）。棟違い・全周が壁・向かい合う壁の間・けらばの無い切妻の L字は軒先の線だけ（outlineOnly）。
 * 詳細（DETAIL）だけ、傾斜面（水下）ごとに水下向きの矢印・「屋根」・「（傾斜N/10）」を出す（detailOnly:true の arrow・text。
 * plan/planSolidsLayerFilter.js visiblePlanPrimitives が他の LOD で除く）。矢じりは renderer/chevron.js（依存なしの純モジュール）。
 */
import { CL_OVERLAP_TOL_MM, DEFAULT_ROOF_SLOPE } from '../../core/constants.js';
import { roofRidgeLines, roofHipDiagonals, extendLinesToOutline, extendDiagonalsToOutline, drainFaceAnchors } from '../../structural/roofFramingGeometry.js';
import { chevronPoints } from '../../renderer/chevron.js';

const segment = line => (line.isVertical
  ? [line.coord, line.lo, line.coord, line.hi]
  : [line.lo, line.coord, line.hi, line.coord]);

/**
 * 下屋1つ（leanToPlanRegions の region）の、壁で切る前の線と傾斜ラベル。純関数・graph を読まない。
 * 平面の断面解決（plan/planSolids.js roofSolids の innerLines・marks）へ渡す線の作り方の唯一の場所。外壁面どまりは解決器（壁立体の遮蔽）が行うので、ここでは壁を読まない。
 * lines は外形線（exposedPaths。閉路は closed:true で先頭の点を末尾へ足さない）→棟木→隅木・谷木の順。外形線だけの region
 * （outlineOnly）は棟木・隅木・谷木・ラベルを出さない。labels は水下の基準点ごと（anchor＝基準点・prims＝矢印→「屋根」→傾斜の表記）。
 * @param {object} region leanToPlanRegions の要素
 * @returns {{lines: Array<{role:'outline'|'ridge'|'hip'|'valley', points:number[], closed:boolean}>,
 *   labels: Array<{anchor:{x:number,y:number}, prims:Array<object>}>}}
 */
export function roofPlanRegionFigure(region) {
  const tolMm = CL_OVERLAP_TOL_MM;
  const lines = [];
  for (const path of region.exposedPaths ?? []) lines.push({ role: 'outline', points: path.points, closed: path.closed });
  // 外形線だけの region（outlineOnly: 陸屋根・棟違い・全周が壁・向かい合う壁の間など）は棟木・隅木・谷木・ラベルを出さない
  if (region.outlineOnly) return { lines, labels: [] };
  const ridges = extendLinesToOutline({
    lines: roofRidgeLines({
      rect: region.rect, rects: region.rects ?? null, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical,
      leanToDrains: region.leanToDrains ?? null, leanToPurlinDepthMm: region.leanToPurlinDepthMm ?? null, tolMm,
    }),
    edges: region.edges, tolMm,
  });
  for (const line of ridges) lines.push({ role: 'ridge', points: segment(line), closed: false });
  // L字の下屋の継ぎ目（隅木・谷木）は水下への距離の場（伏図と同じ）。軒先の角（出隅・入隅）まで延ばす
  const diagonals = extendDiagonalsToOutline({
    diagonals: roofHipDiagonals({ rect: region.rect, rects: region.rects ?? null, shape: region.shape, leanToDrains: region.leanToDrains ?? null, tolMm }),
    edges: region.edges, valleys: true, tolMm,
  });
  for (const d of diagonals) lines.push({ role: d.kind, points: [d.x1, d.y1, d.x2, d.y2], closed: false });
  // 傾斜面ごとのラベル（詳細 LOD のみ）。傾斜面（水下）1つにつき1つ（ユーザー指示）。水下は屋内に接する部分（壁）を除いたもの
  // （2026-10-05 裁定）なので、壁へ向かう矢印は出ない。外壁面どまりはラベルの座標を動かさない
  const anchors = drainFaceAnchors({ rects: region.rect ? [region.rect] : region.rects, drains: region.planDrains, tolMm });
  const labels = anchors.map(a => ({
    anchor: a.anchor,
    prims: roofSlopeLabelPrimitives({ key: region.key, anchors: [a], slope: region.slope }),
  }));
  return { lines, labels };
}

/** ラベルの寸法（ワールド mm。ユーザー指示2026-10-04の裁定）。文字は階段の矢印ラベル（StairLayer.jsx）と同じ 200。 */
export const ROOF_LABEL_FONT_MM = 200;
export const ROOF_LABEL_ARROW_MM = 900;
export const ROOF_LABEL_GAP_MM = 100;
export const ROOF_LABEL_HEAD_MM = 150;

/** 傾斜の表記「（傾斜N/10）」。n が有限で正でなければ既定の傾斜。0.5 刻みは「2.5」のまま。 */
export function roofSlopeText(n) {
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_ROOF_SLOPE;
  return `（傾斜${v}/10）`;
}

/** 文字列の推定幅（半角 ASCII 0.5・それ以外 1.0 ×文字サイズ。elevationFigure.js の方式）。 */
function estimatedTextWidth(text, fontSizeMm) {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0) < 0x80 ? 0.5 : 1) * fontSizeMm;
  return w;
}

const FLOW_DIRECTION = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] };

/**
 * 水下ごとの面の基準点から、傾斜ラベル（水下向きの矢印・「屋根」・傾斜の表記）の primitive を作る（詳細 LOD のみ。detailOnly:true）。
 * 矢印は中点を基準点に置き、先端が水下側。縦の矢印（上下）は文字を左右から挟む（左「屋根」・右「（傾斜N/10）」）、
 * 横の矢印（左右）は上下から挟む（上「屋根」・下「（傾斜N/10）」）。文字は常に横書きで、x,y は文字の左上。
 * @param {object} p
 * @param {string} p.key region の key（primitive の key の接頭辞）
 * @param {Array<{drainIndex:number, anchor:{x:number,y:number}, flow:'up'|'down'|'left'|'right'}>} p.anchors drainFaceAnchors の結果
 * @param {number} p.slope 傾斜 N（N/10）
 * @returns {Array<object>} { kind:'arrow', key, points:[tailX,tailY,tipX,tipY], head:number[6], detailOnly:true } と
 *   { kind:'text', key, x, y, text, fontSizeMm, detailOnly:true } を、面ごとに 矢印→「屋根」→傾斜の表記 の順
 */
export function roofSlopeLabelPrimitives({ key, anchors, slope }) {
  const F = ROOF_LABEL_FONT_MM;
  const L = ROOF_LABEL_ARROW_MM;
  const G = ROOF_LABEL_GAP_MM;
  const name = '屋根';
  const slopeText = roofSlopeText(slope);
  const w1 = estimatedTextWidth(name, F);
  const w2 = estimatedTextWidth(slopeText, F);
  const out = [];
  for (const { drainIndex, anchor: a, flow } of anchors) {
    const [dx, dy] = FLOW_DIRECTION[flow];
    const points = [a.x - (dx * L) / 2, a.y - (dy * L) / 2, a.x + (dx * L) / 2, a.y + (dy * L) / 2];
    out.push({ kind: 'arrow', key: `${key}:arrow:${drainIndex}`, points, head: chevronPoints(points, ROOF_LABEL_HEAD_MM), detailOnly: true });
    const vertical = flow === 'up' || flow === 'down';
    const nameAt = vertical ? { x: a.x - G - w1, y: a.y - F / 2 } : { x: a.x - w1 / 2, y: a.y - G - F };
    const slopeAt = vertical ? { x: a.x + G, y: a.y - F / 2 } : { x: a.x - w2 / 2, y: a.y + G };
    out.push({ kind: 'text', key: `${key}:text:${drainIndex}:name`, ...nameAt, text: name, fontSizeMm: F, detailOnly: true });
    out.push({ kind: 'text', key: `${key}:text:${drainIndex}:slope`, ...slopeAt, text: slopeText, fontSizeMm: F, detailOnly: true });
  }
  return out;
}
