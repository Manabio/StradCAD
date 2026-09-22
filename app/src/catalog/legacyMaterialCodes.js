// ================================================================
// 本体材コードの振り直し表（旧コード → 新コード。R7・4.4.1）。
//
// ステップ1では表は空（振り直しはステップ3で行う）。値 null は削除・廃止（R18）を表す。
// openings/openingCatalog.js の LEGACY_SUBTYPE_ALIASES / normalizeSubType と同型。
//
// ゼロ依存の葉モジュール（他のsrcをimportしない）。
// ================================================================

/** 旧材コード → 新材コード（null=削除・廃止）。ステップ1は空の凍結オブジェクト。 */
export const LEGACY_MATERIAL_CODE_ALIASES = Object.freeze({});

/** 削除・廃止された材の記録（旧コード・旧内容）。ステップ1は空。ステップ3で4.4.1の対応表を持つ。 */
export const REMOVED_MATERIALS = Object.freeze([]);

/** 旧材コードを現行コードへ読み替える（未知・現行コードはそのまま返す）。1段のみ（連鎖の解消は codeNormalization.js）。 */
export function normalizeMaterialCode(code) {
  if (typeof code !== 'string') return code;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_MATERIAL_CODE_ALIASES, code)) return code;
  return LEGACY_MATERIAL_CODE_ALIASES[code];
}
