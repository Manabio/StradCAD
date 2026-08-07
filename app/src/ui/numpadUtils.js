// 物理キーボードの key を NumPad キー記号へ変換する（数字・記号・Backspace のみ。該当なしは null）
export function toNumpadKey(key) {
  if (/^[0-9]$/.test(key)) return key;
  if (key === 'Backspace') return '⌫';
  if (key === '.')  return '.';
  if (key === '+')  return '+';
  if (key === '-')  return '-';
  if (key === '*')  return '×';
  if (key === '/')  return '÷';
  return null;
}

// 数式文字列を数値評価する（App.jsx evalExpr と同一ロジック）。
// positiveOnly=true（既定）は v>0 のみ許容（CL移動量等）。false は 0以下・負値も許容する
// （CL偏芯量など符号付き入力向け。第2段のSiteInfoPanel.jsx差し替えで使用）。
export function evalNumpadExpr(s, { positiveOnly = true } = {}) {
  if (!s) return NaN;
  try {
    const expr = s.replace(/×/g, '*').replace(/÷/g, '/');
    // Function評価前に四則演算の数式のみ許可する（括弧・識別子等の非数式文字列を弾く安全対策）。
    // 空白は演算子まわり・両端のみ許容（ダイアログ自由入力欄の "100 + 50" 等との互換）——"100 50" の
    // ような空白区切りの数字列を無条件で連結して桁違いの数値にしてしまわないよう、空白の位置ごと検証する。
    // 演算子直後の [+-]? は "100+-50"（=50）のような符号付き第2項を許容するため。
    // 指数表記(1e3)・16進(0x10)は意図的に非対応（NaN）
    // 末尾演算子もこの正規表現に包含されるため別途チェックしない
    if (!/^\s*[+-]?\s*(\d+\.?\d*|\.\d+)(\s*[+\-*/]\s*[+-]?\s*(\d+\.?\d*|\.\d+))*\s*$/.test(expr)) return NaN;
    // 評価直前の空白除去はしない: "100 - -50" を除去すると "100--50" となりJSのデクリメント演算子として
    // 構文解析され SyntaxError（→NaN）になる。上の正規表現が既に安全な数式であることを保証済みのため、
    // 空白を含んだまま Function 評価してよい（JS構文として空白は許容される）
    const v = Function(`"use strict"; return (${expr})`)();
    if (typeof v !== 'number' || !isFinite(v)) return NaN;
    return positiveOnly ? (v > 0 ? v : NaN) : v;
  } catch { return NaN; }
}

// NumPad キー 1 つを現在値に適用して新しい値を返す（キーボード入力との共有用）。
// minusReplacesZero=true: 表示値0からの負数入力を "0-" ではなく "-" に置換する（絶対値をマイナスから
// 打ち始めるUX）。CLMoveInput.jsx の物理キーボード経路のみで使用、既定falseは従来どおり数字と同様に扱う
export function applyKeyToNumpadValue(value, k, { minusReplacesZero = false } = {}) {
  function canAppendOp(v) {
    return v.length > 0 && !/[+\-*/]$/.test(v);
  }
  switch (k) {
    case '⌫': return value.length > 1 ? value.slice(0, -1) : '';
    case '.':  return value.includes('.') ? value : value + '.';
    case '+':
    case '-':
      if (k === '-' && minusReplacesZero && (value === '' || value === '0')) return '-';
      if (value === '') return k;
      if (canAppendOp(value)) return value + k;
      return value;
    case '×':
    case '÷': {
      const op = k === '×' ? '*' : '/';
      return canAppendOp(value) ? value + op : value;
    }
    default: // 数字
      return (value === '' || value === '0') ? k : value + k;
  }
}
