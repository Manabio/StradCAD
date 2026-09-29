/**
 * 昇降機器具の採番・記号（graph 非依存の純関数）。
 * 呼び出し側が graph.equipmentRows（の toData 相当・{id,category,no} を持つ配列）を渡す。
 * store.js / snap.js / .jsx / react を静的 import しない。
 */

// 図中記号の接頭辞（分類→接頭辞）。未知の分類は分類の文字列をそのまま使う。
export const EQUIPMENT_SYMBOL_PREFIX = { ev: 'EV' };

/**
 * 同じ id を1件にまとめる（先勝ち）。selfFloorEquipmentCatalog・equipmentSymbols・
 * renumberEquipment・nextEquipmentNo が共有する唯一の重複除去（QA指摘: 全階分をまとめて
 * 渡されたとき同じidの行が複数件混ざりうるため、この関数を通さない入口を作らない）。
 * @param {Array<{id:string}>} items
 * @returns {Array}
 */
function dedupeById(items) {
  const byId = new Map();
  for (const r of items ?? []) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * 器具行（全階ぶんを渡されてもよい）から、同じ id を1件にまとめたカタログを作る。
 * @param {Array<{id:string, category:string, no:number}>} rows
 * @returns {Array<{id:string, category:string, no:number}>}
 */
export function selfFloorEquipmentCatalog(rows) {
  return dedupeById((rows ?? []).map(r => ({ id: r.id, category: r.category, no: r.no })));
}

/** その分類の no の最大+1（0件なら1）。同じidが複数件渡されても重複除去してから見る。 */
export function nextEquipmentNo(catalog, category) {
  const nos = dedupeById(catalog).filter(r => r.category === category).map(r => r.no);
  return nos.length === 0 ? 1 : Math.max(...nos) + 1;
}

function groupByCategory(catalog) {
  const groups = new Map();
  for (const r of dedupeById(catalog)) {
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category).push(r);
  }
  return groups;
}

// 分類内の並び順（no昇順→id昇順で決定的）。
function sortWithinCategory(list) {
  return [...list].sort((a, b) => (a.no - b.no) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 分類ごとに異なる id を数え、1基なら接頭辞だけ、2基以上なら (no, id) の昇順の順位で 接頭辞+順位。
 * @returns {Map<string, string>} id → 記号
 */
export function equipmentSymbols(catalog) {
  const result = new Map();
  for (const [category, list] of groupByCategory(catalog)) {
    const prefix = EQUIPMENT_SYMBOL_PREFIX[category] ?? category;
    if (list.length === 1) {
      result.set(list[0].id, prefix);
      continue;
    }
    sortWithinCategory(list).forEach((r, i) => result.set(r.id, `${prefix}${i + 1}`));
  }
  return result;
}

/** 分類ごとに (no, id) 順で 1..n に詰め直す。 @returns {Map<string, number>} id → 新no */
export function renumberEquipment(catalog) {
  const result = new Map();
  for (const list of groupByCategory(catalog).values()) {
    sortWithinCategory(list).forEach((r, i) => result.set(r.id, i + 1));
  }
  return result;
}

/**
 * order の最小〜最大の階名（例:「1階〜3階」）。1件ならその階名だけ。空配列は throw。
 * @param {Array<{label:string, order:number}>} floors
 */
export function equipmentFloorSpanLabel(floors) {
  if (!floors || floors.length === 0) throw new Error('equipmentFloorSpanLabel: floors is empty');
  const sorted = [...floors].sort((a, b) => a.order - b.order);
  const first = sorted[0], last = sorted[sorted.length - 1];
  return first.order === last.order ? first.label : `${first.label}〜${last.label}`;
}
