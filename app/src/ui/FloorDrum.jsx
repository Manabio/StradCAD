import { useState, useRef, useEffect } from 'react';
import { reaction } from 'mobx';
import {
  ITEM_H, clampIndex, resolveDisplayId, nextIndexFromDrag, nextIndexFromWheel,
  canRequestSwitch, requestFloorSwitch, indexAtPointer, canStartFloorLongPress, shouldFireFloorLongPress,
  isDrumGestureButton, shouldOpenOnContextMenu,
} from './floorDrumLogic.js';
import { useLongPress } from '../interaction/useLongPress.js';
import { isUiBusy } from '../uiBusy.js';

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

// 長押し（横長ドラム・縦長ピル共通）。判断は floorDrumLogic の純関数、タイマーは useLongPress。
// pressIdRef.current は押し始めに呼び出し側が決める（押した位置の階 id）。
function useFloorLongPress({ pendingId, getPendingId, onLongPress, pressIdRef }) {
  // 長押し成立時に、押し始めから状況が変わっていたら（切替の決着待ち・関門）開かない。
  const longPress = useLongPress({
    onFire: () => {
      if (!shouldFireFloorLongPress({ pendingId: getPendingId?.() ?? null, busy: isUiBusy() })) return;
      if (pressIdRef.current != null) onLongPress?.(pressIdRef.current);
    },
  });
  const longPressRef = useRef(null);
  useEffect(() => { longPressRef.current = longPress; });

  // 関門（階/モード切替・undo/redo・階操作）が開いたら、押し始めた長押しのタイマーを止める
  // （App.jsx の関門開始時の中断 resetGestureRefs はここの長押しを知らないため、自前に止める）。
  useEffect(() => reaction(() => isUiBusy(), busy => { if (busy) longPressRef.current.abort(); }), []);
  // アンマウント時（ドラムが消える・縦長への切替・ピルの入れ替え）にも止める。
  useEffect(() => () => longPressRef.current?.abort(), []);
  // 自分が切替を要求した（決着待ちに入った）ときも止める。
  useEffect(() => { if (pendingId != null) longPressRef.current.abort(); }, [pendingId]);
  return longPress;
}

// 縦長用ピル。クリックは従来どおり onClick、長押し（約500ms・移動8px以内）・マウスの右クリックで onLongPress(pressId)。
// 成立した長押しの後のクリックは起こさない。ドラッグ／スクロール（pointercancel・移動・ポインタが外れる）で取り消す。
function PillButton({ pressId, onLongPress, getPendingId, pendingId, onClick, style, children, ...rest }) {
  const pressIdRef = useRef(pressId);
  const pressActiveRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pointerTypeRef = useRef(null);
  const hasHandler = !!onLongPress && pressId != null;
  const longPress = useFloorLongPress({ pendingId, getPendingId, onLongPress, pressIdRef });

  const onPillDown = e => {
    pointerTypeRef.current = e.pointerType;
    longPress.abort();
    suppressClickRef.current = false;
    pressActiveRef.current = false;
    if (!isDrumGestureButton(e.button)) return;
    if (canStartFloorLongPress({ button: e.button, isPrimary: e.isPrimary, hasHandler, pendingId: getPendingId?.() ?? null, busy: isUiBusy() })) {
      pressIdRef.current = pressId;
      pressActiveRef.current = true;
      longPress.begin(e.clientX, e.clientY);
    }
  };
  const onPillMove = e => {
    if (pressActiveRef.current) longPress.move(e.clientX, e.clientY);
  };
  const onPillUp = () => {
    suppressClickRef.current = pressActiveRef.current && longPress.hasFired();
    pressActiveRef.current = false;
    longPress.abort();
  };
  const cancel = () => {
    pressActiveRef.current = false;
    longPress.abort();
  };
  const handleClick = e => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; } // 長押し成立後のクリックは切替にしない
    onClick?.(e);
  };
  const onPillContextMenu = e => {
    e.preventDefault();
    if (!shouldOpenOnContextMenu({ pointerType: pointerTypeRef.current, hasHandler, pendingId: getPendingId?.() ?? null, busy: isUiBusy() })) return;
    longPress.abort(); // Mac の ctrl+クリック（button 0）で始まった長押しが 500ms 後に二重に開かないように
    onLongPress(pressId);
  };
  return (
    <button
      {...rest}
      onClick={handleClick}
      onPointerDown={onPillDown}
      onPointerMove={onPillMove}
      onPointerUp={onPillUp}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={onPillContextMenu}
      style={{ ...style, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      {children}
    </button>
  );
}

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
// onLongPress(id): 長押し（約500ms・移動8px以内）で階設定表を開く入口（無ければ長押しは始めない）。
// getPendingId(): 切替の決着待ちの階を同期に読む（長押しの発火時に状況が変わっていないかの再確認用）。
function FloorWheel({ ordered, displayIndex, pendingId, requestSwitch, onLongPress, getPendingId }) {
  const [drag, setDrag] = useState(0);          // ドラッグ中の縦オフセット(px)
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const pressIdRef = useRef(null);       // 長押しした位置の階 id（押し始めに決める）
  const pressActiveRef = useRef(false);  // このジェスチャで長押しを始めたか（前回の成立の持ち越しで切替を誤って抑止しないため）
  const pointerTypeRef = useRef(null);   // 直前の pointerdown の種類（右クリックで開くのはマウスだけ）

  const longPress = useFloorLongPress({ pendingId, getPendingId, onLongPress, pressIdRef });

  // 右クリック: 既定メニューは出さず、マウスの右クリックなら押した位置の階で階設定表を開く（長押しと同じ関門）。
  const onContextMenu = e => {
    e.preventDefault();
    if (!shouldOpenOnContextMenu({ pointerType: pointerTypeRef.current, hasHandler: !!onLongPress, pendingId: getPendingId?.() ?? null, busy: isUiBusy() })) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientY - (rect.top + rect.height / 2);
    longPress.abort(); // Mac の ctrl+クリック（button 0）で始まった長押しが 500ms 後に二重に開かないように
    onLongPress(ordered[indexAtPointer(displayIndex, offset, ordered.length)].id);
  };

  const onPointerDown = e => {
    pointerTypeRef.current = e.pointerType;
    if (!isDrumGestureButton(e.button)) return; // 右・中ボタンはドラッグも切替も始めない
    if (pendingId != null) return; // 切替の決着待ち中は新しい操作を始めない（連打無視）
    startY.current = e.clientY;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    longPress.abort(); // 2本目の指などで begin を呼び直す前に、押し始めのタイマーを必ず止める
    if (canStartFloorLongPress({ button: e.button, isPrimary: e.isPrimary, hasHandler: !!onLongPress, pendingId, busy: isUiBusy() })) {
      // 押した位置の階＝ドラム中心からのずれで決める（ドラッグ前なので drag=0）
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - (rect.top + rect.height / 2);
      pressIdRef.current = ordered[indexAtPointer(displayIndex, offset, ordered.length)].id;
      pressActiveRef.current = true;
      longPress.begin(e.clientX, e.clientY);
    }
  };
  const onPointerMove = e => {
    if (!dragging) return;
    if (pressActiveRef.current) {
      longPress.move(e.clientX, e.clientY); // 閾値を超えて動いたら長押しは取り消される（ドラッグ）
      if (longPress.hasFired()) return;       // 成立後はドラッグで階を動かさない
    }
    setDrag(e.clientY - startY.current);
  };
  const endDrag = e => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const fired = pressActiveRef.current && longPress.hasFired();
    pressActiveRef.current = false;
    longPress.abort();
    if (fired) { setDrag(0); return; } // 長押しが成立したら離しても階切替は起こさない
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
      onContextMenu={onContextMenu}
      title={onLongPress ? 'ドラッグ／ホイールで階を移動・長押しで階設定表' : 'ドラッグ／ホイールで階を移動'}
      style={{
        userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
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
// onLongPress(id): 長押し／マウスの右クリック（横長ドラム・縦長ピルとも）で階設定表を開く。id は floors の id。省略時は始めない
export function FloorDrum({ floors, activeFloorId, onSwitch, isLandscape, onLongPress }) {
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
    return (
      <FloorWheel
        ordered={ordered} displayIndex={displayIndex} pendingId={pendingId} requestSwitch={requestSwitch}
        onLongPress={onLongPress} getPendingId={() => pendingRef.current}
      />
    );
  }

  return (
    <div
      style={{
        position: 'fixed', zIndex: 206,
        display: 'flex', gap: 4,
        bottom: 52, left: '50%', transform: 'translateX(-50%)',
        flexDirection: 'row', alignItems: 'center',
      }}
      onPointerEnter={e => { if (e.pointerType !== 'touch') setExpanded(true); }} // タッチは押した瞬間にピルが入れ替わると長押しが成り立たない。タップ（click）で広げる
      onPointerLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setExpanded(false); }}
    >
      {expanded
        ? floors.map(f => (
            <PillButton
              key={f.id}
              pressId={f.id} onLongPress={onLongPress} getPendingId={() => pendingRef.current} pendingId={pendingId}
              onClick={() => { requestSwitch(f.id); setExpanded(false); }}
              aria-current={f.id === displayId ? 'true' : undefined}
              title={f.name}
              style={pillStyle(f.id === displayId, false)}
            >
              {f.name}
            </PillButton>
          ))
        : (
            <PillButton
              pressId={display?.id} onLongPress={onLongPress} getPendingId={() => pendingRef.current} pendingId={pendingId}
              onClick={() => setExpanded(true)}
              title="階を移動"
              style={pillStyle(true, true)}
            >
              {display?.name ?? '階'}
            </PillButton>
          )}
    </div>
  );
}
