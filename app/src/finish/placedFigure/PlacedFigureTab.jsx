import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { NumPad } from '../../ui/NumPad.jsx';
import { useScrollIntoViewWhenActive } from '../../ui/useScrollIntoViewWhenActive.js';
import { evalNumpadExpr } from '../../ui/numpadUtils.js';
import { PLACED_FIGURE_TAB_TEXT } from '../../error.js';
import { canHaveDetailViews } from '../../detail/detailModel.js';
import { detailFigureCatalog } from '../../openings/openingCatalog.js';
import { beginFieldUndo, endFieldUndo } from '../finishUndo.js';

const rowStyle = {
  display: 'flex', flexDirection: 'column', gap: 8,
  padding: '6px 10px', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', fontSize: 12,
};
export const lineStyle = { display: 'flex', alignItems: 'center', gap: 8 };
export const linkButtonStyle = { background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#2563eb' };
const valueButtonStyle = { fontSize: 12, textAlign: 'right', cursor: 'pointer' };
// 図の選択＋［配置］の帯・配置待ちの帯・候補が無いときの案内。図面モードの汎用パネルと共用（値を二重に持たない）。
export const pickBarStyle = { ...lineStyle, padding: '6px 10px', borderBottom: '1px solid #e2e8f0' };
export const placingBarStyle = { ...lineStyle, padding: '6px 10px', background: '#eff6ff', color: '#2563eb' };
export const hintStyle = { color: '#94a3b8' };

// 仕上げパレットの「衛生・家具・空調」タブ — 姿図（部分詳細図の平面の配置図）を平面に置く・直す・選ぶ・消す。
// 配置は［配置］で配置待ちにして平面をタップ（FinishModeState.startDrag が置く）。置いた後の位置は X・Y を NumPad で直す。
// finish/equipment/EquipmentTab.jsx と同じ型（一覧＋選択で平面の配置を選ぶ）。文言は error.js の PLACED_FIGURE_TAB_TEXT。
// FigureRow は図面モードの汎用パネル（PlacedFigureModePanel.jsx）も使う。title（見出しの差し替え）・extra（見出しの下の追加表示。
// 渡すと既定の「回転角・鏡像」の表示は出さない＝extra 側が向きを持つ）。positionAction は位置の行（X・Y・高さ）の末尾に描く追加操作。
// 3 つとも渡さなければ仕上げタブの描画のまま。
export const FigureRow = observer(({ graph, mode, pf, entry, onPad, title, extra, positionAction }) => {
  const selected = pf.id === mode.selectedPlacedFigureId;
  const ref = useScrollIntoViewWhenActive(selected);
  const stop = e => e.stopPropagation();
  const valueButton = (field, label) => (
    <button
      onClick={e => { stop(e); onPad({ id: pf.id, field, label, text: String(pf[field]) }); }}
      style={valueButtonStyle}
    >
      {label} {pf[field]}
    </button>
  );
  return (
    <div
      ref={ref}
      onClick={() => mode.selectPlacedFigure(pf.id)}
      style={{
        ...rowStyle,
        border: selected ? '1px solid #2563eb' : '1px solid transparent',
        background: selected ? '#eff6ff' : '#fff',
      }}
    >
      <div style={lineStyle}>
        <span style={{ fontWeight: 700, flex: 1 }}>{title ?? (entry?.label || pf.figureKey)}</span>
        <button onClick={e => { stop(e); mode.rotatePlacedFigure(pf.id); }} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.rotate}</button>
        <button onClick={e => { stop(e); mode.togglePlacedFigureMirror(pf.id); }} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.mirror}</button>
        <button
          onClick={e => { stop(e); mode.removePlacedFigure(pf.id); }}
          style={{ ...linkButtonStyle, color: '#dc2626' }}
        >
          {PLACED_FIGURE_TAB_TEXT.remove}
        </button>
      </div>
      {extra}
      <div style={lineStyle}>
        {valueButton('x', PLACED_FIGURE_TAB_TEXT.x)}
        {valueButton('y', PLACED_FIGURE_TAB_TEXT.y)}
        {valueButton('zMm', PLACED_FIGURE_TAB_TEXT.height)}
        {extra == null && <span style={{ color: '#64748b' }}>{pf.rotationDeg}°{pf.mirror ? ` ${PLACED_FIGURE_TAB_TEXT.mirror}` : ''}</span>}
        {positionAction}
      </div>
      <input
        type="text"
        value={pf.note}
        placeholder={PLACED_FIGURE_TAB_TEXT.note}
        onClick={stop}
        onChange={e => mode.setPlacedFigureNote(pf.id, e.target.value)}
        onFocus={() => beginFieldUndo(graph)}
        onBlur={() => endFieldUndo(graph)}
        style={{ fontSize: 12 }}
      />
    </div>
  );
});

export const PlacedFigureTab = observer(({ graph, mode }) => {
  const [pickKey, setPickKey] = useState('');
  const [pad, setPad] = useState(null); // NumPad を出している欄 { id, field, label, text } | null

  // タブを離れたら配置待ちを解く
  useEffect(() => () => mode.cancelFigurePlacement(), [mode]);

  const catalog = detailFigureCatalog();
  const candidates = [...catalog].filter(([, entry]) => canHaveDetailViews(entry));
  const effectiveKey = candidates.some(([key]) => key === pickKey) ? pickKey : (candidates[0]?.[0] ?? '');

  function confirmPad() {
    const v = evalNumpadExpr(pad.text, { positiveOnly: false });
    if (Number.isFinite(v)) mode.updatePlacedFigure(pad.id, { [pad.field]: v });
    setPad(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={pickBarStyle}>
        {candidates.length === 0 ? (
          <span style={hintStyle}>{PLACED_FIGURE_TAB_TEXT.registerHint}</span>
        ) : (
          <>
            <select value={effectiveKey} onChange={e => setPickKey(e.target.value)} style={{ fontSize: 12, flex: 1 }}>
              {candidates.map(([key, entry]) => <option key={key} value={key}>{entry.label || key}</option>)}
            </select>
            <button onClick={() => mode.beginFigurePlacement(effectiveKey)} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.place}</button>
          </>
        )}
      </div>
      {mode.placingFigureKey && (
        <div style={placingBarStyle}>
          <span style={{ flex: 1 }}>{PLACED_FIGURE_TAB_TEXT.tapPoint}</span>
          <button onClick={() => mode.cancelFigurePlacement()} style={linkButtonStyle}>{PLACED_FIGURE_TAB_TEXT.cancel}</button>
        </div>
      )}
      {graph.placedFigures.map(pf => (
        <FigureRow key={pf.id} graph={graph} mode={mode} pf={pf} entry={catalog.get(pf.figureKey) ?? null} onPad={setPad} />
      ))}
      {pad && (
        <NumPad
          key={`${pad.id}:${pad.field}`}
          value={pad.text}
          label={pad.label}
          onChange={text => setPad(p => ({ ...p, text }))}
          onConfirm={confirmPad}
          onCancel={() => setPad(null)}
          selectOnStart
        />
      )}
    </div>
  );
});
