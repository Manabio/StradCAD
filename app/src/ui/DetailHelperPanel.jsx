import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './DetailHelperPanel.css';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { overlayFor, docDiffMap } from '../catalog/catalogRegistry.js';
import { planRemoveUserEntry, applyCatalogEditPlan, FITTING_PART_ROLE_TEXT } from '../catalog/catalogMaintenance.js';
import { DetailLenMode, DetailEdgeMark, DetailCategory, DETAIL_PRODUCT_FIELD, DetailProductField } from '../core/constants.js';
import { canHaveDetailViews } from '../detail/detailModel.js';
import { detailFigureCatalog } from '../openings/openingCatalog.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
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
  newDraft, entryFromForm, freshDocOf, duplicateDoc, afterDeleteDoc, clearPenError, docContextFor, undoDraft, penStep, penUp, setClosed, setDashRole, DETAIL_DASH_LABELS,
  setMoveLen, setMoveMode, setMoveEdge, rebaseOrigin, rebaseDelta, moveRows, addDatum, removeDatum, setDatumField, setAnchor, anchorVertex, vertexOptions,
  comboOptions, setClassification, validation, saveBlockers, saveEnabled, saveDecision, planSave, afterSaveDoc,
  deleteConfirmMessage, defaultFitDimsFor, fitDimFieldsFor, tryFit, previewPrimitivesOf, labelOptions, pushHistory,
  displayLen, strokeLabel, strokeTitle, moveSpanLabel, distanceButtonLabel, offsetButtonLabel, fitDimButtonLabel,
  libraryMetaLabel, wallThicknessNotice, DETAIL_PLACEMENT_VIEW_LABELS, placementViewOptions, setPlacementView, setProductField,
  helperLibraryRows, libraryOriginOf, libraryRowActions, libraryEntryOf, planRevert, unlockDoc, LIBRARY_ORIGIN,
  loadDxf, setDxfUnit, toggleDxfLayer, setDxfLayers, dxfLayerRows, toggleDxfComponent, setDxfProvenanceField, dxfComponentRows, dxfUnitHint, dxfWarningTexts,
  dxfPreviewPrimitives, draftFromDxf, draftDocOf, provenanceNoticeOf, DETAIL_HELPER_TABS, setProvenanceField,
} from './detailHelperForm.js';
import {
  isFittingDoc, isPartlessFittingDoc, docOfLibraryEntry, fittingEntryOf, selectFittingPart, addFittingPart, removeFittingPart, setFittingLabel,
  availableFittingRoles, switchToFitting, duplicateFittingDoc, isDocDirty, afterSaveFittingDoc, fittingValidation, fittingSetErrorTexts,
  fittingPartRows, fittingSaveBlockers, setFittingProvenanceField, fittingAssemblyPrimitives, assemblyFitDims, ASSEMBLY_FIT_FORM, ASSEMBLY_VIEW, importIntoPart,
} from './detailHelperFitting.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { isPdfBytes } from '../detail/pdf/pdfImport.js';
import {
  loadPdf, setPdfPage, stepPdfPage, setPdfPageView, setPdfScale, setPdfClip, setPdfClipField, pdfClipText, pageSizeOf,
  pointToPage, clipFromDrag, clipOverlayStyle, pdfCanExtract, pdfCanCopy, extractPdf, pdfWarningTexts, describePdfReject,
} from './detailHelperPdf.js';
import {
  activePickRect, setPickRect, clearPickRect, pickedComponentRows, pickSummaryOf, figurePointToMm, pickRectFromDrag, pickOverlayStyle,
  dragKindOf, bindView, activeView, reconcileView, panDeltaPx, pinchArgsOf, wheelZoomedView,
  DETAIL_BASE_SNAP_PX, previewVertexPoints, nearestPointWithin, draftViewOfImport, previewFrameOf,
} from './detailHelperPick.js';
import { isTapDistance } from '../interaction/holdGesture.js';
import {
  FIGURE_WHEEL_ZOOM_FACTOR, viewOfTransform, transformOfView, panView, pinchView, fitViewToRect, autoScaleOfPrimitives, contentBoundsOfPrimitives, viewLimitsOf,
} from '../structural/sectionFigure/figureView.js';
import { useLongPress } from '../interaction/useLongPress.js';
import { DXF_PROVENANCE_FIELDS, PdfReject, PDF_MAX_BYTES, PDF_SIGNATURE_SCAN_BYTES, PDF_PREVIEW_SCALE } from '../core/constants.js';
import { ERR_DXF_FILE_READ_FAILED, ERR_PDF_PAGE_FAILED, DETAIL_PRODUCT_TEXT } from '../error.js';

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
const BUILTIN_KEYS = new Set(detailBuiltinFigures.map(e => e.key)); // 組込みの図（読み取り専用で出す。編集＝同キーの上書き）
const userKeysNow = () => new Set(overlayFor(KIND).user.map(e => e.key));
const newKeyPart = () => crypto.randomUUID();
const freshDoc = () => freshDocOf(newDraft({ idFactory: newKeyPart }));

const MODE_OPTIONS = labelOptions(DETAIL_MODE_LABELS);
const ROLE_OPTIONS = labelOptions(DETAIL_ROLE_LABELS);
const DASH_OPTIONS = labelOptions(DETAIL_DASH_LABELS);
const PARAM_OPTIONS = labelOptions(DETAIL_PARAM_LABELS);
const FIELD_OPTIONS = labelOptions(DETAIL_MATERIAL_FIELD_LABELS);
const KIND_OPTIONS = labelOptions(DETAIL_DATUM_KIND_LABELS);
const AXIS_OPTIONS = labelOptions(DETAIL_AXIS_LABELS);
const PLACEMENT_VIEW_OPTIONS = labelOptions(DETAIL_PLACEMENT_VIEW_LABELS);
/** 製品情報の 4 欄（DetailProductField の値と表示名。キーは error.js の DETAIL_PRODUCT_TEXT と同名）。 */
const PRODUCT_FIELD_ROWS = Object.freeze(Object.values(DetailProductField).map(field => ({ field, label: DETAIL_PRODUCT_TEXT[field] })));

function Select({ value, options, onChange, disabled, empty, title }) {
  return (
    <select className="dthlp-select" value={value ?? ''} disabled={disabled} title={title} onChange={e => onChange(e.target.value)}>
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
      <span className="dthlp-lib-meta">
        <span className={`dthlp-lib-badge${row.origin === LIBRARY_ORIGIN.OVERRIDE ? ' dthlp-lib-badge--override' : ''}`}>{row.originLabel}</span>
        {row.docDiff && <span className="dthlp-lib-badge dthlp-lib-badge--doc" title={DETAIL_HELPER_TEXT.docDiffBadgeTitle}>{DETAIL_HELPER_TEXT.docDiffBadge}</span>}
        {libraryMetaLabel(row)}
      </span>
    </button>
  );
}

// DXF の sha256（ブラウザの SubtleCrypto）。
// 使えない環境（http など）では reject し、loadDxf が NO_DIGEST の警告で読込みを続ける。
const sha256OfBytes = bytes => sha256HexWith(globalThis.crypto?.subtle)(bytes);

/** 読込み結果の共通部分（警告・連結成分の一覧・出所欄・下書きへ写す）。DXF と PDF で共用。配線だけ。 */
function ImportResult({ state, warnings, busy, canCopy, copyNotice, onToggle, onField, onCopy, onClearPick, onToggleLayer, onAllLayersOn }) {
  const rows = state.scene ? pickedComponentRows(state, dxfComponentRows(state)) : [];
  const layerRows = dxfLayerRows(state);
  const pickSummary = pickSummaryOf(state);
  return (
    <>
      {warnings.length > 0 && (
        <ul className="dthlp-dxf-warn" aria-label={DETAIL_HELPER_TEXT.dxfWarnings}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
      {state.scene && (
        <>
          {layerRows.length > 0 && (
            <>
              <div className="dthlp-block-head">
                <span>{DETAIL_HELPER_TEXT.layers}</span>
                <button className="dthlp-btn dthlp-btn--small" disabled={busy || layerRows.every(r => r.visible)} onClick={onAllLayersOn}>{DETAIL_HELPER_TEXT.layersAllOn}</button>
              </div>
              <div className="dthlp-layer-list">
                {layerRows.map(r => (
                  <label key={r.name} className="dthlp-layer-row">
                    <input type="checkbox" checked={r.visible} disabled={busy} onChange={() => onToggleLayer(r.name)} />
                    <span>{`${r.name}（${r.segmentCount}）`}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <div className="dthlp-block-head"><span>{DETAIL_HELPER_TEXT.dxfComponents}</span></div>
          <div className="dthlp-dxf-file">{DETAIL_HELPER_TEXT.pickHint}</div>
          {pickSummary && (
            <div className="dthlp-row">
              <span>{DETAIL_HELPER_TEXT.pickSummary(pickSummary.inRect, pickSummary.total, pickSummary.selected)}</span>
              <button className="dthlp-btn dthlp-btn--small" disabled={busy} onClick={onClearPick}>{DETAIL_HELPER_TEXT.pickClear}</button>
            </div>
          )}
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
      {copyNotice && <div className="dthlp-error">{copyNotice}</div>}
      <button className="dthlp-btn dthlp-btn--primary" disabled={busy || !canCopy || !!copyNotice} onClick={onCopy}>{DETAIL_HELPER_TEXT.dxfCopy}</button>
    </>
  );
}

/** 左ペインの「図面読込み」タブ（DXF）。配線だけ（判断は detailHelperForm.js）。 */
function DxfPane({ dxf, message, busy, copyNotice, onOpen, onUnit, onToggle, onField, onCopy, onClearPick, onToggleLayer, onAllLayersOn }) {
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
          <ImportResult state={dxf} warnings={dxfWarningTexts(dxf)} busy={busy} canCopy={dxf.selected.length > 0} copyNotice={copyNotice} onToggle={onToggle} onField={onField} onCopy={onCopy} onClearPick={onClearPick} onToggleLayer={onToggleLayer} onAllLayersOn={onAllLayersOn} />
        </>
      )}
    </div>
  );
}

// 要素の内寸（ResizeObserver の contentRect と同じ。padding を除く。border は clientWidth/Height に入らない）。
function contentSizeOf(el) {
  const cs = getComputedStyle(el);
  return {
    width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}

/**
 * 中央プレビューを覆うジェスチャー層（S7c-2 の矩形ドラッグ＋S7d-2 のズーム／パン）。t・info は AutoScaledFigure が描画に使った
 * 変換と全体の縮尺・図の範囲（overlay の引数）。1 本指のドラッグ＝移動、長押し後のドラッグ＝矩形（canPick のとき）、2 本指＝ピンチ、
 * ホイール＝拡大縮小。ドラッグ中は部品内の state と svg の CSS だけを動かし、親の state（＝重いプレビューの再描画）は
 * 離したとき（ホイールはフレームごと）の onView／onPick 1 回だけ。
 */
function FigureGestureLayer({ t, info, frame, view, onView, svgRef, canPick, pickRect, onPick, busy, basePointMode, vertexPoints, onBasePoint }) {
  const layerRef = useRef(null);
  const pointers = useRef(new Map()); // 押している指: pointerId → { clientX, clientY }
  const gesture = useRef(null);       // 進行中の操作（押下時の t・view・rect を持ち、終わるまでその値で計算する）
  const dragStyled = useRef(false);   // ドラッグ中の CSS（svg の transform・div の overflow）を当てているか
  const wheel = useRef({ factor: 1, clientX: 0, clientY: 0, raf: 0 });
  const latest = useRef(null);        // ホイール（ネイティブのリスナー）が読む最新の props
  const [live, setLive] = useState(null);
  const [armed, setArmed] = useState(false); // 長押しが成立して、次のドラッグは矩形になる（カーソルで知らせる）
  const longPress = useLongPress({ onFire: () => setArmed(true) });
  const longPressRef = useRef(longPress);
  useEffect(() => { longPressRef.current = longPress; });
  useLayoutEffect(() => { latest.current = { t, info, frame, view, onView, busy }; }); // 連続ホイールの次のフレームが commit 前の古い view を読まないよう layout で更新
  useEffect(() => () => longPressRef.current.abort(), []);

  // ドラッグ中の見た目は svg の CSS だけ（親の state＝重いプレビューの再描画は離したときの 1 回）。はみ出しは div で切る。
  // 全体表示では div が図の大きさ（小さい）なので、拡大の途中で切られないよう枠の大きさに広げる（冪等。move のたびに呼んでよい）。
  function beginDragStyle() {
    const svg = svgRef.current;
    if (!svg) return;
    dragStyled.current = true;
    const host = svg.parentElement;
    host.style.overflow = 'hidden';
    host.style.width = `${frame.width}px`;
    host.style.height = `${frame.height}px`;
    svg.style.transformOrigin = '0 0';
  }
  // viewNow・tNow: そのときの view と変換（div の overflow・大きさは AutoScaledFigure の描画に戻す）。
  const endDragStyle = useCallback((viewNow, tNow) => {
    const svg = svgRef.current;
    if (!svg || !dragStyled.current) return;
    const host = svg.parentElement;
    svg.style.transform = '';
    svg.style.transformOrigin = '';
    host.style.overflow = 'hidden'; // 図は枠いっぱい（fill）か view のどちらかで、はみ出しは切る
    host.style.width = `${tNow.pxWidth}px`;
    host.style.height = `${tNow.pxHeight}px`;
    dragStyled.current = false;
  }, [svgRef]);
  // AutoScaledFigure は描くたびに t を作り直すので、この効果は確定時だけでなく親が描き直すたびに走り、CSS の仮の動きを外す。
  // ドラッグ中に描き直されても move が毎回 beginDragStyle() で当て直す（translate／scale は押下からの絶対量）。
  useLayoutEffect(() => { endDragStyle(view, t); }, [t, view, endDragStyle]);

  // ホイール: React の onWheel は passive で preventDefault が効かないのでネイティブで登録し、フレームごとに 1 回だけ確定する。
  useEffect(() => {
    const el = layerRef.current;
    const w = wheel.current;
    if (!el) return undefined;
    const flush = () => {
      w.raf = 0;
      const cur = latest.current;
      const factor = w.factor;
      w.factor = 1;
      if (!cur || cur.busy) return;
      if (gesture.current) return; // 押下中（長押し待ちを含む）のホイールは無視（押下時の t・view で確定するため、途中で view を変えると古い基準で上書きされる）
      const next = wheelZoomedView({
        view: cur.view, t: cur.t, frame: cur.frame, client: w, rect: el.getBoundingClientRect(),
        factor, autoScale: cur.info.autoScale, contentBounds: cur.info.contentBounds,
      });
      if (next === null) { if (cur.view) cur.onView(null); return; }
      cur.onView(next);
    };
    const onWheel = e => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      w.factor *= e.deltaY < 0 ? FIGURE_WHEEL_ZOOM_FACTOR : 1 / FIGURE_WHEEL_ZOOM_FACTOR;
      w.clientX = e.clientX;
      w.clientY = e.clientY;
      if (!w.raf) w.raf = requestAnimationFrame(flush);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (w.raf) cancelAnimationFrame(w.raf);
      w.raf = 0;
      w.factor = 1;
    };
  }, []);

  const pxOf = (g, pt) => ({ x: (pt.clientX - g.rect.left) * g.t.pxWidth / g.rect.width, y: (pt.clientY - g.rect.top) * g.t.pxHeight / g.rect.height });
  // 2 本指の今の位置（px）。
  const fingersOf = g => g.ids.map(id => pointers.current.get(id)).map(p => (p ? pxOf(g, p) : null));
  const pinchOf = g => {
    const [p1a, p1b] = fingersOf(g);
    return p1a && p1b ? { p1a, p1b } : null;
  };
  function cancelDrag() {
    gesture.current = null;
    longPress.abort();
    setLive(null);
    setArmed(false);
    endDragStyle(view, t);
  }

  function onPointerDown(e) {
    if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
    const rect = e.currentTarget.getBoundingClientRect();
    const base = view ?? viewOfTransform(t, frame);
    const common = { rect, t, base, limits: viewLimitsOf(info.autoScale), contentBounds: info.contentBounds };
    if (pointers.current.size === 1) {
      longPress.begin(e.clientX, e.clientY);
      gesture.current = { ...common, kind: 'press', id: e.pointerId, viewed: !!view, from: { clientX: e.clientX, clientY: e.clientY, mm: figurePointToMm(e, rect, t) } };
    } else if (pointers.current.size === 2) {
      cancelDrag(); // 進行中の 1 本指の操作は捨てる
      const g = { ...common, kind: 'pinch', ids: [...pointers.current.keys()], startT: transformOfView(base, frame) };
      [g.p0a, g.p0b] = fingersOf(g);
      gesture.current = g;
      beginDragStyle();
    }
  }

  function onPointerMove(e) {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    p.clientX = e.clientX;
    p.clientY = e.clientY;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'press' && e.pointerId === g.id && longPress.move(e.clientX, e.clientY)) {
      g.kind = dragKindOf({ fired: longPress.hasFired(), canPick });
    }
    if (g.kind === 'rect' && e.pointerId === g.id) {
      setLive(clipFromDrag(g.from.mm, figurePointToMm(e, g.rect, g.t)));
    } else if (g.kind === 'pan' && g.viewed && e.pointerId === g.id) { // 全体表示のうちは動かすものが無い
      const { dx, dy } = panDeltaPx(g, e);
      beginDragStyle();
      svgRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (g.kind === 'pinch') {
      const now = pinchOf(g);
      const d0 = Math.hypot(g.p0b.x - g.p0a.x, g.p0b.y - g.p0a.y);
      if (!now || d0 <= 0) return;
      // 仮表示の倍率も確定（pinchView）と同じ範囲に収める（離した瞬間に図が跳ばない）
      const k = Math.min(g.limits.maxScale / g.base.scale, Math.max(g.limits.minScale / g.base.scale, Math.hypot(now.p1b.x - now.p1a.x, now.p1b.y - now.p1a.y) / d0));
      const mx0 = (g.p0a.x + g.p0b.x) / 2, my0 = (g.p0a.y + g.p0b.y) / 2;
      const mx1 = (now.p1a.x + now.p1b.x) / 2, my1 = (now.p1a.y + now.p1b.y) / 2;
      beginDragStyle();
      svgRef.current.style.transform = `translate(${mx1 - k * mx0}px, ${my1 - k * my0}px) scale(${k})`;
    }
  }

  // 離したときだけ親へ確定する（onView／onPick）。commit=false（取り消し）は何も確定しない。
  function onPointerEnd(e, commit) {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    p.clientX = e.clientX;
    p.clientY = e.clientY;
    const g = gesture.current;
    const mine = g && (g.id === e.pointerId || g.ids?.includes(e.pointerId));
    if (mine) {
      const pinched = g.kind === 'pinch' ? pinchOf(g) : null;
      gesture.current = null;
      longPress.abort();
      setArmed(false);
      if (!commit) { setLive(null); endDragStyle(view, t); }
      else if (g.kind === 'rect') {
        setLive(null);
        const rect = pickRectFromDrag(g.from, { clientX: e.clientX, clientY: e.clientY, mm: figurePointToMm(e, g.rect, g.t) });
        if (rect) onPick(rect);
      } else if (g.kind === 'pan' && g.viewed) {
        const { dx, dy } = panDeltaPx(g, e);
        onView(panView(g.base, dx, dy, g.contentBounds));
      } else if (g.kind === 'pinch' && pinched) {
        onView(pinchView(...pinchArgsOf(g, pinched)));
      } else if (g.kind === 'press' && basePointMode && isTapDistance(Math.hypot(e.clientX - g.from.clientX, e.clientY - g.from.clientY))) {
        // 基準点を指すモードのタップ（長押しが成立していても動かなければ同じ）。範囲外なら null を渡す。
        onBasePoint(nearestPointWithin(vertexPoints, figurePointToMm(e, g.rect, g.t), DETAIL_BASE_SNAP_PX / g.t.scale));
        endDragStyle(view, t);
      } else endDragStyle(view, t);
    }
    pointers.current.delete(e.pointerId);
  }

  const style = pickOverlayStyle(live ?? pickRect, t);
  return (
    <div className={`dthlp-pick-layer${armed && canPick ? ' dthlp-pick-layer--armed' : ''}${basePointMode ? ' dthlp-pick-layer--armed' : ''}`} ref={layerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={e => onPointerEnd(e, true)}
      onPointerCancel={e => onPointerEnd(e, false)}
      onLostPointerCapture={e => onPointerEnd(e, false)}
      onContextMenu={e => { e.preventDefault(); longPress.abort(); }}>
      {style && <div className="dthlp-pdf-clip" style={style} />}
    </div>
  );
}

/**
 * 左ペインの「図面読込み」タブ（PDF）。ページ選定（番号・前後）→ ページ画像（canvas。表示専用）の上で矩形を 1 回ドラッグ
 * （数値欄と同期）→ 縮尺 → 「抽出」→ 連結成分。配線だけ（判断は detailHelperPdf.js）。
 */
function PdfPane({ pdf, message, busy, copyNotice, onOpen, onPrev, onNext, onPageNumpad, onScale, onClipField, onClipDrag, onExtract, onToggle, onField, onCopy, onClearPick, renderPage, onView, onRenderError }) {
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
      <ImportResult state={pdf} warnings={pdfWarningTexts(pdf)} busy={busy} canCopy={pdfCanCopy(pdf)} copyNotice={copyNotice} onToggle={onToggle} onField={onField} onCopy={onCopy} onClearPick={onClearPick} />
    </div>
  );
}

export function DetailHelperPanel({ onClose }) {
  const [doc, setDoc] = useState(freshDoc);
  const [leftTab, setLeftTab] = useState(DETAIL_HELPER_TABS.PEN);
  const [dxf, setDxf] = useState(null);
  const [pdf, setPdf] = useState(null); // PDF 読込みの状態（DXF と排他。dxf を読むと null）
  const [dxfMessage, setDxfMessage] = useState(null); // { text, isError }（DXF・PDF 共通）
  const [importView, setImportView] = useState(null); // 図読込みのプレビューの view（bindView(scene, view)）
  const [draftView, setDraftView] = useState(null);   // ペン入力のプレビューの view（bindView(下書きの key, view)）
  const [basePointFor, setBasePointFor] = useState(null); // 頂点指定モードの下書きの key（null＝off。次のタップで図の頂点を基準にする）
  const [basePointMiss, setBasePointMiss] = useState(false); // 直前のタップが頂点から遠かった
  const dxfInputRef = useRef(null);
  const pdfDocRef = useRef(null);    // pdfjs の文書（状態に入れない）
  const pdfLoaderRef = useRef(null); // ui/pdfLoader.js（初回の PDF を開くときに動的 import）
  const { form, history, prevEntry, set: fittingSet, partIndex } = doc;
  const fitting = isFittingDoc(doc);
  const partless = isPartlessFittingDoc(doc); // 一式で部品が 0 個（部品の編集は受けない）
  // 一式のとき DXF／PDF の写し先は選んでいる部品（C8）。部品が無い・読み取り専用の間は写せない
  const importCopyNotice = !fitting ? null : partless ? DETAIL_HELPER_MESSAGES.fittingSelectPart : doc.readOnly ? DETAIL_HELPER_TEXT.builtinReadOnly : null;
  const [assemblyOn, setAssemblyOn] = useState(false); // 一式の中央ペイン: false＝選んでいる部品・true＝全体（C8）
  const [assemblyView, setAssemblyView] = useState(ASSEMBLY_VIEW.PLAN);
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
  const [revertConfirm, setRevertConfirm] = useState(null); // { key, alsoRealignDoc }（組込みに戻す確認）

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
  // 図の束の候補（三層合成後の詳細図。配置図のときだけ読む）
  const viewCatalog = canHaveDetailViews(form) ? [...detailFigureCatalog().values()] : null;
  // 製品情報の欄は配置図のときだけ出す（図の束と同じ頭の図）
  const showProduct = canHaveDetailViews(form);
  // 部屋の取り合いの材束縛を解く材マップ（材コード→材。材の一覧が読めるまでは null＝材束縛の図は UNRESOLVED_MATERIAL）
  const materialMap = useMemo(() => (materialList ? new Map(materialList.map(m => [m.code, m])) : null), [materialList]);
  const fitted = useMemo(() => (fitOn && !partless ? tryFit(form, fitDims, { materialMap }) : null), [fitOn, partless, form, fitDims, materialMap]);
  const primitives = useMemo(() => previewPrimitivesOf(form, fitted), [form, fitted]);
  const showDxf = leftTab === DETAIL_HELPER_TABS.DXF;
  const imported = pdf ?? dxf;
  const dxfPrims = useMemo(() => (imported?.scene ? dxfPreviewPrimitives(imported) : []), [imported]);
  // 一式の全体プレビュー（C8）。試し込みの寸法は外付け引き戸の部品と同じ欄（選んでいる部品の分類に依らない）
  const wholeOn = fitting && assemblyOn && !showDxf;
  const assemblyDims = useMemo(
    () => ({ ...assemblyFitDims(previewWallThicknessFor(null, materialList)), ...fitOverrides }),
    [materialList, fitOverrides],
  );
  const assembly = useMemo(
    () => (wholeOn ? fittingAssemblyPrimitives({ form, set: fittingSet, partIndex }, assemblyDims, { view: assemblyView }) : null),
    [wholeOn, form, fittingSet, partIndex, assemblyDims, assemblyView],
  );
  const shownPrims = showDxf ? dxfPrims : wholeOn ? assembly.primitives : primitives;
  // プレビューのズーム／パン（null＝全体）。図読込みは scene、ペン入力は下書きの key に結び付き、単位変更・再抽出・別の下書きで全体へ戻る。
  // 図読込みの鍵は読込みごとのトークン viewEpoch（単位変更・読み直しで変わり、レイヤ切替では保つ。PDF は scene）。
  // レイヤ切替で図の範囲と全体の縮尺が変わるので、残した view は reconcileView で新しい図に合わせる。
  // 一式の全体は一式のキー＋向きに結び付く（部品を切り替えても全体の view を保つ）
  const viewOwner = showDxf ? (imported?.viewEpoch ?? imported?.scene) : wholeOn ? `${fittingSet.key}:${assemblyView}` : form.key;
  // プレビューの枠＝中央ペインの描画域の内寸（ResizeObserver で測る）。測定前・0 以下の軸は既定の枠。枠が変わっても view は保ち、
  // 全体の縮尺が変わるので reconcileView が全体以下なら全体へ・範囲外なら寄せる。
  const previewRef = useRef(null);
  const [measured, setMeasured] = useState(null); // { width, height }（contentRect の内寸）
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return undefined;
    const keep = r => setMeasured(m => (m && m.width === r.width && m.height === r.height ? m : { width: r.width, height: r.height }));
    keep(contentSizeOf(el)); // 初回の描画の前に 1 回測る（既定の枠で描いてから測った枠へ跳ねない）
    const ro = new ResizeObserver(entries => keep(entries[entries.length - 1].contentRect));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame = useMemo(() => previewFrameOf(measured, PREVIEW_FRAME_PX), [measured]);
  const figureMetrics = useMemo(() => (shownPrims.length > 0
    ? { autoScale: autoScaleOfPrimitives(shownPrims, frame), contentBounds: contentBoundsOfPrimitives(shownPrims) } : null), [shownPrims, frame]);
  const keptView = activeView(showDxf ? importView : draftView, viewOwner);
  const shownView = useMemo(
    () => (keptView && figureMetrics ? reconcileView(keptView, figureMetrics.autoScale, figureMetrics.contentBounds) : null),
    [keptView, figureMetrics],
  );
  const setShownView = next => (showDxf ? setImportView(bindView(viewOwner, next)) : setDraftView(bindView(viewOwner, next)));
  const figureSvgRef = useRef(null);
  // 基準点を指す（ペン入力タブだけ。試し込み中・読み取り専用・忙しいときは使えない＝モードも解く）
  const canBasePoint = !showDxf && !wholeOn && !fitOn && !doc.readOnly && !busy && shownPrims.length > 0;
  // モードは下書きの key に結び付く（別の下書きへ移ると解ける）。使えない状態の間は off として扱う。
  const basePointMode = basePointFor === form.key && canBasePoint;
  const setBasePointMode = on => setBasePointFor(on ? form.key : null);
  const vertexPoints = useMemo(() => (basePointMode ? previewVertexPoints(shownPrims) : []), [basePointMode, shownPrims]);
  // 範囲外（p が null）は文言を出してモードを保つ（もう一度指せる。ボタンで解除）
  function handleBasePoint(p) {
    if (!p) { setBasePointMiss(true); return; }
    const point = { s: p.x, t: p.y };
    edit(f => rebaseOrigin(f, point));
    // 指した点が画面に留まるよう view の中心も図と同じ量だけ動かす（view は undo の外。受容）
    if (shownView) {
      const delta = rebaseDelta(form, point);
      setShownView({ ...shownView, cx: shownView.cx + (delta.s ?? 0), cy: shownView.cy + (delta.t ?? 0) });
    }
    setBasePointMode(false);
    setBasePointMiss(false);
  }
  const pickRectNow = showDxf ? activePickRect(imported) : null;
  const canFitRect = !busy && !!pickRectNow && shownPrims.length > 0;
  // 出所は一式では最上位（fittingSet.provenance。部品の本体は出所を持てない＝R10）を表示・編集する
  const shownProvenance = fitting ? fittingSet.provenance : form.extra?.provenance;
  const provenanceNotice = provenanceNoticeOf({ extra: { provenance: shownProvenance } });
  // 一式は一式全体を検証する（選んでいる部品の編集を含む）。部品のエラーは行のバッジ、一式全体のエラーは一覧の上へ振り分ける。
  const result = useMemo(
    () => (fittingSet ? fittingValidation({ form, set: fittingSet, partIndex }) : validation(form)),
    [form, fittingSet, partIndex],
  );
  const blockers = fitting ? fittingSaveBlockers(doc, result) : saveBlockers(form, result);
  const dirty = isDocDirty(doc);
  const partRows = fitting ? fittingPartRows(doc, result) : [];
  const setErrors = fitting ? fittingSetErrorTexts(result) : [];
  const options = comboOptions(form.category, form.view);
  // overlay は React が追跡しないモジュール状態。保存・削除の完了で setLibTick により再レンダーして毎回引き直す（一覧は小さい）。
  const libItems = helperLibraryRows({
    userEntries: overlayFor(KIND).user, builtinList: detailBuiltinFigures,
    docContext: docContextFor(KIND, { overlayFor, docDiffMap, builtinList: detailBuiltinFigures }),
  });
  // 開いている図の出所と許す操作（組込み＝読み取り専用で「編集（上書きを作る）」「複製」だけ／上書き＝「組込みに戻す」／ライブラリ＝削除）。
  const prevOrigin = prevEntry ? libraryOriginOf(prevEntry.key, { builtinKeys: BUILTIN_KEYS, userKeys: userKeysNow() }) : null;
  const rowActions = prevOrigin ? libraryRowActions(prevOrigin, prevEntry, BUILTIN_KEYS) : null;
  const readOnly = Boolean(doc.readOnly);

  function edit(fn, { track = true } = {}) {
    setDoc(d => {
      if (d.readOnly || isPartlessFittingDoc(d)) return d;
      const next = fn(d.form);
      if (next === d.form) return d;
      return clearPenError({ ...d, form: next, history: track ? pushHistory(d.history, d.form) : d.history });
    });
  }
  function replaceDoc(next) {
    setDoc(next);
    setMessage(null);
    setRevertConfirm(null);
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
      const r = d.readOnly ? null : undoDraft(d.history);
      return r ? clearPenError({ ...d, form: r.form, history: r.history }) : d;
    });
  }
  // 計算は setDoc の関数の中（現在の doc から）。エラーは doc.penError に入る。
  function handlePen(dir) {
    setDoc(d => (d.readOnly || isPartlessFittingDoc(d) ? d : penStep(d, dir, penText)));
  }

  // ---- 建具一式の部品（判断は ui/detailHelperFitting.js） ----
  // 部品を切り替えると試し込みの寸法は既定へ戻す（部品ごとの欄が違うため）。全体表示中は寸法が部品に依らないので保つ（ズームと同じ）
  const resetFitOverrides = () => { if (!wholeOn) setFitOverrides({}); };
  function handleSelectPart(index) {
    setDoc(d => clearPenError(selectFittingPart(d, index)));
    resetFitOverrides();
  }
  function handleAddPart(role) {
    if (!role || readOnly) return;
    const { error } = addFittingPart(doc, role); // エラー表示だけ今の doc で判定し、状態の更新は関数形（連打でも取りこぼさない）
    if (error) { setMessage({ text: error, isError: true }); return; }
    setDoc(d => (d.readOnly || !d.set ? d : (addFittingPart(d, role).doc ?? d)));
    resetFitOverrides();
    setMessage(null);
  }
  // 部品の削除は確認してから（部品の図が丸ごと消える）。確認を出している間の編集を取り込まないよう、実行時の doc で作り直す。
  function handleRemovePart(index) {
    if (readOnly) return;
    setConfirm({
      message: DETAIL_HELPER_TEXT.deletePartConfirm(FITTING_PART_ROLE_TEXT[doc.set.parts[index]?.role] ?? ''),
      buttons: [
        { label: DETAIL_HELPER_MESSAGES.confirmDeleteButton, value: 'ok', primary: true, danger: true },
        { label: DETAIL_HELPER_MESSAGES.cancelButton, value: 'cancel' },
      ],
      onSelect: v => { setConfirm(null); if (v === 'ok') { setDoc(d => removeFittingPart(d, index)); resetFitOverrides(); } },
    });
  }
  // 分類の「分類」select。建具一式は新規の空の下書きからだけ選べる（Q-C5b）。一式の doc の分類は変えられない。
  function handleCategory(value) {
    if (fitting) return;
    if (value !== DetailCategory.FITTING) { edit(f => setClassification(f, 'category', value), { track: false }); return; }
    const r = switchToFitting(doc, { idFactory: newKeyPart });
    if (r.error) { setMessage({ text: r.error, isError: true }); return; }
    replaceDoc(r.doc);
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
      applyDxfResult(setDxfUnit(dxf, value));
    } else if (target.kind === 'pdfPage') applyPdfResult(setPdfPage(pdf, value));
    else if (target.kind === 'pdfScale') { setPdf(setPdfScale(pdf, value)); setDxfMessage(null); }
    else if (target.kind === 'pdfClip') applyPdfResult(setPdfClipField(pdf, target.field, value));
  }
  // { dxf, error } を状態へ反映する（単位・レイヤの変更で共用）。
  function applyDxfResult(r) {
    setDxf(r.dxf);
    setDxfMessage(r.error ? { text: r.error, isError: true } : null);
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
    if (fitting) {
      // 一式: 写し先は選んでいる部品（分類は役割の分類・キーは合成キーのまま）。未保存の編集があれば破棄の確認を通す
      const into = importIntoPart(doc, r.form);
      if (into.error) { setDxfMessage({ text: into.error, isError: true }); return; }
      guardDiscard(() => {
        setDoc(into.doc);
        setAssemblyOn(false); // 写した結果（選んだ部品）はペンタブの部品表示で見せる
        const { basePoint } = r;
        setDraftView(bindView(into.doc.form.key, draftViewOfImport(shownView, basePoint)));
        setLeftTab(DETAIL_HELPER_TABS.PEN);
        setDxfMessage(null);
        setMessage(null);
      });
      return;
    }
    guardDiscard(() => {
      replaceDoc(draftDocOf(r.form));
      // 拡大した場所のまま開く: 下書きの座標は基準点 P が原点（offsetMm＝start−P）なので、view の中心から P を引く
      setDraftView(bindView(r.form.key, draftViewOfImport(shownView, r.basePoint)));
      setLeftTab(DETAIL_HELPER_TABS.PEN);
      setDxfMessage(null);
    });
  }

  function handleOpenEntry(key) {
    const userEntries = overlayFor(KIND).user;
    const entry = libraryEntryOf(key, { userEntries, builtinList: detailBuiltinFigures });
    if (!entry) return;
    const origin = libraryOriginOf(key, { builtinKeys: BUILTIN_KEYS, userKeys: userKeysNow() });
    guardDiscard(() => replaceDoc(docOfLibraryEntry(entry, origin)));
  }
  // 組込みの図の「編集（上書きを作る）」: 同キーのまま編集可にする（保存で overridesBuiltin の上書きが作られる）。
  function handleEditOverride() {
    setDoc(d => unlockDoc(d));
    setMessage(null);
    setRevertConfirm(null);
  }
  function handleRevertClick() {
    if (busy || !prevEntry || !rowActions?.canRevert) return;
    guardDiscard(() => setRevertConfirm({ key: prevEntry.key, alsoRealignDoc: true }));
  }
  // 組込みに戻す（保守パネルの標準に戻すと同じ planRevertToBuiltin → applyCatalogEditPlan を runBusy の中で）。使用中でも戻せる（組込みがあるので参照は切れない）。
  // 確認中に下書きを編集していたら（dirty）、置き換える前に破棄の確認を通す。
  function handleRevertConfirmed() {
    if (!revertConfirm || busy) return;
    guardDiscard(performRevert);
  }
  async function performRevert() {
    const { key } = revertConfirm;
    const r = planRevert(key, { builtinKeys: BUILTIN_KEYS, userKeys: userKeysNow(), alsoRealignDoc: revertConfirm.alsoRealignDoc });
    if (!r.ok) { setRevertConfirm(null); setMessage({ text: r.message, isError: true }); return; }
    setBusy(true);
    try {
      await runBusy('カタログ適用', () => applyCatalogEditPlan(KIND, r.plan, { saveFn: saveUserCatalog, markDirty }));
    } catch (e) {
      setRevertConfirm(null);
      setMessage({ text: `${DETAIL_HELPER_MESSAGES.revertFailed}${e.message}`, isError: true });
      return;
    } finally {
      setBusy(false);
    }
    setRevertConfirm(null);
    setLibTick(t => t + 1);
    const builtin = libraryEntryOf(key, { userEntries: overlayFor(KIND).user, builtinList: detailBuiltinFigures });
    setDoc(d => (d.prevEntry?.key === key && builtin ? docOfLibraryEntry(builtin, LIBRARY_ORIGIN.BUILTIN) : d));
    setMessage({ text: DETAIL_HELPER_MESSAGES.reverted, isError: false });
  }

  // 保存・削除・busy・失敗文言は CatalogMaintenancePanel.jsx の useCatalogEditActions と同型。共有化は S5 後の整理課題。
  async function handleSave() {
    if (busy) return;
    const entry = fitting ? fittingEntryOf(doc) : entryFromForm(form); // 一式は選んでいる部品の編集を書き戻した一式
    // 同梱にも同じキーがあるとき、保守パネルと同じ行状態（doc-same 等）で保存し、同梱を外して開いている文書へ即反映する。
    const plan = planSave(entry, prevEntry, docContextFor(KIND, { overlayFor, docDiffMap, builtinList: detailBuiltinFigures }));
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
    setDoc(d => (d.set ? afterSaveFittingDoc(d, entry) : afterSaveDoc(d, entry, savedForm)));
    setLibTick(t => t + 1);
    setMessage({ text: decision.message, isError: false });
  }

  async function handleDeleteClick() {
    if (busy || !prevEntry || !rowActions?.canDelete) return; // 組込み・上書きは削除できない（上書きは「組込みに戻す」）
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
    setDoc(d => (d.set ? duplicateFittingDoc(d, { idFactory: newKeyPart }) : duplicateDoc(d, { idFactory: newKeyPart })));
    setMessage(null);
    setRevertConfirm(null);
  }

  function handleKeyDown(e) {
    if (e.key !== 'Escape' || numpad || confirm || busy) return;
    e.stopPropagation();
    guardDiscard(onClose);
  }

  const rows = moveRows(form);
  const wallNotice = wallThicknessNotice(materialLoadFailed);
  const canSave = (fitting ? result.ok && blockers.length === 0 : saveEnabled(form, result)) && !busy && !readOnly;
  const inertWhenReadOnly = readOnly || undefined; // 組込みの図は編集の部品を押せなくする（edit／handlePen も doc.readOnly で弾く）
  const inertWhenNoPart = readOnly || partless || undefined; // 部品の編集（ペン・手・基準）。一式で部品 0 個のときも受けない

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
          {fitting && (
            <div className="dthlp-block dthlp-parts">
              <div className="dthlp-block-head">
                <span>{DETAIL_HELPER_TEXT.partsHeading}</span>
                <Select value="" empty={DETAIL_HELPER_TEXT.addPart} disabled={readOnly || busy}
                  options={availableFittingRoles(doc).map(role => ({ value: role, label: FITTING_PART_ROLE_TEXT[role] ?? role }))}
                  onChange={handleAddPart} />
              </div>
              {setErrors.length > 0 && <ul className="dthlp-errors">{setErrors.map((t, i) => <li key={i}>{t}</li>)}</ul>}
              {partRows.map(r => (
                <div key={r.role} className="dthlp-part">
                  <button className={`dthlp-lib-row${r.selected ? ' dthlp-lib-row--active' : ''}`} disabled={busy} onClick={() => handleSelectPart(r.index)}>
                    <span className="dthlp-lib-label">{r.roleLabel}</span>
                    <span className="dthlp-lib-meta">
                      {r.errorCount > 0 && <span className="dthlp-lib-badge dthlp-lib-badge--error">{DETAIL_HELPER_TEXT.partErrorBadge(r.errorCount)}</span>}
                      {r.classLabel}
                    </span>
                  </button>
                  <button className="dthlp-btn dthlp-btn--small" disabled={busy || readOnly} onClick={() => handleRemovePart(r.index)}>{DETAIL_HELPER_TEXT.remove}</button>
                </div>
              ))}
            </div>
          )}
          <div className="dthlp-tabs">
            <button className={`dthlp-btn${showDxf ? '' : ' dthlp-btn--active'}`} onClick={() => setLeftTab(DETAIL_HELPER_TABS.PEN)}>{DETAIL_HELPER_TEXT.tabPen}</button>
            <button className={`dthlp-btn${showDxf ? ' dthlp-btn--active' : ''}`} onClick={() => setLeftTab(DETAIL_HELPER_TABS.DXF)}>{DETAIL_HELPER_TEXT.tabDxf}</button>
          </div>
          {showDxf && pdf && (
            <PdfPane
              pdf={pdf} message={dxfMessage} busy={busy} copyNotice={importCopyNotice}
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
              onClearPick={() => setPdf(p => clearPickRect(p))}
              renderPage={(canvas, pageNo) => pdfLoaderRef.current.renderPdfPage(pdfDocRef.current, pageNo, canvas, PDF_PREVIEW_SCALE)}
              onView={view => setPdf(p => setPdfPageView(p, view))}
              onRenderError={err => setDxfMessage({ text: ERR_PDF_PAGE_FAILED(err instanceof Error ? err.message : String(err)), isError: true })}
            />
          )}
          {showDxf && !pdf && (
            <DxfPane
              dxf={dxf} message={dxfMessage} busy={busy} copyNotice={importCopyNotice}
              onOpen={() => dxfInputRef.current?.click()}
              onUnit={() => openNumpad({ kind: 'dxfUnit' }, dxf.unitText, DETAIL_HELPER_TEXT.dxfUnit)}
              onToggle={index => setDxf(d => toggleDxfComponent(d, index))}
              onField={(field, value) => setDxf(d => setDxfProvenanceField(d, field, value))}
              onCopy={handleDxfCopy}
              onClearPick={() => setDxf(d => clearPickRect(d))}
              onToggleLayer={name => applyDxfResult(toggleDxfLayer(dxf, name))}
              onAllLayersOn={() => applyDxfResult(setDxfLayers(dxf, []))}
            />
          )}
          {!showDxf && (<>
          <div className="dthlp-pen" inert={inertWhenNoPart}>
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

          <div className="dthlp-moves" inert={inertWhenNoPart}>
            {rows.map(r => (
              <div key={r.strokeId} className="dthlp-stroke">
                <div className="dthlp-stroke-head">
                  <span>{strokeTitle(r.strokeIndex, r.vertexCount)}</span>
                  <Select value={r.dashRole} options={DASH_OPTIONS} disabled={readOnly} title={DETAIL_HELPER_TEXT.lineRole} onChange={dashRole => edit(f => setDashRole(f, r.strokeId, dashRole))} />
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
          <div className="dthlp-toolbar">
            {!showDxf && fitting && (<>
              <button className={`dthlp-btn${wholeOn ? '' : ' dthlp-btn--active'}`} onClick={() => setAssemblyOn(false)}>{DETAIL_HELPER_TEXT.assemblyPart}</button>
              <button className={`dthlp-btn${wholeOn ? ' dthlp-btn--active' : ''}`} onClick={() => setAssemblyOn(true)}>{DETAIL_HELPER_TEXT.assemblyWhole}</button>
            </>)}
            {wholeOn && (<>
              <button className={`dthlp-btn${assemblyView === ASSEMBLY_VIEW.PLAN ? ' dthlp-btn--active' : ''}`} onClick={() => setAssemblyView(ASSEMBLY_VIEW.PLAN)}>{DETAIL_HELPER_TEXT.assemblyPlan}</button>
              <button className={`dthlp-btn${assemblyView === ASSEMBLY_VIEW.UP ? ' dthlp-btn--active' : ''}`} onClick={() => setAssemblyView(ASSEMBLY_VIEW.UP)}>{DETAIL_HELPER_TEXT.assemblyUp}</button>
              {fitDimFieldsFor(ASSEMBLY_FIT_FORM).map(({ field, label }) => (
                <button key={field} className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'fit', field }, assemblyDims[field], label)}>
                  {fitDimButtonLabel(label, assemblyDims[field])}
                </button>
              ))}
            </>)}
            {!showDxf && !wholeOn && (<>
              <button className={`dthlp-btn${fitOn ? '' : ' dthlp-btn--active'}`} onClick={() => setFitOn(false)}>{DETAIL_HELPER_TEXT.fitOff}</button>
              <button className={`dthlp-btn${fitOn ? ' dthlp-btn--active' : ''}`} onClick={() => { setFitOn(true); setBasePointFor(null); }}>{DETAIL_HELPER_TEXT.fitOn}</button>
              {fitOn && fitFields.map(({ field, label }) => (
                <button key={field} className="dthlp-btn dthlp-btn--small" onClick={() => openNumpad({ kind: 'fit', field }, fitDims[field], label)}>
                  {fitDimButtonLabel(label, fitDims[field])}
                </button>
              ))}
            </>)}
            <button className="dthlp-btn" disabled={busy || !shownView} onClick={() => setShownView(null)}>{DETAIL_HELPER_TEXT.viewAll}</button>
            {showDxf && (
              <button className="dthlp-btn" disabled={!canFitRect}
                onClick={() => setShownView(fitViewToRect(pickRectNow, frame, viewLimitsOf(figureMetrics.autoScale)))}>
                {DETAIL_HELPER_TEXT.viewFitRect}
              </button>
            )}
            {!showDxf && (
              <button className={`dthlp-btn${basePointMode ? ' dthlp-btn--active' : ''}`} aria-pressed={basePointMode} disabled={!basePointMode && !canBasePoint}
                onClick={() => { setBasePointMode(!basePointMode); setBasePointMiss(false); }}>
                {DETAIL_HELPER_TEXT.basePoint}
              </button>
            )}
            <span className="dthlp-hint">{showDxf ? DETAIL_HELPER_TEXT.gestureHint : DETAIL_HELPER_TEXT.gestureHintPen}</span>
            {basePointMode && <span className="dthlp-hint">{basePointMiss ? DETAIL_HELPER_TEXT.basePointMiss : DETAIL_HELPER_TEXT.basePointHint}</span>}
          </div>
          {!showDxf && (fitOn || wholeOn) && wallNotice && <div className="dthlp-error">{wallNotice}</div>}
          {!showDxf && !wholeOn && fitted?.error && <div className="dthlp-error">{fitted.error.message}</div>}
          {wholeOn && assembly.failures.map(f => <div key={f.role} className="dthlp-error">{f.text}</div>)}
          <div className="dthlp-preview" ref={previewRef}>
            {shownPrims.length === 0 ? (
              <div className="dthlp-empty">{showDxf ? DETAIL_HELPER_TEXT.dxfEmptyPreview : DETAIL_HELPER_MESSAGES.emptyPreview}</div>
            ) : (
              <AutoScaledFigure
                primitives={shownPrims}
                maxWidth={frame.width}
                maxHeight={frame.height}
                fill
                onEditDim={showDxf || wholeOn || fitOn || readOnly ? undefined : (dim, v) => edit(f => setMoveLen(f, dim.editKey, String(v)))}
                view={shownView}
                svgRef={figureSvgRef}
                overlay={(t, info) => (
                  <FigureGestureLayer t={t} info={info} frame={frame} view={shownView} onView={setShownView} svgRef={figureSvgRef}
                    canPick={showDxf && !!imported?.scene} pickRect={pickRectNow} busy={busy}
                    basePointMode={basePointMode} vertexPoints={vertexPoints} onBasePoint={handleBasePoint}
                    onPick={r => (pdf ? setPdf(p => setPickRect(p, r)) : setDxf(d => setPickRect(d, r)))} />
                )}
              />
            )}
          </div>
        </section>

        {/* 右: 分類・基準・検証・保存・ライブラリ */}
        <section className="dthlp-pane dthlp-right">
          <div className="dthlp-block" inert={inertWhenReadOnly}>
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldLabel}
              <input className="dthlp-input" value={fitting ? fittingSet.label : form.label}
                onChange={e => (fitting ? setDoc(d => (d.readOnly ? d : setFittingLabel(d, e.target.value))) : edit(f => ({ ...f, label: e.target.value }), { track: false }))} />
            </label>
            <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldCategory}
              <Select value={fitting ? fittingSet.category : form.category} options={options.categories} disabled={fitting} onChange={handleCategory} />
            </label>
            {/* 一式の分類は部品の役割で決まる（view・subject は選ばせない） */}
            {!fitting && (
              <>
                <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldView}
                  <Select value={form.view} options={options.views} onChange={v => edit(f => setClassification(f, 'view', v), { track: false })} />
                </label>
                <label className="dthlp-row">{DETAIL_HELPER_TEXT.fieldSubject}
                  <Select value={form.subject} options={options.subjects} onChange={v => edit(f => setClassification(f, 'subject', v), { track: false })} />
                </label>
              </>
            )}
            {canHaveDetailViews(form) && (
              <div>
                <span>{DETAIL_HELPER_TEXT.viewsGroup}</span>
                {PLACEMENT_VIEW_OPTIONS.map(({ value: view, label }) => (
                  <label key={view} className="dthlp-row">{label}
                    <Select value={form.views?.[view] ?? ''} options={placementViewOptions(form, viewCatalog, view)} disabled={readOnly}
                      onChange={key => edit(f => setPlacementView(f, view, key))} />
                  </label>
                ))}
              </div>
            )}
            {showProduct && (
              <div>
                <span>{DETAIL_PRODUCT_TEXT.group}</span>
                {PRODUCT_FIELD_ROWS.map(({ field, label }) => (
                  <label key={field} className="dthlp-row">{label}
                    <input className="dthlp-input" value={form[DETAIL_PRODUCT_FIELD]?.[field] ?? ''} readOnly={readOnly}
                      onChange={e => edit(f => setProductField(f, field, e.target.value), { track: false })} />
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="dthlp-block" inert={inertWhenNoPart}>
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
                  <input className="dthlp-input" value={shownProvenance[field] ?? ''}
                    onChange={e => (fitting
                      ? setDoc(d => (d.readOnly ? d : setFittingProvenanceField(d, field, e.target.value)))
                      : edit(f => setProvenanceField(f, field, e.target.value), { track: false }))} />
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
              {readOnly && <button className="dthlp-btn dthlp-btn--primary" disabled={busy} onClick={handleEditOverride}>{DETAIL_HELPER_TEXT.editOverride}</button>}
              {rowActions?.canRevert
                ? <button className="dthlp-btn" disabled={busy} onClick={handleRevertClick}>{DETAIL_HELPER_TEXT.revertToBuiltin}</button>
                : <button className="dthlp-btn" disabled={busy || !prevEntry || !rowActions?.canDelete} onClick={handleDeleteClick}>{DETAIL_HELPER_TEXT.remove}</button>}
            </div>
            {readOnly && <div className="dthlp-ok">{DETAIL_HELPER_TEXT.builtinReadOnly}</div>}
            {revertConfirm && (
              <div className="dthlp-block">
                <div>{DETAIL_HELPER_TEXT.revertTitle}</div>
                <label className="dthlp-row">
                  <input type="checkbox" checked={revertConfirm.alsoRealignDoc}
                    onChange={e => setRevertConfirm(c => ({ ...c, alsoRealignDoc: e.target.checked }))} />
                  {DETAIL_HELPER_TEXT.revertAlsoDoc}
                </label>
                <div className="dthlp-actions">
                  <button className="dthlp-btn dthlp-btn--primary" disabled={busy} onClick={handleRevertConfirmed}>{DETAIL_HELPER_TEXT.approveButton}</button>
                  <button className="dthlp-btn" disabled={busy} onClick={() => setRevertConfirm(null)}>{DETAIL_HELPER_MESSAGES.cancelButton}</button>
                </div>
              </div>
            )}
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
