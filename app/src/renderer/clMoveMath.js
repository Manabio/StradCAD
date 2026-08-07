// CLMoveInput.jsx（中心線移動の数値入力窓）の純ロジック部分。ui/numpadUtils.js と同じ理由でJSX/CSSを
// 持つコンポーネント本体から切り出す——node:test（jsdom等に頼らない既存流儀）から直接検証できるようにする
// ため。平面モード・構造モード（梁芯）の両方が同じ実装を使う（本ファイルはappMode非依存）。

import { evalNumpadExpr } from '../ui/numpadUtils.js';

// 倍率分母の最大桁単位: 151→100, 230→200
export function calcStep(scaleDenom) {
  if (!scaleDenom || scaleDenom <= 0) return 1;
  const exp = Math.floor(Math.log10(scaleDenom));
  const place = Math.pow(10, exp);
  return Math.floor(scaleDenom / place) * place;
}

// CLの表示基準値を返す（相対表示の原点）。
// columnAxisAware=true（構造モード）かつ参照先が柱芯オフセット非0の通り芯なら、基準を「通り芯値+柱芯
// オフセット」（＝柱芯位置）にする——AddCLDialogの「柱芯」参照は保存時に通り芯clId＋畳んだrefOffsetへ
// 変換される（.claude/structural-model.md 割り切り(c)）ため、通り芯値のままだと表示距離が柱芯偏芯量ぶん
// ズレる（実際の作られ方＝「Y2柱芯から」と食い違う）。既定false＝従来どおり通り芯値そのまま。
export function getDisplayBase(cl, isV, graph, columnAxisAware = false) {
  if (cl.refId) {
    const refVal = cl._referencedCL?.value ?? 0;
    if (columnAxisAware) {
      const off = graph?.columnAxisOffsets?.get(cl.refId) ?? 0;
      if (off !== 0) return refVal + off;
    }
    return refVal;
  }
  const gridCLs = isV ? (graph?.gridXs ?? []) : (graph?.gridYs ?? []);
  const originCL = gridCLs.find(c => c.id !== cl.id);
  return originCL ? originCL.value : 0;
}

// 絶対座標をステップ丸めした絶対座標に変換
export function roundAbsToStep(absVal, cl, isV, scaleDenominator, graph, columnAxisAware = false) {
  const base = getDisplayBase(cl, isV, graph, columnAxisAware);
  const displayVal = isV ? absVal - base : -(absVal - base);
  const step = calcStep(scaleDenominator);
  const roundedDisplay = step > 0 ? Math.round(displayVal / step) * step : Math.round(displayVal);
  return isV ? base + roundedDisplay : base - roundedDisplay;
}

// 四則演算の安全な評価。ui/numpadUtils.js の evalNumpadExpr（NumPad共通の事前検証つき評価）へ委譲する。
// CL移動量は符号付き値（負の偏芯オフセット等）を扱うため positiveOnly:false で呼ぶ
export function safeEval(str) {
  return evalNumpadExpr(str, { positiveOnly: false });
}

// 先頭が「+」かつ数値1つ → 相対演算（現在値へ加算）。既定でフィールド全選択のまま数値入力を始める
// ため、"-1820" のような素の負数入力は「絶対値 -1820」を意図している（マイナス始まりの絶対値入力は
// CL がラベル無し・参照ベースで負のオフセットを持ち得るため頻出）。"-" を相対の符号としても扱うと
// 「絶対値として負数を打つ」手段が無くなり曖昧性を解消できないため、相対演算は "+" 始まりのみ対応する
// （相対減算をしたい場合は結果の絶対値を直接打つ）。
export function isRelative(str) {
  return /^\+(\d+(\.\d+)?|\.\d+)$/.test(str);
}

// 末尾が演算子でなく評価可能 → 式完了
export function isComplete(str) {
  if (!str) return false;
  if (/[+\-*/]$/.test(str)) return false;
  return !isNaN(safeEval(str));
}

// 入力文字列 → 確定する表示値（相対なら relativeBase へ加算、絶対ならそのまま）。不完全な式は NaN。
export function resolveDisplayValue(str, relativeBase) {
  if (!isComplete(str)) return NaN;
  const raw = safeEval(str);
  return isRelative(str) ? relativeBase + raw : raw;
}
