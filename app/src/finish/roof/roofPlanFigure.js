/**
 * 下屋の平面表示の図形（軒先の線・棟木・隅木・谷木。ステップ1＝線だけ）の純モジュール。
 * renderer/RoofPlanLayer.jsx は結果を Konva 要素へ写すだけ。store.js・snap.js・.jsx・react-konva を静的に import しない
 * （node:test から単体で import できる）。graphDerived も import しない（memo は呼び出し側の jsx）。
 *
 * 対象は下屋（RoomFeature.ROOF の部屋）だけ。主屋根は対象外。全構造種別で出す（structural/roofFramingRegions.js
 * leanToPlanRegions。構造ゲートなし）。母屋・束・小屋梁は描かない。線は細い実線1本で、全 LOD で同じ。
 *
 * primitive: { kind:'line', key, role:'outline'|'ridge'|'hip'|'valley', points:number[], closed:boolean, detailOnly:false }
 *   outline＝軒先・けらばの外形線（壁の中に重なる部分は除く）、ridge＝棟木（切妻はけらばの外形線まで・寄棟は延ばさない。
 *   L字の下屋の片流れは向かい合う水下があるときだけ＝伏図と同じ線）、
 *   hip＝隅木（軒の角まで）、valley＝谷木（軒先の線の入隅の角まで。伏図と違い平面だけ延ばす）。
 * 壁に当たる線の端（外形線の開いた端・棟木・隅木・谷木）は、通り芯ではなく描かれている壁の屋根側の外壁面で止める
 * （roofPlanWallTrim.js。壁が無い階は通り芯のまま）。
 * 切妻になる L字・棟違いは暫定で軒先の線だけ（次のステップで「妻面全幅の中心が棟木」の規則を入れる）。
 * 詳細（DETAIL）だけ、傾斜面（水下）ごとに水下向きの矢印・「屋根」・「（傾斜N/10）」を出す（detailOnly:true の arrow・text。
 * visibleRoofPlanPrimitives が他の LOD で除く）。矢じりは renderer/chevron.js（依存なしの純モジュール）。
 */
import { CL_OVERLAP_TOL_MM, DEFAULT_ROOF_SLOPE } from '../../core/constants.js';
import { roofRidgeLines, roofHipDiagonals, extendLinesToOutline, extendDiagonalsToOutline, drainFaceAnchors } from '../../structural/roofFramingGeometry.js';
import { chevronPoints } from '../../renderer/chevron.js';
import { leanToPlanRegions } from '../../structural/roofFramingRegions.js';
import { outerWallFaceNear } from '../wallFaces.js';
import { trimRoofPlanLinesAtWalls } from './roofPlanWallTrim.js';
import { LodLevel } from '../../viewport.js';

const segment = line => (line.isVertical
  ? [line.coord, line.lo, line.coord, line.hi]
  : [line.lo, line.coord, line.hi, line.coord]);

/**
 * 平面に描く下屋の図形（graph の屋根の部屋ごとに、外形線→棟木→隅木→谷木の順）。屋根が無い・graph が無い階は []。
 * 戻り値は読み取り専用（呼び出し側が memo して複数レンダーで共有する）。
 * @param {object|null} graph 屋根セルのある階の graph
 * @returns {Array<object>} 線 { kind:'line', key, role:'outline'|'ridge'|'hip'|'valley', points, closed, detailOnly:false } のあとに、
 *   region ごとに傾斜ラベル（kind:'arrow'|'text'。roofSlopeLabelPrimitives）
 */
export function roofPlanFigure(graph) {
  const out = [];
  const tolMm = CL_OVERLAP_TOL_MM;
  const faceAt = q => outerWallFaceNear(graph, q);
  for (const region of leanToPlanRegions(graph)) {
    const lines = [];
    region.exposedPaths.forEach((path, i) => {
      lines.push({ kind: 'line', key: `${region.key}:outline:${i}`, role: 'outline', points: path.points, closed: path.closed, detailOnly: false });
    });
    const ridges = extendLinesToOutline({
      lines: roofRidgeLines({
        rect: region.rect, rects: region.rects ?? null, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical,
        leanToDrains: region.leanToDrains ?? null, leanToPurlinDepthMm: region.leanToPurlinDepthMm ?? null, tolMm,
      }),
      edges: region.edges, tolMm,
    });
    ridges.forEach((line, i) => {
      lines.push({ kind: 'line', key: `${region.key}:ridge:${i}`, role: 'ridge', points: segment(line), closed: false, detailOnly: false });
    });
    // L字の下屋の継ぎ目（隅木・谷木）は水下への距離の場（伏図と同じ）。軒先の角（出隅・入隅）まで延ばす
    const diagonals = extendDiagonalsToOutline({
      diagonals: roofHipDiagonals({ rect: region.rect, rects: region.rects ?? null, shape: region.shape, leanToDrains: region.leanToDrains ?? null, tolMm }),
      edges: region.edges, valleys: true, tolMm,
    });
    const counts = { hip: 0, valley: 0 };
    for (const d of diagonals) {
      lines.push({ kind: 'line', key: `${region.key}:${d.kind}:${counts[d.kind]++}`, role: d.kind, points: [d.x1, d.y1, d.x2, d.y2], closed: false, detailOnly: false });
    }
    // 壁に当たる端は通り芯でなく外壁面で止める（壁が無ければ通り芯のまま）。壁を探す距離は出幅（軒・けらば）の大きい方
    const reachMm = Math.max(0, ...region.edges.map(e => e.overhangMm)) + tolMm;
    out.push(...trimRoofPlanLinesAtWalls(lines, { faceAt, zeroZones: region.zeroZones, reachMm, tolMm }));
    // 傾斜面ごとのラベル（詳細 LOD のみ）。外壁面どまりは線の端だけで、ラベルの座標は動かさない。
    // 傾斜面1つにつき1つ（ユーザー指示）。壁に接する切妻・寄棟の下屋は壁の辺も水下なので、壁へ向かう矢印の面も出す（描いてある面を省かない）
    const anchors = drainFaceAnchors({ rects: region.rect ? [region.rect] : region.rects, drains: region.planDrains, tolMm });
    out.push(...roofSlopeLabelPrimitives({ key: region.key, anchors, slope: region.slope }));
  }
  return out;
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

/**
 * 表示する図形。詳細（DETAIL）は全部、他の LOD は詳細だけの図形（detailOnly。ステップ2の文字・矢印）を除く。
 * 線は全 LOD で出す。
 * @param {Array<{detailOnly:boolean}>} primitives roofPlanFigure の結果
 * @param {string} lod LodLevel
 */
export function visibleRoofPlanPrimitives(primitives, lod) {
  return lod === LodLevel.DETAIL ? primitives : primitives.filter(p => !p.detailOnly);
}
