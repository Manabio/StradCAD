/**
 * 天井面の算出（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏モードの見上げ（plan/planSolids.js の ceiling 立体）が使う。部屋ごとに「セル矩形の和」と「天井の高さ」を返す。
 *
 * 天井を持つ部屋＝屋内（kind === INTERIOR）かつ feature なし。吹抜け・階段・階段吹抜け・屋根・昇降路・未定義は天井を持たない。
 * セルの帰属は選択と同じ所属索引（ceilingOwners.js ceilingCellOwnersOf。親と部分指定の優先は並び順に依存しない〔部分指定どうしが同じセルを持つときだけ部屋順の先勝ち〕。S9・裁定 2026-10-10）:
 * kind 'room' のセル→その部屋の面、kind 'stair' のセル→対の部屋（stair.roomId）の区画の面だけ。索引に無いセルは面にならない。
 * 高さ zMm＝層の FL からの天井面の高さ＝部屋の床段差（effectiveFloorLevel(room)−effectiveFloorLevel(null)）＋roomCeilingHeight(graph, room).mm。
 * 数値化できない欄は既定天井高（isFallback）の mm を使う。部分指定の子（自分の CH 欄なし）は CH が床段差で補正されるので親と同じ天井面になる。
 * 壁の上端（planSolids.js wallCeilZ）は床段差を含めない（別系統。ここでは裁定により含める）。
 */
import { CeilingShape } from '../core/constants.js';
import { roomHasCeiling, ceilingCellOwnersOf } from './ceilingOwners.js';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { normalizeRect, isValidRect } from '../plan/planGeometry.js';

/** 部屋が天井を持つか（唯一の述語）。 */
export { roomHasCeiling };

const byRow = (a, b) => a.y1 - b.y1 || a.x1 - b.x1;

/**
 * 天井を持つ部屋ごとの天井面。セルが1つも解決できない部屋は出さない。順序は graph.rooms の順、矩形は (y1, x1) 順（決定的）。
 *
 * 天井区画（S5。Room.ceilingZones）がある部屋は「残り（zoneId: null。部屋の CH）→ 区画の配列順」の面に分ける。区画のセルは
 * refreshCells で今の分割に展開し、所属索引（ceilingCellOwnersOf）がこの部屋に帰属させるセルだけを採る（Z1。区画の旧キーが解けない・他の部屋に取られた
 * セルは捨てる＝部屋の CH に戻る）。同じセルが複数の区画にあれば先勝ち。空の面は出さない。区画の無い部屋の出力は区画導入前と同じ（zoneId は null）。
 * 階段の対の部屋（stair.roomId。feature STAIR で roomHasCeiling は偽）は、stairHasCeiling(graph, stair) が真で区画を持つときだけ、
 * 区画の面を出す（S6b。区画のセルのうち所属索引（ceilingCellOwnersOf）が階段所属としてその部屋に帰属させるセルだけ＝階段下部屋 2a が取ったセルは落ちる）。
 * 区画の無い階段は従来どおり天井を描かない（区画に入らなかった残りのセルの面も出さない）。
 * 区画の zMm＝床段差＋(heightMm ?? 部屋の CH)。shape・dims は区画の形状・寸法（残りは flat・[]）、chMm は基準の CH（床段差を含まない。
 * 平面＝天井高／傾斜＝低い側。S6a）。
 * @param {object} graph
 * @returns {Array<{roomId: string, zoneId: string|null, rects: Array<{x1:number,y1:number,x2:number,y2:number}>, zMm: number, shape: string, dims: number[], chMm: number}>}
 */
export function ceilingSurfacesOf(graph) {
  if (!graph) return [];
  // 読み取りスコープ（withGraphReadScope）で包まない: 呼び元（plan/planSolids.js）は MobX の追跡下で呼ぶことがあり、
  // スコープは内側の Reaction で依存を取るため外側の observer が部屋・CL の変更に反応しなくなる。
  // 所属は選択と同じ索引（ceilingOwners.js。親と部分指定の優先は並び順に依存しない。部分指定どうしが同じセルを持つときだけ部屋順の先勝ち）。S9（裁定 2026-10-10）
  const owners = ceilingCellOwnersOf(graph);
  // 階段の対の部屋（S6b）: 天井を持たない部屋（feature STAIR）だが、階段が天井を持つ（階段所属のセル）なら区画の面だけを出す（残りは出さない）
  const pairRooms = new Set();
  const cellToRoom = new Map();
  for (const [key, owner] of owners) {
    const room = graph.roomMap.get(owner.rowId);
    if (!room) continue; // 対の部屋が無い階段・消えた部屋は描かない
    if (owner.kind === 'stair' && !roomHasCeiling(room)) pairRooms.add(room);
    cellToRoom.set(key, room);
  }
  const rectsByRoom = new Map(); // room → Map<セルキー, 矩形>
  for (const [key, room] of cellToRoom) {
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
    const roomCh = roomCeilingHeight(graph, room).mm;
    const roomZ = floorStep + roomCh;
    const taken = new Set();
    const zoneFaces = [];
    for (const zone of room.ceilingZones) {
      const rects = [];
      for (const key of ceilingRefreshCells(new Set(zone.cells), graph)) {
        if (taken.has(key) || !rectByKey.has(key)) continue;
        taken.add(key);
        rects.push(rectByKey.get(key));
      }
      if (rects.length === 0) continue;
      rects.sort(byRow);
      const chMm = zone.heightMm ?? roomCh;
      zoneFaces.push({ roomId: room.id, zoneId: zone.id, rects, zMm: floorStep + chMm, shape: zone.shape, dims: [...zone.dims], chMm });
    }
    const rest = [];
    for (const [key, rect] of rectByKey) if (!taken.has(key)) rest.push(rect);
    if (rest.length > 0 && !pairRooms.has(room)) {
      rest.sort(byRow);
      out.push({ roomId: room.id, zoneId: null, rects: rest, zMm: roomZ, shape: CeilingShape.FLAT, dims: [], chMm: roomCh });
    }
    out.push(...zoneFaces);
  }
  return out;
}
