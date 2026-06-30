import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { roomBounds } from './gridCells.js';
import { RoomKind } from '@core';

// 屋内 / 階段 / 吹抜け / 屋外。階段は RoomKind ではなく階段への変換アクション。
const BUTTONS = [
  { type: 'kind',  value: RoomKind.INTERIOR, label: '屋内' },
  { type: 'stair',                           label: '階段' },
  { type: 'kind',  value: RoomKind.VOID,     label: '吹抜け' },
  { type: 'kind',  value: RoomKind.EXTERIOR, label: '屋外' },
];

export const RoomNameInput = observer(({ room, graph, viewport, stairEnabled = true, onConfirm, onCancel, onConvertToStair }) => {
  const [value, setValue] = useState(room.name || '');
  // 「階段」は確定前の排他選択フラグ。確定時に初めて変換アクションを発火する。
  const [stairSelected, setStairSelected] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const bounds = roomBounds(room.cells, graph);
  const cx = (bounds.x1 + bounds.x2) / 2;
  const cy = (bounds.y1 + bounds.y2) / 2;
  const { x: sx, y: sy } = viewport.worldToScreen(cx, cy);

  function confirm() {
    if (stairSelected) onConvertToStair?.(room.id);
    else               onConfirm(room.id, value.trim());
  }

  function onKeyDown(e) {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { onCancel(room.id); }
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
          const disabled = opt.type === 'stair' && !stairEnabled;
          const active = opt.type === 'stair'
            ? stairSelected
            : !stairSelected && room.kind === opt.value;
          return (
            <button
              key={opt.label}
              disabled={disabled}
              title={disabled ? '上階に採用階がありません' : undefined}
              onClick={() => {
                if (opt.type === 'stair') { setStairSelected(true); }
                else { setStairSelected(false); room.setKind(opt.value); }
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
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
  );
});

function btnStyle(bg, color) {
  return {
    background: bg, color, border: 'none',
    borderRadius: 6, padding: '5px 14px',
    fontSize: 13, cursor: 'pointer', fontWeight: 600,
  };
}
