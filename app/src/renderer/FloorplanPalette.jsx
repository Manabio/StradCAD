import { observer } from 'mobx-react-lite';
import { OpeningCategory } from '@core';
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';

const ROW   = { display: 'flex', justifyContent: 'space-between', padding: '9px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13 };
const LABEL = { color: '#64748b' };
const VALUE = { color: '#1e293b', fontWeight: 600 };

// 平面モードのパレット — 選択中の開口（建具・窓）の内容を表示する。
// 横長＝右端パネル（ModePanel）／縦長＝ボトムシート（BottomSheet）。
// 開口の選択は FloorplanModeState.selectedOpeningId が保持し、空白タップで解除される。
export const FloorplanPalette = observer(function FloorplanPalette({ opening, isLandscape, onClose }) {
  const isWindow = opening.category === OpeningCategory.WINDOW;
  const entry    = findCatalogEntry(opening.category, opening.subType);

  const rows = (
    <div style={{ overflowY: 'auto' }}>
      <div style={ROW}><span style={LABEL}>分類</span><span style={VALUE}>{isWindow ? '窓' : '建具'}</span></div>
      <div style={ROW}><span style={LABEL}>種別</span><span style={VALUE}>{entry?.label ?? opening.subType}</span></div>
      <div style={ROW}><span style={LABEL}>幅</span><span style={VALUE}>{Math.round(opening.width)} mm</span></div>
      <div style={ROW}><span style={LABEL}>取付方向</span><span style={VALUE}>{opening.isVertical ? '縦軸' : '横軸'}</span></div>
      <div style={ROW}><span style={LABEL}>基準オフセット</span><span style={VALUE}>{Math.round(opening.refOffset)} mm</span></div>
    </div>
  );

  return isLandscape
    ? <ModePanel title="開口" width={320} onClose={onClose}>{rows}</ModePanel>
    : <BottomSheet title="開口" initialSnap={0.4} raiseSignal={opening.id}>{rows}</BottomSheet>;
});
