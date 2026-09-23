// ================================================================
// カタログ保守パネル（ステップ5・ハンバーガー「カタログ保守」）の純ロジック。
//
// 材料（material）の面材（panel）・仕上げ材（finish）・下地材（backing）の追加・編集・削除
// （ステップ12c・2026-09-24: 下地材も開放。クラス（backingClass）は木／その他の2択必須・RC不可）。
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

import {
  CatalogKind, kindDef, listKinds, KIND_LABELS, FIXTURE_SYMBOL_PROFILES, KNOWN_OPENING_MECHANISMS,
} from './catalogKinds.js';
import {
  appendDocEntry, composeCatalog, composeList, docDiffMap, originOf, overlayFor, removeDocEntry, setOverlay,
} from './catalogRegistry.js';
import { assertNoDuplicate, displayNameOf, matchByContent, valuesEqual } from './catalogMatch.js';
import { diffPairs, fieldLabel } from './catalogDiffView.js';
import { nextSerial, parseMaterialCode, formatMaterialCode, isMaterialCode } from './materialCode.js';
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

/** このパネルで追加・編集できるカテゴリ（ステップ12c: 下地材も開放）。 */
export const EDITABLE_MATERIAL_CATEGORIES = Object.freeze([
  MATERIAL_CATEGORY.PANEL, MATERIAL_CATEGORY.FINISH, MATERIAL_CATEGORY.BACKING,
]);

/** category が追加・編集可能（面材・仕上げ材・下地材）かどうか。 */
export function isEditableMaterialCategory(category) {
  return EDITABLE_MATERIAL_CATEGORIES.includes(category);
}

/**
 * ステップ12c（Q-A確定 2026-09-24）: 下地材（backing）のクラス選択肢。'wood'|'other'のみ——
 * RCは固定集合判定（finish/materials/backingClass.js の RC_WALL_BACKING_CODES）専用で、
 * ユーザーがここから選ぶことはできない。値は finish/materials/backingClass.js の BackingClass と
 * 同じだが、catalog/*.js は finish/materials/* を静的importできない（catalogImports.test.js の
 * 許可リスト）ため、MATERIAL_CATEGORY と同様に値だけをここに複製する（二重管理は
 * structureRules.test.js 等の実データ突合せで検知——本ファイルの既存パターンを踏襲）。
 */
export const BACKING_CLASS_OPTIONS = Object.freeze([
  { value: 'wood', label: '木' },
  { value: 'other', label: 'その他' },
]);
const BACKING_CLASS_VALUES = Object.freeze(new Set(BACKING_CLASS_OPTIONS.map(o => o.value)));

/**
 * ステップ12c QA指摘m2（2026-09-24再報告）: 下地区分selectの表示値。本体の下地材
 * （materialData.jsのRC3件・間柱・正角材）は entry.backingClass フィールド自体を持たない
 * （M1参照）ため、選択済みの値をそのまま表示すると常に「選択してください」（空）になり、
 * 実際の分類（RC固定・木質固定）が読み取れない。entry.backingClassが明示的に'wood'|'other'
 * なら（ユーザーが選んだ値）それをそのまま使い、無ければ backingClassOfFn（finish/materials/
 * backingClass.js の backingClassOf。catalog/*.js は静的importできないため呼び出し側が注入する
 * ——DI型はplanBulkSectionImportのparseSpecList等と同じ既存パターン）で導出した固定集合の分類
 * （'wood'|'rc'|'other'）を返す——表示専用の値で、保存には使わない（呼び出し側がform stateと
 * 独立に扱うこと）。
 * @param {{ code?: string, backingClass?: string|null }|null} entry
 * @param {(code: string|undefined) => string} backingClassOfFn
 * @returns {string} 'wood'|'rc'|'other'|''（entry省略時）
 */
export function backingClassDisplayFor(entry, backingClassOfFn) {
  if (!entry) return '';
  if (entry.backingClass === 'wood' || entry.backingClass === 'other') return entry.backingClass;
  return backingClassOfFn ? backingClassOfFn(entry.code) : '';
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
 * 追加・編集・削除はステップ12）。
 * ステップ12d: 建具記号（fixtureSymbol）もenabled:true。ステップ12dの時点ではReadonlyKindTab
 * （閲覧のみ）へ乗せていたが、12fで追加・複製・編集・標準の上書き・標準に戻す・削除まで開放した
 * 専用タブ（ui/CatalogMaintenancePanel.jsx FixtureSymbolTab）へ差し替えた——VIEWABLE_KINDSは
 * enabled判定だけを持つ表であり、タブの中身（閲覧専用か編集可能か）はここでは決めない。
 * これで登録表の全種別が enabled:true になる。
 * ステップ12g: 内装マスター（interiorMaster）は全操作（追加・複製・編集・標準の上書き・標準に
 * 戻す・削除）まで開放した専用タブ（InteriorMasterTab）、断面（section）は呼称（label）の編集・
 * 標準の上書き・userの削除まで開放した専用タブ（SectionTab。寸法系は固定のまま・新規追加は
 * 引き続き規格文字列の一括入力のみ）へそれぞれ差し替えた——ReadonlyKindTabに残るのは境界マスター・
 * 建具種別の2種別のみ（境界マスターは範囲外の裁定、建具種別はステップ12hで着手予定）。
 */
const VIEWABLE_KINDS = Object.freeze([
  CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER, CatalogKind.SECTION,
  CatalogKind.OPENING_SUB_TYPE, CatalogKind.FIXTURE_SYMBOL,
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
  // ステップ12f: 建具記号（fixtureSymbol）のcategoryもopeningSubTypeと同じ2値（fitting/window）
  // ——別の対応表として持つ（formatCategoryLabelはkindごとに独立した表を引くため、
  // 値が同じでも共有せず複製する既存の規約に合わせる）。
  [CatalogKind.FIXTURE_SYMBOL]: Object.freeze({ fitting: '建具', window: '窓' }),
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
 * QA指摘n8（2026-09-24再報告）: kindのcategory選択肢（{value,label}[]）をCATEGORY_LABELS_BY_KIND
 * から導出する——.jsx側にcategory値の一覧を手書きの選択肢配列として複製させない
 * （formatCategoryLabelと同じ表を唯一の出所にする）。対応表が無いkindは空配列。
 * @param {string} kind
 * @returns {Array<{ value: string, label: string }>}
 */
export function categoryOptionsFor(kind) {
  const labels = CATEGORY_LABELS_BY_KIND[kind];
  return labels ? Object.entries(labels).map(([value, label]) => ({ value, label })) : [];
}

/**
 * QA指摘m4（2026-09-24再々報告）: 建具種別（openingSubType）の機構(mechanism)の表示名。
 * 旧: ui/CatalogMaintenancePanel.jsx に直書きされていた OPENING_SUB_TYPE_MECHANISM_LABELS を
 * こちらへ移設した——formatCategoryLabel/CATEGORY_LABELS_BY_KINDと同じ層（catalog/*.js に
 * 対応表を持ち、.jsx側は薄いgetterだけを呼ぶ）に揃える。キー集合は catalogKinds.js の
 * KNOWN_OPENING_MECHANISMS（openings/openingCatalog.js OpeningMechanismの値の複製）と一致する
 * ことを catalog/catalogMaintenance.test.js（T3）で固定する。日本語文言は
 * openings/openingCatalog.js OpeningMechanismの定義コメントをそのまま転記したもの。
 */
export const OPENING_SUB_TYPE_MECHANISM_LABELS = Object.freeze({
  swing: 'swing（片開き・蝶番）',
  slideDouble: 'slideDouble（引き違い）',
  slideSingle: 'slideSingle（片引き）',
  fold: 'fold（折れ戸・折りたたみ窓）',
  free: 'free（自由蝶番）',
  fixed: 'fixed（開閉なし）',
  hung: 'hung（上げ下げ窓）',
  awning: 'awning（横すべり出し窓）',
  tilt: 'tilt（内倒し窓）',
  louver: 'louver（ガラスルーバー窓）',
  pivot: 'pivot（縦軸回転窓）',
  swingDouble: 'swingDouble（両開き）',
  swingChild: 'swingChild（親子扉）',
  swingIn: 'swingIn（内開き窓）',
  freeDouble: 'freeDouble（自由両開き扉）',
  shutter: 'shutter（シャッター）',
  overhead: 'overhead（オーバーヘッドドア）',
  emergency: 'emergency（非常用進入口）',
  fireDoor: 'fireDoor（常時開放式防火戸）',
  fireFold: 'fireFold（常時開放式防火折戸）',
  slideLayout: 'slideLayout（多枚建て引違い等）',
  projectVertical: 'projectVertical（縦すべり出し窓）',
  projectOut: 'projectOut（突出し窓）',
  tiltOut: 'tiltOut（外倒し窓）',
  pivotHorizontal: 'pivotHorizontal（横軸回転窓）',
  drehKipp: 'drehKipp（ドレーキップ窓）',
  awningMulti: 'awningMulti（オーニング窓）',
  garari: 'garari（ガラリ・固定）',
  glassBlock: 'glassBlock（ガラスブロック）',
  frameOnly: 'frameOnly（三方枠・枠のみ）',
});

/**
 * mechanism値の表示名（唯一の読み出し口）。対応表に無い値（未知の複製漏れ等）は
 * mechanismの生値へフォールバックする（formatCategoryLabelと同じフォールバック規約）。
 * @param {string} mechanism
 * @returns {string}
 */
export function formatMechanismLabel(mechanism) {
  return OPENING_SUB_TYPE_MECHANISM_LABELS[mechanism] ?? mechanism;
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
 * フォーム入力から材エントリを組み立てる。面材・仕上げ材はx/yを常に0固定
 * （materialData.js「面材・仕上げ材は寸法なし→0,0」と同じ）。下地材（category:'backing'）は
 * x/yをそのまま持たせる。
 * QA指摘Minor3（再指摘）: name/spec/noteの前後の空白を除く責務をこの関数1箇所に寄せる
 * （呼び出し側でトリムしてから渡す約束にすると、呼び出し側が増えたときにトリムし忘れが起こる）。
 *
 * ステップ12b QA指摘n1（12c申し送り・2026-09-24再報告）の解消: x/y:0固定は面材・仕上げ材専用の
 * 割り切りのまま残し、category:'backing'のときだけ呼び出し側（フォーム）から渡された x/y を
 * そのまま使う——間柱コード（WOOD_STUD_CODE_BY_SIZE）行の materialExtraLockedFields
 * （x/y/thicknessロック）は、フォーム（ui/CatalogMaintenancePanel.jsx formFromEntry）が編集開始時に
 * 元entryのx/yを引き継ぐため、変更していなければlockedFieldsForの一致検査を通る。
 *
 * ステップ12c QA指摘M1（2026-09-24再報告）: backingClassは値が無ければ（null/undefined）
 * entryにキー自体を持たせない——本体の下地材（materialData.jsのRC3件・間柱・正角材）は
 * backingClassフィールドを一切持たないため、フォームの空選択（''）がnullへ変換されてここへ来ても
 * `entry.backingClass = null` にしてしまうと kindDef.validate が「backingClassが不正です」で
 * 拒否し、本体の下地材が一切編集保存できなくなる（QA実測: note変更ですら拒否された）。
 * @param {{ code:string, name:string, spec?:string, thickness?:number|null, note?:string,
 *           category:string, x?:number, y?:number, backingClass?:string|null }} args
 */
export function buildMaterialEntry({
  code, name, spec = '', thickness = null, note = '', category, x = 0, y = 0, backingClass = null,
}) {
  const entry = { code, name: name.trim(), spec: spec.trim(), thickness, note: note.trim(), category };
  if (category === MATERIAL_CATEGORY.BACKING) {
    entry.x = x;
    entry.y = y;
    if (backingClass != null) entry.backingClass = backingClass;
  } else {
    entry.x = 0;
    entry.y = 0;
  }
  return entry;
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
 * 保存前検証: (1) カテゴリが編集可能（panel/finish/backing）であること、(2) kindDef('material').validate、
 * (3) assertNoDuplicate（R17。builtinList から合成した全エントリに対して検査）。
 * 失敗は日本語メッセージで返す（例外を投げない——フォーム表示用）。
 * ステップ12c QA指摘M3（2026-09-24再報告・リード裁定Q-1=案(a)）: 下地材（category:'backing'）の
 * 必須検査（x/y>0・backingClass必須）はここではなく planSaveEntry 側（新規追加・既存編集の
 * 両方が通る唯一の経路）に一本化した——本関数は新規追加（isAdding）経路でしか呼ばれず、既存行の
 * 編集は planSaveEntry のみを通るため、ここに検査を残すと編集経路が検査されない穴になる
 * （QA指摘M3の症状そのもの）。
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateMaterialEntry(entry, builtinList) {
  if (!isEditableMaterialCategory(entry?.category)) {
    return {
      ok: false,
      message: `このカテゴリの材料はここでは編集できません（面材・仕上げ材・下地材のみ）: ${entry?.category}`,
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
 * ステップ12c QA指摘M3（2026-09-24再報告・リード裁定Q-1=案(a)）: 下地材（material・
 * category:'backing'）の必須検査（backingClassは'wood'|'other'必須・x/yは0より大きい数値必須）。
 * planSaveEntry からのみ呼ぶ（新規追加・既存編集の両方が通る唯一の経路に一本化——
 * validateMaterialEntryのbacking検査は重複のため削除済み）。
 *
 * 「本体の上書き行」（builtinKeys.has(key)。origin='builtin'の素のbuiltin行、および同キーを
 * userライブラリで上書きしたoverride/doc-override行の両方を含む）では検査を丸ごと掛けない——
 * 一般則（リード裁定Q-1）。理由: materialData.js の builtin 下地材（RC 3件は x=y=0 が仕様。
 * 間柱・正角材はx/y>0だが backingClass フィールド自体を最初から持たない）は12c以前からある
 * 既存データで、ユーザーが作った値ではない。overrideLockedFields（catalogKinds.js）が
 * category/backingClassの値そのものを上書き行では変更不可にしている（lockedFieldsForで
 * prevEntryと同値であることを別途強制）ため、ここで検査を緩めても不正なbackingClass/x/yが
 * 新たに混入する経路は無い——検査を掛けると「note等の項目だけを変える編集」まで本体データの
 * 形（x=0の RC 3件・backingClass未設定の全builtin下地材）を理由に拒否してしまう
 * （QA指摘M1の症状と同型）。ユーザーが新規追加・自分のuserエントリを編集する行
 * （builtinKeys.has(key)===false）には常に掛かる。
 * @param {object} entry
 * @param {{ builtinOverride: boolean }} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validateBackingMaterialFields(entry, { builtinOverride }) {
  if (builtinOverride) return { ok: true };
  if (!(typeof entry.x === 'number' && entry.x > 0)) {
    return { ok: false, message: '下地材のXは0より大きい数値を入力してください' };
  }
  if (!(typeof entry.y === 'number' && entry.y > 0)) {
    return { ok: false, message: '下地材のYは0より大きい数値を入力してください' };
  }
  if (!BACKING_CLASS_VALUES.has(entry.backingClass)) {
    return { ok: false, message: '下地材のクラスは木／その他のいずれかです' };
  }
  return { ok: true };
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

  // ステップ12c QA指摘M3（2026-09-24再報告）: 下地材の必須検査（material専用。他種別には無関係）。
  // 新規追加・既存編集の両方がplanSaveEntryを通るため、ここが唯一の適用箇所になる。
  if (kind === CatalogKind.MATERIAL && entry.category === MATERIAL_CATEGORY.BACKING) {
    const backingResult = validateBackingMaterialFields(entry, { builtinOverride: builtinKeys.has(key) });
    if (!backingResult.ok) return backingResult;
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
 * ステップ12f（Q-C/Q-E: 保存後メッセージの文言選択。materialSaveMessageをkind汎用へ一般化）:
 * 該当する注記だけを「保存しました」に括弧書きで足す（両方該当なら「／」で連結）。
 * - overridesBuiltin: この保存でbuiltin同キーの上書き（builtin/override行の保存）になった
 *   → 「他の文書は合わせ直すまで変わりません」（R3。他文書のdoc同梱はこの場では変わらない。
 *   種別を問わない）。
 * - thicknessChanged: 厚さが変わった → 「壁は次に仕上げモードを出るまで旧い厚みのままです」
 *   （鮮度キーは材コードのみ・2026-09-15裁定。壁の再生成はこの保存では起きない）。厚みを持つのは
 *   material（面材・仕上げ材・下地材）だけのため、kindがmaterialでなければこの注記は無視する
 *   （呼び出し側がthicknessChangedを渡さなくても安全）。
 * @param {string} kind
 * @param {{ overridesBuiltin?: boolean, thicknessChanged?: boolean }} args
 * @returns {string}
 */
export function catalogSaveMessage(kind, { overridesBuiltin = false, thicknessChanged = false } = {}) {
  const notes = [];
  if (overridesBuiltin) notes.push('他の文書は合わせ直すまで変わりません');
  if (kind === CatalogKind.MATERIAL && thicknessChanged) notes.push('壁は次に仕上げモードを出るまで旧い厚みのままです');
  return notes.length > 0 ? `保存しました（${notes.join('／')}）` : '保存しました';
}

/** catalogSaveMessage(CatalogKind.MATERIAL, ...) の薄いラッパ（既存呼び出し・テストを変えない）。 */
export function materialSaveMessage(args) {
  return catalogSaveMessage(CatalogKind.MATERIAL, args);
}

/**
 * ステップ12f（QA指摘n7で位置・誤字を修正）: 「新規追加（isAdding）は常に編集可・既存行は
 * editState（1.1 rowEditStateの戻り値）のcanEdit/reasonに従う」という判定を
 * materialRowDisabledReason・fixtureSymbolRowDisabledReasonで共有する（materialRowDisabledReasonの
 * categoryによる一律拒否ゲートだけがmaterial専用のため、そこだけ呼び出し側に残す）。
 * @param {{ isAdding: boolean, editState?: { canEdit: boolean, reason: string|null } | null }} args
 * @returns {string|null}
 */
function editStateDisabledReason({ isAdding, editState }) {
  if (isAdding) return null;
  if (editState?.canEdit) return null;
  return editState?.reason ?? null;
}

/**
 * ステップ12b QA指摘m4（2026-09-24再報告・jsxLockedCat/変異jsxThick/jsxOverride/jsxConfirmの
 * 対称形）: 材料タブの行が編集不可な理由（フォームの無効化理由）を1箇所に集約する。
 * ステップ12c: 下地材分岐（「下地材はこのパネルでは編集できません」の固定文言）は廃止した——
 * 下地材も面材・仕上げ材と同じくisEditableMaterialCategoryでtrueになる（EDITABLE_MATERIAL_CATEGORIES
 * に3カテゴリとも含まれる）。builtin下地材の上書きはoverrideLockedFields（category・backingClass）
 * で、間柱6件はmaterialExtraLockedFieldsのextraLocked（x/y/thickness）で個別に守る——カテゴリ単位の
 * 一律拒否はもう不要。categoryが（将来の拡張等で）編集不可の値を持つ場合の汎用フォールバックだけ残す。
 * 新規追加（isAdding）はまだ行を持たないため常に編集可能（null）。既存行はeditState（1.1
 * rowEditStateの戻り値）のcanEdit/reasonに従う（editStateDisabledReasonへ委譲）。
 * @param {{ isAdding: boolean, category: string, editState?: { canEdit: boolean, reason: string|null } | null }} args
 * @returns {string|null}
 */
export function materialRowDisabledReason({ isAdding, category, editState = null }) {
  if (!isEditableMaterialCategory(category)) {
    return 'このカテゴリの材料はここでは編集できません';
  }
  return editStateDisabledReason({ isAdding, editState });
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

// ================================================================
// ステップ12f（保守パネル「建具記号」タブへの配線。Q-D確定 2026-09-24）: 建具記号タブ専用の
// フォーム純関数。追加・複製・編集・標準の上書き・標準に戻す・削除は12aの共通ロジック
// （rowEditState/lockedFieldsFor/planSaveEntry/planRevertToBuiltin/planRemoveUserEntry/
// applyCatalogEditPlan）をそのまま使う——ここに持つのは「フォーム値からエントリを組み立てる」
// 「追加時だけの書式・重複検査」「どの欄を出すか」という、建具記号固有の判断だけ。
// ================================================================

/**
 * ステップ12f（Q-D確定 2026-09-24）: 建具記号エントリのmechanismのうち、三方枠専用記号
 * （WF/SF/SSF等）のスコープを表す値。openings/openingCatalog.js OpeningMechanism.FRAME_ONLY と
 * 同じ文字列——catalog/*.js は openings/*.js を静的importできない（catalogImports.test.jsの
 * 許可リスト）ため、catalogKinds.js FIXTURE_SYMBOL登録表のisSupportedと同様に値だけを複製する
 * （catalogRealMasters.test.jsでOpeningMechanism.FRAME_ONLYと一致することを固定する想定）。
 */
export const FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM = 'frameOnly';

/**
 * ステップ12f（Q-D確定 2026-09-24）: 追加時の記号（key）の書式。英大文字2〜4文字
 * （タグ`${記号}-${番号}`で数字や記号が混ざると番号と読み違えるため。本体は2〜3文字）。
 */
export const FIXTURE_SYMBOL_KEY_PATTERN = /^[A-Z]{2,4}$/;

/**
 * kind の合成後（builtin・user・doc）の全キー集合。追加時のキー重複検査
 * （builtin・ユーザーライブラリ・文書同梱のいずれとも重ならないこと）に使う——materialの
 * collectKnownMaterialCodesと同じ役割の種別汎用版（keyOfがcode以外のkindにも使える形）。
 * @param {string} kind
 * @param {object[]} builtinList
 * @returns {Set<string>}
 */
export function collectKnownCatalogKeys(kind, builtinList) {
  const def = kindDef(kind);
  return new Set(composeList(kind, builtinList).map(def.keyOf));
}

/**
 * ステップ12f（QA指摘M1・再報告で修正）: 建具記号フォームの入力から、どの欄を出すか（現時点では
 * profileの要否のみ）を判定する（.jsx側にframeOnly直書きの条件分岐を残さない——
 * materialFormHasDimensionsと同じ役割の薄い判定）。profileは三方枠専用記号のときだけ意味を持つ
 * （frameProfileFor参照）。
 * 引数は**パネルのフォームが実際に持つ形**（真偽値`frameOnly`。「三方枠専用記号にする」
 * チェックボックスの値）を受け取る——buildFixtureSymbolEntryの引数と同じ形。エントリ形
 * （`mechanism:FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM`）を渡す呼び出しは無い（フォーム側が
 * entry→formの変換（fixtureSymbolFormFromEntry）を経てからこの関数を呼ぶため）。
 * @param {{ frameOnly?: boolean }|null} form フォーム値。
 * @returns {{ showProfile: boolean }}
 */
export function fixtureSymbolFormFieldsFor(form) {
  return { showProfile: form?.frameOnly === true };
}

/**
 * ステップ12f: 建具記号フォーム入力からエントリを組み立てる。key/labelは前後の空白を除く
 * （他種別のbuildMaterialEntry等と同じトリム規約）。keyは大文字化しない——追加時の書式検査
 * （validateFixtureSymbolForm）が生の入力をそのまま見て「aw」等を拒否できるようにするため
 * （呼び出し側でこっそり大文字化すると拒否できないケースを黙って通してしまう）。
 * frameOnly（真偽値。フォームの「三方枠専用記号にする」チェック）がtrueのときだけ
 * mechanism:FIXTURE_SYMBOL_FRAME_ONLY_MECHANISMを持たせ、profileも(solid|bentのときだけ)
 * 持たせる——三方枠でない記号にprofileの値が紛れ込まない（設計「三方枠でない記号にprofileを
 * 入れても保存値に持たない」）。defaultMaterialGlassは空文字ならキー自体を持たせない
 * （buildMaterialEntryのbackingClassと同じ規約——空値をnullで保存するとkindDef.validateの
 * 型検査（文字列またはnull/undefined）は通るが、無意味な明示nullを増やさない）。
 * @param {{ key?: string, label?: string, category?: string, frameOnly?: boolean,
 *           profile?: string|null, defaultMaterialGlass?: string|null }} form
 * @returns {{ key: string, label: string, category: string, mechanism?: string,
 *             profile?: string, defaultMaterialGlass?: string }}
 */
export function buildFixtureSymbolEntry({
  key, label, category, frameOnly = false, profile = null, defaultMaterialGlass = null,
} = {}) {
  const entry = { key: (key ?? '').trim(), label: (label ?? '').trim(), category };
  if (frameOnly) {
    entry.mechanism = FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM;
    if (FIXTURE_SYMBOL_PROFILES.includes(profile)) entry.profile = profile;
  }
  const glass = (defaultMaterialGlass ?? '').trim();
  if (glass !== '') entry.defaultMaterialGlass = glass;
  return entry;
}

/**
 * ステップ12f QA指摘m3（2026-09-24再報告）: buildFixtureSymbolEntryの逆変換——保存済み
 * エントリ（builtin/user/doc）からフォーム値を組み立てる（ui/CatalogMaintenancePanel.jsxに
 * あった`formFromFixtureSymbolEntry`を純関数として移設。往復テストで固定する）。
 * mechanismをframeOnly（真偽値）へ、category/profile/defaultMaterialGlassは未設定なら
 * フォームの既定値（空文字）へ丸める——input/selectはcontrolled componentのためnull/undefinedを
 * 渡さない契約（他フォーム関数と同じ）。
 * @param {object} entry
 * @returns {{ key: string, label: string, category: string, frameOnly: boolean,
 *             profile: string, defaultMaterialGlass: string }}
 */
export function fixtureSymbolFormFromEntry(entry) {
  return {
    key: entry?.key ?? '',
    label: entry?.label ?? '',
    category: entry?.category === 'window' ? 'window' : 'fitting',
    frameOnly: entry?.mechanism === FIXTURE_SYMBOL_FRAME_ONLY_MECHANISM,
    profile: entry?.profile ?? '',
    defaultMaterialGlass: entry?.defaultMaterialGlass ?? '',
  };
}

/**
 * ステップ12f QA指摘m4（2026-09-24再報告）: 作図プレビュー用のドラフトエントリを組み立てる
 * （ui/CatalogMaintenancePanel.jsxにあった`{ ...buildFixtureSymbolEntry(form), key: form.key
 * || '?' }`を純関数として移設）。buildFixtureSymbolEntryが返すkey（前後空白を除いたもの）が
 * 空文字なら'?'へ置き換える——CatalogPreview（ui/catalogPreview.js fixtureSymbolPreview）の
 * isNonEmptyString(entry.key)ガードを追加時（記号未入力）のプレビューでも満たすため
 * （保存はしない。表示専用のプレースホルダ）。
 * @param {Parameters<typeof buildFixtureSymbolEntry>[0]} form
 * @returns {ReturnType<typeof buildFixtureSymbolEntry>}
 */
export function fixtureSymbolPreviewEntry(form) {
  const entry = buildFixtureSymbolEntry(form);
  return { ...entry, key: entry.key || '?' };
}

/**
 * ステップ12f（Q-D確定 2026-09-24）: 建具記号フォームの検証。追加時（isAdding）だけ記号の書式
 * （FIXTURE_SYMBOL_KEY_PATTERN）・重複（builtinKeys/allKeys）を検査する——既存行の編集は
 * keyBoundFields（key/category/mechanism）がlockedFieldsFor/planSaveEntry側で既に固定して
 * いるため、ここでの重複検査は不要（keyは変わらない）。label必須・category必須は追加・編集の
 * 両方で検査する（planSaveEntry側のkindDef.validateでも検査されるが、フォーム表示用の日本語
 * メッセージをここで先に出す——他種別のvalidateMaterialEntryと同じ役割分担）。
 * @param {{ key?: string, label?: string, category?: string }} form
 * @param {{ isAdding: boolean, allKeys?: Set<string>, builtinKeys?: Set<string> }} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateFixtureSymbolForm(form, { isAdding, allKeys = new Set(), builtinKeys = new Set() } = {}) {
  const label = (form?.label ?? '').trim();
  const category = form?.category;
  if (!label) return { ok: false, message: '呼称を入力してください' };
  if (category !== 'fitting' && category !== 'window') {
    return { ok: false, message: '区分は建具または窓のいずれかです' };
  }
  if (isAdding) {
    const key = (form?.key ?? '').trim();
    if (!FIXTURE_SYMBOL_KEY_PATTERN.test(key)) {
      return { ok: false, message: '記号は英大文字2〜4文字で入力してください（例: AW）' };
    }
    if (builtinKeys.has(key)) {
      return { ok: false, message: '標準を編集してください（同じ記号の標準エントリがあります）' };
    }
    if (allKeys.has(key)) {
      return { ok: false, message: `既に使われている記号です: ${key}` };
    }
  }
  return { ok: true };
}

/**
 * ステップ12f: 建具記号タブのフォーム無効化理由（materialRowDisabledReasonの建具記号版。
 * カテゴリ単位の一律拒否を持たない——建具記号はどのcategory（fitting/window）も編集可能）。
 * @param {{ isAdding: boolean, editState?: { canEdit: boolean, reason: string|null } | null }} args
 * @returns {string|null}
 */
export function fixtureSymbolRowDisabledReason({ isAdding, editState = null } = {}) {
  return editStateDisabledReason({ isAdding, editState });
}

// ================================================================
// ステップ12g（内装マスター（全操作＋標準の上書き）と断面（呼称の編集・標準の上書き・
// userの削除）を編集タブにする）: 内装マスタータブ・断面タブ専用のフォーム純関数。
// 追加・複製・編集・標準の上書き・標準に戻す・削除は12aの共通ロジック（rowEditState/
// lockedFieldsFor/planSaveEntry/planRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlan）を
// そのまま使う——ここに持つのは「フォーム値からエントリを組み立てる」「新規追加時のキー採番」
// 「フォーム側の検証」という、各種別固有の判断だけ（12fのfixtureSymbol系と同じ役割分担）。
// ================================================================

/** 内装マスターの新規追加キーの採番書式（USER_連番）。 */
const INTERIOR_MASTER_KEY_PATTERN = /^USER_(\d+)$/;

/**
 * ステップ12g（設計「keyはUSER_1…から未使用の最小番号を自動採番」）: allKeys（builtin・
 * ユーザーライブラリ・文書同梱の合成キー集合。collectKnownCatalogKeysで組み立てる）のうち
 * USER_連番の欠番を含めて最小の未使用番号を返す——materialCode.jsのnextSerialと同じ
 * 「最小の空き番号」規約（欠番の再利用）。ユーザーがキーを直接入力する経路は無い
 * （追加・複製のどちらもこの関数で決めたキーをフォームへ渡す）。
 * @param {Set<string>} allKeys
 * @returns {string} 'USER_1'・'USER_2'…
 */
export function nextInteriorMasterKey(allKeys) {
  const used = new Set();
  for (const key of allKeys ?? []) {
    const m = INTERIOR_MASTER_KEY_PATTERN.exec(key);
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `USER_${n}`;
}

/**
 * 保存済みエントリ（builtin/user/doc）からフォーム値を組み立てる（buildInteriorMasterEntryの
 * 逆変換）。ceilingHeightは数値入力欄のためparseThicknessInputと同じ文字列化規約（未設定は空文字）。
 * @param {object} entry
 * @returns {{ key: string, label: string, wallMaterial: string, wallFinish: string, ceilingHeight: string }}
 */
export function interiorMasterFormFromEntry(entry) {
  return {
    key: entry?.key ?? '',
    label: entry?.label ?? '',
    wallMaterial: entry?.wallMaterial ?? '',
    wallFinish: entry?.wallFinish ?? '',
    ceilingHeight: entry?.ceilingHeight == null ? '' : String(entry.ceilingHeight),
  };
}

/**
 * フォーム入力から内装マスターエントリを組み立てる。key/label/wallMaterial/wallFinishは前後の
 * 空白を除く（他種別のbuildMaterialEntry等と同じトリム規約）。ceilingHeightは空白を除いてから
 * Numberへ変換する（空文字はNaN——validateInteriorMasterForm側で拒否する。parseThicknessInputは
 * 空文字をnullにするが、ceilingHeightはmaterialのthicknessと違い必須項目のためnull許容にしない）。
 * @param {{ key?: string, label?: string, wallMaterial?: string, wallFinish?: string, ceilingHeight?: string|number }} form
 * @returns {{ key: string, label: string, wallMaterial: string, wallFinish: string, ceilingHeight: number }}
 */
export function buildInteriorMasterEntry({
  key, label, wallMaterial, wallFinish, ceilingHeight,
} = {}) {
  const trimmed = String(ceilingHeight ?? '').trim();
  return {
    key: (key ?? '').trim(),
    label: (label ?? '').trim(),
    wallMaterial: (wallMaterial ?? '').trim(),
    wallFinish: (wallFinish ?? '').trim(),
    ceilingHeight: trimmed === '' ? NaN : Number(trimmed),
  };
}

/**
 * ステップ12g: 内装マスターフォームの検証。label必須・wallMaterial/wallFinishは材料コード
 * （12桁数字。materialCode.js isMaterialCode）必須・ceilingHeightは0より大きい有限数値が必須。
 * 追加時（isAdding）だけキーの重複を検査する（キー自体はnextInteriorMasterKeyが未使用の番号を
 * 選ぶため通常は起こらないが、呼び出し側の取り違え等に備えた保険）。
 *
 * QA指摘M1（12g再報告・リード裁定「拒否」2026-09-24）: 12桁検査だけでは材料カタログに実在しない
 * コード（存在しない材料コード）を保存できてしまう——本関数は材料カタログ本体を静的importできない
 * （catalog/*.js は finish/materials/* を持たない不変条件）ため、呼び出し側（jsx）が合成済みの
 * 材料キー集合を`materialKeys`として注入する（DI型。collectKnownCatalogKeys(CatalogKind.MATERIAL,
 * materialBuiltinList)と同じ形）。`materialKeys`省略時（null）は「材料カタログを読み込んでいない
 * のに検証だけ通す」事故を防ぐため、既定で保存不可（読み込み未完了の理由）を返す——他の引数
 * （allKeys/builtinKeys）のような空Set既定にしない。呼び出し側は材料一覧を読み込むまで保存ボタンを
 * disabledにする想定（interiorMasterRowDisabledReasonのmaterialListLoaded引数）。
 * @param {{ key?: string, label?: string, wallMaterial?: string, wallFinish?: string, ceilingHeight?: string|number }} form
 * @param {{ isAdding: boolean, allKeys?: Set<string>, builtinKeys?: Set<string>, materialKeys?: Set<string>|null }} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateInteriorMasterForm(form, {
  isAdding, allKeys = new Set(), builtinKeys = new Set(), materialKeys = null,
} = {}) {
  const label = (form?.label ?? '').trim();
  const wallMaterial = (form?.wallMaterial ?? '').trim();
  const wallFinish = (form?.wallFinish ?? '').trim();
  const ceilingHeight = Number(String(form?.ceilingHeight ?? '').trim());
  if (!label) return { ok: false, message: '呼称を入力してください' };
  if (!isMaterialCode(wallMaterial)) {
    return { ok: false, message: '壁材は材料コード（12桁数字）で入力してください' };
  }
  if (!isMaterialCode(wallFinish)) {
    return { ok: false, message: '壁仕上げは材料コード（12桁数字）で入力してください' };
  }
  if (!Number.isFinite(ceilingHeight) || ceilingHeight <= 0) {
    return { ok: false, message: '天井高は0より大きい数値を入力してください' };
  }
  if (!materialKeys) {
    return { ok: false, message: '材料カタログが読み込まれていません（しばらく待ってから保存してください）' };
  }
  if (!materialKeys.has(wallMaterial)) {
    return { ok: false, message: '壁材は材料カタログに無いコードです' };
  }
  if (!materialKeys.has(wallFinish)) {
    return { ok: false, message: '壁仕上げは材料カタログに無いコードです' };
  }
  if (isAdding) {
    const key = (form?.key ?? '').trim();
    if (!key) return { ok: false, message: 'キーが割り当てられていません' };
    if (builtinKeys.has(key) || allKeys.has(key)) {
      return { ok: false, message: `既に使われているキーです: ${key}` };
    }
  }
  return { ok: true };
}

/**
 * ステップ12g: 内装マスタータブのフォーム無効化理由（fixtureSymbolRowDisabledReasonと同型。
 * 内装マスターはどの行もカテゴリ単位の一律拒否を持たない）。
 * QA指摘M1（12g再報告）: materialListLoaded:false（材料カタログの動的importが完了していない）のときは
 * isAdding・editStateの状態に関わらず保存不可の理由を返す——validateInteriorMasterFormが
 * materialKeys省略時に拒否する仕組みと対にして、呼び出し側（jsx）は保存ボタンをdisabledにできる。
 * @param {{ isAdding: boolean, editState?: { canEdit: boolean, reason: string|null } | null,
 *           materialListLoaded?: boolean }} args
 * @returns {string|null}
 */
export function interiorMasterRowDisabledReason({ isAdding, editState = null, materialListLoaded = true } = {}) {
  if (!materialListLoaded) return '材料カタログを読み込んでいます…';
  return editStateDisabledReason({ isAdding, editState });
}

/**
 * ステップ12g（設計「断面は元entryをそのままlabel以外」）: 保存済み断面エントリからフォーム値
 * （呼称のみ）を組み立てる。他の全項目（materialType/shape/width/height等）はkeyBoundFields
 * （catalogKinds.js SECTION登録表）で常に固定のため、フォームに持たせず選択行のentryをそのまま
 * 参照表示する（sectionRowDisabledReason・呼び出し側jsxの責務）。
 * @param {object} entry
 * @returns {{ key: string, label: string }}
 */
export function sectionFormFromEntry(entry) {
  return { key: entry?.key ?? '', label: entry?.label ?? '' };
}

/**
 * ステップ12g: 断面エントリを組み立てる。prevEntry（選択行の元エントリ）をそのまま複製し、
 * labelだけフォーム値（前後の空白を除く）へ差し替える——寸法系はkeyBoundFieldsで常に固定のため
 * ここで書き換える経路を持たない（他項目をフォームから受け取らないことで、呼び出し側が
 * 誤って寸法を変更したエントリを組み立てられないようにする設計）。
 * @param {object} prevEntry 選択行の元エントリ（必須。断面には新規追加フォームが無い——
 *   追加は既存の「規格文字列から追加」のみ）
 * @param {{ label?: string }} form
 * @returns {object}
 */
export function buildSectionEntry(prevEntry, form) {
  return { ...prevEntry, label: (form?.label ?? '').trim() };
}

/**
 * ステップ12g: 断面フォームの検証（呼称必須のみ——寸法系はbuildSectionEntryがprevEntryから
 * 引き継ぐため検証対象に無い）。
 * @param {{ label?: string }} form
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateSectionForm(form) {
  const label = (form?.label ?? '').trim();
  if (!label) return { ok: false, message: '呼称を入力してください' };
  return { ok: true };
}

/**
 * ステップ12g: 断面タブのフォーム無効化理由。断面には新規追加フォームが無いため isAdding は
 * 常に false で呼ばれる想定だが、他種別と同じ引数形を保つ。
 * QA指摘M2（12g再報告）: editStateDisabledReason（fixtureSymbolRowDisabledReason等と共有する
 * 汎用委譲）はrowEditStateの共通文言（「複製してください」「合わせ直すか複製してください」）を
 * そのまま返すが、断面タブには複製・合わせ直しの手段が無い（設計12g「追加は既存の一括入力のみ」で
 * 複製ボタン自体を持たない）ため、その文言のまま出すと利用者に無い操作を示してしまう。
 * doc-only・doc-diffの2状態だけは断面タブ専用の文言（呼称は変更できない旨）に差し替える——
 * それ以外の状態（builtin/user/override/doc-same/doc-override。すべてcanEdit:true）は
 * editStateDisabledReasonの既定どおりnullを返す。
 * @param {{ isAdding: boolean, editState?: { canEdit: boolean, state?: string, reason: string|null } | null }} args
 * @returns {string|null}
 */
export function sectionRowDisabledReason({ isAdding, editState = null } = {}) {
  if (isAdding) return null;
  if (editState?.canEdit) return null;
  if (editState?.state === 'doc-only') {
    return '文書にのみ存在する断面です。呼称は変更できません';
  }
  if (editState?.state === 'doc-diff') {
    return '文書の内容が本体と異なる断面です。呼称は変更できません';
  }
  return editState?.reason ?? null;
}

// ================================================================
// ステップ12h（建具種別（openingSubType）の追加・複製・編集・削除・標準の上書きを保守パネルの
// 編集タブにする）: OpeningSubTypeTab専用のフォーム純関数。追加・複製・編集・標準の上書き・
// 標準に戻す・削除は12aの共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry/
// planRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlan）をそのまま使う——ここに持つのは
// 「フォーム値からエントリを組み立てる」「新規追加時のキー採番（同カテゴリ内でuser1…）」
// 「フォーム側の検証（機構別の欄を含む）」「slideLayoutの文字列表記⇄オブジェクトの変換」という、
// 建具種別固有の判断だけ（12f/12gの役割分担と同型）。
// ================================================================

// openings/openingCatalog.js OpeningMechanism の該当値を複製する（catalog/*.js は openings/*.js を
// 静的importできない——catalogImports.test.jsの許可リスト。KNOWN_OPENING_MECHANISMSと同じ
// 複製規約。catalogRealMasters.test.jsでOpeningMechanismの値と一致することを固定する想定）。
export const OPENING_SUB_TYPE_SWING_CHILD_MECHANISM = 'swingChild';
export const OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM = 'fireDoor';
export const OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM = 'fireFold';
export const OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM = 'slideLayout';

// slideLayout.panels の要素で使う矢印向き（openings/openingCatalog.js builtin の全slideLayout
// エントリから列挙した値の集合——'both'は引き分け窓の中央2枚等で使う）。
const SLIDE_LAYOUT_ARROW_VALUES = new Set(['pos', 'neg', 'both']);

// QA指摘m3（リード裁定・実ソース確認 2026-09-24再々報告）: fireLeaves/fireAngleの許容値。
// openings/openingCatalog.js FITTING_CATALOGの実データ（fireDoorDouble/Single/180系・
// fireFold90/180）がいずれもfireLeaves∈{1,2}・fireAngle∈{90,180}しか持たず、描画側
// （openings/openingPlanSymbolGeometry.js fireDoorLeafSpecs="fireLeaves===2"・
// fireFoldLeafSpecs="fireAngle===180"、openingCatalog.js hingeSideMatters）もこの2値の
// 二値分岐しかしない——任意の正数を許可すると描画側が想定しない値（例:3枚）を保存できてしまう。
const FIRE_LEAVES_VALUES = new Set([1, 2]);
const FIRE_ANGLE_VALUES = new Set([90, 180]);

/**
 * ステップ12h（設計「slideLayoutは文字列表記。tracks=2; pos fix の parse/format」）:
 * slideLayoutオブジェクト（{tracks:number, panels:Array<{arrow:'pos'|'neg'|'both'}|{fix:true}>}）を
 * 文字列表記（`tracks=<N>; <トークン> <トークン> …`。トークンはpanelsを左から順に、
 * {fix:true}は'fix'・{arrow:'pos'|'neg'|'both'}はその値）へ整形する。parseSlideLayoutの逆変換
 * （parse(format(x))がbuiltin全件でxとdeepEqualになることをテストで固定する）。
 * 不正な形（tracksが正整数でない・panelsが空/不正要素を含む）は日本語例外を投げる——
 * openingSubTypeFormFromEntryは呼び出し側でtry/catchして空文字へフォールバックする。
 * @param {{ tracks: number, panels: Array<object> }} slideLayout
 * @returns {string}
 */
export function formatSlideLayout(slideLayout) {
  const isPlainSlideLayoutObject = typeof slideLayout === 'object' && slideLayout !== null && !Array.isArray(slideLayout);
  if (!isPlainSlideLayoutObject) {
    throw new Error('引違い配置が不正です（オブジェクトが必要です）');
  }
  const { tracks, panels } = slideLayout;
  if (!(Number.isInteger(tracks) && tracks > 0)) {
    throw new Error('引違い配置のtracksは1以上の整数で指定してください');
  }
  if (!Array.isArray(panels) || panels.length === 0) {
    throw new Error('引違い配置のpanelsは1件以上必要です');
  }
  // QA指摘n1（2026-09-24再々報告）: 要素は{fix:true}または{arrow:'pos'|'neg'|'both'}の
  // どちらか一方の形だけを許す——キー集合を厳密に見る（Object.keysの個数と名前）ことで、
  // 余計なキーを含む要素（例: {arrow:'pos', fix:true}）を「fixが先に見つかったので黙って
  // arrowを捨てる」形で通さない（旧実装はp.fix===trueを先に見るだけでarrowの有無を見ていなかった）。
  const tokens = panels.map(p => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new Error(`引違い配置のpanelsに不正な要素があります: ${JSON.stringify(p)}`);
    }
    const keys = Object.keys(p);
    if (keys.length === 1 && keys[0] === 'fix' && p.fix === true) return 'fix';
    if (keys.length === 1 && keys[0] === 'arrow' && SLIDE_LAYOUT_ARROW_VALUES.has(p.arrow)) return p.arrow;
    throw new Error(`引違い配置のpanelsに不正な要素があります: ${JSON.stringify(p)}`);
  });
  return `tracks=${tracks}; ${tokens.join(' ')}`;
}

// QA指摘n1（2026-09-24再々報告）: tracksは先頭0無しの正の整数のみ（'0'や'02'のような
// 前ゼロ表記は拒否してよい——リード裁定）。上限は設けない。
const SLIDE_LAYOUT_TEXT_PATTERN = /^tracks=([1-9]\d*);\s*(.+)$/;

/**
 * ステップ12h: formatSlideLayoutの逆変換。書式は`tracks=<N>; <トークン> <トークン> …`
 * （トークンは空白区切り。'fix'または'pos'|'neg'|'both'）。不正な入力は日本語例外を投げる
 * （呼び出し側のvalidateOpeningSubTypeFormがそのままフォーム用エラーメッセージとして使う）。
 * tracks=0・tracks=02のような前ゼロ・0以下・非整数は書式不正として拒否する（上限なし）。
 * @param {string} text
 * @returns {{ tracks: number, panels: Array<{arrow:string}|{fix:true}> }}
 */
export function parseSlideLayout(text) {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') {
    throw new Error('引違い配置を入力してください（例: tracks=2; pos fix）');
  }
  const m = SLIDE_LAYOUT_TEXT_PATTERN.exec(trimmed);
  if (!m) {
    throw new Error('引違い配置の書式が不正です（例: tracks=2; pos fix）');
  }
  const tracks = Number(m[1]);
  const tokens = m[2].trim().split(/\s+/).filter(t => t !== '');
  if (tokens.length === 0) {
    throw new Error('引違い配置のpanelsは1件以上必要です（例: tracks=2; pos fix）');
  }
  const panels = tokens.map(tok => {
    if (tok === 'fix') return { fix: true };
    if (SLIDE_LAYOUT_ARROW_VALUES.has(tok)) return { arrow: tok };
    throw new Error(`引違い配置に不明な記号があります: ${tok}（pos/neg/both/fixのいずれか）`);
  });
  return { tracks, panels };
}

// keyOf(entry)は複合キー（`${category}:${key}`）を返すため、採番用の書式検査は複合キーから
// category: を除いた残りの部分に対して行う（nextInteriorMasterKeyと同じ「未使用の最小番号」規約）。
const OPENING_SUB_TYPE_USER_KEY_PATTERN = /^user(\d+)$/;

/**
 * ステップ12h（設計「keyは同カテゴリ内でuser1…を自動採番」）: allKeys（builtin・ユーザー
 * ライブラリ・文書同梱の合成キー集合。collectKnownCatalogKeys(OPENING_SUB_TYPE, builtinList)で
 * 組み立てる複合キー`category:key`の集合）のうち、同じcategoryに属するuser連番の欠番を含めて
 * 最小の未使用番号を返す（bareなkey——`${category}:`は付けない。buildOpeningSubTypeEntryの
 * categoryフィールドと組み合わせてkeyOfが複合キーを組み立てる）。
 * @param {string} category 'fitting'|'window'
 * @param {Set<string>} allKeys 複合キー（`${category}:${key}`）の集合
 * @returns {string} 'user1'・'user2'…
 */
export function nextOpeningSubTypeKey(category, allKeys) {
  const prefix = `${category}:`;
  const used = new Set();
  for (const key of allKeys ?? []) {
    if (!key.startsWith(prefix)) continue;
    const m = OPENING_SUB_TYPE_USER_KEY_PATTERN.exec(key.slice(prefix.length));
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `user${n}`;
}

/**
 * 保存済みエントリ（builtin/user/doc）からフォーム値を組み立てる（buildOpeningSubTypeEntryの
 * 逆変換）。wallKindsは配列のまま持たず、interior/exteriorそれぞれのチェック状態
 * （wallInterior/wallExterior。両方falseはwallKinds省略＝両方に出せる、と同じ意味——
 * openingCatalog.js「wallKinds省略可（両方に出す）」の規約）へ開く。数値項目は未設定なら空文字
 * （parseThicknessInputと同じ文字列化規約）。slideLayoutは文字列表記（formatSlideLayout）——
 * 不正な形（壊れた同梱データ等）はフォーム表示だけ空文字にフォールバックする（投げない。
 * このタブはentryを直接書き換えないため、表示不能な同梱データがあってもクラッシュさせない）。
 * QA指摘m1（2026-09-24再々報告・最優先）: 元entryが明示的に`wallKinds: []`（どちらの壁種にも
 * 出ない。builtinには存在しないがuser/doc行では起こりうる）を持つ場合、`wallKindsExplicitEmpty`を
 * trueにする——両チェックボックスがfalseの状態が「未設定（両方に出せる）」なのか「明示的に
 * 空（どちらにも出ない）」なのかをフォームが覚えていないと、何も編集せず保存しただけで
 * `wallKinds:[]`が黙ってキー省略（＝両方に出せる、の意味）へ反転してしまう
 * （buildOpeningSubTypeEntryがこのフラグを見て`[]`のまま保存する）。
 * @param {object} entry
 * @returns {{ category: string, key: string, label: string, mechanism: string,
 *             wallInterior: boolean, wallExterior: boolean, wallKindsExplicitEmpty: boolean,
 *             defaultWidth: string, defaultHeight: string,
 *             childRatio: string, fireLeaves: string, fireAngle: string, slideLayoutText: string }}
 */
export function openingSubTypeFormFromEntry(entry) {
  const hasWallKinds = Array.isArray(entry?.wallKinds);
  const wallKinds = hasWallKinds ? entry.wallKinds : [];
  let slideLayoutText = '';
  if (entry?.slideLayout) {
    try {
      slideLayoutText = formatSlideLayout(entry.slideLayout);
    } catch {
      slideLayoutText = '';
    }
  }
  return {
    category: entry?.category === 'window' ? 'window' : 'fitting',
    key: entry?.key ?? '',
    label: entry?.label ?? '',
    mechanism: entry?.mechanism ?? '',
    wallInterior: wallKinds.includes('interior'),
    wallExterior: wallKinds.includes('exterior'),
    wallKindsExplicitEmpty: hasWallKinds && wallKinds.length === 0,
    defaultWidth: entry?.defaultWidth == null ? '' : String(entry.defaultWidth),
    defaultHeight: entry?.defaultHeight == null ? '' : String(entry.defaultHeight),
    childRatio: entry?.childRatio == null ? '' : String(entry.childRatio),
    fireLeaves: entry?.fireLeaves == null ? '' : String(entry.fireLeaves),
    fireAngle: entry?.fireAngle == null ? '' : String(entry.fireAngle),
    slideLayoutText,
  };
}

/**
 * フォーム入力から建具種別エントリを組み立てる。key/labelの前後の空白を除く（他種別の
 * buildMaterialEntry等と同じトリム規約）。wallInterior/wallExteriorのどちらか一方でもtrueなら
 * 選択どおりのwallKinds配列を持たせる。どちらもfalseのときは、`wallKindsExplicitEmpty`
 * （QA指摘m1・openingSubTypeFormFromEntryが元entryの`wallKinds:[]`から立てるフラグ）がtrueなら
 * `wallKinds: []`をそのまま保持し、falseならwallKinds自体を持たせない
 * （openingSubTypeFormFromEntryの逆＝「未設定＝両方に出せる」の意味を保つ——空配列`[]`は
 * 「どちらにも出ない」という別の意味になるためbuildMaterialEntryのbackingClassと同様、
 * 意味が変わる値は明示フラグ無しに作り出さない）。mechanism別の欄（childRatio/fireLeaves/
 * fireAngle/slideLayout）は現在のmechanismに対応するものだけをentryへ持たせる——他の機構へ
 * 切り替えたときに前の機構の入力値が保存値へ紛れ込まない（buildFixtureSymbolEntryのprofile
 * 省略と同じ設計）。slideLayoutTextの解析（parseSlideLayout）が例外を投げた場合はここでは
 * 黙って持たせない（validateOpeningSubTypeFormが同じ文字列を独立に再解析し、保存前に同じ例外
 * メッセージを返す——buildInteriorMasterEntryのceilingHeight→NaNと同じ「buildは投げない・
 * validateが再検査する」役割分担）。
 * @param {{ category?: string, key?: string, label?: string, mechanism?: string,
 *           wallInterior?: boolean, wallExterior?: boolean, wallKindsExplicitEmpty?: boolean,
 *           defaultWidth?: string|number, defaultHeight?: string|number, childRatio?: string|number,
 *           fireLeaves?: string|number, fireAngle?: string|number, slideLayoutText?: string }} form
 * @returns {object}
 */
export function buildOpeningSubTypeEntry(form) {
  const category = form?.category === 'window' ? 'window' : 'fitting';
  const mechanism = (form?.mechanism ?? '').trim();
  const entry = {
    category,
    key: (form?.key ?? '').trim(),
    label: (form?.label ?? '').trim(),
    mechanism,
    defaultWidth: Number(String(form?.defaultWidth ?? '').trim()),
    defaultHeight: Number(String(form?.defaultHeight ?? '').trim()),
  };
  const wallKinds = [];
  if (form?.wallInterior) wallKinds.push('interior');
  if (form?.wallExterior) wallKinds.push('exterior');
  if (wallKinds.length > 0) {
    entry.wallKinds = wallKinds;
  } else if (form?.wallKindsExplicitEmpty) {
    entry.wallKinds = [];
  }

  // ステップ12h（往復テストで判明）: 未入力（トリム後空文字）はNumber('')===0という有限数に
  // 化けるため、childRatio/fireLeaves/fireAngleは「トリム後の文字列が空でない」ことを先に確認
  // してからNumberへ変換する——空欄のままのbuiltin行（fireFold90等はfireLeavesを持たない）を
  // 「0」で新規に持たせてしまう事故を防ぐ（buildMaterialEntryのbackingClass省略と同じ考え方）。
  if (mechanism === OPENING_SUB_TYPE_SWING_CHILD_MECHANISM) {
    const childRatioText = (form?.childRatio ?? '').trim();
    if (childRatioText !== '') {
      const childRatio = Number(childRatioText);
      if (Number.isFinite(childRatio)) entry.childRatio = childRatio;
    }
  }
  // QA指摘m3（リード裁定・実ソース確認）: openings/openingPlanSymbol.js の機構別分岐は
  // FIRE_DOOR（fireDoorLeafSpecs呼び出し行）が fireLeaves と fireAngle の両方を読み、
  // FIRE_FOLD（fireFoldLeafSpecs呼び出し行）は fireAngle だけを読む（fireLeavesは参照しない）。
  // fireLeavesの欄はFIRE_DOORのときだけ持たせる——FIRE_FOLDにfireLeavesを持たせても描画側は
  // 一切参照しないため、無意味な値が保存値に紛れ込むのを防ぐ。
  if (mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM) {
    const fireLeavesText = (form?.fireLeaves ?? '').trim();
    if (fireLeavesText !== '') {
      const fireLeaves = Number(fireLeavesText);
      if (Number.isFinite(fireLeaves)) entry.fireLeaves = fireLeaves;
    }
  }
  if (mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM || mechanism === OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM) {
    const fireAngleText = (form?.fireAngle ?? '').trim();
    if (fireAngleText !== '') {
      const fireAngle = Number(fireAngleText);
      if (Number.isFinite(fireAngle)) entry.fireAngle = fireAngle;
    }
  }
  if (mechanism === OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM) {
    const text = (form?.slideLayoutText ?? '').trim();
    if (text !== '') {
      try {
        entry.slideLayout = parseSlideLayout(text);
      } catch {
        // 不正な入力はここでは黙って持たせない——validateOpeningSubTypeForm が同じ文字列を
        // 独立にparseSlideLayoutへ通し、保存前に同じ例外メッセージを日本語で返す。
      }
    }
  }
  return entry;
}

/**
 * ステップ12h（QA指摘m3で分離・リード裁定）: 建具種別フォームの入力から、機構別の欄
 * （childRatio/fireLeaves/fireAngle/slideLayoutText）の表示要否を判定する（.jsx側にmechanism
 * 直書きの条件分岐を残さない——fixtureSymbolFormFieldsForと同じ役割）。fireLeavesと
 * fireAngleを別フラグに分けたのは、実ソース（openings/openingPlanSymbol.js）でFIRE_DOORが
 * fireLeaves・fireAngleの両方を読み、FIRE_FOLDはfireAngleだけを読む（fireLeavesを参照しない）
 * ため——旧実装は両方を同じshowFireFieldsで束ねており、FIRE_FOLDの欄にfireLeavesを出して
 * いた（意味を持たない入力を許す不具合）。
 * @param {{ mechanism?: string }|null} form
 * @returns {{ showChildRatio: boolean, showFireLeaves: boolean, showFireAngle: boolean, showSlideLayout: boolean }}
 */
export function openingSubTypeFormFieldsFor(form) {
  const mechanism = form?.mechanism;
  return {
    showChildRatio: mechanism === OPENING_SUB_TYPE_SWING_CHILD_MECHANISM,
    showFireLeaves: mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM,
    showFireAngle: mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM || mechanism === OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM,
    showSlideLayout: mechanism === OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM,
  };
}

/**
 * ステップ12h: 建具種別フォームの検証。呼称・区分・機構（KNOWN_OPENING_MECHANISMSのいずれか）・
 * 既定幅／既定高（0より大きい数値）は追加・編集の両方で検査する。機構別の欄は、対応する
 * mechanismのときだけ・値が入力されていれば範囲を検査する（未入力は許容——openings側にも
 * 既定値フォールバックがある。openingElevationFigure.js/openingPlanSymbol.jsのentry?.childRatio
 * ?? 0.3等）。追加時（isAdding）だけキー（同カテゴリ内で採番済みのはず）の重複を検査する
 * （nextOpeningSubTypeKeyが未使用の番号を選ぶため通常は起こらないが、呼び出し側の取り違え等に
 * 備えた保険——他種別のvalidateXxxFormと同じ位置付け）。
 * @param {ReturnType<typeof openingSubTypeFormFromEntry>} form
 * @param {{ isAdding: boolean, allKeys?: Set<string>, builtinKeys?: Set<string> }} args
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateOpeningSubTypeForm(form, { isAdding, allKeys = new Set(), builtinKeys = new Set() } = {}) {
  const category = form?.category;
  if (category !== 'fitting' && category !== 'window') {
    return { ok: false, message: '区分は建具または窓のいずれかです' };
  }
  const label = (form?.label ?? '').trim();
  if (!label) return { ok: false, message: '呼称を入力してください' };
  const mechanism = (form?.mechanism ?? '').trim();
  if (!KNOWN_OPENING_MECHANISMS.includes(mechanism)) {
    return { ok: false, message: '機構を選択してください' };
  }
  const defaultWidth = Number(String(form?.defaultWidth ?? '').trim());
  if (!(Number.isFinite(defaultWidth) && defaultWidth > 0)) {
    return { ok: false, message: '既定幅は0より大きい数値を入力してください' };
  }
  const defaultHeight = Number(String(form?.defaultHeight ?? '').trim());
  if (!(Number.isFinite(defaultHeight) && defaultHeight > 0)) {
    return { ok: false, message: '既定高は0より大きい数値を入力してください' };
  }

  if (mechanism === OPENING_SUB_TYPE_SWING_CHILD_MECHANISM) {
    const childRatioText = (form?.childRatio ?? '').trim();
    if (childRatioText !== '') {
      const childRatio = Number(childRatioText);
      if (!(Number.isFinite(childRatio) && childRatio > 0 && childRatio < 1)) {
        return { ok: false, message: '子扉比率は0より大きく1より小さい数値を入力してください' };
      }
    }
  }
  // QA指摘m3（リード裁定）: fireLeaves/fireAngleは本体（openings/openingCatalog.js
  // FITTING_CATALOG）の実データがいずれも{1,2}・{90,180}の2値しか取らず、描画側
  // （openings/openingPlanSymbolGeometry.js fireDoorLeafSpecs/fireFoldLeafSpecs、
  // openingCatalog.js hingeSideMatters）も「2か否か」「180か否か」の二値分岐しかしないため、
  // 任意の正数ではなくこの2値だけを許可する（FIRE_LEAVES_VALUES/FIRE_ANGLE_VALUES）。
  // fireLeavesの欄はFIRE_DOORのときだけ検査する——FIRE_FOLDは描画側がfireLeavesを一切
  // 参照しないため検査対象に含めない（openingSubTypeFormFieldsForのshowFireLeavesと同じ判定）。
  if (mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM) {
    const fireLeavesText = (form?.fireLeaves ?? '').trim();
    if (fireLeavesText !== '' && !FIRE_LEAVES_VALUES.has(Number(fireLeavesText))) {
      return { ok: false, message: '防火枚数は1または2のみ入力できます' };
    }
  }
  if (mechanism === OPENING_SUB_TYPE_FIRE_DOOR_MECHANISM || mechanism === OPENING_SUB_TYPE_FIRE_FOLD_MECHANISM) {
    const fireAngleText = (form?.fireAngle ?? '').trim();
    if (fireAngleText !== '') {
      const fireAngle = Number(fireAngleText);
      if (!FIRE_ANGLE_VALUES.has(fireAngle)) {
        return { ok: false, message: '防火角度は90または180のみ入力できます' };
      }
    }
  }
  if (mechanism === OPENING_SUB_TYPE_SLIDE_LAYOUT_MECHANISM) {
    const text = (form?.slideLayoutText ?? '').trim();
    if (text === '') {
      return { ok: false, message: '引違い配置を入力してください（例: tracks=2; pos fix）' };
    }
    try {
      parseSlideLayout(text);
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  if (isAdding) {
    const key = (form?.key ?? '').trim();
    if (!key) return { ok: false, message: 'キーが割り当てられていません' };
    const composite = `${category}:${key}`;
    if (builtinKeys.has(composite) || allKeys.has(composite)) {
      return { ok: false, message: `既に使われているキーです: ${composite}` };
    }
  }
  return { ok: true };
}

/**
 * ステップ12h: 建具種別タブのフォーム無効化理由（fixtureSymbolRowDisabledReasonと同型。
 * 建具種別はどの行もカテゴリ単位の一律拒否を持たない）。
 * @param {{ isAdding: boolean, editState?: { canEdit: boolean, reason: string|null } | null }} args
 * @returns {string|null}
 */
export function openingSubTypeRowDisabledReason({ isAdding, editState = null } = {}) {
  return editStateDisabledReason({ isAdding, editState });
}
