/**
 * 昇降機器具の図中記号（位置＋文字）の計算（graph を読むだけの純関数。
 * react / store.js / snap.js / .jsx を静的 import しない）。
 * レンダラ（renderer/EquipmentSymbolLayer.jsx）は結果を Konva 要素へ写像するだけにする
 * （finish/stepSection.js・finish/stair/stairGeometry.js と同じパターン）。
 */
import { equipmentFootprints } from './equipmentGeometry.js';
import { equipmentSymbols } from './equipmentNumbering.js';
import { roomBounds } from '../gridCells.js';

/**
 * 器具行ごとに、記号の文字と位置（refresh済みセルの包絡矩形の中心）を返す。
 * セルが解決できない行（equipmentFootprintsが空として除く）・catalogに無いid（symbol未定義）は出さない。
 * @param {object} graph
 * @param {Array<{id:string, category:string, no:number}>} catalog equipmentSymbolsへ渡すカタログ
 * @returns {Array<{id:string, text:string, x:number, y:number}>}
 */
export function computeEquipmentSymbols(graph, catalog) {
  if (!graph) return [];
  const symbols = equipmentSymbols(catalog);
  const result = [];
  for (const fp of equipmentFootprints(graph)) {
    const text = symbols.get(fp.id);
    if (!text) continue;
    const bounds = roomBounds(fp.cells, graph);
    if (bounds.x1 === Infinity) continue;
    result.push({ id: fp.id, text, x: (bounds.x1 + bounds.x2) / 2, y: (bounds.y1 + bounds.y2) / 2 });
  }
  return result;
}
