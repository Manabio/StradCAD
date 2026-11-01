// ================================================================
// 建具 1 件の部分詳細図の上書き（Opening.detailRefs）の正規形。import を持たない葉。
// 形は {[slot]: 詳細図のキー} | null。空の写像・空文字・文字列以外の値は捨てて、
// 何も残らなければ null に正規化する（FBS は null のとき何も書かない＝未使用の文書のバイト列は不変）。
// slot の名前は検証しない（DetailSlot にある全 slot をデータとして受ける）。
// キーを昇順に並べた凍結オブジェクトを返す——undo のスナップショット比較（JSON.stringify）と FBS の
// 書出しが挿入順に左右されず、スナップショットとの共有でも書き換えられない。
// ================================================================

/**
 * @param {unknown} v
 * @returns {Readonly<Record<string,string>>|null}
 */
export function normalizeDetailRefs(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v)
    .filter(([, key]) => typeof key === 'string' && key !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : null;
}

/**
 * slot を key に差し替えた（key が空・null なら外した）次の detailRefs。元は変えない。
 * @param {unknown} current
 * @param {string} slot
 * @param {string|null|undefined} key
 */
export function withDetailRef(current, slot, key) {
  const next = { ...(normalizeDetailRefs(current) ?? {}) };
  if (typeof key === 'string' && key !== '') next[slot] = key;
  else delete next[slot];
  return normalizeDetailRefs(next);
}
