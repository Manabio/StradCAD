/**
 * 空間セル索引（展開図一般化Phase 1。設計 `.claude/elevation-redesign.md` §5.2/§5.3）。
 *
 * 「(層, 世界x, 世界y) → そのセルの所有Room・床天井」を返す純モジュール。
 * `section/sectionProbe.js` の `makeProbeContext` にあった床天井の式（`floorZOf`/`chOf`）は
 * ここへ移設した——2箇所に置くと「帯のローカルz=0 ≡ その帯の部屋の実効FL」という不変条件
 * （`elevation-model.md`「不変条件: 帯のローカル z=0 ≡ その帯の部屋の実効FL」節）が将来ズレる
 * 危険があるため、式の実体は本ファイルのみに置き、`makeProbeContext`は本索引を内包して
 * 薄いラッパ（`floorZOf`/`chOf`という対外契約はそのまま）として振る舞う。
 *
 * 新規依存はゼロ——材料は既存の純関数のみ（`finish/edgeClassify.js` buildCellToRoom、
 * `finish/gridCells.js` worldToCell、`finish/roomMetrics.js` roomCeilingHeight、
 * `graph.effectiveFloorLevel`）。
 *
 * `componentId`（同一層内で全高の壁に遮られずに隣接するセルの連結成分）と`cellsAlong`
 * （列に沿ったヒット列）はPhase 2以降——本Phaseでは実装しない（設計R4「誰も読まない」の
 * 通り、実装コストに見合う消費者がまだ無いため）。
 */
import { buildCellToRoom } from '../../finish/edgeClassify.js';
import { worldToCell } from '../../finish/gridCells.js';
import { roomCeilingHeight } from '../../finish/roomMetrics.js';

/**
 * @typedef {object} SpaceCell
 * @property {object|null} room - そのセルの所有Room（未割当領域はnull）
 * @property {number} floorZ - 絶対z（帯のfloorOffsetMm差し引き後）
 * @property {number|null} ceilZ - 絶対z。room無しはnull（詳細はcellAtのコメント参照）
 *
 * layerは意図的に持たせない——呼び出し側は自分が渡したlayerを知っており、layer
 * （PlanGraph全体）を抱えるとassert失敗時のnode:assert差分表示がグラフを走査し
 * 10秒以上かかる（QA実測。外すと数ms）。
 */

/**
 * layers（各{graph,floorZMm,role}）から空間セル索引を組む。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @param {{floorOffsetMm?:number}} [opts] - floorOffsetMmは帯のz原点差し引き
 *   （elevationBand.jsのbandFloorOffsetMmが単一情報源。未指定=0=階のdatum基準のまま）。
 * @returns {{
 *   cellAt:(layer:object, worldX:number, worldY:number)=>SpaceCell|null,
 *   cellToRoomFor:(layer:object)=>Map,
 *   cellToRoomByLayer:Map,
 *   floorZFor:(room:object|null, layer:object)=>number,
 *   chFor:(room:object|null, graph:object)=>number|null,
 * }}
 */
export function buildSpaceIndex(layers, opts = {}) {
  const floorOffsetMm = opts.floorOffsetMm ?? 0;
  const cellToRoomByLayer = new Map(); // layer -> Map<cellKey, Room>（呼び出し側から参照可能に公開）
  const cellToRoomByGraph = new Map(); // graph -> Map<cellKey, Room>（実体はgraph単位で共有）
  const chCacheByGraph = new Map();    // graph -> Map<room.id, mm>

  function cellToRoomFor(layer) {
    const cached = cellToRoomByLayer.get(layer);
    if (cached) return cached;
    let byGraph = cellToRoomByGraph.get(layer.graph);
    if (!byGraph) {
      byGraph = buildCellToRoom(layer.graph);
      cellToRoomByGraph.set(layer.graph, byGraph);
    }
    cellToRoomByLayer.set(layer, byGraph);
    return byGraph;
  }
  for (const layer of layers ?? []) cellToRoomFor(layer);

  // **帯のローカルz=0 ≡ その帯の部屋の実効FL**（elevationBand.jsのbandFloorOffsetMm。
  // finalizeBandの平行移動と対の不変条件）。ここを階のdatum基準のままにすると、実効FL≠0の
  // 部屋の帯だけエンジンの床zがfloorOffsetぶんズレる（実機「11'」B1/A2）。
  // layer.floorZMm自体は触らない——壁・断面のzまで動くため。
  function floorZFor(room, layer) {
    if (!room) return layer.floorZMm - floorOffsetMm; // 部屋外（所有Room不明）はlayer自身の基準面へ
    const graph = layer.graph;
    return layer.floorZMm + graph.effectiveFloorLevel(room) - graph.floorDatum - floorOffsetMm;
  }

  function chFor(room, graph) {
    if (!room) return null;
    let cache = chCacheByGraph.get(graph);
    if (!cache) { cache = new Map(); chCacheByGraph.set(graph, cache); }
    if (!cache.has(room.id)) cache.set(room.id, roomCeilingHeight(graph, room).mm);
    return cache.get(room.id);
  }

  // cellAt: (layer, worldX, worldY) → SpaceCell | null。
  // グリッドにセルが無い（layer.graphが無い・格子外）位置はnull——「セルが1つも無い」ことと
  // 「セルはあるが部屋が未割当」（room:null）は区別する（後者はfloorZ/ceilZの解決余地がある）。
  // room=nullのceilZはnull。本番の層スタック`buildLayerStack`（sectionProbe.js:532-543）は
  // cut依存の`fallbackCeilZ`（sectionProbe.js:319-323）を使うため、差し替えにはcutか既定CHを
  // 渡す引数が要る（本Phaseでは未対応）。
  function cellAt(layer, worldX, worldY) {
    if (!layer?.graph) return null;
    const cell = worldToCell(worldX, worldY, layer.graph);
    if (!cell) return null;
    const room = cellToRoomFor(layer).get(cell.key) ?? null;
    const floorZ = floorZFor(room, layer);
    const ch = chFor(room, layer.graph);
    const ceilZ = room ? floorZ + ch : null;
    return { room, floorZ, ceilZ };
  }

  return { cellAt, cellToRoomFor, cellToRoomByLayer, floorZFor, chFor };
}
