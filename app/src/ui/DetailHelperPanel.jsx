import { useEffect, useMemo, useRef, useState } from 'react';
import './DetailHelperPanel.css';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { overlayFor, docDiffMap } from '../catalog/catalogRegistry.js';
import { planRemoveUserEntry, applyCatalogEditPlan } from '../catalog/catalogMaintenance.js';
import { DetailLenMode, DetailEdgeMark } from '../core/constants.js';
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
  setMoveLen, setMoveMode, setMoveEdge, moveRows, addDatum, removeDatum, setDatumField, setAnchor, anchorVertex, vertexOptions,
  comboOptions, setClassification, validation, saveBlockers, saveEnabled, saveDecision, planSave, afterSaveDoc,
  deleteConfirmMessage, libraryRows, defaultFitDimsFor, fitDimFieldsFor, tryFit, previewPrimitivesOf, labelOptions, pushHistory,
  displayLen, strokeLabel, strokeTitle, moveSpanLabel, distanceButtonLabel, offsetButtonLabel, fitDimButtonLabel,
  libraryMetaLabel, wallThicknessNotice,
  loadDxf, setDxfUnit, toggleDxfComponent, setDxfProvenanceField, dxfComponentRows, dxfUnitHint, dxfWarningTexts,
  dxfPreviewPrimitives, draftFromDxf, draftDocOf, provenanceNoticeOf, DETAIL_HELPER_TABS, setProvenanceField,
} from './detailHelperForm.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { isPdfBytes } from '../detail/pdf/pdfImport.js';
import {
  loadPdf, setPdfPage, stepPdfPage, setPdfPageView, setPdfScale, setPdfClip, setPdfClipField, pdfClipText, pageSizeOf,
  pointToPage, clipFromDrag, clipOverlayStyle, pdfCanExtract, pdfCanCopy, extractPdf, pdfWarningTexts, describePdfReject,
} from './detailHelperPdf.js';
import { DXF_PROVENANCE_FIELDS, PdfReject, PDF_MAX_BYTES, PDF_SIGNATURE_SCAN_BYTES, PDF_PREVIEW_SCALE } from '../core/constants.js';
import { ERR_DXF_FILE_READ_FAILED, ERR_PDF_PAGE_FAILED } from '../error.js';

/**
 * 部分詳細図ヘルパー（全画面パネル）。ペン入力で一筆書きの図を描き、基準・寸法を指定して
 * ライブラリ（カタログ種別 detailFigure の user 層）へ保存・削除する。グラフは読まない・書かない。
 * 判断（フォーム操作・検証・保存可否・文言）は ui/detailHelperForm.js に持ち、ここは配線だけ。
 * 保存・削除は CatalogMaintenancePanel と同じ共通経路（planSaveEntry/planRemoveUserEntry → applyCatalogEditPlan）を
 * runBusy('カタログ適用', …) の中で呼ぶ。
 */
const KIND = CatalogKind.DETAIL_FIGURE;
// 旧い pdfjs 文書の破棄（待たない。破棄の失敗で画面の操作を止めない）。
const discardPdfDoc = (loader, doc) => { if (doc) loader?.closePdf(doc).catch(() => undefined); };
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

// DXF の sha256（ブラウザの SubtleCrypto）。
// 使えない環境（http など）では reject し、loadDxf が NO_DIGEST の警告で読込みを続ける。
const sha256OfBytes = bytes => sha256HexWith(globalThis.crypto?.subtle)(bytes);

/** 読込み結果の共通部分（警告・連結成分の一覧・出所欄・下書きへ写す）。DXF と PDF で共用。配線だけ。 */
function ImportResult({ state, warnings, busy, canCopy, onToggle, onField, onCopy }) {
  const rows = state.scene ? dxfComponentRows(state) : [];
  return (
    <>
      {warnings.length > 0 && (
        <ul className="dthlp-dxf-warn" aria-label={DETAIL_HELPER_TEXT.dxfWarnings}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
      {state.scene && (
        <>
          <div className="dthlp-block-head"><span>{DETAIL_HELPER_TEXT.dxfComponents}</span></div>
          <div className="dthlp-dxf-comps">
            {rows.length === 0 && <div className="dthlp-empty">{DETAIL_HELPER_TEXT.dxfNoComponents}</div>}
            {rows.map(r => (
              <div key={r.index} className={`dthlp-dxf-comp${r.selected ? ' dthlp-dxf-comp--selected' : ''}`} onClick={() => onToggle(r.index)}>
                <span>{`${r.label}・${r.detail}`}</span>
                {r.warningItems.length > 0 && (
                  <ul className="dthlp-dxf-warn">{r.warningItems.map((w, i) => <li key={i} className={w.red ? 'dthlp-dxf-warn--red' : undefined}>{w.text}</li>)}</ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="dthlp-block">
        <div className="dthlp-block-head"><span>{DETAIL_HELPER_TEXT.dxfProvenance}</span></div>
        <label className="dthlp-row">{DETAIL_HELPER_TEXT.dxfMaker}
          <input className="dthlp-input" value={state.maker} onChange={e => onField(DXF_PROVENANCE_FIELDS.MAKER, e.target.value)} />
        </label>
        <label className="dthlp-row">{DETAIL_HELPER_TEXT.dxfSeries}
          <input className="dthlp-input" value={state.series} onChange={e => onField(DXF_PROVENANCE_FIELDS.SERIES, e.target.value)} />
        </label>
        <label className="dthlp-row">{DETAIL_HELPER_TEXT.dxfLicense}
          <input className="dthlp-input" value={state.licenseNote} onChange={e => onField(DXF_PROVENANCE_FIELDS.LICENSE_NOTE, e.target.value)} />
        </label>
      </div>
      <button className="dthlp-btn dthlp-btn--primary" disabled={busy || !canCopy} onClick={onCopy}>{DETAIL_HELPER_TEXT.dxfCopy}</button>
    </>
  );
}

/** 左ペインの「図面読込み」タブ（DXF）。配線だけ（判断は detailHelperForm.js）。 */
function DxfPane({ dxf, message, busy, onOpen, onUnit, onToggle, onField, onCopy }) {
  return (
    <div className="dthlp-dxf">
      <button className="dthlp-btn" disabled={busy} onClick={onOpen}>{DETAIL_HELPER_TEXT.dxfOpen}</button>
      {message && <div className={message.isError ? 'dthlp-error' : 'dthlp-ok'}>{message.text}</div>}
      {dxf && (
        <>
          <div className="dthlp-dxf-file">{dxf.fileName}（{dxf.encoding}）</div>
          <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onUnit}>
            {DETAIL_HELPER_TEXT.dxfUnit}: {displayLen(dxf.unitText)}（{dxfUnitHint(dxf)}）
          </button>
          <ImportResult state={dxf} warnings={dxfWarningTexts(dxf)} busy={busy} canCopy={dxf.selected.length > 0} onToggle={onToggle} onField={onField} onCopy={onCopy} />
        </>
      )}
    </div>
  );
}

/**
 * 左ペインの「図面読込み」タブ（PDF）。ページ選定（番号・前後）→ ページ画像（canvas。表示専用）の上で矩形を 1 回ドラッグ
 * （数値欄と同期）→ 縮尺 → 「抽出」→ 連結成分。配線だけ（判断は detailHelperPdf.js）。
 */
function PdfPane({ pdf, message, busy, onOpen, onPrev, onNext, onPageNumpad, onScale, onClipField, onClipDrag, onExtract, onToggle, onField, onCopy, renderPage, onView, onRenderError }) {
  const canvasRef = useRef(null);
  const dragFrom = useRef(null);
  useEffect(() => {
    let cancelled = false;
    renderPage(canvasRef.current, pdf.page)
      .then(r => { if (!cancelled) onView(r.view); })
      .catch(e => { if (!cancelled) onRenderError(e); });
    return () => { cancelled = true; };
  }, [pdf.loadId, pdf.page]); // eslint-disable-line react-hooks/exhaustive-deps -- ページ（と読み直し）が変わったときだけ描く。コールバックは毎回作り直されるため依存に入れない
  const size = pageSizeOf(pdf.view);
  const overlay = clipOverlayStyle(pdf.clip, size);
  const pointOf = e => pointToPage(e, e.currentTarget.getBoundingClientRect(), size);
  return (
    <div className="dthlp-dxf">
      <button className="dthlp-btn" disabled={busy} onClick={onOpen}>{DETAIL_HELPER_TEXT.dxfOpen}</button>
      {message && <div className={message.isError ? 'dthlp-error' : 'dthlp-ok'}>{message.text}</div>}
      <div className="dthlp-dxf-file">{pdf.fileName}</div>
      <div className="dthlp-row">
        <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onPrev}>{DETAIL_HELPER_TEXT.pdfPrev}</button>
        <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onPageNumpad}>{DETAIL_HELPER_TEXT.pdfPage}: {pdf.page}</button>
        <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onNext}>{DETAIL_HELPER_TEXT.pdfNext}</button>
        <span>{DETAIL_HELPER_TEXT.pdfPageCount(pdf.pageCount)}</span>
      </div>
      <div className="dthlp-pdf-page"
        onPointerDown={e => { if (!size || busy) return; e.currentTarget.setPointerCapture(e.pointerId); dragFrom.current = pointOf(e); }}
        onPointerMove={e => { if (dragFrom.current && size) onClipDrag(clipFromDrag(dragFrom.current, pointOf(e))); }}
        onPointerUp={() => { dragFrom.current = null; }}
        onPointerCancel={() => { dragFrom.current = null; }}>
        <canvas ref={canvasRef} className="dthlp-pdf-canvas" />
        {overlay && <div className="dthlp-pdf-clip" style={overlay} />}
      </div>
      <div className="dthlp-dxf-file">{size ? DETAIL_HELPER_TEXT.pdfDragHint : DETAIL_HELPER_TEXT.pdfNoPage}</div>
      <div className="dthlp-block-head"><span>{DETAIL_HELPER_TEXT.pdfClip}</span></div>
      <div className="dthlp-row">
        {Object.entries(DETAIL_HELPER_TEXT.pdfClipFields).map(([field, label]) => (
          <button key={field} className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={() => onClipField(field)}>
            {label}: {displayLen(pdfClipText(pdf.clip, field))}
          </button>
        ))}
      </div>
      <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onScale}>{DETAIL_HELPER_TEXT.pdfScale}: {displayLen(pdf.scaleText)}</button>
      <button className="dthlp-btn dthlp-btn--primary" disabled={busy || !pdfCanExtract(pdf)} onClick={onExtract}>{DETAIL_HELPER_TEXT.pdfExtract}</button>
      <ImportResult state={pdf} warnings={pdfWarningTexts(pdf)} busy={busy} canCopy={pdfCanCopy(pdf)} onToggle={onToggle} onField={onField} onCopy={onCopy} />
    </div>
  );
}

export function DetailHelperPanel({ onClose }) {
  const [doc, setDoc] = useState(freshDoc);
  const [leftTab, setLeftTab] = useState(DETAIL_HELPER_TABS.PEN);
  const [dxf, setDxf] = useState(null);
  const [pdf, setPdf] = useState(null); // PDF 読込みの状態（DXF と排他。dxf を読むと null）
  const [dxfMessage, setDxfMessage] = useState(null); // { text, isError }（DXF・PDF 共通）
  const dxfInputRef = useRef(null);
  const pdfDocRef = useRef(null);    // pdfjs の文書（状態に入れない）
  const pdfLoaderRef = useRef(null); // ui/pdfLoader.js（初回の PDF を開くときに動的 import）
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
  // 閉じるとき pdfjs の文書（worker 側の資源）を解放する。
  useEffect(() => () => { discardPdfDoc(pdfLoaderRef.current, pdfDocRef.current); pdfDocRef.current = null; }, []);

  const fitDims = useMemo(
    () => ({ ...defaultFitDimsFor(form, previewWallThicknessFor(null, materialList)), ...fitOverrides }),
    [materialList, fitOverrides, form],
  );
  const fitFields = fitDimFieldsFor(form);
  // 部屋の取り合いの材束縛を解く材マップ（材コード→材。材の一覧が読めるまでは null＝材束縛の図は UNRESOLVED_MATERIAL）
  const materialMap = useMemo(() => (materialList ? new Map(materialList.map(m => [m.code, m])) : null), [materialList]);
  const fitted = useMemo(() => (fitOn ? tryFit(form, fitDims, { materialMap }) : null), [fitOn, form, fitDims, materialMap]);
  const primitives = useMemo(() => previewPrimitivesOf(form, fitted), [form, fitted]);
  const showDxf = leftTab === DETAIL_HELPER_TABS.DXF;
  const imported = pdf ?? dxf;
  const dxfPrims = useMemo(() => (imported?.scene ? dxfPreviewPrimitives(imported) : []), [imported]);
  const shownPrims = showDxf ? dxfPrims : primitives;
  const provenanceNotice = provenanceNoticeOf(form);
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
    else if (target.kind === 'dxfUnit') {
      const r = setDxfUnit(dxf, value);
      setDxf(r.dxf);
      setDxfMessage(r.error ? { text: r.error, isError: true } : null);
    } else if (target.kind === 'pdfPage') applyPdfResult(setPdfPage(pdf, value));
    else if (target.kind === 'pdfScale') { setPdf(setPdfScale(pdf, value)); setDxfMessage(null); }
    else if (target.kind === 'pdfClip') applyPdfResult(setPdfClipField(pdf, target.field, value));
  }
  // { pdf, error } を状態へ反映する（エラーは握って画面に出す）。
  function applyPdfResult(r) {
    setPdf(r.pdf);
    setDxfMessage(r.error ? { text: r.error, isError: true } : null);
  }

  // PDF を開く（pdfjs は初回だけ動的 import。読み込めなければ「部品を起動できません」）。
  async function loadPdfFile(bytes, fileName) {
    try {
      pdfLoaderRef.current ??= await import('./pdfLoader.js');
    } catch {
      return { ok: false, message: describePdfReject({ code: PdfReject.WORKER_UNAVAILABLE }) };
    }
    const { openPdf, closePdf } = pdfLoaderRef.current;
    return loadPdf({ bytes, fileName, digest: sha256OfBytes, open: openPdf, close: closePdf });
  }

  // DXF・PDF を読む。外部ファイルなので accept は付けない（iOS の Files は未登録拡張子を accept に含むと全ファイルをグレーアウトする）。
  // 種別は内容で判定（先頭が %PDF- なら PDF、それ以外は DXF）。読込み〜解析は runBusy の中（await をまたぐ UI 入口）。失敗は握って画面に出す。
  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
      const result = await runBusy('図面読込み', async () => {
        // 先頭だけ読んで内容判定し、PDF の大きさの上限は全体を読む前に見る。
        const isPdf = isPdfBytes(new Uint8Array(await file.slice(0, PDF_SIGNATURE_SCAN_BYTES).arrayBuffer()));
        if (isPdf && file.size > PDF_MAX_BYTES) return { ok: false, message: describePdfReject({ code: PdfReject.SIZE_LIMIT }) };
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isPdf) return loadPdfFile(bytes, file.name);
        return loadDxf({ bytes, fileName: file.name, digest: sha256OfBytes });
      });
      if (!result.ok) setDxfMessage({ text: result.message, isError: true });
      else {
        setDxfMessage(null);
        discardPdfDoc(pdfLoaderRef.current, pdfDocRef.current);
        if (result.pdf) { pdfDocRef.current = result.doc; setDxf(null); setPdf(result.pdf); }
        else { pdfDocRef.current = null; setPdf(null); setDxf(result.dxf); }
      }
    } catch {
      setDxfMessage({ text: ERR_DXF_FILE_READ_FAILED, isError: true });
    } finally {
      setBusy(false);
    }
  }
  // 選んだページの演算子列を読み、範囲の成分を作る（runBusy の中。失敗は握って画面に出す）。
  async function handlePdfExtract() {
    if (busy || !pdf || !pdfCanExtract(pdf)) return;
    setBusy(true);
    try {
      const r = await runBusy('図面読込み', async () => {
        const pageData = await pdfLoaderRef.current.readPdfPage(pdfDocRef.current, pdf.page);
        return extractPdf(pdf, pageData);
      });
      applyPdfResult(r);
    } catch (err) {
      setDxfMessage({ text: ERR_PDF_PAGE_FAILED(err instanceof Error ? err.message : String(err)), isError: true });
    } finally {
      setBusy(false);
    }
  }
  // 選んだ成分を新規下書きへ写す（未保存の下書きがあれば破棄の確認を通す）。DXF・PDF 共通。
  function handleDxfCopy() {
    const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart });
    if (r.error) { setDxfMessage({ text: r.error, isError: true }); return; }
    guardDiscard(() => {
      replaceDoc(draftDocOf(r.form));
      setLeftTab(DETAIL_HELPER_TABS.PEN);
      setDxfMessage(null);
    });
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
      message: deleteConfirmMessage({ label: prevEntry.label, used: used.has(prevEntry.key), dirty, entry: prevEntry }),
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
          <div className="dthlp-tabs">
            <button className={`dthlp-btn${showDxf ? '' : ' dthlp-btn--active'}`} onClick={() => setLeftTab(DETAIL_HELPER_TABS.PEN)}>{DETAIL_HELPER_TEXT.tabPen}</button>
            <button className={`dthlp-btn${showDxf ? ' dthlp-btn--active' : ''}`} onClick={() => setLeftTab(DETAIL_HELPER_TABS.DXF)}>{DETAIL_HELPER_TEXT.tabDxf}</button>
          </div>
          {showDxf && pdf && (
            <PdfPane
              pdf={pdf} message={dxfMessage} busy={busy}
              onOpen={() => dxfInputRef.current?.click()}
              onPrev={() => applyPdfResult(stepPdfPage(pdf, -1))}
              onNext={() => applyPdfResult(stepPdfPage(pdf, 1))}
              onPageNumpad={() => openNumpad({ kind: 'pdfPage' }, String(pdf.page), DETAIL_HELPER_TEXT.pdfPage)}
              onScale={() => openNumpad({ kind: 'pdfScale' }, pdf.scaleText, DETAIL_HELPER_TEXT.pdfScale)}
              onClipField={field => openNumpad({ kind: 'pdfClip', field }, pdfClipText(pdf.clip, field), DETAIL_HELPER_TEXT.pdfClipFields[field])}
              onClipDrag={clip => setPdf(p => setPdfClip(p, clip))}
              onExtract={handlePdfExtract}
              onToggle={index => setPdf(p => toggleDxfComponent(p, index))}
              onField={(field, value) => setPdf(p => setDxfProvenanceField(p, field, value))}
              onCopy={handleDxfCopy}
              renderPage={(canvas, pageNo) => pdfLoaderRef.current.renderPdfPage(pdfDocRef.current, pageNo, canvas, PDF_PREVIEW_SCALE)}
              onView={view => setPdf(p => setPdfPageView(p, view))}
              onRenderError={err => setDxfMessage({ text: ERR_PDF_PAGE_FAILED(err instanceof Error ? err.message : String(err)), isError: true })}
            />
          )}
          {showDxf && !pdf && (
            <DxfPane
              dxf={dxf} message={dxfMessage} busy={busy}
              onOpen={() => dxfInputRef.current?.click()}
              onUnit={() => openNumpad({ kind: 'dxfUnit' }, dxf.unitText, DETAIL_HELPER_TEXT.dxfUnit)}
              onToggle={index => setDxf(d => toggleDxfComponent(d, index))}
              onField={(field, value) => setDxf(d => setDxfProvenanceField(d, field, value))}
              onCopy={handleDxfCopy}
            />
          )}
          {!showDxf && (<>
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
                    <button
                      className={`dthlp-btn dthlp-btn--small${m.edge === DetailEdgeMark.AIR ? ' dthlp-btn--active' : ''}`}
                      aria-pressed={m.edge === DetailEdgeMark.AIR}
                      onClick={() => edit(f => setMoveEdge(f, m.editKey, m.edge === DetailEdgeMark.AIR ? null : DetailEdgeMark.AIR))}
                    >
                      {DETAIL_HELPER_TEXT.airEdge}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          </>)}
        </section>

        {/* 中央: プレビューと試し込み */}
        <section className="dthlp-pane dthlp-center">
          {!showDxf && <div className="dthlp-toolbar">
            <button className={`dthlp-btn${fitOn ? '' : ' dthlp-btn--active'}`} onClick={() => setFitOn(false)}>{DETAIL_HELPER_TEXT.fitOff}</button>
            <button className={`dthlp-btn${fitOn ? ' dthlp-btn--active' : ''}`} onClick={() => setFitOn(true)}>{DETAIL_HELPER_TEXT.fitOn}</button>
            {fitOn && fitFields.map(({ field, label }) => (
              <button key={field} className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'fit', field }, fitDims[field], label)}>
                {fitDimButtonLabel(label, fitDims[field])}
              </button>
            ))}
          </div>}
          {!showDxf && fitOn && wallNotice && <div className="dthlp-error">{wallNotice}</div>}
          {!showDxf && fitted?.error && <div className="dthlp-error">{fitted.error.message}</div>}
          <div className="dthlp-preview">
            {shownPrims.length === 0 ? (
              <div className="dthlp-empty">{showDxf ? DETAIL_HELPER_TEXT.dxfEmptyPreview : DETAIL_HELPER_MESSAGES.emptyPreview}</div>
            ) : (
              <AutoScaledFigure
                primitives={shownPrims}
                maxWidth={PREVIEW_FRAME_PX.width}
                maxHeight={PREVIEW_FRAME_PX.height}
                onEditDim={showDxf || fitOn ? undefined : (dim, v) => edit(f => setMoveLen(f, dim.editKey, String(v)))}
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

          {provenanceNotice && (
            <div className="dthlp-block dthlp-provenance">
              <div>{provenanceNotice}</div>
              {[
                [DXF_PROVENANCE_FIELDS.MAKER, DETAIL_HELPER_TEXT.dxfMaker],
                [DXF_PROVENANCE_FIELDS.SERIES, DETAIL_HELPER_TEXT.dxfSeries],
                [DXF_PROVENANCE_FIELDS.LICENSE_NOTE, DETAIL_HELPER_TEXT.dxfLicense],
              ].map(([field, label]) => (
                <label key={field} className="dthlp-row">{label}
                  <input className="dthlp-input" value={form.extra.provenance[field] ?? ''}
                    onChange={e => edit(f => setProvenanceField(f, field, e.target.value), { track: false })} />
                </label>
              ))}
            </div>
          )}

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

      {/* DXF 選択（hidden）。accept は付けない: iOS の Files は OS に未登録の拡張子を accept に含むと全ファイルを選べなくなる。
          選別は読込み後の内容判定（dxfDecode／dxfTokenize）で行う。 */}
      <input ref={dxfInputRef} type="file" style={{ display: 'none' }} onChange={handleImportFile} />
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
