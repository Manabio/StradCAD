/**
 * 腰壁・垂れ壁（交点から交点の1区間単位の指定）の解決・検証（仕上げモードで動的ロード）。
 *
 * PlanGraph.kneeDropWalls（key=edgeKey(axisCLId,startCLId,endCLId) → レコード）は「何を
 * 指定したか」だけを保持する。壁側（Wall.axisOffset 等の厚みジオメトリ）へは一切書き込まない
 * ——腰壁・垂れ壁は「天板」の追加描画（ShapesLayer.jsx）と、平面切断高さ以下の腰壁のみ
 * 通常の壁帯描画を天板輪郭に差し替える表示上の分岐であり、壁自体の材構成は変えない。
 *
 * 天端: 壁の仕上げ面と**同面**（幅＝12+壁の層厚+12＝壁厚そのもの）で、壁の上端から厚
 * CAP_THICKNESS ぶんの帯（仕様2026-08の断面図）。腰壁＝床から天端までの寸法（topHeight）。
 * 垂れ壁＝天井から下端までの寸法（bottomHeight。天端の対称扱い）。帯は壁の高さの**内側**に
 * あり、topHeight/bottomHeight を増やさない。
 */

import { edgeKey } from '@core';
import { worldToCell } from './gridCells.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { cellsBeyondBreak } from './stair/stairGeometry.js';
import { stairUnderRoomsOf } from './stair/stairUnderRooms.js';
import { roomCeilingHeight } from './roomMetrics.js';

export const CAP_THICKNESS   = 30;   // mm — 天端の帯の厚さ（仕様2026-08。壁上端から下へ）
// mm — 天端の**壁仕上げ面**からの出幅（仕様2026-08「天端幅 = 12 + 壁の層厚 + 12」の12。
// 壁の層厚＝仕上げ面から仕上げ面までの壁厚で、12はその外側への出。仕上げ材の厚みではない）。
// 出るのは**厚み方向だけ**——長さ方向は壁端で止まる（ユーザー確定2026-08）ため、平面の天端は
// 壁のスパンをそのまま使い capLo/capHi（厚み方向）にだけこの出幅を足す。
export const CAP_OVERHANG    = 12;
export const PLAN_CUT_HEIGHT = 1500; // mm — 平面切断高さ

// 天井高さが解決できない（区間の両側とも部屋がない）ときのエラーメッセージ。
// validateKneeDropWall と KneeDropWallDialog（フィールド未入力でも先出しする上部固定ブロック）の
// 双方で使う唯一の情報源。
export const ERR_CEILING_HEIGHT_UNRESOLVED = '天井高さを解決できません（両側とも部屋がありません）';

const MIN_HEIGHT  = 20; // mm — 腰H・垂れHの下限（天井高さ上限側のマージンも同値）
const BOTH_MARGIN = 20; // mm — 両方指定時の上限式 (腰H+垂れH <= 天井高さ - 2*BOTH_MARGIN) に使う

// 壁スパンと区間の重なりを「有意」とみなす下限(mm)。
// 隅の取り合いで壁端は**隣の区間へ半壁厚ぶん食い込む**——コーナーマップも closeConvexCorners
// （wallGeneration.js）も、角では相手壁の仕上げ面（軸CLから ±(wallBase/2+wallFinish)）まで
// 端点を伸ばすため。ここを微小値（5mm等）にすると「隣の区間の壁が57.5mmはみ出しただけ」を
// 区間の構成壁として拾ってしまい、その壁が**全長にわたって**腰壁天板の輪郭で描き替えられる
// （実機2026-08「21」2階 X2×Y2+3500: 隣室側の壁に天板線が増え、通常の壁帯が消えた）。
// 値は隅の取り合いの許容差（core/wallChamfer.js chamferWalls・renderer/wallJunctionResolve.js
// の CORNER_EXCLUSION・closeConvexCorners の CONTINUE_TOL）と揃えた 150mm。
const SPAN_OVERLAP_EPS = 150; // mm

// 押下位置から部屋側セルを解決する際のオフセット(mm)。edgeClassify.js の ADJACENT_SAMPLE_EPS と同水準。
const PRESS_SIDE_EPS = 10; // mm

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（edgeClassify.js と同型）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 軸CLの一致判定: **id ではなく世界座標（向き＋位置）で見る**。
 *
 * 同じ通りに別々のCLが2本ある図面が実在する（実機「21」2階の`5d54f984@-3500`と
 * `faaf4c30@-3500`。片方はY2からの相対、片方は絶対で作られたもの）。id一致で照合すると、
 * 面や壁が持つCLと腰壁レコードが持つCLが食い違って**指定が無いことになる**——出隅処理で
 * 同型の不具合を踏んでいる（`.claude/data-model.md`「出隅の取り合い」）。同じ向き・同じ位置の
 * CLは空間的に同じ通りなので、座標で照合する方が厳密に頑健で、階をまたぐ参照にもそのまま効く
 * （断面エンジンは他階のグラフを世界座標で読む）。
 */
const AXIS_MATCH_EPS = 0.5; // mm
function sameAxisLine(a, b) {
  return !!a && !!b && a.centerLineType === b.centerLineType
    && Math.abs(a.effectiveValue - b.effectiveValue) <= AXIS_MATCH_EPS;
}

/**
 * 軸CL（と同じ通り）・区間[spanLo,spanHi]に重なる graph.kneeDropWalls のレコードを列挙する。
 * key=edgeKey(axisCLId,startCLId,endCLId) の解読（key.split(':')→CL解決→lo/hi→スパン重なり判定）
 * はこの関数のみで行う——キー形式を所有するこのファイルへ集約し、次の3つが消費者として使う:
 *   - elevation/section/sectionProbe.js の kneeDropZRangesAt … 腰壁・垂れ壁の**実体**
 *     （壁のz存在範囲）。展開図に現れる腰壁の断面・天端・端部・アキの標記はすべてここが源。
 *   - elevation/elevationFaceList.js の kneeDropRecordFor … 面分割（袖壁の高さ）。
 *   - elevation/elevationFigure.js の kneeDropGapsOnFace … **描画ではなく配置の都合**。
 *     段差見付け面（kind==='step'。断面エンジンに対応概念が無い専用描画）と、壁2段書き
 *     ラベルの回避範囲（エンジンの出力は buildFaceFigure の後に積まれるため見えない）。
 * knee/drop指定の有無によるフィルタは呼び出し側の責務のまま（全レコードを返す）。
 * @param {object} graph
 * @param {import('@core').CenterLine} axisCL 壁・面の軸CL（idではなく座標で照合する。sameAxisLine）
 * @param {number} spanLo
 * @param {number} spanHi
 * @returns {Array<{key:string, rec:object, lo:number, hi:number}>} スパンが重ならないものは含まない
 */
export function kneeDropRecordsOnAxis(graph, axisCL, spanLo, spanHi) {
  const out = [];
  if (!axisCL) return out;
  for (const [key, rec] of graph.kneeDropWalls) {
    const [keyAxisCLId, startCLId, endCLId] = key.split(':');
    if (!sameAxisLine(getShape(graph, keyAxisCLId), axisCL)) continue;
    const startCL = getShape(graph, startCLId);
    const endCL   = getShape(graph, endCLId);
    if (!startCL || !endCL) continue;
    const lo = Math.min(startCL.value, endCL.value);
    const hi = Math.max(startCL.value, endCL.value);
    if (hi <= spanLo || lo >= spanHi) continue; // スパンが重ならない
    out.push({ key, rec, lo, hi });
  }
  return out;
}

/**
 * 「1本の壁」に対応する腰壁・垂れ壁レコードを返す（該当が複数あっても先頭）。
 * kneeDropRecordsOnAxis との違いは**隅の取り合いぶんのはみ出しを重なりとみなさない**こと
 * （SPAN_OVERLAP_EPS の説明参照）。素の重なり判定は sectionProbe の点クエリ
 * （kneeDropZRangeAt。幅1mm）が使うため kneeDropRecordsOnAxis 側は変えられない——
 * 「壁がその区間の構成壁か」を問う経路だけがこちらを通る（平面の kneeDropWallGeometry と同じ判定）。
 * @param {object} graph
 * @param {import('@core').CenterLine} axisCL 壁の軸CL
 * @param {number} wLo 壁スパンの下側
 * @param {number} wHi 壁スパンの上側
 * @returns {{key:string, rec:object, lo:number, hi:number}|null}
 */
export function kneeDropRecordForWallSpan(graph, axisCL, wLo, wHi) {
  return kneeDropRecordsOnAxis(graph, axisCL, wLo, wHi)
    .find(r => Math.min(r.hi, wHi) - Math.max(r.lo, wLo) > SPAN_OVERLAP_EPS) ?? null;
}

/**
 * 壁の押下位置（ワールド座標）から、腰壁・垂れ壁の対象区間キー（edgeKey）を解決する。
 * 壁の部屋側（axisOffsetの符号側）へ微小オフセットしてセルを解決し、壁の長さ方向のセル境界
 * CLペアをedgeKeyへ正規化する（computeNamedBoundaryEdges と同じ正規化規則）。
 * @param {import('@core').Wall} wall
 * @param {{x:number,y:number}} worldPos
 * @param {object} graph
 * @returns {string|null} 解決不能（グリッド外・格子未成立）なら null
 */
export function resolveWallSpanKey(wall, worldPos, graph) {
  const axisCL = wall.axisCL;
  const axisV  = axisCL.effectiveValue;
  const along  = wall.isVertical ? worldPos.y : worldPos.x;
  const dir    = Math.sign(wall.axisOffset) || 1;
  const probe  = axisV + dir * PRESS_SIDE_EPS;

  const cell = wall.isVertical
    ? worldToCell(probe, along, graph)
    : worldToCell(along, probe, graph);
  if (!cell) return null;

  const [leftId, topId, rightId, bottomId] = cell.key.split(':');
  const [sId, eId] = wall.isVertical ? [topId, bottomId] : [leftId, rightId];
  const sCL = getShape(graph, sId), eCL = getShape(graph, eId);
  if (!sCL || !eCL) return null;
  const [s2, e2] = sCL.value <= eCL.value ? [sId, eId] : [eId, sId];
  return edgeKey(axisCL.id, s2, e2);
}

/**
 * 区間キーの幾何と、そこに重なる全Wallの実面範囲（materialRange のmin/max合算）を解決する。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom buildCellToRoom(graph) の結果
 * @returns {{axisCL, isVertical:boolean, lo:number, hi:number, faceLo:number, faceHi:number,
 *   walls:import('@core').Wall[], roomNeg, roomPos} | null}
 *   faceLo/faceHi = 区間に重なる壁群の仕上げ全幅（材が存在する範囲の外包絡）。
 *   壁が1本も無ければ null（孤児区間）。
 */
export function kneeDropWallGeometry(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const { axisCL, isVertical, lo, hi, roomNeg, roomPos } = geo;

  let faceLo = Infinity, faceHi = -Infinity;
  const walls = [];
  for (const w of graph.walls) {
    // 軸の一致は id ではなく通り（向き＋座標）で見る（sameAxisLine。同じ通りに別CLが2本ある
    // 図面があり、id一致だと区間の構成壁を取りこぼす）。
    if (!sameAxisLine(w.axisCL, axisCL) || w.isVertical !== isVertical) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (Math.min(wHi, hi) - Math.max(wLo, lo) <= SPAN_OVERLAP_EPS) continue;
    const mr = w.materialRange;
    faceLo = Math.min(faceLo, mr.lo);
    faceHi = Math.max(faceHi, mr.hi);
    walls.push(w);
  }
  if (walls.length === 0) return null;

  return { axisCL, isVertical, lo, hi, faceLo, faceHi, walls, roomNeg, roomPos };
}

/**
 * 壁が腰壁・垂れ壁指定の対象として適格か（外壁と、2a壁＝階段下部屋の偏芯壁は対象外）。
 * 2a壁は generateStairUnderWalls 固有の偏芯式で生成される別管理の壁で、通常の壁帯描画の
 * 前提（materialRange の単純合算）がそのまま成立しないため対象から除く（.claude/data-model.md
 * 「内周壁は仕上げ脱出境界で全削除・導出再生成する」2a節参照）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @returns {boolean}
 */
export function isEligibleWallSpan(wall, graph) {
  if (wall.isExteriorWall) return false;
  for (const stair of graph.stairs) {
    const beyond = cellsBeyondBreak(stair, graph, stair.riser ?? null);
    if (beyond.size === 0) continue;
    for (const room of stairUnderRoomsOf(stair, graph, beyond)) {
      if (room.generatedWallIds.has(wall.id)) return false;
    }
  }
  return true;
}

/**
 * 区間の両側の部屋の天井高さのうち低い方を返す（片側が部屋なしならその側は無視）。
 * @param {object} graph
 * @param {string} key edgeKey(axisCLId, startCLId, endCLId)
 * @param {Map<string, import('@core').Room>} cellToRoom
 * @returns {number|null} 両側とも部屋なし（区間の幾何が解決できない）なら null
 */
export function effectiveCeilingHeight(graph, key, cellToRoom) {
  const geo = edgeGeometry(key, graph, cellToRoom);
  if (!geo) return null;
  const heights = [];
  for (const room of [geo.roomNeg, geo.roomPos]) {
    if (!room) continue;
    heights.push(roomCeilingHeight(graph, room).mm);
  }
  if (heights.length === 0) return null;
  return Math.min(...heights);
}

/**
 * 腰壁高さ・垂れ壁高さの入力値を検証する。
 * @param {number|null} kneeTop 腰壁の上端寸法(mm)。null=腰壁指定なし
 * @param {number|null} dropBottom 垂れ壁の下端寸法(mm)。null=垂れ壁指定なし
 * @param {number|null} ceilingHeight effectiveCeilingHeight の結果
 * @returns {{valid:boolean, error:string|null}}
 */
export function validateKneeDropWall(kneeTop, dropBottom, ceilingHeight) {
  if (kneeTop == null && dropBottom == null) return { valid: true, error: null }; // 両方未指定＝解除
  if (ceilingHeight == null) return { valid: false, error: ERR_CEILING_HEIGHT_UNRESOLVED };

  const max = ceilingHeight - MIN_HEIGHT;
  if (kneeTop != null && !(kneeTop >= MIN_HEIGHT && kneeTop <= max)) {
    return { valid: false, error: `腰壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (dropBottom != null && !(dropBottom >= MIN_HEIGHT && dropBottom <= max)) {
    return { valid: false, error: `垂れ壁高さは${MIN_HEIGHT}〜${max}mmで指定してください` };
  }
  if (kneeTop != null && dropBottom != null) {
    const limit = ceilingHeight - 2 * BOTH_MARGIN;
    if (kneeTop + dropBottom > limit) {
      return { valid: false, error: `腰壁高さ＋垂れ壁高さは${limit}mm以下にしてください` };
    }
  }
  return { valid: true, error: null };
}

/**
 * 描画用: 腰壁・垂れ壁が指定された区間に重なる全WallのID → 描画オーバーレイ情報のMapを返す
 * （wallJunctionResolve.js の resolveWallTJunctions と同様、毎レンダー解決）。
 *
 * 優先順位（同一区間に腰壁・垂れ壁が同居する場合）: 腰壁が平面切断高さを貫く
 * （topHeight > PLAN_CUT_HEIGHT）ときは常に通常の壁帯描画を優先し、垂れ壁のオーバーレイも
 * 出さない（要件の明示規則）。腰壁が貫かない（<=PLAN_CUT_HEIGHT）ときは腰壁の天板輪郭が
 * 常に優先される（腰壁天板より低い切断面には他に描くものが無いため）。腰壁指定が無い区間
 * でのみ垂れ壁の判定（切断面が壁本体を貫くか）を行う。
 * @param {object} graph
 * @returns {Map<string, {mode:'knee'|'drop', capLo:number, capHi:number}>}
 */
export function resolveKneeDropOverlays(graph) {
  const result = new Map();
  if (graph.kneeDropWalls.size === 0) return result;
  const cellToRoom = buildCellToRoom(graph);

  for (const [key, rec] of graph.kneeDropWalls) {
    if (!rec.knee && !rec.drop) continue;
    const geo = kneeDropWallGeometry(graph, key, cellToRoom);
    if (!geo) continue;
    const capLo = geo.faceLo - CAP_OVERHANG, capHi = geo.faceHi + CAP_OVERHANG;

    let overlay = null;
    if (rec.knee) {
      if (rec.knee.topHeight <= PLAN_CUT_HEIGHT) overlay = { mode: 'knee', capLo, capHi };
    } else if (rec.drop) {
      const ceilingHeight = effectiveCeilingHeight(graph, key, cellToRoom);
      // 垂れ壁の下端（床からの高さ = ceilingHeight - bottomHeight）が平面切断高さより上にあれば、
      // 切断面は壁本体を貫かない（notCutByPlane）——このときだけ天板輪郭の破線オーバーレイを出す。
      // 下端が切断面以下（=切断面が壁本体を貫く）なら通常の壁帯描画のまま。
      const notCutByPlane = ceilingHeight != null && (ceilingHeight - rec.drop.bottomHeight) > PLAN_CUT_HEIGHT;
      if (notCutByPlane) overlay = { mode: 'drop', capLo, capHi };
    }
    if (!overlay) continue;

    for (const w of geo.walls) {
      if (!result.has(w.id)) result.set(w.id, overlay);
    }
  }
  return result;
}
