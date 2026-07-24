/**
 * 段差断面（隣接する2部屋にFL差があり、境界が壁・扉で塞がれていない間口）の幾何計算。
 *
 * 検出ロジック:
 *   1. computeNamedBoundaryEdges（edgeClassify.js）でセル境界単位の候補を列挙する。
 *   2. 各境界を「直交する区切りCL」で刻み、小区間ごとに両側の部屋を解決して段差量を求める
 *      （屋内どうし・floorLevelDiff≠0・階段吹抜け(STAIR_VOID)でない組のみ。STEPマスター
 *      判定 selectBoundaryMaster と同じ条件）。
 *   3. 同一軸CL・同一段差量の小区間を数値区間として結合する（重複もここで畳まれる）。
 *   4. 区間上の壁・開口（本ファイルの openSubIntervals）を差し引き、残った開放区間（間口）
 *      ごとに1件の断面プロファイルを作る。
 *
 * 小区間ごとに部屋を解決するのが要（セル境界の中点1点で部屋組を決めない）。中心線を部分的に
 * 短縮すると、その区間ではセルが横へ連結して「境界が実在しない」状態になるが、セルキーの上では
 * 境界CLが端点として残り続ける。中点だけを見ると、境界が実在しない区間まで段差として扱われる。
 *
 * 描画ルールをここへ集約し、レンダラ（StepSectionLayer.jsx）は結果を Konva 要素へ写像するだけ
 * にする（wallJunctionResolve.js・finish/stair/stairGeometry.js と同じパターン）。
 */
import { CenterLineType, RoomFeature, RoomKind } from '@core';
import { computeNamedBoundaryEdges, edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { worldToCell, dividerCLsBetween } from './gridCells.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from './wallGeneration.js';
import { subtractIntervals } from './stair/stairGeometry.js';

// 断面プロファイルの張り出し長（軸CLから左右へ。mm）
export const STEP_SECTION_RUN_MM = 300;
// 段差線（蹴上げ）の軸CLからの偏芯量(mm)。低い方へ「下地材/2 + 仕上げ材」
// ＝部屋壁の生成オフセット（wallGeneration.js）と同じ量だけずらす
export const STEP_LINE_ECCENTRICITY_MM = DEFAULT_WALL_BASE / 2 + DEFAULT_WALL_FINISH;
// 床ラインの下側（along+方向）に描くハッチ帯の深さ（mm）
export const STEP_SECTION_HATCH_DEPTH_MM = 90;
// ハッチ線のピッチ（線に垂直な方向の間隔。mm）
export const STEP_SECTION_HATCH_PITCH_MM = 60;
// 寸法の足（引出線）の起点を断面から離す距離（mm）— 断面線にタッチさせない
export const STEP_SECTION_WITNESS_GAP_MM = 30;
// 寸法値を蹴上げ（段差）から離す距離（mm）— 寸法線より段差寄りに置く
export const STEP_SECTION_DIM_TEXT_ACROSS_MM = 150;

// 段差断面を描く最小の間口幅(mm)。部屋外周壁の端点はコーナーで直交壁の仕上げ面ぶん
// （= STEP_LINE_ECCENTRICITY_MM）内側へ詰められているため、境界から壁を差し引くと両端に
// 数十mmの残差が残る。これは作図上の詰め代であって開口ではない（詰め代の位置は直交壁の材が
// 占めている）。人が通れない幅の区間は間口とみなさない。
const MIN_OPEN_MM = 200;

// 端点CL・壁スパンの一致判定の許容差(mm)（stairGeometry.js の WALL_AXIS_CL_EPS と同水準）
const WALL_AXIS_EPS = 0.5;

// 隣接セル判定のサンプリング距離(mm)。edgeClassify.js の ADJACENT_SAMPLE_EPS と同値。
const ADJACENT_SAMPLE_EPS = 10;

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（他 finish/*.js と同じ規約）
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * axisCLId 上の [lo,hi] 区間から、壁・開口（建具）に覆われた部分を差し引いた
 * 「壁・扉のない区間（開放された間口）」を返す。
 */
function openSubIntervals(graph, axisCLId, isVertical, lo, hi) {
  const covers = [];
  for (const w of graph.walls) {
    if (w.isVertical !== isVertical || w.axisCL.id !== axisCLId) continue;
    covers.push([Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)]);
  }
  for (const o of graph.openings) {
    if (o.isVertical !== isVertical || o.axisCL.id !== axisCLId) continue;
    covers.push([Math.min(o.coord1, o.coord2), Math.max(o.coord1, o.coord2)]);
  }
  return subtractIntervals(lo, hi, covers).filter(([a, b]) => b - a >= MIN_OPEN_MM);
}

// 間口端に直交壁があるかを判定する（段差線を壁の仕上げ面で止めるため）。
// endVal = 間口端の座標（境界の伸び方向）、acrossPos = 境界軸の座標。
function hasCrossWallAt(graph, endVal, isVertical, acrossPos) {
  return graph.walls.some(w =>
    w.isVertical !== isVertical &&
    Math.abs(w.axisCL.effectiveValue - endVal) < WALL_AXIS_EPS &&
    Math.min(w.coord1, w.coord2) - WALL_AXIS_EPS <= acrossPos &&
    acrossPos <= Math.max(w.coord1, w.coord2) + WALL_AXIS_EPS);
}

// (across, along) → world {x,y}。isVertical(軸CLがVERTICAL): 境界の伸び方向(along)=Y、
// 断面の張り出し方向(across)=X。!isVertical はその逆。
function toPoint(isVertical, across, along) {
  return isVertical ? { x: across, y: along } : { x: along, y: across };
}

function rectFrom(p1, p2) {
  return { x1: Math.min(p1.x, p2.x), y1: Math.min(p1.y, p2.y), x2: Math.max(p1.x, p2.x), y2: Math.max(p1.y, p2.y) };
}

// 矩形を覆う45度の斜めハッチ線（世界座標）。実際の切り抜きは呼び出し側（Konva Group clip）が
// 行うため、ここでは rect の外側まで余裕を持たせた長さで生成する。
function hatchLines(rect, pitchMm) {
  const { x1, y1, x2, y2 } = rect;
  const diag = (x2 - x1) + (y2 - y1) + pitchMm;
  const step = pitchMm * Math.SQRT2; // c=x+y の間隔 → 実際の垂直方向ピッチが pitchMm になるよう補正
  const cMin = x1 + y1, cMax = x2 + y2;
  const lines = [];
  for (let c = cMin; c <= cMax; c += step) {
    const xa = x1 - diag, xb = x2 + diag;
    lines.push({ x1: xa, y1: c - xa, x2: xb, y2: c - xb });
  }
  return lines;
}

/**
 * 1件の段差線＋断面プロファイルを組み立てる。
 * @param {number} axisVal - 境界軸CLの座標値(mm)
 * @param {boolean} isVertical - 軸CLがVERTICALか
 * @param {number} along - 間口区間の中点（境界の伸び方向の座標。mm）
 * @param {number} diff - floorLevelDiff(roomNeg, roomPos) = level(roomPos) - level(roomNeg)
 * @param {number} lineLo - 段差線の始端（壁仕上げ面まで詰めた座標。mm）
 * @param {number} lineHi - 段差線の終端（同上。mm）
 */
function buildStepSection({ id, axisVal, isVertical, along, diff, lineLo, lineHi }) {
  // along+ が「低い方（床下・地盤側）」。lowSign = 低い部屋がある across 方向
  // （diff>0 は roomPos が高い → 低いのは roomNeg 側 = across−）。
  const half      = Math.abs(diff) / 2;
  const lowAlong  = along + half;
  const highAlong = along - half;
  const lowSign   = diff > 0 ? -1 : 1;

  // 段差線（蹴上げ）は軸CL上ではなく、低い方へ「下地材/2 + 仕上げ材」だけ偏芯させる
  // （部屋壁の生成オフセットと同じ量）。床ラインもこの位置まで移動して段差線に取り付く。
  const stepAcross = axisVal + lowSign * STEP_LINE_ECCENTRICITY_MM;
  const lowOuter   = axisVal + lowSign * STEP_SECTION_RUN_MM;
  const highOuter  = axisVal - lowSign * STEP_SECTION_RUN_MM;

  const pt = (across, alongV) => toPoint(isVertical, across, alongV);
  const pHighOuter = pt(highOuter,  highAlong);
  const pHighInner = pt(stepAcross, highAlong);
  const pLowInner  = pt(stepAcross, lowAlong);
  const pLowOuter  = pt(lowOuter,   lowAlong);

  // 段差線: 高低差のある境界を、間口いっぱい（両端の壁仕上げ面から壁仕上げ面まで）横切る線分。
  // 位置は軸CLではなく低い方へ偏芯させた stepAcross（断面プロファイルの蹴上げと同じ位置）。
  const pLineA = pt(stepAcross, lineLo);
  const pLineB = pt(stepAcross, lineHi);
  const stepLine = { x1: pLineA.x, y1: pLineA.y, x2: pLineB.x, y2: pLineB.y };

  // 断面線: 上段床ライン → 蹴上げ → 下段床ライン（3線分で表現）
  const profileSegs = [
    { x1: pHighOuter.x, y1: pHighOuter.y, x2: pHighInner.x, y2: pHighInner.y },
    { x1: pHighInner.x, y1: pHighInner.y, x2: pLowInner.x,  y2: pLowInner.y },
    { x1: pLowInner.x,  y1: pLowInner.y,  x2: pLowOuter.x,  y2: pLowOuter.y },
  ];

  const hatchRectHigh = rectFrom(pHighOuter, pt(stepAcross, highAlong + STEP_SECTION_HATCH_DEPTH_MM));
  const hatchRectLow  = rectFrom(pLowInner,  pt(lowOuter,   lowAlong  + STEP_SECTION_HATCH_DEPTH_MM));

  // 寸法は「低い方の部屋」側に描く。寸法線は寸法値と同じ across 位置で返し、
  // 「寸法値の直下」への逃がしはレンダラがスクリーンpx基準でずらす（文字高はズーム非依存の
  // px指定なので、mm固定の逃がし量では倍率によって文字に重なったり離れすぎたりするため）。
  // 引出線は高い側だけに引く（低い側は床ラインと重なるため不要。端点の塗りつぶし丸は両端に残る）。
  // 起点は段差線から WITNESS_GAP 離して断面線へタッチさせない。
  const textAcross  = stepAcross + lowSign * STEP_SECTION_DIM_TEXT_ACROSS_MM;
  const dimAcross   = textAcross;
  const witHighFrom = stepAcross + lowSign * STEP_SECTION_WITNESS_GAP_MM;

  const pDimLow  = pt(dimAcross, lowAlong);
  const pDimHigh = pt(dimAcross, highAlong);
  const pWitHigh = pt(witHighFrom, highAlong);
  const pText    = pt(textAcross, along);

  return {
    id,
    isVertical,
    heightDiffMm: Math.round(Math.abs(diff)),
    stepLine,
    profileSegs,
    hatch: [
      { rect: hatchRectHigh, lines: hatchLines(hatchRectHigh, STEP_SECTION_HATCH_PITCH_MM) },
      { rect: hatchRectLow,  lines: hatchLines(hatchRectLow,  STEP_SECTION_HATCH_PITCH_MM) },
    ],
    dim: {
      line: { x1: pDimLow.x, y1: pDimLow.y, x2: pDimHigh.x, y2: pDimHigh.y },
      witnesses: [
        { x1: pWitHigh.x, y1: pWitHigh.y, x2: pDimHigh.x, y2: pDimHigh.y },
      ],
      textX: pText.x,
      textY: pText.y,
    },
  };
}

/**
 * 軸CL上の点（across = axisVal, along）の両側セルが属する部屋を返す。
 * @returns {[Room|null, Room|null]} [負側, 正側]（null = 無名屋外／格子外）
 */
function roomsAcross(graph, cellToRoom, isVertical, axisVal, along) {
  const at = (off) => {
    const cell = isVertical
      ? worldToCell(axisVal + off, along, graph)
      : worldToCell(along, axisVal + off, graph);
    return cell ? (cellToRoom.get(cell.key) ?? null) : null;
  };
  return [at(-ADJACENT_SAMPLE_EPS), at(+ADJACENT_SAMPLE_EPS)];
}

/**
 * 軸CL上の1点における段差量(mm)。段差断面の対象外なら 0 を返す。
 * 条件は境界マスター選定（selectBoundaryMaster の STEP）と揃える。
 */
function stepDiffAt(graph, cellToRoom, isVertical, axisVal, along) {
  const [roomNeg, roomPos] = roomsAcross(graph, cellToRoom, isVertical, axisVal, along);
  // 片側が無名屋外、または両側が同一部屋（＝境界が実在しない区間を含む）→ 対象外
  if (!roomNeg || !roomPos || roomNeg.id === roomPos.id) return 0;
  if (roomNeg.kind === RoomKind.EXTERIOR || roomPos.kind === RoomKind.EXTERIOR) return 0;
  // 階段吹抜け（STAIR_VOID）は一切描画しない自動管理Room。未定義部屋は床レベルを持たない
  if (roomNeg.feature === RoomFeature.STAIR_VOID || roomPos.feature === RoomFeature.STAIR_VOID) return 0;
  if (roomNeg.feature === RoomFeature.UNDEFINED || roomPos.feature === RoomFeature.UNDEFINED) return 0;
  return graph.floorLevelDiff(roomNeg, roomPos);
}

/**
 * 同一段差量の数値区間を、接する・重なるものどうし結合する。
 * 同じ境界が親部屋と部分指定部屋の両方から二重に上がるため、重複もここで畳まれる。
 * @param {{lo:number, hi:number, diff:number}[]} spans
 */
function mergeSpans(spans) {
  const byDiff = new Map();
  for (const s of spans) {
    if (!byDiff.has(s.diff)) byDiff.set(s.diff, []);
    byDiff.get(s.diff).push(s);
  }
  const merged = [];
  for (const [diff, list] of byDiff) {
    list.sort((a, b) => a.lo - b.lo);
    let cur = { lo: list[0].lo, hi: list[0].hi, diff };
    for (const s of list.slice(1)) {
      if (s.lo <= cur.hi + WALL_AXIS_EPS) cur.hi = Math.max(cur.hi, s.hi);
      else { merged.push(cur); cur = { lo: s.lo, hi: s.hi, diff }; }
    }
    merged.push(cur);
  }
  return merged;
}

/**
 * グラフ全体から段差断面の描画データを列挙する。
 * @param {object} graph
 * @returns {ReturnType<typeof buildStepSection>[]}
 */
export function computeStepSections(graph) {
  if (!graph) return [];
  const cellToRoom = buildCellToRoom(graph);

  // axisCLId → { isVertical, spans: [{lo, hi, diff}] }
  const byAxis = new Map();
  for (const key of computeNamedBoundaryEdges(graph)) {
    const geo = edgeGeometry(key, graph, cellToRoom);
    if (!geo) continue;
    const { isVertical, axisCL, startCL, endCL } = geo;
    // 壁・開口の coord1/coord2 は effectiveValue 由来のため、比較・配置も同じ基準に揃える
    const axisVal = axisCL.effectiveValue;
    const lo = Math.min(startCL.effectiveValue, endCL.effectiveValue);
    const hi = Math.max(startCL.effectiveValue, endCL.effectiveValue);

    // 直交する区切りCLで刻む。この刻みの中では両側のセル（＝部屋）が変わらないので、
    // 小区間の中点1点のサンプリングでその区間全体の段差量が確定する。
    const orthoType = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
    const cuts = dividerCLsBetween(graph, orthoType, lo, hi).map(cl => cl.effectiveValue);
    const breaks = [...new Set([lo, ...cuts, hi])].sort((a, b) => a - b);

    for (let i = 0; i < breaks.length - 1; i++) {
      const subLo = breaks[i], subHi = breaks[i + 1];
      if (subHi - subLo < WALL_AXIS_EPS) continue;
      const diff = stepDiffAt(graph, cellToRoom, isVertical, axisVal, (subLo + subHi) / 2);
      if (diff === 0) continue;
      if (!byAxis.has(axisCL.id)) byAxis.set(axisCL.id, { isVertical, spans: [] });
      byAxis.get(axisCL.id).spans.push({ lo: subLo, hi: subHi, diff });
    }
  }

  // 位置が同じ断面は1件に畳む——重複を残すと React の key が衝突し、片方が描画から落ちる。
  const sectionMap = new Map();
  for (const [axisCLId, { isVertical, spans }] of byAxis) {
    const axisShape = getShape(graph, axisCLId);
    if (!axisShape) continue;
    const axisVal = axisShape.effectiveValue;

    for (const { lo, hi, diff } of mergeSpans(spans)) {
      for (const [subLo, subHi] of openSubIntervals(graph, axisCLId, isVertical, lo, hi)) {
        // 段差線の両端は、間口端に直交壁があればその仕上げ面まで詰める（壁がなければCL位置のまま）
        const loInset = hasCrossWallAt(graph, subLo, isVertical, axisVal) ? STEP_LINE_ECCENTRICITY_MM : 0;
        const hiInset = hasCrossWallAt(graph, subHi, isVertical, axisVal) ? STEP_LINE_ECCENTRICITY_MM : 0;
        const id = `${axisCLId}:${subLo.toFixed(1)}:${subHi.toFixed(1)}`;
        if (sectionMap.has(id)) continue;
        sectionMap.set(id, buildStepSection({
          id, axisVal, isVertical, along: (subLo + subHi) / 2, diff,
          lineLo: subLo + loInset, lineHi: subHi - hiInset,
        }));
      }
    }
  }
  return [...sectionMap.values()];
}
