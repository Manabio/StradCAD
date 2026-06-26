import './NumPad.css';
import { applyKeyToNumpadValue } from './numpadUtils.js';

const ROWS = [
  [{ k: '7' }, { k: '8' }, { k: '9' }, { k: '⌫', cls: 'back'    }],
  [{ k: '4' }, { k: '5' }, { k: '6' }, { k: '.',  cls: 'dot'     }],
  [{ k: '1' }, { k: '2' }, { k: '3' }, { k: '0'                  }],
  [{ k: '+', cls: 'op' }, { k: '-', cls: 'op' }, { k: '×', cls: 'op' }, { k: '÷', cls: 'op' }],
  [{ k: '✕', cls: 'cancel', span: 3 },            { k: '✓', cls: 'confirm' }],
];

/**
 * @param {string}           value     現在の入力文字列
 * @param {string}           label     軸ラベル
 * @param {(s:string)=>void} onChange  文字列変化コールバック
 * @param {()=>void}         onConfirm 確定
 * @param {()=>void}         onCancel  キャンセル
 */
export function NumPad({ value, label, onChange, onConfirm, onCancel, hideDisplay = false }) {
  function press(k) {
    if (k === '✓') { onConfirm(); return; }
    if (k === '✕') { onCancel();  return; }
    onChange(applyKeyToNumpadValue(value, k));
  }

  return (
    <div className="numpad" onPointerDown={e => e.stopPropagation()}>
      {!hideDisplay && (
        <div className="numpad-display">
          <span className="numpad-axis">{label}</span>
          <span className="numpad-value">{value || '0'}</span>
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
