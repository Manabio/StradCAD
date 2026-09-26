// 在来木造の柱の「由来集合」を表す純モジュール。柱1本は複数の由来を同時に持ちうる（例: 3a壁交点＋
// 3b上階柱直下が同じ位置に合流する）ため、単一の由来ラベルではなく Set<ColumnOrigin> を柱に持たせ、
// 表示時（renderer/originColorKey.js columnOriginColorKey）に優先順位で1色へ落とす。
//
// 'grid'（通り芯交点）・'jamb'（建具の袖柱）・'manual'（手動固定）はこの集合に入れない——
// grid は柱自身の verticalCL/horizontalCL の centerLineKind から描画時に導出する（昇格/降格で
// 種別が変わっても再計算なしで追従させるため。真実を1つに保つ）、jamb は既存の woodJambRef、
// manual は既存の dimensionStatus がそれぞれ唯一の真実であり、二重に持たない。
//
// 真実の書き手は structural/woodAutoFill.js autoFillWoodColumns のみ（他所から直接いじらない）。

/** 柱の由来（'grid'・'jamb'・'manual' を除く）。値は formatColumnOrigins が永続化する文字列そのもの。 */
export const ColumnOrigin = Object.freeze({
  WALL:         'wall',         // 3a: 自階の壁の交点
  FREE_END:     'freeEnd',      // F-1: 壁の自由端
  ABOVE:        'above',        // 3b（上階柱直下）・3h-2（上階梁横断）
  SUPPORT_SPAN: 'supportSpan',  // 3i: 梁の支持長1820ルールによる分割
});

/**
 * 由来集合(Set<string>)を永続化用の文字列にする。空・null は null。
 * ソートしてから連結する（生成順（Setの挿入順）に依存しない決定的な文字列にするため——
 * 同じ由来の組合せなら常に同じ文字列になり、冪等性の判定（前回値と比較して書き戻すか）に使える）。
 * @param {Set<string>|null} origins
 * @returns {string|null}
 */
export function formatColumnOrigins(origins) {
  if (!origins || origins.size === 0) return null;
  return [...origins].sort().join(',');
}

/**
 * formatColumnOrigins の逆変換。null・空文字は空集合。
 * @param {string|null} str
 * @returns {Set<string>}
 */
export function parseColumnOrigins(str) {
  if (!str) return new Set();
  return new Set(str.split(','));
}

/**
 * slots（columnSlotKey等 → {verticalCL, horizontalCL, woodAxisOffset?, woodJambRef?, origins}）へ
 * 1件をマージする。同じ key が既にあれば origins は和集合、それ以外のフィールド（verticalCL/
 * horizontalCL/woodAxisOffset/woodJambRef）は今回渡した entry で（従来どおり）後勝ちに上書きする
 * ——slots.set(key, ...) の意味論（Map は既存キーの位置のまま値だけ差し替える）は変えない。
 * 無ければ {...entry, origins:new Set(origins)} を新規 set する。
 * @param {Map<string, object>} slots
 * @param {string} key
 * @param {object} entry - verticalCL/horizontalCL 等（origins は含めない）
 * @param {Iterable<string>} origins - この呼び出しが加える由来（ColumnOrigin の値。0件も可）
 */
export function mergeSlot(slots, key, entry, origins) {
  const existing = slots.get(key);
  const merged = existing ? new Set(existing.origins) : new Set();
  for (const o of origins) merged.add(o);
  slots.set(key, { ...entry, origins: merged });
}
