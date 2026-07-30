import { useEffect, useRef, useState } from 'react';
import './NumPad.css';
import { applyKeyToNumpadValue, toNumpadKey } from './numpadUtils.js';

const ROWS = [
  [{ k: '7' }, { k: '8' }, { k: '9' }, { k: '⌫', cls: 'back'    }],
  [{ k: '4' }, { k: '5' }, { k: '6' }, { k: '.',  cls: 'dot'     }],
  [{ k: '1' }, { k: '2' }, { k: '3' }, { k: '0'                  }],
  [{ k: '+', cls: 'op' }, { k: '-', cls: 'op' }, { k: '×', cls: 'op' }, { k: '÷', cls: 'op' }],
  [{ k: '✕', cls: 'cancel', span: 3 },            { k: '✓', cls: 'confirm' }],
];

/**
 * @param {string}           value             現在の入力文字列
 * @param {string}           label             軸ラベル
 * @param {(s:string)=>void} onChange          文字列変化コールバック
 * @param {()=>void}         onConfirm         確定
 * @param {()=>void}         onCancel          キャンセル
 * @param {boolean}          [keyboard]        物理キーボード入力を購読する（Enter確定 / Escapeキャンセル / 数字・記号入力）。opt-in。
 *                                             自前で keydown を持つ画面（SiteInfoPanel 等）は有効化しないこと（二重発火するため）。
 * @param {boolean}          [cancelOnOutside] パッド外クリックでキャンセルする。opt-in。
 * @param {boolean}          [selectOnStart]   開始時に全選択状態にし、最初の入力で既存値を置換する。opt-in。
 */
export function NumPad({
  value, label, onChange, onConfirm, onCancel,
  hideDisplay = false,
  keyboard = false,
  cancelOnOutside = false,
  selectOnStart = false,
}) {
  // 全選択状態。selectOnStart のときだけ true で開始し、最初の入力で解除する。
  const [selected, setSelected] = useState(selectOnStart);

  // ドラッグ移動。キー以外の部分（表示行・余白）をつかんで動かす。キーは自前の
  // pointerdown で stopPropagation するため、コンテナに届いた pointerdown はドラッグ開始とみなせる。
  // 位置は既定位置（画面下中央）からのオフセットで持ち、マウント毎にリセットされる。
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null); // { pointerId, startX, startY, baseX, baseY } | null

  function handleDragStart(e) {
    e.stopPropagation(); // cancelOnOutside の document ハンドラへ届かせない（従来挙動を維持）
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: dragOffset.x, baseY: dragOffset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleDragMove(e) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    setDragOffset({ x: d.baseX + e.clientX - d.startX, y: d.baseY + e.clientY - d.startY });
  }
  function handleDragEnd(e) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  }

  // キー1つを現在値へ適用。全選択中は現在値を空とみなして置換し、選択を解除する。
  function applyKey(k) {
    onChange(applyKeyToNumpadValue(selected ? '' : value, k));
    if (selected) setSelected(false);
  }

  function press(k) {
    if (k === '✓') { onConfirm(); return; }
    if (k === '✕') { onCancel();  return; }
    applyKey(k);
  }

  // 物理キーボード入力（opt-in）。
  useEffect(() => {
    if (!keyboard) return;
    const onKeyDown = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); onConfirm(); return; }
      if (e.key === 'Escape') { e.preventDefault(); onCancel();  return; }
      const k = toNumpadKey(e.key);
      if (k != null) { e.preventDefault(); applyKey(k); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keyboard, value, selected, onChange, onConfirm, onCancel]); // eslint-disable-line react-hooks/exhaustive-deps -- applyKey は value/selected から再生成される

  // パッド外クリックでキャンセル（opt-in）。自身の pointerdown は stopPropagation するため、
  // document へ届く pointerdown はパッド外クリックのときだけ。
  useEffect(() => {
    if (!cancelOnOutside) return;
    const onOutside = () => onCancel();
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [cancelOnOutside, onCancel]);

  return (
    <div
      className="numpad"
      style={{ transform: `translate(calc(-50% + ${dragOffset.x}px), ${dragOffset.y}px)` }}
      onPointerDown={handleDragStart}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
      onPointerCancel={handleDragEnd}
    >
      {!hideDisplay && (
        <div className="numpad-display">
          <span className="numpad-axis">{label}</span>
          <span className={'numpad-value' + (selected ? ' numpad-value--selected' : '')}>{value || '0'}</span>
          <span className="numpad-unit">mm</span>
        </div>
      )}

      <div className="numpad-grid">
        {ROWS.map((row, ri) =>
          row.map((btn, bi) => (
            <button
              key={`${ri}-${bi}`}
              className={[
                'numpad-key',
                btn.cls   ? `numpad-key--${btn.cls}` : '',
                btn.span === 3 ? 'numpad-key--span3' : btn.span === 2 ? 'numpad-key--span2' : '',
              ].filter(Boolean).join(' ')}
              onPointerDown={e => { e.stopPropagation(); press(btn.k); }}
            >
              {btn.k}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
