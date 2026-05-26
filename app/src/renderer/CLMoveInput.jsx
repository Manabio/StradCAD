import { useState, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { NumPad } from '../ui/NumPad.jsx';
import './CLMoveInput.css';

export const CLMoveInput = observer(function CLMoveInput({
  moveState, screenX, screenY, onUpdate, onCommit, onCancel, graph,
}) {
  // ── Rules of Hooks: すべて early return より前 ──────────────────
  const cl  = moveState?.cl ?? null;
  const isV = cl?.centerLineType === 'X';

  // ---- 表示値と基準値を計算 ----
  let displayValue = 0;
  let base = 0; // 絶対座標への変換基準 (表示値 + base → 絶対座標)

  if (cl) {
    if (cl.refId) {
      // 参照あり: refOffset を表示
      base = cl._referencedCL?.value ?? 0;
      displayValue = isV ? cl.refOffset : -cl.refOffset;
    } else {
      // 参照なし: X1/Y1 からの距離を表示
      const gridCLs = isV ? (graph?.gridXs ?? []) : (graph?.gridYs ?? []);
      const originCL = gridCLs.find(c => c.id !== cl.id);
      if (originCL) {
        base = originCL.value;
        displayValue = isV ? cl.value - base : -(cl.value - base);
      } else {
        // X1/Y1 が存在しない (自分自身が X1) → 絶対座標表示
        base = 0;
        displayValue = isV ? cl.value : -cl.value;
      }
    }
  }

  // ref に保持して useEffect 内から常に最新値を読めるようにする
  const baseRef = useRef(0);
  baseRef.current = base;

  const [inputStr, setInputStr] = useState('');
  const typingRef   = useRef(false);
  const inputStrRef = useRef('');   // keydown ハンドラ用の最新値参照
  const applyRef    = useRef(null); // keydown ハンドラが常に最新の apply を呼べるよう

  // 新しい移動セッション開始時にタイピング状態をリセット
  useEffect(() => {
    if (moveState) {
      typingRef.current = false;
      inputStrRef.current = String(Math.round(displayValue));
    }
  }, [moveState]); // eslint-disable-line react-hooks/exhaustive-deps

  // ドラッグで値が変わったとき、テンキー未操作中のみ追従
  useEffect(() => {
    if (!typingRef.current) {
      setInputStr(String(Math.round(displayValue)));
    }
  }, [displayValue]);

  // 表示値 d → 絶対座標
  function dispToAbs(d) {
    return isV ? baseRef.current + d : baseRef.current - d;
  }

  // applyStr の最新版を ref に保持
  function applyStr(str) {
    inputStrRef.current = str;
    setInputStr(str);
    typingRef.current = true;
    const v = Number(str);
    if (!isNaN(v) && str.trim() !== '') onUpdate(dispToAbs(v));
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

  // 参照先ラベル ("X1から" / "Y2から" / "X =" など)
  let fromLabel;
  if (cl.refId) {
    fromLabel = `${cl._referencedCL?.label ?? axisLabel}から`;
  } else {
    const gridCLs = isV ? (graph?.gridXs ?? []) : (graph?.gridYs ?? []);
    const originCL = gridCLs.find(c => c.id !== cl.id);
    fromLabel = originCL ? `${originCL.label}から` : `${axisLabel} =`;
  }

  // ---- テキストフィールド入力 ----
  function handleFocus() { typingRef.current = true;  }
  function handleBlur()  { typingRef.current = false; }
  function handleChange(e) { applyStr(e.target.value); }
  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      const v = Number(inputStr);
      if (!isNaN(v)) { onUpdate(dispToAbs(v)); onCommit(); }
    }
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  }

  // ---- テンキー入力 ----
  function handleNumChange(newStr) { applyStr(newStr); }
  function handleNumConfirm() {
    const v = Number(inputStr);
    if (!isNaN(v)) onUpdate(dispToAbs(v));
    onCommit();
  }

  return (
    <>
      {/* カーソル横の小窓 */}
      <div className="cl-move-input" style={{ left: screenX + 14, top: screenY - 28 }}>
        <span className="cl-move-label">{fromLabel}</span>
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
        label={fromLabel}
        onChange={handleNumChange}
        onConfirm={handleNumConfirm}
        onCancel={onCancel}
      />
    </>
  );
});
