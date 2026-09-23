// ================================================================
// カタログ保守パネル（ステップ5・ハンバーガー「カタログ保守」）の純ロジック。
//
// 第1段の範囲＝材料（material）の面材（panel）・仕上げ材（finish）のみ。
// 下地材（backing）は一覧に出所バッジ付きで表示してよいが、追加・編集・削除は不可。
//
// 純モジュール（葉）。同ディレクトリの兄弟モジュール（catalogKinds.js・catalogRegistry.js・
// catalogMatch.js・materialCode.js・catalogBundle.js・catalogCodec.js）にのみ依存する。
// .jsx / store.js を静的 import しない（catalogImports.test.js の許可リストに従う）。
// 永続化I/O（storage/db.js の saveUserCatalog）は commitUserEntries の呼び出し側が
// saveFn として注入する（catalogOverlayLoader.js と同じDI型。本ファイルはstorage/db.jsを
// 一切importしない）。
//
// builtin一覧（materialData.js の MATERIALS）は呼び出し側（CatalogMaintenancePanel.jsx）が
// パネルを開いたときに動的 import で読んで渡す——本ファイルは本体標準マスタを一切読まない。
// ================================================================

import { CatalogKind, kindDef, listKinds, KIND_LABELS } from './catalogKinds.js';
import { composeCatalog, composeList, docDiffMap, originOf, overlayFor, setOverlay } from './catalogRegistry.js';
import { assertNoDuplicate, displayNameOf, matchByContent } from './catalogMatch.js';
import { diffPairs } from './catalogDiffView.js';
import { nextSerial, parseMaterialCode, formatMaterialCode } from './materialCode.js';
import { emptyBundle, withEntries } from './catalogBundle.js';
import { encodeCatalogBundle } from './catalogCodec.js';

/** 材の役割（カテゴリ）。materialData.js の MATERIAL_CATEGORY と同じ3値
 * （本体マスタは静的 import できないため、ここでは値の集合だけを持つ）。 */
export const MATERIAL_CATEGORY = Object.freeze({
  BACKING: 'backing',
  PANEL:   'panel',
  FINISH:  'finish',
});

/** このパネルで追加・編集できるカテゴリ（第1段の範囲。下地材は対象外）。 */
export const EDITABLE_MATERIAL_CATEGORIES = Object.freeze([MATERIAL_CATEGORY.PANEL, MATERIAL_CATEGORY.FINISH]);

/** category が追加・編集可能（面材・仕上げ材）かどうか。 */
export function isEditableMaterialCategory(category) {
  return EDITABLE_MATERIAL_CATEGORIES.includes(category);
}

/**
 * 1行（材エントリ）が編集可能かどうか（QA指摘Major-A・2026-09-22）。
 * category が面材・仕上げ材以外（下地材）→ 不可。origin が 'builtin'・'doc' → 不可
 * （doc=文書同梱は解決順doc>userでdocが勝つため、userだけを更新しても一覧・解決結果に反映されず
 * 「保存しました」だけが出る黙って効かない状態になる——複製してユーザーライブラリの新規エントリに
 * してから編集する経路のみ許す）。origin が 'user'（またはまだ保存前＝null/undefined＝新規追加）
 * かつ編集可能categoryのときのみ ok:true。
 * @param {'doc'|'user'|'builtin'|null|undefined} origin
 * @param {string} category
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function canEditMaterialRow(origin, category) {
  if (!isEditableMaterialCategory(category)) {
    return { ok: false, reason: '下地材はこのパネルでは編集できません（一覧の表示のみ）' };
  }
  if (origin === 'builtin') {
    return { ok: false, reason: '標準材料の編集は未対応です（複製してから編集してください）' };
  }
  if (origin === 'doc') {
    return { ok: false, reason: '文書同梱の材料の編集は未対応です。複製してから編集してください' };
  }
  return { ok: true, reason: null };
}

/**
 * 厚さ入力欄の文字列をパースする（QA指摘Minor1）。前後の空白を除いてから空文字判定するため、
 * 空白だけの入力（'  '）が Number('  ')===0 に化けて意図せず厚さ0として保存される事故を防ぐ。
 * 空（トリム後）は null。それ以外は Number(...)（数値でなければ NaN——呼び出し側で弾く）。
 * @param {string} raw
 * @returns {number|null} 空ならnull、数値ならその値（不正な入力はNaN）
 */
export function parseThicknessInput(raw) {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? null : Number(trimmed);
}

/**
 * 種別タブの器（左タブ）。listKinds() から導出する——登録表に種別が増えたらタブも増える。
 * ステップ7d: 内装マスター・境界マスターは閲覧のみ（追加・複製・編集・削除なし）で enabled:true。
 * ステップ8h: 断面も閲覧のみで enabled:true（規格文字列の一括入力はステップ8iで別途着手）。
 * openingSubType は選択UIが無いためまだ enabled:false（「準備中」表示用）。
 */
const VIEWABLE_KINDS = Object.freeze([
  CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER, CatalogKind.SECTION,
]);

export function buildKindTabs() {
  return listKinds().map(kind => ({
    kind,
    label: KIND_LABELS[kind] ?? kind,
    enabled: VIEWABLE_KINDS.includes(kind),
  }));
}

/**
 * kind の一覧行（出所付き）。builtin一覧・overlay（catalogRegistry.jsの現在の状態）を
 * composeList/originOf で合成し、search（表示名またはキーの部分一致・大小文字区別なし）で
 * 絞り込む（ステップ8h: 断面は label が「H-300×150×6.5×9」、key が「STEEL-H300x150」のように
 * 呼び方が割れるため両方を対象にする。他種別でも害はないため共通の規則にする）。
 * diffMap（catalogRegistry.js の docDiffMap の戻り値）を渡すと、各行に R13 の差分情報
 * （{baseOrigin, diffFields, baseEntry}）を diff として付ける（省略時は null）。
 * category による絞り込みは material 専用のため持たない（buildMaterialRows 側で行う）。
 * @param {{ kind: string, builtinList: object[], search?: string, diffMap?: Map }} args
 * @returns {Array<{ entry: object, origin: 'doc'|'user'|'builtin'|null, diff: object|null }>}
 */
export function buildCatalogRows({ kind, builtinList, search = '', diffMap = null }) {
  const def = kindDef(kind);
  const needle = (search ?? '').trim().toLowerCase();
  return composeList(kind, builtinList)
    .map(entry => ({
      entry,
      origin: originOf(kind, def.keyOf(entry), builtinList),
      diff: diffMap?.get(def.keyOf(entry)) ?? null,
    }))
    .filter(row => (
      !needle
      || displayNameOf(row.entry).toLowerCase().includes(needle)
      || def.keyOf(row.entry).toLowerCase().includes(needle)
    ));
}

/**
 * 材の一覧行（出所付き）。buildCatalogRows(kind:material) の薄いラッパ——category（完全一致。
 * null/空なら絞り込みなし）による絞り込みだけ材専用にここへ残す。
 * @param {{ builtinList: object[], search?: string, category?: string|null, diffMap?: Map }} args
 * @returns {Array<{ entry: object, origin: 'doc'|'user'|'builtin'|null, diff: object|null }>}
 */
export function buildMaterialRows({ builtinList, search = '', category = null, diffMap = null }) {
  return buildCatalogRows({ kind: CatalogKind.MATERIAL, builtinList, search, diffMap })
    .filter(row => !category || row.entry.category === category);
}

/**
 * buildMaterialRows の戻り値から、R13の差分（diff）が付いている行だけを絞り込む
 * （ステップ6b「合わせ直す」一括対象の唯一の判定箇所。QA指摘Minor-1・2026-09-23:
 * CatalogMaintenancePanel.jsx に直書きされていた allRows.filter(r => r.diff) をこちらへ切り出し、
 * 単体テストできるようにする——一括ボタンは検索・カテゴリ絞り込みの影響を受けない
 * allRows（絞り込み前の全行）に対して呼ぶ契約）。
 * @param {ReturnType<typeof buildMaterialRows>} rows
 * @returns {ReturnType<typeof buildMaterialRows>}
 */
export function realignTargets(rows) {
  return rows.filter(row => row.diff);
}

/**
 * 採番用の既知コード集合（builtin＋ユーザーライブラリ＋文書同梱の全コード）。
 * @param {{ builtinList: object[], doc?: object[], user?: object[] }} args
 * @returns {Set<string>}
 */
export function collectKnownMaterialCodes({ builtinList, doc = [], user = [] }) {
  const codes = new Set();
  for (const list of [builtinList, doc, user]) {
    for (const entry of list ?? []) {
      if (typeof entry?.code === 'string') codes.add(entry.code);
    }
  }
  return codes;
}

/** major・minor の帯で空いている材料コードを1件採番する（表示専用。手入力不可）。 */
export function nextMaterialCode(major, minor, knownCodes) {
  return formatMaterialCode(major, minor, Number(nextSerial(major, minor, knownCodes)));
}

/**
 * フォーム入力から材エントリを組み立てる。x/yは面材・仕上げ材の規約どおり常に0固定
 * （materialData.js「面材・仕上げ材は寸法なし→0,0」と同じ）。
 * QA指摘Minor3（再指摘）: name/spec/noteの前後の空白を除く責務をこの関数1箇所に寄せる
 * （呼び出し側でtrimしてから渡す約束にすると、呼び出し側が増えたときにtrimし忘れが起こる）。
 */
export function buildMaterialEntry({ code, name, spec = '', thickness = null, note = '', category }) {
  return { code, name: name.trim(), spec: spec.trim(), x: 0, y: 0, thickness, note: note.trim(), category };
}

/**
 * 複製元エントリと同内容・新コードのエントリを組み立てる（複製）。
 * dedupeFields（name/spec/x/y/thickness）が複製元と一致するため、名称を変えるまでは
 * validateMaterialEntry がR17で拒否する（意図した挙動。呼び出し側は保存前に必ず
 * validateMaterialEntry を通すこと）。
 */
export function duplicateMaterialEntry(sourceEntry, knownCodes) {
  const parsed = parseMaterialCode(sourceEntry?.code);
  if (!parsed) throw new Error(`複製元の材料コードが不正です: ${sourceEntry?.code}`);
  const code = nextMaterialCode(parsed.major, parsed.minor, knownCodes);
  return { ...sourceEntry, code };
}

/**
 * 保存前検証: (1) カテゴリが編集可能（panel/finish）であること、(2) kindDef('material').validate、
 * (3) assertNoDuplicate（R17。builtinList から合成した全エントリに対して検査）。
 * 失敗は日本語メッセージで返す（例外を投げない——フォーム表示用）。
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateMaterialEntry(entry, builtinList) {
  if (!isEditableMaterialCategory(entry?.category)) {
    return {
      ok: false,
      message: `このカテゴリの材料はここでは編集できません（面材・仕上げ材のみ）: ${entry?.category}`,
    };
  }
  const def = kindDef(CatalogKind.MATERIAL);
  try {
    def.validate(entry);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const merged = composeList(CatalogKind.MATERIAL, builtinList);
  try {
    assertNoDuplicate(CatalogKind.MATERIAL, entry, merged);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  return { ok: true };
}

/** ユーザーライブラリ配列へ追加・更新する（kindDef(kind).keyOfが同じなら上書き）。非破壊。 */
export function upsertUserCatalogEntry(kind, userEntries, entry) {
  const def = kindDef(kind);
  const key = def.keyOf(entry);
  const idx = userEntries.findIndex(e => def.keyOf(e) === key);
  if (idx === -1) return [...userEntries, entry];
  const next = [...userEntries];
  next[idx] = entry;
  return next;
}

/** upsertUserCatalogEntry(material, ...) の薄いラッパ（既存呼び出し・テストを変えない）。 */
export function upsertUserMaterialEntry(userEntries, entry) {
  return upsertUserCatalogEntry(CatalogKind.MATERIAL, userEntries, entry);
}

/**
 * ユーザーライブラリから1件外す（削除）。裁定: 削除はユーザーライブラリから外すだけの操作——
 * origin が 'user' 以外（builtin・doc）は削除不可で例外を投げる（文書同梱分は参照が無くなるまで
 * 残る＝この操作の対象外。builtin はそもそも削除できない）。
 */
export function removeUserMaterialEntry(userEntries, code, origin) {
  if (origin !== 'user') {
    throw new Error('ユーザーライブラリのエントリ以外は削除できません（builtin・文書同梱は対象外）');
  }
  return userEntries.filter(e => e.code !== code);
}

/**
 * ユーザーライブラリ（catalogsストア `user:<kind>` レコード）として保存する束を組み立てる
 * （catalogOverlayLoader.js が読む形と同じ: {version, catalogs:{<kind>:[…]}, encodings:{<kind>:'json'}, aliases:{}}）。
 * バイト列化（encodeCatalogBundle）・実際の永続化（storage/db.js saveUserCatalog）は
 * 呼び出し側（commitUserEntries）が行う。
 */
export function buildUserCatalogBundle(kind, userEntries) {
  let bundle = withEntries(emptyBundle(), kind, userEntries);
  bundle = {
    ...bundle,
    encodings: { ...bundle.encodings, [kind]: kindDef(kind).encoding },
  };
  return bundle;
}

/** buildUserCatalogBundle(material, ...) の薄いラッパ（既存呼び出し・テストを変えない）。 */
export function buildUserMaterialBundle(userEntries) {
  return buildUserCatalogBundle(CatalogKind.MATERIAL, userEntries);
}

/**
 * ユーザーライブラリの更新（追加・編集・削除で共通）を1箇所にまとめる（QA指摘Minor・再指摘:
 * CatalogMaintenancePanel.jsxに直書きされていたoverlay更新→encode→永続化→ロールバックの手順を
 * こちらへ移し、永続化I/O（storage/db.js saveUserCatalog）は saveFn として呼び出し側に注入させる
 * ——catalogOverlayLoader.js の loadDocumentCatalogs/loadUserCatalogs と同じDI型（本ファイルは
 * storage/db.js を静的importしない。catalogImports.test.js の許可リストに従う）。
 *
 * 手順: (1) overlay の user を nextUser へ更新 (2) saveFn(kind, bytes) で永続化
 * (3) 失敗（saveFnがreject）した場合は overlay の user を prevUser へ戻してから、
 * 同じ例外を再throwする（黙って握りつぶさない。呼び出し側がメッセージを利用者へ出せるように）。
 * 成功時は overlay は nextUser のまま。
 *
 * ステップ7d: kind を必須引数にした（省略時material固定をやめる。reconcileIncomingCatalogsが
 * 種別ループでinteriorMaster・boundaryMasterぶんも呼ぶため）。
 * @param {string} kind
 * @param {object[]} nextUser 保存後のユーザーライブラリ配列
 * @param {object[]} prevUser 失敗時に戻す元のユーザーライブラリ配列
 * @param {{ saveFn: (kind: string, bytes: Uint8Array) => Promise<void> }} deps
 * @returns {Promise<void>}
 */
export async function commitUserEntries(kind, nextUser, prevUser, { saveFn }) {
  const { doc } = overlayFor(kind);
  setOverlay(kind, { doc, user: nextUser });
  try {
    await saveFn(kind, encodeCatalogBundle(buildUserCatalogBundle(kind, nextUser)));
  } catch (e) {
    setOverlay(kind, { doc, user: prevUser }); // 保存失敗はoverlayを戻す
    throw e;
  }
}

/**
 * ステップ6b（4.7 合わせ直し）: 文書同梱材を本体（catalogRegistry.js docDiffMap の
 * baseOrigin='user'|'builtin'の内容）に合わせ直す差分プラン（純関数。I/Oしない）。
 * key が文書同梱（doc）に無ければ日本語例外。差分が無ければ ok:false——このとき同キーの
 * user/builtinエントリの有無で理由を分ける（QA指摘Minor-3・2026-09-23）:
 *   - 同キーのuser/builtinが有る（=docDiffMap側で比較済み・内容が一致） → reason:'本体と同じ内容です'
 *   - 同キーのuser/builtinが無い（=新規追加材。docDiffMapは比較相手が無いため最初から対象外）
 *     → reason:'相手なし（合わせ直す先の本体エントリがありません）'
 * 差分があれば { ok: true, diffPairs, baseOrigin, baseEntry }——diffPairs は catalogDiffView.js の
 * diffPairs（[{field,label,from,to}]）で from=doc（現在の同梱内容）・to=baseEntry
 * （合わせ直す先の本体内容）（例:「厚 15 → 12.5」）。
 * 実際に doc から外す（removeDocEntry）・永続化は呼び出し側の責務——本関数はプランのみ返す。
 * @param {string} kind
 * @param {string} key
 * @param {{ builtinList: object[] }} args
 * @returns {{ ok: true, diffPairs: object[], baseOrigin: 'user'|'builtin', baseEntry: object }
 *         | { ok: false, reason: string }}
 */
/** ステップ8i: 一括入力の衝突行の理由文言に使う出所ラベル（ui/CatalogMaintenancePanel.jsxのORIGIN_LABELSと同じ日本語）。 */
const SECTION_IMPORT_ORIGIN_LABELS = Object.freeze({ doc: '同梱', user: 'ライブラリ', builtin: '標準' });

/**
 * ステップ8i（規格文字列の一括入力）: 断面の規格文字列（一括）から追加するエントリのプランを
 * 組み立てる純関数（I/Oしない）。specText の解析自体は structural/sectionCatalog.js の
 * parseSectionSpecList が担う——catalog/*.js は本体標準マスタ（structural/sectionCatalog.js含む）を
 * 静的importできない不変条件（catalogImports.test.js）のため、呼び出し側が parseSpecList として
 * 注入する（commitUserEntriesのsaveFnと同じDI型。「純関数（I/Oしない）」の契約上、本関数の中では
 * import(...)しない）。
 *
 * 手順: (1) parseSpecList(specText) で解析（解釈できない行はerrors） (2) 各エントリを
 * kindDef(section).validate（parseSpecListが返す形が壊れていないかの保険） (3) 既存キー
 * （builtin+user+doc合成後。composeCatalogは常に最新のoverlay状態=overlayFor(kind)を読む）と
 * 衝突する行は「既にあります（出所）」でskippedへ（builtinと同キーの編集はこのパネルでは不可——
 * ステップ12。上書きしない） (4) キーが違っても内容（matchFields）完全一致なら同じく
 * 「既にあります（出所）」でskippedへ（QA指摘Minor-B1・2026-09-23: 角形鋼管はキーに板厚の文字列
 * 表現をそのまま使うため、'□250×250×9' と builtin の 'STEEL-SQ250x250x9.0' のように内容が
 * 同一でもキーが別になりうる——catalogMatch.jsのmatchByContent（既存のR14照合ロジック。
 * 二重実装しない）で exact 判定できた行は、一致先エントリの出所を理由に添えて除外する）。
 * (5) 残りをtoAddへ。
 * @param {string} specText
 * @param {{ builtinList: object[], parseSpecList: (specText: string) => { entries: object[], errors: Array<{line:string, reason:string}> } }} args
 * @returns {{ toAdd: object[], skipped: Array<{line:string, reason:string}>, errors: Array<{line:string, reason:string}> }}
 */
export function planBulkSectionImport(specText, { builtinList, parseSpecList }) {
  const def = kindDef(CatalogKind.SECTION);
  const { entries, errors: parseErrors } = parseSpecList(specText);
  const errors = [...parseErrors];
  const merged = composeCatalog(CatalogKind.SECTION, builtinList);
  const mergedEntries = [...merged.values()];

  const toAdd = [];
  const skipped = [];
  // ステップ9c QA指摘Minor-1: 同じ入力内で同一キー（H形鋼はキーに板厚を含まないため別内容でも同キーになりうる）
  // になる2行目以降は skipped へ回す。残すと toAdd に同キーが並び、プレビュー（先頭）と登録（upsert で末尾）が食い違う。
  const seenKeys = new Set();
  for (const entry of entries) {
    try {
      def.validate(entry);
    } catch (e) {
      errors.push({ line: entry.label ?? entry.key ?? '(不明)', reason: e.message });
      continue;
    }
    const key = def.keyOf(entry);
    if (merged.has(key)) {
      const origin = originOf(CatalogKind.SECTION, key, builtinList) ?? 'builtin';
      skipped.push({ line: entry.label, reason: `既にあります（${SECTION_IMPORT_ORIGIN_LABELS[origin] ?? origin}）` });
      continue;
    }
    if (seenKeys.has(key)) {
      skipped.push({ line: entry.label, reason: `同じ入力内で重複しています（${key}）` });
      continue;
    }
    // QA指摘Minor-B1: キーが違っても内容（matchFields）完全一致なら重複として除外する（toAdd 済みの行も相手に含める）。
    const { exact, hits } = matchByContent(CatalogKind.SECTION, entry, [...mergedEntries, ...toAdd]);
    if (exact && hits.length > 0) {
      const hitKey = def.keyOf(hits[0]);
      const origin = merged.has(hitKey) ? (originOf(CatalogKind.SECTION, hitKey, builtinList) ?? 'builtin') : null;
      skipped.push({
        line: entry.label,
        reason: origin ? `既にあります（${SECTION_IMPORT_ORIGIN_LABELS[origin] ?? origin}）` : `同じ入力内で重複しています（${hitKey}）`,
      });
      continue;
    }
    seenKeys.add(key);
    toAdd.push(entry);
  }
  return { toAdd, skipped, errors };
}

export function planRealign(kind, key, { builtinList }) {
  const def = kindDef(kind);
  const { doc, user } = overlayFor(kind);
  const docEntry = doc.find(e => def.keyOf(e) === key);
  if (!docEntry) throw new Error(`文書同梱に無いキーです: ${key}`);
  const diff = docDiffMap(kind, builtinList).get(key);
  if (!diff) {
    const hasPartner = user.some(e => def.keyOf(e) === key) || (builtinList ?? []).some(e => def.keyOf(e) === key);
    return hasPartner
      ? { ok: false, reason: '本体と同じ内容です' }
      : { ok: false, reason: '相手なし（合わせ直す先の本体エントリがありません）' };
  }
  return {
    ok: true,
    diffPairs: diffPairs(kind, docEntry, diff.baseEntry, diff.diffFields),
    baseOrigin: diff.baseOrigin,
    baseEntry: diff.baseEntry,
  };
}
