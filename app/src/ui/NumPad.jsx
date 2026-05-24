import './NumPad.css';

const ROWS = [
  [{ k: '7' }, { k: '8' }, { k: '9' }, { k: '⌫', cls: 'back'    }],
  [{ k: '4' }, { k: '5' }, { k: '6' }, { k: '±',  cls: 'sign'    }],
  [{ k: '1' }, { k: '2' }, { k: '3' }, { k: '.',               }],
  [{ k: '0', span: 2 },               { k: '✕', cls: 'cancel'  },
                                        { k: '✓', cls: 'confirm' }],
];

/**
 * 数値入力テンキー
 *
 * @param {string}        value     現在の入力文字列
 * @param {string}        label     軸ラベル ("X" | "Y")
 * @param {(s:string)=>void} onChange  文字列変化コールバック
 * @param {()=>void}      onConfirm 確定
 * @param {()=>void}      onCancel  キャンセル
 */
export function NumPad({ value, label, onChange, onConfirm, onCancel }) {
  function press(k) {
    switch (k) {
      case '⌫':
        onChange(value.length > 1 ? value.slice(0, -1) : '0');
        break;
      case '±':
        onChange(value.startsWith('-') ? value.slice(1) : '-' + value);
        break;
      case '.':
        if (!value.includes('.')) onChange(value + '.');
        break;
      case '✓':
        onConfirm();
        break;
      case '✕':
        onCancel();
        break;
      default: { // 数字
        const next = value === '0' ? k : value + k;
        onChange(next);
      }
    }
  }

  return (
    <div className="numpad" onPointerDown={e => e.stopPropagation()}>
      {/* 値表示 */}
      <div className="numpad-display">
        <span className="numpad-axis">{label} =</span>
        <span className="numpad-value">{value}</span>
        <span className="numpad-unit">mm</span>
      </div>

      {/* キーグリッド */}
      <div className="numpad-grid">
        {ROWS.map((row, ri) =>
          row.map((btn, bi) => (
            <button
              key={`${ri}-${bi}`}
              className={`numpad-key${btn.cls ? ` numpad-key--${btn.cls}` : ''}${btn.span ? ' numpad-key--span2' : ''}`}
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
