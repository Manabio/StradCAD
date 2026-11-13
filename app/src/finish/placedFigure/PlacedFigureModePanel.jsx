import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { ModePanel } from '../../ui/ModePanel.jsx';
import { BottomSheet } from '../../ui/BottomSheet.jsx';
import { NumPad } from '../../ui/NumPad.jsx';
import { evalNumpadExpr } from '../../ui/numpadUtils.js';
import { PLACED_FIGURE_TAB_TEXT, PLACED_FIGURE_MODE_PANEL_TEXT } from '../../error.js';
import { detailFigureCatalog } from '../../openings/openingCatalog.js';
import { FigureRow, lineStyle, linkButtonStyle, pickBarStyle, placingBarStyle, hintStyle } from './PlacedFigureTab.jsx';
import { placeableFigureCandidates, placedFigureRows } from './placedFigureModePanelRows.js';
import { placedFigureRoomNameLookup } from './placedFigureRooms.js';

// 図面モード（姿図配置モード）の汎用パネル。定義表 PLACED_FIGURE_MODES の 1 行から立った PlacedFigureModeState に付く（モードごとに足さない）。
// 見出しは定義表の表示名（mode.def.label）。置ける図は mode.def.subjects の分類の配置図だけ。行の UI は仕上げタブの FigureRow と共用し、
// 製品情報（図の product）・部屋（配置点から都度引く）・向きを extra で足す。製品情報は表示だけ（編集は部分詳細図ヘルパー）。
// 判断（候補・行のデータ・部屋名）は純モジュール（placedFigureModePanelRows.js・placedFigureRooms.js）。
export const PlacedFigureModePanel = observer(({ graph, mode, isLandscape }) => {
  const [pickKey, setPickKey] = useState('');
  const [pad, setPad] = useState(null); // NumPad を出している欄 { id, field, label, text } | null

  // パネルを離れたら配置待ちを解く
  useEffect(() => () => mode.cancelFigurePlacement(), [mode]);

  const candidates = placeableFigureCandidates(detailFigureCatalog(), mode.def.subjects);
  const effectiveKey = candidates.some(c => c.key === pickKey) ? pickKey : (candidates[0]?.key ?? '');
  const placed = new Map(mode.placedFiguresInMode().map(pf => [pf.id, pf]));
  const rows = placedFigureRows([...placed.values()], mode.figureOf, placedFigureRoomNameLookup(graph));

  function confirmPad() {
    const v = evalNumpadExpr(pad.text, { positiveOnly: false });
    if (Number.isFinite(v)) mode.updatePlacedFigure(pad.id, { [pad.field]: v });
    setPad(null);
  }

  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={pickBarStyle}>
        {candidates.length === 0 ? (
          <span style={hintStyle}>{PLACED_FIGURE_TAB_TEXT.registerHint}</span>
        ) : (
          <>
            <select value={effectiveKey} onChange={e => setPickKey(e.target.value)} style={{ fontSize: 12, flex: 1 }}>
              {candidates.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
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
      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows.map(row => (
          <FigureRow
            key={row.id}
            graph={graph}
            mode={mode}
            pf={placed.get(row.id)}
            entry={null}
            onPad={setPad}
            title={row.title}
            extra={(
              <>
                {row.productLines.map(l => <div key={l.label} style={lineStyle}>{l.label} {l.value}</div>)}
                <div style={lineStyle}>{PLACED_FIGURE_MODE_PANEL_TEXT.room} {row.roomName ?? PLACED_FIGURE_MODE_PANEL_TEXT.noRoom}</div>
                <div style={lineStyle}>{PLACED_FIGURE_MODE_PANEL_TEXT.direction} {row.rotationDeg}°{row.mirror ? ` ${PLACED_FIGURE_TAB_TEXT.mirror}` : ''}</div>
              </>
            )}
          />
        ))}
      </div>
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
  return isLandscape
    ? <ModePanel title={mode.def.label} raiseSignal={mode.selectedPlacedFigureId}>{inner}</ModePanel>
    : <BottomSheet title={mode.def.label} raiseSignal={mode.selectedPlacedFigureId}>{inner}</BottomSheet>;
});
