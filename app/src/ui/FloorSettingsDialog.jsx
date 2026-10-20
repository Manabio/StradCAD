import { useEffect, useRef, useState } from 'react';
import './AddCLDialog.css';
import { floorSettingsRows, sectionDiagramModel, layoutFloorSettingsFigure, computeFloorHeightEdit, maxEaveHeightMm } from '../floorHeights.js';
import { NumPad } from './NumPad.jsx';
import { stairRiserChangesForEdit, riserChangeLine } from '../finish/stair/stairRiserFollow.js';
import { trapFocusIndex, shouldConfirmOnEnter, resolvePadText } from './floorSettingsKeys.js';

const INVALID_STYLE = { borderColor: '#dc2626', background: '#fef2f2' };
const SEL = '#1e40af';
const SCROLL_STYLE = { maxHeight: '60vh', overflowY: 'auto', overflowX: 'auto' };

/**
 * 階設定表の図（表示部）。layoutFloorSettingsFigure の結果を 1:1 px で描くだけ。選択中の階の FL 線・階高寸法は青。
 * 入力欄（階高・GL）は呼び出し側が input 枠へ絶対配置で重ねる。
 */
function FigureSvg({ figure, selectedPlaneId }) {
  return (
    <svg data-floor-figure width={figure.width} height={figure.height} style={{ display: 'block' }} role="img" aria-label="階設定表の図">
      {figure.lines.map(l => {
        const sel = selectedPlaneId != null && l.planeIds.includes(selectedPlaneId);
        const color = sel ? SEL : '#334155'; // GL も他のレベル線と同じ色・太さ・実線（2026-10-20 指示）
        return (
          <g key={l.key} data-level-line={l.kind}>
            <line x1={l.x1} x2={l.x2} y1={l.y} y2={l.y} stroke={color} strokeWidth={1} />
            <text x={l.labelX} y={l.labelY} fontSize={11} textAnchor="end" fill={color}>{l.label}</text>
            <polygon points={l.marker.points.map(p => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={1} />
          </g>
        );
      })}
      {figure.rightDims.map(d => {
        const sel = d.planeId != null && d.planeId === selectedPlaneId;
        const color = sel ? SEL : '#475569';
        return (
          <g key={d.key}>
            {!d.solo && <line x1={d.x} x2={d.x} y1={d.y1} y2={d.y2} stroke={color} strokeWidth={1} />}
            {!d.solo && <line x1={d.x - 3} x2={d.x + 3} y1={d.y1} y2={d.y1} stroke={color} strokeWidth={1} />}
            {!d.solo && <line x1={d.x - 3} x2={d.x + 3} y1={d.y2} y2={d.y2} stroke={color} strokeWidth={1} />}
            {!d.input && <text x={d.textX} y={d.yMid + 4} fontSize={11} textAnchor="middle" fill={color}>{d.text}</text>}
          </g>
        );
      })}
      {figure.leftDim && (
        <g data-max-eave>
          <line x1={figure.leftDim.x} x2={figure.leftDim.x} y1={figure.leftDim.y1} y2={figure.leftDim.y2} stroke="#475569" strokeWidth={1} />
          <line x1={figure.leftDim.x - 3} x2={figure.leftDim.x + 3} y1={figure.leftDim.y1} y2={figure.leftDim.y1} stroke="#475569" strokeWidth={1} />
          <line x1={figure.leftDim.x - 3} x2={figure.leftDim.x + 3} y1={figure.leftDim.y2} y2={figure.leftDim.y2} stroke="#475569" strokeWidth={1} />
          <text x={figure.leftDim.textX} y={figure.leftDim.labelY} fontSize={11} textAnchor="end" fill="#475569">最高軒高</text>
          <text x={figure.leftDim.textX} y={figure.leftDim.valueY} fontSize={11} textAnchor="end" fill="#475569">{figure.leftDim.text}</text>
        </g>
      )}
    </svg>
  );
}

/**
 * 階設定表ダイアログ（階高＋GL）。図だけで編集する: 水平のレベル線（軒桁上端・nFL・GL。▽の先端が線に乗る）、右の寸法鎖＝各階高・GL〜1FL の入力欄、
 * 左の寸法＝最高軒高（自動・入力なし）。階が多いときは図の部分だけスクロールする。欄にフォーカスすると NumPad を出す（物理キーボードも可）。
 * 入力中の値は draft（編集した行・GL だけ）に持ち、表示と検査は floorSettingsRows（floorHeights.js・純）に任せる。
 * 確定は onConfirm(draft)（App.jsx が computeFloorHeightEdit で再検査して反映）、キャンセルは破棄。
 * モーダル: 背景の押下は何もしない（編集中の値を不意に捨てない）。ダイアログ外のキー入力（Ctrl+Z 等）は後段へ渡さない。
 *
 * planes        : 採用階（project.planes。elevation 昇順）
 * topHeightMm   : 現在の最上階の階高
 * glBelow1FlMm  : 現在の GL（1FL からの下がり量）
 * selectedPlaneId : 開いたとき選択状態にする階（長押しした位置の階）
 * stairItems    : 全採用階の階段の要約（floorSettingsFacts.js。開くときに集める）。OK を押したとき蹴上が変わる階段があれば
 *                 確定の前にこのダイアログの中で「蹴上 ○→○」の一覧を出して確認を取る（はい→onConfirm／いいえ→表に戻る）。
 *                 確認は関門（runBusy）の外＝onConfirm の前に済ませる（関門の中でユーザーの回答を待たない）。
 * leanToPlaneIds: 下屋のある採用階の id（最高の軒の高さの計算用）
 */
export function FloorSettingsDialog({ planes, topHeightMm, glBelow1FlMm, selectedPlaneId, stairItems = [], leanToPlaneIds = [], onConfirm, onCancel: closeDialog }) {
  const [draft, setDraft] = useState({ heights: {}, glBelow1FlMm: undefined });
  const [numpadFor, setNumpadFor] = useState(null); // NumPad を出している欄（{kind:'height',id}|{kind:'gl'}|null）
  const padRestoreRef = useRef(false); // NumPad 操作後の focus 戻しの間は onFocus の全選択・パッド再設定を飛ばす
  const [pendingRisers, setPendingRisers] = useState(null); // 確認待ちの蹴上の変化一覧（null＝確認中でない）
  // Escape・キャンセル: 確認中は「いいえ」と同じく表に戻すだけ。確認中でなければダイアログを閉じる。
  const onCancel = () => (pendingRisers ? setPendingRisers(null) : closeDialog());
  const dialogRef = useRef(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });

  const view = floorSettingsRows(planes, draft, topHeightMm, glBelow1FlMm);
  const maxEave = maxEaveHeightMm(planes, view, leanToPlaneIds);
  const figure = layoutFloorSettingsFigure(sectionDiagramModel(planes, view), { maxEaveMm: maxEave });

  // ダイアログ内のフォーカス可能な要素（Tab の循環と、外から呼び戻すときの先頭）
  function focusables() {
    return [...(dialogRef.current?.querySelectorAll('input:not([disabled]), button:not([disabled])') ?? [])];
  }
  function moveFocus(shift) {
    const list = focusables();
    const i = trapFocusIndex(list.length, list.indexOf(document.activeElement), shift);
    if (i >= 0) list[i].focus();
  }

  // ダイアログの外にフォーカスがあっても、キー入力を後段へ渡さず既定動作（Enter/Space で背景のボタンを押す等）も
  // 起こさない。Escape はキャンセル、Tab はフォーカスをダイアログ内へ呼び戻す（外へ出さない）。
  useEffect(() => {
    const guard = (e) => {
      if (dialogRef.current?.contains(e.target)) return; // 中の入力は下の onKeyDown が扱う
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === 'Escape') { cancelRef.current(); return; }
      if (e.key === 'Tab') moveFocus(e.shiftKey);
    };
    window.addEventListener('keydown', guard, true);
    return () => window.removeEventListener('keydown', guard, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function setHeight(id, text) {
    setPendingRisers(null); // 値を変えたら確認はやり直し
    setDraft(d => ({ ...d, heights: { ...d.heights, [id]: text } }));
  }
  function setGl(text) {
    setPendingRisers(null);
    setDraft(d => ({ ...d, glBelow1FlMm: text }));
  }
  // NumPad の対象欄の現在の文字列・ラベル（表示は view＝欄の表示と同じ値）
  const padRow = numpadFor?.kind === 'height' ? view.rows.find(r => r.id === numpadFor.id) : null;
  const padValue = numpadFor?.kind === 'gl' ? view.gl.text : (padRow?.heightText ?? '');
  const padLabel = numpadFor?.kind === 'gl' ? 'GL' : (padRow?.name ?? '');
  function setPadValue(text) {
    if (numpadFor?.kind === 'gl') setGl(text);
    else if (numpadFor?.kind === 'height') setHeight(numpadFor.id, text);
  }
  // NumPad のキーは押した時点でフォーカスを奪うので、対象の欄へ戻す（物理キーボード・Enter を続けて使える）。
  // ポインタ押下の既定のフォーカス移動より後に戻すため setTimeout。戻す間は onFocus の全選択をしない。
  function refocusPadField(target) {
    setTimeout(() => {
      const el = target.kind === 'gl'
        ? dialogRef.current?.querySelector('[data-gl-input]')
        : dialogRef.current?.querySelector(`[data-floor-id="${target.id}"]`);
      if (!el) return;
      padRestoreRef.current = true;
      el.focus();
      padRestoreRef.current = false;
    }, 0);
  }
  function onPadChange(text) {
    setPadValue(text);
    refocusPadField(numpadFor);
  }
  // ✕: 閉じて欄へフォーカスを戻す（フォーカスが残ったままだと同じ欄の再タップで focus が来ず開けない）
  function cancelNumpad() {
    setNumpadFor(null);
    refocusPadField(numpadFor);
  }
  // ✓: 式（3000*2 等）が整数に評価できれば値にし、パッドを閉じる。次の欄へは移らない
  function closeNumpad() {
    setPadValue(resolvePadText(padValue));
    setNumpadFor(null);
    refocusPadField(numpadFor);
  }
  function handleConfirm() {
    if (!view.ok) return;
    const edit = computeFloorHeightEdit(planes, draft, topHeightMm, glBelow1FlMm);
    const risers = stairRiserChangesForEdit(stairItems, planes, edit.updates);
    if (risers.length > 0) { setPendingRisers(risers); return; }
    onConfirm(draft);
  }
  function handleKeyDown(e) {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME の変換確定の Enter 等では何もしない
    if (e.key === 'Tab') { e.preventDefault(); moveFocus(e.shiftKey); return; } // フォーカスはダイアログ内で循環
    if (shouldConfirmOnEnter({ key: e.key, tagName: e.target.tagName })) handleConfirm();
    if (e.key === 'Escape') onCancel();
  }

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={e => e.stopPropagation()} />
      <div className="cl-dialog" ref={dialogRef} onKeyDown={handleKeyDown} style={{ minWidth: 340 }}>
        <div className="cl-dialog-title">階設定表</div>
        <div data-figure-scroll style={SCROLL_STYLE}>
          <div style={{ position: 'relative', width: figure.width, height: figure.height }}>
            <FigureSvg figure={figure} selectedPlaneId={selectedPlaneId} />
            {figure.rightDims.filter(d => d.input).map(d => {
              const isGl = d.input.kind === 'gl';
              const row = isGl ? null : view.rows.find(r => r.id === d.input.id);
              const invalid = isGl ? view.gl.invalid : row?.invalid;
              const error = isGl ? view.gl.error : row?.error;
              return (
                <input
                  key={d.key}
                  {...(isGl ? { 'data-gl-input': true } : { 'data-floor-id': d.input.id })}
                  type="text"
                  inputMode="none"
                  className="cl-dialog-input"
                  style={{ position: 'absolute', left: d.input.x, top: d.input.y, width: d.input.w, height: d.input.h, boxSizing: 'border-box', textAlign: 'right', ...(invalid ? INVALID_STYLE : null) }}
                  value={isGl ? view.gl.text : (row?.heightText ?? '')}
                  title={error ?? (isGl ? '1FLからの下がり寸法（負＝GLが1FLより上）' : (row?.isTop ? '最上階FL〜軒桁上端' : undefined))}
                  aria-invalid={invalid || undefined}
                  autoFocus={!isGl && d.input.id === selectedPlaneId}
                  onFocus={e => { if (padRestoreRef.current) return; e.target.select(); setNumpadFor(isGl ? { kind: 'gl' } : { kind: 'height', id: d.input.id }); }}
                  onPointerDown={() => { if (!numpadFor) setNumpadFor(isGl ? { kind: 'gl' } : { kind: 'height', id: d.input.id }); }}
                  onChange={e => (isGl ? setGl(e.target.value) : setHeight(d.input.id, e.target.value))}
                />
              );
            })}
          </div>
        </div>
        {pendingRisers && (
          <div data-riser-confirm style={{ marginTop: 8, padding: 8, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 4, fontSize: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>階高の変更で次の階段の蹴上が変わります。よろしいですか？</div>
            {pendingRisers.map(c => (
              <div key={c.key} data-riser-line>{riserChangeLine(c)}{c.explicit ? '（指定値を書き換え）' : ''}</div>
            ))}
          </div>
        )}
        {pendingRisers ? (
          <div className="cl-dialog-actions">
            <button className="cl-dialog-btn cl-dialog-btn--cancel" autoFocus onClick={() => setPendingRisers(null)}>いいえ</button>
            <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={() => onConfirm(draft)}>はい</button>
          </div>
        ) : (
          <div className="cl-dialog-actions">
            <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>キャンセル</button>
            <button
              className="cl-dialog-btn cl-dialog-btn--ok"
              disabled={!view.ok}
              style={view.ok ? undefined : { opacity: 0.4, cursor: 'not-allowed' }}
              onClick={handleConfirm}
            >OK</button>
          </div>
        )}
      </div>
      {numpadFor && (
        <NumPad
          key={numpadFor.kind === 'gl' ? 'gl' : numpadFor.id}
          value={padValue}
          label={padLabel}
          onChange={onPadChange}
          onConfirm={closeNumpad}
          onCancel={cancelNumpad}
          selectOnStart
        />
      )}
    </>
  );
}
