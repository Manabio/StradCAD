import { observer } from 'mobx-react-lite';
import { ModePanel } from '../ui/ModePanel.jsx';
import { BottomSheet } from '../ui/BottomSheet.jsx';
import { MaterialSelect } from '../finish/FinishTable.jsx';
import { withFinishUndo } from '../finish/finishUndo.js';
import { interiorRows, stairRows, selectionSummary, ceilingWriteTargetRoom } from './ceilingPanelRows.js';

// 天伏モードの専用パネル（仕上げ表とは独立。仕上げ表との共有はデータと純モジュール＋材選択の部品 MaterialSelect だけ）。
// パネルは App から渡る graph prop を使う（mode に graph を持たせない。階切替で古い graph を抱える穴を作らないため）。
// 部屋の無い階段の行（kind==='stair'）は行タップの選択対象外（タップしても selectRoom を呼ばない）。
// ただしキャンバスのドラッグ選択（S2）で選ばれたときは強調する（selectedRoomId === row.id）。
// タブ列の上に選択中のセルの要約を1行出す（selectionSummary）。
// 要約の下に、選択中のセル群の天井材・仕上げの MaterialSelect を2つ出す（S3）。「仕上げは部屋に1つ」なので
// 書込み先は常に部屋の customOverrides（ceilingPanel／ceilingFinish。ceilingWriteTargetRoom が所属から解く）。
// 部屋の無い階段なら disabled の「—」。undo は仕上げ表の master 欄と同じ withFinishUndo（欄単位で1エントリ）。
// 表の天井材・仕上げは読むだけ（略称表示）、CH は読むだけ（天井区画は S5）。行の組み立ては ceilingPanelRows.js。

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

// 天井材・仕上げの欄（選択中のセル群の書込み先の部屋へ。空は clearOverride＝既定へ復帰）
const CeilingMaterialFields = observer(({ graph, mode, room }) => {
  const info = room ? room.getFinishInfo() : null;
  const fields = [
    { key: 'ceilingPanel',  label: '天井材', category: 'panel' },
    { key: 'ceilingFinish', label: '仕上げ', category: 'finish' },
  ];
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 10px', borderBottom: '1px solid #e2e8f0', background: '#fafafa', flexShrink: 0 }}>
      {fields.map(f => (
        <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, fontSize: 12, color: '#374151' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{f.label}：</span>
          {room ? (
            <MaterialSelect
              mode={mode}
              category={f.category}
              value={info[f.key]}
              onChange={v => withFinishUndo(graph, () => (v === '' ? room.clearOverride(f.key) : room.setOverride(f.key, v)))}
              style={{ flex: 1, minWidth: 0 }}
            />
          ) : (
            <select disabled value="" style={{ flex: 1, minWidth: 0 }} title="部屋の無い階段には天井材・仕上げを指定できません">
              <option value="">—</option>
            </select>
          )}
        </label>
      ))}
    </div>
  );
});

export const CeilingPanel = observer(({ graph, mode, isLandscape }) => {
  const rows = mode.activeTab === 'stair' ? stairRows(graph, mode.materialMap) : interiorRows(graph, mode.materialMap);
  const summary = selectionSummary(graph, mode.selection);
  const inner = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {summary && (
        <div style={{ padding: '6px 10px', fontSize: 12, color: '#1e3a8a', background: '#eff6ff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
          選択中: {summary.name}／{summary.cellCount}セル／CH {dash(summary.ch)}
        </div>
      )}
      {mode.selection && (
        <CeilingMaterialFields graph={graph} mode={mode} room={ceilingWriteTargetRoom(graph, mode.selection)} />
      )}
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
                    background: row.id === mode.selectedRoomId ? '#eff6ff' : '#fff',
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
