// ================================================================
// 境界エッジの列挙と境界マスター選定（仕上げモードの純関数群）
//
// 境界マスター選定表（CLAUDE.md データモデル参照）を実装する。Edge クラス（core.js）はデータのみを持ち、
// 判定・選定はここ（仕上げモードの function）で行う。
//
//   computeNamedBoundaryEdges(graph) → Set<edgeKey>
//       名前付き部屋のセル境界セグメントを edgeKey 集合として列挙（差分追跡の入力）。
//   selectBoundaryMaster(edge, graph, cellToRoom) → masterType | null
//       両側の領域（無名屋外/有名屋外/屋内）と軸線の線種から masterType を導出。
//
// ※ masterType は BOUNDARY_MASTERS（boundaryMasters.js）のキー文字列。
//    選定はトポロジー論理のみで、材データには依存しない。
// ================================================================

import { CenterLineType, RoomKind, Discipline, edgeKey } from '@core';
import { worldToCell, refreshCells } from './gridCells.js';

// 隣接セル判定時、境界線からこの距離(mm)だけ内側をサンプリングする。
const ADJACENT_SAMPLE_EPS = 10; // mm

// struct CL は _structGraph.shapeMap に格納されるため両方を検索する。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

// ----------------------------------------------------------------
// 領域・線種の分類
// ----------------------------------------------------------------

const REGION = Object.freeze({
  ANON_EXTERIOR:  'anonExterior',  // 無名屋外（部屋なし＝建物外部）
  NAMED_EXTERIOR: 'namedExterior', // 有名屋外（RoomKind.EXTERIOR）
  INTERIOR:       'interior',      // 屋内（kind !== EXTERIOR。feature の階段・吹抜けは無関係）
});

function regionOf(room) {
  if (!room) return REGION.ANON_EXTERIOR;
  return room.kind === RoomKind.EXTERIOR ? REGION.NAMED_EXTERIOR : REGION.INTERIOR;
}

/** 軸CLの線種を分類する（補助線 / 中心線 / 通り芯）。 */
export function classifyAxisLineType(cl) {
  if (cl.discipline === Discipline.STRUCT && cl.labeled) return '通り芯';
  if (cl.lineType === 'dashed') return '補助線';
  return '中心線';
}

// ----------------------------------------------------------------
// エッジ両側の部屋を取得
// ----------------------------------------------------------------

/**
 * エッジの幾何と両側の部屋を返す（軸CLの ±ADJACENT_SAMPLE_EPS をセグメント中点でサンプリング）。
 * @param {import('@core').Edge|string|{axisCLId,startCLId,endCLId}} edge
 * @returns {{ axisCL, startCL, endCL, isVertical, axisVal, lo, hi, roomNeg, roomPos } | null}
 *   roomNeg = 軸の負側(−eps), roomPos = 正側(+eps)。room は Room | null（null = 無名屋外）
 */
export function edgeGeometry(edge, graph, cellToRoom) {
  const [axisCLId, startCLId, endCLId] = typeof edge === 'string'
    ? edge.split(':')
    : [edge.axisCLId, edge.startCLId, edge.endCLId];

  const axisCL  = getShape(graph, axisCLId);
  const startCL = getShape(graph, startCLId);
  const endCL   = getShape(graph, endCLId);
  if (!axisCL || !startCL || !endCL) return null;

  const isVertical = axisCL.centerLineType === CenterLineType.VERTICAL;
  const axisVal = axisCL.value;
  const lo  = Math.min(startCL.value, endCL.value);
  const hi  = Math.max(startCL.value, endCL.value);
  const mid = (lo + hi) / 2;

  const sample = (off) => isVertical
    ? worldToCell(axisVal + off, mid, graph)
    : worldToCell(mid, axisVal + off, graph);

  const cellNeg = sample(-ADJACENT_SAMPLE_EPS);
  const cellPos = sample(+ADJACENT_SAMPLE_EPS);
  const roomNeg = cellNeg ? (cellToRoom.get(cellNeg.key) ?? null) : null;
  const roomPos = cellPos ? (cellToRoom.get(cellPos.key) ?? null) : null;
  return { axisCL, startCL, endCL, isVertical, axisVal, lo, hi, roomNeg, roomPos };
}

// ----------------------------------------------------------------
// 公開 API
// ----------------------------------------------------------------

/**
 * cellKey → Room の索引を作る。
 * room.cells は部屋指定時点のグリッド分割を凍結したキーであり、後から領域内部に
 * 区切りCLが追加されると現在のキーと一致しなくなるため、refreshCells で
 * 現在のグリッド分割に展開してから索引化する。
 */
export function buildCellToRoom(graph) {
  const m = new Map();
  for (const room of graph.rooms) {
    for (const key of refreshCells(room.cells, graph)) m.set(key, room);
  }
  return m;
}

/**
 * 名前付き部屋のセル境界セグメントを edgeKey 集合として列挙する。
 * 各セルの4辺を走査し、端点CLを value 昇順に正規化して重複排除する。
 * （部屋の命名でエッジが生じる。両側が同一部屋の内部CLも含む。）
 */
export function computeNamedBoundaryEdges(graph) {
  const keys = new Set();
  for (const room of graph.rooms) {
    if (!room.name) continue;
    for (const cellKey of room.cells) {
      const [L, T, R, B] = cellKey.split(':');
      const add = (axisId, sId, eId) => {
        const a = getShape(graph, axisId);
        const s = getShape(graph, sId);
        const e = getShape(graph, eId);
        if (!a || !s || !e) return;
        const [s2, e2] = s.value <= e.value ? [sId, eId] : [eId, sId];
        keys.add(edgeKey(axisId, s2, e2));
      };
      add(L, T, B); // 左辺（垂直CL L、上下の水平CL）
      add(R, T, B); // 右辺
      add(T, L, R); // 上辺（水平CL T、左右の垂直CL）
      add(B, L, R); // 下辺
    }
  }
  return keys;
}

/**
 * 境界マスターを選定する（両側の領域 × 軸線の線種 × 床レベル差の表）。
 * @param {import('@core').Edge | string} edge  Edge インスタンスまたは edgeKey 文字列
 * @param {object} graph
 * @param {Map<string, import('@core').Room>} cellToRoom  buildCellToRoom の結果
 * @returns {string|null} BOUNDARY_MASTERS のキー | null（対象外）
 */
export function selectBoundaryMaster(edge, graph, cellToRoom) {
  const geo = edgeGeometry(edge, graph, cellToRoom);
  if (!geo) return null;
  const { roomNeg: roomA, roomPos: roomB, axisCL } = geo;

  // 同一部屋（両側が同じ部屋）→ 未定（目地 / 下がり壁）
  if (roomA && roomB && roomA.id === roomB.id) return 'UNDEFINED';

  const A = regionOf(roomA);
  const B = regionOf(roomB);
  const pair = (x, y) => (A === x && B === y) || (A === y && B === x);

  if (pair(REGION.INTERIOR, REGION.INTERIOR)) {
    // 別部屋。レベル差があれば段差、なければ内壁。
    return Math.abs(graph.floorLevelDiff(roomA, roomB)) > 0 ? 'STEP' : 'INTERIOR_WALL';
  }
  if (pair(REGION.INTERIOR, REGION.ANON_EXTERIOR))  return 'EXTERIOR_WALL';
  if (pair(REGION.INTERIOR, REGION.NAMED_EXTERIOR)) return 'INNER_OUTER_WALL';
  if (pair(REGION.NAMED_EXTERIOR, REGION.ANON_EXTERIOR)) {
    return classifyAxisLineType(axisCL) === '補助線' ? 'OUTDOOR_FACILITY' : 'CANTILEVER_WALL';
  }
  if (pair(REGION.NAMED_EXTERIOR, REGION.NAMED_EXTERIOR)) return 'OUTDOOR_FACILITY'; // 要検討
  if (A === REGION.ANON_EXTERIOR && B === REGION.ANON_EXTERIOR) return null; // 外×外（通常発生しない）
  return 'EXTERIOR_WALL'; // その他（半面未定義等）暫定
}

// ----------------------------------------------------------------
// トポロジー差分同期（モード境界で実行）
// ----------------------------------------------------------------

/** edgeMap を JSON 比較可能な決定的スナップショットにする（undo 用）。 */
export function snapshotEdges(graph) {
  return graph.edges
    .map(e => ({
      key:        e.key,
      masterType: e.masterType ?? null,
      overrides:  [...e.overrides].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** スナップショットから edgeMap を復元する（undo/redo 用。action メソッドのみ呼ぶ）。 */
export function restoreEdges(graph, snaps) {
  for (const key of [...graph.edgeMap.keys()]) graph.removeEdge(key);
  for (const s of snaps) graph.addEdge(s.key, s.masterType, s.overrides);
}

/**
 * 名前付き部屋のトポロジーに edgeMap を一致させる。
 *   消えたエッジ : 削除
 *   新規エッジ   : 生成（masterType を導出）
 *   維持エッジ   : masterType を再導出（overrides は保持）
 */
export function syncEdgesFromTopology(graph) {
  const desired    = computeNamedBoundaryEdges(graph);
  const cellToRoom = buildCellToRoom(graph);

  for (const key of [...graph.edgeMap.keys()]) {
    if (!desired.has(key)) graph.removeEdge(key);
  }
  for (const key of desired) {
    const type     = selectBoundaryMaster(key, graph, cellToRoom);
    const existing = graph.getEdge(key);
    if (existing) existing.setMasterType(type);
    else          graph.addEdge(key, type);
  }
}
