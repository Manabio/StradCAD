/**
 * 部屋領域 (Room.cells) から外周壁を自動生成するユーティリティ。
 *
 * 変位量 = wallBase / 2 + wallFinish (mm) — 境界CLから室内方向へオフセット
 * デフォルト: wallBase=90, wallFinish=12.5 → 57.5mm
 */

import { RoomKind } from '@core';
import { worldToCell, dividerCLsBetween } from './gridCells.js';
import { buildCellToRoom } from './edgeClassify.js';

export const DEFAULT_WALL_BASE   = 90;    // mm
export const DEFAULT_WALL_FINISH = 12.5;  // mm

// 隣接セル判定時、境界線からこの距離(mm)だけ内側をサンプリングする
const ADJACENT_SAMPLE_EPS = 10; // mm

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

// ----------------------------------------------------------------
// 境界エッジ検出
// ----------------------------------------------------------------

/**
 * 1D スパン [startId, endId] において、adjacentSpans でカバーされない外部サブ区間を返す。
 * 隣接セルのスパンが部分的にしか重ならない場合（異なる幅のセルが境界を共有する場合）も
 * 正しく分割して外部区間だけを抽出する。
 *
 * @param {string} startId
 * @param {string} endId
 * @param {{L: string, R: string}[]} adjacentSpans - 隣接セルのスパン（{L, R} は CL ID）
 * @param {object} graph
 * @returns {[string, string][]} 外部サブ区間の [startId, endId] ペアの配列
 */
function externalSubIntervals(startId, endId, adjacentSpans, graph) {
  const startCL = getShape(graph, startId);
  const endCL   = getShape(graph, endId);
  if (!startCL || !endCL) return [];

  const startVal = startCL.value;
  const endVal   = endCL.value;

  // 自スパン内に入る隣接セル境界をカット点として収集
  // 自部屋のセルには現れない区切りCL（隣の領域だけを分ける境界）も候補に加える。
  // 自部屋側で覆われていなければ後段の covered 判定で外周のまま残り、
  // 覆われていれば隣接室の境界と同じ扱いになるため、追加しても安全（過分割は再マージで吸収される）。
  const cutMap = new Map([[startVal, startId], [endVal, endId]]);
  for (const { L, R } of adjacentSpans) {
    for (const id of [L, R]) {
      const cl = getShape(graph, id);
      if (cl && cl.value > startVal && cl.value < endVal) cutMap.set(cl.value, id);
    }
  }
  for (const cl of dividerCLsBetween(graph, startCL.centerLineType, startVal, endVal)) {
    cutMap.set(cl.value, cl.id);
  }

  const sorted = [...cutMap.entries()].sort((a, b) => a[0] - b[0]);

  const result = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [v1, id1] = sorted[i];
    const [v2, id2] = sorted[i + 1];
    const mid = (v1 + v2) / 2;
    const covered = adjacentSpans.some(({ L, R }) => {
      const lCL = getShape(graph, L);
      const rCL = getShape(graph, R);
      return lCL && rCL && lCL.value <= mid && rCL.value >= mid;
    });
    if (!covered) result.push([id1, id2]);
  }
  return result;
}

/**
 * room.cells の Set<cellKey> から外周エッジパラメータを返す。
 *
 * cellKey = "leftCLId:topCLId:rightCLId:bottomCLId"
 * y軸は下向き正なので topCL.value < bottomCL.value。
 *
 * 値域のオーバーラップで隣接判定するため、異なる幅・高さのセルが境界を部分共有する
 * 場合（L字型の部屋など）でも外周を正しく抽出できる。
 *
 * offset=1 で呼ぶと axisOffset が符号のみ（±1）になり、階段下壁生成（stairUnderWalls.js）が
 * エッジごとに異なる実オフセット値へ差し替える用途に使える。
 *
 * @returns {{ axisCLId, startCLId, endCLId, isVertical, axisOffset }[]}
 */
export function computeExternalEdgeParams(room, offset, graph) {
  // 各境界 CL を持つセルのスパンを収集
  const byTopCL    = new Map(); // clId → [{L, R}]（このCLをtopに持つセル）
  const byBottomCL = new Map(); // clId → [{L, R}]（このCLをbottomに持つセル）
  const byLeftCL   = new Map(); // clId → [{L, R}] where L=topCLId, R=bottomCLId
  const byRightCL  = new Map(); // clId → [{L, R}] where L=topCLId, R=bottomCLId

  for (const cellKey of room.cells) {
    const [L, T, R, B] = cellKey.split(':');
    if (!byTopCL.has(T))    byTopCL.set(T, []);
    if (!byBottomCL.has(B)) byBottomCL.set(B, []);
    if (!byLeftCL.has(L))   byLeftCL.set(L, []);
    if (!byRightCL.has(R))  byRightCL.set(R, []);
    byTopCL.get(T).push({ L, R });
    byBottomCL.get(B).push({ L, R });
    byLeftCL.get(L).push({ L: T, R: B });
    byRightCL.get(R).push({ L: T, R: B });
  }

  const results = [];

  for (const cellKey of room.cells) {
    const [L, T, R, B] = cellKey.split(':');

    // 上辺: セルはTの下側。Tの上側（bottomCL=T）の隣接セルでカバーされない部分が外周
    // 室内は下(y大) → axisOffset = +offset
    for (const [sId, eId] of externalSubIntervals(L, R, byBottomCL.get(T) || [], graph)) {
      results.push({ axisCLId: T, startCLId: sId, endCLId: eId, isVertical: false, axisOffset: +offset });
    }
    // 下辺: セルはBの上側。Bの下側（topCL=B）の隣接セルでカバーされない部分が外周
    // 室内は上(y小) → axisOffset = -offset
    for (const [sId, eId] of externalSubIntervals(L, R, byTopCL.get(B) || [], graph)) {
      results.push({ axisCLId: B, startCLId: sId, endCLId: eId, isVertical: false, axisOffset: -offset });
    }
    // 左辺: セルはLの右側。Lの左側（rightCL=L）の隣接セルでカバーされない部分が外周
    // 室内は右(x大) → axisOffset = +offset
    for (const [sId, eId] of externalSubIntervals(T, B, byRightCL.get(L) || [], graph)) {
      results.push({ axisCLId: L, startCLId: sId, endCLId: eId, isVertical: true,  axisOffset: +offset });
    }
    // 右辺: セルはRの左側。Rの右側（leftCL=R）の隣接セルでカバーされない部分が外周
    // 室内は左(x小) → axisOffset = -offset
    for (const [sId, eId] of externalSubIntervals(T, B, byLeftCL.get(R) || [], graph)) {
      results.push({ axisCLId: R, startCLId: sId, endCLId: eId, isVertical: true,  axisOffset: -offset });
    }
  }

  return results;
}

// ----------------------------------------------------------------
// 連続セグメントのマージ
// ----------------------------------------------------------------

/**
 * 同一 axisCLId・axisOffset のセグメント群を、端点CLが連続するものでマージする。
 * セグメントは startCL.value 昇順でソートし、endCLId === 次の startCLId なら結合。
 */
export function mergeSegments(segs, graph) {
  if (segs.length === 0) return [];

  const sorted = [...segs].sort((a, b) => {
    const aCL = getShape(graph, a.startCLId);
    const bCL = getShape(graph, b.startCLId);
    return (aCL?.value ?? 0) - (bCL?.value ?? 0);
  });

  const merged = [];
  let current = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (current.endCLId === next.startCLId) {
      current = { ...current, endCLId: next.endCLId };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

// ----------------------------------------------------------------
// 外壁ループ抽出
// ----------------------------------------------------------------

/**
 * 部屋の外周エッジ1本について、境界の外側にあるセルの所属部屋を判定する。
 *
 * @param {{axisCLId, startCLId, endCLId, isVertical, axisOffset}} p
 * @returns {import('@core').Room | null} 外側セルが属する部屋（未割当なら null）
 */
export function findOutsideRoom(p, graph, cellToRoom) {
  const axisCL  = getShape(graph, p.axisCLId);
  const startCL = getShape(graph, p.startCLId);
  const endCL   = getShape(graph, p.endCLId);
  if (!axisCL || !startCL || !endCL) return null;

  const sign = Math.sign(p.axisOffset) || 1;
  const axisVal = axisCL.value;
  const mid     = (startCL.value + endCL.value) / 2;
  const outside = axisVal - sign * ADJACENT_SAMPLE_EPS;

  const { x, y } = p.isVertical
    ? { x: outside, y: mid }
    : { x: mid, y: outside };

  const cell = worldToCell(x, y, graph);
  return cell ? (cellToRoom.get(cell.key) ?? null) : null;
}

/**
 * 部屋の外周エッジ1本が外壁ループに含まれるかどうかを判定する。
 *
 * - 内外区分が「屋内」（kind !== EXTERIOR）の部屋: 外側に部屋が割り当てられていない（建物外周）場合のみ外壁
 * - 内外区分が「屋外」の部屋: 外側が「屋内」（kind !== EXTERIOR）の部屋（中庭の境界）の場合のみ外壁
 *
 * feature（階段・吹抜け属性）は外壁分類に無関係。
 *
 * @returns {'outer' | 'courtyard' | null}
 */
function classifyExteriorEdge(room, p, graph, cellToRoom) {
  const outsideRoom = findOutsideRoom(p, graph, cellToRoom);
  const outsideKind = outsideRoom?.kind ?? null;

  if (room.kind !== RoomKind.EXTERIOR) {
    return outsideKind === null ? 'outer' : null;
  }
  return (outsideKind !== null && outsideKind !== RoomKind.EXTERIOR) ? 'courtyard' : null;
}

/**
 * 全部屋の内外区分から外壁ループのセグメントを抽出する。
 *
 * - `loopType: 'outer'` — 建物外周（時計回り想定）
 * - `loopType: 'courtyard'` — 建物内部の屋外領域の境界（反時計回り想定）
 *
 * @returns {{ axisCLId, startCLId, endCLId, isVertical, loopType, value, start, end }[]}
 */
export function computeExteriorWallSegments(graph) {
  const cellToRoom = buildCellToRoom(graph);

  const groups = new Map(); // "axisCLId:loopType" → segs[]
  // 部分指定の部屋は親と同じ外周エッジを重複して上げる（cells は親の部分集合なので
  // 外周の一部が完全に一致する）。同一エッジが2本入ると mergeSegments は端点CLが
  // 連続しないため結合できず、まったく同じ線分が2件返って React の key が衝突する。
  const seen = new Set();
  for (const room of graph.rooms) {
    for (const p of computeExternalEdgeParams(room, 1, graph)) {
      const loopType = classifyExteriorEdge(room, p, graph, cellToRoom);
      if (!loopType) continue;
      const segId = `${p.axisCLId}:${loopType}:${p.startCLId}:${p.endCLId}:${p.axisOffset}`;
      if (seen.has(segId)) continue;
      seen.add(segId);
      const key = `${p.axisCLId}:${loopType}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...p, loopType });
    }
  }

  const segments = [];
  for (const [, segs] of groups) {
    for (const seg of mergeSegments(segs, graph)) {
      const axisCL  = getShape(graph, seg.axisCLId);
      const startCL = getShape(graph, seg.startCLId);
      const endCL   = getShape(graph, seg.endCLId);
      if (!axisCL || !startCL || !endCL) continue;
      segments.push({
        axisCLId:   seg.axisCLId,
        startCLId:  seg.startCLId,
        endCLId:    seg.endCLId,
        isVertical: seg.isVertical,
        loopType:   seg.loopType,
        value:      axisCL.value,
        start:      startCL.value,
        end:        endCL.value,
      });
    }
  }
  return segments;
}

// ----------------------------------------------------------------
// 壁生成
// ----------------------------------------------------------------

// 座標一致判定の許容誤差(mm)。開口辺・エッジとも CL 実値由来のため実質同値の比較
const OPENING_EPS = 1e-6;

/**
 * エッジパラメータ p（computeExternalEdgeParams の1件）が、階段の上り口・下り口の
 * 開口辺（stairPortEdges の結果）上に乗っているかを判定する。
 * サブ区間の切断点には開口辺の端（階段footprint境界のCL）が必ず含まれるため
 * （externalSubIntervals が dividerCLsBetween で全分割CLを切断候補にする）、
 * 区間中点が開口辺内にあるかだけで過不足なく判定できる。
 */
export function onStairOpening(p, graph, openings) {
  if (openings.length === 0) return false;
  const axisCL  = getShape(graph, p.axisCLId);
  const startCL = getShape(graph, p.startCLId);
  const endCL   = getShape(graph, p.endCLId);
  if (!axisCL || !startCL || !endCL) return false;
  const mid = (startCL.value + endCL.value) / 2;
  return openings.some(o =>
    o.isVertical === p.isVertical &&
    Math.abs(o.value - axisCL.value) < OPENING_EPS &&
    mid > o.lo && mid < o.hi,
  );
}

// ----------------------------------------------------------------
// 端点ルール（軸CLの線分範囲による壁のクリップ）
// ----------------------------------------------------------------

// 端点判定の座標一致許容誤差(mm)
const ENDPOINT_EPS = 0.5;

/**
 * 壁セグメントを軸CL（中心線）の線分範囲へクリップする（端点ルール）。
 *
 * 線分編集で交点が無くなった中心線は、セル分割上は列全体を分割し続けるため、
 * 生成セグメントが軸CLの実在範囲（extentLo〜extentHi）を越えることがある。
 * 越えた端は「端点」であり、端点ノードに壁があったと想定した protrusion
 * （下地偏芯量＋仕上げ厚）だけCL端からはね出して止める。範囲外へ完全に出る
 * セグメントは壁を作らない（null）。通り芯・範囲未確定のCLはクリップしない。
 *
 * seg は mergeSegments 後（startCL.value <= endCL.value）であること。
 * @returns {{ startOffset, endOffset } | null}
 */
export function clipToAxisExtent(axisCL, startCL, startOffset, endCL, endOffset, protrusion) {
  if (axisCL.labeled || axisCL.extentLo == null || axisCL.extentHi == null) {
    return { startOffset, endOffset };
  }
  const lo = axisCL.extentLo, hi = axisCL.extentHi;
  if (startCL.value >= hi - ENDPOINT_EPS || endCL.value <= lo + ENDPOINT_EPS) return null;
  let s = startOffset, e = endOffset;
  if (startCL.value < lo - ENDPOINT_EPS) s = (lo - protrusion) - startCL.value;
  if (endCL.value   > hi + ENDPOINT_EPS) e = (hi + protrusion) - endCL.value;
  return { startOffset: s, endOffset: e };
}

// ----------------------------------------------------------------
// コーナーマップ方式による壁生成
// ----------------------------------------------------------------

/**
 * 部屋の境界多角形を「閉じた形」として捉え、各辺の端点オフセットを
 * コーナーマップから直接決定して壁を生成する。
 *
 * chamferWalls に依存せず正確な取り合いを実現するため、
 * 生成された壁には isRoomWall=true が設定される。
 *
 * コーナーマップ: key = "水平CLid:垂直CLid"
 *   value = { hOffset: 水平辺のaxisOffset, vOffset: 垂直辺のaxisOffset }
 *
 * 水平辺の startOffset = コーナーにある垂直辺の axisOffset
 * 水平辺の endOffset   = コーナーにある垂直辺の axisOffset
 * 垂直辺は h/v を逆にして同様。
 *
 * stairOpenings（階段の上り口・下り口の開口辺。stairPortEdges の結果）上のエッジは
 * 壁を生成しない。フィルタはコーナーマップ構築前に行うため、開口辺に接する隣接壁の
 * 端点オフセットは登録されず（null → 0）、隣接壁は開口境界のCL位置で止まる。
 */
export function generateRoomWallsFromOutline(graph, room, { wallBase = DEFAULT_WALL_BASE, wallFinish = DEFAULT_WALL_FINISH } = {}, stairOpenings = []) {
  const offset = wallBase / 2 + wallFinish;
  const rawParams = computeExternalEdgeParams(room, offset, graph)
    .filter(p => !onStairOpening(p, graph, stairOpenings));

  // コーナーマップ構築
  // key: "hCLId:vCLId" (水平CL id : 垂直CL id)
  // 水平辺 → hOffset を登録、垂直辺 → vOffset を登録
  const cornerMap = new Map();
  const ensureCorner = (hId, vId) => {
    const key = `${hId}:${vId}`;
    if (!cornerMap.has(key)) cornerMap.set(key, { hOffset: null, vOffset: null });
    return cornerMap.get(key);
  };

  for (const p of rawParams) {
    if (!p.isVertical) {
      // 水平辺: axis = 水平CL, start/end = 垂直CL
      ensureCorner(p.axisCLId, p.startCLId).hOffset = p.axisOffset;
      ensureCorner(p.axisCLId, p.endCLId).hOffset   = p.axisOffset;
    } else {
      // 垂直辺: axis = 垂直CL, start/end = 水平CL
      ensureCorner(p.startCLId, p.axisCLId).vOffset = p.axisOffset;
      ensureCorner(p.endCLId,   p.axisCLId).vOffset = p.axisOffset;
    }
  }

  // (axisCLId, axisOffset) でグループ化してマージ
  const groups = new Map();
  for (const p of rawParams) {
    const key = `${p.axisCLId}:${p.axisOffset}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const walls = [];
  for (const [, segs] of groups) {
    const { axisCLId, axisOffset, isVertical } = segs[0];
    const axisCL = getShape(graph, axisCLId);
    if (!axisCL) continue;

    for (const seg of mergeSegments(segs, graph)) {
      const startCL = getShape(graph, seg.startCLId);
      const endCL   = getShape(graph, seg.endCLId);
      if (!startCL || !endCL) continue;

      // コーナーマップから端点オフセットを取得
      let startOffset, endOffset;
      if (!isVertical) {
        // 水平壁: start/end は垂直CL → vOffset を使用
        startOffset = cornerMap.get(`${axisCLId}:${seg.startCLId}`)?.vOffset ?? 0;
        endOffset   = cornerMap.get(`${axisCLId}:${seg.endCLId}`)?.vOffset   ?? 0;
      } else {
        // 垂直壁: start/end は水平CL → hOffset を使用
        startOffset = cornerMap.get(`${seg.startCLId}:${axisCLId}`)?.hOffset ?? 0;
        endOffset   = cornerMap.get(`${seg.endCLId}:${axisCLId}`)?.hOffset   ?? 0;
      }

      // 端点ルール: 軸CLの線分範囲を越える部分ははねだし付きで止める
      const clipped = clipToAxisExtent(axisCL, startCL, startOffset, endCL, endOffset, offset);
      if (!clipped) continue;

      const w = graph.addWall(axisCL, axisOffset, isVertical, startCL, clipped.startOffset, endCL, clipped.endOffset, { isRoomWall: true, wallFinish });
      walls.push(w);
    }
  }

  return walls;
}

/**
 * 外壁ループ（建物外周・中庭境界）から実体としての Wall を生成する。
 *
 * computeExternalEdgeParams が返す axisOffset は常に室内方向を指すため、
 * 外壁本体は `loopType` を問わず常にその逆方向（室外側）に生成する
 * （`outer` = 建物の真の外側 / `courtyard` = 隣接する屋内/吹抜け側）。
 *
 * generateRoomWallsFromOutline と同様にコーナーマップでオフセットを決定し、
 * loopType ごとに閉じたループとして扱う。生成された壁には
 * isRoomWall=true（chamferWalls による再調整を抑止）/ isExteriorWall=true を設定する。
 *
 * stairOpenings（階段の上り口・下り口の開口辺）上のエッジは、courtyard（両側とも部屋）
 * の場合のみ壁を生成しない。outer（外側が未割当＝部屋指定なし）は建物外周のため
 * 開口辺でも壁を残す。
 */
export function generateExteriorWalls(graph, { wallBase = DEFAULT_WALL_BASE, wallFinish = DEFAULT_WALL_FINISH } = {}, stairOpenings = []) {
  const offset = wallBase / 2 + wallFinish;

  const cellToRoom = buildCellToRoom(graph);

  // loopType ごとに符号付きオフセット済みエッジを集約
  const byLoopType = new Map(); // loopType → rawParams[]
  for (const room of graph.rooms) {
    for (const p of computeExternalEdgeParams(room, offset, graph)) {
      const loopType = classifyExteriorEdge(room, p, graph, cellToRoom);
      if (!loopType) continue;
      if (loopType === 'courtyard' && onStairOpening(p, graph, stairOpenings)) continue;

      // 外壁は常に「室外側（室内方向の逆）」に生成する
      // （p.axisOffset は常に室内方向を指すため、outer/courtyard とも反転する）
      const axisOffset = -p.axisOffset;

      if (!byLoopType.has(loopType)) byLoopType.set(loopType, []);
      byLoopType.get(loopType).push({ ...p, axisOffset });
    }
  }

  const walls = [];
  for (const [, rawParams] of byLoopType) {
    // コーナーマップ構築（generateRoomWallsFromOutline と同様）
    const cornerMap = new Map();
    const ensureCorner = (hId, vId) => {
      const key = `${hId}:${vId}`;
      if (!cornerMap.has(key)) cornerMap.set(key, { hOffset: null, vOffset: null });
      return cornerMap.get(key);
    };
    for (const p of rawParams) {
      if (!p.isVertical) {
        ensureCorner(p.axisCLId, p.startCLId).hOffset = p.axisOffset;
        ensureCorner(p.axisCLId, p.endCLId).hOffset   = p.axisOffset;
      } else {
        ensureCorner(p.startCLId, p.axisCLId).vOffset = p.axisOffset;
        ensureCorner(p.endCLId,   p.axisCLId).vOffset = p.axisOffset;
      }
    }

    // (axisCLId, axisOffset) でグループ化してマージ
    const groups = new Map();
    for (const p of rawParams) {
      const key = `${p.axisCLId}:${p.axisOffset}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    for (const [, segs] of groups) {
      const { axisCLId, axisOffset, isVertical } = segs[0];
      const axisCL = getShape(graph, axisCLId);
      if (!axisCL) continue;

      for (const seg of mergeSegments(segs, graph)) {
        const startCL = getShape(graph, seg.startCLId);
        const endCL   = getShape(graph, seg.endCLId);
        if (!startCL || !endCL) continue;

        let startOffset, endOffset;
        if (!isVertical) {
          startOffset = cornerMap.get(`${axisCLId}:${seg.startCLId}`)?.vOffset ?? 0;
          endOffset   = cornerMap.get(`${axisCLId}:${seg.endCLId}`)?.vOffset   ?? 0;
        } else {
          startOffset = cornerMap.get(`${seg.startCLId}:${axisCLId}`)?.hOffset ?? 0;
          endOffset   = cornerMap.get(`${seg.endCLId}:${axisCLId}`)?.hOffset   ?? 0;
        }

        // 端点ルール: 軸CLの線分範囲を越える部分ははねだし付きで止める
        const clipped = clipToAxisExtent(axisCL, startCL, startOffset, endCL, endOffset, offset);
        if (!clipped) continue;

        const w = graph.addWall(axisCL, axisOffset, isVertical, startCL, clipped.startOffset, endCL, clipped.endOffset, {
          isRoomWall: true,
          isExteriorWall: true,
          wallFinish,
        });
        walls.push(w);
      }
    }
  }

  return walls;
}

// ----------------------------------------------------------------
// 下地オーナー解決（下地オーナー壁＋仕上げ薄壁方式）
// ----------------------------------------------------------------

// 同一CL上の壁スパン重なりを「有意」とみなす下限(mm)。clEccentricity.js の
// SPAN_OVERLAP_EPS・stairUnderWalls.js の SKIP_OVERLAP_EPS と同水準
// （浮動小数の丸め・端点接触を誤って有意重なりと判定しない）。
// 3ファイルとも同じ意図の閾値のため、値を変更する場合は3箇所とも揃えること
// （clEccentricity.js:SPAN_OVERLAP_EPS / stairUnderWalls.js:SKIP_OVERLAP_EPS 参照）。
const SPAN_OVERLAP_EPS = 5; // mm

function wallSpan(w) {
  return [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];
}

/**
 * 壁 o の端点（coord1/coord2）のうち value に一致する側の {cl, offset} を返す
 * （分割で生じる新端点を、相手壁の実端点参照＋オフセットへそのまま流用して値を一致させるため）。
 * @returns {{cl:import('@core').Shape, offset:number}|null}
 */
function anchorForValue(o, value, eps) {
  if (Math.abs(o.coord1 - value) <= eps) return { cl: o.clStart, offset: o.startOffset };
  if (Math.abs(o.coord2 - value) <= eps) return { cl: o.clEnd, offset: o.endOffset };
  return null;
}

/**
 * 壁 w（非オーナー候補）を、オーナー壁群 ownerWalls（同一 axisCL）のスパンに対して
 * 「重なる区間＝薄壁（backingDepth=0）」「重ならない区間＝オーナー」に仕分ける。
 * 全区間が同じ扱いなら分割せず w 自身のフィールドを書き換えて返す（null）。
 * 部分重なりがあれば graph.removeShape(w) → graph.addWall で複数本に分割し、
 * 新しい壁の配列を返す（呼び出し側が generatedWallIds を張り替える）。
 *
 * 分割点は必ず ownerWalls のいずれかの端点（coord1/coord2）と一致するため、その壁の
 * clStart/clEnd 参照＋オフセットをそのまま新端点として流用する（座標値を独自に再計算せず
 * 相手の実端点値と完全一致させる）。w 自身の真の両端（分割されない側）は w の元の
 * clStart/clEnd 参照を維持する。
 *
 * @param {object} graph
 * @param {import('@core').Wall} w
 * @param {import('@core').Wall[]} ownerWalls
 * @param {{claimUncovered?: boolean}} [opts]
 *   claimUncovered=true（既定。resolveBackingOwnership が使う——生成直後の壁のフル初期解決）:
 *   重ならない区間は「オーナーの既定式」（backingOffset=0・backingDepth=2*(|axisOffset|-
 *   wallFinish)）で明示し直す。
 *   claimUncovered=false（App.jsx ステップ3の外壁オーナー化パスが使う）: 重ならない区間・
 *   分割で生じる新壁のうち非covered分は一切変更しない——このパス以前に確定済みの
 *   backingOffset/backingDepth/finishSide（ステップ2の所有権解決・ステップ2bのCL偏芯）を
 *   そのまま継承する。外壁パスは「外壁スパンに重なる区間を薄壁化する」ことだけを担い、
 *   既に確定済みの内周壁の解決を上書きしない（F1: 上書きすると偏芯結果が破壊される）。
 * @returns {import('@core').Wall[]|null}
 */
function splitWallByOwnership(graph, w, ownerWalls, { claimUncovered = true } = {}) {
  const [wLo, wHi] = wallSpan(w);
  const ownerSpans = ownerWalls.map(wallSpan);

  // 切断点候補: 両端 + オーナー壁群の端点のうち w の内部にあるもの。
  const rawCuts = [wLo, wHi];
  for (const [a, b] of ownerSpans) {
    if (a > wLo + SPAN_OVERLAP_EPS && a < wHi - SPAN_OVERLAP_EPS) rawCuts.push(a);
    if (b > wLo + SPAN_OVERLAP_EPS && b < wHi - SPAN_OVERLAP_EPS) rawCuts.push(b);
  }
  const sortedCuts = [...new Set(rawCuts)].sort((a, b) => a - b);

  // 近接する切断点（間隔が SPAN_OVERLAP_EPS 以下）を1点に統合する: 統合しないと、その間の
  // 極小区間が「有意な長さなし」として後段で捨てられ、分割壁の間に最大 EPS 分の隙間が
  // できてしまう（区間を捨てるのではなく点を間引くことでこれを避ける）。
  const dedupCuts = [];
  for (const v of sortedCuts) {
    if (dedupCuts.length > 0 && v - dedupCuts[dedupCuts.length - 1] <= SPAN_OVERLAP_EPS) continue;
    dedupCuts.push(v);
  }

  // 開口（建具・窓）を跨ぐ切断は行わない: findHostWall は開口のスパン全体が1本の壁に
  // 収まることを要求するため、開口の内部で壁を分割すると開口がどちらの新壁にもホストされず
  // 孤立してしまう。開口の内部（両端は除く＝開口の境界での分割は許容）に落ちる切断点だけを
  // 除去する（両端 wLo/wHi は常に残す）。
  const openings = graph.openings.filter(o => o.isVertical === w.isVertical && o.axisCL.id === w.axisCL.id);
  const finalCuts = dedupCuts.filter(v =>
    v === wLo || v === wHi ||
    !openings.some(o => o.coord1 < v - SPAN_OVERLAP_EPS && v + SPAN_OVERLAP_EPS < o.coord2));

  // 区間ごとの covered 判定: 区間全体でオーナースパンとの重なりが有意にあれば covered と
  // みなす（中点だけでなく区間内のどこかで重なれば covered）。開口を跨ぐ切断点を間引いた
  // 結果、1区間が本来は covered/非covered に分かれるべき混在区間になり得るため、その場合は
  // 安全側で「一部でも covered なら区間全体を薄壁」に倒す（下地の二重化よりギャップの方が
  // 実害が小さいという判断）。
  const overlapsAny = (lo, hi) => ownerSpans.some(([c1, c2]) => Math.min(hi, c2) - Math.max(lo, c1) > SPAN_OVERLAP_EPS);

  const subs = [];
  for (let i = 0; i < finalCuts.length - 1; i++) {
    const lo = finalCuts[i], hi = finalCuts[i + 1];
    if (hi - lo <= SPAN_OVERLAP_EPS) continue; // dedup済みのため通常到達しない（安全側の残置）
    subs.push({ lo, hi, covered: overlapsAny(lo, hi) });
  }
  // 隣接する同タグ区間はマージする（分割数を必要最小限にする）
  const merged = [];
  for (const s of subs) {
    const last = merged[merged.length - 1];
    if (last && last.covered === s.covered) last.hi = s.hi;
    else merged.push({ ...s });
  }
  if (merged.length === 0) return null; // 区間が完全に消えた（到達しない想定の安全側）

  // オーナー側フィールド（claimUncovered=true の既定式でのみ使う）。finishSide は既存値を
  // 優先する——axisOffset===0（CL偏芯の仕上げ面合わせで面がCL上に一致したケース）では
  // sign(axisOffset) が0になり側を導出できないため、既に確定済みの finishSide を壊さない。
  const sign = w.finishSide ?? (Math.sign(w.axisOffset) || 1);
  const ownerBackingDepth = 2 * (Math.abs(w.axisOffset) - w.wallFinish);
  const fieldsFor = (covered) => claimUncovered
    ? { backingOffset: 0, backingDepth: covered ? 0 : ownerBackingDepth, finishSide: sign }
    : { backingOffset: w.backingOffset, backingDepth: covered ? 0 : w.backingDepth, finishSide: w.finishSide };

  if (merged.length === 1) {
    const covered = merged[0].covered;
    if (!claimUncovered && !covered) return null; // 何もしない（既存の解決結果をそのまま保持）
    const f = fieldsFor(covered);
    w.backingOffset = f.backingOffset; w.backingDepth = f.backingDepth; w.finishSide = f.finishSide;
    return null;
  }

  // 部分重なり: 壁を分割する。w の真の両端（分割されない側）は元の clStart/clEnd を保つ。
  const origLoRef = w.coord1 <= w.coord2 ? { cl: w.clStart, offset: w.startOffset } : { cl: w.clEnd, offset: w.endOffset };
  const origHiRef = w.coord1 <= w.coord2 ? { cl: w.clEnd, offset: w.endOffset } : { cl: w.clStart, offset: w.startOffset };
  const refAt = (value) => {
    if (Math.abs(value - wLo) <= SPAN_OVERLAP_EPS) return origLoRef;
    if (Math.abs(value - wHi) <= SPAN_OVERLAP_EPS) return origHiRef;
    for (const o of ownerWalls) {
      const a = anchorForValue(o, value, SPAN_OVERLAP_EPS);
      if (a) return a;
    }
    return null;
  };

  // 2パス化: 先に全区間の端点参照を解決し切ってから addWall する。1つでも解決できなければ
  // graph を一切変更せずに分割を断念する（addWall 済みの壁だけがグラフに残る・元の壁が
  // 消えたまま新壁が無い、といった中途半端な状態を作らない）。
  const refs = merged.map(s => ({ s, startRef: refAt(s.lo), endRef: refAt(s.hi) }));
  if (refs.some(r => !r.startRef || !r.endRef)) {
    if (!claimUncovered) return null; // 既存の解決結果を保持（何もしない）
    // フォールバック（安全側）: 分割せず、重なりが1か所でもあれば薄壁として扱う
    const anyCovered = merged.some(m => m.covered);
    w.backingOffset = 0;
    w.backingDepth  = anyCovered ? 0 : ownerBackingDepth;
    w.finishSide    = sign;
    return null;
  }

  const newWalls = refs.map(({ s, startRef, endRef }) =>
    graph.addWall(w.axisCL, w.axisOffset, w.isVertical, startRef.cl, startRef.offset, endRef.cl, endRef.offset, {
      isRoomWall:     w.isRoomWall,
      isExteriorWall: w.isExteriorWall,
      wallFinish:     w.wallFinish,
      ...fieldsFor(s.covered),
    }));

  graph.removeShape(w.id);
  return newWalls;
}

/**
 * ownerWalls を下地オーナーとして確定し（setOwnerFields=true の既定時。backingOffset=0・
 * backingDepth=既定式・finishSide=既存値優先）、challengerWalls のうち ownerWalls と同一
 * axisCL・スパンが重なる区間を薄壁（backingDepth=0）にする（部分重なりは
 * splitWallByOwnership で分割）。どちらが「オーナー」かは呼び出し側が決める
 * （+側／外壁など）——ここでは判定しない。
 *
 * challengerWalls のうち、どの axisCL にも ownerWalls が存在しない壁は一切変更しない
 * （既存の解決結果——他パスが既に付けた backingOffset/backingDepth/finishSide や、
 * 生成時の既定値——をそのまま保持する）。対抗するオーナーが無い CL の解決は呼び出し側
 * （resolveBackingOwnership 等）の責務であり、ここで「対抗が無ければ自分がオーナー」と
 * 決めてしまうと、複数の所有権パスを順に適用する構成（例: 内周壁パス→外壁パス）で、
 * 先のパスが既に確定した非オーナー壁を後のパスが誤って再びオーナーへ戻してしまう
 * （そのCLに後のパスのオーナー種別が存在しないだけで、内容としては無関係な CL のため）。
 *
 * @param {object} graph
 * @param {import('@core').Wall[]} ownerWalls
 * @param {import('@core').Wall[]} challengerWalls
 * @param {{setOwnerFields?: boolean, claimUncovered?: boolean}} [opts]
 *   setOwnerFields=false: ownerWalls 自身のフィールドを一切書き換えない（App.jsx ステップ3の
 *   外壁オーナー化パスが使う——外壁は backingRange の既存フォールバック式で既に正しい下地帯を
 *   返すため明示不要。明示すると materialRange が既定式ぶん広がる副作用がある。F1/F10参照）。
 *   claimUncovered: splitWallByOwnership へそのまま渡す（同関数のdocを参照）。
 * @returns {Map<string, import('@core').Wall[]>} 分割が起きた壁の 旧ID→新壁群（呼び出し側が
 *   generatedWallIds を張り替える。分割が無かった壁は含まれない）
 */
export function applyBackingOwnership(graph, ownerWalls, challengerWalls, { setOwnerFields = true, claimUncovered = true } = {}) {
  if (setOwnerFields) {
    for (const w of ownerWalls) {
      if (w.wallFinish == null) continue; // 手動壁等（生成時確定値が無い）は対象外
      w.backingOffset = 0;
      w.backingDepth  = 2 * (Math.abs(w.axisOffset) - w.wallFinish);
      // finishSide は既存値を優先する（axisOffset===0＝CL偏芯の仕上げ面合わせでは
      // sign(axisOffset)が0になり側を導出できないため、既に確定済みの値を壊さない）。
      w.finishSide    = w.finishSide ?? (Math.sign(w.axisOffset) || 1);
    }
  }

  const ownersByCL = new Map(); // axisCLId → owner壁[]
  for (const w of ownerWalls) {
    if (w.wallFinish == null) continue;
    if (!ownersByCL.has(w.axisCL.id)) ownersByCL.set(w.axisCL.id, []);
    ownersByCL.get(w.axisCL.id).push(w);
  }

  const splitMap = new Map();
  for (const w of challengerWalls) {
    if (w.wallFinish == null) continue;
    const owners = ownersByCL.get(w.axisCL.id);
    if (!owners || owners.length === 0) continue; // 対抗オーナーが無いCL＝このパスの対象外
    const news = splitWallByOwnership(graph, w, owners, { claimUncovered });
    if (news) splitMap.set(w.id, news);
  }
  return splitMap;
}

/**
 * 同一CL上の下地（間柱帯）を1つに統一する（下地オーナー壁＋仕上げ薄壁方式）。
 * walls は今回生成した内周壁全体（複数Roomにわたる。階段ペアRoom・階段吹抜けの壁も含む）。
 *
 * オーナー規則: axisCL・スパン単位で「＋側（axisOffsetが正＝座標値が増える側）の壁が
 * 常にオーナー。−側の壁は、＋側の壁と重ならないサブ区間のみオーナー」。生成直後は
 * axisOffset = ±(wallBase/2+wallFinish) の対称式のため、符号＝側が成立する
 * （CL偏芯適用前のこの時点でのみ有効な前提。適用後は clEccentricity.js 側の isOwner が
 * 別途スパン重なりで再判定する）。＋側同士のスパン重なり（同じ側に複数Roomの壁が並んで
 * 重複するケース）は判定しない——Room.cells は部屋間で排他（同じセルを2部屋が持てない）
 * ため、同一CL・同一側に生成される壁のスパンは重ならない前提が成立する。
 *
 * @param {object} graph
 * @param {import('@core').Wall[]} walls
 * @returns {Map<string, import('@core').Wall[]>} applyBackingOwnership と同形
 */
export function resolveBackingOwnership(graph, walls) {
  const groups = new Map(); // axisCLId → walls[]
  for (const w of walls) {
    if (w.wallFinish == null) continue;
    if (!groups.has(w.axisCL.id)) groups.set(w.axisCL.id, []);
    groups.get(w.axisCL.id).push(w);
  }

  const splitMap = new Map();
  for (const [, group] of groups) {
    const posWalls = group.filter(w => Math.sign(w.axisOffset) > 0);
    const negWalls = group.filter(w => Math.sign(w.axisOffset) < 0);
    if (posWalls.length === 0) {
      // − 側だけのグループ（対抗する＋側が今回の生成分に無い＝このCLでは − 側が唯一の壁）:
      // − 側全体をオーナーとして明示する（applyBackingOwnership はオーナー無しCLのchallengerに
      // 触れない設計のため、この解決はここで直接行う）。
      for (const w of negWalls) {
        if (w.wallFinish == null) continue;
        w.backingOffset = 0;
        w.backingDepth  = 2 * (Math.abs(w.axisOffset) - w.wallFinish);
        // finishSide は既存値を優先する（axisOffset===0では側を導出できないため）。
        w.finishSide    = w.finishSide ?? (Math.sign(w.axisOffset) || 1);
      }
      continue;
    }
    for (const [id, news] of applyBackingOwnership(graph, posWalls, negWalls)) splitMap.set(id, news);
  }
  return splitMap;
}

/**
 * Wall オブジェクトから undo/redo 用スナップショットを作成する。
 * CL は ID 参照で保持し、復元時に graph.shapeMap から解決する。
 */
export function snapshotWall(w) {
  return {
    id:          w.id,
    axisCLId:    w.axisCL.id,
    axisOffset:  w.axisOffset,
    isVertical:  w.isVertical,
    startCLId:   w.clStart.id,
    startOffset: w.startOffset,
    endCLId:     w.clEnd.id,
    endOffset:   w.endOffset,
    isRoomWall:  w.isRoomWall,
    isExteriorWall: w.isExteriorWall,
    wallFinish:  w.wallFinish,
    backingOffset: w.backingOffset,
    backingDepth:  w.backingDepth,
    finishSide:  w.finishSide,
  };
}

/**
 * スナップショットから壁を graph に再追加する（undo/redo 用）。
 * 同一 ID で再生成するため undo → redo → undo のサイクルが正しく機能する。
 */
export function restoreWallsFromSnapshots(graph, snapshots) {
  const walls = [];
  for (const s of snapshots) {
    const axisCL  = getShape(graph, s.axisCLId);
    const startCL = getShape(graph, s.startCLId);
    const endCL   = getShape(graph, s.endCLId);
    if (!axisCL || !startCL || !endCL) continue;
    const props = {};
    if (s.isRoomWall)     props.isRoomWall     = true;
    if (s.isExteriorWall) props.isExteriorWall = true;
    if (s.wallFinish != null) props.wallFinish = s.wallFinish;
    if (s.backingOffset != null) props.backingOffset = s.backingOffset;
    if (s.backingDepth  != null) props.backingDepth  = s.backingDepth;
    if (s.finishSide    != null) props.finishSide    = s.finishSide;
    const w = graph.addWall(axisCL, s.axisOffset, s.isVertical, startCL, s.startOffset ?? 0, endCL, s.endOffset ?? 0, props, s.id);
    walls.push(w);
  }
  return walls;
}
