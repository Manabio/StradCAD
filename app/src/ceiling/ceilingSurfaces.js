/**
 * 天井面の算出（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏モードの見上げ（plan/planSolids.js の ceiling 立体）が使う。部屋ごとに「セル矩形の和」と「天井の高さ」を返す。
 *
 * 天井を持つ部屋＝屋内（kind === INTERIOR）かつ feature なし。吹抜け・階段・階段吹抜け・屋根・昇降路・未定義は天井を持たない。
 * セルの帰属は buildCellToRoom（部分指定の子が親のセルを上書きする。床立体 floorSolidOf と同じセル→矩形の口）。
 * 述語 roomHasCeiling は ceilingOwners.js（選択の索引）と共有。索引そのものへの一本化は見送り: 実データの --up の合計が 340→337 本に変わった
 * （buildCellToRoom は天井を持たない部屋〔階段ペア・吹抜け〕も帰属を取り、その上の屋内部屋の天井を落とす。索引は取らない）。
 * 高さ zMm＝層の FL からの天井面の高さ＝部屋の床段差（effectiveFloorLevel(room)−effectiveFloorLevel(null)）＋roomCeilingHeight(graph, room).mm。
 * 数値化できない欄は既定天井高（isFallback）の mm を使う。部分指定の子（自分の CH 欄なし）は CH が床段差で補正されるので親と同じ天井面になる。
 * 壁の上端（planSolids.js wallCeilZ）は床段差を含めない（別系統。ここでは裁定により含める）。
 */
import { roomHasCeiling } from './ceilingOwners.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { cellBoundsFromKey, refreshCells } from '../finish/gridCells.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { normalizeRect, isValidRect } from '../plan/planGeometry.js';

/** 部屋が天井を持つか（唯一の述語）。 */
export { roomHasCeiling };

const byRow = (a, b) => a.y1 - b.y1 || a.x1 - b.x1;

/**
 * 天井を持つ部屋ごとの天井面。セルが1つも解決できない部屋は出さない。順序は graph.rooms の順、矩形は (y1, x1) 順（決定的）。
 *
 * 天井区画（S5。Room.ceilingZones）がある部屋は「残り（zoneId: null。部屋の CH）→ 区画の配列順」の面に分ける。区画のセルは
 * refreshCells で今の分割に展開し、buildCellToRoom がこの部屋に帰属させるセルだけを採る（Z1。区画の旧キーが解けない・他の部屋に取られた
 * セルは捨てる＝部屋の CH に戻る）。同じセルが複数の区画にあれば先勝ち。空の面は出さない。区画の無い部屋の出力は区画導入前と同じ（zoneId は null）。
 * 区画の zMm＝床段差＋(heightMm ?? 部屋の CH)。
 * @param {object} graph
 * @returns {Array<{roomId: string, zoneId: string|null, rects: Array<{x1:number,y1:number,x2:number,y2:number}>, zMm: number}>}
 */
export function ceilingSurfacesOf(graph) {
  if (!graph) return [];
  const cellToRoom = buildCellToRoom(graph);
  const rectsByRoom = new Map(); // room → Map<セルキー, 矩形>
  for (const [key, room] of cellToRoom) {
    if (!roomHasCeiling(room)) continue;
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    const rect = normalizeRect(b);
    if (!isValidRect(rect)) continue;
    if (!rectsByRoom.has(room)) rectsByRoom.set(room, new Map());
    rectsByRoom.get(room).set(key, rect);
  }
  const out = [];
  for (const room of graph.rooms) {
    const rectByKey = rectsByRoom.get(room);
    if (!rectByKey) continue;
    // 床段差（階基準 floorDatum からの差）＋CH。子の CH を床段差で補正する roomCeilingHeight と同じ基準
    const floorStep = graph.effectiveFloorLevel(room) - graph.effectiveFloorLevel(null);
    const roomZ = floorStep + roomCeilingHeight(graph, room).mm;
    const taken = new Set();
    const zoneFaces = [];
    for (const zone of room.ceilingZones) {
      const rects = [];
      for (const key of refreshCells(new Set(zone.cells), graph)) {
        if (taken.has(key) || !rectByKey.has(key)) continue;
        taken.add(key);
        rects.push(rectByKey.get(key));
      }
      if (rects.length === 0) continue;
      rects.sort(byRow);
      zoneFaces.push({ roomId: room.id, zoneId: zone.id, rects, zMm: floorStep + (zone.heightMm ?? roomCeilingHeight(graph, room).mm) });
    }
    const rest = [];
    for (const [key, rect] of rectByKey) if (!taken.has(key)) rest.push(rect);
    if (rest.length > 0) {
      rest.sort(byRow);
      out.push({ roomId: room.id, zoneId: null, rects: rest, zMm: roomZ });
    }
    out.push(...zoneFaces);
  }
  return out;
}
