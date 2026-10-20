import { useEffect, useRef, useState } from 'react';
import './AddCLDialog.css';
import { floorSettingsRows, sectionDiagramModel, layoutSectionDiagram } from '../floorHeights.js';
import { trapFocusIndex, shouldConfirmOnEnter } from './floorSettingsKeys.js';

const INVALID_STYLE = { borderColor: '#dc2626', background: '#fef2f2' };
const CELL = { padding: '3px 6px', fontSize: 12, whiteSpace: 'nowrap' };

function formatMm(v) {
  return String(Math.round(v * 10) / 10);
}

/** 簡易断面図（表示専用）。layoutSectionDiagram の結果を描くだけ。選択中の階の FL 線・階高寸法は青。 */
function SectionDiagram({ layout, selectedPlaneId }) {
  const SEL = '#1e40af';
  return (
    <svg
      data-section-diagram
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{ flex: '1 1 200px', minWidth: 180, maxWidth: 280, height: 'auto', alignSelf: 'flex-start' }}
      role="img"
      aria-label="簡易断面図"
    >
      {layout.lines.map(l => {
        const sel = selectedPlaneId != null && l.planeIds.includes(selectedPlaneId);
        const color = sel ? SEL : (l.kind === 'gl' ? '#92400e' : '#334155');
        return (
          <g key={l.key}>
            <line x1={l.x1} x2={l.x2} y1={l.y} y2={l.y} stroke={color} strokeWidth={l.kind === 'fl' ? 1 : 1.6} strokeDasharray={l.kind === 'gl' ? '5 3' : undefined} />
            <text x={l.x1 - 4} y={l.y + 3.5} fontSize={10} textAnchor="end" fill={color}>{l.label}</text>
          </g>
        );
      })}
      {layout.dims.map(d => {
        const sel = d.planeId != null && d.planeId === selectedPlaneId;
        const color = sel ? SEL : '#475569';
        return (
          <g key={d.key}>
            <line x1={d.x} x2={d.x} y1={d.y1} y2={d.y2} stroke={color} strokeWidth={1} />
            <line x1={d.x - 3} x2={d.x + 3} y1={d.y1} y2={d.y1} stroke={color} strokeWidth={1} />
            <line x1={d.x - 3} x2={d.x + 3} y1={d.y2} y2={d.y2} stroke={color} strokeWidth={1} />
            <text x={d.x + 5} y={d.yMid + 3.5} fontSize={10} fill={color}>{d.text}</text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 階設定表ダイアログ（階高＋GL）。上＝上階の順に 階名／階高(入力)／nFL(GL+mm・自動) を並べ、最下行に GL(1FLからの下がり)を置く。
 * 入力中の値は draft（編集した行・GL だけ）に持ち、表示と検査は floorSettingsRows（floorHeights.js・純）に任せる。
 * 確定は onConfirm(draft)（App.jsx が computeFloorHeightEdit で再検査して反映）、キャンセルは破棄。
 * モーダル: 背景の押下は何もしない（編集中の値を不意に捨てない）。ダイアログ外のキー入力（Ctrl+Z 等）は後段へ渡さない。
 *
 * planes        : 採用階（project.planes。elevation 昇順）
 * topHeightMm   : 現在の最上階の階高
 * glBelow1FlMm  : 現在の GL（1FL からの下がり量）
 * selectedPlaneId : 開いたとき選択状態にする階（長押しした位置の階）
 */
export function FloorSettingsDialog({ planes, topHeightMm, glBelow1FlMm, selectedPlaneId, onConfirm, onCancel }) {
  const [draft, setDraft] = useState({ heights: {}, glBelow1FlMm: undefined });
  const dialogRef = useRef(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; });

  const view = floorSettingsRows(planes, draft, topHeightMm, glBelow1FlMm);
  const diagram = layoutSectionDiagram(sectionDiagramModel(planes, view));

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
    setDraft(d => ({ ...d, heights: { ...d.heights, [id]: text } }));
  }
  function setGl(text) {
    setDraft(d => ({ ...d, glBelow1FlMm: text }));
  }
  function handleConfirm() {
    if (!view.ok) return;
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#64748b' }}>
              <th style={{ ...CELL, textAlign: 'left', fontWeight: 600 }}>階</th>
              <th style={{ ...CELL, textAlign: 'right', fontWeight: 600 }}>階高 (mm)</th>
              <th style={{ ...CELL, textAlign: 'right', fontWeight: 600 }}>nFL (GL+mm)</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map(r => (
              <tr key={r.id} data-floor-id={r.id} style={r.id === selectedPlaneId ? { background: '#eff6ff' } : undefined}>
                <td style={{ ...CELL, color: r.id === selectedPlaneId ? '#1e40af' : '#334155', fontWeight: r.id === selectedPlaneId ? 700 : 500 }}>
                  {r.name}
                </td>
                <td style={{ ...CELL, textAlign: 'right' }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    className="cl-dialog-input"
                    style={r.invalid ? INVALID_STYLE : undefined}
                    value={r.heightText}
                    title={r.error ?? (r.isTop ? '最上階FL〜軒桁上端' : undefined)}
                    aria-invalid={r.invalid || undefined}
                    autoFocus={r.id === selectedPlaneId}
                    onFocus={e => e.target.select()}
                    onChange={e => setHeight(r.id, e.target.value)}
                  />
                </td>
                <td style={{ ...CELL, textAlign: 'right', color: '#475569' }}>{formatMm(r.nFlMm)}</td>
              </tr>
            ))}
            <tr data-gl-row style={{ borderTop: '1px solid #e2e8f0' }}>
              <td style={{ ...CELL, color: '#334155', fontWeight: 600 }}>GL</td>
              <td style={{ ...CELL, textAlign: 'right' }}>
                <input
                  type="text"
                  className="cl-dialog-input"
                  style={view.gl.invalid ? INVALID_STYLE : undefined}
                  value={view.gl.text}
                  title={view.gl.error ?? '1FLからの下がり寸法（負＝GLが1FLより上）'}
                  aria-invalid={view.gl.invalid || undefined}
                  onFocus={e => e.target.select()}
                  onChange={e => setGl(e.target.value)}
                />
              </td>
              <td style={{ ...CELL, textAlign: 'right', color: '#94a3b8' }}>0</td>
            </tr>
          </tbody>
        </table>
        <SectionDiagram layout={diagram} selectedPlaneId={selectedPlaneId} />
        </div>
        <div className="cl-dialog-result">
          軒高（GL〜軒桁上端）: {view.eaveFromGlMm === null ? '-' : `${formatMm(view.eaveFromGlMm)} mm`}
        </div>
        {/* 「最高の軒の高さ」は S8 でここに足す */}
        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>キャンセル</button>
          <button
            className="cl-dialog-btn cl-dialog-btn--ok"
            disabled={!view.ok}
            style={view.ok ? undefined : { opacity: 0.4, cursor: 'not-allowed' }}
            onClick={handleConfirm}
          >OK</button>
        </div>
      </div>
    </>
  );
}
