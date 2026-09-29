/**
 * 昇降機器具の建物全体（全採用階）読み出し（純関数。project と activeGraph を読むだけ。
 * react / store.js / snap.js / .jsx を静的 import しない）。昇降機の仕様追加 ステップ4・S4。
 *
 * アクティブ階は常に graph.equipmentRows（生きている行）から読む——project.equipmentIndex が
 * 古くても正しい。他階は project.equipmentIndex（App.jsx の effect が peek して詰める非永続
 * キャッシュ）から読む。project.planes に無い planeId（階削除後に残ったキャッシュ等）は無視する。
 *
 * アクティブ階が project.planes に無い場合（検討案の平面。採用フロアではない）は自階だけを返す
 * （QA指摘M1・2026-09-29）——採用階の index（project.equipmentIndex）を検討案の平面の採番・記号に
 * 混ぜない（検討案の平面では、設置階だけに設置し採番は自階の行から求める仕様のため。
 * 混ぜると採用階に既にある no と衝突し、検討案側の器具の記号が採番されない事故になる
 * ——QA実測: 検討案の平面で2基設置すると no が 1・1 で重複）。
 */
import { selfFloorEquipmentCatalog, equipmentFloorSpanLabel } from './equipmentNumbering.js';

/**
 * 器具行一覧を返す。アクティブ階が project.planes（採用フロア）にあれば全採用階ぶん
 * （elevation昇順。アクティブ階は activeGraph.equipmentRows（生きている行）、他階は
 * project.equipmentIndex.get(planeId)（plain値配列。無ければ空配列＝index未読込み））。
 * アクティブ階が project.planes に無ければ（検討案の平面）自階だけの1件を返す。
 * @param {object} project
 * @param {object} activeGraph
 * @returns {Array<{plane:object, rows:Array<{id,category,no,usage}>}>}
 */
export function floorEquipmentRowLists(project, activeGraph) {
  const activePlaneId = activeGraph?.plane?.id ?? null;
  const isAdopted = project.planes.some(p => p.id === activePlaneId);
  if (!isAdopted) {
    if (!activeGraph?.plane) return [];
    return [{ plane: activeGraph.plane, rows: activeGraph.equipmentRows }];
  }
  return project.planes.map(plane => ({
    plane,
    rows: plane.id === activePlaneId ? activeGraph.equipmentRows : (project.equipmentIndex.get(plane.id) ?? []),
  }));
}

/**
 * 建物全体（全採用階）の器具カタログ（{id,category,no}[]。重複は先勝ち＝低階が勝つ。
 * judgeElevatorInstall と同じ規約）。
 * @param {object} project
 * @param {object} activeGraph
 * @returns {Array<{id:string, category:string, no:number}>}
 */
export function buildingEquipmentCatalog(project, activeGraph) {
  const allRows = floorEquipmentRowLists(project, activeGraph).flatMap(f => f.rows);
  return selfFloorEquipmentCatalog(allRows);
}

/**
 * id（器具id）が存在する全階から「設置階〜最上階」の表示文字列を作る（equipmentFloorSpanLabel）。
 * id を持つ行が1件も無ければ null（未登録・削除済み等。呼び出し側は現在の階名等へフォールバックする）。
 * @param {object} project
 * @param {object} activeGraph
 * @param {string} id
 * @returns {string|null}
 */
export function equipmentSpanLabelOf(project, activeGraph, id) {
  const floors = floorEquipmentRowLists(project, activeGraph)
    .filter(f => f.rows.some(r => r.id === id))
    .map(f => ({ label: f.plane.name, order: f.plane.elevation }));
  if (floors.length === 0) return null;
  return equipmentFloorSpanLabel(floors);
}
