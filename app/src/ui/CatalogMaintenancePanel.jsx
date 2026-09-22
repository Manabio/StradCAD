import { useEffect, useMemo, useState } from 'react';
import './CatalogMaintenancePanel.css';
import { CatalogKind, MATERIAL_CLASSES } from '../catalog/catalogKinds.js';
import { parseMaterialCode } from '../catalog/materialCode.js';
import { overlayFor } from '../catalog/catalogRegistry.js';
import { saveUserCatalog } from '../storage/db.js';
import {
  buildKindTabs, buildMaterialRows, collectKnownMaterialCodes, nextMaterialCode,
  buildMaterialEntry, duplicateMaterialEntry, validateMaterialEntry,
  upsertUserMaterialEntry, removeUserMaterialEntry, commitUserEntries,
  canEditMaterialRow, isEditableMaterialCategory, parseThicknessInput, MATERIAL_CATEGORY,
} from '../catalog/catalogMaintenance.js';

// materialData.js（本体マスタ）は仕上げモードと同じ理由でここでも動的 import する
// （EccentricityDialog.jsxと同型。コード分割維持——materialData.jsは独立チャンクのまま）。

const CATEGORY_LABELS = Object.freeze({
  [MATERIAL_CATEGORY.PANEL]:   '面材',
  [MATERIAL_CATEGORY.FINISH]:  '仕上げ材',
  [MATERIAL_CATEGORY.BACKING]: '下地材',
});
const ORIGIN_LABELS = Object.freeze({ doc: '同梱', user: 'ライブラリ', builtin: '標準' });

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
  const allRows = buildMaterialRows({ builtinList: list });
  const visibleRows = buildMaterialRows({ builtinList: list, search, category: category || null });
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

  useEffect(() => {
    let cancelled = false;
    import('../finish/materials/materialData.js').then(m => {
      if (!cancelled) setBuiltinList(m.MATERIALS);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

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
      await commitUserEntries(nextUser, user, { saveFn: saveUserCatalog });
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
      await commitUserEntries(nextUser, user, { saveFn: saveUserCatalog });
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
          {/* 左: 種別タブ（第1段は材料のみ実装。他は登録表から器だけ出して無効化） */}
          <div className="catmnt-kind-tabs">
            {kindTabs.map(tab => (
              <button
                key={tab.kind}
                className={`catmnt-kind-tab${tab.kind === activeKind ? ' catmnt-kind-tab--active' : ''}`}
                disabled={!tab.enabled}
                onClick={() => tab.enabled && setActiveKind(tab.kind)}
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
                </div>
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
                      <span className="catmnt-row-name">{row.entry.name}</span>
                      <span className="catmnt-cat-badge">{CATEGORY_LABELS[row.entry.category] ?? row.entry.category}</span>
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
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">名称</span>
                      <input
                        value={form.name}
                        disabled={!!disabledReason}
                        onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      />
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">仕様</span>
                      <input
                        value={form.spec}
                        disabled={!!disabledReason}
                        onChange={e => setForm(f => ({ ...f, spec: e.target.value }))}
                      />
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
                        onChange={e => setForm(f => ({ ...f, thickness: e.target.value }))}
                      />
                    </div>

                    <div className="catmnt-form-row">
                      <span className="catmnt-form-label">備考</span>
                      <input
                        value={form.note}
                        disabled={!!disabledReason}
                        onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                      />
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
        </div>
      </div>
    </div>
  );
}
