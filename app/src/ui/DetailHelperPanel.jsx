import { useEffect, useMemo, useRef, useState } from 'react';
import './DetailHelperPanel.css';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { overlayFor, docDiffMap } from '../catalog/catalogRegistry.js';
import { planRemoveUserEntry, applyCatalogEditPlan } from '../catalog/catalogMaintenance.js';
import { DetailLenMode } from '../core/constants.js';
import { saveUserCatalog } from '../storage/db.js';
import { markDirty } from '../dirtyState.js';
import { collectCurrentCatalogUsage } from '../store.js';
import { runBusy } from '../uiBusy.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import { NumPad } from './NumPad.jsx';
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { previewWallThicknessFor } from './catalogPreview.js';
import { useScrollIntoViewWhenActive } from './useScrollIntoViewWhenActive.js';
import {
  DETAIL_HELPER_TEXT, DETAIL_HELPER_MESSAGES, DETAIL_NUMPAD_LABELS, PEN_BUTTONS, PREVIEW_FRAME_PX,
  DETAIL_ROLE_LABELS, DETAIL_MODE_LABELS, DETAIL_PARAM_LABELS, DETAIL_MATERIAL_FIELD_LABELS, DETAIL_DATUM_KIND_LABELS, DETAIL_AXIS_LABELS,
  newDraft, entryFromForm, freshDocOf, docFromEntry, duplicateDoc, afterDeleteDoc, clearPenError, docContextFor, isDraftDirty, undoDraft, penStep, penUp, setClosed,
  setMoveLen, setMoveMode, moveRows, addDatum, removeDatum, setDatumField, setAnchor, anchorVertex, vertexOptions,
  comboOptions, setClassification, validation, saveBlockers, saveEnabled, saveDecision, planSave, afterSaveDoc,
  deleteConfirmMessage, libraryRows, defaultFitDimsFor, fitDimFieldsFor, tryFit, previewPrimitivesOf, labelOptions, pushHistory,
  displayLen, strokeLabel, strokeTitle, moveSpanLabel, distanceButtonLabel, offsetButtonLabel, fitDimButtonLabel,
  libraryMetaLabel, wallThicknessNotice,
} from './detailHelperForm.js';

/**
 * 部分詳細図ヘルパー（全画面パネル）。ペン入力で一筆書きの図を描き、基準・寸法を指定して
 * ライブラリ（カタログ種別 detailFigure の user 層）へ保存・削除する。グラフは読まない・書かない。
 * 判断（フォーム操作・検証・保存可否・文言）は ui/detailHelperForm.js に持ち、ここは配線だけ。
 * 保存・削除は CatalogMaintenancePanel と同じ共通経路（planSaveEntry/planRemoveUserEntry → applyCatalogEditPlan）を
 * runBusy('カタログ適用', …) の中で呼ぶ。
 */
const KIND = CatalogKind.DETAIL_FIGURE;
const newKeyPart = () => crypto.randomUUID();
const freshDoc = () => freshDocOf(newDraft({ idFactory: newKeyPart }));

const MODE_OPTIONS = labelOptions(DETAIL_MODE_LABELS);
const ROLE_OPTIONS = labelOptions(DETAIL_ROLE_LABELS);
const PARAM_OPTIONS = labelOptions(DETAIL_PARAM_LABELS);
const FIELD_OPTIONS = labelOptions(DETAIL_MATERIAL_FIELD_LABELS);
const KIND_OPTIONS = labelOptions(DETAIL_DATUM_KIND_LABELS);
const AXIS_OPTIONS = labelOptions(DETAIL_AXIS_LABELS);

function Select({ value, options, onChange, disabled, empty }) {
  return (
    <select className="dthlp-select" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function LibraryRow({ row, active, disabled, onSelect }) {
  const ref = useScrollIntoViewWhenActive(active);
  return (
    <button ref={ref} disabled={disabled} className={`dthlp-lib-row${active ? ' dthlp-lib-row--active' : ''}`} onClick={() => onSelect(row.key)}>
      <span className="dthlp-lib-label">{row.label}</span>
      <span className="dthlp-lib-meta">{libraryMetaLabel(row)}</span>
    </button>
  );
}

export function DetailHelperPanel({ onClose }) {
  const [doc, setDoc] = useState(freshDoc);
  const { form, history, baseline, prevEntry } = doc;
  const penError = doc.penError ?? null;
  const rootRef = useRef(null);
  const [penText, setPenText] = useState('');
  const [numpad, setNumpad] = useState(null); // { target, value, label }
  const [fitOn, setFitOn] = useState(false);
  const [fitOverrides, setFitOverrides] = useState({});
  const [materialList, setMaterialList] = useState(undefined);
  const [materialLoadFailed, setMaterialLoadFailed] = useState(false);
  const [, setLibTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { text, isError }
  const [confirm, setConfirm] = useState(null); // { message, buttons, onSelect }

  // 試し込みの壁厚の既定は保守パネルのプレビューと同じ式（下地材＋面材×2）。材の一覧は保守パネルと同様に動的 import。
  useEffect(() => {
    let cancelled = false;
    import('../finish/materials/materialData.js').then(m => { if (!cancelled) setMaterialList(m.MATERIALS); })
      .catch(() => { if (!cancelled) setMaterialLoadFailed(true); }); // 失敗は黙らせず、壁厚欄に「既定値で代用中」を示す
    return () => { cancelled = true; };
  }, []);

  // 開いた直後からキー入力（Escape）を受けられるよう、ルートへフォーカスする。
  useEffect(() => { rootRef.current?.focus(); }, []);

  const fitDims = useMemo(
    () => ({ ...defaultFitDimsFor(form, previewWallThicknessFor(null, materialList)), ...fitOverrides }),
    [materialList, fitOverrides, form],
  );
  const fitFields = fitDimFieldsFor(form);
  const fitted = useMemo(() => (fitOn ? tryFit(form, fitDims) : null), [fitOn, form, fitDims]);
  const primitives = useMemo(() => previewPrimitivesOf(form, fitted), [form, fitted]);
  const result = useMemo(() => validation(form), [form]);
  const blockers = saveBlockers(form, result);
  const dirty = isDraftDirty(form, baseline);
  const options = comboOptions(form.category, form.view);
  // overlay は React が追跡しないモジュール状態。保存・削除の完了で setLibTick により再レンダーして毎回引き直す（一覧は小さい）。
  const libItems = libraryRows(overlayFor(KIND).user);

  function edit(fn, { track = true } = {}) {
    setDoc(d => {
      const next = fn(d.form);
      if (next === d.form) return d;
      return clearPenError({ ...d, form: next, history: track ? pushHistory(d.history, d.form) : d.history });
    });
  }
  function replaceDoc(next) {
    setDoc(next);
    setMessage(null);
  }
  // 未保存の下書きがあれば確認してから action を実行する。
  function guardDiscard(action) {
    if (!dirty) { action(); return; }
    setConfirm({
      message: DETAIL_HELPER_MESSAGES.discard,
      buttons: [
        { label: DETAIL_HELPER_MESSAGES.discardButton, value: 'ok', primary: true, danger: true },
        { label: DETAIL_HELPER_MESSAGES.cancelButton, value: 'cancel' },
      ],
      onSelect: v => { setConfirm(null); if (v === 'ok') action(); },
    });
  }

  function handleUndo() {
    setDoc(d => {
      const r = undoDraft(d.history);
      return r ? clearPenError({ ...d, form: r.form, history: r.history }) : d;
    });
  }
  // 計算は setDoc の関数の中（現在の doc から）。エラーは doc.penError に入る。
  function handlePen(dir) {
    setDoc(d => penStep(d, dir, penText));
  }

  function openNumpad(target, value, label) {
    setNumpad({ target, value, label });
  }
  function confirmNumpad() {
    const { target, value } = numpad;
    setNumpad(null);
    if (target.kind === 'pen') { setPenText(value); setDoc(d => ({ ...d, penError: null })); }
    else if (target.kind === 'move') edit(f => setMoveLen(f, target.editKey, value));
    else if (target.kind === 'offset') edit(f => setDatumField(f, target.datumId, 'offset', value));
    else if (target.kind === 'fit') setFitOverrides(o => ({ ...o, [target.field]: value }));
  }

  function handleOpenEntry(key) {
    const entry = overlayFor(KIND).user.find(e => e.key === key);
    if (!entry) return;
    guardDiscard(() => replaceDoc(docFromEntry(entry)));
  }

  // 保存・削除・busy・失敗文言は CatalogMaintenancePanel.jsx の useCatalogEditActions と同型。共有化は S5 後の整理課題。
  async function handleSave() {
    if (busy) return;
    const entry = entryFromForm(form);
    // 同梱にも同じキーがあるとき、保守パネルと同じ行状態（doc-same 等）で保存し、同梱を外して開いている文書へ即反映する。
    const plan = planSave(entry, prevEntry, docContextFor(KIND, { overlayFor, docDiffMap }));
    const decision = saveDecision(plan);
    if (!decision.apply) { setMessage({ text: decision.message, isError: decision.isError }); return; }
    if (decision.confirmMessage) {
      setConfirm({
        message: decision.confirmMessage,
        buttons: [
          { label: DETAIL_HELPER_TEXT.approveButton, value: 'ok', primary: true },
          { label: DETAIL_HELPER_MESSAGES.cancelButton, value: 'cancel' },
        ],
        onSelect: v => { setConfirm(null); if (v === 'ok') performSave(plan, entry, form, decision); },
      });
      return;
    }
    await performSave(plan, entry, form, decision);
  }
  async function performSave(plan, entry, savedForm, decision) {
    if (busy) return;
    setBusy(true);
    try {
      await runBusy('カタログ適用', () => applyCatalogEditPlan(KIND, plan, { saveFn: saveUserCatalog, markDirty }));
    } catch (e) {
      setMessage({ text: `保存に失敗しました: ${e.message}`, isError: true });
      return;
    } finally {
      setBusy(false);
    }
    setDoc(d => afterSaveDoc(d, entry, savedForm));
    setLibTick(t => t + 1);
    setMessage({ text: decision.message, isError: false });
  }

  async function handleDeleteClick() {
    if (busy || !prevEntry) return;
    // 使用状況を集める await の間に別の図を開く・複製・編集が通らないよう、先に塞ぐ（確認を出す前に戻す）。
    setBusy(true);
    let used;
    try {
      used = (await collectCurrentCatalogUsage()).get(KIND) ?? new Set();
    } catch (e) {
      setMessage({ text: e.message, isError: true });
      return;
    } finally {
      setBusy(false);
    }
    setConfirm({
      message: deleteConfirmMessage({ label: prevEntry.label, used: used.has(prevEntry.key), dirty }),
      buttons: [
        { label: DETAIL_HELPER_MESSAGES.confirmDeleteButton, value: 'ok', primary: true, danger: true },
        { label: DETAIL_HELPER_MESSAGES.cancelButton, value: 'cancel' },
      ],
      onSelect: v => { setConfirm(null); if (v === 'ok') performDelete(prevEntry.key, used); },
    });
  }
  async function performDelete(key, usedKeys) {
    if (busy) return;
    let plan;
    try {
      plan = planRemoveUserEntry(KIND, key, { usedKeys });
    } catch (e) {
      setMessage({ text: e.message, isError: true });
      return;
    }
    setBusy(true);
    try {
      await runBusy('カタログ適用', () => applyCatalogEditPlan(KIND, plan, { saveFn: saveUserCatalog, markDirty }));
    } catch (e) {
      setMessage({ text: `削除に失敗しました: ${e.message}`, isError: true });
      return;
    } finally {
      setBusy(false);
    }
    setLibTick(t => t + 1);
    const fresh = freshDoc();
    setDoc(d => afterDeleteDoc(d, key, fresh));
    setMessage(null);
  }

  function handleDuplicate() {
    setDoc(d => duplicateDoc(d, { idFactory: newKeyPart }));
    setMessage(null);
  }

  function handleKeyDown(e) {
    if (e.key !== 'Escape' || numpad || confirm || busy) return;
    e.stopPropagation();
    guardDiscard(onClose);
  }

  const rows = moveRows(form);
  const wallNotice = wallThicknessNotice(materialLoadFailed);
  const canSave = saveEnabled(form, result) && !busy;

  return (
    <div className="dthlp-root" ref={rootRef} tabIndex={-1} onKeyDown={handleKeyDown}>
      <div className="dthlp-header">
        <span className="dthlp-title">{DETAIL_HELPER_TEXT.title}</span>
        <div className="dthlp-header-actions">
          <button className="dthlp-btn" disabled={busy} onClick={() => guardDiscard(() => replaceDoc(freshDoc()))}>{DETAIL_HELPER_TEXT.newDraft}</button>
          <button className="dthlp-btn" disabled={busy} onClick={() => guardDiscard(onClose)}>{DETAIL_HELPER_TEXT.close}</button>
        </div>
      </div>

      <div className="dthlp-body">
        {/* 左: ペン操作と命令一覧 */}
        <section className="dthlp-pane dthlp-left">
          <div className="dthlp-pen">
            <button className="dthlp-btn dthlp-distance" onClick={() => openNumpad({ kind: 'pen' }, penText, DETAIL_NUMPAD_LABELS.penDistance)}>
              {distanceButtonLabel(penText)}
            </button>
            <div className="dthlp-dirs">
              {PEN_BUTTONS.map(b => (
                <button key={b.dir} className={`dthlp-btn dthlp-dir dthlp-dir--${b.dir}`} onClick={() => handlePen(b.dir)}>{b.label}</button>
              ))}
            </div>
            <div className="dthlp-pen-actions">
              <button className="dthlp-btn" onClick={() => edit(penUp)}>{DETAIL_HELPER_TEXT.penUp}</button>
              <button className="dthlp-btn" disabled={history.length === 0} onClick={handleUndo}>{DETAIL_HELPER_TEXT.undo}</button>
            </div>
            {penError && <div className="dthlp-error">{penError}</div>}
          </div>

          <div className="dthlp-moves">
            {rows.map(r => (
              <div key={r.strokeId} className="dthlp-stroke">
                <div className="dthlp-stroke-head">
                  <span>{strokeTitle(r.strokeIndex, r.vertexCount)}</span>
                  <button className="dthlp-btn dthlp-btn--small" onClick={() => edit(f => setClosed(f, r.strokeId, !r.closed))}>
                    {r.closed ? DETAIL_HELPER_TEXT.openShape : DETAIL_HELPER_TEXT.closeShape}
                  </button>
                </div>
                {r.moves.map(m => (
                  <div key={m.editKey.moveIndex} className="dthlp-move">
                    <span className="dthlp-move-span">{moveSpanLabel(m)}</span>
                    {m.isVector ? (
                      <span>{m.dirLabel}</span>
                    ) : (
                      <>
                        <button className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'move', editKey: m.editKey }, m.lenText, DETAIL_NUMPAD_LABELS.moveLen)}>
                          {displayLen(m.lenText)}
                        </button>
                        <Select value={m.mode} options={MODE_OPTIONS} onChange={mode => edit(f => setMoveMode(f, m.editKey, mode))} />
                        {m.mode === DetailLenMode.PARAM && (
                          <Select value={m.param} options={PARAM_OPTIONS} onChange={param => edit(f => setMoveMode(f, m.editKey, m.mode, { param }))} />
                        )}
                        {m.mode === DetailLenMode.MATERIAL && (
                          <>
                            <input className="dthlp-input dthlp-input--code" value={m.code ?? ''}
                              onChange={e => edit(f => setMoveMode(f, m.editKey, m.mode, { code: e.target.value }), { track: false })} />
                            <Select value={m.field} options={FIELD_OPTIONS} onChange={field => edit(f => setMoveMode(f, m.editKey, m.mode, { field }))} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        {/* 中央: プレビューと試し込み */}
        <section className="dthlp-pane dthlp-center">
          <div className="dthlp-toolbar">
            <button className={`dthlp-btn${fitOn ? '' : ' dthlp-btn--active'}`} onClick={() => setFitOn(false)}>{DETAIL_HELPER_TEXT.fitOff}</button>
            <button className={`dthlp-btn${fitOn ? ' dthlp-btn--active' : ''}`} onClick={() => setFitOn(true)}>{DETAIL_HELPER_TEXT.fitOn}</button>
            {fitOn && fitFields.map(({ field, label }) => (
              <button key={field} className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'fit', field }, fitDims[field], label)}>
                {fitDimButtonLabel(label, fitDims[field])}
              </button>
            ))}
          </div>
          {fitOn && wallNotice && <div className="dthlp-error">{wallNotice}</div>}
          {fitted?.error && <div className="dthlp-error">{fitted.error.message}</div>}
          <div className="dthlp-preview">
            {primitives.length === 0 ? (
              <div className="dthlp-empty">{DETAIL_HELPER_MESSAGES.emptyPreview}</div>
            ) : (
              <AutoScaledFigure
                primitives={primitives}
                maxWidth={PREVIEW_FRAME_PX.width}
                maxHeight={PREVIEW_FRAME_PX.height}
                onEditDim={fitOn ? undefined : (dim, v) => edit(f => setMoveLen(f, dim.editKey, String(v)))}
              />
            )}
          </div>
        </section>

        {/* 右: 分類・基準・検証・保存・ライブラリ */}
        <section className="dthlp-pane dthlp-right">
          <div className="dthlp-block">
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldLabel}
              <input className="dthlp-input" value={form.label} onChange={e => edit(f => ({ ...f, label: e.target.value }), { track: false })} />
            </label>
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldCategory}
              <Select value={form.category} options={options.categories} onChange={v => edit(f => setClassification(f, 'category', v), { track: false })} />
            </label>
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldView}
              <Select value={form.view} options={options.views} onChange={v => edit(f => setClassification(f, 'view', v), { track: false })} />
            </label>
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldSubject}
              <Select value={form.subject} options={options.subjects} onChange={v => edit(f => setClassification(f, 'subject', v), { track: false })} />
            </label>
          </div>

          <div className="dthlp-block">
            <div className="dthlp-block-head">
              <span>{DETAIL_HELPER_TEXT.datumHeading}</span>
              <button className="dthlp-btn dthlp-btn--small" onClick={() => edit(f => addDatum(f))}>{DETAIL_HELPER_TEXT.addDatum}</button>
            </div>
            {form.datums.map(d => (
              <div key={d.id} className="dthlp-datum">
                <div className="dthlp-datum-main">
                  <Select value={d.axis} options={AXIS_OPTIONS} onChange={v => edit(f => setDatumField(f, d.id, 'axis', v))} />
                  <Select value={d.kind} options={KIND_OPTIONS} onChange={v => edit(f => setDatumField(f, d.id, 'kind', v))} />
                  <Select value={d.role} options={ROLE_OPTIONS} onChange={v => edit(f => setDatumField(f, d.id, 'role', v))} />
                  <button className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'offset', datumId: d.id }, d.offset, DETAIL_NUMPAD_LABELS.offset)}>
                    {offsetButtonLabel(d.offset)}
                  </button>
                  <button className="dthlp-btn dthlp-btn--small" onClick={() => edit(f => removeDatum(f, d.id))}>{DETAIL_HELPER_TEXT.remove}</button>
                </div>
                {form.strokes.map((s, i) => (
                  <div key={s.id} className="dthlp-anchor">
                    <span>{strokeLabel(i)}</span>
                    <Select
                      value={anchorVertex(form, s.id, d.id) ?? ''}
                      options={vertexOptions(form, s.id)}
                      empty={DETAIL_HELPER_TEXT.noAnchor}
                      onChange={v => edit(f => setAnchor(f, s.id, d.id, v))}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="dthlp-block">
            {blockers.length === 0 ? (
              <div className="dthlp-ok">{DETAIL_HELPER_TEXT.validOk}</div>
            ) : (
              <ul className="dthlp-errors">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
            <div className="dthlp-actions">
              <button className="dthlp-btn dthlp-btn--primary" disabled={!canSave} onClick={handleSave}>{DETAIL_HELPER_TEXT.save}</button>
              <button className="dthlp-btn" disabled={busy} onClick={handleDuplicate}>{DETAIL_HELPER_TEXT.duplicate}</button>
              <button className="dthlp-btn" disabled={busy || !prevEntry} onClick={handleDeleteClick}>{DETAIL_HELPER_TEXT.remove}</button>
            </div>
            {message && <div className={message.isError ? 'dthlp-error' : 'dthlp-ok'}>{message.text}</div>}
          </div>

          <div className="dthlp-block dthlp-library">
            {libItems.map(row => <LibraryRow key={row.key} row={row} active={row.key === prevEntry?.key} disabled={busy} onSelect={handleOpenEntry} />)}
          </div>
        </section>
      </div>

      {numpad && (
        <NumPad
          value={numpad.value}
          label={numpad.label}
          onChange={value => setNumpad(n => ({ ...n, value }))}
          onConfirm={confirmNumpad}
          onCancel={() => setNumpad(null)}
          keyboard
          cancelOnOutside
          selectOnStart
        />
      )}
      {confirm && <ConfirmDialog message={confirm.message} buttons={confirm.buttons} onSelect={confirm.onSelect} />}
    </div>
  );
}
