import { useRef } from 'react';

const LONG_PRESS_MS  = 500; // 長押し判定時間
const MOVE_THRESHOLD = 8;   // px — これ以上動いたらパンに切り替え

/**
 * D案ロングプレス検出フック
 *
 * @param {object} callbacks
 * @param {(sx, sy) => void}  callbacks.onStart   — 押し始め (視覚フィードバック用)
 * @param {(sx, sy) => void}  callbacks.onFire    — 長押し成立 (メニュー表示)
 * @param {() => void}        callbacks.onCancel  — キャンセル (移動 or 早期離し)
 *
 * @returns {{ begin, move, abort, isPending }}
 *   begin(sx, sy)  — pointerDown で呼ぶ
 *   move(sx, sy)   — pointerMove で呼ぶ。true を返したらパン開始してよい
 *   abort()        — pointerUp / TouchEnd で呼ぶ
 *   isPending()    — タイマー動作中か
 */
export function useLongPress({ onStart, onFire, onCancel } = {}) {
  const timerRef    = useRef(null);
  const startPosRef = useRef(null);
  const firedRef    = useRef(false);

  function begin(sx, sy) {
    firedRef.current    = false;
    startPosRef.current = { x: sx, y: sy };
    onStart?.(sx, sy);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      onFire?.(startPosRef.current.x, startPosRef.current.y);
    }, LONG_PRESS_MS);
  }

  // 移動検出 — 閾値超えたら長押しキャンセルし true を返す (→ パン開始の合図)
  function move(sx, sy) {
    if (!startPosRef.current) return false;
    const moved = Math.hypot(sx - startPosRef.current.x, sy - startPosRef.current.y);
    if (moved > MOVE_THRESHOLD) {
      _clear();
      if (!firedRef.current) onCancel?.();
      return true; // パンに切り替えてよい
    }
    return false;
  }

  // pointerUp / 外部から強制キャンセル
  function abort() {
    const wasPending = timerRef.current !== null;
    _clear();
    if (wasPending && !firedRef.current) onCancel?.();
  }

  function isPending() {
    return timerRef.current !== null;
  }

  function _clear() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }

  return { begin, move, abort, isPending };
}
