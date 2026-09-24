// ================================================================
// カタログ束（.stq 同梱／ユーザーライブラリの器）— 生成・検証・マージ・解決順。
//
// 束の形: { version:1, catalogs:{ kind:[entries] }, encodings:{ kind:'json' }, aliases:{ kind:{from:to} } }
//
// 純モジュール（葉）。catalogKinds.js（登録表）・catalogMatch.js（不一致検出）にのみ依存する。
// ================================================================

import { kindDef, listKinds, KIND_LABELS } from './catalogKinds.js';
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
      try {
        def.validate(entry);
      } catch (e) {
        // ステップ14-S（裁定1付随）: 種別・キーを前置する——通知（catalogOverlayLoader.js
        // onError／documentFile.jsの例外文言）だけでは「どの束のどのエントリが壊れているか」
        // が分からず、原因調査ができなかった（QA実測）。keyOf自体が例外を投げる（key欠落等）
        // 場合はキー部分を「(キー不明)」にする。
        let key = '(キー不明)';
        try { key = def.keyOf(entry); } catch { /* キー欠落は不明のまま */ }
        throw new Error(`${kind} ${key}: ${e.message}`, { cause: e });
      }
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
      // 既知種別のみ from/to のキー形式を検査する（未知の種別は他の検証と同様スキップして保持）。
      const def = knownKinds.has(kind) ? kindDef(kind) : null;
      for (const [from, to] of Object.entries(table)) {
        if (to !== null && typeof to !== 'string') {
          throw new Error(`カタログ束のaliases.${kind}.${from}が不正です`);
        }
        if (def) {
          def.parseKey(from); // 当該種別のkeyOf形式でなければparseKeyが例外を投げる
          if (to !== null) def.parseKey(to);
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

/**
 * 束の各エントリへ、種別ごとの migrate（登録表 kindDef(kind).migrate。あれば）を適用した
 * 新しい束を返す（非破壊）。呼び出し側は validateBundle の前に通すこと（ステップ14-S: 裁定1
 * ——旧 structural/sectionCatalog.js parseSectionSpec のバグで作られた不正データ（例: 負の
 * 断面）を、検証で弾く前に読込み時に正しい内容へ書き換えて救済する）。
 * migrate を持たない種別・migrate が「変更なし」と判断したエントリ（===同一参照を返す契約。
 * 対象外のエントリは必ず同一参照を返すこと）はそのまま保持し、migrated には積まない。
 * 未知の種別・catalogs の値が配列でない項目は素通しする（ここで例外にすると、壊れたデータが
 * validateBundle まで届かず、本来の validateBundle のエラー文言を利用者へ出せなくなるため——
 * 「壊れているかどうかの判定」はvalidateBundleの役目のまま残す）。
 *
 * QA指摘Major-1（ステップ14-S再指摘）: キーが変わる移行（keyOf(from)!==keyOf(to)）は
 * withAlias(nextBundle, kind, 旧キー, 新キー) で読み替え表へ積む——旧キーを参照している
 * 部材（例: columns[].sectionDefId）が codeNormalization.js の rewrite（section なら
 * rewriteSectionRefs）で新キーへ書き換わるようにするため。移行しても参照側の据え置きが
 * 直らないのでは「読める」の意味が無い。
 *
 * QA指摘Major-2（ステップ14-S再指摘）: 移行後のキーが同じ束に既に存在する場合（例: 旧バグで
 * 負になった 'H-…' の隣に、利用者が手で正しく入れ直した 'H…' が既にある）は、
 * 既存の正常なエントリ（migrateが同一参照を返す＝未変更のエントリ）を優先し、移行した方は
 * 束に含めない（重複キーでvalidateBundleが例外を投げ、overlay全体がuntrustedになる方が実害が
 * 大きいため）。捨てた場合も migrated には積む（dropped:true を付ける。通知文で「既存を優先」と
 * 分かるようにする）。alias（旧キー→新キー）は捨てた場合も積む——参照は生き残った既存エントリへ
 * 向くようにするため（既存優先の結果と矛盾しない：newKeyは既存エントリのキーと同じ）。
 * @param {object} bundle
 * @returns {{ bundle: object, migrated: Array<{kind:string, from:object, to:object, dropped?:boolean}> }}
 */
export function migrateBundle(bundle) {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.catalogs)) return { bundle, migrated: [] };
  const knownKinds = new Set(listKinds());
  const migrated = [];
  let nextBundle = bundle;
  for (const [kind, entries] of Object.entries(bundle.catalogs)) {
    if (!knownKinds.has(kind) || !Array.isArray(entries)) continue;
    const def = kindDef(kind);
    if (typeof def.migrate !== 'function') continue;

    // 1st pass: 移行が不要（migrateが同一参照を返す）なエントリのキーを「既存キー集合」として
    // 予約する——束の中の並び順に関わらず、既存の正常なエントリを常に優先するため。
    const reservedKeys = new Set();
    for (const entry of entries) {
      if (def.migrate(entry) === entry) {
        try { reservedKeys.add(def.keyOf(entry)); } catch { /* keyOf失敗はvalidateBundleに委ねる */ }
      }
    }

    let changed = false;
    const nextEntries = [];
    for (const entry of entries) {
      const migratedEntry = def.migrate(entry);
      if (migratedEntry === entry) {
        nextEntries.push(entry);
        continue;
      }
      changed = true;
      let fromKey = null, toKey = null;
      try { fromKey = def.keyOf(entry); } catch { /* noop */ }
      try { toKey = def.keyOf(migratedEntry); } catch { /* noop */ }
      const dropped = toKey !== null && reservedKeys.has(toKey);
      if (dropped) {
        migrated.push({ kind, from: entry, to: migratedEntry, dropped: true });
      } else {
        nextEntries.push(migratedEntry);
        if (toKey !== null) reservedKeys.add(toKey); // 後続の同一キーへの移行はこちらを優先する
        migrated.push({ kind, from: entry, to: migratedEntry });
      }
      if (fromKey !== null && toKey !== null && fromKey !== toKey) {
        nextBundle = withAlias(nextBundle, kind, fromKey, toKey);
      }
    }
    if (changed) nextBundle = withEntries(nextBundle, kind, nextEntries);
  }
  return { bundle: nextBundle, migrated };
}

/**
 * migrateBundle の migrated[] 1件を日本語の移行通知文にする（catalogOverlayLoader.js・
 * storage/documentFile.js 共通の口。文言の組み立てを二重実装しない）。
 * keyOf が例外を投げる（壊れたエントリ等）場合はキー部分を「(キー不明)」にする。
 * dropped:true（QA指摘Major-2: 既存の正常なエントリを優先し移行結果を捨てた）は末尾に
 * 「既存を優先」を付記する。
 */
export function formatMigrationNotice({ kind, from, to, dropped }) {
  const def = kindDef(kind);
  const label = KIND_LABELS[kind] ?? kind;
  const keyOfSafe = entry => {
    try { return def.keyOf(entry); } catch { return '(キー不明)'; }
  };
  const base = `${label} ${keyOfSafe(from)} を ${keyOfSafe(to)} へ移行しました`;
  return dropped ? `${base}（既存を優先し、移行結果は破棄）` : base;
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
 * 複数の束を1つに統合する（IDBの種別ごとの束＝${projectId}:catalogs:<kind> レコード群 →
 * .stq エンベロープの単一 catalogs フィールドへの変換用。splitBundleByKind の逆）。
 * catalogs/aliases/encodings をそれぞれマージする。同じ種別が複数の束に含まれる場合は
 * 後勝ち（現状の呼び出し側は種別ごとに1つの束しか作らないため衝突しない）。
 */
export function mergeBundles(bundles) {
  let merged = emptyBundle();
  for (const bundle of bundles) {
    if (!bundle) continue;
    for (const [kind, entries] of Object.entries(bundle.catalogs ?? {})) {
      merged = withEntries(merged, kind, entries);
    }
    for (const [kind, table] of Object.entries(bundle.aliases ?? {})) {
      for (const [from, to] of Object.entries(table)) merged = withAlias(merged, kind, from, to);
    }
    merged = { ...merged, encodings: { ...merged.encodings, ...(bundle.encodings ?? {}) } };
  }
  return merged;
}

/**
 * 束を種別ごとに分割する（mergeBundles の逆）。IDBの種別ごとレコード保存
 * （${projectId}:catalogs:<kind>）用——1種別だけを含む束を種別数ぶん返す。
 * @returns {Map<string, object>} kind → その種別だけを含む束
 */
export function splitBundleByKind(bundle) {
  const result = new Map();
  for (const kind of Object.keys(bundle?.catalogs ?? {})) {
    let sub = withEntries(emptyBundle(), kind, bundleEntries(bundle, kind));
    const aliases = bundleAliases(bundle, kind);
    if (Object.keys(aliases).length > 0) sub = { ...sub, aliases: { [kind]: aliases } };
    const encoding = bundle.encodings?.[kind];
    if (encoding) sub = { ...sub, encodings: { [kind]: encoding } };
    result.set(kind, sub);
  }
  return result;
}

/**
 * ライブラリ衝突検出: overridesBuiltin の印が無いのに builtin と同キー・内容不一致の user エントリを検出する。
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
