/**
 * 天伏の天井セル（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 *
 * 天井セル＝仕上げのセルを「天井芯」でさらに割った格子（finish/gridCells.js の CEILING_CELL_GRID＝仕上げの分割線＋天井芯）。
 * 天井セルの key は仕上げのセルと同じ形（leftId:topId:rightId:bottomId）で、天井芯が1本も無ければ仕上げのセルと
 * key も順序も一致する（天井の分割線は仕上げの分割線の上位集合）。
 *
 * 仕上げ側のデータ（Room.cells・Stair.cells・天井区画 CeilingZone.cells）は仕上げ key でも天井 key でもよい
 * （区画は天井 key で持つ）。読む側は ceilingRefreshCells で「今の天井セル」へ展開してから使う。
 * 展開は key → 矩形（cellBoundsFromKey）→ その矩形に掛かる天井セル、の順なので、仕上げ key（粗い）は
 * 天井芯で割れたセル群へ、天井 key は同じセルへ。解けない key（天井芯の削除など）は捨てる＝そのセルは部屋の
 * 天井高に戻る（S5 と同じ受容）。
 */
import { CEILING_CELL_GRID, regionCellsAt, getCellsInRect, cellBoundsFromKey } from '../finish/gridCells.js';
import { scopedValue } from '../graphReadScope.js';

/** 点 (wx, wy) を含む天井セルの連結領域（regionCellsAt の天井版）。 */
export function ceilingRegionCellsAt(wx, wy, graph) {
  return regionCellsAt(wx, wy, graph, CEILING_CELL_GRID);
}

/**
 * 矩形 b に掛かる天井セル。仕上げの getCellsInRect と同じ展開（小区間の中点から引くため、L字併合セルなど
 * b からはみ出すセルへも広がる。裁定: 案A・2026-10-10）。天井芯が1本も無ければ仕上げの refreshCells と
 * key・順序とも一致する。b は x1/x2・y1/y2 の大小が反転していてもよい（min/max に正規化する）。
 * b が不正（null・非有限）なら空。
 * @param {{x1:number,y1:number,x2:number,y2:number}|null} b
 * @returns {Array<{key:string,x1:number,x2:number,y1:number,y2:number}>}
 */
export function ceilingCellsWithin(b, graph) {
  if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return [];
  const x1 = Math.min(b.x1, b.x2), x2 = Math.max(b.x1, b.x2);
  const y1 = Math.min(b.y1, b.y2), y2 = Math.max(b.y1, b.y2);
  return getCellsInRect(x1, y1, x2, y2, graph, CEILING_CELL_GRID);
}

function refreshOnce(keys, graph) {
  const result = new Set();
  for (const key of keys) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue; // 解けない key（CL 削除など）は捨てる
    for (const cell of ceilingCellsWithin(b, graph)) result.add(cell.key);
  }
  return result;
}

/**
 * セルキーの集合（仕上げ key・天井 key のどちらも可）を今の天井セルの key へ展開する（refreshCells の天井版）。
 * 解けない key は捨てる。Set 入力は読み取りスコープ内で同一性メモ化する（スコープ内で keys を変更しないこと）。
 * @param {Iterable<string>} keys
 * @returns {Set<string>}
 */
export function ceilingRefreshCells(keys, graph) {
  if (keys instanceof Set) {
    const memo = scopedValue(graph, 'ceilingGrid:refresh', () => new WeakMap());
    let hit = memo.get(keys);
    if (!hit) { hit = refreshOnce(keys, graph); memo.set(keys, hit); }
    return hit;
  }
  return refreshOnce(keys, graph);
}
