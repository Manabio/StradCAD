// ================================================================
// カタログ保守パネル（ステップ5・ハンバーガー「カタログ保守」）の純ロジック。
//
// 第1段の範囲＝材料（material）の面材（panel）・仕上げ材（finish）のみ。
// 下地材（backing）は一覧に出所バッジ付きで表示してよいが、追加・編集・削除は不可。
//
// 純モジュール（葉）。同ディレクトリの兄弟モジュール（catalogKinds.js・catalogRegistry.js・
// catalogMatch.js・materialCode.js・catalogBundle.js・catalogCodec.js・usedEntries.js）に
// のみ依存する。.jsx / store.js を静的 import しない（catalogImports.test.js の許可リストに従う）。
// 永続化I/O（storage/db.js の saveUserCatalog）は commitUserEntries の呼び出し側が
// saveFn として注入する（catalogOverlayLoader.js と同じDI型。本ファイルはstorage/db.jsを
// 一切importしない）。
//
// builtin一覧（materialData.js の MATERIALS）は呼び出し側（CatalogMaintenancePanel.jsx）が
// パネルを開いたときに動的 import で読んで渡す——本ファイルは本体標準マスタを一切読まない。
// ================================================================

import { CatalogKind, kindDef, listKinds, KIND_LABELS } from './catalogKinds.js';
import {
  appendDocEntry, composeCatalog, composeList, docDiffMap, originOf, overlayFor, removeDocEntry, setOverlay,
} from './catalogRegistry.js';
import { assertNoDuplicate, displayNameOf, matchByContent, valuesEqual } from './catalogMatch.js';
import { diffPairs, fieldLabel } from './catalogDiffView.js';
import { nextSerial, parseMaterialCode, formatMaterialCode } from './materialCode.js';
import { emptyBundle, withEntries } from './catalogBundle.js';
import { encodeCatalogBundle } from './catalogCodec.js';
import { stripOverridesBuiltin } from './usedEntries.js';

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
 * ステップ10f: 建具種別（openingSubType）も同じ閲覧のみで enabled:true（姿図プレビュー付き。
 * 追加・編集・削除はステップ12）。これで登録表の全種別が enabled:true になる。
 */
const VIEWABLE_KINDS = Object.freeze([
  CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER, CatalogKind.SECTION,
  CatalogKind.OPENING_SUB_TYPE,
]);

export function buildKindTabs() {
  return listKinds().map(kind => ({
    kind,
    label: KIND_LABELS[kind] ?? kind,
    enabled: VIEWABLE_KINDS.includes(kind),
  }));
}

/**
 * ステップ10f: 閲覧タブ（ui/CatalogMaintenancePanel.jsx の ReadonlyKindTab）の詳細欄で、
 * READONLY_KIND_FIELDS の値を読み取り専用表示用の文字列にする汎用の整形（.jsx側に判断を
 * 残さない——catalogDiffView.js の diffTooltip/formatFieldValue と同じく、表示整形ロジックは
 * catalog/*.js 側に置く）。
 * - 未設定（null/undefined/空文字）は「（未設定）」。
 * - 配列は要素を「・」で連結する。例: openingSubType の wallKinds=['interior','exterior']
 *   → 'interior・exterior'。
 *   QA指摘Minor-3（2026-09-23）: 要素にオブジェクトを含む配列は、要素境界が読めるよう
 *   各要素を「〔…〕」で包み「／」で連結する（プリミティブ配列と同じ「・」区切りのままだと
 *   親（plainオブジェクト）の「・」と衝突し、要素の切れ目が読めなくなるため）。例:
 *   slideLayout.panels=[{arrow:'neg'},{fix:true}] → '〔arrow:neg〕／〔fix:true〕'。
 * - plainオブジェクトは「key:value」を「・」で連結する。例: openingSubType の
 *   slideLayout={tracks:2, panels:[{arrow:'neg'},{fix:true}]} →
 *   'tracks:2・panels:〔arrow:neg〕／〔fix:true〕'（panelsは要素にオブジェクトを含む配列のため
 *   上の規則で「〔…〕／」区切りに開く）。
 * - 空配列・空オブジェクトは「（なし）」。
 * layers（境界マスター）・fields（境界マスター）は ui/CatalogMaintenancePanel.jsx 側に既に
 * 個別のフォーマット（formatLayerLine等）があるため、この関数はそれ以外の項目
 * （openingSubType の wallKinds/slideLayout 等）向けの汎用フォールバックとして使う。
 * @param {*} value
 * @returns {string}
 */
export function formatReadonlyValue(value) {
  if (value === null || value === undefined || value === '') return '（未設定）';
  if (Array.isArray(value)) {
    if (value.length === 0) return '（なし）';
    const hasObjectElement = value.some(v => v !== null && typeof v === 'object' && !Array.isArray(v));
    return hasObjectElement
      ? value.map(v => `〔${formatReadonlyValue(v)}〕`).join('／')
      : value.map(formatReadonlyValue).join('・');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length > 0 ? entries.map(([k, v]) => `${k}:${formatReadonlyValue(v)}`).join('・') : '（なし）';
  }
  return String(value);
}

// ステップ10f QA指摘Minor-2（2026-09-23）: category値→表示名の対応を種別ごとにここへ集約する
// （ui/CatalogMaintenancePanel.jsx側にあったCATEGORY_LABELS（material用）・
// OPENING_CATEGORY_LABELS（openingSubType用）の重複定義をやめ、ここへ委譲させる。
// formatReadonlyFieldValueのcategory分岐がkindを見ずに動いていたため、材料にopeningSubType用の
// 対応表が誤って効く／その逆の衝突があった——kindごとに分けて持つことで解消する）。
const CATEGORY_LABELS_BY_KIND = Object.freeze({
  [CatalogKind.MATERIAL]: Object.freeze({
    [MATERIAL_CATEGORY.PANEL]:   '面材',
    [MATERIAL_CATEGORY.FINISH]:  '仕上げ材',
    [MATERIAL_CATEGORY.BACKING]: '下地材',
  }),
  [CatalogKind.OPENING_SUB_TYPE]: Object.freeze({ fitting: '建具', window: '窓' }),
});

/**
 * category値の表示名（kindごとの対応表から引く）。対応表に無い種別・値は
 * formatReadonlyValue(value) にフォールバックする（未知の値でも投げない）。
 * @param {string} kind
 * @param {*} value
 * @returns {string}
 */
export function formatCategoryLabel(kind, value) {
  return CATEGORY_LABELS_BY_KIND[kind]?.[value] ?? formatReadonlyValue(value);
}

/**
 * QA指摘M2（2026-09-24再報告）: userエントリ（overlay.userの該当key。無ければ呼び出し側の
 * 責任でnull）が「builtinの上書き」として扱われるべきかどうかの唯一の判定式。
 * overridesBuiltinフラグ（planSaveEntryが付ける）を優先し、フラグが無い場合（例: 旧データ・
 * 明示的にフラグを付けずoverlayへ直接setOverlayしたテスト等）でも、keyがbuiltinにも存在すれば
 * 上書き扱いにする——同じkeyのuserエントリはbuiltinを構造的に上書きするため（同一keyは
 * 同一エンティティという登録表全体の前提。catalogRegistry.js resolveCatalogのdoc>user>builtin
 * 解決順もこの前提の上に成り立つ）。buildCatalogRows（badge判定）・rowEditState（override/
 * doc-override状態の判定）の両方がこの1つの式を共有する。
 * @param {object|null} userEntry
 * @param {boolean} keyIsBuiltin
 * @returns {boolean}
 */
function isBuiltinOverride(userEntry, keyIsBuiltin) {
  return Boolean(userEntry?.overridesBuiltin) || Boolean(keyIsBuiltin);
}

/**
 * kind の一覧行（出所付き）。builtin一覧・overlay（catalogRegistry.jsの現在の状態）を
 * composeList/originOf で合成し、search（表示名またはキーの部分一致・大小文字区別なし）で
 * 絞り込む（ステップ8h: 断面は label が「H-300×150×6.5×9」、key が「STEEL-H300x150」のように
 * 呼び方が割れるため両方を対象にする。他種別でも害はないため共通の規則にする）。
 * diffMap（catalogRegistry.js の docDiffMap の戻り値）を渡すと、各行に R13 の差分情報
 * （{baseOrigin, diffFields, baseEntry}）を diff として付ける（省略時は null）。
 * category による絞り込みは material 専用のため持たない（buildMaterialRows 側で行う）。
 * ステップ12a: 各行に `overridesBuiltin`（userエントリがbuiltin同キーの上書きとして保存されたもの
 * かどうか。true=バッジ「標準を編集」の対象）・`builtinEntry`（builtinの同キーentryか無ければnull。
 * フォームで本体の値を併記するのに使う）を付ける。
 * @param {{ kind: string, builtinList: object[], search?: string, diffMap?: Map }} args
 * @returns {Array<{ entry: object, origin: 'doc'|'user'|'builtin'|null, diff: object|null,
 *                    overridesBuiltin: boolean, builtinEntry: object|null }>}
 */
export function buildCatalogRows({ kind, builtinList, search = '', diffMap = null }) {
  const def = kindDef(kind);
  const needle = (search ?? '').trim().toLowerCase();
  const builtinByKey = new Map(builtinList.map(e => [def.keyOf(e), e]));
  // QA指摘M2（2026-09-24再報告）: overridesBuiltinの唯一の出所を「userライブラリの同キー
  // エントリ」にする（resolveした行のentryのoverridesBuiltinだけを見ると、doc起源の行
  // （entry=docのエントリ。docへ保存時にstripOverridesBuiltinで印を落とす規約——usedEntries.js）
  // では常にfalseになり、標準を上書きした材が文書に同梱された瞬間バッジ・「標準に戻す」経路が
  // 消える。userの同キーエントリを別途引いてisBuiltinOverrideで判定する——rowEditStateの
  // doc-override判定と同じ式（下記isBuiltinOverride）を共有する。
  const { user } = overlayFor(kind);
  const userByKey = new Map(user.map(e => [def.keyOf(e), e]));
  return composeList(kind, builtinList)
    .map(entry => {
      const key = def.keyOf(entry);
      const userEntry = userByKey.get(key) ?? null;
      return {
        entry,
        origin: originOf(kind, key, builtinList),
        diff: diffMap?.get(key) ?? null,
        overridesBuiltin: Boolean(userEntry) && isBuiltinOverride(userEntry, builtinByKey.has(key)),
        builtinEntry: builtinByKey.get(key) ?? null,
      };
    })
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
 *
 * ステップ12b QA指摘n1（12c申し送り・2026-09-24再報告）: x/y:0固定は「面材・仕上げ材は寸法なし」
 * という第1段（面材・仕上げ材のみ）専用の割り切り。12cで下地材カテゴリを開放すると、間柱コード
 * （WOOD_STUD_CODE_BY_SIZE）行はmaterialExtraLockedFieldsでx/y/thicknessがロックされるため、
 * この関数のままx/yを0で組み立てると「元のx/yから変えていないのにロック違反で拒否される」
 * 事故になる——12cでは下地材カテゴリのときだけフォームから元entryのx/yを引き継ぐ分岐を追加
 * すること（この関数を下地材向けに複製しない。カテゴリ分岐をこの関数へ足すか、下地材専用の
 * 組み立て関数を別途置くかは12c設計時に判断する）。
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

// ================================================================
// ステップ12a（本体編集＝builtinの上書き。5種別共通の純ロジック 1.1〜1.3）。
// 決定（設計 2026-09-23・裁定済み）: 本体の編集は新しい仕組みを作らず「同キーのuserエントリ＋
// overridesBuiltin:true」で表す（4.2/4.4。catalogBundle.js detectLibraryConflicts・
// resolveQueue.js markOverrideは実装済み）。保存済み文書は使用中エントリをdocとして同梱し
// doc>userで解決されるため、使用中の行はほぼ「出所doc」になる——doc-same（差分なし・相手あり）
// の編集（確認のうえ同梱を外して即反映）が無いとbuiltin行だけ編集可では実質編集できない。
// ================================================================

/**
 * ステップ12a（1.1）: 行（buildCatalogRowsの1行）の編集可否・状態を判定する（Q-B確定
 * 2026-09-23。doc-overrideはQA指摘M2・2026-09-24再報告で追加）。builtin（編集=上書き・複製）／
 * override（userでbuiltin同キー＝標準を編集した状態: 編集・標準に戻す・複製）／user（編集・
 * 削除・複製）／doc-override（文書同梱の相手＝userエントリがbuiltinの上書き（isBuiltinOverride）:
 * doc-sameの特殊形。編集・標準に戻す・複製。M2: 標準を編集した材が文書保存でdocへ同梱されると
 * 普通のdoc-sameに落ちてバッジ・「標準に戻す」が消える穴を塞ぐ）／doc-same（文書同梱が相手
 * （userかbuiltin。ただし上書きではない）と差分なし: 編集・複製）／doc-diff（文書同梱が相手と
 * 不一致: 編集不可・複製のみ）／doc-only（相手（userもbuiltinも）が無い: 編集不可・複製のみ）の
 * 7状態。
 * doc-same/doc-diff/doc-only/doc-override の判定は diffMap（catalogRegistry.js docDiffMapの
 * 戻り値。省略時は row.diffで代用）と「相手（userかbuiltin）があるか」で行う——docDiffMapは
 * 「相手が無い」場合と「相手はあるが内容が同じ」場合をどちらも戻り値（Map）から除外する
 * （比較不能／差分なしを戻り値だけからは区別できない）ため、相手の有無は overlayFor(kind).user と
 * builtinKeys で別途判定する（planRealignのhasPartner判定と同型。overlayFor読み出しは同ファイル
 * 内の既存関数（planRealign・commitUserEntries等）と同じ許容パターン——モジュールスコープの
 * 現在状態を読むだけで外部I/Oはしない）。
 * @param {string} kind
 * @param {{ entry: object, origin: 'doc'|'user'|'builtin'|null, diff: object|null }} row buildCatalogRowsの1行
 * @param {{ builtinKeys?: Set<string>, diffMap?: Map }} args
 * @returns {{ state: 'builtin'|'override'|'user'|'doc-override'|'doc-same'|'doc-diff'|'doc-only',
 *             canEdit: boolean, canRevert: boolean, canDelete: boolean, canDuplicate: boolean,
 *             reason: string|null }}
 */
export function rowEditState(kind, row, { builtinKeys = new Set(), diffMap = null } = {}) {
  const def = kindDef(kind);
  const key = def.keyOf(row.entry);
  const origin = row.origin;

  if (origin === 'builtin') {
    return { state: 'builtin', canEdit: true, canRevert: false, canDelete: false, canDuplicate: true, reason: null };
  }
  if (origin === 'user') {
    const isOverride = isBuiltinOverride(row.entry, builtinKeys.has(key));
    return isOverride
      ? { state: 'override', canEdit: true, canRevert: true, canDelete: false, canDuplicate: true, reason: null }
      : { state: 'user', canEdit: true, canRevert: false, canDelete: true, canDuplicate: true, reason: null };
  }
  if (origin === 'doc') {
    const diff = diffMap ? (diffMap.get(key) ?? null) : (row.diff ?? null);
    if (diff) {
      return {
        state: 'doc-diff', canEdit: false, canRevert: false, canDelete: false, canDuplicate: true,
        reason: '文書の内容が本体と異なります。合わせ直すか複製してください',
      };
    }
    const { user } = overlayFor(kind);
    const userEntry = user.find(e => def.keyOf(e) === key) ?? null;
    // QA指摘M2（2026-09-24再報告）: 標準を上書きしたuserエントリが、たまたま文書にも同梱
    // されている（doc-sameの特殊形）行は 'doc-override' にする——文書保存のたびに
    // バッジ「標準を編集」・「標準に戻す」の経路が消えるのを防ぐ（M2の症状そのもの）。
    // userEntryが無ければ（builtinKeys.has(key)だけでisBuiltinOverrideがtrueになるケース＝
    // 「userの上書きは無いがdoc内容がたまたまbuiltinと一致」）doc-overrideにはしない
    // （戻す先の上書きが実在しない）。
    if (userEntry && isBuiltinOverride(userEntry, builtinKeys.has(key))) {
      return { state: 'doc-override', canEdit: true, canRevert: true, canDelete: false, canDuplicate: true, reason: null };
    }
    const hasPartner = builtinKeys.has(key) || Boolean(userEntry);
    return hasPartner
      ? { state: 'doc-same', canEdit: true, canRevert: false, canDelete: false, canDuplicate: true, reason: null }
      : {
        state: 'doc-only', canEdit: false, canRevert: false, canDelete: false, canDuplicate: true,
        reason: '文書にのみ存在します（複製してください）',
      };
  }
  throw new Error(`行の出所が不正です（kind:${kind}）: ${origin}`);
}

/**
 * ステップ12a（1.2 固定項目）: kindDef(kind).keyBoundFields（出所を問わず常に固定）∪
 * （builtinKeys に key が含まれていれば kindDef(kind).overrideLockedFields も追加＝builtinの
 * 上書きだけに掛かる固定）∪ extraLocked（間柱6コード等、呼び出し側の文脈でだけ追加固定したい
 * 項目。例: 間柱の材コードはx/y/thicknessも固定——conformWoodBackingが柱寸からコードを選ぶため）。
 * @param {string} kind
 * @param {string} key
 * @param {{ builtinKeys?: Set<string>, extraLocked?: string[] }} args
 * @returns {Set<string>}
 */
export function lockedFieldsFor(kind, key, { builtinKeys = new Set(), extraLocked = [] } = {}) {
  const def = kindDef(kind);
  const locked = new Set(def.keyBoundFields ?? []);
  if (builtinKeys.has(key)) {
    for (const f of def.overrideLockedFields ?? []) locked.add(f);
  }
  for (const f of extraLocked) locked.add(f);
  return locked;
}

/**
 * ステップ12a（1.3）: rowEditStateの状態のうち「既存行の編集」を表す5つ（doc-same/doc-override/
 * override/user/builtin。doc-diff/doc-onlyは編集不可なのでplanSaveEntryに来る想定が無い。
 * doc-overrideはQA指摘M2・2026-09-24再報告で追加）。
 * QA指摘Minor-2（2026-09-24再報告）: これらの状態のときはprevEntry必須——省略されると
 * 固定項目検査（lockedFieldsFor）が丸ごと素通りしてしまう（`if (prevEntry)`が偽になるため）。
 */
const EXISTING_ROW_STATES = Object.freeze(['doc-same', 'doc-override', 'override', 'user', 'builtin']);

/**
 * ステップ12a（1.3）/QA指摘M1（2026-09-24再報告）: rowStateが「文書同梱を外して即反映」を
 * 要する状態（doc-same・doc-override）かどうか。Q-Cの確認ダイアログ・removeDocKey/confirmPairs
 * の算出で共有する唯一の判定（doc-overrideをdoc-sameと個別に書くと片方だけ直す退行が起きる）。
 */
function needsDocStrip(rowState) {
  return rowState === 'doc-same' || rowState === 'doc-override';
}

/**
 * ステップ12b QA指摘m4（2026-09-24再報告・jsxLockedCat）: 固定項目の拒否メッセージの唯一の
 * 定義箇所。planSaveEntryの内部拒否と、呼び出し側（.jsx）が同じ項目をUI上でdisabled化する
 * ときのツールチップ文言の両方がここを参照する——文言のズレ・.jsx側での再実装を防ぐ。
 * @param {string} kind
 * @param {string} field
 * @returns {string}
 */
export function lockedFieldReason(kind, field) {
  return `${fieldLabel(kind, field)}は変更できません（複製してください）`;
}

/**
 * ステップ12a（1.3 本体編集の保存プラン）: (0) rowStateがEXISTING_ROW_STATES（既存行の編集）
 * なのにprevEntryが省略されていれば拒否（QA指摘Minor-2） (1) 固定項目
 * （lockedFieldsFor。加えてkeyOf自体の一致——QA指摘Nit-2: valuesEqualは文字列をtrimして
 * 比較するため前後空白だけの差はここでは素通りしうるが、keyOfの生の文字列比較なら捕まる）が
 * prevEntryから変わっていれば拒否（lockedFieldReason(kind, field)。prevEntry省略＝新規追加は
 * 対象外） (1.5) QA指摘m1（2026-09-24再報告）: prevEntryとentryに1項目も差分が無ければ
 * （diffPairs(kind, prevEntry, entry)が空）、これ以降の検証・書込みを一切せず
 * { ok: true, noop: true } だけを返す——builtin行の「変更せず保存」が無意味な同内容user上書きを
 * 作る事故、doc-same/doc-override行の「変更せず保存」が確認なしに同梱を外してしまう事故を防ぐ
 * （.jsx側はnoop:trueのとき「変更はありません」を出し、applyCatalogEditPlanを呼ばない）。
 * (2) kindDef(kind).validate (3) R17（dedupeFieldsを持つ種別のみ。現状material）
 * assertNoDuplicate (4) builtin同キーならoverridesBuiltin:trueを付与（無ければ項目自体を持たせ
 * ない＝usedEntries.buildDocumentBundleが同梱から除去するのと対の規約）→
 * upsertUserCatalogEntry。rowStateがneedsDocStrip（doc-same/doc-override）なら
 * removeDocKey=key・confirmPairs=diffPairs(kind, prevEntry, entry)（Q-C: 使用中の材・記号を
 * 編集するとき確認のうえ同梱を外して即反映。from=doc現在値・to=編集後の値）。
 * QA指摘m4（2026-09-24再報告・jsxOverride/jsxThick/jsxConfirm）: 呼び出し側（.jsx）が
 * 再計算せずに済むよう、判断そのもの（builtin同キーかどうか・厚さが変わったか・確認が要るか）
 * を戻り値へ含める——overridesBuiltin（builtinKeys.has(key)。保存後メッセージの「他の文書は
 * 合わせ直すまで変わりません」表示の判定に使う）・thicknessChanged（prevEntry.thickness !==
 * entry.thickness。material専用の項目だが他種別ではthicknessが常にundefinedのため無害）・
 * needsConfirm（needsDocStrip(rowState) && confirmPairs.length > 0。Q-C確認ダイアログの
 * 要否）。
 * @param {string} kind
 * @param {object} entry 編集後のエントリ（keyBoundFields込みでフォームから組み立てたもの）
 * @param {{ builtinList?: object[], rowState?: string|null, prevEntry?: object|null, extraLocked?: string[] }} args
 * @returns {{ ok: true, noop: true }
 *         | { ok: true, noop: false, nextUser: object[], removeDocKey: string|null, confirmPairs: object[],
 *             overridesBuiltin: boolean, thicknessChanged: boolean, needsConfirm: boolean }
 *         | { ok: false, message: string }}
 */
export function planSaveEntry(kind, entry, { builtinList = [], rowState = null, prevEntry = null, extraLocked = [] } = {}) {
  const def = kindDef(kind);
  const key = def.keyOf(entry);
  const builtinKeys = new Set(builtinList.map(e => def.keyOf(e)));

  if (EXISTING_ROW_STATES.includes(rowState) && !prevEntry) {
    return { ok: false, message: '編集元の項目が指定されていません' };
  }

  if (prevEntry) {
    const locked = lockedFieldsFor(kind, key, { builtinKeys, extraLocked });
    for (const field of locked) {
      if (!valuesEqual(prevEntry[field], entry[field])) {
        return { ok: false, message: lockedFieldReason(kind, field) };
      }
    }
    // QA指摘Nit-2（2026-09-24再報告）: 上のvaluesEqualは文字列をtrimして比較するため、
    // keyBoundFieldsの個々の値が前後空白だけ変わったケースは通り抜けうる——最後にkeyOf自体
    // （生の文字列。trimしない）の一致を確認する保険。個別項目の検査を優先するのは、code等の
    // 具体的な項目名で理由を伝えるため（このチェックは「他の個別検査は通ったがkeyだけ実は
    // 違う」ケースのフォールバック）。
    if (def.keyOf(prevEntry) !== key) {
      return { ok: false, message: '識別項目（キー）は変更できません（複製してください）' };
    }

    // QA指摘m1（2026-09-24再報告）: 変更が無ければ何もしない（no-op）。
    if (diffPairs(kind, prevEntry, entry).length === 0) {
      return { ok: true, noop: true };
    }
  }

  try {
    def.validate(entry);
  } catch (e) {
    return { ok: false, message: e.message };
  }

  if (def.dedupeFields && def.dedupeFields.length > 0) {
    const merged = composeList(kind, builtinList);
    try {
      assertNoDuplicate(kind, entry, merged);
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  const overridesBuiltin = builtinKeys.has(key);
  let nextEntry = entry;
  if (overridesBuiltin) {
    nextEntry = { ...entry, overridesBuiltin: true };
  } else if (Object.prototype.hasOwnProperty.call(entry, 'overridesBuiltin')) {
    nextEntry = { ...entry };
    delete nextEntry.overridesBuiltin;
  }

  const { user } = overlayFor(kind);
  const nextUser = upsertUserCatalogEntry(kind, user, nextEntry);

  const removeDocKey = needsDocStrip(rowState) ? key : null;
  const confirmPairs = needsDocStrip(rowState) ? diffPairs(kind, prevEntry, entry) : [];
  const thicknessChanged = Boolean(prevEntry) && prevEntry.thickness !== entry.thickness;
  const needsConfirm = needsDocStrip(rowState) && confirmPairs.length > 0;

  return {
    ok: true, noop: false, nextUser, removeDocKey, confirmPairs, overridesBuiltin, thicknessChanged, needsConfirm,
  };
}

/**
 * ステップ12a（1.3 標準に戻す）: userライブラリからkeyを外す（builtin同キーの上書きを解除）。
 * alsoRealignDoc（既定true。確認ダイアログの「この文書の同梱も標準に合わせる」チェック相当）が
 * trueかつ文書同梱(doc)にも同キーがあればremoveDocKeyを添える——無ければnull
 * （removeDocEntryはdocに無いキーを渡すと例外を投げるため、呼び出し前にここで存在を確認する）。
 * @param {string} kind
 * @param {string} key
 * @param {{ alsoRealignDoc?: boolean }} args
 * @returns {{ nextUser: object[], removeDocKey: string|null }}
 */
export function planRevertToBuiltin(kind, key, { alsoRealignDoc = true } = {}) {
  const def = kindDef(kind);
  const { doc, user } = overlayFor(kind);
  const nextUser = user.filter(e => def.keyOf(e) !== key);
  const docHasKey = doc.some(e => def.keyOf(e) === key);
  return { nextUser, removeDocKey: (alsoRealignDoc && docHasKey) ? key : null };
}

/**
 * ステップ12a（1.3 使用中userの削除。Q9を未保存文書でも守る）: userライブラリからkeyを外す。
 * 使用中（usedKeysに含む）で文書同梱(doc)に同キーが無ければ、削除前のuserエントリをdocAppendとして
 * 返す（呼び出し側がapplyCatalogEditPlanでdocへ書き写す＝参照が保存直前に消えないようにする）。
 * QA指摘Minor-1（2026-09-24再報告）: docAppendはtarget（userエントリ）をそのまま渡さず
 * stripOverridesBuiltin（usedEntries.js。buildDocumentBundle/recoverUnresolvedEntriesと
 * 同じ規約）を通す——overridesBuiltinはuserライブラリ側の状態であり、doc（文書同梱）へ
 * 持ち込むと別環境での衝突検出（catalogBundle.js detectLibraryConflicts）を誤って黙らせる。
 * overlay上のuser側エントリ（target）自体は変更しない（nextUserは削除だけで印は無関係）。
 * @param {string} kind
 * @param {string} key
 * @param {{ usedKeys?: Set<string> }} args
 * @returns {{ nextUser: object[], docAppend: object|null }}
 */
export function planRemoveUserEntry(kind, key, { usedKeys = new Set() } = {}) {
  const def = kindDef(kind);
  const { doc, user } = overlayFor(kind);
  const target = user.find(e => def.keyOf(e) === key);
  if (!target) throw new Error(`ユーザーライブラリに無いキーです: ${key}`);
  const nextUser = user.filter(e => def.keyOf(e) !== key);
  const docHasKey = doc.some(e => def.keyOf(e) === key);
  const docAppend = (usedKeys.has(key) && !docHasKey) ? stripOverridesBuiltin(target) : null;
  return { nextUser, docAppend };
}

/**
 * ステップ12a（1.3 プラン適用）: commitUserEntries(kind, plan.nextUser, prevUser, {saveFn}) で
 * ユーザーライブラリを永続化した後、plan.removeDocKey（本体へ戻す／doc-same編集）または
 * plan.docAppend（使用中user削除時の書き写し）があればoverlay上のdocを更新し、どちらかが
 * あったときだけmarkDirty()を呼ぶ（removeDocEntry/appendDocEntryはoverlayのみを書き換える
 * in-memory操作でありmarkDirtyを呼ばないと利用者が文書の再保存が必要なことに気づかない——
 * ui/CatalogMaintenancePanel.jsxの既存の合わせ直しフローと同型）。
 * saveFnが失敗した場合はcommitUserEntries自身がoverlayをprevUserへ戻して再throwする
 * （doc側の操作はそこへ到達しないため実行されない＝ロールバックの型を複製しない）。
 * QA指摘Nit-1（2026-09-24再報告）: prevUser省略時は関数に入った時点のoverlayFor(kind).user
 * を既定値にする（省略を[]扱いにすると、失敗時のロールバック先が空になり既存userを消してしまう
 * 事故になる）。
 * @param {string} kind
 * @param {{ nextUser: object[], removeDocKey?: string|null, docAppend?: object|null }} plan
 * @param {{ saveFn: (kind: string, bytes: Uint8Array) => Promise<void>, markDirty?: () => void, prevUser?: object[] }} deps
 * @returns {Promise<void>}
 */
export async function applyCatalogEditPlan(kind, plan, { saveFn, markDirty, prevUser } = {}) {
  const effectivePrevUser = prevUser ?? overlayFor(kind).user;
  await commitUserEntries(kind, plan.nextUser, effectivePrevUser, { saveFn });
  if (plan.removeDocKey) {
    removeDocEntry(kind, plan.removeDocKey);
    markDirty?.();
  } else if (plan.docAppend) {
    appendDocEntry(kind, plan.docAppend);
    markDirty?.();
  }
}

// ================================================================
// ステップ12b（材料タブへの配線。Q-B確定 2026-09-23）: 間柱6コードの extraLocked・保存後
// メッセージの文言選択——どちらも「判断」のため.jsx側に残さずここへ置く。
// ================================================================

/**
 * ステップ12b（Q-B: 間柱6件はx/y/thicknessも固定）: key が間柱コード（studCodes。呼び出し側が
 * finish/materials/backingClass.js の WOOD_STUD_CODE_BY_SIZE の値から注入——catalogMaintenance.js
 * は finish/materials/* を静的importできないため、コード集合はDIで受け取る）に含まれていれば
 * ['x','y','thickness']、それ以外は空配列（lockedFieldsFor の extraLocked にそのまま渡す）。
 * @param {string} key
 * @param {Set<string>} studCodes
 * @returns {string[]}
 */
export function materialExtraLockedFields(key, studCodes = new Set()) {
  return studCodes.has(key) ? ['x', 'y', 'thickness'] : [];
}

/**
 * ステップ12b（Q-C/Q-E: 保存後メッセージの文言選択）: 該当する注記だけを「保存しました」に
 * 括弧書きで足す（両方該当なら「／」で連結）。
 * - overridesBuiltin: この保存でbuiltin同キーの上書き（builtin/override行の保存）になった
 *   → 「他の文書は合わせ直すまで変わりません」（R3。他文書のdoc同梱はこの場では変わらない）。
 * - thicknessChanged: 厚さが変わった → 「壁は次に仕上げモードを出るまで旧い厚みのままです」
 *   （鮮度キーは材コードのみ・2026-09-15裁定。壁の再生成はこの保存では起きない）。
 * @param {{ overridesBuiltin?: boolean, thicknessChanged?: boolean }} args
 * @returns {string}
 */
export function materialSaveMessage({ overridesBuiltin = false, thicknessChanged = false } = {}) {
  const notes = [];
  if (overridesBuiltin) notes.push('他の文書は合わせ直すまで変わりません');
  if (thicknessChanged) notes.push('壁は次に仕上げモードを出るまで旧い厚みのままです');
  return notes.length > 0 ? `保存しました（${notes.join('／')}）` : '保存しました';
}

/**
 * ステップ12b QA指摘m4（2026-09-24再報告・jsxLockedCat/変異jsxThick/jsxOverride/jsxConfirmの
 * 対称形）: 材料タブの行が編集不可な理由（フォームの無効化理由）を1箇所に集約する。
 * category が編集可能（面材・仕上げ材）でなければ最優先で下地材の理由を返す（12cまで一律）。
 * 新規追加（isAdding）はまだ行を持たないため常に編集可能（null）。既存行はeditState（1.1
 * rowEditStateの戻り値）のcanEdit/reasonに従う。
 * @param {{ isAdding: boolean, category: string, editState?: { canEdit: boolean, reason: string|null } | null }} args
 * @returns {string|null}
 */
export function materialRowDisabledReason({ isAdding, category, editState = null }) {
  if (!isEditableMaterialCategory(category)) {
    return '下地材はこのパネルでは編集できません（一覧の表示のみ）';
  }
  if (isAdding) return null;
  if (editState?.canEdit) return null;
  return editState?.reason ?? null;
}

/**
 * ステップ12b QA指摘m4（2026-09-24再報告）: 削除確認後の完了メッセージの文言選択。
 * planRemoveUserEntry の戻り値（plan.docAppend の有無＝使用中で同梱へ写したかどうか）だけを
 * 見る——.jsx側で「使用中かどうか」を再判定させない。
 * @param {{ docAppend?: object|null }|null|undefined} plan
 * @returns {string}
 */
export function removeMessageFor(plan) {
  return plan?.docAppend
    ? '削除しました（使用中のため、この文書には同梱として残しました）'
    : '削除しました';
}
