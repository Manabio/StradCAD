import { observer } from 'mobx-react-lite';

const FIELD_DEFS = [
  { key: 'floorMaterial',     label: '仕上げ',   group: '床',   groupSpan: 1 },
  { key: 'baseboardMaterial', label: '仕上げ',   group: '巾木', groupSpan: 2 },
  { key: 'baseboardHeight',   label: 'H',        group: null,   groupSpan: 0 },
  { key: 'wallMaterial',      label: '壁',       group: '壁',   groupSpan: 3 },
  { key: 'dadoMaterial',      label: '腰仕上げ', group: null,   groupSpan: 0 },
  { key: 'dadoHeight',        label: '腰H',      group: null,   groupSpan: 0 },
  { key: 'ceilingMaterial',   label: '仕上げ',   group: '天井', groupSpan: 3 },
  { key: 'ceilingHeight',     label: 'H',        group: null,   groupSpan: 0 },
  { key: 'cornice',           label: '周り縁',   group: null,   groupSpan: 0 },
  { key: 'note',              label: '備考',     group: '備考', groupSpan: 1 },
];

const cellBase = {
  border: '1px solid #cbd5e1',
  padding: '4px 8px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

const headerCell = {
  ...cellBase,
  background: '#f1f5f9',
  fontWeight: 600,
  textAlign: 'center',
  color: '#374151',
};

export const FinishTable = observer(({ graph, selectedRoomId, onSelectRoom, floorName }) => {
  const rooms = graph.rooms;

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={headerCell} rowSpan={2}>階</th>
            <th style={headerCell} rowSpan={2}>室名</th>
            {/* グループヘッダー */}
            {FIELD_DEFS.filter(f => f.group !== null).map(f => (
              <th key={`gh-${f.key}`} colSpan={f.groupSpan} style={headerCell}>{f.group}</th>
            ))}
          </tr>
          <tr>
            {FIELD_DEFS.map(f => (
              <th key={`sh-${f.key}`} style={headerCell}>{f.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rooms.length === 0 && (
            <tr>
              <td colSpan={FIELD_DEFS.length + 2} style={{ ...cellBase, textAlign: 'center', color: '#94a3b8', padding: 20 }}>
                部屋が登録されていません
              </td>
            </tr>
          )}
          {rooms.map(room => {
            const isSelected = room.id === selectedRoomId;
            const rowStyle = {
              background: isSelected ? '#eff6ff' : '#fff',
              cursor: 'pointer',
              outline: isSelected ? '2px solid #2563eb' : 'none',
              outlineOffset: -2,
            };
            return (
              <tr key={room.id} style={rowStyle} onClick={() => onSelectRoom(room.id)}>
                <td style={{ ...cellBase, textAlign: 'center', color: '#64748b' }}>{floorName}</td>
                <td style={{ ...cellBase, fontWeight: isSelected ? 700 : 400 }}>{room.name || '（名称未設定）'}</td>
                {FIELD_DEFS.map(f => (
                  <td key={f.key} style={cellBase}>
                    <FinishCell room={room} fieldKey={f.key} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

const FinishCell = observer(({ room, fieldKey }) => {
  const value = room.finish[fieldKey];
  return (
    <input
      value={value}
      onChange={e => room.finish.setField(fieldKey, e.target.value)}
      onClick={e => e.stopPropagation()}
      style={{
        width: '100%',
        minWidth: 60,
        border: 'none',
        outline: 'none',
        background: 'transparent',
        fontSize: 12,
        padding: 0,
      }}
    />
  );
});
