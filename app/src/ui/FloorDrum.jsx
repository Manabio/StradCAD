import { useState, useRef } from 'react';
import {
  ITEM_H, clampIndex, resolveDisplayId, nextIndexFromDrag, nextIndexFromWheel,
  canRequestSwitch, requestFloorSwitch,
} from './floorDrumLogic.js';

// ピルボタンのスタイル（isActive=現在階, dim=折りたたみ時の半透明）
function pillStyle(isActive, dim) {
  return {
    padding: '3px 12px',
    borderRadius: 12,
    border: `1px solid ${isActive ? '#2563eb' : '#cbd5e1'}`,
    background: isActive ? '#2563eb' : 'rgba(255,255,255,0.95)',
    color: isActive ? '#fff' : '#475569',
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap',
    boxShadow: isActive ? 'none' : '0 1px 3px rgba(0,0,0,0.08)',
    opacity: dim ? 0.4 : 1,
    transition: 'opacity 0.15s',
  };
}

const HALF_VISIBLE = 2;  // 中心の上下に露出する階数（計 2*2+1=5 階）

// 縦ドラム1階分のスタイル。中心からの距離で減衰させ、ドラムロールの遠近を演出する。
function wheelItemStyle(dist) {
  const isCenter = dist === 0;
  return {
    height: ITEM_H,
    display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
    padding: '0 12px',
    fontSize: isCenter ? 14 : 12,
    fontWeight: isCenter ? 700 : 500,
    color: isCenter ? '#2563eb' : '#64748b',
    opacity: Math.max(0.25, 1 - dist * 0.28),
    whiteSpace: 'nowrap', userSelect: 'none',
    transition: 'color 0.12s, font-size 0.12s, font-weight 0.12s, opacity 0.12s',
  };
}

// 横長用ドラムロール — 当該階を中心に固定し、ドラッグ/ホイールで階を回す。
// ordered は上=上階の並び（呼び出し側で反転済み）。
// displayIndex は表示基準の階（保留中の選択があればその階）。pendingId は切替の決着待ちの階
// （null=待ちなし）、requestSwitch(id) は切替の要求（FloorDrum が pending の管理を持つ）。
function FloorWheel({ ordered, displayIndex, pendingId, requestSwitch }) {
  const [drag, setDrag] = useState(0);          // ドラッグ中の縦オフセット(px)
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);

  const onPointerDown = e => {
    if (pendingId != null) return; // 切替の決着待ち中は新しい操作を始めない（連打無視）
    startY.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = e => {
    if (!dragging) return;
    setDrag(e.clientY - startY.current);
  };
  const endDrag = e => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // 下方向ドラッグ(正) → 上の階（インデックス小）が中心へ。
    // 離した位置から選んだ階の中心へ直接スナップする（pending が表示基準になる）。
    const next = nextIndexFromDrag(displayIndex, drag, ordered.length);
    setDrag(0);
    requestSwitch(ordered[next].id);
  };
  const onWheel = e => {
    // ホイール下回し → 1階下へ（インデックス大）。
    const next = nextIndexFromWheel(displayIndex, e.deltaY, ordered.length);
    requestSwitch(ordered[next].id);
  };

  const maskH = ITEM_H * (HALF_VISIBLE * 2 + 1);
  const centerTop = (maskH - ITEM_H) / 2;
  // 当該階を中心スロットへ固定し、ドラッグ分だけ追従させる。
  const translateY = centerTop - displayIndex * ITEM_H + drag;
  // ドラッグ中に中心へ来ている階（色付けの基準）。
  const centerIndex = clampIndex(Math.round(displayIndex - drag / ITEM_H), ordered.length);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
      title="ドラッグ／ホイールで階を移動"
      style={{
        position: 'fixed', zIndex: 206,
        left: 8, top: '15%', transform: 'translateY(-50%)',
        height: maskH, overflow: 'hidden',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.9)',
        boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
        cursor: 'grab', touchAction: 'none',
        WebkitMaskImage:
          'linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent)',
        maskImage:
          'linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent)',
      }}
    >
      {/* 中心スロットの目印 */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: centerTop, height: ITEM_H,
        borderTop: '1px solid #cbd5e1', borderBottom: '1px solid #cbd5e1',
        pointerEvents: 'none',
      }} />
      <div style={{
        transform: `translateY(${translateY}px)`,
        transition: dragging ? 'none' : 'transform 0.18s ease-out',
      }}>
        {ordered.map((f, i) => (
          <div key={f.id} style={wheelItemStyle(Math.abs(i - centerIndex))}>
            {f.name}
          </div>
        ))}
      </div>
    </div>
  );
}

// 移動スライダー（ドラム）— 採用階の移動のみを担当する。
// 横長: 当該階を中心に固定したドラムロール（ドラッグ/ホイールで回す）。
// 縦長: 現在階のみを半透明表示し、ホバー/タップで全階を露出する（スマート・パーシステント）。
// 検討案は扱わない（上部チップが担当）。
//
// floors        : [{ id, name }]（標高昇順を想定）
// activeFloorId : 現在表示中の階ID
// onSwitch(id)  : 階切替
// isLandscape   : 横長=左端縦並び / 縦長=下部横並び
export function FloorDrum({ floors, activeFloorId, onSwitch, isLandscape }) {
  const [expanded, setExpanded] = useState(false);
  // 保留中の選択。階を選んだ瞬間から切替の決着まで、表示は選んだ階に留める。
  // pendingRef は同一フレーム内の再入力を state の再描画前でも弾くための鏡（state だけだと古い値を読む）。
  const [pendingId, setPendingId] = useState(null);
  const pendingRef = useRef(null);
  const setPending = id => { pendingRef.current = id; setPendingId(id); };

  const displayId = resolveDisplayId(floors, activeFloorId, pendingId);
  const display   = floors.find(f => f.id === displayId) ?? null;

  const requestSwitch = id => {
    if (!canRequestSwitch(pendingRef.current, displayId, id)) return;
    requestFloorSwitch(id, onSwitch, setPending);
  };

  if (isLandscape) {
    // 縦ドラムは上=上階。floors は標高昇順想定なので反転する。
    const ordered = [...floors].reverse();
    const displayIndex = ordered.findIndex(f => f.id === displayId);
    if (displayIndex < 0) return null;
    return <FloorWheel ordered={ordered} displayIndex={displayIndex} pendingId={pendingId} requestSwitch={requestSwitch} />;
  }

  return (
    <div
      style={{
        position: 'fixed', zIndex: 206,
        display: 'flex', gap: 4,
        bottom: 52, left: '50%', transform: 'translateX(-50%)',
        flexDirection: 'row', alignItems: 'center',
      }}
      onPointerEnter={() => setExpanded(true)}
      onPointerLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false); }}
    >
      {expanded
        ? floors.map(f => (
            <button
              key={f.id}
              onClick={() => { requestSwitch(f.id); setExpanded(false); }}
              aria-current={f.id === displayId ? 'true' : undefined}
              title={f.name}
              style={pillStyle(f.id === displayId, false)}
            >
              {f.name}
            </button>
          ))
        : (
            <button
              onClick={() => setExpanded(true)}
              title="階を移動"
              style={pillStyle(true, true)}
            >
              {display?.name ?? '階'}
            </button>
          )}
    </div>
  );
}
