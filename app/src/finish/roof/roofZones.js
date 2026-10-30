/**
 * 屋根区画（PlanGraph.roofZones）の純関数。graph は書き換えない（呼び出し側が graph.setRoofZones する）。
 *
 * 区画＝最上階の部屋セルの上に重なるセル集合＋RoofSpec。区画に入らないセルは従来の mainRoofSpec に従う。
 * 保存のセルキーは生キーのまま持ち、読む側（roofZoneEffectiveCells）が refreshCells（現在の格子へ展開し直す）と
 * 建物範囲（footprintCellKeys）との交差で守る。
 *
 * wallGate.js は storage 系を連鎖して引くため、graphSnapshot.js が引く roofDefaults.js には置かずこの葉に分ける
 * （mainRoof.js のヘッダと同じ理由）。store.js / snap.js / .jsx を静的に import しない。
 */
import { RoofZone } from '../../core/roofZone.js';
import { refreshCells } from '../gridCells.js';
import { footprintCellKeys } from '../../structural/wallGate.js';

/**
 * 区画を作る。後から作った区画が既存区画のセルを奪い、空になった区画は消す。
 * cellKeys は昇順・重複除去に正規化（RoofZone のコンストラクタ）。空なら変更なし（zoneId: null）。
 * @param {ReadonlyArray<RoofZone>} zones 現在の区画
 * @param {Iterable<string>} cellKeys 区画にするセルキー
 * @param {import('../../core/roofSpec.js').RoofSpec} spec 区画の仕様（呼び出し側が createRoofZoneSpec で作る）
 * @param {() => string} [idFactory]
 * @returns {{ zones: ReadonlyArray<RoofZone>, zoneId: string|null }}
 */
export function createRoofZone(zones, cellKeys, spec, idFactory = () => crypto.randomUUID()) {
  const zone = new RoofZone({ id: idFactory(), cells: cellKeys, spec });
  if (zone.cells.length === 0) return { zones, zoneId: null };
  // id の重複は保存後の restoreRoofZones（先勝ち）で新しい区画が黙って消えるので、作る時点で拒む（QA 指摘）
  if (zones.some(z => z.id === zone.id)) throw new Error(`createRoofZone: 区画 id が重複しています: ${zone.id}`);
  const taken = new Set(zone.cells);
  const kept = [];
  for (const z of zones) {
    const rest = z.cells.filter(c => !taken.has(c));
    if (rest.length === 0) continue;
    kept.push(rest.length === z.cells.length ? z : z.withCells(rest));
  }
  kept.push(zone);
  return { zones: Object.freeze(kept), zoneId: zone.id };
}

/**
 * 区画を消す。該当 id が無ければ同じ配列（同一参照）を返す。
 * @param {ReadonlyArray<RoofZone>} zones
 * @param {string} zoneId
 */
export function removeRoofZone(zones, zoneId) {
  if (!zones.some(z => z.id === zoneId)) return zones;
  return Object.freeze(zones.filter(z => z.id !== zoneId));
}

/**
 * 区画の実効セル＝現在の格子へ展開し直したセル ∩ 建物範囲（最上階の屋内部屋セル）。
 * @returns {Set<string>}
 */
export function roofZoneEffectiveCells(zone, graph) {
  const footprint = footprintCellKeys(graph);
  return effectiveCellsIn(zone, graph, footprint);
}

function effectiveCellsIn(zone, graph, footprint) {
  const out = new Set();
  for (const key of refreshCells(zone.cells, graph)) if (footprint.has(key)) out.add(key);
  return out;
}

/**
 * 主屋根（mainRoofSpec）に従うセル＝建物範囲 − どの区画の実効セルでもないセル。
 * @returns {Set<string>}
 */
export function mainRoofRestCellKeys(graph) {
  const footprint = footprintCellKeys(graph);
  const rest = new Set(footprint);
  for (const zone of graph.roofZones) {
    for (const key of effectiveCellsIn(zone, graph, footprint)) rest.delete(key);
  }
  return rest;
}
