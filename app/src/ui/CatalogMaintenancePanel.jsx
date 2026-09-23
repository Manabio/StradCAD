import { useEffect, useMemo, useState } from 'react';
import './CatalogMaintenancePanel.css';
import { CatalogKind, kindDef, MATERIAL_CLASSES, FIXTURE_SYMBOL_PROFILES } from '../catalog/catalogKinds.js';
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
  planRealign, realignTargets, planBulkSectionImport, formatReadonlyValue, formatCategoryLabel,
  isEditableMaterialCategory, parseThicknessInput, MATERIAL_CATEGORY, BACKING_CLASS_OPTIONS,
  rowEditState, lockedFieldsFor, planSaveEntry, planRevertToBuiltin, planRemoveUserEntry,
  applyCatalogEditPlan, materialExtraLockedFields, materialSaveMessage, catalogSaveMessage,
  lockedFieldReason, materialRowDisabledReason, removeMessageFor, backingClassDisplayFor,
  buildFixtureSymbolEntry, validateFixtureSymbolForm, fixtureSymbolFormFieldsFor,
  fixtureSymbolRowDisabledReason, collectKnownCatalogKeys,
  fixtureSymbolFormFromEntry, fixtureSymbolPreviewEntry, categoryOptionsFor,
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
const READONLY_KIND_FIELDS = Object.freeze({
  [CatalogKind.INTERIOR_MASTER]: Object.freeze(['label', 'wallMaterial', 'wallFinish', 'ceilingHeight']),
  [CatalogKind.BOUNDARY_MASTER]: Object.freeze(['label', 'kind', 'layers', 'derivedFrom', 'fields']),
  [CatalogKind.SECTION]: Object.freeze([
    'label', 'materialType', 'shape', 'width', 'height', 'webThickness', 'flangeThickness', 'wallThickness',
  ]),
  [CatalogKind.OPENING_SUB_TYPE]: Object.freeze([
    'label', 'category', 'mechanism', 'wallKinds', 'defaultWidth', 'defaultHeight',
    'childRatio', 'fireLeaves', 'fireAngle', 'slideLayout',
  ]),
  // ステップ12f: 建具記号（fixtureSymbol）は編集タブ（FixtureSymbolTab）へ移行したため、
  // ここには含めない（ReadonlyKindTabの対象から外れる）。
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
  // R13: doc（文書同梱）起源の材が本体と不一致な分だけを集める（毎レンダー取り直し。
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
  // ステップ6b（4.7 合わせ直し）: null | { keys: string[] }（単一行=1件、「すべて合わせ直す」=複数件）
  const [realignConfirm, setRealignConfirm] = useState(null);
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

  // R13: 選択行が doc（文書同梱）起源で本体と不一致のとき、違っている項目だけを
  // フォームでオレンジ表示＋本体値併記する（doc は編集不可＝表示のみ）。
  // diffPairs(kind, from=本体, to=doc, diffFields) — diffFields は row.diff（docDiffMap）が
  // 既に持つものをそのまま渡し、等価判定を再計算しない。
  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.MATERIAL, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
    : new Map();
  // ステップ12b（1章: 標準の上書き行はbuiltinEntryと違う項目に本体値を併記。R13のオレンジとは
  // 別の意味（不一致の通知ではなく「標準からの差分」の参考表示）のため色は変えない）。
  const builtinDiffByField = (editState?.state === 'override' && selectedRow?.builtinEntry)
    ? new Map(diffPairs(CatalogKind.MATERIAL, selectedRow.builtinEntry, selectedRow.entry).map(p => [p.field, p]))
    : new Map();
  const fmtDiffValue = v => (v === null || v === undefined || v === '' ? '未設定' : String(v));

  // ステップ6b（4.7 合わせ直し）: 出所「同梱」で差分ありの行（realignTargets。allRows基準——
  // 検索・カテゴリ絞り込みの影響を受けない＝一覧全体が対象。ボタンのラベルにもその旨を明記する
  // QA指摘Minor-2・2026-09-23）。realignConfirm が立っているあいだは、対象キーごとに
  // planRealign（catalogMaintenance.js）でプラン（diffPairs/reason）を取り直す
  // （承認直前の最新overlay状態を反映するため、useMemoでキャッシュしない）。
  const diffRows = realignTargets(allRows);
  const realignPlans = (realignConfirm && builtinList)
    ? realignConfirm.keys.map(key => {
        let plan;
        try {
          plan = planRealign(CatalogKind.MATERIAL, key, { builtinList });
        } catch (e) {
          plan = { ok: false, reason: e.message };
        }
        const row = allRows.find(r => r.entry.code === key);
        return { key, plan, name: row?.entry?.name ?? key };
      })
    : [];

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
  }

  async function handleSave() {
    if (!form) return;
    setFormError(null);
    setFormMessage(null);
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
      // material専用のカテゴリ制約を持たせられない）。def.validate/R17はplanSaveEntry側でも
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
    // planSaveEntry経由（固定項目検査・R17・overridesBuiltin付与・doc-same/doc-overrideの
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
  // しか見ず、保存前の削除で参照が宙に浮く事故があった（Q9違反）。
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
  }

  // ステップ6b（4.7 合わせ直し）: 承認された対象キーを removeDocEntry（catalog/catalogRegistry.js）で
  // 文書同梱（doc）から外す。永続化I/Oはしない——次の保存で同梱がbuiltin/user内容で書き直される
  // （saveCatalogDocument が overlay 合成結果から束を作るため）。dirtyState.js の markDirty で
  // 保存を促す（他の overlay 変更＝commitUserEntries経由はcommitUserEntries内で永続化まで行うのに対し、
  // removeDocEntryはoverlayのみ変えるIn-memory操作のため、ここで明示的にmarkDirtyする）。
  function handleRealignConfirmed() {
    if (!realignConfirm) return;
    try {
      for (const key of realignConfirm.keys) {
        removeDocEntry(CatalogKind.MATERIAL, key);
      }
    } catch (e) {
      setFormError(e.message);
      setRealignConfirm(null);
      return;
    }
    markDirty();
    // 選択中の行が合わせ直し対象に含まれていた場合、出所（doc→user/builtin）が変わり
    // formが古い同梱値のままになるため、選択を外して再選択を促す（削除確認と同じ扱い）。
    if (selectedCode && realignConfirm.keys.includes(selectedCode)) {
      setIsAdding(false);
      setSelectedCode(null);
      setForm(null);
    }
    setRealignConfirm(null);
    setFormMessage('本体の内容に合わせ直しました（保存すると同梱が本体の内容で更新され、通知が止まります）');
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
                  {diffRows.length > 0 && (
                    <button
                      className="catmnt-btn catmnt-btn--secondary"
                      onClick={() => setRealignConfirm({ keys: diffRows.map(r => r.entry.code) })}
                    >
                      すべて本体の内容に合わせ直す（{diffRows.length}件・絞り込みに関わらず全件）
                    </button>
                  )}
                </div>

                {/* ステップ6b: 合わせ直しの確認（単一行・一括のどちらも同じ型。削除確認と同様インライン） */}
                {realignConfirm && (
                  <div className="catmnt-realign-confirm">
                    <div className="catmnt-realign-confirm-title">
                      本体の内容に合わせ直しますか？（{realignConfirm.keys.length}件）
                    </div>
                    {realignPlans.map(({ key, plan, name }) => (
                      <div key={key} className="catmnt-realign-item">
                        <div className="catmnt-realign-item-name">{name}</div>
                        {plan.ok ? (
                          <ul className="catmnt-realign-diff-list">
                            {plan.diffPairs.map(p => (
                              <li key={p.field} style={{ color: CATALOG_DIFF_COLOR }}>
                                {p.label} {fmtDiffValue(p.from)} → {fmtDiffValue(p.to)}
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
                      <button className="catmnt-btn catmnt-btn--primary" onClick={handleRealignConfirmed}>
                        承認する
                      </button>
                      <button className="catmnt-btn catmnt-btn--secondary" onClick={() => setRealignConfirm(null)}>
                        キャンセル
                      </button>
                    </div>
                  </div>
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
                          onClick={e => { e.stopPropagation(); setRealignConfirm({ keys: [row.entry.code] }); }}
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
                      {/* R13: doc（文書同梱）が本体と不一致の項目だけ、本体値をオレンジで併記する */}
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

          {/* ステップ7d: 内装マスター・境界マスターの閲覧タブ（読み取り専用。追加・複製・編集・
              削除・合わせ直しボタンは出さない——選ぶ経路が無い・layers/fieldsの編集UIは複雑・
              編集はステップ12でまとめて着手する裁定） */}
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
            <FixtureSymbolTab materialList={builtinList} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * ステップ7d: 内装マスター・境界マスターの閲覧タブ本体（読み取り専用）。
 * builtin一覧・overlay（catalog/catalogRegistry.js）を buildCatalogRows で合成し、出所バッジ・
 * R13差分（≠＋オレンジ＋diffTooltip）付きの一覧と、選択行の詳細（READONLY_KIND_FIELDS）を表示する
 * だけ——追加・複製・編集・削除・合わせ直しの手段は一切持たない。
 */
function ReadonlyKindTab({ kind, builtinList, search, setSearch, selectedKey, setSelectedKey, materialList }) {
  const def = kindDef(kind);
  // ステップ8i: 規格文字列の一括入力（断面タブのみ）でユーザーライブラリへ追加した直後、
  // overlay（catalog/catalogRegistry.jsのモジュール単位の可変状態。Reactが追跡しない）の
  // 変化を一覧へ反映するため、増分だけを持つローカルstateで強制的に再レンダーする
  // （computeDerived相当のrows計算は毎レンダー取り直しのため、これだけで足りる）。
  const [refreshTick, setRefreshTick] = useState(0);
  const diffMap = builtinList ? docDiffMap(kind, builtinList) : new Map();
  const rows = builtinList ? buildCatalogRows({ kind, builtinList, search, diffMap }) : [];
  const selectedRow = selectedKey ? rows.find(r => def.keyOf(r.entry) === selectedKey) ?? null : null;
  const fieldDefs = READONLY_KIND_FIELDS[kind] ?? [];

  return (
    <>
      <div className="catmnt-list-col" data-refresh-tick={refreshTick}>
        <div className="catmnt-list-toolbar">
          <input
            className="catmnt-search-input"
            placeholder="名称で検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {kind === CatalogKind.SECTION && builtinList && (
          <SectionBulkImport builtinList={builtinList} onImported={() => setRefreshTick(t => t + 1)} />
        )}
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
 * ステップ8i: 断面の「規格文字列から追加」（折りたたみ）。断面タブ（ReadonlyKindTab）専用——
 * 他の閲覧タブ（内装マスター・境界マスター）には出さない。解析（planBulkSectionImport）→
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
// 現状の適用範囲（報告事項）: FixtureSymbolTabはこのフック・コンポーネントへ移行済み。材料タブ
// （CatalogMaintenancePanel本体）は本ラウンドでは未移行——材料タブは同じ確認state群に加えて
// 「合わせ直す」（realignConfirm）・R13/標準差分のフィールド別オレンジ表示・下地区分selectの
// 表示値解決など、確認フロー本体だけでは括れない付随ロジックが同じハンドラへ深く絡んでおり、
// 移行するには材料タブの十数本の既存wiringテスト（performSave/handleDeleteConfirmed/
// handleRevertConfirmedの関数シグネチャ・busy state宣言・確認ボタンJSXを正規表現で直接検査する
// もの）を書き直す必要がある。本セッションでは目視確認の手段が無い状態でその一括書き換えを
// 行うリスクが高いと判断し、材料タブは現状のまま維持し、この報告として明記する
// （フック・確認ブロック自体は次段（12g/12h）で新設するタブ、および材料タブの将来の移行先として
// 用意しておく）。
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
 * ステップ12f: 建具記号（fixtureSymbol）タブ本体。材料タブ（本体上書き込み。ステップ12a〜12c）と
 * 同じ共通ロジック（rowEditState/lockedFieldsFor/planSaveEntry/planRevertToBuiltin/
 * planRemoveUserEntry/applyCatalogEditPlan）を使う——追加・複製・編集・標準の上書き・標準に戻す・
 * 削除。「合わせ直す」（文書同梱をR13差分から本体へ合わせる一括操作）はこのタブの対象外
 * （設計12fの明示スコープに無い。doc-diff行は複製のみ可能なまま——rowEditStateのreasonどおり）。
 * @param {{ materialList: object[]|null }} props materialListは平面記号プレビューのダミー壁厚
 *   導出用（材料タブが動的importで読み込んだbuiltin一覧。未指定なら既定壁厚に落ちる）。
 */
function FixtureSymbolTab({ materialList }) {
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
  }
  function onFixtureSymbolDeleted(plan) {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage(removeMessageFor(plan));
  }
  function onFixtureSymbolReverted() {
    setIsAdding(false);
    setSelectedKey(null);
    setForm(null);
    setFormMessage('標準に戻しました');
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

  const selectedRow = (!isAdding && selectedKey) ? rows.find(r => r.entry.key === selectedKey) ?? null : null;
  const editState = selectedRow ? rowEditState(CatalogKind.FIXTURE_SYMBOL, selectedRow, { builtinKeys }) : null;
  const lockedFields = selectedRow
    ? lockedFieldsFor(CatalogKind.FIXTURE_SYMBOL, selectedRow.entry.key, { builtinKeys })
    : new Set();
  const disabledReason = form ? fixtureSymbolRowDisabledReason({ isAdding, editState }) : null;
  const { showProfile } = fixtureSymbolFormFieldsFor(form);

  // QA指摘m5（2026-09-24再報告）: 材料タブと同じ2種類の併記——R13（doc起源が本体と不一致。
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

  function handleAddNew() {
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm(emptyFixtureSymbolForm());
    setFormError(null);
    setFormMessage(null);
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedKey(row.entry.key);
    actions.resetConfirmState();
    setForm(fixtureSymbolFormFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
  }

  function handleDuplicateClick(row) {
    setIsAdding(true);
    setSelectedKey(null);
    actions.resetConfirmState();
    setForm({ ...fixtureSymbolFormFromEntry(row.entry), key: '' });
    setFormError('複製しました。記号を変更してから保存してください');
    setFormMessage(null);
  }

  async function handleSave() {
    if (!form || !builtinList) return;
    setFormError(null);
    setFormMessage(null);
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
        </div>

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
