import { useState } from 'react';
import './AddCLDialog.css';
import { NumPad } from './NumPad.jsx';

/**
 * 階追加ダイアログ
 *
 * isLowest=true  → ケース1: 「上階」 or 「下階 n階分+」
 * isLowest=false → ケース3: 「上階」 or 「上階 n階分一般階」
 *
 * onConfirm(action, n):
 *   action = 'upper'   → 上階 (n=1固定)
 *   action = 'lower'   → 下階 n階分+
 *   action = 'general' → 上階 n階分一般階
 */
export function AddFloorDialog({ isLowest, onConfirm, onCancel }) {
  const [choice, setChoice] = useState('upper'); // 'upper' | 'lower' | 'general'
  const [nStr,   setNStr]   = useState('1');

  const n = Math.max(1, Math.floor(Number(nStr) || 1));

  function handleConfirm() {
    if (choice === 'upper') { onConfirm('upper', 1); return; }
    onConfirm(choice, n);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  handleConfirm();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  const altChoice = isLowest ? 'lower' : 'general';
  const altLabel  = isLowest ? '下階' : '一般階';
  const altUnit   = isLowest ? '階分+' : '階分';
  const showN     = choice === altChoice;

  return (
    <>
      <div className="cl-dialog-backdrop" onPointerDown={onCancel} />
      <div className="cl-dialog" onKeyDown={handleKeyDown}>
        <div className="cl-dialog-title">階を追加</div>

        {/* 上階 */}
        <label className="cl-dialog-row" style={{ cursor: 'pointer', gap: 8 }}>
          <input
            type="radio"
            name="floor-choice"
            checked={choice === 'upper'}
            onChange={() => setChoice('upper')}
            style={{ margin: 0 }}
          />
          <span style={{ fontSize: 13, color: '#1e293b' }}>上階</span>
        </label>

        {/* 下階 / 一般階 */}
        <label className="cl-dialog-row" style={{ cursor: 'pointer', gap: 8 }}>
          <input
            type="radio"
            name="floor-choice"
            checked={choice === altChoice}
            onChange={() => setChoice(altChoice)}
            style={{ margin: 0 }}
          />
          <span style={{ fontSize: 13, color: '#1e293b', whiteSpace: 'nowrap' }}>
            {altLabel}
          </span>
          <input
            type="number"
            className="cl-dialog-input"
            value={nStr}
            min="1"
            style={{ width: 60, opacity: showN ? 1 : 0.4 }}
            onChange={e => { setChoice(altChoice); setNStr(e.target.value); }}
            onFocus={() => setChoice(altChoice)}
          />
          <span className="cl-dialog-unit">{altUnit}</span>
        </label>

        <div className="cl-dialog-actions">
          <button className="cl-dialog-btn cl-dialog-btn--cancel" onClick={onCancel}>
            キャンセル
          </button>
          <button className="cl-dialog-btn cl-dialog-btn--ok" onClick={handleConfirm}>
            OK
          </button>
        </div>
      </div>

      {showN && (
        <NumPad
          value={nStr}
          label="n"
          onChange={setNStr}
          onConfirm={handleConfirm}
          onCancel={onCancel}
        />
      )}
    </>
  );
}
