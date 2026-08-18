// savedFloors（保存ドキュメント）へ反映すべき差分の計算（計算部）。db.js の
// commitFloorsToDocument から使う。IndexedDBに一切依存しない純関数——保存ドキュメントは常に
// 保存時点の project.planeMap（＝ planeIds）の鏡でなければならない、という不変条件をテストで固定する。
//
// floorOps.js に置かないのは意図的: floorOps.js は既に storage/db.js（saveFloor/deleteFloor）を
// 静的 import しており、db.js からこのファイルを import すると循環importになるため、
// 依存の無い葉モジュールとして storage/ 配下に分離する。

/**
 * savedKeys（現在 savedFloors に存在する planeId 一覧）と planeIds（保存時点の
 * project.planeMap の全 planeId＝保存対象）を突き合わせ、savedFloors へ適用すべき差分を返す。
 *
 * @param {string[]} savedKeys
 * @param {string[]} planeIds
 * @returns {{ toCopy: string[], toDelete: string[] }}
 *   toCopy   — floors から savedFloors へコピーすべき planeId（= planeIds そのもの。floors に
 *              実体が無ければ呼び出し側でスキップする）
 *   toDelete — savedFloors から削除すべき planeId（= savedKeys のうち planeIds に無いもの。
 *              保存後に削除された階がゴーストとして savedFloors に残り続けるのを防ぐ）
 */
export function computeSavedFloorDiff(savedKeys, planeIds) {
  const idSet = new Set(planeIds ?? []);
  const toCopy = [...idSet];
  const toDelete = (savedKeys ?? []).filter(key => !idSet.has(key));
  return { toCopy, toDelete };
}
