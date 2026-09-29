import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ConfirmDialog } from '../../ui/ConfirmDialog.jsx';
import { RoomDeleteConfirm } from '../RoomDeleteConfirm.jsx';
import { equipmentSymbols } from './equipmentNumbering.js';
import { buildEquipmentTabEntries } from './equipmentTab.js';
import { EV_USAGE_OPTIONS, CATEGORY_LABEL } from './equipmentOptions.js';

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 10px', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', fontSize: 12,
};

// 仕上げパレットの「機械器具」タブ — 昇降機器具の一覧＋行内編集（用途・削除）。
// finish/stair/StairTab.jsx と同じ型（一覧＋選択で背後の部屋カード/器具を選ぶ）。
// 登録済み行の削除・用途変更は onDeleteEquipment/onChangeEquipmentUsage（必須props）経由——
// App.jsx の全階連動（runElevatorRemoval/runElevatorUsageChange。ステップ5）へ委ねるため、
// mode.deleteEquipment/mode.setEquipmentUsageを直接呼ばない（単階しか反映されないため）。
export const EquipmentTab = observer(({ graph, mode, floorName, onDeleteEquipment, onChangeEquipmentUsage }) => {
  const [deleteRowId, setDeleteRowId] = useState(null); // 器具行の削除確認対象id
  const [deleteRoomConfirm, setDeleteRoomConfirm] = useState(null); // 未登録Room削除の確認対象{roomId, roomName}

  const catalog = mode.equipmentCatalog();
  const symbols = equipmentSymbols(catalog);
  // 登録済み行ごとの階範囲は mode.equipmentSpanLabel(id)（project があれば全階分「1階〜3階」・
  // 無ければ自階の階名だけ。ステップ4・S4）。未登録（行の無い昇降路Room）は常に現在の階名。
  const entries = buildEquipmentTabEntries({
    rows: graph.equipmentRows, rooms: graph.rooms, symbols,
    spanLabelOf: id => mode.equipmentSpanLabel(id), currentFloorLabel: floorName ?? '',
  });

  if (entries.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: '#94a3b8', padding: 20, fontSize: 12 }}>
        機械器具が登録されていません
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {entries.map(entry => (
        <div
          key={entry.id}
          onClick={() => mode.selectEquipment(entry.id)}
          style={{
            ...rowStyle,
            border: entry.id === mode.selectedEquipmentId ? '1px solid #2563eb' : '1px solid transparent',
            background: entry.id === mode.selectedEquipmentId ? '#eff6ff' : '#fff',
          }}
        >
          <span style={{ fontWeight: 700, width: 56, flexShrink: 0 }}>{entry.symbol}</span>
          <span style={{ color: '#64748b', width: 36, flexShrink: 0 }}>{CATEGORY_LABEL[entry.category] ?? ''}</span>
          {entry.kind === 'row' ? (
            <select
              value={entry.usage ?? ''}
              onClick={e => e.stopPropagation()}
              onChange={e => onChangeEquipmentUsage(entry.id, e.target.value)}
              style={{ fontSize: 12, flexShrink: 0 }}
            >
              {EV_USAGE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          ) : (
            <span style={{ color: '#94a3b8', flexShrink: 0 }}>ー</span>
          )}
          <span style={{ color: '#64748b', flex: 1 }}>{entry.spanLabel}</span>
          <button
            onClick={e => {
              e.stopPropagation();
              if (entry.kind === 'row') setDeleteRowId(entry.id);
              else setDeleteRoomConfirm({ roomId: entry.roomId, roomName: entry.symbol });
            }}
            style={{ color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
          >
            削除
          </button>
        </div>
      ))}
      {deleteRowId && (
        <ConfirmDialog
          message="この昇降機器具を削除しますか？"
          buttons={[
            { label: 'キャンセル', value: 'cancel' },
            { label: '削除', value: 'ok', danger: true },
          ]}
          onSelect={value => {
            if (value === 'ok') onDeleteEquipment(deleteRowId);
            setDeleteRowId(null);
          }}
        />
      )}
      <RoomDeleteConfirm
        graph={graph}
        mode={mode}
        deleteConfirm={deleteRoomConfirm}
        onClose={() => setDeleteRoomConfirm(null)}
      />
    </div>
  );
});
