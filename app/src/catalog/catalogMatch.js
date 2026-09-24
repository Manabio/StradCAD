// ================================================================
// カタログの照合・不一致検出・候補選定（同梱とアプリ側カタログの照合・不一致通知の判定・
// 内容一致の段階的探索・重複登録の禁止）。
//
// 純モジュール（葉）。catalogKinds.js（登録表）・materialCode.js（コードのパース）・
// error.js（ERR_CATALOG_DUPLICATE。葉モジュールで .claude/ の不変条件に反しない）に依存する。
// ================================================================

import { kindDef } from './catalogKinds.js';
import { parseMaterialCode } from './materialCode.js';
import { ERR_CATALOG_DUPLICATE } from '../error.js';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 深い比較（厳密。2026-09-22追加裁定）: 配列・オブジェクトの「中」で使う。
 * null と undefined は同値にしない（キーの有無を区別する——`fields`・`layers`の各要素・
 * `slideLayout`等のオブジェクトのキー集合は項目名の集合＝意味を持つため）。
 * 文字列のtrim比較は維持する。
 */
function deepValuesEqualStrict(a, b) {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepValuesEqualStrict(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false; // キーの有無を区別する（{框:null}≠{}）
    return keysA.every(k => (
      Object.prototype.hasOwnProperty.call(b, k) && deepValuesEqualStrict(a[k], b[k])
    ));
  }
  return false;
}

/**
 * 値の等価判定の規約（エントリ直下の項目＝compareFields/matchFields/dedupeFields
 * で名指しされる値に使う）:
 *   文字列は前後の空白を除いて完全一致／数値は null と 0 を区別／
 *   null と undefined（省略）は同値（2026-09-22裁定。本体マスタは触らない。「未設定はnull」は
 *   エントリの項目の話であって、項目の値がオブジェクト・配列のときその「中」までは及ばない）／
 *   配列・オブジェクトの「中」（fields・layersの各要素・slideLayout等の入れ子）は
 *   deepValuesEqualStrictで厳密に比較する（キーの有無・入れ子内のnull/undefinedを区別する）。
 */
export function valuesEqual(a, b) {
  const aNullish = a === null || a === undefined;
  const bNullish = b === null || b === undefined;
  if (aNullish || bNullish) return aNullish && bNullish;
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepValuesEqualStrict(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return deepValuesEqualStrict(a, b);
  }
  return false;
}

/** kind の compareFields のうち a/b で異なる項目名の配列（code/key等の識別子は含まない）。 */
export function diffEntries(kind, a, b) {
  const def = kindDef(kind);
  return def.compareFields.filter(f => !valuesEqual(a?.[f], b?.[f]));
}

/**
 * 不一致を通知するか。silentDiffFields（材の spec/thickness）のいずれかが
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
 * matchFields を末尾から1つずつ外しながら target と内容一致する entries を探す。
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
 * rankCandidatesの本体。登録表の行（またはそれと同じ形のダミー行）を直接受け取る
 * （積み残し2026-09-22: 本番経路のrankCandidatesは種別文字列専用に戻し、行オブジェクトを
 * 受ける経路はここへ分離した。テストで compareCandidates の口が実際に効くことを、凍結された
 * 本番登録表を書き換えずに確認するのに使う）。
 */
export function rankCandidatesWith(def, target, hits, origins) {
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
 * 同じ段の候補の順位付け（本番経路。kind は種別文字列専用——kindDef(kind)で登録表を引く）。
 * 登録表の行が `compareCandidates(a,b,target)` を指定していればそれを使う（QA指摘 M7）。
 * 未指定なら共通規則——builtin優先 → matchFieldsのうち数値項目の絶対差の合計が小さい順 →
 * キー（keyOf）昇順。現状は全種別未指定（共通規則のみで運用）。
 */
export function rankCandidates(kind, target, hits, origins) {
  return rankCandidatesWith(kindDef(kind), target, hits, origins);
}

/**
 * 同梱エントリ(docEntry)をアプリ側カタログ(appEntries=builtin+userの合成一覧)と照合する。
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

/** entryの名称（表示用）。material=name、他4種別=label。どちらも無ければ空文字。 */
export function displayNameOf(entry) {
  return entry?.name || entry?.label || '';
}

/**
 * 重複禁止（dedupeFields完全一致）エラーを組み立てる（2026-09-22 QA指摘C）。両エントリのキー＋名称を含める。
 * origins（Map<key,'doc'|'user'|'builtin'>）を渡せば出所も併記する（registry の合成後検査用。
 * assertNoDuplicate 単体からは出所を持たないため省略）。code は ERR_CATALOG_DUPLICATE
 * （wallRefresh.js 等の呼び出し側が「握りつぶさず再throwすべきエラー」と識別するのに使う）。
 * 2026-09-22 QA指摘・Minor: 名称（displayNameOf）が空のとき「（（名称なし））」のような
 * 二重括弧にしない——名称・出所のどちらも無ければ括弧ごと省き、キーだけを出す。
 */
export function formatDuplicateError(kind, def, a, b, origins) {
  const tag = e => {
    const origin = origins?.get(def.keyOf(e));
    const parts = [displayNameOf(e), origin].filter(Boolean).join('・');
    return parts ? `${def.keyOf(e)}（${parts}）` : def.keyOf(e);
  };
  const err = new Error(
    `同じ内容の${kind}が既に登録されています（重複禁止）: ${tag(a)} ⇔ ${tag(b)}`,
  );
  err.code = ERR_CATALOG_DUPLICATE;
  return err;
}

/**
 * 同じ内容（dedupeFields完全一致）の重複登録を弾く（category違いも不可）。
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
  if (conflict) throw formatDuplicateError(kind, def, conflict, entry);
}

/**
 * 場面(b): 実体が無くコードしか無いとき、大分類・中分類が同じ材を候補にする。
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
