import { useEffect, useMemo, useState } from 'react';
import './CatalogMaintenancePanel.css';
import {
  CatalogKind, kindDef, MATERIAL_CLASSES, FIXTURE_SYMBOL_PROFILES, KNOWN_OPENING_MECHANISMS,
} from '../catalog/catalogKinds.js';
import { parseMaterialCode } from '../catalog/materialCode.js';
import { docDiffMap, overlayFor, removeDocEntry } from '../catalog/catalogRegistry.js';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffPairs, diffTooltip, fieldLabel } from '../catalog/catalogDiffView.js';
import { saveUserCatalog } from '../storage/db.js';
import { markDirty } from '../dirtyState.js';
import { collectCurrentCatalogUsage } from '../store.js';
import { WOOD_STUD_CODE_BY_SIZE, backingClassOf } from '../finish/materials/backingClass.js';
import {
  buildKindTabs, buildMaterialRows, buildCatalogRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserCatalogEntry, commitUserEntries,
  realignPlansFor, realignTargets, planBulkSectionImport, formatReadonlyValue, formatCategoryLabel,
  isEditableMaterialCategory, parseThicknessInput, MATERIAL_CATEGORY, BACKING_CLASS_OPTIONS,
  rowEditState, lockedFieldsFor, planSaveEntry, planRevertToBuiltin, planRemoveUserEntry,
  applyCatalogEditPlan, materialExtraLockedFields, materialSaveMessage, catalogSaveMessage,
  lockedFieldReason, materialRowDisabledReason, removeMessageFor, backingClassDisplayFor,
  buildFixtureSymbolEntry, validateFixtureSymbolForm, fixtureSymbolFormFieldsFor,
  fixtureSymbolRowDisabledReason, collectKnownCatalogKeys,
  fixtureSymbolFormFromEntry, fixtureSymbolPreviewEntry, categoryOptionsFor,
  nextInteriorMasterKey, interiorMasterFormFromEntry, buildInteriorMasterEntry,
  validateInteriorMasterForm, interiorMasterRowDisabledReason,
  sectionFormFromEntry, buildSectionEntry, validateSectionForm, sectionRowDisabledReason,
  nextOpeningSubTypeKey, openingSubTypeFormFromEntry, buildOpeningSubTypeEntry,
  validateOpeningSubTypeForm, openingSubTypeFormFieldsFor, openingSubTypeRowDisabledReason,
  formatMechanismLabel, collectExportableEntries, formatBuiltinSource,
} from '../catalog/catalogMaintenance.js';
import { parseSectionSpecList } from '../structural/sectionCatalog.js';
import { CatalogPreview } from './CatalogPreview.jsx';

// ステップ12b: 間柱6コード（backingClass.js WOOD_STUD_CODE_BY_SIZE の値）は本体編集の
// extraLockedとして常に注入する（12cで下地材タブを開放するまでは実際にこのコードを持つ行を
// このタブで選択できないため効果は無いが、12cで背景を開いたときに配線をやり直さずに済むよう
// 先に配線しておく——設計 12b「間柱6件はextraLockedで注入」）。ステップ12c: 下地材タブを開放した
// ことでこのextraLockedが実効化する（間柱6件だけx/y/thicknessも固定）。
const STUD_CODE_SET = new Set(Object.values(WOOD_STUD_CODE_BY_SIZE));

// materialData.js（本体マスタ）は仕上げモードと同じ理由でここでも動的 import する
// （EccentricityDialog.jsxと同型。コード分割維持——materialData.jsは独立チャンクのまま）。
// structural/sectionCatalog.jsは既にstructural/structuralEntities.js等から静的importされており
// 独立チャンクにならない（catalogKinds.jsのコメント参照）ため、ここでは静的importでよい
// （規格文字列の一括入力パーサ parseSectionSpecList を呼ぶためだけに使う。SECTION_CATALOG自体は
// 引き続きkindDef(section).loadBuiltin()の動的importで読む）。

const ORIGIN_LABELS = Object.freeze({ doc: '同梱', user: 'ライブラリ', builtin: '標準' });

// ステップ7d: 内装マスター・境界マスターの閲覧タブ（読み取り専用）に並べる項目。
// ステップ8h: 断面も同じ閲覧タブ（ReadonlyKindTab）に並べる項目を追加。
// ステップ10f: 建具種別（openingSubType）も追加。
// QA指摘Minor-1（2026-09-23）: ラベル文字列はここでは持たない——catalog/catalogDiffView.js の
// FIELD_LABELS（「唯一の定義箇所」と宣言済み）を fieldLabel(kind, field) で引く。ここは
// field名の配列だけを持つ（同じタブ内でツールチップ（diffTooltip）と詳細欄で別の日本語名が
// 同時に出る二重定義を防ぐ）。
// 追加・複製・編集・削除・合わせ直しボタンは出さない（選ぶ経路が無い・layers/fieldsの編集UIは
// 複雑・編集はステップ12でまとめて着手する裁定）。
// ステップ12g: 内装マスター（InteriorMasterTab）・断面（SectionTab）は編集タブへ移行したため、
// ここには含めない（12fのfixtureSymbol移行と同型）。境界マスターは範囲外のため引き続き閲覧のみ。
// ステップ12h: 建具種別（openingSubType）も専用の編集タブ（OpeningSubTypeTab）へ移行したため、
// READONLY_KIND_FIELDSに残るのは境界マスターのみになった。
const READONLY_KIND_FIELDS = Object.freeze({
  [CatalogKind.BOUNDARY_MASTER]: Object.freeze(['label', 'kind', 'layers', 'derivedFrom', 'fields']),
});

/** layers（境界マスター）1件を「役割: コード or src」の1行文字列にする。 */
function formatLayerLine(layer) {
  const source = layer.code ?? layer.src ?? '（未指定）';
  return `${layer.role}: ${source}`;
}

/**
 * READONLY_KIND_FIELDSの1項目値を読み取り専用表示用の文字列にする。layers・fields（境界マスター）は
 * 専用の書式を持つためここで個別に扱う。category（QA指摘Minor-2・2026-09-23: material/openingSubType
 * 双方が持つfield名のためkindも渡し、catalog/catalogMaintenance.jsのformatCategoryLabel(kind, value)
 * で種別ごとに和訳する——field名だけで分岐すると他種別のcategoryと衝突するため）。それ以外
 * （openingSubTypeのwallKinds/slideLayout等の配列・plainオブジェクトを含む）は
 * catalog/catalogMaintenance.jsのformatReadonlyValue（汎用整形。ステップ10f）に委ねる。
 */
function formatReadonlyFieldValue(kind, field, value) {
  if (field === 'layers') {
    return Array.isArray(value) && value.length > 0 ? value.map(formatLayerLine).join(' / ') : '（なし）';
  }
  if (field === 'fields') {
    const entries = value ? Object.entries(value) : [];
    return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ') : '（なし）';
  }
  if (field === 'category') {
    return formatCategoryLabel(kind, value);
  }
  return formatReadonlyValue(value);
}

function firstMajor() {
  return Number(Object.keys(MATERIAL_CLASSES)[0]);
}
function firstMinor(major) {
  const keys = Object.keys(MATERIAL_CLASSES[major]?.minors ?? {});
  return keys.length ? Number(keys[0]) : 0;
}

/**
 * catalogRegistry.js の overlay（モジュール単位の可変状態。Reactが追跡しない）から
 * 一覧・採番用コード集合を組み立てる。保存・削除の直後にも同じ関数で明示的に取り直す
 * （モジュール関数のため useEffect の依存配列に含めなくてよい＝react-hooks/exhaustive-deps
 * を偽の依存で黙らせない）。
 */
function computeDerived(list, search, category) {
  if (!list) return { allRows: [], visibleRows: [], knownCodes: new Set() };
  // doc（文書同梱）起源の材が本体と不一致な分だけを集める（毎レンダー取り直し。
  // overlayFor と同じくモジュール単位の可変状態のため useMemo でキャッシュしない）。
  const diffMap = docDiffMap(CatalogKind.MATERIAL, list);
  const allRows = buildMaterialRows({ builtinList: list, diffMap });
  const visibleRows = buildMaterialRows({ builtinList: list, search, category: category || null, diffMap });
  const { doc, user } = overlayFor(CatalogKind.MATERIAL);
  const knownCodes = collectKnownMaterialCodes({ builtinList: list, doc, user });
  return { allRows, visibleRows, knownCodes };
}

// ステップ12c: 下地材（category:'backing'）はX/Y入力・下地区分（backingClass）選択欄を
// フォームに出す。判断（どのcategoryで寸法欄を持つか）は純関数側（buildMaterialEntryの
// category分岐）に置き、ここは表示の要否だけを見る薄い判定。
function materialFormHasDimensions(category) {
  return category === MATERIAL_CATEGORY.BACKING;
}

function formFromEntry(entry) {
  const parsed = parseMaterialCode(entry.code);
  return {
    name: entry.name ?? '',
    spec: entry.spec ?? '',
    thickness: entry.thickness == null ? '' : String(entry.thickness),
    note: entry.note ?? '',
    category: entry.category,
    major: parsed?.major ?? firstMajor(),
    minor: parsed?.minor ?? firstMinor(parsed?.major ?? firstMajor()),
    // ステップ12c QA指摘n1対応: 下地材（category:'backing'）の編集開始時は元entryのx/yを
    // 引き継ぐ（buildMaterialEntryへそのまま渡す。変更しなければlockedFieldsForの一致検査を
    // 通る——間柱6件のextraLocked（x/y/thickness）対策）。面材・仕上げ材はどのみち
    // buildMaterialEntryが0固定にするため、entry.x/yをそのまま持たせても無害。
    x: entry.x ?? 0,
    y: entry.y ?? 0,
    backingClass: entry.backingClass ?? '',
  };
}

/**
 * ハンバーガー「カタログ保守」から開く全画面パネル。材料（面材・仕上げ材・下地材の全カテゴリ）の
 * 一覧／追加／複製／編集／削除（ステップ12c・2026-09-24: 下地材も開放。x/y・下地区分
 * （backingClass:木/その他）が必須。RCは選べない——固定集合のみ）。
 * builtin（標準材料）の編集も含む（ステップ12a/12b/12c: 同キーのuserエントリ＋
 * overridesBuiltin:trueで表す）。
 *
 * 純ロジック（一覧の合成・検索・採番・検証）は catalog/catalogMaintenance.js に持つ
 * （本コンポーネントはそれを呼ぶだけ）。
 */
export function CatalogMaintenancePanel({ onClose }) {
  const [activeKind, setActiveKind] = useState(CatalogKind.MATERIAL);
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(false);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const [selectedCode, setSelectedCode] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formMessage, setFormMessage] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // ステップ12b（削除確認の使用状況）: null | { status: 'loading'|'ready'|'error', usedKeys?: Set, message?: string }
  const [deleteUsage, setDeleteUsage] = useState(null);
  // ステップ6b（合わせ直し）: ステップ14-A1でuseRealignActions（kind汎用フック）へ移設した
  // （realignConfirm state・realignPlansの毎レンダー再計算・handleRealignConfirmedを含む。
  // realignPlansはuseMemoでキャッシュしない——承認直前の最新overlay状態を反映するため）。
  // ステップ12b（Q-C: 使用中のdoc-same行の保存確認）: null | { plan, entryCode, confirmPairs, overridesBuiltin, thicknessChanged }
  const [saveConfirm, setSaveConfirm] = useState(null);
  // ステップ12b（標準に戻す確認）: null | { key, alsoRealignDoc }
  const [revertConfirm, setRevertConfirm] = useState(null);
  // ステップ12b QA指摘m2（2026-09-24再報告）: 承認系ボタンの二重押し防止。保存・削除・標準に戻す
  // の非同期処理の実行中だけtrueにする（該当ボタンをdisabledにする唯一の判定）。
  const [busy, setBusy] = useState(false);

  // ステップ7d: 内装マスター・境界マスターの閲覧タブ（読み取り専用）用の状態。material（左記の
  // builtinList/selectedCode等）とは別に持つ——編集フォーム系のstateを閲覧タブへ誤って持ち込まない。
  const [readonlyBuiltinByKind, setReadonlyBuiltinByKind] = useState({}); // kind -> builtin一覧
  const [readonlySearch, setReadonlySearch] = useState('');
  const [readonlySelectedKey, setReadonlySelectedKey] = useState(null);

  // ステップ12i QA指摘M1（2026-09-24再報告・案(b)）: overlay（catalog/catalogRegistry.js）は
  // モジュール単位の可変状態でReactが変化を追跡しない。DeveloperExportPanelは各種別タブと別の
  // コンポーネント（FixtureSymbolTab/InteriorMasterTab/SectionTab/OpeningSubTypeTabはそれぞれ
  // 自身のstateだけで完結し、保存・削除・標準に戻す後もこの親コンポーネントは再レンダーされない）
  // のため、開いたまま他タブでuserライブラリを編集してもDeveloperExportPanelの表示が更新
  // されない（症状そのもの）。userライブラリを実際に変更した操作（保存・削除・標準に戻す・
  // 断面の一括追加）の完了時にlibraryTickを1つ進め、それをDeveloperExportPanelへpropsで渡す
  // （keyにはしない——keyでの再マウントはopen/builtinList/loadErrorも失い「開いたまま」の要件と
  // 矛盾する）。材料タブ（この親コンポーネント自身がstateを持つ）の保存・削除・標準に戻すでも
  // 同じtickを進める——DeveloperExportPanel側をuseMemo(deps:[...,libraryTick])にするため、
  // 親の再レンダーだけでは再計算されない（tickを進めない操作を1つでも取りこぼすと、その操作
  // だけ症状が再発する）。
  const [libraryTick, setLibraryTick] = useState(0);
  function handleLibraryChanged() {
    setLibraryTick(t => t + 1);
  }

  useEffect(() => {
    let cancelled = false;
    import('../finish/materials/materialData.js').then(m => {
      if (!cancelled) setBuiltinList(m.MATERIALS);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  // 閲覧タブを開いたとき（activeKindが内装・境界マスターへ切り替わったとき）だけ
  // kindDef(kind).loadBuiltin() で動的importする（一度読んだ種別はキャッシュして読み直さない）。
  useEffect(() => {
    if (!READONLY_KIND_FIELDS[activeKind]) return;
    if (readonlyBuiltinByKind[activeKind]) return;
    let cancelled = false;
    kindDef(activeKind).loadBuiltin().then(list => {
      if (!cancelled) setReadonlyBuiltinByKind(prev => ({ ...prev, [activeKind]: list }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeKind, readonlyBuiltinByKind]);

  // catalogRegistry.js の overlay はモジュール単位の可変状態（Reactが追跡しない）ため、
  // useMemoでキャッシュせず毎レンダー computeDerived を呼び直す（保存・削除後の他state更新に
  // 伴う再レンダーで、変更後のoverlayを常に読み直す。材は高々数百件のため毎回の再合成は軽い）。
  const { allRows, visibleRows, knownCodes } = builtinList
    ? computeDerived(builtinList, search, categoryFilter)
    : { allRows: [], visibleRows: [], knownCodes: new Set() };

  const kindTabs = useMemo(() => buildKindTabs(), []);

  const previewCode = (isAdding && form) ? nextMaterialCode(form.major, form.minor, knownCodes) : null;

  const selectedRow = (!isAdding && selectedCode)
    ? allRows.find(r => r.entry.code === selectedCode) ?? null
    : null;

  // ステップ12b: builtin一覧のキー集合（rowEditState/lockedFieldsForに渡すDI引数。生成は
  // builtinListが変わったとき（読み込み完了時）だけでよいためuseMemoでキャッシュする）。
  const builtinKeys = useMemo(
    () => new Set((builtinList ?? []).map(e => e.code)),
    [builtinList],
  );
  // ステップ12b（本体編集の状態判定）: 編集中（!isAdding）の選択行だけ判定する
  // （新規追加はrowEditStateの対象外＝固定項目検査もplanSaveEntry側でprevEntry省略として扱う）。
  const editState = selectedRow ? rowEditState(CatalogKind.MATERIAL, selectedRow, { builtinKeys }) : null;
  const lockedFields = (selectedRow)
    ? lockedFieldsFor(CatalogKind.MATERIAL, selectedRow.entry.code, {
        builtinKeys, extraLocked: materialExtraLockedFields(selectedRow.entry.code, STUD_CODE_SET),
      })
    : new Set();
  // ステップ12c QA指摘m2（2026-09-24再報告）: 下地区分selectの表示値。backingClassが
  // ロック（本体の下地材＝backingClassフィールド自体を持たない）されている行は、選択済み値
  // （常に空）の代わりに backingClassOf（固定集合＋overlay）由来の分類を表示専用で見せる
  // （RCも見せられる。保存にはform.backingClassをそのまま使うので影響しない）。
  const backingClassSelectValue = (selectedRow && lockedFields.has('backingClass'))
    ? backingClassDisplayFor(selectedRow.entry, backingClassOf)
    : form?.backingClass ?? '';

  // 選択行が doc（文書同梱）起源で本体と不一致のとき、違っている項目だけを
  // フォームでオレンジ表示＋本体値併記する（doc は編集不可＝表示のみ）。
  // diffPairs(kind, from=本体, to=doc, diffFields) — diffFields は row.diff（docDiffMap）が
  // 既に持つものをそのまま渡し、等価判定を再計算しない。
  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.MATERIAL, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  // ステップ12b（1章: 標準の上書き行はbuiltinEntryと違う項目に本体値を併記。差分表示のオレンジとは
  // 別の意味（不一致の通知ではなく「標準からの差分」の参考表示）のため色は変えない）。
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.MATERIAL, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  const fmtDiffValue = v => (v === null || v === undefined || v === '' ? '未設定' : String(v));

  // ステップ14-A1（課題A1）: 「合わせ直す」はkind汎用フックuseRealignActionsへ委譲する
  // （targets=realignTargets(allRows)・plansの組み立て・確定処理・完了通知は全てフック内）。
  // onRealigned: 選択中の行が対象に含まれていた場合、出所（doc→user/builtin）が変わりformが
  // 古い同梱値のままになるため選択を外す（旧・材料タブ直書きのhandleRealignConfirmedと同じ扱い）。
  // onError: QA指摘Minor-3（2026-09-24再報告）で渡さない方針にした——formErrorはフォームが開いて
  // いないと見えない穴があり、フックのnotice（ツールバー直下・常に見える）と二重表示になるだけで
  // 意味が無い。エラー表示はフックのnoticeだけに一本化する（materialTab以外のonError利用は
  // フック側に任意のまま残す）。合わせ直しはユーザーライブラリを変えないためonLibraryChangedは
  // 渡さない。
  const realign = useRealignActions(CatalogKind.MATERIAL, {
    builtinList, allRows, onRealigned: handleMaterialRealigned,
  });

  // ステップ12b QA指摘m4（2026-09-24再報告）: フォーム無効化理由はcatalog/catalogMaintenance.jsの
  // materialRowDisabledReasonで一本化する（.jsx側で三項演算子チェーンを再実装しない）。
  const disabledReason = form ? materialRowDisabledReason({ isAdding, category: form.category, editState }) : null;
  // 複製ボタンはcategoryだけで判定する（origin=builtin/docの行も、複製してユーザーライブラリの
  // 新規エントリを作る経路としては許可する。編集不可＝rowEditableとは別軸。rowEditStateの
  // canDuplicateは全状態でtrueのため、実質categoryだけの判定で変わらない）。
  const duplicatable = form ? isEditableMaterialCategory(form.category) : false;

  function handleAddNew() {
    const major = firstMajor();
    setIsAdding(true);
    setSelectedCode(null);
    setConfirmingDelete(false);
    setDeleteUsage(null);
    setSaveConfirm(null);
    setRevertConfirm(null);
    setForm({
      name: '', spec: '', thickness: '', note: '', category: MATERIAL_CATEGORY.PANEL, major, minor: firstMinor(major),
      x: '', y: '', backingClass: '',
    });
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedCode(row.entry.code);
    setConfirmingDelete(false);
    setDeleteUsage(null);
    setSaveConfirm(null);
    setRevertConfirm(null);
    setForm(formFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleDuplicateClick(row) {
    const copy = duplicateMaterialEntry(row.entry, knownCodes);
    setIsAdding(true);
    setSelectedCode(null);
    setConfirmingDelete(false);
    setDeleteUsage(null);
    setSaveConfirm(null);
    setRevertConfirm(null);
    setForm(formFromEntry(copy));
    setFormError('複製しました。名称を変更してから保存してください（同内容のままでは保存できません）');
    setFormMessage(null);
    realign.clearNotice();
  }

  // ステップ12b（本体編集の保存適用。ok:trueのplanを永続化しメッセージを出す。新規追加・
  // 既存行の直接保存・doc-same/doc-override確認後の保存の3経路が共有する唯一の末尾処理——
  // QA指摘n2: 新規追加もplanSaveEntry+applyCatalogEditPlanへ寄せ、保存経路を1本にする）。
  // QA指摘m2: busyで二重押しを防ぐ（呼び出し側のボタンはbusy中disabled。ここでも念のため
  // 多重実行を防止する）。
  async function performSave(plan, entryCode, { overridesBuiltin, thicknessChanged }) {
    if (busy) return;
    setBusy(true);
    try {
      await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      setFormError(`保存に失敗しました: ${e.message}`);
      setSaveConfirm(null);
      return;
    } finally {
      setBusy(false);
    }
    setIsAdding(false);
    setSelectedCode(entryCode);
    setFormMessage(materialSaveMessage({ overridesBuiltin, thicknessChanged }));
    setSaveConfirm(null);
    realign.clearNotice();
    handleLibraryChanged();
  }

  async function handleSave() {
    if (!form) return;
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
    const thickness = parseThicknessInput(form.thickness);
    if (form.thickness.trim() !== '' && Number.isNaN(thickness)) {
      setFormError('厚さは数値で入力してください');
      return;
    }
    const code = isAdding ? previewCode : selectedCode;
    const entry = buildMaterialEntry({
      code, name: form.name, spec: form.spec, thickness, note: form.note, category: form.category,
      x: Number(form.x), y: Number(form.y), backingClass: form.backingClass || undefined,
    });

    if (isAdding) {
      // QA指摘n2: 新規追加もplanSaveEntry+applyCatalogEditPlan（performSave）へ寄せる。
      // validateMaterialEntryは引き続き使う——planSaveEntryにはcategoryの編集可否ゲート・
      // 下地材の必須項目検査（x/y>0・backingClass）が無いため（planSaveEntryは5種別共通の汎用関数で
      // material専用のカテゴリ制約を持たせられない）。def.validate/重複禁止検査はplanSaveEntry側でも
      // 再検査されるが、この新規追加経路は高々数百件の材一覧に対する1回の合成のため
      // 無視できる規模——二重実装というより「同じ検査を2箇所が独立に通す」保険的な重複であり、
      // 永続化手順（nextUser組み立て・overridesBuiltin付与・commit）自体の二重実装は解消する。
      const result = validateMaterialEntry(entry, builtinList);
      if (!result.ok) { setFormError(result.message); return; }
      const plan = planSaveEntry(CatalogKind.MATERIAL, entry, { builtinList, rowState: null });
      if (!plan.ok) { setFormError(plan.message); return; }
      await performSave(plan, entry.code, { overridesBuiltin: plan.overridesBuiltin, thicknessChanged: plan.thicknessChanged });
      return;
    }

    // ステップ12b（本体編集）: builtin/override/user/doc-same/doc-override行の編集は
    // planSaveEntry経由（固定項目検査・重複禁止検査・overridesBuiltin付与・doc-same/doc-overrideの
    // confirmPairsをここに集約）。QA指摘m4: overridesBuiltin/thicknessChanged/needsConfirmは
    // planの戻り値をそのまま使う（.jsx側で再計算しない）。QA指摘m1: noop:trueなら
    // 何もせず「変更はありません」を出す。
    const prevEntry = selectedRow?.entry ?? null;
    const plan = planSaveEntry(CatalogKind.MATERIAL, entry, {
      builtinList,
      rowState: editState?.state ?? null,
      prevEntry,
      extraLocked: materialExtraLockedFields(selectedCode, STUD_CODE_SET),
    });
    if (!plan.ok) { setFormError(plan.message); return; }
    if (plan.noop) { setFormMessage('変更はありません'); return; }

    // Q-C: 使用中のdoc-same/doc-override行は確認のうえ同梱を外して保存する。
    if (plan.needsConfirm) {
      setSaveConfirm({
        plan, entryCode: entry.code, confirmPairs: plan.confirmPairs,
        overridesBuiltin: plan.overridesBuiltin, thicknessChanged: plan.thicknessChanged,
      });
      return;
    }
    await performSave(plan, entry.code, { overridesBuiltin: plan.overridesBuiltin, thicknessChanged: plan.thicknessChanged });
  }

  function handleSaveConfirmed() {
    if (!saveConfirm || busy) return;
    performSave(saveConfirm.plan, saveConfirm.entryCode, saveConfirm);
  }

  // ステップ12b QA指摘M1（2026-09-24再報告）: 削除確認の使用状況は store.js の
  // collectCurrentCatalogUsage（未保存の作業中の編集を含む「現在の」使用キー）経由で取得する
  // ——旧実装（loadAllSavedFloors→collectCatalogUsageAcrossFloors）は最後に明示保存した内容
  // しか見ず、保存前の削除で参照が宙に浮く事故があった（削除はライブラリから外すだけとする原則への違反）。
  async function handleDeleteClick() {
    setConfirmingDelete(true);
    setFormError(null);
    setDeleteUsage({ status: 'loading' });
    try {
      const usedKeysByKind = await collectCurrentCatalogUsage();
      setDeleteUsage({ status: 'ready', usedKeys: usedKeysByKind.get(CatalogKind.MATERIAL) ?? new Set() });
    } catch (e) {
      setDeleteUsage({ status: 'error', message: e.message });
    }
  }

  async function handleDeleteConfirmed() {
    if (!selectedRow || !deleteUsage || deleteUsage.status !== 'ready' || busy) return;
    let plan;
    try {
      plan = planRemoveUserEntry(CatalogKind.MATERIAL, selectedRow.entry.code, { usedKeys: deleteUsage.usedKeys });
    } catch (e) {
      setFormError(e.message);
      setConfirmingDelete(false);
      setDeleteUsage(null);
      return;
    }
    setBusy(true);
    try {
      await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      setFormError(`削除に失敗しました: ${e.message}`);
      setConfirmingDelete(false);
      setDeleteUsage(null);
      return;
    } finally {
      setBusy(false);
    }
    setIsAdding(false);
    setSelectedCode(null);
    setForm(null);
    setConfirmingDelete(false);
    setDeleteUsage(null);
    // ステップ12b QA指摘m4: 完了メッセージの文言選択はcatalog/catalogMaintenance.jsの
    // removeMessageFor(plan)経由（.jsx側でplan.docAppendの有無を再判定しない）。
    setFormMessage(removeMessageFor(plan));
    realign.clearNotice();
    handleLibraryChanged();
  }

  // ステップ12b（標準に戻す。override/doc-override行）。
  function handleRevertClick() {
    if (!selectedRow) return;
    setRevertConfirm({ key: selectedRow.entry.code, alsoRealignDoc: true });
  }

  async function handleRevertConfirmed() {
    if (!revertConfirm || busy) return;
    const plan = planRevertToBuiltin(CatalogKind.MATERIAL, revertConfirm.key, { alsoRealignDoc: revertConfirm.alsoRealignDoc });
    setBusy(true);
    try {
      await applyCatalogEditPlan(CatalogKind.MATERIAL, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      setFormError(`標準に戻す処理に失敗しました: ${e.message}`);
      setRevertConfirm(null);
      return;
    } finally {
      setBusy(false);
    }
    setIsAdding(false);
    setSelectedCode(null);
    setForm(null);
    setRevertConfirm(null);
    setFormMessage('標準に戻しました');
    realign.clearNotice();
    handleLibraryChanged();
  }

  // ステップ14-A1（課題A1）: useRealignActionsのonRealigned。合わせ直し対象キーに選択中の行が
  // 含まれていた場合、出所（doc→user/builtin）が変わりformが古い同梱値のままになるため、
  // 選択を外して再選択を促す（旧・材料タブ直書きのhandleRealignConfirmedと同じ扱い）。
  function handleMaterialRealigned(keys) {
    if (selectedCode && keys.includes(selectedCode)) {
      setIsAdding(false);
      setSelectedCode(null);
      setForm(null);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); }
  }

  return (
    <div
      className="catmnt-backdrop"
      onPointerDown={e => { if (e.target === e.currentTarget) onClose?.(); }}
      onKeyDown={handleKeyDown}
    >
      <div className="catmnt-panel">
        <div className="catmnt-header">
          <span>カタログ保守</span>
          <button className="catmnt-close-btn" onClick={onClose}>閉じる</button>
        </div>

        {/* ステップ12i: 開発者向けエクスポート（現在選択中のkind）。catmnt-bodyは種別タブ・
            一覧・詳細の横並びflexのため、その中の1項目にすると縦の列になってしまう——
            ヘッダー直下・catmnt-bodyの外に横幅いっぱいの帯として置く。 */}
        <DeveloperExportPanel key={activeKind} kind={activeKind} libraryTick={libraryTick} />

        <div className="catmnt-body">
          {/* 左: 種別タブ（材料は追加・編集・削除まで実装。内装マスター・境界マスター・断面・
              建具種別（openingSubType）は閲覧のみ。ステップ10fで全種別がenabled:trueになった） */}
          <div className="catmnt-kind-tabs">
            {kindTabs.map(tab => (
              <button
                key={tab.kind}
                className={`catmnt-kind-tab${tab.kind === activeKind ? ' catmnt-kind-tab--active' : ''}`}
                disabled={!tab.enabled}
                onClick={() => {
                  if (!tab.enabled) return;
                  setActiveKind(tab.kind);
                  // タブを切り替えたら閲覧タブの検索・選択をリセットする（前のタブの選択を持ち越さない）。
                  setReadonlySearch('');
                  setReadonlySelectedKey(null);
                }}
              >
                {tab.label}
                {!tab.enabled && <span className="catmnt-kind-tab-note">準備中</span>}
              </button>
            ))}
          </div>

          {activeKind === CatalogKind.MATERIAL && (
            <>
              {/* 中央: 一覧 */}
              <div className="catmnt-list-col">
                <div className="catmnt-list-toolbar">
                  <input
                    className="catmnt-search-input"
                    placeholder="名称で検索"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  <select
                    className="catmnt-category-select"
                    value={categoryFilter}
                    onChange={e => setCategoryFilter(e.target.value)}
                  >
                    <option value="">すべてのカテゴリ</option>
                    <option value={MATERIAL_CATEGORY.PANEL}>面材</option>
                    <option value={MATERIAL_CATEGORY.FINISH}>仕上げ材</option>
                    <option value={MATERIAL_CATEGORY.BACKING}>下地材</option>
                  </select>
                  <button className="catmnt-add-btn" disabled={!builtinList} onClick={handleAddNew}>
                    + 新規追加
                  </button>
                  {realign.targets.length > 0 && (
                    <button
                      className="catmnt-btn catmnt-btn--secondary"
                      onClick={() => realign.requestRealign(realign.targets.map(r => r.entry.code))}
                    >
                      すべて本体の内容に合わせ直す（{realign.targets.length}件・絞り込みに関わらず全件）
                    </button>
                  )}
                </div>

                {/* ステップ14-A1: 完了通知・失敗通知はuseRealignActionsのnotice経由でツールバー直下に
                    出す（旧実装はformMessage/formErrorへ書いていたため{form && …}の中でしか
                    見えなかった穴を塞ぐ。案(a)・2026-09-24裁定）。 */}
                {realign.notice && (
                  <div className={realign.notice.kind === 'error' ? 'catmnt-form-error' : 'catmnt-form-message'}>
                    {realign.notice.text}
                  </div>
                )}

                {/* ステップ6b/14-A1: 合わせ直しの確認（単一行・一括のどちらも同じ型。削除確認と同様インライン） */}
                {realign.realignConfirm && (
                  <RealignConfirmBlock
                    plans={realign.plans}
                    onConfirm={realign.handleRealignConfirmed}
                    onCancel={realign.cancelRealign}
                  />
                )}

                <div className="catmnt-rows">
                  {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
                  {loadError && <div className="catmnt-row-empty">材料データの読み込みに失敗しました</div>}
                  {builtinList && visibleRows.length === 0 && (
                    <div className="catmnt-row-empty">該当する材料がありません</div>
                  )}
                  {visibleRows.map(row => (
                    <div
                      key={row.entry.code}
                      className={`catmnt-row${(!isAdding && row.entry.code === selectedCode) ? ' catmnt-row--selected' : ''}`}
                      onClick={() => handleSelectRow(row)}
                    >
                      <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                        {ORIGIN_LABELS[row.origin] ?? '?'}
                      </span>
                      {/* ステップ12b（1章）: userエントリがbuiltin同キーの上書きの行に「標準を編集」バッジを添える。 */}
                      {row.overridesBuiltin && (
                        <span className="catmnt-badge catmnt-badge--override">標準を編集</span>
                      )}
                      <span
                        className="catmnt-row-name"
                        style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                        title={row.diff ? diffTooltip(CatalogKind.MATERIAL, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
                      >
                        {row.entry.name}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
                      </span>
                      <span className="catmnt-cat-badge">{formatCategoryLabel(CatalogKind.MATERIAL, row.entry.category)}</span>
                      {row.diff && (
                        <button
                          className="catmnt-realign-btn"
                          title="本体の内容に合わせ直す"
                          onClick={e => { e.stopPropagation(); realign.requestRealign([row.entry.code]); }}
                        >
                          合わせ直す
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 右: 編集フォーム */}
              <div className="catmnt-form-col">
                {!form && (
                  <div className="catmnt-form-empty">左の一覧から材料を選択するか、「+ 新規追加」してください</div>
                )}
                {form && (
                  <>
                    {disabledReason && <div className="catmnt-form-note">{disabledReason}</div>}

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">材料コード</span>
                      <span className="catmnt-code-readout">{isAdding ? (previewCode ?? '-') : selectedCode}</span>
                    </div>

                    {isAdding && (
                      <>
                        <div className="catmnt-form-row">
                          <span className="catmnt-form-label">大分類</span>
                          <select
                            value={form.major}
                            onChange={e => {
                              const major = Number(e.target.value);
                              setForm(f => ({ ...f, major, minor: firstMinor(major) }));
                            }}
                          >
                            {Object.entries(MATERIAL_CLASSES).map(([major, cls]) => (
                              <option key={major} value={Number(major)}>{cls.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="catmnt-form-row">
                          <span className="catmnt-form-label">中分類</span>
                          <select
                            value={form.minor}
                            onChange={e => setForm(f => ({ ...f, minor: Number(e.target.value) }))}
                          >
                            {Object.entries(MATERIAL_CLASSES[form.major]?.minors ?? {}).map(([minor, label]) => (
                              <option key={minor} value={Number(minor)}>{label}</option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">カテゴリ</span>
                      <select
                        value={form.category}
                        disabled={!!disabledReason || lockedFields.has('category')}
                        title={lockedFields.has('category') ? lockedFieldReason(CatalogKind.MATERIAL, 'category') : undefined}
                        style={docDiffByField.has('category') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                      >
                        <option value={MATERIAL_CATEGORY.PANEL}>面材</option>
                        <option value={MATERIAL_CATEGORY.FINISH}>仕上げ材</option>
                        {/* ステップ12c: 下地材も選択肢として常に出す（追加・編集とも開放）。 */}
                        <option value={MATERIAL_CATEGORY.BACKING}>下地材</option>
                      </select>
                      {/* doc（文書同梱）が本体と不一致の項目だけ、本体値をオレンジで併記する */}
                      {docDiffByField.has('category') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {formatCategoryLabel(CatalogKind.MATERIAL, docDiffByField.get('category').from)}）
                        </span>
                      )}
                      {/* ステップ12b: 標準の上書き行は、標準値と違う項目に本体値を参考併記する（オレンジにはしない）。 */}
                      {builtinDiffByField.has('category') && (
                        <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                          （標準 {formatCategoryLabel(CatalogKind.MATERIAL, builtinDiffByField.get('category').from)}）
                        </span>
                      )}
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">名称</span>
                      <input
                        value={form.name}
                        disabled={!!disabledReason}
                        style={docDiffByField.has('name') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      />
                      {docDiffByField.has('name') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {fmtDiffValue(docDiffByField.get('name').from)}）
                        </span>
                      )}
                      {builtinDiffByField.has('name') && (
                        <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                          （標準 {fmtDiffValue(builtinDiffByField.get('name').from)}）
                        </span>
                      )}
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">仕様</span>
                      <input
                        value={form.spec}
                        disabled={!!disabledReason}
                        style={docDiffByField.has('spec') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                      />
                      {docDiffByField.has('spec') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {fmtDiffValue(docDiffByField.get('spec').from)}）
                        </span>
                      )}
                      {builtinDiffByField.has('spec') && (
                        <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                          （標準 {fmtDiffValue(builtinDiffByField.get('spec').from)}）
                        </span>
                      )}
                    </div>

                    {materialFormHasDimensions(form.category) ? (
                      <div className="catmnt-form-row">
                        <span className="catmnt-form-label">X / Y</span>
                        <input
                          type="number"
                          value={form.x}
                          disabled={!!disabledReason || lockedFields.has('x')}
                          title={lockedFields.has('x') ? lockedFieldReason(CatalogKind.MATERIAL, 'x') : undefined}
                          style={{ maxWidth: 56, ...(docDiffByField.has('x') ? { color: CATALOG_DIFF_COLOR } : {}) }}
                          onChange={e => setForm(f => ({ ...f, x: e.target.value }))}
                        />
                        <input
                          type="number"
                          value={form.y}
                          disabled={!!disabledReason || lockedFields.has('y')}
                          title={lockedFields.has('y') ? lockedFieldReason(CatalogKind.MATERIAL, 'y') : undefined}
                          style={{ maxWidth: 56, ...(docDiffByField.has('y') ? { color: CATALOG_DIFF_COLOR } : {}) }}
                          onChange={e => setForm(f => ({ ...f, y: e.target.value }))}
                        />
                        {docDiffByField.has('x') && (
                          <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                            （本体X {fmtDiffValue(docDiffByField.get('x').from)}）
                          </span>
                        )}
                        {docDiffByField.has('y') && (
                          <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                            （本体Y {fmtDiffValue(docDiffByField.get('y').from)}）
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="catmnt-form-row">
                        <span className="catmnt-form-label">X / Y</span>
                        <input value="0" disabled readOnly style={{ maxWidth: 56 }} />
                        <input value="0" disabled readOnly style={{ maxWidth: 56 }} />
                        <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>面材・仕上げ材は寸法なし固定</span>
                      </div>
                    )}

                    {materialFormHasDimensions(form.category) && (
                      <div className="catmnt-form-row">
                        <span className="catmnt-form-label">下地区分</span>
                        <select
                          value={backingClassSelectValue}
                          disabled={!!disabledReason || lockedFields.has('backingClass')}
                          title={lockedFields.has('backingClass') ? lockedFieldReason(CatalogKind.MATERIAL, 'backingClass') : undefined}
                          onChange={e => setForm(f => ({ ...f, backingClass: e.target.value }))}
                        >
                          <option value="">選択してください</option>
                          {BACKING_CLASS_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                          {/* ステップ12c QA指摘m2: RCは選択肢に無いため、表示専用でこの行のときだけ足す
                              （選べない——select自体がlockedFields.has('backingClass')でdisabled）。 */}
                          {backingClassSelectValue === 'rc' && <option value="rc">RC（固定）</option>}
                        </select>
                      </div>
                    )}

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">厚さ(mm)</span>
                      <input
                        value={form.thickness}
                        disabled={!!disabledReason || lockedFields.has('thickness')}
                        title={lockedFields.has('thickness') ? lockedFieldReason(CatalogKind.MATERIAL, 'thickness') : undefined}
                        style={docDiffByField.has('thickness') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, thickness: e.target.value }))}
                      />
                      {docDiffByField.has('thickness') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {fmtDiffValue(docDiffByField.get('thickness').from)}）
                        </span>
                      )}
                      {builtinDiffByField.has('thickness') && (
                        <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                          （標準 {fmtDiffValue(builtinDiffByField.get('thickness').from)}）
                        </span>
                      )}
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">備考</span>
                      <input
                        value={form.note}
                        disabled={!!disabledReason}
                        style={docDiffByField.has('note') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                      />
                      {docDiffByField.has('note') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {fmtDiffValue(docDiffByField.get('note').from)}）
                        </span>
                      )}
                      {builtinDiffByField.has('note') && (
                        <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                          （標準 {fmtDiffValue(builtinDiffByField.get('note').from)}）
                        </span>
                      )}
                    </div>

                    {formError && <div className="catmnt-form-error">{formError}</div>}
                    {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

                    {confirmingDelete ? (
                      <div className="catmnt-form-row">
                        <span style={{ fontSize: 12, color: '#dc2626' }}>
                          本当に削除しますか？（ユーザーライブラリから外します）
                          {deleteUsage?.status === 'loading' && '（使用状況を確認しています…）'}
                          {deleteUsage?.status === 'error' && `（使用状況の確認に失敗しました: ${deleteUsage.message}）`}
                          {deleteUsage?.status === 'ready' && deleteUsage.usedKeys.has(selectedRow?.entry.code) && (
                            '（使用中のため、この文書には現在の内容を同梱として残します）'
                          )}
                        </span>
                        <button
                          className="catmnt-btn catmnt-btn--danger"
                          disabled={!deleteUsage || deleteUsage.status !== 'ready' || busy}
                          onClick={handleDeleteConfirmed}
                        >
                          削除する
                        </button>
                        <button
                          className="catmnt-btn catmnt-btn--secondary"
                          disabled={busy}
                          onClick={() => { setConfirmingDelete(false); setDeleteUsage(null); }}
                        >
                          キャンセル
                        </button>
                      </div>
                    ) : revertConfirm ? (
                      <div className="catmnt-realign-confirm">
                        <div className="catmnt-realign-confirm-title">標準に戻しますか？</div>
                        <label style={{ fontSize: 12, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={revertConfirm.alsoRealignDoc}
                            onChange={e => setRevertConfirm(c => ({ ...c, alsoRealignDoc: e.target.checked }))}
                          />
                          この文書の同梱も標準に合わせる
                        </label>
                        <div className="catmnt-form-actions">
                          <button className="catmnt-btn catmnt-btn--primary" disabled={busy} onClick={handleRevertConfirmed}>承認する</button>
                          <button className="catmnt-btn catmnt-btn--secondary" disabled={busy} onClick={() => setRevertConfirm(null)}>
                            キャンセル
                          </button>
                        </div>
                      </div>
                    ) : saveConfirm ? (
                      <div className="catmnt-realign-confirm">
                        <div className="catmnt-realign-confirm-title">この文書の同梱を外して保存しますか？</div>
                        <ul className="catmnt-realign-diff-list">
                          {saveConfirm.confirmPairs.map(p => (
                            <li key={p.field}>{p.label} {fmtDiffValue(p.from)} → {fmtDiffValue(p.to)}</li>
                          ))}
                        </ul>
                        <div className="catmnt-realign-confirm-note">
                          保存すると、この文書では同梱を外し編集後の内容が使われます。他の文書は各自で合わせ直してください。
                        </div>
                        <div className="catmnt-form-actions">
                          <button className="catmnt-btn catmnt-btn--primary" disabled={busy} onClick={handleSaveConfirmed}>承認する</button>
                          <button className="catmnt-btn catmnt-btn--secondary" disabled={busy} onClick={() => setSaveConfirm(null)}>
                            キャンセル
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="catmnt-form-actions">
                        <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason || busy} onClick={handleSave}>
                          {isAdding ? '追加' : '保存'}
                        </button>
                        {!isAdding && selectedRow && (
                          <button
                            className="catmnt-btn catmnt-btn--secondary"
                            disabled={!duplicatable}
                            onClick={() => handleDuplicateClick(selectedRow)}
                          >
                            複製
                          </button>
                        )}
                        {!isAdding && editState?.canRevert && (
                          <button className="catmnt-btn catmnt-btn--secondary" onClick={handleRevertClick}>
                            標準に戻す
                          </button>
                        )}
                        {!isAdding && editState?.canDelete && (
                          <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteClick}>
                            削除
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* ステップ7d: 境界マスターの閲覧タブ（読み取り専用。追加・複製・編集・削除・
              合わせ直しボタンは出さない——選ぶ経路が無い・layers/fieldsの編集UIは複雑・範囲外の
              裁定。内装マスター・断面・建具記号・建具種別は12f/12g/12hで編集タブへ移行済みのため、
              ステップ12h時点でREADONLY_KIND_FIELDSに残るのは境界マスターのみ）。 */}
          {READONLY_KIND_FIELDS[activeKind] && (
            <ReadonlyKindTab
              kind={activeKind}
              builtinList={readonlyBuiltinByKind[activeKind] ?? null}
              search={readonlySearch}
              setSearch={setReadonlySearch}
              selectedKey={readonlySelectedKey}
              setSelectedKey={setReadonlySelectedKey}
              materialList={builtinList}
            />
          )}

          {/* ステップ12f: 建具記号（fixtureSymbol）タブ（追加・複製・編集・標準の上書き・
              標準に戻す・削除）。materialListは平面記号プレビューのダミー壁厚導出用（材料タブが
              動的importで読み込んだbuiltin一覧をそのまま渡す）。 */}
          {activeKind === CatalogKind.FIXTURE_SYMBOL && (
            <FixtureSymbolTab materialList={builtinList} onLibraryChanged={handleLibraryChanged} />
          )}

          {/* ステップ12g: 内装マスター（interiorMaster）タブ（全操作＋標準の上書き）。
              materialListは壁材・壁仕上げコードの実在検査（QA指摘M1）用——材料タブが動的importで
              読み込んだbuiltin一覧をそのまま渡す（未読込みなら保存ボタンをdisabledにする）。 */}
          {activeKind === CatalogKind.INTERIOR_MASTER && (
            <InteriorMasterTab materialList={builtinList} onLibraryChanged={handleLibraryChanged} />
          )}

          {/* ステップ12g: 断面（section）タブ（呼称の編集・標準の上書き・userの削除。
              追加は既存の「規格文字列から追加」＝SectionBulkImportのみ）。 */}
          {activeKind === CatalogKind.SECTION && (
            <SectionTab onLibraryChanged={handleLibraryChanged} />
          )}

          {/* ステップ12h: 建具種別（openingSubType）タブ（追加・複製・編集・標準の上書き・
              標準に戻す・削除）。materialListは平面記号プレビューのダミー壁厚導出用（材料タブが
              動的importで読み込んだbuiltin一覧をそのまま渡す）。 */}
          {activeKind === CatalogKind.OPENING_SUB_TYPE && (
            <OpeningSubTypeTab materialList={builtinList} onLibraryChanged={handleLibraryChanged} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ステップ7d: 境界マスターの閲覧タブ本体（読み取り専用。ステップ12h時点で
 * READONLY_KIND_FIELDSに残るのはこの1種別のみ——内装マスター・断面・建具記号・建具種別は
 * 12f/12g/12hで専用の編集タブへ移行した）。builtin一覧・overlay（catalog/catalogRegistry.js）を
 * buildCatalogRows で合成し、出所バッジ・差分表示（≠＋オレンジ＋diffTooltip）付きの一覧と、
 * 選択行の詳細（READONLY_KIND_FIELDS）を表示するだけ——追加・複製・編集・削除・合わせ直しの
 * 手段は一切持たない。
 */
function ReadonlyKindTab({ kind, builtinList, search, setSearch, selectedKey, setSelectedKey, materialList }) {
  const def = kindDef(kind);
  const diffMap = builtinList ? docDiffMap(kind, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind, builtinList, search, diffMap }) : [];
  const selectedRow = selectedKey ? rows.find(r => def.keyOf(r.entry) === selectedKey) ?? null : null;
  const fieldDefs = READONLY_KIND_FIELDS[kind] ?? [];

  return (
    <>
      <div className="catmnt-list-col">
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="名称で検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="catmnt-rows">
          {!builtinList && <div className="catmnt-row-empty">読み込み中…</div>}
          {builtinList && rows.length === 0 && <div className="catmnt-row-empty">該当する項目がありません</div>}
          {rows.map(row => {
            const key = def.keyOf(row.entry);
            return (
              <div
                key={key}
                className={`catmnt-row${key === selectedKey ? ' catmnt-row--selected' : ''}`}
                onClick={() => setSelectedKey(key)}
              >
                <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                  {ORIGIN_LABELS[row.origin] ?? '?'}
                </span>
                <span
                  className="catmnt-row-name"
                  style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                  title={row.diff ? diffTooltip(kind, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
                >
                  {row.entry.label ?? key}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="catmnt-form-col">
        {!selectedRow && (
          <div className="catmnt-form-empty">左の一覧から項目を選択してください（このタブは閲覧のみです）</div>
        )}
        {selectedRow && (
          <>
            <div className="catmnt-form-note">閲覧のみです（追加・編集・削除・合わせ直しは未対応）</div>
            <div className="catmnt-form-row">
              <span className="catmnt-form-label">キー</span>
              <span className="catmnt-code-readout">{def.keyOf(selectedRow.entry)}</span>
            </div>
            {fieldDefs.map(field => (
              <div className="catmnt-form-row" key={field}>
                <span className="catmnt-form-label">{fieldLabel(kind, field)}</span>
                <span
                  className="catmnt-code-readout"
                  style={selectedRow.diff?.diffFields?.includes(field) ? { color: CATALOG_DIFF_COLOR } : undefined}
                >
                  {formatReadonlyFieldValue(kind, field, selectedRow.entry[field])}
                </span>
              </div>
            ))}
            {/* ステップ9b: 作図プレビュー（登録表 ui/catalogPreview.js 経由。断面・建具種別のみ図を持つ）。
                ステップ11f: 建具種別は平面記号も並べて描く——materialListは壁厚導出用（QA指摘・
                2026-09-23裁定Aで境界マスターは廃止・boundaryListは渡さない）。 */}
            <CatalogPreview kind={kind} entry={selectedRow.entry} materialList={materialList} />
          </>
        )}
      </div>
    </>
  );
}

/**
 * ステップ8i: 断面の「規格文字列から追加」（折りたたみ）。断面タブ（ステップ12g以降は
 * SectionTab）専用——他のタブには出さない。解析（planBulkSectionImport）→
 * 結果一覧（追加される行・除外行とその理由・解析できなかった行）→「ライブラリへ追加」
 * （commitUserEntries）の順。純ロジックはcatalog/catalogMaintenance.jsのplanBulkSectionImportへ
 * 寄せ、本コンポーネントは表示・保存I/Oの配線のみ持つ（パーサの直書きをしない）。
 */
function SectionBulkImport({ builtinList, onImported }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [plan, setPlan] = useState(null); // {toAdd, skipped, errors} | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // ステップ9c: 「追加される行」の1件を選んで作図プレビューを出す（Q3裁定: 一覧全部の同時描画はしない）。
  // planが再解析される（setPlanが呼ばれる）たびにリセットする。
  const [selectedDraftKey, setSelectedDraftKey] = useState(null);

  function handleParse() {
    setError(null);
    setSelectedDraftKey(null);
    setPlan(planBulkSectionImport(text, { builtinList, parseSpecList: parseSectionSpecList }));
  }

  async function handleCommit() {
    if (!plan || plan.toAdd.length === 0) return;
    setBusy(true);
    setError(null);
    const { user } = overlayFor(CatalogKind.SECTION);
    let nextUser = user;
    for (const entry of plan.toAdd) {
      nextUser = upsertUserCatalogEntry(CatalogKind.SECTION, nextUser, entry);
    }
    try {
      await commitUserEntries(CatalogKind.SECTION, nextUser, user, { saveFn: saveUserCatalog });
    } catch (e) {
      setBusy(false);
      setError(`保存に失敗しました: ${e.message}`);
      return;
    }
    setBusy(false);
    setText('');
    setPlan(null);
    setSelectedDraftKey(null);
    onImported?.();
  }

  const selectedDraft = (plan && selectedDraftKey)
    ? plan.toAdd.find(e => e.key === selectedDraftKey) ?? null
    : null;

  return (
    <div className="catmnt-bulk-import">
      <button
        className="catmnt-btn catmnt-btn--secondary"
        onClick={() => setOpen(o => !o)}
      >
        規格文字列から追加{open ? '（閉じる）' : ''}
      </button>
      {open && (
        <div className="catmnt-bulk-import-body">
          <textarea
            className="catmnt-bulk-import-textarea"
            placeholder={'例: H400×200×8×13 / □250×250×9'}
            value={text}
            onChange={e => { setText(e.target.value); setPlan(null); setSelectedDraftKey(null); }}
          />
          <div className="catmnt-form-actions">
            <button className="catmnt-btn catmnt-btn--secondary" disabled={!text.trim()} onClick={handleParse}>
              解析
            </button>
            <button
              className="catmnt-btn catmnt-btn--primary"
              disabled={!plan || plan.toAdd.length === 0 || busy}
              onClick={handleCommit}
            >
              ライブラリへ追加{plan ? `（${plan.toAdd.length}件）` : ''}
            </button>
          </div>
          {error && <div className="catmnt-form-error">{error}</div>}
          {plan && (
            <div className="catmnt-bulk-import-result">
              {plan.toAdd.length > 0 && (
                <div>
                  <div className="catmnt-bulk-import-result-title">追加される行（{plan.toAdd.length}件）</div>
                  <ul>
                    {plan.toAdd.map(e => (
                      <li
                        key={e.key}
                        className={`catmnt-bulk-import-row${e.key === selectedDraftKey ? ' catmnt-bulk-import-row--selected' : ''}`}
                        onClick={() => setSelectedDraftKey(e.key)}
                      >
                        {e.label}
                      </li>
                    ))}
                  </ul>
                  {/* ステップ9c: 選択中の1件だけ作図プレビューを出す（一覧全部は同時に描かない）。 */}
                  {selectedDraft && <CatalogPreview kind={CatalogKind.SECTION} entry={selectedDraft} />}
                </div>
              )}
              {plan.skipped.length > 0 && (
                <div>
                  <div className="catmnt-bulk-import-result-title">除外された行（{plan.skipped.length}件）</div>
                  <ul>{plan.skipped.map((s, i) => <li key={i}>{s.line} — {s.reason}</li>)}</ul>
                </div>
              )}
              {plan.errors.length > 0 && (
                <div>
                  <div className="catmnt-bulk-import-result-title catmnt-bulk-import-result-title--error">
                    解析できなかった行（{plan.errors.length}件）
                  </div>
                  <ul className="catmnt-bulk-import-error-list">{plan.errors.map((e, i) => <li key={i}>{e.line} — {e.reason}</li>)}</ul>
                </div>
              )}
              {plan.toAdd.length === 0 && plan.skipped.length === 0 && plan.errors.length === 0 && (
                <div className="catmnt-row-empty">解析できる行がありません</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ステップ12i（開発者向けエクスポート）: 保守パネルで編集した「標準の上書き分」「userの
// 追加分」を本体ソースの該当行と同じ書式のJSソース片として読み取り専用textareaに出す
// （開発者が本体マスタへ手作業で反映するときにそのままコピーして貼れる形）。対象の抽出
// （collectExportableEntries）・整形（formatBuiltinSource）は純関数（catalog/catalogMaintenance.js）
// ——本コンポーネントは描くだけ。種別タブの上（activeKindを問わず常に1つ）に置く共通部品
// （設計12i「各編集タブ（または全種別共通のパネル上部）」の後者を採る——5タブそれぞれに
// 複製するとbuiltinListの二重読み込み・配線の重複が増えるため）。呼び出し側が
// `key={activeKind}` を渡してkind切替え時にコンポーネントを丸ごと再マウントさせる
// （開閉・読み込み結果を前のkindから持ち越さない。setStateをuseEffect本体で直接呼ぶ
// リセット処理はreact-hooks/set-state-in-effectのlint対象になるため避ける）。
//
// QA指摘M1（2026-09-24再報告・案(b)）: overlay（catalog/catalogRegistry.js）はモジュール単位の
// 可変状態でReactが変化を追跡しないため、開いたまま他タブ（各タブは自身のstateで完結し、
// 保存・削除・標準に戻す後もこの親は再レンダーされない）でuserライブラリを編集すると表示が
// 古いまま——親が管理するlibraryTick（userライブラリを実際に変更した操作の完了ごとに進む）を
// propsで受け取り、useMemoの依存に含めて再計算する（親の再レンダーだけでは再計算されない
// ようuseMemoでtick駆動にする——builtinList/kindだけに依存すると、tickが進んでも
// 「同じbuiltinList・同じkind」のまま再計算をスキップしてしまう）。
const EXPORTABLE_CATALOG_KINDS = Object.freeze([
  CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.SECTION,
  CatalogKind.OPENING_SUB_TYPE, CatalogKind.FIXTURE_SYMBOL,
]);

function DeveloperExportPanel({ kind, libraryTick }) {
  const [open, setOpen] = useState(false);
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!open || builtinList || loadError) return;
    let cancelled = false;
    kindDef(kind).loadBuiltin().then(list => {
      if (!cancelled) setBuiltinList(list);
    }).catch(e => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [open, kind, builtinList, loadError]);

  // rules-of-hooksのため、種別が対象外（boundaryMaster）のときの早期returnより前にHooksを
  // すべて呼び終える（useMemoもここで呼ぶ——早期returnの後にHookを置かない）。
  const computed = useMemo(() => {
    if (!builtinList) return { overrides: [], additions: [], formatted: { overrides: '', additions: '' }, formatError: null };
    const def = kindDef(kind);
    const builtinKeys = new Set(builtinList.map(def.keyOf));
    const { overrides, additions } = collectExportableEntries(kind, { builtinList });
    try {
      return { overrides, additions, formatted: formatBuiltinSource(kind, [...overrides, ...additions], { builtinKeys }), formatError: null };
    } catch (e) {
      return { overrides, additions, formatted: { overrides: '', additions: '' }, formatError: e.message };
    }
    // libraryTickは値を直接使わない——overlay（catalog/catalogRegistry.js）はモジュール単位の
    // 可変状態でReactが追跡できないため、依存配列に含めるだけで「userライブラリが変わった」
    // 再計算のトリガーとして使う意図的な使い方（QA指摘M1・2026-09-24再報告の対処点。除くと
    // userライブラリ変更後もDeveloperExportPanelが更新されない退行に戻る）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, builtinList, libraryTick]);
  const { overrides, additions, formatted, formatError } = computed;

  if (!EXPORTABLE_CATALOG_KINDS.includes(kind)) return null;

  return (
    <div className="catmnt-bulk-import">
      <button className="catmnt-btn catmnt-btn--secondary" onClick={() => setOpen(o => !o)}>
        開発者向けエクスポート{open ? '（閉じる）' : ''}
      </button>
      {open && (
        <div className="catmnt-bulk-import-body">
          {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
          {loadError && <div className="catmnt-form-error">読み込みに失敗しました: {loadError}</div>}
          {formatError && <div className="catmnt-form-error">整形に失敗しました: {formatError}</div>}
          {builtinList && !formatError && (
            <>
              <div className="catmnt-bulk-import-result-title">標準の上書き分（{overrides.length}件）</div>
              <textarea className="catmnt-bulk-import-textarea" readOnly value={formatted.overrides} />
              <div className="catmnt-bulk-import-result-title">userの追加分（{additions.length}件）</div>
              <textarea className="catmnt-bulk-import-textarea" readOnly value={formatted.additions} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ステップ12f: 建具記号（fixtureSymbol）タブの新規追加フォーム初期値。
function emptyFixtureSymbolForm() {
  return { key: '', label: '', category: 'fitting', frameOnly: false, profile: '', defaultMaterialGlass: '' };
}

// QA指摘n8（2026-09-24再報告）: 枠断面selectの表示文言。値の集合そのもの（'solid'|'bent'）は
// catalog/catalogKinds.js の FIXTURE_SYMBOL_PROFILES が唯一の定義箇所——ここは表示文言だけを持つ。
const FIXTURE_SYMBOL_PROFILE_LABELS = Object.freeze({
  solid: 'solid（木材の無垢断面）',
  bent: 'bent（鋼板の曲げ加工）',
});

// ================================================================
// QA指摘n9（2026-09-24再報告）: 本体編集タブ（材料タブ・建具記号タブ）が共有しうる非同期アクション
// （保存・削除・標準に戻す）と、その確認状態・busyガードを1箇所にまとめるフック＋確認ブロック用
// コンポーネント。
//
// 現状の適用範囲（報告事項）: FixtureSymbolTab（12f）・InteriorMasterTab・SectionTab（12g）は
// このフック・コンポーネントへ移行済み。材料タブ（CatalogMaintenancePanel本体）は本ラウンドでも
// 未移行——材料タブは同じ確認state群に加えて、同梱差分/標準差分のフィールド別オレンジ表示・
// 下地区分selectの表示値解決など、確認フロー本体だけでは括れない付随ロジックが同じハンドラへ
// 深く絡んでおり、移行するには材料タブの十数本の既存wiringテスト（performSave/
// handleDeleteConfirmed/handleRevertConfirmedの関数シグネチャ・busy state宣言・確認ボタンJSXを
// 正規表現で直接検査するもの）を書き直す必要がある。本セッションでは目視確認の手段が無い状態で
// その一括書き換えを行うリスクが高いと判断し、材料タブは現状のまま維持し、この報告として明記する
// （材料タブの将来の移行先として引き続き用意しておく）。「合わせ直す」（旧realignConfirm）は
// ステップ14-A1でuseRealignActions（kind汎用の別フック）へ切り出し、材料タブも移行済み——
// 対象は上記の「保存・削除・標準に戻す」（useCatalogEditActions）とは別の性質（busy無し・
// ユーザーライブラリを変えない）のため別フックにした（設計 2026-09-24）。
// ================================================================

/**
 * 削除確認ブロック（材料タブ・建具記号タブで同一のUI）。busy中は両ボタンdisabled。
 * @param {{ deleteUsage: {status:string,usedKeys?:Set,message?:string}|null, isUsed: boolean,
 *           busy: boolean, onConfirm: () => void, onCancel: () => void }} props
 */
function DeleteConfirmBlock({ deleteUsage, isUsed, busy, onConfirm, onCancel }) {
  return (
    <div className="catmnt-form-row">
      <span style={{ fontSize: 12, color: '#dc2626' }}>
        本当に削除しますか？（ユーザーライブラリから外します）
        {deleteUsage?.status === 'loading' && '（使用状況を確認しています…）'}
        {deleteUsage?.status === 'error' && `（使用状況の確認に失敗しました: ${deleteUsage.message}）`}
        {deleteUsage?.status === 'ready' && isUsed && '（使用中のため、この文書には現在の内容を同梱として残します）'}
      </span>
      <button
        className="catmnt-btn catmnt-btn--danger"
        disabled={!deleteUsage || deleteUsage.status !== 'ready' || busy}
        onClick={onConfirm}
      >
        削除する
      </button>
      <button className="catmnt-btn catmnt-btn--secondary" disabled={busy} onClick={onCancel}>
        キャンセル
      </button>
    </div>
  );
}

/**
 * 標準に戻す確認ブロック（材料タブ・建具記号タブで同一のUI）。
 * @param {{ revertConfirm: { key: string, alsoRealignDoc: boolean },
 *           setRevertConfirm: Function, busy: boolean, onConfirm: () => void, onCancel: () => void }} props
 */
function RevertConfirmBlock({ revertConfirm, setRevertConfirm, busy, onConfirm, onCancel }) {
  return (
    <div className="catmnt-realign-confirm">
      <div className="catmnt-realign-confirm-title">標準に戻しますか？</div>
      <label style={{ fontSize: 12, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={revertConfirm.alsoRealignDoc}
          onChange={e => setRevertConfirm(c => ({ ...c, alsoRealignDoc: e.target.checked }))}
        />
        この文書の同梱も標準に合わせる
      </label>
      <div className="catmnt-form-actions">
        <button className="catmnt-btn catmnt-btn--primary" disabled={busy} onClick={onConfirm}>承認する</button>
        <button className="catmnt-btn catmnt-btn--secondary" disabled={busy} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

/**
 * doc-same/doc-override保存（使用中の同梱を外して保存）の確認ブロック（材料タブ・建具記号タブで
 * 同一のUI）。
 * @param {{ saveConfirm: { confirmPairs: object[] }, busy: boolean,
 *           onConfirm: () => void, onCancel: () => void }} props
 */
function SaveConfirmBlock({ saveConfirm, busy, onConfirm, onCancel }) {
  return (
    <div className="catmnt-realign-confirm">
      <div className="catmnt-realign-confirm-title">この文書の同梱を外して保存しますか？</div>
      <ul className="catmnt-realign-diff-list">
        {saveConfirm.confirmPairs.map(p => (
          <li key={p.field}>{p.label} {String(p.from ?? '未設定')} → {String(p.to ?? '未設定')}</li>
        ))}
      </ul>
      <div className="catmnt-realign-confirm-note">
        保存すると、この文書では同梱を外し編集後の内容が使われます。他の文書は各自で合わせ直してください。
      </div>
      <div className="catmnt-form-actions">
        <button className="catmnt-btn catmnt-btn--primary" disabled={busy} onClick={onConfirm}>承認する</button>
        <button className="catmnt-btn catmnt-btn--secondary" disabled={busy} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

/**
 * ステップ14-A1（課題A1: 「合わせ直す」をkind汎用へ切り出す）: 「本体の内容に合わせ直す」確認
 * ブロック（旧・材料タブ専用インラインJSXから移設。他kindでも使えるよう plans/onConfirm/onCancel
 * だけを受け取る薄い表示コンポーネントにする）。差分値の整形は formatReadonlyValue に統一する
 * （旧実装の「未設定」から「（未設定）」表記へ変わる——設計裁定2026-09-24で受け入れ済み）。
 * @param {{ plans: Array<{ key: string, name: string, plan: object }>,
 *           onConfirm: () => void, onCancel: () => void }} props
 */
function RealignConfirmBlock({ plans, onConfirm, onCancel }) {
  return (
    <div className="catmnt-realign-confirm">
      <div className="catmnt-realign-confirm-title">
        本体の内容に合わせ直しますか？（{plans.length}件）
      </div>
      {plans.map(({ key, plan, name }) => (
        <div key={key} className="catmnt-realign-item">
          <div className="catmnt-realign-item-name">{name}</div>
          {plan.ok ? (
            <ul className="catmnt-realign-diff-list">
              {plan.diffPairs.map(p => (
                <li key={p.field} style={{ color: CATALOG_DIFF_COLOR }}>
                  {p.label} {formatReadonlyValue(p.from)} → {formatReadonlyValue(p.to)}
                </li>
              ))}
            </ul>
          ) : (
            <div className="catmnt-realign-diff-none">{plan.reason}</div>
          )}
        </div>
      ))}
      <div className="catmnt-realign-confirm-note">
        保存すると同梱が本体の内容で更新され、通知が止まります。
      </div>
      <div className="catmnt-form-actions">
        <button className="catmnt-btn catmnt-btn--primary" onClick={onConfirm}>
          承認する
        </button>
        <button className="catmnt-btn catmnt-btn--secondary" onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

/**
 * QA指摘n9: 本体編集タブが共有する非同期アクション（保存・削除・標準に戻す）の手順そのものを
 * まとめるフック。フォーム自体の状態（form/formError/formMessage/isAdding/selectedKey等、種別
 * 固有の検証）は呼び出し側が引き続き持つ——ここで持つのは「確認→busy→applyCatalogEditPlan→
 * 完了通知」という共通の手順だけ（完了時に何をするかはonSaved/onDeleted/onRevertedへ委ねる。
 * .jsx側に判断を残さないため、entryKey/planの組み立てはcatalog/catalogMaintenance.js側の
 * planSaveEntry等が済ませたものをそのまま渡す契約）。
 * @param {string} kind
 * @param {{ onSaved?: (entryKey: string, meta: object) => void, onDeleted?: (plan: object) => void,
 *           onReverted?: () => void, onError?: (message: string) => void }} handlers
 */
function useCatalogEditActions(kind, { onSaved, onDeleted, onReverted, onError } = {}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteUsage, setDeleteUsage] = useState(null);
  const [saveConfirm, setSaveConfirm] = useState(null);
  const [revertConfirm, setRevertConfirm] = useState(null);

  async function performSave(plan, entryKey, meta = {}) {
    if (busy) return;
    setBusy(true);
    try {
      await applyCatalogEditPlan(kind, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      onError?.(`保存に失敗しました: ${e.message}`);
      setSaveConfirm(null);
      return;
    } finally {
      setBusy(false);
    }
    setSaveConfirm(null);
    onSaved?.(entryKey, meta);
  }

  function handleSaveConfirmed() {
    if (!saveConfirm || busy) return;
    performSave(saveConfirm.plan, saveConfirm.entryKey, saveConfirm);
  }

  async function handleDeleteClick() {
    setConfirmingDelete(true);
    setDeleteUsage({ status: 'loading' });
    try {
      const usedKeysByKind = await collectCurrentCatalogUsage();
      setDeleteUsage({ status: 'ready', usedKeys: usedKeysByKind.get(kind) ?? new Set() });
    } catch (e) {
      setDeleteUsage({ status: 'error', message: e.message });
    }
  }

  function cancelDelete() {
    setConfirmingDelete(false);
    setDeleteUsage(null);
  }

  async function handleDeleteConfirmed(entryKey) {
    if (!entryKey || !deleteUsage || deleteUsage.status !== 'ready' || busy) return;
    let plan;
    try {
      plan = planRemoveUserEntry(kind, entryKey, { usedKeys: deleteUsage.usedKeys });
    } catch (e) {
      onError?.(e.message);
      cancelDelete();
      return;
    }
    setBusy(true);
    try {
      await applyCatalogEditPlan(kind, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      onError?.(`削除に失敗しました: ${e.message}`);
      cancelDelete();
      return;
    } finally {
      setBusy(false);
    }
    cancelDelete();
    onDeleted?.(plan);
  }

  function handleRevertClick(key) {
    setRevertConfirm({ key, alsoRealignDoc: true });
  }

  async function handleRevertConfirmed() {
    if (!revertConfirm || busy) return;
    const plan = planRevertToBuiltin(kind, revertConfirm.key, { alsoRealignDoc: revertConfirm.alsoRealignDoc });
    setBusy(true);
    try {
      await applyCatalogEditPlan(kind, plan, { saveFn: saveUserCatalog, markDirty });
    } catch (e) {
      onError?.(`標準に戻す処理に失敗しました: ${e.message}`);
      setRevertConfirm(null);
      return;
    } finally {
      setBusy(false);
    }
    setRevertConfirm(null);
    onReverted?.();
  }

  function resetConfirmState() {
    setConfirmingDelete(false);
    setDeleteUsage(null);
    setSaveConfirm(null);
    setRevertConfirm(null);
  }

  return {
    busy, confirmingDelete, deleteUsage, saveConfirm, setSaveConfirm, revertConfirm, setRevertConfirm,
    performSave, handleSaveConfirmed, handleDeleteClick, handleDeleteConfirmed,
    handleRevertClick, handleRevertConfirmed, cancelDelete, resetConfirmState,
  };
}

/**
 * ステップ14-A1（課題A1・裁定2026-09-24）: 完了通知の唯一の文言定義
 * （useRealignActionsのhandleRealignConfirmed成功時にnoticeへセットする。旧・材料タブの
 * setFormMessageに直書きされていた文言をそのまま定数化した）。
 */
const REALIGN_DONE_MESSAGE = '本体の内容に合わせ直しました（保存すると同梱が本体の内容で更新され、通知が止まります）';

/**
 * ステップ14-A1（課題A1: 「合わせ直す」をkind汎用のフックへ切り出す。旧・材料タブに直書きされて
 * いたrealignConfirm state・realignPlansの毎レンダー再計算（承認直前の最新overlay状態を
 * 反映するためuseMemoでキャッシュしない）・handleRealignConfirmedを移設）。
 * useCatalogEditActionsには載せない——busy無し・同期処理・ユーザーライブラリ（overlay.user）を
 * 変えない（overlay.docを外すだけの操作）という別の性質のため（設計 2026-09-24）。
 * 確定操作は各keyへ removeDocEntry(kind, key) を呼び、成功すれば markDirty() してから
 * onRealigned(keys) を呼ぶ（選択中の行が対象に含まれていた場合の選択解除は呼び出し側の責務——
 * 出所（doc→user/builtin）が変わりformが古い同梱値のままになるため）。合わせ直しは
 * ユーザーライブラリを変えないため、完了時に onLibraryChanged は呼ばない（呼び出し側も渡さない）。
 * 失敗（removeDocEntryの例外）は onError(e.message) を呼び（渡す・渡さないは呼び出し側の任意）、
 * かつ notice にも同じ文言をkind:'error'で持たせる——旧実装は確認・通知がフォーム外（一覧欄）で
 * 起きるのに完了メッセージ・エラーだけフォーム内（{form && …}）にしか出ない穴があったため
 * （通知位置の裁定2026-09-24・案(a)）、noticeを一覧側の唯一の表示先にする。QA指摘Minor-3
 * （2026-09-24再報告）: 材料タブはonErrorを渡さない——formErrorへ二重表示すると同じ文言が
 * フォーム内・一覧欄の両方に出る（フォームが開いているとき）ため、noticeだけに一本化する。
 * @param {string} kind
 * @param {{ builtinList: object[]|null, allRows: object[], onRealigned?: (keys: string[]) => void,
 *           onError?: (message: string) => void }} args
 * @returns {{ realignConfirm: {keys:string[]}|null, targets: object[], plans: object[],
 *             notice: {kind:'ok'|'error', text:string}|null, clearNotice: () => void,
 *             requestRealign: (keys: string[]) => void, cancelRealign: () => void,
 *             handleRealignConfirmed: () => void }}
 */
function useRealignActions(kind, { builtinList, allRows, onRealigned, onError } = {}) {
  const [realignConfirm, setRealignConfirm] = useState(null);
  const [notice, setNotice] = useState(null);

  const targets = realignTargets(allRows);
  const plans = (realignConfirm && builtinList)
    ? realignPlansFor(kind, realignConfirm.keys, { builtinList })
    : [];

  function requestRealign(keys) {
    setNotice(null);
    setRealignConfirm({ keys });
  }

  function cancelRealign() {
    setRealignConfirm(null);
  }

  function handleRealignConfirmed() {
    if (!realignConfirm) return;
    try {
      for (const key of realignConfirm.keys) {
        removeDocEntry(kind, key);
      }
    } catch (e) {
      onError?.(e.message);
      setNotice({ kind: 'error', text: e.message });
      setRealignConfirm(null);
      return;
    }
    markDirty();
    setRealignConfirm(null);
    setNotice({ kind: 'ok', text: REALIGN_DONE_MESSAGE });
    onRealigned?.(realignConfirm.keys);
  }

  function clearNotice() {
    setNotice(null);
  }

  return {
    realignConfirm, targets, plans, notice, clearNotice, requestRealign, cancelRealign, handleRealignConfirmed,
  };
}

/**
 * ステップ12f: 建具記号（fixtureSymbol）タブ本体。材料タブ（本体上書き込み。ステップ12a〜12c）と
 * 同じ共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry/planRevertToBuiltin/
 * planRemoveUserEntry/applyCatalogEditPlan）を使う——追加・複製・編集・標準の上書き・標準に戻す・
 * 削除。「合わせ直す」（文書同梱を差分から本体へ合わせる一括操作）はステップ14-A2で
 * useRealignActions（kind汎用フック。材料タブ・14-A1と同じ）へ展開した。
 * @param {{ materialList: object[]|null }} props materialListは平面記号プレビューのダミー壁厚
 *   導出用（材料タブが動的importで読み込んだbuiltin一覧。未指定なら既定壁厚に落ちる）。
 */
function FixtureSymbolTab({ materialList, onLibraryChanged }) {
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');

  const [selectedKey, setSelectedKey] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formMessage, setFormMessage] = useState(null);

  // QA指摘n9（2026-09-24再報告）: 保存・削除・標準に戻すの非同期手順・確認state・busyガードは
  // 共通フックへ委譲する（材料タブとの重複解消。完了時の後始末はonSaved/onDeleted/onRevertedへ）。
  function onFixtureSymbolSaved(entryKey, meta) {
    setIsAdding(false);
    setSelectedKey(entryKey);
    setFormMessage(catalogSaveMessage(CatalogKind.FIXTURE_SYMBOL, meta));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onFixtureSymbolDeleted(plan) {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage(removeMessageFor(plan));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onFixtureSymbolReverted() {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage('標準に戻しました');
    realign.clearNotice();
    onLibraryChanged?.();
  }
  const actions = useCatalogEditActions(CatalogKind.FIXTURE_SYMBOL, {
    onSaved: onFixtureSymbolSaved,
    onDeleted: onFixtureSymbolDeleted,
    onReverted: onFixtureSymbolReverted,
    onError: setFormError,
  });
  const { busy } = actions;

  useEffect(() => {
    let cancelled = false;
    kindDef(CatalogKind.FIXTURE_SYMBOL).loadBuiltin().then(list => {
      if (!cancelled) setBuiltinList(list);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const builtinKeys = useMemo(() => new Set((builtinList ?? []).map(e => e.key)), [builtinList]);

  // overlay（catalog/catalogRegistry.js）はモジュール単位の可変状態のため、毎レンダー取り直す
  // （computeDerivedと同じ理由。材は高々数十〜百件のため毎回の再合成は軽い）。
  const diffMap = builtinList ? docDiffMap(CatalogKind.FIXTURE_SYMBOL, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind: CatalogKind.FIXTURE_SYMBOL, builtinList, search, diffMap }) : [];
  // ステップ14-A2（課題A2）: 「合わせ直す」一括対象は検索の影響を受けない全行から取る
  // （材料タブ・14-A1と同じ規約。realignTargetsはallRows基準で呼ぶ契約）。
  const allRows = builtinList ? buildCatalogRows({ kind: CatalogKind.FIXTURE_SYMBOL, builtinList, diffMap }) : [];

  // ステップ14-A4（課題A4・A3 QA持ち越し）: 絞り込み後のrowsから選択行を探すと、検索で選択行が
  // 一覧から隠れたとき編集状態が消える（材料タブ・14-A1、建具種別タブ・14-A3はallRowsから探して
  // いる）。allRowsは検索の影響を受けないためここで揃える。
  const selectedRow = (!isAdding && selectedKey) ? allRows.find(r => r.entry.key === selectedKey) ?? null : null;
  const editState = selectedRow ? rowEditState(CatalogKind.FIXTURE_SYMBOL, selectedRow, { builtinKeys }) : null;
  const lockedFields = selectedRow
    ? lockedFieldsFor(CatalogKind.FIXTURE_SYMBOL, selectedRow.entry.key, { builtinKeys })
    : new Set();
  const disabledReason = form ? fixtureSymbolRowDisabledReason({ isAdding, editState }) : null;
  const { showProfile } = fixtureSymbolFormFieldsFor(form);

  // QA指摘m5（2026-09-24再報告）: 材料タブと同じ2種類の併記——同梱差分（doc起源が本体と不一致。
  // オレンジ）と、標準を編集した行の本体値参考併記（非オレンジ）。
  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.FIXTURE_SYMBOL, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.FIXTURE_SYMBOL, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  const fmtDiffValue = v => (v === null || v === undefined || v === '' ? '未設定' : String(v));

  // ステップ14-A2（課題A2）: 「合わせ直す」はkind汎用フックuseRealignActionsへ委譲する（材料タブ・
  // 14-A1と同じ）。onRealigned: 選択中の行が対象に含まれていた場合、出所（doc→user/builtin）が
  // 変わりformが古い同梱値のままになるため選択を外す。
  function onFixtureSymbolRealigned(keys) {
    if (selectedKey && keys.includes(selectedKey)) {
      setIsAdding(false);
      setSelectedKey(null);
      setForm(null);
      actions.resetConfirmState();
    }
  }
  const realign = useRealignActions(CatalogKind.FIXTURE_SYMBOL, {
    builtinList, allRows, onRealigned: onFixtureSymbolRealigned,
  });

  function handleAddNew() {
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm(emptyFixtureSymbolForm());
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedKey(row.entry.key);
    actions.resetConfirmState();
    setForm(fixtureSymbolFormFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleDuplicateClick(row) {
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm({ ...fixtureSymbolFormFromEntry(row.entry), key: '' });
    setFormError('複製しました。記号を変更してから保存してください');
    setFormMessage(null);
    realign.clearNotice();
  }

  async function handleSave() {
    if (!form || !builtinList) return;
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
    const entry = buildFixtureSymbolEntry(form);

    if (isAdding) {
      const allKeys = collectKnownCatalogKeys(CatalogKind.FIXTURE_SYMBOL, builtinList);
      const check = validateFixtureSymbolForm(form, { isAdding: true, allKeys, builtinKeys });
      if (!check.ok) { setFormError(check.message); return; }
      const plan = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, { builtinList, rowState: null });
      if (!plan.ok) { setFormError(plan.message); return; }
      await actions.performSave(plan, entry.key, { overridesBuiltin: plan.overridesBuiltin });
      return;
    }

    const check = validateFixtureSymbolForm(form, { isAdding: false });
    if (!check.ok) { setFormError(check.message); return; }
    const prevEntry = selectedRow?.entry ?? null;
    const plan = planSaveEntry(CatalogKind.FIXTURE_SYMBOL, entry, {
      builtinList, rowState: editState?.state ?? null, prevEntry,
    });
    if (!plan.ok) { setFormError(plan.message); return; }
    if (plan.noop) { setFormMessage('変更はありません'); return; }

    if (plan.needsConfirm) {
      actions.setSaveConfirm({ plan, entryKey: entry.key, confirmPairs: plan.confirmPairs, overridesBuiltin: plan.overridesBuiltin });
      return;
    }
    await actions.performSave(plan, entry.key, { overridesBuiltin: plan.overridesBuiltin });
  }

  function handleDeleteClick() {
    setFormError(null);
    actions.handleDeleteClick();
  }

  function handleRevertClick() {
    if (!selectedRow) return;
    actions.handleRevertClick(selectedRow.entry.key);
  }

  const duplicatable = !!form;
  const previewEntry = form ? fixtureSymbolPreviewEntry(form) : null;

  return (
    <>
      <div className="catmnt-list-col">
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="記号・呼称で検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="catmnt-add-btn" disabled={!builtinList} onClick={handleAddNew}>
            + 新規追加
          </button>
          {realign.targets.length > 0 && (
            <button
              className="catmnt-btn catmnt-btn--secondary"
              onClick={() => realign.requestRealign(realign.targets.map(r => r.entry.key))}
            >
              すべて本体の内容に合わせ直す（{realign.targets.length}件・絞り込みに関わらず全件）
            </button>
          )}
        </div>

        {realign.notice && (
          <div className={realign.notice.kind === 'error' ? 'catmnt-form-error' : 'catmnt-form-message'}>
            {realign.notice.text}
          </div>
        )}

        {realign.realignConfirm && (
          <RealignConfirmBlock
            plans={realign.plans}
            onConfirm={realign.handleRealignConfirmed}
            onCancel={realign.cancelRealign}
          />
        )}

        <div className="catmnt-rows">
          {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
          {loadError && <div className="catmnt-row-empty">建具記号データの読み込みに失敗しました</div>}
          {builtinList && rows.length === 0 && <div className="catmnt-row-empty">該当する建具記号がありません</div>}
          {rows.map(row => (
            <div
              key={row.entry.key}
              className={`catmnt-row${(!isAdding && row.entry.key === selectedKey) ? ' catmnt-row--selected' : ''}`}
              onClick={() => handleSelectRow(row)}
            >
              <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                {ORIGIN_LABELS[row.origin] ?? '?'}
              </span>
              {row.overridesBuiltin && (
                <span className="catmnt-badge catmnt-badge--override">標準を編集</span>
              )}
              <span
                className="catmnt-row-name"
                style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                title={row.diff ? diffTooltip(CatalogKind.FIXTURE_SYMBOL, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
              >
                {row.entry.key}（{row.entry.label}）{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
              </span>
              <span className="catmnt-cat-badge">{formatCategoryLabel(CatalogKind.FIXTURE_SYMBOL, row.entry.category)}</span>
              {row.diff && (
                <button
                  className="catmnt-realign-btn"
                  title="本体の内容に合わせ直す"
                  onClick={e => { e.stopPropagation(); realign.requestRealign([row.entry.key]); }}
                >
                  合わせ直す
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="catmnt-form-col">
        {!form && (
          <div className="catmnt-form-empty">左の一覧から建具記号を選択するか、「+ 新規追加」してください</div>
        )}
        {form && (
          <>
            {disabledReason && <div className="catmnt-form-note">{disabledReason}</div>}

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">記号</span>
              {isAdding ? (
                <input
                  value={form.key}
                  placeholder="英大文字2〜4文字（例: AW）"
                  onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                />
              ) : (
                <span className="catmnt-code-readout">{selectedKey}</span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">呼称</span>
              <input
                value={form.label}
                disabled={!!disabledReason}
                style={docDiffByField.has('label') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              />
              {docDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('label').from)}）
                </span>
              )}
              {builtinDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('label').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">区分</span>
              <select
                value={form.category}
                disabled={!!disabledReason || lockedFields.has('category')}
                title={lockedFields.has('category') ? lockedFieldReason(CatalogKind.FIXTURE_SYMBOL, 'category') : undefined}
                style={docDiffByField.has('category') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
              >
                {categoryOptionsFor(CatalogKind.FIXTURE_SYMBOL).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {docDiffByField.has('category') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {formatCategoryLabel(CatalogKind.FIXTURE_SYMBOL, docDiffByField.get('category').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <label style={{ fontSize: 12, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={form.frameOnly}
                  disabled={!!disabledReason || lockedFields.has('mechanism')}
                  title={lockedFields.has('mechanism') ? lockedFieldReason(CatalogKind.FIXTURE_SYMBOL, 'mechanism') : undefined}
                  onChange={e => setForm(f => ({ ...f, frameOnly: e.target.checked }))}
                />
                三方枠専用記号にする
              </label>
            </div>

            {showProfile && (
              <div className="catmnt-form-row">
                <span className="catmnt-form-label">枠断面</span>
                <select
                  value={form.profile}
                  disabled={!!disabledReason}
                  style={docDiffByField.has('profile') ? { color: CATALOG_DIFF_COLOR } : undefined}
                  onChange={e => setForm(f => ({ ...f, profile: e.target.value }))}
                >
                  <option value="">未指定（solid扱い）</option>
                  {FIXTURE_SYMBOL_PROFILES.map(p => (
                    <option key={p} value={p}>{FIXTURE_SYMBOL_PROFILE_LABELS[p] ?? p}</option>
                  ))}
                </select>
                {docDiffByField.has('profile') && (
                  <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                    （本体 {fmtDiffValue(docDiffByField.get('profile').from)}）
                  </span>
                )}
                {builtinDiffByField.has('profile') && (
                  <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                    （標準 {fmtDiffValue(builtinDiffByField.get('profile').from)}）
                  </span>
                )}
              </div>
            )}

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">材料・ガラス（既定）</span>
              <input
                value={form.defaultMaterialGlass}
                disabled={!!disabledReason}
                style={docDiffByField.has('defaultMaterialGlass') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, defaultMaterialGlass: e.target.value }))}
              />
              {docDiffByField.has('defaultMaterialGlass') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('defaultMaterialGlass').from)}）
                </span>
              )}
              {builtinDiffByField.has('defaultMaterialGlass') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('defaultMaterialGlass').from)}）
                </span>
              )}
            </div>

            {formError && <div className="catmnt-form-error">{formError}</div>}
            {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

            {actions.confirmingDelete ? (
              <DeleteConfirmBlock
                deleteUsage={actions.deleteUsage}
                isUsed={actions.deleteUsage?.status === 'ready' && actions.deleteUsage.usedKeys.has(selectedRow?.entry.key)}
                busy={busy}
                onConfirm={() => actions.handleDeleteConfirmed(selectedRow?.entry.key)}
                onCancel={actions.cancelDelete}
              />
            ) : actions.revertConfirm ? (
              <RevertConfirmBlock
                revertConfirm={actions.revertConfirm}
                setRevertConfirm={actions.setRevertConfirm}
                busy={busy}
                onConfirm={actions.handleRevertConfirmed}
                onCancel={() => actions.setRevertConfirm(null)}
              />
            ) : actions.saveConfirm ? (
              <SaveConfirmBlock
                saveConfirm={actions.saveConfirm}
                busy={busy}
                onConfirm={actions.handleSaveConfirmed}
                onCancel={() => actions.setSaveConfirm(null)}
              />
            ) : (
              <div className="catmnt-form-actions">
                <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason || busy} onClick={handleSave}>
                  {isAdding ? '追加' : '保存'}
                </button>
                {!isAdding && selectedRow && (
                  <button
                    className="catmnt-btn catmnt-btn--secondary"
                    disabled={!duplicatable}
                    onClick={() => handleDuplicateClick(selectedRow)}
                  >
                    複製
                  </button>
                )}
                {!isAdding && editState?.canRevert && (
                  <button className="catmnt-btn catmnt-btn--secondary" onClick={handleRevertClick}>
                    標準に戻す
                  </button>
                )}
                {!isAdding && editState?.canDelete && (
                  <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteClick}>
                    削除
                  </button>
                )}
              </div>
            )}

            {previewEntry && (
              <CatalogPreview kind={CatalogKind.FIXTURE_SYMBOL} entry={previewEntry} materialList={materialList} />
            )}
          </>
        )}
      </div>
    </>
  );
}

// ステップ12g: 内装マスター（interiorMaster）タブの新規追加フォーム初期値。keyはnextInteriorMasterKey
// が決めた値（USER_連番）をそのまま持つ——ユーザーが直接入力する欄は無い。
function emptyInteriorMasterForm(key) {
  return { key, label: '', wallMaterial: '', wallFinish: '', ceilingHeight: '' };
}

/**
 * ステップ12g: 内装マスター（interiorMaster）タブ本体。建具記号タブ（FixtureSymbolTab・
 * ステップ12f）と同じ共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry/planRevertToBuiltin/
 * planRemoveUserEntry/applyCatalogEditPlan・useCatalogEditActions）を使う——追加・複製・編集・
 * 標準の上書き・標準に戻す・削除の全操作。キー（key）はユーザーが直接入力せず、
 * nextInteriorMasterKey（USER_連番。欠番の再利用）で採番する。作図プレビューは持たない
 * （ui/catalogPreview.js PREVIEW_BUILDERSに内装マスターの登録が無い——壁材・壁仕上げ・天井高の
 * 数値データのみで図を持たない）。
 * QA指摘M1（12g再報告）: materialListは材料タブが動的importで読み込んだ材料builtin一覧
 * （CatalogMaintenancePanel本体のbuiltinList）をそのまま渡す——壁材・壁仕上げコードが材料カタログに
 * 実在するかをvalidateInteriorMasterFormへmaterialKeys（collectKnownCatalogKeys(MATERIAL,…)）として
 * 注入する。未読込みの間はinteriorMasterRowDisabledReasonがmaterialListLoaded:falseで保存ボタンを
 * disabledにする。
 * 「合わせ直す」（文書同梱を差分から本体へ合わせる一括操作）はステップ14-A4で
 * useRealignActions（kind汎用フック。材料タブ・14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3と
 * 同じ）へ展開した。内装マスターのkeyOfは単純キー（entry.key）のため、行ボタン・一括ボタンとも
 * row.entry.keyをrealignのkeyとして渡す（建具種別タブのような複合キー変換は不要）。
 * @param {{ materialList: object[]|null }} props
 */
function InteriorMasterTab({ materialList, onLibraryChanged }) {
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');

  const [selectedKey, setSelectedKey] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formMessage, setFormMessage] = useState(null);

  function onInteriorMasterSaved(entryKey, meta) {
    setIsAdding(false);
    setSelectedKey(entryKey);
    setFormMessage(catalogSaveMessage(CatalogKind.INTERIOR_MASTER, meta));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onInteriorMasterDeleted(plan) {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage(removeMessageFor(plan));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onInteriorMasterReverted() {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage('標準に戻しました');
    realign.clearNotice();
    onLibraryChanged?.();
  }
  const actions = useCatalogEditActions(CatalogKind.INTERIOR_MASTER, {
    onSaved: onInteriorMasterSaved,
    onDeleted: onInteriorMasterDeleted,
    onReverted: onInteriorMasterReverted,
    onError: setFormError,
  });
  const { busy } = actions;

  useEffect(() => {
    let cancelled = false;
    kindDef(CatalogKind.INTERIOR_MASTER).loadBuiltin().then(list => {
      if (!cancelled) setBuiltinList(list);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const builtinKeys = useMemo(() => new Set((builtinList ?? []).map(e => e.key)), [builtinList]);
  // QA指摘M1（12g再報告）: 壁材・壁仕上げコードの実在検査に使う材料キー集合。materialListが
  // 未読込み（null）ならmaterialKeysもnull——validateInteriorMasterFormの「materialKeys省略時は
  // 保存不可」規約と同じnull規約を呼び出し側でも保つ。
  const materialKeys = useMemo(
    () => (materialList ? collectKnownCatalogKeys(CatalogKind.MATERIAL, materialList) : null),
    [materialList],
  );

  const diffMap = builtinList ? docDiffMap(CatalogKind.INTERIOR_MASTER, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind: CatalogKind.INTERIOR_MASTER, builtinList, search, diffMap }) : [];
  // ステップ14-A4（課題A4）: 「合わせ直す」一括対象は検索の影響を受けない全行から取る
  // （材料タブ・14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3と同じ規約。realignTargetsは
  // allRows基準で呼ぶ契約）。
  const allRows = builtinList ? buildCatalogRows({ kind: CatalogKind.INTERIOR_MASTER, builtinList, diffMap }) : [];

  // 絞り込み後のrowsから選択行を探すと、検索で選択行が一覧から隠れたとき編集状態が消える
  // （材料タブ・14-A1、建具種別タブ・14-A3と同じ理由。allRowsは検索の影響を受けない）。
  const selectedRow = (!isAdding && selectedKey) ? allRows.find(r => r.entry.key === selectedKey) ?? null : null;
  const editState = selectedRow ? rowEditState(CatalogKind.INTERIOR_MASTER, selectedRow, { builtinKeys }) : null;
  const disabledReason = form
    ? interiorMasterRowDisabledReason({ isAdding, editState, materialListLoaded: Boolean(materialList) })
    : null;
  // keyBoundFields（catalogKinds.js INTERIOR_MASTER登録表）はkeyのみ——lockedFields.has('key')は
  // 追加・編集のどちらでも常にtrueになるが、他タブ（材料・建具記号）と同じ「固定項目はlockedFieldsFor
  // 経由で判定する」規約を崩さないためここでも呼ぶ（キー読取欄のツールチップに使う）。
  const lockedFields = form ? lockedFieldsFor(CatalogKind.INTERIOR_MASTER, form.key, { builtinKeys }) : new Set();

  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.INTERIOR_MASTER, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.INTERIOR_MASTER, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  const fmtDiffValue = v => (v === null || v === undefined || v === '' ? '未設定' : String(v));

  // ステップ14-A4（課題A4）: 「合わせ直す」はkind汎用フックuseRealignActionsへ委譲する（材料タブ・
  // 14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3と同じ）。onRealigned: 選択中の行が対象に
  // 含まれていた場合、出所（doc→user/builtin）が変わりformが古い同梱値のままになるため選択を外す。
  function onInteriorMasterRealigned(keys) {
    if (selectedKey && keys.includes(selectedKey)) {
      setIsAdding(false);
      setSelectedKey(null);
      setForm(null);
      actions.resetConfirmState();
    }
  }
  const realign = useRealignActions(CatalogKind.INTERIOR_MASTER, {
    builtinList, allRows, onRealigned: onInteriorMasterRealigned,
  });

  function handleAddNew() {
    const allKeys = collectKnownCatalogKeys(CatalogKind.INTERIOR_MASTER, builtinList);
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm(emptyInteriorMasterForm(nextInteriorMasterKey(allKeys)));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedKey(row.entry.key);
    actions.resetConfirmState();
    setForm(interiorMasterFormFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleDuplicateClick(row) {
    const allKeys = collectKnownCatalogKeys(CatalogKind.INTERIOR_MASTER, builtinList);
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm({ ...interiorMasterFormFromEntry(row.entry), key: nextInteriorMasterKey(allKeys) });
    setFormError('複製しました。内容を確認して保存してください');
    setFormMessage(null);
    realign.clearNotice();
  }

  async function handleSave() {
    if (!form || !builtinList) return;
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
    const entry = buildInteriorMasterEntry(form);

    if (isAdding) {
      const allKeys = collectKnownCatalogKeys(CatalogKind.INTERIOR_MASTER, builtinList);
      const check = validateInteriorMasterForm(form, { isAdding: true, allKeys, builtinKeys, materialKeys });
      if (!check.ok) { setFormError(check.message); return; }
      const plan = planSaveEntry(CatalogKind.INTERIOR_MASTER, entry, { builtinList, rowState: null });
      if (!plan.ok) { setFormError(plan.message); return; }
      await actions.performSave(plan, entry.key, { overridesBuiltin: plan.overridesBuiltin });
      return;
    }

    const check = validateInteriorMasterForm(form, { isAdding: false, materialKeys });
    if (!check.ok) { setFormError(check.message); return; }
    const prevEntry = selectedRow?.entry ?? null;
    const plan = planSaveEntry(CatalogKind.INTERIOR_MASTER, entry, {
      builtinList, rowState: editState?.state ?? null, prevEntry,
    });
    if (!plan.ok) { setFormError(plan.message); return; }
    if (plan.noop) { setFormMessage('変更はありません'); return; }

    if (plan.needsConfirm) {
      actions.setSaveConfirm({ plan, entryKey: entry.key, confirmPairs: plan.confirmPairs, overridesBuiltin: plan.overridesBuiltin });
      return;
    }
    await actions.performSave(plan, entry.key, { overridesBuiltin: plan.overridesBuiltin });
  }

  function handleDeleteClick() {
    setFormError(null);
    actions.handleDeleteClick();
  }

  function handleRevertClick() {
    if (!selectedRow) return;
    actions.handleRevertClick(selectedRow.entry.key);
  }

  const duplicatable = !!form;

  return (
    <>
      <div className="catmnt-list-col">
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="呼称・キーで検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="catmnt-add-btn" disabled={!builtinList} onClick={handleAddNew}>
            + 新規追加
          </button>
          {realign.targets.length > 0 && (
            <button
              className="catmnt-btn catmnt-btn--secondary"
              onClick={() => realign.requestRealign(realign.targets.map(r => r.entry.key))}
            >
              すべて本体の内容に合わせ直す（{realign.targets.length}件・絞り込みに関わらず全件）
            </button>
          )}
        </div>

        {realign.notice && (
          <div className={realign.notice.kind === 'error' ? 'catmnt-form-error' : 'catmnt-form-message'}>
            {realign.notice.text}
          </div>
        )}

        {realign.realignConfirm && (
          <RealignConfirmBlock
            plans={realign.plans}
            onConfirm={realign.handleRealignConfirmed}
            onCancel={realign.cancelRealign}
          />
        )}

        <div className="catmnt-rows">
          {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
          {loadError && <div className="catmnt-row-empty">内装マスターデータの読み込みに失敗しました</div>}
          {builtinList && rows.length === 0 && <div className="catmnt-row-empty">該当する内装マスターがありません</div>}
          {rows.map(row => (
            <div
              key={row.entry.key}
              className={`catmnt-row${(!isAdding && row.entry.key === selectedKey) ? ' catmnt-row--selected' : ''}`}
              onClick={() => handleSelectRow(row)}
            >
              <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                {ORIGIN_LABELS[row.origin] ?? '?'}
              </span>
              {row.overridesBuiltin && (
                <span className="catmnt-badge catmnt-badge--override">標準を編集</span>
              )}
              <span
                className="catmnt-row-name"
                style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                title={row.diff ? diffTooltip(CatalogKind.INTERIOR_MASTER, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
              >
                {row.entry.label}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
              </span>
              {row.diff && (
                <button
                  className="catmnt-realign-btn"
                  title="本体の内容に合わせ直す"
                  onClick={e => { e.stopPropagation(); realign.requestRealign([row.entry.key]); }}
                >
                  合わせ直す
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="catmnt-form-col">
        {!form && (
          <div className="catmnt-form-empty">左の一覧から内装マスターを選択するか、「+ 新規追加」してください</div>
        )}
        {form && (
          <>
            {disabledReason && <div className="catmnt-form-note">{disabledReason}</div>}

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">キー</span>
              <span
                className="catmnt-code-readout"
                title={lockedFields.has('key') ? lockedFieldReason(CatalogKind.INTERIOR_MASTER, 'key') : undefined}
              >
                {form.key}
              </span>
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">呼称</span>
              <input
                value={form.label}
                disabled={!!disabledReason}
                style={docDiffByField.has('label') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              />
              {docDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('label').from)}）
                </span>
              )}
              {builtinDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('label').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">壁材（材料コード）</span>
              <input
                value={form.wallMaterial}
                placeholder="12桁数字"
                disabled={!!disabledReason}
                style={docDiffByField.has('wallMaterial') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, wallMaterial: e.target.value }))}
              />
              {docDiffByField.has('wallMaterial') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('wallMaterial').from)}）
                </span>
              )}
              {builtinDiffByField.has('wallMaterial') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('wallMaterial').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">壁仕上げ（材料コード）</span>
              <input
                value={form.wallFinish}
                placeholder="12桁数字"
                disabled={!!disabledReason}
                style={docDiffByField.has('wallFinish') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, wallFinish: e.target.value }))}
              />
              {docDiffByField.has('wallFinish') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('wallFinish').from)}）
                </span>
              )}
              {builtinDiffByField.has('wallFinish') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('wallFinish').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">天井高（mm）</span>
              <input
                value={form.ceilingHeight}
                disabled={!!disabledReason}
                style={docDiffByField.has('ceilingHeight') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, ceilingHeight: e.target.value }))}
              />
              {docDiffByField.has('ceilingHeight') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('ceilingHeight').from)}）
                </span>
              )}
              {builtinDiffByField.has('ceilingHeight') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('ceilingHeight').from)}）
                </span>
              )}
            </div>

            {formError && <div className="catmnt-form-error">{formError}</div>}
            {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

            {actions.confirmingDelete ? (
              <DeleteConfirmBlock
                deleteUsage={actions.deleteUsage}
                isUsed={actions.deleteUsage?.status === 'ready' && actions.deleteUsage.usedKeys.has(selectedRow?.entry.key)}
                busy={busy}
                onConfirm={() => actions.handleDeleteConfirmed(selectedRow?.entry.key)}
                onCancel={actions.cancelDelete}
              />
            ) : actions.revertConfirm ? (
              <RevertConfirmBlock
                revertConfirm={actions.revertConfirm}
                setRevertConfirm={actions.setRevertConfirm}
                busy={busy}
                onConfirm={actions.handleRevertConfirmed}
                onCancel={() => actions.setRevertConfirm(null)}
              />
            ) : actions.saveConfirm ? (
              <SaveConfirmBlock
                saveConfirm={actions.saveConfirm}
                busy={busy}
                onConfirm={actions.handleSaveConfirmed}
                onCancel={() => actions.setSaveConfirm(null)}
              />
            ) : (
              <div className="catmnt-form-actions">
                <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason || busy} onClick={handleSave}>
                  {isAdding ? '追加' : '保存'}
                </button>
                {!isAdding && selectedRow && (
                  <button
                    className="catmnt-btn catmnt-btn--secondary"
                    disabled={!duplicatable}
                    onClick={() => handleDuplicateClick(selectedRow)}
                  >
                    複製
                  </button>
                )}
                {!isAdding && editState?.canRevert && (
                  <button className="catmnt-btn catmnt-btn--secondary" onClick={handleRevertClick}>
                    標準に戻す
                  </button>
                )}
                {!isAdding && editState?.canDelete && (
                  <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteClick}>
                    削除
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * ステップ12g: 断面（section）タブ本体。設計スコープは「呼称（label）の編集・標準の上書き・
 * userの削除」のみ——寸法系（materialType/shape/width/height等）はkeyBoundFieldsで常に固定
 * （lockedFieldsFor/planSaveEntryが値の変更を拒否する）ため読み取り専用表示のみ、新規追加フォーム・
 * 複製ボタンは持たない（追加は既存の「規格文字列から追加」＝SectionBulkImportのみ）。
 * 「合わせ直す」（文書同梱を差分から本体へ合わせる一括操作）はステップ14-A5で
 * useRealignActions（kind汎用フック。材料タブ・14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3、
 * 内装マスタータブ・14-A4と同じ）へ展開した。断面のkeyOfは単純キー（entry.key）のため、行ボタン・
 * 一括ボタンとも row.entry.key をrealignのkeyとして渡す（建具種別タブのような複合キー変換は
 * 不要）。断面タブには新規追加・複製が無いため、clearNoticeの呼び出し先は行選択・保存開始・
 * 保存/削除/戻す完了・一括入力（SectionBulkImport）完了のみ。
 */
function SectionTab({ onLibraryChanged }) {
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const [selectedKey, setSelectedKey] = useState(null);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formMessage, setFormMessage] = useState(null);

  function onSectionSaved(entryKey, meta) {
    setSelectedKey(entryKey);
    setFormMessage(catalogSaveMessage(CatalogKind.SECTION, meta));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onSectionDeleted(plan) {
    setSelectedKey(null);
    setForm(null);
    setFormMessage(removeMessageFor(plan));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onSectionReverted() {
    setSelectedKey(null);
    setForm(null);
    setFormMessage('標準に戻しました');
    realign.clearNotice();
    onLibraryChanged?.();
  }
  const actions = useCatalogEditActions(CatalogKind.SECTION, {
    onSaved: onSectionSaved,
    onDeleted: onSectionDeleted,
    onReverted: onSectionReverted,
    onError: setFormError,
  });
  const { busy } = actions;

  useEffect(() => {
    let cancelled = false;
    kindDef(CatalogKind.SECTION).loadBuiltin().then(list => {
      if (!cancelled) setBuiltinList(list);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const builtinKeys = useMemo(() => new Set((builtinList ?? []).map(e => e.key)), [builtinList]);

  const diffMap = builtinList ? docDiffMap(CatalogKind.SECTION, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind: CatalogKind.SECTION, builtinList, search, diffMap }) : [];
  // ステップ14-A5（課題A5）: 「合わせ直す」一括対象は検索の影響を受けない全行から取る
  // （材料タブ・14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3、内装マスタータブ・14-A4と同じ
  // 規約。realignTargetsはallRows基準で呼ぶ契約）。
  const allRows = builtinList ? buildCatalogRows({ kind: CatalogKind.SECTION, builtinList, diffMap }) : [];

  // 絞り込み後のrowsから選択行を探すと、検索で選択行が一覧から隠れたとき編集状態が消える
  // （材料タブ・14-A1、建具種別タブ・14-A3、内装マスタータブ・14-A4と同じ理由。allRowsは検索の
  // 影響を受けない）。
  const selectedRow = selectedKey ? allRows.find(r => r.entry.key === selectedKey) ?? null : null;
  const editState = selectedRow ? rowEditState(CatalogKind.SECTION, selectedRow, { builtinKeys }) : null;
  const disabledReason = form ? sectionRowDisabledReason({ isAdding: false, editState }) : null;
  // 寸法系の固定表示項目はlockedFieldsFor（catalogKinds.js SECTION登録表のkeyBoundFields）から
  // 導出する——別に手書きの一覧を持たず、固定項目の唯一の出所（catalogKinds.js）と表示項目を
  // 一致させる（'key'は別欄で表示済みのため除く）。
  const lockedFields = selectedRow
    ? lockedFieldsFor(CatalogKind.SECTION, selectedRow.entry.key, { builtinKeys })
    : new Set();
  const fixedDisplayFields = [...lockedFields].filter(f => f !== 'key');

  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.SECTION, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.SECTION, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  const fmtDiffValue = v => (v === null || v === undefined || v === '' ? '未設定' : String(v));

  // ステップ14-A5（課題A5）: 「合わせ直す」はkind汎用フックuseRealignActionsへ委譲する（材料タブ・
  // 14-A1、建具記号タブ・14-A2、建具種別タブ・14-A3、内装マスタータブ・14-A4と同じ）。onRealigned:
  // 選択中の行が対象に含まれていた場合、出所（doc→user/builtin）が変わりformが古い同梱値のまま
  // になるため選択を外す。
  function onSectionRealigned(keys) {
    if (selectedKey && keys.includes(selectedKey)) {
      setSelectedKey(null);
      setForm(null);
      actions.resetConfirmState();
    }
  }
  const realign = useRealignActions(CatalogKind.SECTION, {
    builtinList, allRows, onRealigned: onSectionRealigned,
  });

  function handleSelectRow(row) {
    setSelectedKey(row.entry.key);
    actions.resetConfirmState();
    setForm(sectionFormFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  async function handleSave() {
    if (!form || !selectedRow) return;
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
    const check = validateSectionForm(form);
    if (!check.ok) { setFormError(check.message); return; }
    const entry = buildSectionEntry(selectedRow.entry, form);
    const plan = planSaveEntry(CatalogKind.SECTION, entry, {
      builtinList, rowState: editState?.state ?? null, prevEntry: selectedRow.entry,
    });
    if (!plan.ok) { setFormError(plan.message); return; }
    if (plan.noop) { setFormMessage('変更はありません'); return; }

    if (plan.needsConfirm) {
      actions.setSaveConfirm({ plan, entryKey: entry.key, confirmPairs: plan.confirmPairs, overridesBuiltin: plan.overridesBuiltin });
      return;
    }
    await actions.performSave(plan, entry.key, { overridesBuiltin: plan.overridesBuiltin });
  }

  function handleDeleteClick() {
    setFormError(null);
    actions.handleDeleteClick();
  }

  function handleRevertClick() {
    if (!selectedRow) return;
    actions.handleRevertClick(selectedRow.entry.key);
  }

  return (
    <>
      <div className="catmnt-list-col" data-refresh-tick={refreshTick}>
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="呼称・キーで検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {realign.targets.length > 0 && (
            <button
              className="catmnt-btn catmnt-btn--secondary"
              onClick={() => realign.requestRealign(realign.targets.map(r => r.entry.key))}
            >
              すべて本体の内容に合わせ直す（{realign.targets.length}件・絞り込みに関わらず全件）
            </button>
          )}
        </div>

        {realign.notice && (
          <div className={realign.notice.kind === 'error' ? 'catmnt-form-error' : 'catmnt-form-message'}>
            {realign.notice.text}
          </div>
        )}

        {realign.realignConfirm && (
          <RealignConfirmBlock
            plans={realign.plans}
            onConfirm={realign.handleRealignConfirmed}
            onCancel={realign.cancelRealign}
          />
        )}

        {builtinList && (
          <SectionBulkImport
            builtinList={builtinList}
            onImported={() => { setRefreshTick(t => t + 1); realign.clearNotice(); onLibraryChanged?.(); }}
          />
        )}

        <div className="catmnt-rows">
          {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
          {loadError && <div className="catmnt-row-empty">断面データの読み込みに失敗しました</div>}
          {builtinList && rows.length === 0 && <div className="catmnt-row-empty">該当する断面がありません</div>}
          {rows.map(row => (
            <div
              key={row.entry.key}
              className={`catmnt-row${row.entry.key === selectedKey ? ' catmnt-row--selected' : ''}`}
              onClick={() => handleSelectRow(row)}
            >
              <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                {ORIGIN_LABELS[row.origin] ?? '?'}
              </span>
              {row.overridesBuiltin && (
                <span className="catmnt-badge catmnt-badge--override">標準を編集</span>
              )}
              <span
                className="catmnt-row-name"
                style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                title={row.diff ? diffTooltip(CatalogKind.SECTION, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
              >
                {row.entry.label}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
              </span>
              {row.diff && (
                <button
                  className="catmnt-realign-btn"
                  title="本体の内容に合わせ直す"
                  onClick={e => { e.stopPropagation(); realign.requestRealign([row.entry.key]); }}
                >
                  合わせ直す
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="catmnt-form-col">
        {!form && (
          <div className="catmnt-form-empty">
            左の一覧から断面を選択してください（追加は「規格文字列から追加」を使ってください）
          </div>
        )}
        {form && (
          <>
            {disabledReason && <div className="catmnt-form-note">{disabledReason}</div>}

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">キー</span>
              <span className="catmnt-code-readout">{form.key}</span>
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">呼称</span>
              <input
                value={form.label}
                disabled={!!disabledReason}
                style={docDiffByField.has('label') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              />
              {docDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue(docDiffByField.get('label').from)}）
                </span>
              )}
              {builtinDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue(builtinDiffByField.get('label').from)}）
                </span>
              )}
            </div>

            {fixedDisplayFields.filter(f => selectedRow?.entry?.[f] !== undefined).map(field => (
              <div className="catmnt-form-row" key={field}>
                <span className="catmnt-form-label">{fieldLabel(CatalogKind.SECTION, field)}</span>
                <span className="catmnt-code-readout">{formatReadonlyValue(selectedRow?.entry?.[field])}</span>
              </div>
            ))}

            {formError && <div className="catmnt-form-error">{formError}</div>}
            {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

            {actions.confirmingDelete ? (
              <DeleteConfirmBlock
                deleteUsage={actions.deleteUsage}
                isUsed={actions.deleteUsage?.status === 'ready' && actions.deleteUsage.usedKeys.has(selectedRow?.entry.key)}
                busy={busy}
                onConfirm={() => actions.handleDeleteConfirmed(selectedRow?.entry.key)}
                onCancel={actions.cancelDelete}
              />
            ) : actions.revertConfirm ? (
              <RevertConfirmBlock
                revertConfirm={actions.revertConfirm}
                setRevertConfirm={actions.setRevertConfirm}
                busy={busy}
                onConfirm={actions.handleRevertConfirmed}
                onCancel={() => actions.setRevertConfirm(null)}
              />
            ) : actions.saveConfirm ? (
              <SaveConfirmBlock
                saveConfirm={actions.saveConfirm}
                busy={busy}
                onConfirm={actions.handleSaveConfirmed}
                onCancel={() => actions.setSaveConfirm(null)}
              />
            ) : (
              <div className="catmnt-form-actions">
                <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason || busy} onClick={handleSave}>
                  保存
                </button>
                {editState?.canRevert && (
                  <button className="catmnt-btn catmnt-btn--secondary" onClick={handleRevertClick}>
                    標準に戻す
                  </button>
                )}
                {editState?.canDelete && (
                  <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteClick}>
                    削除
                  </button>
                )}
              </div>
            )}

            {selectedRow && <CatalogPreview kind={CatalogKind.SECTION} entry={selectedRow.entry} />}
          </>
        )}
      </div>
    </>
  );
}

// ステップ12h: 建具種別（openingSubType）タブの新規追加フォーム初期値。key はnextOpeningSubTypeKey
// が同カテゴリ内で決めた値（user連番）をそのまま持つ——内装マスターと同じくユーザーが直接
// キーを入力する欄は無い。mechanismは既定でKNOWN_OPENING_MECHANISMSの先頭値にしておく
// （selectは常に有効な値を持たせるcontrolled component契約）。
function emptyOpeningSubTypeForm(category, key) {
  return {
    category, key, label: '', mechanism: KNOWN_OPENING_MECHANISMS[0],
    wallInterior: false, wallExterior: false, wallKindsExplicitEmpty: false,
    defaultWidth: '', defaultHeight: '',
    childRatio: '', fireLeaves: '', fireAngle: '', slideLayoutText: '',
  };
}

/**
 * ステップ12h: 建具種別（openingSubType）タブ本体。建具記号タブ（FixtureSymbolTab・12f）・
 * 内装マスタータブ（InteriorMasterTab・12g）と同じ共通ロジック（rowEditState/lockedFieldsFor/
 * planSaveEntry/planRevertToBuiltin/planRemoveUserEntry/applyCatalogEditPlan・
 * useCatalogEditActions）を使う——追加・複製・編集・標準の上書き・標準に戻す・削除の全操作。
 * キー（key）はカテゴリ（区分）ごとに独立した連番（nextOpeningSubTypeKey。'user1'…）で採番する
 * ——区分（category）を追加中に切り替えると、その区分の次の空き番号へ採番し直す
 * （handleCategoryChange）。区分・キー・機構（mechanism）はkeyBoundFields（catalogKinds.js
 * OPENING_SUB_TYPE登録表）のため既存行では固定（lockedFields）——編集できるのは呼称・対応壁種・
 * 既定幅／既定高・機構別の欄（子扉比率・防火枚数／防火角度・引違い配置）のみ。
 * 作図プレビューは姿図＋平面記号の両方を持つ（ui/catalogPreview.js openingSubTypePreview・
 * openingSubTypePlanPreview。CatalogPreview.jsxがkindを見てview:'plan'も自動で並べる）。
 * 「合わせ直す」（文書同梱を差分から本体へ合わせる一括操作）はステップ14-A3で
 * useRealignActions（kind汎用フック。材料タブ・14-A1、建具記号タブ・14-A2と同じ）へ展開した。
 * openingSubTypeのキーはkeyOfが`${category}:${key}`の複合キーを返す（catalogKinds.js
 * OPENING_SUB_TYPE登録表）ため、行ボタン・一括ボタンとも`def.keyOf(row.entry)`をrealignの
 * keyとして渡す（removeDocEntry/planRealignの照合キーと一致させる。row.entry.keyそのものは
 * 複合キーの後半だけで照合に使えない）。
 * @param {{ materialList: object[]|null }} props materialListは平面記号プレビューのダミー壁厚
 *   導出用（材料タブが動的importで読み込んだbuiltin一覧。未指定なら既定壁厚に落ちる）。
 */
function OpeningSubTypeTab({ materialList, onLibraryChanged }) {
  const def = kindDef(CatalogKind.OPENING_SUB_TYPE);
  const [builtinList, setBuiltinList] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');

  const [selectedKey, setSelectedKey] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [formMessage, setFormMessage] = useState(null);

  function onOpeningSubTypeSaved(entryKey, meta) {
    setIsAdding(false);
    setSelectedKey(entryKey);
    setFormMessage(catalogSaveMessage(CatalogKind.OPENING_SUB_TYPE, meta));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onOpeningSubTypeDeleted(plan) {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage(removeMessageFor(plan));
    realign.clearNotice();
    onLibraryChanged?.();
  }
  function onOpeningSubTypeReverted() {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage('標準に戻しました');
    realign.clearNotice();
    onLibraryChanged?.();
  }
  const actions = useCatalogEditActions(CatalogKind.OPENING_SUB_TYPE, {
    onSaved: onOpeningSubTypeSaved,
    onDeleted: onOpeningSubTypeDeleted,
    onReverted: onOpeningSubTypeReverted,
    onError: setFormError,
  });
  const { busy } = actions;

  useEffect(() => {
    let cancelled = false;
    kindDef(CatalogKind.OPENING_SUB_TYPE).loadBuiltin().then(list => {
      if (!cancelled) setBuiltinList(list);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  const builtinKeys = useMemo(() => new Set((builtinList ?? []).map(e => def.keyOf(e))), [builtinList, def]);

  const diffMap = builtinList ? docDiffMap(CatalogKind.OPENING_SUB_TYPE, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind: CatalogKind.OPENING_SUB_TYPE, builtinList, search, diffMap }) : [];
  // ステップ14-A3（課題A3）: 「合わせ直す」一括対象は検索の影響を受けない全行から取る
  // （材料タブ・14-A1、建具記号タブ・14-A2と同じ規約。realignTargetsはallRows基準で呼ぶ契約）。
  const allRows = builtinList ? buildCatalogRows({ kind: CatalogKind.OPENING_SUB_TYPE, builtinList, diffMap }) : [];

  // QA指摘（A2再報告）: 絞り込み後のrowsから選択行を探すと、検索で選択行が一覧から隠れたとき
  // 編集状態が消える（材料タブ・14-A1はallRowsから探している）。allRowsは検索の影響を受けない
  // ためここで揃える。
  const selectedRow = (!isAdding && selectedKey) ? allRows.find(r => def.keyOf(r.entry) === selectedKey) ?? null : null;
  const editState = selectedRow ? rowEditState(CatalogKind.OPENING_SUB_TYPE, selectedRow, { builtinKeys }) : null;
  const lockedFields = selectedRow
    ? lockedFieldsFor(CatalogKind.OPENING_SUB_TYPE, def.keyOf(selectedRow.entry), { builtinKeys })
    : new Set();
  const disabledReason = form ? openingSubTypeRowDisabledReason({ isAdding, editState }) : null;
  const { showChildRatio, showFireLeaves, showFireAngle, showSlideLayout } = openingSubTypeFormFieldsFor(form);

  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.OPENING_SUB_TYPE, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.OPENING_SUB_TYPE, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  // wallKinds/slideLayoutは配列・オブジェクトのためformatReadonlyValue（汎用整形）で文字列化する。
  const fmtDiffValue = (field, v) => {
    if (field === 'wallKinds' || field === 'slideLayout') return formatReadonlyValue(v);
    return v === null || v === undefined || v === '' ? '未設定' : String(v);
  };

  // ステップ14-A3（課題A3）: 「合わせ直す」はkind汎用フックuseRealignActionsへ委譲する（材料タブ・
  // 14-A1、建具記号タブ・14-A2と同じ）。onRealigned: 選択中の行が対象に含まれていた場合、出所
  // （doc→user/builtin）が変わりformが古い同梱値のままになるため選択を外す。
  function onOpeningSubTypeRealigned(keys) {
    if (selectedKey && keys.includes(selectedKey)) {
      setIsAdding(false);
      setSelectedKey(null);
      setForm(null);
      actions.resetConfirmState();
    }
  }
  const realign = useRealignActions(CatalogKind.OPENING_SUB_TYPE, {
    builtinList, allRows, onRealigned: onOpeningSubTypeRealigned,
  });

  function handleAddNew() {
    if (!builtinList) return;
    const allKeys = collectKnownCatalogKeys(CatalogKind.OPENING_SUB_TYPE, builtinList);
    const category = 'fitting';
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm(emptyOpeningSubTypeForm(category, nextOpeningSubTypeKey(category, allKeys)));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedKey(def.keyOf(row.entry));
    actions.resetConfirmState();
    setForm(openingSubTypeFormFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
  }

  function handleDuplicateClick(row) {
    if (!builtinList) return;
    const allKeys = collectKnownCatalogKeys(CatalogKind.OPENING_SUB_TYPE, builtinList);
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm({ ...openingSubTypeFormFromEntry(row.entry), key: nextOpeningSubTypeKey(row.entry.category, allKeys) });
    setFormError('複製しました。内容を確認して保存してください');
    setFormMessage(null);
    realign.clearNotice();
  }

  // 追加中に区分（category）を切り替えたときは、その区分の次の空き番号へキーを採番し直す
  // （区分ごとに独立した連番のため——設計12h「keyは同カテゴリ内でuser1…」）。編集中は区分自体が
  // 固定（lockedFields.has('category')でselectがdisabled）なので、このハンドラは呼ばれない。
  function handleCategoryChange(nextCategory) {
    if (isAdding && builtinList) {
      const allKeys = collectKnownCatalogKeys(CatalogKind.OPENING_SUB_TYPE, builtinList);
      setForm(f => ({ ...f, category: nextCategory, key: nextOpeningSubTypeKey(nextCategory, allKeys) }));
      return;
    }
    setForm(f => ({ ...f, category: nextCategory }));
  }

  async function handleSave() {
    if (!form || !builtinList) return;
    setFormError(null);
    setFormMessage(null);
    realign.clearNotice();
    const entry = buildOpeningSubTypeEntry(form);

    if (isAdding) {
      const allKeys = collectKnownCatalogKeys(CatalogKind.OPENING_SUB_TYPE, builtinList);
      const check = validateOpeningSubTypeForm(form, { isAdding: true, allKeys, builtinKeys });
      if (!check.ok) { setFormError(check.message); return; }
      const plan = planSaveEntry(CatalogKind.OPENING_SUB_TYPE, entry, { builtinList, rowState: null });
      if (!plan.ok) { setFormError(plan.message); return; }
      await actions.performSave(plan, def.keyOf(entry), { overridesBuiltin: plan.overridesBuiltin });
      return;
    }

    const check = validateOpeningSubTypeForm(form, { isAdding: false });
    if (!check.ok) { setFormError(check.message); return; }
    const prevEntry = selectedRow?.entry ?? null;
    const plan = planSaveEntry(CatalogKind.OPENING_SUB_TYPE, entry, {
      builtinList, rowState: editState?.state ?? null, prevEntry,
    });
    if (!plan.ok) { setFormError(plan.message); return; }
    if (plan.noop) { setFormMessage('変更はありません'); return; }

    if (plan.needsConfirm) {
      actions.setSaveConfirm({ plan, entryKey: def.keyOf(entry), confirmPairs: plan.confirmPairs, overridesBuiltin: plan.overridesBuiltin });
      return;
    }
    await actions.performSave(plan, def.keyOf(entry), { overridesBuiltin: plan.overridesBuiltin });
  }

  function handleDeleteClick() {
    setFormError(null);
    actions.handleDeleteClick();
  }

  function handleRevertClick() {
    if (!selectedRow) return;
    actions.handleRevertClick(def.keyOf(selectedRow.entry));
  }

  const duplicatable = !!form;
  const previewEntry = form ? buildOpeningSubTypeEntry(form) : null;

  return (
    <>
      <div className="catmnt-list-col">
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="呼称・キーで検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="catmnt-add-btn" disabled={!builtinList} onClick={handleAddNew}>
            + 新規追加
          </button>
          {realign.targets.length > 0 && (
            <button
              className="catmnt-btn catmnt-btn--secondary"
              onClick={() => realign.requestRealign(realign.targets.map(r => def.keyOf(r.entry)))}
            >
              すべて本体の内容に合わせ直す（{realign.targets.length}件・絞り込みに関わらず全件）
            </button>
          )}
        </div>

        {realign.notice && (
          <div className={realign.notice.kind === 'error' ? 'catmnt-form-error' : 'catmnt-form-message'}>
            {realign.notice.text}
          </div>
        )}

        {realign.realignConfirm && (
          <RealignConfirmBlock
            plans={realign.plans}
            onConfirm={realign.handleRealignConfirmed}
            onCancel={realign.cancelRealign}
          />
        )}

        <div className="catmnt-rows">
          {!builtinList && !loadError && <div className="catmnt-row-empty">読み込み中…</div>}
          {loadError && <div className="catmnt-row-empty">建具種別データの読み込みに失敗しました</div>}
          {builtinList && rows.length === 0 && <div className="catmnt-row-empty">該当する建具種別がありません</div>}
          {rows.map(row => {
            const key = def.keyOf(row.entry);
            return (
              <div
                key={key}
                className={`catmnt-row${(!isAdding && key === selectedKey) ? ' catmnt-row--selected' : ''}`}
                onClick={() => handleSelectRow(row)}
              >
                <span className={`catmnt-badge catmnt-badge--${row.origin ?? 'builtin'}`}>
                  {ORIGIN_LABELS[row.origin] ?? '?'}
                </span>
                {row.overridesBuiltin && (
                  <span className="catmnt-badge catmnt-badge--override">標準を編集</span>
                )}
                <span
                  className="catmnt-row-name"
                  style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                  title={row.diff ? diffTooltip(CatalogKind.OPENING_SUB_TYPE, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
                >
                  {row.entry.label}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
                </span>
                <span className="catmnt-cat-badge">{formatCategoryLabel(CatalogKind.OPENING_SUB_TYPE, row.entry.category)}</span>
                {row.diff && (
                  <button
                    className="catmnt-realign-btn"
                    title="本体の内容に合わせ直す"
                    onClick={e => { e.stopPropagation(); realign.requestRealign([key]); }}
                  >
                    合わせ直す
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="catmnt-form-col">
        {!form && (
          <div className="catmnt-form-empty">左の一覧から建具種別を選択するか、「+ 新規追加」してください</div>
        )}
        {form && (
          <>
            {disabledReason && <div className="catmnt-form-note">{disabledReason}</div>}

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">キー</span>
              <span className="catmnt-code-readout">{form.category}:{form.key}</span>
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">呼称</span>
              <input
                value={form.label}
                disabled={!!disabledReason}
                style={docDiffByField.has('label') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              />
              {docDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue('label', docDiffByField.get('label').from)}）
                </span>
              )}
              {builtinDiffByField.has('label') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue('label', builtinDiffByField.get('label').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">区分</span>
              <select
                value={form.category}
                disabled={!!disabledReason || lockedFields.has('category')}
                title={lockedFields.has('category') ? lockedFieldReason(CatalogKind.OPENING_SUB_TYPE, 'category') : undefined}
                onChange={e => handleCategoryChange(e.target.value)}
              >
                {categoryOptionsFor(CatalogKind.OPENING_SUB_TYPE).map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">機構</span>
              <select
                value={form.mechanism}
                disabled={!!disabledReason || lockedFields.has('mechanism')}
                title={lockedFields.has('mechanism') ? lockedFieldReason(CatalogKind.OPENING_SUB_TYPE, 'mechanism') : undefined}
                style={docDiffByField.has('mechanism') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, mechanism: e.target.value }))}
              >
                {KNOWN_OPENING_MECHANISMS.map(m => (
                  <option key={m} value={m}>{formatMechanismLabel(m)}</option>
                ))}
              </select>
              {docDiffByField.has('mechanism') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue('mechanism', docDiffByField.get('mechanism').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">対応壁種</span>
              <label style={{ fontSize: 12, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.wallInterior}
                  disabled={!!disabledReason}
                  onChange={e => setForm(f => ({ ...f, wallInterior: e.target.checked, wallKindsExplicitEmpty: false }))}
                />
                内部
              </label>
              <label style={{ fontSize: 12, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={form.wallExterior}
                  disabled={!!disabledReason}
                  onChange={e => setForm(f => ({ ...f, wallExterior: e.target.checked, wallKindsExplicitEmpty: false }))}
                />
                外部
              </label>
              {docDiffByField.has('wallKinds') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue('wallKinds', docDiffByField.get('wallKinds').from)}）
                </span>
              )}
              {builtinDiffByField.has('wallKinds') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue('wallKinds', builtinDiffByField.get('wallKinds').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">既定幅（mm）</span>
              <input
                value={form.defaultWidth}
                disabled={!!disabledReason}
                style={docDiffByField.has('defaultWidth') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, defaultWidth: e.target.value }))}
              />
              {docDiffByField.has('defaultWidth') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue('defaultWidth', docDiffByField.get('defaultWidth').from)}）
                </span>
              )}
              {builtinDiffByField.has('defaultWidth') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue('defaultWidth', builtinDiffByField.get('defaultWidth').from)}）
                </span>
              )}
            </div>

            <div className="catmnt-form-row">
              <span className="catmnt-form-label">既定高（mm）</span>
              <input
                value={form.defaultHeight}
                disabled={!!disabledReason}
                style={docDiffByField.has('defaultHeight') ? { color: CATALOG_DIFF_COLOR } : undefined}
                onChange={e => setForm(f => ({ ...f, defaultHeight: e.target.value }))}
              />
              {docDiffByField.has('defaultHeight') && (
                <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                  （本体 {fmtDiffValue('defaultHeight', docDiffByField.get('defaultHeight').from)}）
                </span>
              )}
              {builtinDiffByField.has('defaultHeight') && (
                <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                  （標準 {fmtDiffValue('defaultHeight', builtinDiffByField.get('defaultHeight').from)}）
                </span>
              )}
            </div>

            {showChildRatio && (
              <div className="catmnt-form-row">
                <span className="catmnt-form-label">子扉比率</span>
                <input
                  value={form.childRatio}
                  placeholder="例: 0.3（未入力は既定0.3）"
                  disabled={!!disabledReason}
                  style={docDiffByField.has('childRatio') ? { color: CATALOG_DIFF_COLOR } : undefined}
                  onChange={e => setForm(f => ({ ...f, childRatio: e.target.value }))}
                />
                {docDiffByField.has('childRatio') && (
                  <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                    （本体 {fmtDiffValue('childRatio', docDiffByField.get('childRatio').from)}）
                  </span>
                )}
                {builtinDiffByField.has('childRatio') && (
                  <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                    （標準 {fmtDiffValue('childRatio', builtinDiffByField.get('childRatio').from)}）
                  </span>
                )}
              </div>
            )}

            {/* QA指摘m3（リード裁定）: fireLeavesはFIRE_DOORのときだけ（FIRE_FOLDは描画側が
                参照しない）・fireAngleはFIRE_DOOR/FIRE_FOLD両方——showFireLeaves/showFireAngleを
                別々に判定する（openingSubTypeFormFieldsFor参照）。値域は1・2／90・180のみ。 */}
            {showFireLeaves && (
              <div className="catmnt-form-row">
                <span className="catmnt-form-label">防火枚数</span>
                <input
                  value={form.fireLeaves}
                  placeholder="1 または 2（未入力は既定1）"
                  disabled={!!disabledReason}
                  style={docDiffByField.has('fireLeaves') ? { color: CATALOG_DIFF_COLOR } : undefined}
                  onChange={e => setForm(f => ({ ...f, fireLeaves: e.target.value }))}
                />
                {docDiffByField.has('fireLeaves') && (
                  <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                    （本体 {fmtDiffValue('fireLeaves', docDiffByField.get('fireLeaves').from)}）
                  </span>
                )}
                {builtinDiffByField.has('fireLeaves') && (
                  <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                    （標準 {fmtDiffValue('fireLeaves', builtinDiffByField.get('fireLeaves').from)}）
                  </span>
                )}
              </div>
            )}
            {showFireAngle && (
              <div className="catmnt-form-row">
                <span className="catmnt-form-label">防火角度</span>
                <input
                  value={form.fireAngle}
                  placeholder="90 または 180（未入力は既定90）"
                  disabled={!!disabledReason}
                  style={docDiffByField.has('fireAngle') ? { color: CATALOG_DIFF_COLOR } : undefined}
                  onChange={e => setForm(f => ({ ...f, fireAngle: e.target.value }))}
                />
                {docDiffByField.has('fireAngle') && (
                  <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                    （本体 {fmtDiffValue('fireAngle', docDiffByField.get('fireAngle').from)}）
                  </span>
                )}
                {builtinDiffByField.has('fireAngle') && (
                  <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                    （標準 {fmtDiffValue('fireAngle', builtinDiffByField.get('fireAngle').from)}）
                  </span>
                )}
              </div>
            )}

            {showSlideLayout && (
              <div className="catmnt-form-row">
                <span className="catmnt-form-label">引違い配置</span>
                <input
                  value={form.slideLayoutText}
                  placeholder="例: tracks=2; pos fix"
                  disabled={!!disabledReason}
                  style={docDiffByField.has('slideLayout') ? { color: CATALOG_DIFF_COLOR } : undefined}
                  onChange={e => setForm(f => ({ ...f, slideLayoutText: e.target.value }))}
                />
                {docDiffByField.has('slideLayout') && (
                  <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                    （本体 {fmtDiffValue('slideLayout', docDiffByField.get('slideLayout').from)}）
                  </span>
                )}
                {builtinDiffByField.has('slideLayout') && (
                  <span className="catmnt-diff-note" style={{ color: '#64748b', fontSize: 11 }}>
                    （標準 {fmtDiffValue('slideLayout', builtinDiffByField.get('slideLayout').from)}）
                  </span>
                )}
              </div>
            )}

            {formError && <div className="catmnt-form-error">{formError}</div>}
            {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

            {actions.confirmingDelete ? (
              <DeleteConfirmBlock
                deleteUsage={actions.deleteUsage}
                isUsed={actions.deleteUsage?.status === 'ready' && actions.deleteUsage.usedKeys.has(selectedRow ? def.keyOf(selectedRow.entry) : null)}
                busy={busy}
                onConfirm={() => actions.handleDeleteConfirmed(selectedRow ? def.keyOf(selectedRow.entry) : null)}
                onCancel={actions.cancelDelete}
              />
            ) : actions.revertConfirm ? (
              <RevertConfirmBlock
                revertConfirm={actions.revertConfirm}
                setRevertConfirm={actions.setRevertConfirm}
                busy={busy}
                onConfirm={actions.handleRevertConfirmed}
                onCancel={() => actions.setRevertConfirm(null)}
              />
            ) : actions.saveConfirm ? (
              <SaveConfirmBlock
                saveConfirm={actions.saveConfirm}
                busy={busy}
                onConfirm={actions.handleSaveConfirmed}
                onCancel={() => actions.setSaveConfirm(null)}
              />
            ) : (
              <div className="catmnt-form-actions">
                <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason || busy} onClick={handleSave}>
                  {isAdding ? '追加' : '保存'}
                </button>
                {!isAdding && selectedRow && (
                  <button
                    className="catmnt-btn catmnt-btn--secondary"
                    disabled={!duplicatable}
                    onClick={() => handleDuplicateClick(selectedRow)}
                  >
                    複製
                  </button>
                )}
                {!isAdding && editState?.canRevert && (
                  <button className="catmnt-btn catmnt-btn--secondary" onClick={handleRevertClick}>
                    標準に戻す
                  </button>
                )}
                {!isAdding && editState?.canDelete && (
                  <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteClick}>
                    削除
                  </button>
                )}
              </div>
            )}

            {previewEntry && (
              <CatalogPreview kind={CatalogKind.OPENING_SUB_TYPE} entry={previewEntry} materialList={materialList} />
            )}
          </>
        )}
      </div>
    </>
  );
}
