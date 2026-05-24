import { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { NumPad } from '../ui/NumPad.jsx';
import './CLMoveInput.css';

export const CLMoveInput = observer(function CLMoveInput({
  moveState, screenX, screenY, onUpdate, onCommit, onCancel,
}) {
  // ── Rules of Hooks: すべて early return より前 ──────────────────
  const cl           = moveState?.cl ?? null;
  const isV          = cl?.centerLineType === 'X';
  const displayValue = cl ? (isV ? cl.value : -cl.value) : 0;

  const [inputStr, setInputStr] = useState('');
  const typingRef    = useRef(false);
  const inputStrRef  = useRef('');   // keydown ハンドラ用の最新値参照
  const applyRef     = useRef(null); // keydown ハンドラが常に最新の apply を呼べるよう

  // ドラッグで値が変わったとき、テンキー未操作中のみ追従
  useEffect(() => {
    if (!typingRef.current) {
      setInputStr(String(Math.round(displayValue)));
    }
  }, [displayValue]);

  // applyStr の最新版を ref に保持
  function applyStr(str) {
    inputStrRef.current = str;
    setInputStr(str);
    typingRef.current = true;
    const v = Number(str);
    if (!isNaN(v) && str.trim() !== '') onUpdate(isV ? v : -v);
  }
  applyRef.current = applyStr;

  // ── キーボード → テンキー連携 (INPUT にフォーカスがない時のみ) ──
  useEffect(() => {
    if (!moveState) return;

    function onKeyDown(e) {
      if (document.activeElement?.tagName === 'INPUT') return;
      const str   = inputStrRef.current;
      const apply = applyRef.current;

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        apply(str === '0' ? e.key : str + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        apply(str.length > 1 ? str.slice(0, -1) : '0');
      } else if (e.key === '.') {
        if (!str.includes('.')) apply(str + '.');
      } else if (e.key === '-') {
        apply(str.startsWith('-') ? str.slice(1) : '-' + str);
      } else if (e.key === 'Enter') {
        const v = Number(str);
        if (!isNaN(v)) apply(str);
        onCommit();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── early return ────────────────────────────────────────────────
  if (!moveState) return null;

  const axisLabel = isV ? 'X' : 'Y';

  // ---- テキストフィールド入力 ----
  function handleFocus() { typingRef.current = true;  }
  function handleBlur()  { typingRef.current = false; }
  function handleChange(e) { applyStr(e.target.value); }
  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const v = Number(inputStr);
      if (!isNaN(v)) { onUpdate(isV ? v : -v); onCommit(); }
    }
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  // ---- テンキー入力 ----
  function handleNumChange(newStr) { applyStr(newStr); }
  function handleNumConfirm() {
    const v = Number(inputStr);
    if (!isNaN(v)) onUpdate(isV ? v : -v);
    onCommit();
  }

  return (
    <>
      {/* カーソル横の小窓 */}
      <div className="cl-move-input" style={{ left: screenX + 14, top: screenY - 28 }}>
        <span className="cl-move-label">{axisLabel} =</span>
        <input
          className="cl-move-value"
          type="number"
          value={inputStr}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        <span className="cl-move-unit">mm</span>
      </div>

      {/* テンキー (画面下部固定) */}
      <NumPad
        value={inputStr}
        label={axisLabel}
        onChange={handleNumChange}
        onConfirm={handleNumConfirm}
        onCancel={onCancel}
      />
    </>
  );
});
