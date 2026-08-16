import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { OpeningEditor } from './OpeningEditor.jsx';
import { openingGroupsOnFloor, effectiveHeight } from './openingNumbering.js';
import { findCatalogEntry } from './openingCatalog.js';

function round(v) { return Math.round(v); }

function totalCountOf(group) {
  if (!group) return 0;
  let total = 0;
  for (const n of group.counts.values()) total += n;
  return total;
}

// 建具モード突入時に自動表示されるパネル。上段＝記号別採番リスト（アクティブ階のみ・
// 採番は全階統一）、下段＝選択中建具の姿図＋フォーム（OpeningEditor）。
// StructuralPanel.jsx / StairPanel.jsx と同じシェル分岐（横長=ModePanel／縦長=BottomSheet）。
// 項目4: パネルに「×」を追加し、クリックで建具モードを脱出する（脱出先は平面モード。
// onCloseは呼び出し側=App.jsxがhandleModeChange('floorplan')を渡す）。
export const OpeningPanel = observer(function OpeningPanel({ graph, project, mode, isLandscape, onToast, onClose }) {
  const groups = openingGroupsOnFloor(graph, project);
  const selectedId = mode.selectedOpeningId;
  const selectedOpening = selectedId ? graph.shapeMap.get(selectedId) : null;

  const inner = (
    <>
      <div style={{ height: '40%', overflowY: 'auto', borderBottom: '1px solid #e2e8f0', padding: 8 }}>
        {groups.length === 0 && (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: 8 }}>この階に建具・窓はありません</div>
        )}
        {groups.map(({ tag, group, openings }) => {
          const entry = findCatalogEntry(openings[0].category, openings[0].subType);
          const w = group?.width ?? openings[0].width;
          const h = group?.height ?? effectiveHeight(openings[0]);
          const sill = group?.sillHeight;
          return (
            <div key={tag ?? openings.map(o => o.id).join(',')} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12 }}>
                <span style={{ fontWeight: 700, color: '#1e293b' }}>
                  {tag ?? '—'} {entry?.label ?? openings[0].subType} {round(w)}×{round(h)}
                  {sill != null ? `（窓台${round(sill)}）` : ''}
                </span>
                <span style={{ color: '#94a3b8' }}>
                  この階 {openings.length} / 全体 {totalCountOf(group)}
                </span>
              </div>
              {openings.map(o => (
                <div
                  key={o.id}
                  onClick={() => mode.selectOpening(o.id)}
                  style={{
                    fontSize: 12, padding: '4px 8px', marginTop: 2, cursor: 'pointer', borderRadius: 4,
                    background: o.id === selectedId ? '#eff6ff' : 'transparent',
                    color: o.id === selectedId ? '#2563eb' : '#475569',
                  }}
                >
                  {o.refCL?.label ?? '?'} {o.refOffset >= 0 ? '+' : ''}{round(o.refOffset)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <OpeningEditor graph={graph} project={project} opening={selectedOpening} mode={mode} onToast={onToast} />
    </>
  );

  return isLandscape
    ? <ModePanel title="建具" onClose={onClose}>{inner}</ModePanel>
    : <BottomSheet title="建具" initialSnap={0.5} raiseSignal={selectedId} onClose={onClose}>{inner}</BottomSheet>;
});
