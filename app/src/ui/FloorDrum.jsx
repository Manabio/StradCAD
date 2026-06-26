import { useState, useRef } from 'react';

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

const ITEM_H       = 34; // 1階あたりの高さ(px)
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
function FloorWheel({ ordered, activeIndex, onSwitch }) {
  const [drag, setDrag] = useState(0);          // ドラッグ中の縦オフセット(px)
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);

  const clamp = i => Math.max(0, Math.min(ordered.length - 1, i));

  const onPointerDown = e => {
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
    const steps = Math.round(drag / ITEM_H);
    setDrag(0);
    const next = clamp(activeIndex - steps);
    if (next !== activeIndex) onSwitch(ordered[next].id);
  };
  const onWheel = e => {
    // ホイール下回し → 1階下へ（インデックス大）。
    const next = clamp(activeIndex + (e.deltaY > 0 ? 1 : -1));
    if (next !== activeIndex) onSwitch(ordered[next].id);
  };

  const maskH = ITEM_H * (HALF_VISIBLE * 2 + 1);
  const centerTop = (maskH - ITEM_H) / 2;
  // 当該階を中心スロットへ固定し、ドラッグ分だけ追従させる。
  const translateY = centerTop - activeIndex * ITEM_H + drag;
  // ドラッグ中に中心へ来ている階（色付けの基準）。
  const centerIndex = clamp(Math.round(activeIndex - drag / ITEM_H));

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
  const active  = floors.find(f => f.id === activeFloorId) ?? null;

  if (isLandscape) {
    // 縦ドラムは上=上階。floors は標高昇順想定なので反転する。
    const ordered = [...floors].reverse();
    const activeIndex = ordered.findIndex(f => f.id === activeFloorId);
    if (activeIndex < 0) return null;
    return <FloorWheel ordered={ordered} activeIndex={activeIndex} onSwitch={onSwitch} />;
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
              onClick={() => { onSwitch(f.id); setExpanded(false); }}
              aria-current={f.id === activeFloorId ? 'true' : undefined}
              title={f.name}
              style={pillStyle(f.id === activeFloorId, false)}
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
              {active?.name ?? '階'}
            </button>
          )}
    </div>
  );
}
