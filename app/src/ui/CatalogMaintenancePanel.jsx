import { useEffect, useMemo, useState } from 'react';
import './CatalogMaintenancePanel.css';
import { CatalogKind, kindDef, MATERIAL_CLASSES } from '../catalog/catalogKinds.js';
import { parseMaterialCode } from '../catalog/materialCode.js';
import { docDiffMap, overlayFor, removeDocEntry } from '../catalog/catalogRegistry.js';
import { CATALOG_DIFF_COLOR, CATALOG_DIFF_MARK, diffPairs, diffTooltip } from '../catalog/catalogDiffView.js';
import { saveUserCatalog } from '../storage/db.js';
import { markDirty } from '../dirtyState.js';
import {
  buildKindTabs, buildMaterialRows, buildCatalogRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserMaterialEntry, removeUserMaterialEntry, upsertUserCatalogEntry, commitUserEntries,
  planRealign, realignTargets, planBulkSectionImport,
  canEditMaterialRow, isEditableMaterialCategory, parseThicknessInput, MATERIAL_CATEGORY,
} from '../catalog/catalogMaintenance.js';
import { parseSectionSpecList } from '../structural/sectionCatalog.js';

// materialData.js（本体マスタ）は仕上げモードと同じ理由でここでも動的 import する
// （EccentricityDialog.jsxと同型。コード分割維持——materialData.jsは独立チャンクのまま）。
// structural/sectionCatalog.jsは既にstructural/structuralEntities.js等から静的importされており
// 独立チャンクにならない（catalogKinds.jsのコメント参照）ため、ここでは静的importでよい
// （規格文字列の一括入力パーサ parseSectionSpecList を呼ぶためだけに使う。SECTION_CATALOG自体は
// 引き続きkindDef(section).loadBuiltin()の動的importで読む）。

const CATEGORY_LABELS = Object.freeze({
  [MATERIAL_CATEGORY.PANEL]:   '面材',
  [MATERIAL_CATEGORY.FINISH]:  '仕上げ材',
  [MATERIAL_CATEGORY.BACKING]: '下地材',
});
const ORIGIN_LABELS = Object.freeze({ doc: '同梱', user: 'ライブラリ', builtin: '標準' });

// ステップ7d: 内装マスター・境界マスターの閲覧タブ（読み取り専用）に並べる項目。
// ステップ8h: 断面も同じ閲覧タブ（ReadonlyKindTab）に並べる項目を追加。
// 追加・複製・編集・削除・合わせ直しボタンは出さない（選ぶ経路が無い・layers/fieldsの編集UIは
// 複雑・編集はステップ12でまとめて着手する裁定）。
const READONLY_KIND_FIELDS = Object.freeze({
  [CatalogKind.INTERIOR_MASTER]: Object.freeze([
    { field: 'label', label: '呼称' },
    { field: 'wallMaterial', label: '壁材' },
    { field: 'wallFinish', label: '壁仕上げ' },
    { field: 'ceilingHeight', label: '天井高' },
  ]),
  [CatalogKind.BOUNDARY_MASTER]: Object.freeze([
    { field: 'label', label: '呼称' },
    { field: 'kind', label: '種類' },
    { field: 'layers', label: '層構成' },
    { field: 'derivedFrom', label: '継承元' },
    { field: 'fields', label: '項目' },
  ]),
  [CatalogKind.SECTION]: Object.freeze([
    { field: 'label', label: '呼称' },
    { field: 'materialType', label: '材種' },
    { field: 'shape', label: '形状' },
    { field: 'width', label: '幅' },
    { field: 'height', label: '成' },
    { field: 'webThickness', label: 'ウェブ厚' },
    { field: 'flangeThickness', label: 'フランジ厚' },
    { field: 'wallThickness', label: '板厚' },
  ]),
});

/** layers（境界マスター）1件を「役割: コード or src」の1行文字列にする。 */
function formatLayerLine(layer) {
  const source = layer.code ?? layer.src ?? '（未指定）';
  return `${layer.role}: ${source}`;
}

/** READONLY_KIND_FIELDSの1項目値を読み取り専用表示用の文字列にする。 */
function formatReadonlyFieldValue(field, value) {
  if (field === 'layers') {
    return Array.isArray(value) && value.length > 0 ? value.map(formatLayerLine).join(' / ') : '（なし）';
  }
  if (field === 'fields') {
    const entries = value ? Object.entries(value) : [];
    return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v ?? 'null'}`).join(', ') : '（なし）';
  }
  if (value === null || value === undefined || value === '') return '（未設定）';
  return String(value);
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
  };
}

/**
 * ハンバーガー「カタログ保守」から開く全画面パネル。第1段の範囲＝材料の面材・仕上げ材のみ
 * （一覧／追加／複製／編集／削除）。下地材は一覧に出所バッジ付きで表示するが編集不可。
 * builtin（標準材料）の編集も第1段では不可（ステップ12）。
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
  // ステップ6b（4.7 合わせ直し）: null | { keys: string[] }（単一行=1件、「すべて合わせ直す」=複数件）
  const [realignConfirm, setRealignConfirm] = useState(null);

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

  // R13: 選択行が doc（文書同梱）起源で本体と不一致のとき、違っている項目だけを
  // フォームでオレンジ表示＋本体値併記する（doc は編集不可＝表示のみ）。
  // diffPairs(kind, from=本体, to=doc, diffFields) — diffFields は row.diff（docDiffMap）が
  // 既に持つものをそのまま渡し、等価判定を再計算しない。
  const docDiffByField = (selectedRow?.origin === 'doc' && selectedRow?.diff)
    ? new Map(diffPairs(
        CatalogKind.MATERIAL, selectedRow.diff.baseEntry, selectedRow.entry, selectedRow.diff.diffFields,
      ).map(p => [p.field, p]))
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

  // canEditMaterialRow（QA指摘Major-A）: category=backing・origin=builtin・origin=docは編集不可。
  // 新規追加（isAdding）はまだoriginを持たないためnull（=保存前提の編集可能扱い）で判定する。
  const { reason: disabledReason } = form
    ? canEditMaterialRow(isAdding ? null : (selectedRow?.origin ?? null), form.category)
    : { ok: true, reason: null };
  // 複製ボタンはcategoryだけで判定する（origin=builtin/docの行も、複製してユーザーライブラリの
  // 新規エントリを作る経路としては許可する。編集不可＝rowEditableとは別軸）。
  const duplicatable = form ? isEditableMaterialCategory(form.category) : false;

  function handleAddNew() {
    const major = firstMajor();
    setIsAdding(true);
    setSelectedCode(null);
    setConfirmingDelete(false);
    setForm({ name: '', spec: '', thickness: '', note: '', category: MATERIAL_CATEGORY.PANEL, major, minor: firstMinor(major) });
    setFormError(null);
    setFormMessage(null);
  }

  function handleSelectRow(row) {
    setIsAdding(false);
    setSelectedCode(row.entry.code);
    setConfirmingDelete(false);
    setForm(formFromEntry(row.entry));
    setFormError(null);
    setFormMessage(null);
  }

  function handleDuplicateClick(row) {
    const copy = duplicateMaterialEntry(row.entry, knownCodes);
    setIsAdding(true);
    setSelectedCode(null);
    setConfirmingDelete(false);
    setForm(formFromEntry(copy));
    setFormError('複製しました。名称を変更してから保存してください（同内容のままでは保存できません）');
    setFormMessage(null);
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
    });
    const result = validateMaterialEntry(entry, builtinList);
    if (!result.ok) { setFormError(result.message); return; }

    const { user } = overlayFor(CatalogKind.MATERIAL);
    const nextUser = upsertUserMaterialEntry(user, entry);
    try {
      await commitUserEntries(CatalogKind.MATERIAL, nextUser, user, { saveFn: saveUserCatalog });
    } catch (e) {
      setFormError(`保存に失敗しました: ${e.message}`);
      return;
    }

    setIsAdding(false);
    setSelectedCode(entry.code);
    setFormMessage('保存しました');
  }

  async function handleDeleteConfirmed() {
    if (!selectedRow) return;
    const { user } = overlayFor(CatalogKind.MATERIAL);
    let nextUser;
    try {
      nextUser = removeUserMaterialEntry(user, selectedRow.entry.code, selectedRow.origin);
    } catch (e) {
      setFormError(e.message);
      setConfirmingDelete(false);
      return;
    }
    try {
      await commitUserEntries(CatalogKind.MATERIAL, nextUser, user, { saveFn: saveUserCatalog });
    } catch (e) {
      setFormError(`削除に失敗しました: ${e.message}`);
      setConfirmingDelete(false);
      return;
    }
    setIsAdding(false);
    setSelectedCode(null);
    setForm(null);
    setConfirmingDelete(false);
    setFormMessage('削除しました');
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
          {/* 左: 種別タブ（材料は追加・編集・削除まで実装。内装・境界マスターは閲覧のみ。
              section/openingSubTypeは登録表から器だけ出して無効化） */}
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
                      <span
                        className="catmnt-row-name"
                        style={row.diff ? { color: CATALOG_DIFF_COLOR } : undefined}
                        title={row.diff ? diffTooltip(CatalogKind.MATERIAL, row.diff.diffFields, row.entry, row.diff.baseEntry) : undefined}
                      >
                        {row.entry.name}{row.diff ? ` ${CATALOG_DIFF_MARK}` : ''}
                      </span>
                      <span className="catmnt-cat-badge">{CATEGORY_LABELS[row.entry.category] ?? row.entry.category}</span>
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
                        disabled={!!disabledReason}
                        style={docDiffByField.has('category') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                      >
                        <option value={MATERIAL_CATEGORY.PANEL}>面材</option>
                        <option value={MATERIAL_CATEGORY.FINISH}>仕上げ材</option>
                        {/* 下地材の行を選択した場合のみ表示用に出す（selectはdisabledReasonで無効化済み。
                            新規追加時はform.categoryが常にpanel/finishのため出現しない） */}
                        {form.category === MATERIAL_CATEGORY.BACKING && (
                          <option value={MATERIAL_CATEGORY.BACKING}>下地材</option>
                        )}
                      </select>
                      {/* R13: doc（文書同梱）が本体と不一致の項目だけ、本体値をオレンジで併記する */}
                      {docDiffByField.has('category') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {CATEGORY_LABELS[docDiffByField.get('category').from] ?? fmtDiffValue(docDiffByField.get('category').from)}）
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
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">X / Y</span>
                      <input value="0" disabled readOnly style={{ maxWidth: 56 }} />
                      <input value="0" disabled readOnly style={{ maxWidth: 56 }} />
                      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>面材・仕上げ材は寸法なし固定</span>
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">厚さ(mm)</span>
                      <input
                        value={form.thickness}
                        disabled={!!disabledReason}
                        style={docDiffByField.has('thickness') ? { color: CATALOG_DIFF_COLOR } : undefined}
                        onChange={e => setForm(f => ({ ...f, thickness: e.target.value }))}
                      />
                      {docDiffByField.has('thickness') && (
                        <span className="catmnt-diff-note" style={{ color: CATALOG_DIFF_COLOR, fontSize: 11 }}>
                          （本体 {fmtDiffValue(docDiffByField.get('thickness').from)}）
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
                    </div>

                    {formError && <div className="catmnt-form-error">{formError}</div>}
                    {formMessage && <div className="catmnt-form-message">{formMessage}</div>}

                    {confirmingDelete ? (
                      <div className="catmnt-form-row">
                        <span style={{ fontSize: 12, color: '#dc2626' }}>
                          本当に削除しますか？（ユーザーライブラリから外します）
                        </span>
                        <button className="catmnt-btn catmnt-btn--danger" onClick={handleDeleteConfirmed}>削除する</button>
                        <button className="catmnt-btn catmnt-btn--secondary" onClick={() => setConfirmingDelete(false)}>
                          キャンセル
                        </button>
                      </div>
                    ) : (
                      <div className="catmnt-form-actions">
                        <button className="catmnt-btn catmnt-btn--primary" disabled={!!disabledReason} onClick={handleSave}>
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
                        {!isAdding && selectedRow?.origin === 'user' && (
                          <button className="catmnt-btn catmnt-btn--danger" onClick={() => setConfirmingDelete(true)}>
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
            />
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
function ReadonlyKindTab({ kind, builtinList, search, setSearch, selectedKey, setSelectedKey }) {
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
            {fieldDefs.map(({ field, label }) => (
              <div className="catmnt-form-row" key={field}>
                <span className="catmnt-form-label">{label}</span>
                <span
                  className="catmnt-code-readout"
                  style={selectedRow.diff?.diffFields?.includes(field) ? { color: CATALOG_DIFF_COLOR } : undefined}
                >
                  {formatReadonlyFieldValue(field, selectedRow.entry[field])}
                </span>
              </div>
            ))}
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

  function handleParse() {
    setError(null);
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
    onImported?.();
  }

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
            onChange={e => { setText(e.target.value); setPlan(null); }}
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
                  <ul>{plan.toAdd.map(e => <li key={e.key}>{e.label}</li>)}</ul>
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
