import { Line, Rect, Circle, Text, Group } from 'react-konva';
import { miterTriangleVertices, verticalDimLabelBox } from '../elevation/elevationLayout.js';
import { TRIANGLE_HEIGHT_SCREEN_MM, TRIANGLE_ANGLE_DEG } from '../elevation/elevationStyle.js';

// ================================================================
// 展開図（elevation/*.js）のプリミティブ語彙の Konva レンダラ。
// structural/sectionFigure/AutoScaledFigure.jsx の renderPrimitive の Konva 版
// （語彙・座標系は共通。ズームが無いため t は固定倍率の mm→px 変換器
//  elevation/elevationLayout.js の makeElevationTransform を渡す）。
//
// 唯一の追加語彙 `tag`（建具記号丸: 円＋直径横線＋上下2段テキスト）は
// renderer/OpeningTagLayer.jsx の OpeningTag と同じ構成（rPx指定でズーム非依存の
// 見た目サイズにする）。elevationFigure.js ヘッダコメント参照（設計からの意図的な逸脱）。
//
// すべて strokeScaleEnabled={false}（Group scale を掛けず、自前で mm→px 変換するため）。
// ================================================================

const STROKE_COLOR = '#1e293b';
const DIM_COLOR    = '#2563eb';
const DASH_CENTER  = [16, 4, 4, 4]; // 一点鎖線
const DASH_DASHED  = [8, 4];

function weightPx(p, lineWeightsPx) {
  if (p.weight && lineWeightsPx?.[p.weight] != null) return lineWeightsPx[p.weight];
  return p.width ?? 1;
}

function dashArray(dash) {
  if (dash === 'center') return DASH_CENTER;
  if (dash === 'dashed') return DASH_DASHED;
  return undefined;
}

// anchor='middle'&&baseline='middle' の text は幅・高さを仮定した箱の中央寄せで近似する。
const MIDDLE_BOX_W = 500;
const MIDDLE_BOX_H = 28;

function renderText(p, key, t) {
  const x = t.tx(p.x), y = t.ty(p.y);
  const fontSize = p.size ?? 12;
  if (p.anchor === 'middle' && p.baseline === 'middle') {
    return (
      <Text key={key} x={x - MIDDLE_BOX_W / 2} y={y - MIDDLE_BOX_H / 2}
        width={MIDDLE_BOX_W} height={MIDDLE_BOX_H} align="center" verticalAlign="middle"
        text={p.text} fontSize={fontSize} fill={p.fill ?? STROKE_COLOR} listening={false} />
    );
  }
  return <Text key={key} x={x} y={y} text={p.text} fontSize={fontSize} fill={p.fill ?? STROKE_COLOR} listening={false} />;
}

function renderTag(p, key, t) {
  const x = t.tx(p.cx), y = t.ty(p.cy);
  const r = p.rPx;
  const stroke = p.stroke ?? STROKE_COLOR;
  const fontSize = Math.max(9, r * 0.7);
  return (
    <Group key={key} x={x} y={y}>
      <Circle radius={r} stroke={stroke} strokeWidth={1} strokeScaleEnabled={false} listening={false} />
      <Line points={[-r, 0, r, 0]} stroke={stroke} strokeWidth={1} strokeScaleEnabled={false} listening={false} />
      <Text x={-r} y={-r} width={r * 2} height={r} align="center" verticalAlign="middle"
        text={p.top ?? ''} fontSize={fontSize} fill={stroke} listening={false} />
      <Text x={-r} y={0} width={r * 2} height={r} align="center" verticalAlign="middle"
        text={p.bottom ?? ''} fontSize={fontSize} fill={stroke} listening={false} />
    </Group>
  );
}

function renderDim(p, key, t) {
  const isV = p.dir !== 'h';
  const x1 = t.tx(isV ? p.at : p.from), y1 = t.ty(isV ? p.from : p.at);
  const x2 = t.tx(isV ? p.at : p.to),   y2 = t.ty(isV ? p.to   : p.at);
  const nodes = [
    <Line key={`${key}-l`} points={[x1, y1, x2, y2]} stroke={DIM_COLOR} strokeWidth={1} strokeScaleEnabled={false} listening={false} />,
  ];
  if (p.foot != null) {
    const fx = t.tx(isV ? p.foot : p.from), fy = t.ty(isV ? p.from : p.foot);
    const fx2 = t.tx(isV ? p.foot : p.to), fy2 = t.ty(isV ? p.to : p.foot);
    nodes.push(<Line key={`${key}-f1`} points={[x1, y1, fx, fy]} stroke={DIM_COLOR} strokeWidth={1} strokeScaleEnabled={false} listening={false} />);
    nodes.push(<Line key={`${key}-f2`} points={[x2, y2, fx2, fy2]} stroke={DIM_COLOR} strokeWidth={1} strokeScaleEnabled={false} listening={false} />);
  }
  if (p.dot) {
    nodes.push(<Circle key={`${key}-d1`} x={x1} y={y1} radius={2} fill={DIM_COLOR} strokeScaleEnabled={false} listening={false} />);
    nodes.push(<Circle key={`${key}-d2`} x={x2} y={y2} radius={2} fill={DIM_COLOR} strokeScaleEnabled={false} listening={false} />);
  }
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  if (isV) {
    // 天井高寸法など縦方向の寸法値: 寸法線の左側に、文字の天が左を向く縦書き回転
    // （反時計回り90°。ユーザー仕様）。verticalDimLabelBoxが回転・オフセットを一括算出する。
    const box = verticalDimLabelBox(x1, midY);
    nodes.push(
      <Text key={`${key}-t`} {...box} align="center"
        text={String(p.label ?? '')} fontSize={11} fill={DIM_COLOR} listening={false} />,
    );
  } else {
    nodes.push(
      <Text key={`${key}-t`} x={midX - 40} y={midY - 7} width={80} align="center"
        text={String(p.label ?? '')} fontSize={11} fill={DIM_COLOR} listening={false} />,
    );
  }
  return nodes;
}

function renderMiterTriangle(p, key, t, screenPxPerMm) {
  const anchorX = t.tx(p.x), anchorY = t.ty(p.y);
  const heightPx = TRIANGLE_HEIGHT_SCREEN_MM * (screenPxPerMm ?? 1);
  const { top, outer, inner } = miterTriangleVertices(anchorX, anchorY, p.dir, heightPx, TRIANGLE_ANGLE_DEG);
  return (
    <Line key={key} points={[...top, ...outer, ...inner]} closed
      fill="#1e293b" stroke="#1e293b" strokeWidth={1} strokeScaleEnabled={false} listening={false} />
  );
}

function renderOne(p, i, t, lineWeightsPx, screenPxPerMm) {
  const key = `p${i}`;
  switch (p.type) {
    case 'line':
      return (
        <Line key={key} points={[t.tx(p.x1), t.ty(p.y1), t.tx(p.x2), t.ty(p.y2)]}
          stroke={p.stroke ?? STROKE_COLOR} strokeWidth={weightPx(p, lineWeightsPx)}
          dash={dashArray(p.dash)} strokeScaleEnabled={false} listening={false} />
      );
    case 'rect':
      return (
        <Rect key={key} x={t.tx(p.x)} y={t.ty(p.y)} width={t.sx(p.w)} height={t.sx(p.h)}
          fill={p.fill} stroke={p.stroke ?? STROKE_COLOR} strokeWidth={weightPx(p, lineWeightsPx)}
          strokeScaleEnabled={false} listening={false} />
      );
    case 'polyline':
      return (
        <Line key={key} points={p.points.flatMap(([x, y]) => [t.tx(x), t.ty(y)])}
          closed={!!p.closed} fill={p.closed ? (p.fill ?? STROKE_COLOR) : undefined}
          stroke={p.stroke ?? STROKE_COLOR} strokeWidth={weightPx(p, lineWeightsPx)}
          strokeScaleEnabled={false} listening={false} />
      );
    case 'circle':
      return (
        <Circle key={key} x={t.tx(p.cx)} y={t.ty(p.cy)} radius={p.rPx ?? t.sx(p.r ?? 0)}
          fill={p.fill} stroke={p.stroke ?? STROKE_COLOR} strokeWidth={1}
          strokeScaleEnabled={false} listening={false} />
      );
    case 'text':
      return renderText(p, key, t);
    case 'tag':
      return renderTag(p, key, t);
    case 'dim':
      return renderDim(p, key, t);
    case 'miterTriangle':
      return renderMiterTriangle(p, key, t, screenPxPerMm);
    default:
      return null;
  }
}

/**
 * プリミティブ配列を Konva 要素配列へレンダリングする。
 * @param {object[]} primitives
 * @param {{tx:Function, ty:Function, sx:Function}} t - mm→px 変換器
 * @param {{lineWeightsPx?: {thin:number, medium:number, thick:number}, screenPxPerMm?: number}} [opts]
 *   screenPxPerMm - 校正値（miterTriangleのスクリーン固定サイズ換算用。ElevationLayer.jsxが
 *   viewportから渡す。tagのrPxとは異なりTRIANGLE_HEIGHT_SCREEN_MMが「実画面mm」基準のため必要）。
 * @returns {import('react').ReactNode[]}
 */
export function renderFigurePrimitives(primitives, t, { lineWeightsPx, screenPxPerMm } = {}) {
  return primitives.flatMap((p, i) => {
    const el = renderOne(p, i, t, lineWeightsPx, screenPxPerMm);
    return el == null ? [] : el;
  });
}
