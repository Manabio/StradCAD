import { Line, Circle, Text } from 'react-konva';
import { DimensionSide } from '@core';
import { RULER, INSET, OUTWARD, labelCircleRadius } from '../layout.js';

// ================================================================
// ガター注記の共通プリミティブ。
// 通り芯（GutterCircleLabels）・柱芯（GutterLayer.jsx の buildColumnAxisRowElements）・
// 中心線寸法（GutterLayer.jsx の buildRowElements / pushFallbackSegment）の
// いずれもここを参照することで、丸ラベル・寸法行・寸法値テキストの見た目が常に一致する
// （片方だけ変えてもう片方が古いままになる、という参照漏れを防ぐ）。
// OUTWARD・labelCircleRadius 自体は layout.js が単一の真実源（renderer/gutterLabelHits.js
// という react-konva に依存しない純関数レイヤからも参照するため。JSX非依存に保つ）。
// ================================================================

// ガター端から画面定数pxの位置（ズームに関わらず一定）。丸ラベルの定位置に使う。
// 帯の厚み・半径は RULER 基準、上端位置のみ INSET.top（ツールバー分下がる）を使う。
export function gutterEdgeCoord(viewport, width, height, side) {
  switch (side) {
    case DimensionSide.TOP:    return viewport.screenToWorld(0, INSET.top - RULER / 2 - OUTWARD).y;
    case DimensionSide.BOTTOM: return viewport.screenToWorld(0, height - RULER / 2 + OUTWARD).y;
    case DimensionSide.LEFT:   return viewport.screenToWorld(RULER / 2 - OUTWARD, 0).x;
    case DimensionSide.RIGHT:  return viewport.screenToWorld(width - RULER / 2 + OUTWARD, 0).x;
    default: return null;
  }
}

// 丸ラベル（塗り・縁取り・太字青文字）。(x, y) は丸の中心。
export function labelCircle(keyBase, x, y, label, viewport) {
  const r         = labelCircleRadius(viewport);
  const labelSize = RULER / viewport.scaleX;
  const fontSize  = 11 / viewport.scaleX;
  return [
    <Circle key={`${keyBase}-circle`} x={x} y={y} radius={r}
      fill="#dbeafe" stroke="#93c5fd" strokeWidth={viewport.lineWeightsPx.medium} strokeScaleEnabled={false} listening={false} />,
    <Text key={`${keyBase}-text`} x={x - labelSize / 2} y={y - labelSize / 2}
      width={labelSize} height={labelSize} align="center" verticalAlign="middle"
      text={label} fontSize={fontSize} fontStyle="bold" fill="#3b82f6" listening={false} />,
  ];
}

// ================================================================
// 寸法値テキストの例外描画仕様（問題.md「寸法線の新しい仕様」）。
//
// 寸法値テキストの幅が区間長さを超える場合に限り発動する。それ以外の区間は
// 呼び出し元が渡す通常時の配置（normalNumCoord）・中央揃えのまま変更しない。
//
//   1. 寸法はねだし: 複数区間からなる寸法線全体の最初・最後の区間に限り、
//      テキストを仲間の区間と反対方向（外側）へはみ出して表示する。
//   2. 同じ寸法値が3つ以上連続する区間（run）: 「〃」がrun内1区間に収まる
//      ならrun先頭・末尾は実数値+中間は「〃」、収まらなければrun全体を
//      「値×N」の1つのラベルに統合する。
//   99. 上記いずれにも該当しないオーバーフロー区間: 中央揃え・折り返しなし
//      のまま、数値の位置だけ外側（基準線を挟んで図面と反対側）にする。
// ================================================================

const CHAR_WIDTH_RATIO = 0.62; // RoomLabelsLayer.jsx の概算手法 (fontSize * 文字数 * 比率) を流用

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

// オーバーフロー区間の数値を基準線の「外側」（図面から離れる側）に置く座標。
// X軸寸法線ではTextの y、Y軸寸法線（rotation=-90）では x として使う——
// どちらも isNear（TOP/LEFT）なら基準線の手前(-)、そうでなければ奥(+) が外側になる。
function outsideNumCoord(side, lineCoord, fontSize, gap) {
  const isNear = side === DimensionSide.TOP || side === DimensionSide.LEFT;
  return isNear ? lineCoord - fontSize - gap : lineCoord + gap;
}

// 区間配列（value昇順）を「同じlengthが連続するrun」に分割する。
function groupRuns(segments) {
  const runs = [];
  let i = 0;
  while (i < segments.length) {
    let j = i;
    while (j + 1 < segments.length && segments[j + 1].length === segments[i].length) j++;
    runs.push({ start: i, end: j });
    i = j + 1;
  }
  return runs;
}

// 区間配列全体から、寸法値ラベル1件分の仕様 { idx, v1, v2, text, exception, merged } を組み立てる。
// idx は元の区間配列内の位置（はねだし判定=区間配列全体の先頭/末尾かどうかに使う）。
function buildLabelSpecs(segments, fontSize) {
  const specs = [];
  for (const { start, end } of groupRuns(segments)) {
    const runLen  = end - start + 1;
    const seg0    = segments[start];
    const overflow = estimateTextWidth(String(seg0.length), fontSize) > seg0.length;

    if (!overflow || runLen < 3) {
      for (let k = start; k <= end; k++) {
        const s = segments[k];
        specs.push({ idx: k, v1: s.v1, v2: s.v2, text: String(s.length), exception: overflow });
      }
      continue;
    }

    if (estimateTextWidth('〃', fontSize) <= seg0.length) {
      specs.push({ idx: start, v1: seg0.v1, v2: seg0.v2, text: String(seg0.length), exception: true });
      for (let k = start + 1; k < end; k++) {
        const s = segments[k];
        specs.push({ idx: k, v1: s.v1, v2: s.v2, text: '〃', exception: true });
      }
      const segEnd = segments[end];
      specs.push({ idx: end, v1: segEnd.v1, v2: segEnd.v2, text: String(segEnd.length), exception: true });
    } else {
      const segEnd = segments[end];
      specs.push({ idx: start, v1: seg0.v1, v2: segEnd.v2, text: `${seg0.length} × ${runLen}`, exception: true, merged: true });
    }
  }
  return specs;
}

// 寸法線1行（基準線+区間ごとの数値）の Konva 要素を生成する。
// GRID寸法・柱芯寸法・中心線寸法（通常行・部屋内フォールバック）が共通で使う。
// segments: [{ v1, v2, length }]（value昇順、length は to-from を丸めた整数mm）。
// normalNumCoord: オーバーフローしない区間に使う、呼び出し元の既存の数値配置（変更しない）。
export function dimensionRow({ keyBase, axis, side, lineCoord, normalNumCoord, segments, color, strokeWidth, fontSize, gap }) {
  let vMin = Math.min(...segments.map(s => s.v1));
  let vMax = Math.max(...segments.map(s => s.v2));

  const chainLen = segments.length;
  const specs    = buildLabelSpecs(segments, fontSize);

  const labels = specs.map((spec, i) => {
    const isChainEdge = chainLen > 1 && !spec.merged && (spec.idx === 0 || spec.idx === chainLen - 1);
    const hangOut     = isChainEdge && spec.exception;
    // 99.default の「外側化」は寸法はねだし（ケース1）には適用しない——はねだしは区間方向への
    // テキスト位置の変更のみで、線を挟んだ内外側は通常時の配置(normalNumCoord)を保つ。
    const numCoord    = (spec.exception && !hangOut) ? outsideNumCoord(side, lineCoord, fontSize, gap) : normalNumCoord;
    const textWidth   = estimateTextWidth(spec.text, fontSize);

    // 寸法はねだし: ラベルが区間の外側にはみ出す分、基準線もそこまで伸ばす（はみ出した数値が
    // 線から浮いて見えないようにする）。
    let x, y, width;
    if (axis === 'X') {
      if (hangOut && spec.idx === 0)                 { x = spec.v1 - textWidth; width = textWidth; vMin = Math.min(vMin, x); }
      else if (hangOut && spec.idx === chainLen - 1)  { x = spec.v2;             width = textWidth; vMax = Math.max(vMax, x + width); }
      else                                            { x = spec.v1;             width = spec.v2 - spec.v1; }
      y = numCoord;
    } else {
      if (hangOut && spec.idx === 0)                 { y = spec.v1;                  width = textWidth; vMin = Math.min(vMin, y - width); }
      else if (hangOut && spec.idx === chainLen - 1)  { y = spec.v2 + textWidth;      width = textWidth; vMax = Math.max(vMax, y); }
      else                                            { y = spec.v2;                  width = spec.v2 - spec.v1; }
      x = numCoord;
    }

    return axis === 'X'
      ? <Text key={`${keyBase}-num-${i}`} x={x} y={y} width={width} align="center"
          text={spec.text} fontSize={fontSize} fill={color} listening={false} />
      : <Text key={`${keyBase}-num-${i}`} x={x} y={y} width={width} align="center" rotation={-90}
          text={spec.text} fontSize={fontSize} fill={color} listening={false} />;
  });

  const line = axis === 'X'
    ? <Line key={`${keyBase}-line`} points={[vMin, lineCoord, vMax, lineCoord]}
        stroke={color} strokeWidth={strokeWidth} strokeScaleEnabled={false} listening={false} />
    : <Line key={`${keyBase}-line`} points={[lineCoord, vMin, lineCoord, vMax]}
        stroke={color} strokeWidth={strokeWidth} strokeScaleEnabled={false} listening={false} />;

  return { line, labels };
}
