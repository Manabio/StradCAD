// ================================================================
// カタログ束（.stq 同梱／ユーザーライブラリの器）— 生成・検証・マージ・解決順。
//
// 束の形: { version:1, catalogs:{ kind:[entries] }, encodings:{ kind:'json' }, aliases:{ kind:{from:to} } }
//
// 純モジュール（葉）。catalogKinds.js（登録表）・catalogMatch.js（不一致検出）にのみ依存する。
// ================================================================

import { kindDef, listKinds } from './catalogKinds.js';
import { diffEntries, valuesEqual } from './catalogMatch.js';

const BUNDLE_VERSION = 1;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 空のカタログ束。 */
export function emptyBundle() {
  return { version: BUNDLE_VERSION, catalogs: {}, encodings: {}, aliases: {} };
}

/**
 * 束を検証する。型違い・keyOf欠落（keyOfが導出できない＝必須項目欠落として validate が弾く）・
 * キー重複・dedupeFields重複・version不正は例外。
 * 未知の種別（登録表に無い kind）は検証をスキップして保持する（往復互換のため）。
 */
export function validateBundle(bundle) {
  if (!isPlainObject(bundle)) throw new Error('カタログ束はオブジェクトである必要があります');
  if (bundle.version !== BUNDLE_VERSION) {
    throw new Error(`未対応のカタログ束バージョンです: ${bundle.version}`);
  }
  if (!isPlainObject(bundle.catalogs)) throw new Error('カタログ束のcatalogsが不正です');

  const knownKinds = new Set(listKinds());

  for (const [kind, entries] of Object.entries(bundle.catalogs)) {
    if (!knownKinds.has(kind)) continue; // 未知の種別は検証をスキップして保持
    if (!Array.isArray(entries)) throw new Error(`カタログ束の${kind}が配列である必要があります`);
    const def = kindDef(kind);

    const seenKeys = new Set();
    for (const entry of entries) {
      def.validate(entry);
      const key = def.keyOf(entry);
      if (seenKeys.has(key)) throw new Error(`${kind}のキーが重複しています: ${key}`);
      seenKeys.add(key);
    }

    if (def.dedupeFields && def.dedupeFields.length > 0) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          if (def.dedupeFields.every(f => valuesEqual(entries[i][f], entries[j][f]))) {
            throw new Error(
              `${kind}の内容が重複しています（${def.dedupeFields.join(',')}が一致）: `
              + `${def.keyOf(entries[i])} / ${def.keyOf(entries[j])}`,
            );
          }
        }
      }
    }
  }

  if (bundle.aliases !== undefined) {
    if (!isPlainObject(bundle.aliases)) throw new Error('カタログ束のaliasesが不正です');
    for (const [kind, table] of Object.entries(bundle.aliases)) {
      if (!isPlainObject(table)) throw new Error(`カタログ束のaliases.${kind}が不正です`);
      for (const [from, to] of Object.entries(table)) {
        if (to !== null && typeof to !== 'string') {
          throw new Error(`カタログ束のaliases.${kind}.${from}が不正です`);
        }
      }
    }
  }

  if (bundle.encodings !== undefined) {
    if (!isPlainObject(bundle.encodings)) throw new Error('カタログ束のencodingsが不正です');
    for (const [kind, enc] of Object.entries(bundle.encodings)) {
      if (typeof enc !== 'string') throw new Error(`カタログ束のencodings.${kind}が不正です`);
    }
  }

  return true;
}

/** kind のエントリ配列（無ければ空配列）。 */
export function bundleEntries(bundle, kind) {
  return bundle?.catalogs?.[kind] ?? [];
}

/** kind のエントリ配列を差し替えた新しい束を返す（非破壊）。 */
export function withEntries(bundle, kind, entries) {
  return { ...bundle, catalogs: { ...bundle.catalogs, [kind]: entries } };
}

/** kind の読み替え表（無ければ空オブジェクト）。 */
export function bundleAliases(bundle, kind) {
  return bundle?.aliases?.[kind] ?? {};
}

/** kind の読み替え表に1件追記した新しい束を返す（非破壊）。 */
export function withAlias(bundle, kind, from, to) {
  return {
    ...bundle,
    aliases: { ...bundle.aliases, [kind]: { ...bundleAliases(bundle, kind), [from]: to } },
  };
}

/**
 * doc → user → builtin の順に set していく（doc勝ち）→ Map<key, entry>。
 * エントリはそのまま参照を格納する（コピー・凍結・ラップしない＝===同一性を保つ）。
 */
export function resolveCatalog(kind, { doc = [], user = [], builtin = [] } = {}) {
  const def = kindDef(kind);
  const map = new Map();
  for (const entry of builtin) map.set(def.keyOf(entry), entry);
  for (const entry of user) map.set(def.keyOf(entry), entry);
  for (const entry of doc) map.set(def.keyOf(entry), entry);
  return map;
}

/** resolveCatalog と同じ優先順で、キー → 出所('doc'|'user'|'builtin') を返す。 */
export function resolveOrigins(kind, { doc = [], user = [], builtin = [] } = {}) {
  const def = kindDef(kind);
  const origins = new Map();
  for (const entry of builtin) origins.set(def.keyOf(entry), 'builtin');
  for (const entry of user) origins.set(def.keyOf(entry), 'user');
  for (const entry of doc) origins.set(def.keyOf(entry), 'doc');
  return origins;
}

/**
 * 4.4: overridesBuiltin の印が無いのに builtin と同キー・内容不一致の user エントリを検出する。
 * 印がある（本体材の編集として作った）ものは衝突にしない。
 */
export function detectLibraryConflicts(kind, { user = [], builtin = [] } = {}) {
  const def = kindDef(kind);
  const builtinMap = new Map(builtin.map(e => [def.keyOf(e), e]));
  const conflicts = [];
  for (const entry of user) {
    if (entry.overridesBuiltin) continue;
    const key = def.keyOf(entry);
    const builtinEntry = builtinMap.get(key);
    if (!builtinEntry) continue;
    const diffFields = diffEntries(kind, builtinEntry, entry);
    if (diffFields.length > 0) conflicts.push({ key, diffFields });
  }
  return conflicts;
}
