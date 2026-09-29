import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { roomBounds } from './gridCells.js';
import { RoomFeature } from '@core';
import {
  ROOM_KIND_OPTIONS, featureOptionsForDialog, featureToSelectValue, selectValueToFeature,
} from './roomNamingOptions.js';

// 区分（屋内/屋外。kind）と属性（なし/階段/吹抜け/昇降機。feature）の2セレクタ。
// 〔屋内|屋外〕は kind（base軸、相互排他・常にどちらかON）。
// 〔なし|階段|吹抜け|昇降機〕は feature（属性軸、相互排他・個別ON/OFF可）。
// 選択肢は featureOptionsForDialog（roomNamingOptions.js）が唯一の供給源——部分指定
// （referenceRoomIds 非空）は昇降機を選べない（S5）。
// 新規Room（未指定セル・統合・新規部分指定）の命名専用ダイアログ。既存部屋の編集は
// 仕上げ表・内部タブのカードへ移した。本ダイアログに削除は無い。

export const RoomNameInput = observer(({ room, graph, viewport, stairEnabled = true, onConfirm, onCancel }) => {
  const [value, setValue]           = useState(room.name || '');
  const [kindSel, setKindSel]       = useState(room.kind);
  const [featureSel, setFeatureSel] = useState(room.feature ?? null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const bounds = roomBounds(room.cells, graph);
  const cx = (bounds.x1 + bounds.x2) / 2;
  const cy = (bounds.y1 + bounds.y2) / 2;
  const { x: sx, y: sy } = viewport.worldToScreen(cx, cy);

  function confirm() {
    onConfirm(room.id, { name: value.trim(), kind: kindSel, feature: featureSel });
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
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>区分</div>
          <select
            value={kindSel}
            onChange={e => setKindSel(e.target.value)}
            style={selectStyle}
          >
            {ROOM_KIND_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 2 }}>属性</div>
          <select
            value={featureToSelectValue(featureSel)}
            onChange={e => setFeatureSel(selectValueToFeature(e.target.value))}
            title={stairEnabled ? undefined : '上階に採用階がありません'}
            style={selectStyle}
          >
            {featureOptionsForDialog(room).map(opt => (
              <option
                key={featureToSelectValue(opt.value)}
                value={featureToSelectValue(opt.value)}
                disabled={opt.value === RoomFeature.STAIR && !stairEnabled}
              >
                {opt.label}
              </option>
            ))}
          </select>
        </div>
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

const selectStyle = {
  width: '100%',
  fontSize: 13,
  padding: '5px 8px',
  border: '1px solid #93c5fd',
  borderRadius: 6,
  outline: 'none',
  boxSizing: 'border-box',
};

function btnStyle(bg, color, border) {
  return {
    background: bg, color, border: border ?? 'none',
    borderRadius: 6, padding: '5px 14px',
    fontSize: 13, cursor: 'pointer', fontWeight: 600,
  };
}
