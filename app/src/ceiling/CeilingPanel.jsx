import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { interiorRows, stairRows } from './ceilingPanelRows.js';

// 天伏モードの専用パネル（仕上げ表とは独立。仕上げ表との共有はデータと純モジュールだけ）。
// パネルは App から渡る graph prop を使う（mode に graph を持たせない。階切替で古い graph を抱える穴を作らないため）。
// 部屋の無い階段の行（kind==='stair'）は選択対象外（タップしても selectRoom を呼ばず、強調もしない）。
// S1a' は読むだけ（天井材の編集は S3、天井区画は S5）。行の組み立ては ceilingPanelRows.js。

const TABS = [
  { id: 'interior', label: '内部' },
  { id: 'stair',    label: '階段' },
];

const COLUMNS = [
  { key: 'name',          label: '部屋名' },
  { key: 'ceilingBoard',  label: '天井材' },
  { key: 'ceilingFinish', label: '仕上げ' },
  { key: 'ch',            label: 'CH' },
];

const cellStyle = { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid #e2e8f0', textAlign: 'left' };

const dash = (v) => (v == null || v === '' ? '—' : v);

export const CeilingPanel = observer(({ graph, mode, isLandscape }) => {
  const rows = mode.activeTab === 'stair' ? stairRows(graph) : interiorRows(graph);
  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => mode.setActiveTab(tab.id)}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: mode.activeTab === tab.id ? 700 : 400,
              color: mode.activeTab === tab.id ? '#2563eb' : '#64748b',
              background: 'none',
              border: 'none',
              borderBottom: mode.activeTab === tab.id ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: '#64748b' }}>
            {mode.activeTab === 'stair' ? '階段はありません。' : '部屋はありません。'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {COLUMNS.map(c => (
                  <th key={c.key} style={{ ...cellStyle, fontWeight: 700, color: '#475569', background: '#f8fafc' }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  onClick={() => { if (row.kind === 'room') mode.selectRoom(row.id); }}
                  style={{
                    cursor: row.kind === 'room' ? 'pointer' : 'default',
                    background: row.kind === 'room' && row.id === mode.selectedRoomId ? '#eff6ff' : '#fff',
                  }}
                >
                  {COLUMNS.map(c => (
                    <td key={c.key} style={cellStyle}>{c.key === 'name' ? row.name : dash(row[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
  return isLandscape
    ? <ModePanel title="天伏" raiseSignal={mode.selectedRoomId}>{inner}</ModePanel>
    : <BottomSheet title="天伏" raiseSignal={mode.selectedRoomId}>{inner}</BottomSheet>;
});
