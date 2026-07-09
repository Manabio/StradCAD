import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { roomBounds } from './gridCells.js';
import { RoomKind, RoomFeature } from '@core';
import { ConfirmDialog } from '../ui/ConfirmDialog.jsx';

// 屋内 / 階段 / 吹抜け / 屋外。
// 〔屋内|屋外〕は kind（base軸、相互排他・常にどちらかON）。
// 〔階段|吹抜け〕は feature（属性軸、相互排他・個別ON/OFF可）。
// フェーズ3: 既存部屋にもこのダイアログが開くため、すべてローカル state に留め、
// 確定時（onConfirm）に一括適用する（即時反映はしない）。
const BUTTONS = [
  { type: 'kind',    value: RoomKind.INTERIOR, label: '屋内' },
  { type: 'feature', value: RoomFeature.STAIR, label: '階段' },
  { type: 'feature', value: RoomFeature.VOID,  label: '吹抜け' },
  { type: 'kind',    value: RoomKind.EXTERIOR, label: '屋外' },
];

export const RoomNameInput = observer(({ room, graph, viewport, stairEnabled = true, onConfirm, onCancel, onDelete }) => {
  const [value, setValue]           = useState(room.name || '');
  const [kindSel, setKindSel]       = useState(room.kind);
  const [featureSel, setFeatureSel] = useState(room.feature ?? null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const bounds = roomBounds(room.cells, graph);
  const cx = (bounds.x1 + bounds.x2) / 2;
  const cy = (bounds.y1 + bounds.y2) / 2;
  const { x: sx, y: sy } = viewport.worldToScreen(cx, cy);

  // 削除対象が「子を持つ親部屋」かどうか（部分指定も道連れで消える旨の確認を挟む）
  const hasChildren = graph.rooms.some(r => r.referenceRoomIds.has(room.id));

  function confirm() {
    onConfirm(room.id, { name: value.trim(), kind: kindSel, feature: featureSel });
  }

  function onKeyDown(e) {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { onCancel(room.id); }
  }

  // 階段/吹抜けは相互排他・個別ON/OFF可（再クリックでOFF）
  function toggleFeature(featureValue) {
    setFeatureSel(prev => prev === featureValue ? null : featureValue);
  }

  function requestDelete() {
    if (hasChildren) setDeleteConfirmOpen(true);
    else             onDelete(room.id);
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: sx, top: sy,
        transform: 'translate(-50%, -50%)',
        zIndex: 300,
        background: '#fff',
        border: '2px solid #2563eb',
        borderRadius: 10,
        boxShadow: '0 4px 20px rgba(0,0,0,0.18)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 200,
      }}
    >
      <div style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>部屋名を入力</div>
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="例: リビング"
        style={{
          fontSize: 15,
          padding: '6px 10px',
          border: '1px solid #93c5fd',
          borderRadius: 6,
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        {BUTTONS.map(opt => {
          const disabled = opt.type === 'feature' && opt.value === RoomFeature.STAIR && !stairEnabled;
          const active = opt.type === 'kind' ? kindSel === opt.value : featureSel === opt.value;
          return (
            <button
              key={opt.label}
              disabled={disabled}
              title={disabled ? '上階に採用階がありません' : undefined}
              onClick={() => {
                if (opt.type === 'kind') setKindSel(opt.value);
                else                     toggleFeature(opt.value);
              }}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '5px 0',
                borderRadius: 6,
                border: active ? '1px solid #2563eb' : '1px solid #cbd5e1',
                background: disabled ? '#f1f5f9' : (active ? '#eff6ff' : '#fff'),
                color: disabled ? '#cbd5e1' : (active ? '#2563eb' : '#475569'),
                fontWeight: active ? 700 : 400,
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <button
          onClick={requestDelete}
          style={btnStyle('#fff', '#dc2626', '1px solid #fca5a5')}
        >
          削除
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => onCancel(room.id)}
            style={btnStyle('#f1f5f9', '#475569')}
          >
            キャンセル
          </button>
          <button
            onClick={confirm}
            style={btnStyle('#2563eb', '#fff')}
          >
            確定
          </button>
        </div>
      </div>
      {deleteConfirmOpen && (
        <ConfirmDialog
          message="この部屋を削除すると、部分指定も削除されます。よろしいですか？"
          buttons={[
            { label: 'キャンセル', value: 'cancel' },
            { label: '削除', value: 'ok', danger: true },
          ]}
          onSelect={value => {
            setDeleteConfirmOpen(false);
            if (value === 'ok') onDelete(room.id);
          }}
        />
      )}
    </div>
  );
});

function btnStyle(bg, color, border) {
  return {
    background: bg, color, border: border ?? 'none',
    borderRadius: 6, padding: '5px 14px',
    fontSize: 13, cursor: 'pointer', fontWeight: 600,
  };
}
