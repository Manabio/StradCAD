import { useRef, useState, useEffect } from 'react';
import { FinishTable } from './FinishTable.jsx';

const SNAP_HALF  = 0.5;   // 画面高さの 50%
const SNAP_PEEK  = 0.15;  // 画面高さの 15%（閉じかけ状態）
const CLOSE_VEL  = 600;   // px/s を超えたら下スワイプで閉じる

// 縦長デバイス用 — 下からせり上がるハーフモーダル
export function FinishHalfModal({ graph, selectedRoomId, onSelectRoom, floorName }) {
  const [snapRatio, setSnapRatio] = useState(SNAP_PEEK);
  const [dragging,  setDragging]  = useState(false);
  const startY   = useRef(null);
  const startSnap = useRef(null);
  const lastY    = useRef(null);
  const lastT    = useRef(null);
  const sheetH   = window.innerHeight * snapRatio;

  useEffect(() => {
    if (selectedRoomId) setSnapRatio(SNAP_HALF);
  }, [selectedRoomId]);

  function onHandleDown(e) {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startY.current   = clientY;
    startSnap.current = snapRatio;
    lastY.current    = clientY;
    lastT.current    = Date.now();
    setDragging(true);
  }

  function onHandleMove(e) {
    if (!dragging) return;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = clientY - startY.current;
    const newRatio = Math.max(SNAP_PEEK, Math.min(0.85, startSnap.current - dy / window.innerHeight));
    setSnapRatio(newRatio);
    const dt = Date.now() - lastT.current;
    if (dt > 0) {
      // velocity tracking (only care about swipe direction)
    }
    lastY.current = clientY;
    lastT.current = Date.now();
  }

  function onHandleUp(e) {
    setDragging(false);
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dt = Date.now() - lastT.current || 1;
    const vel = (clientY - lastY.current) / (dt / 1000); // px/s (正=下方向)
    if (vel > CLOSE_VEL || snapRatio < SNAP_PEEK + 0.05) {
      setSnapRatio(SNAP_PEEK);
    } else if (snapRatio > 0.65) {
      setSnapRatio(0.85);
    } else {
      setSnapRatio(SNAP_HALF);
    }
  }

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('pointermove', onHandleMove);
    window.addEventListener('pointerup',   onHandleUp);
    return () => {
      window.removeEventListener('pointermove', onHandleMove);
      window.removeEventListener('pointerup',   onHandleUp);
    };
  });

  return (
    <div
      style={{
        position: 'fixed',
        left: 0, right: 0,
        bottom: 0,
        height: sheetH,
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(8px)',
        borderTop: '1px solid #e2e8f0',
        borderRadius: '16px 16px 0 0',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.12)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        transition: dragging ? 'none' : 'height 0.25s ease',
        touchAction: 'none',
      }}
    >
      {/* ドラッグハンドル */}
      <div
        onPointerDown={onHandleDown}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '10px 0 6px',
          cursor: 'row-resize',
          flexShrink: 0,
        }}
      >
        <div style={{ width: 40, height: 4, borderRadius: 2, background: '#cbd5e1' }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b', marginTop: 6 }}>仕上げ表</div>
      </div>

      <FinishTable
        graph={graph}
        selectedRoomId={selectedRoomId}
        onSelectRoom={onSelectRoom}
        floorName={floorName}
      />
    </div>
  );
}
