// ================================================================
// カタログの照合・不一致検出・候補選定（R8/R12/R14/R17）。
//
// 純モジュール（葉）。catalogKinds.js（登録表）と materialCode.js（コードのパース）だけに依存する。
// ================================================================

import { kindDef } from './catalogKinds.js';
import { parseMaterialCode } from './materialCode.js';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 値の等価判定（4.5-3・4.6の規約）:
 *   文字列は前後の空白を除いて完全一致／数値は null と 0 を区別／
 *   配列・オブジェクトは項目ごとの深い比較（文字列化比較はしない）。
 */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!valuesEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** kind の compareFields のうち a/b で異なる項目名の配列（code/key等の識別子は含まない）。 */
export function diffEntries(kind, a, b) {
  const def = kindDef(kind);
  return def.compareFields.filter(f => !valuesEqual(a?.[f], b?.[f]));
}

/**
 * R12: 不一致を通知するか。silentDiffFields（材の spec/thickness）のいずれかが
 * diffFields に含まれていれば、他の項目が同時に違っていても通知しない。
 */
export function shouldNotifyDiff(kind, diffFields) {
  if (!diffFields || diffFields.length === 0) return false;
  const def = kindDef(kind);
  const silent = def.silentDiffFields ?? [];
  if (silent.length === 0) return true;
  return !diffFields.some(f => silent.includes(f));
}

/**
 * R14: matchFields を末尾から1つずつ外しながら target と内容一致する entries を探す。
 * 戻り値: { level, exact, hits }
 *   level: 何項目外した段で見つかったか（0=完全一致）
 *   exact: 完全一致（段0）で見つかったか
 *   hits : その段で一致した候補（複数可）。1件も見つからなければ空配列。
 */
export function matchByContent(kind, target, entries) {
  const def = kindDef(kind);
  const fields = def.matchFields;
  const minLen = def.minMatchFields;
  for (let len = fields.length; len >= minLen; len--) {
    const consider = fields.slice(0, len);
    const hits = entries.filter(e => consider.every(f => valuesEqual(target?.[f], e?.[f])));
    if (hits.length > 0) {
      return { level: fields.length - len, exact: len === fields.length, hits };
    }
  }
  return { level: fields.length - minLen + 1, exact: false, hits: [] };
}

/**
 * 同じ段の候補の順位付け: 登録表の行が `compareCandidates(a,b,target)` を指定していれば
 * それを使う（QA指摘 M7）。未指定なら共通規則——builtin優先 → matchFieldsのうち数値項目の
 * 絶対差の合計が小さい順 → キー（keyOf）昇順。現状は全種別未指定（共通規則のみで運用）。
 *
 * kind には種別文字列（本番経路。kindDef(kind)で登録表を引く）のほか、
 * `{ keyOf, matchFields, compareCandidates? }` を満たす行オブジェクトを直接渡せる
 * （テストで compareCandidates の口が実際に効くことを、凍結された本番登録表を書き換えずに
 * 確認するため）。
 */
export function rankCandidates(kind, target, hits, origins) {
  const def = typeof kind === 'string' ? kindDef(kind) : kind;

  if (typeof def.compareCandidates === 'function') {
    return [...hits].sort((a, b) => def.compareCandidates(a, b, target));
  }

  const numericFields = def.matchFields.filter(f => typeof target?.[f] === 'number');

  function numericDistance(entry) {
    return numericFields.reduce((sum, f) => {
      const a = target[f], b = entry[f];
      if (typeof a !== 'number' || typeof b !== 'number') return sum;
      return sum + Math.abs(a - b);
    }, 0);
  }

  return [...hits].sort((a, b) => {
    const originA = origins?.get(def.keyOf(a)) ?? 'user';
    const originB = origins?.get(def.keyOf(b)) ?? 'user';
    if (originA === 'builtin' && originB !== 'builtin') return -1;
    if (originB === 'builtin' && originA !== 'builtin') return 1;
    const distA = numericDistance(a), distB = numericDistance(b);
    if (distA !== distB) return distA - distB;
    const keyA = def.keyOf(a), keyB = def.keyOf(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

/**
 * R8: 同梱エントリ(docEntry)をアプリ側カタログ(appEntries=builtin+userの合成一覧)と照合する。
 *   同一キーが存在 → 内容一致なら {action:'same'}、不一致なら {action:'adopt-doc', diffFields, notify}
 *   キー不一致 → 内容照合（matchByContent）。完全一致 → {action:'alias'}（自動）。
 *              部分一致（類似） → {action:'propose', candidates}（承認UIへ）。
 *   一致なし → {action:'add', entry:docEntry}
 */
export function classifyIncoming(kind, docEntry, appEntries, origins) {
  const def = kindDef(kind);
  const key = def.keyOf(docEntry);
  const existing = appEntries.find(e => def.keyOf(e) === key);
  if (existing) {
    const diffFields = diffEntries(kind, existing, docEntry);
    if (diffFields.length === 0) return { action: 'same', key };
    return { action: 'adopt-doc', key, diffFields, notify: shouldNotifyDiff(kind, diffFields) };
  }

  const { exact, hits } = matchByContent(kind, docEntry, appEntries);
  if (hits.length > 0) {
    const candidates = rankCandidates(kind, docEntry, hits, origins);
    if (exact) return { action: 'alias', from: key, to: def.keyOf(candidates[0]) };
    return { action: 'propose', from: key, candidates };
  }
  return { action: 'add', entry: docEntry };
}

/**
 * R17: 同じ内容（dedupeFields完全一致）の重複登録を弾く（category違いも不可）。
 * dedupeFields を持たない種別は常に許容（no-op）。
 */
export function assertNoDuplicate(kind, entry, entries) {
  const def = kindDef(kind);
  const dedupeFields = def.dedupeFields;
  if (!dedupeFields || dedupeFields.length === 0) return;
  const entryKey = def.keyOf(entry);
  const conflict = entries.find(e => (
    def.keyOf(e) !== entryKey
    && dedupeFields.every(f => valuesEqual(e[f], entry[f]))
  ));
  if (conflict) {
    throw new Error(`同じ内容の${kind}が既に登録されています（重複禁止）: ${def.keyOf(conflict)}`);
  }
}

/**
 * 4.6.1 場面(b): 実体が無くコードしか無いとき、大分類・中分類が同じ材を候補にする。
 * 候補が無ければ空配列。材料コード以外のkeyには使わない（コードが12桁体系の材専用）。
 */
export function suggestByClass(code, entries) {
  const parsed = parseMaterialCode(code);
  if (!parsed) return [];
  const hits = entries.filter(e => {
    const p = parseMaterialCode(e.code);
    return p && p.major === parsed.major && p.minor === parsed.minor;
  });
  return [...hits].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
