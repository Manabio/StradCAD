// ガター内「柱芯」丸ラベルの位置計算・当たり判定（純関数群。react-konva 等のJSX依存を持たない）。
// GutterLayer.jsx（描画）と interaction/gutterHitTest.js（長押しヒット判定）の両方から参照される
// 単一の真実源——描画とヒット判定の位置がズレないよう、幾何計算はここに一本化する。
import { DimensionKind, DimensionSide } from '@core';
import { INSET, OUTWARD, labelCircleRadius } from '../layout.js';

// 通り芯寸法(GRID)の基準線スクリーン位置を4辺分まとめてワールド座標で返す
// （GridDimensions の lineY/lineX と同じ式。位置がずれるとクランプ後の見た目も狂うため必ず揃える）。
const GRID_LINE_INSET   = 4;   // 上・左右: 線のガター内端からの距離 (px)
const GRID_NUM_INSET    = 12;  // 上・左右: 数字中心のガター内端からの距離 (px)
const GRID_B_LINE_INSET = 14;  // 下: 線のガター内端からの距離 (px)

export function gridLineBounds(viewport, width, height) {
  return {
    top:    viewport.screenToWorld(0, INSET.top - GRID_LINE_INSET).y,
    bottom: viewport.screenToWorld(0, height - INSET.bottom + GRID_B_LINE_INSET).y,
    left:   viewport.screenToWorld(INSET.left - GRID_LINE_INSET, 0).x,
    right:  viewport.screenToWorld(width - INSET.right + GRID_NUM_INSET, 0).x,
  };
}

// 「実画面で5cm」= 印刷スケール 1/N の紙面上で5cm相当のワールド距離（mm）。
// N（=scaleDenominator）に比例するため、ズームに応じてリアルタイムに伸縮する。
const OFFSET_CM_AT_SCALE = 5; // 印刷スケール換算で5cm（例: 1/100 なら 50mm×100 = 5000mm）
export function offsetMm(viewport) {
  return OFFSET_CM_AT_SCALE * 10 * viewport.scaleDenominator;
}

// 柱芯寸法線を通り芯寸法(GRID)の基準線から内側へ離す余白（半径相当+OUTWARD、行の軸に応じた向きの
// スケールで換算）。○ラベル廃止後は、ガター逃げ時に柱芯寸法線がGRID基準線へ重ならない離隔としてのみ使う。
export function columnAxisPush(axis, viewport) {
  const pushScale = axis === 'X' ? viewport.scaleY : viewport.scaleX;
  return labelCircleRadius(viewport) + OUTWARD / pushScale;
}

// 1行分の柱芯アンカーを value 昇順で返す。中心線版の部屋内フォールバックとは異なり、
// 柱芯はグリッドからのオフセットのみで決まる1:1の点で「浮いた中心線」が存在しないため、
// 重なり判定・連鎖探索は不要——外側オフセット位置が描画エリア外に出る（柱芯がガーターへ
// 逃げる）場合でも、柱芯寸法線は通り芯寸法(GRID)の基準線（gridBounds、gridLineBounds参照）
// より外（ガーター側）へは出さず、その内側（モデル側）2*push分の位置で止める。丸ラベルは
// 自分の寸法線からpush分しか離れない（GutterLayer.jsx buildColumnAxisRowElements参照）ため、
// 停止位置をGRID基準線とちょうど揃える（=0オフセット）と二つの寸法線自体が重なってしまう。2*push分
// 内側に留めることで「GRID基準線 → 丸ラベル → 柱芯寸法線」の順にpush間隔で並び、GRID基準線が
// 常に最も外側、丸ラベルが両方の寸法線からちょうどpushずつ離れた、重なりのない配置になる
// （丸ラベル自体のクランプは GutterLayer.jsx buildColumnAxisRowElements 側で行う）。
export function buildColumnAxisAnchors(d, graph, viewport, gridBounds) {
  if (!d) return { boundary: null, lineCoord: null, anchors: [] };
  const boundary = d.centerBoundary;
  if (boundary == null) return { boundary: null, lineCoord: null, anchors: [] };

  const isNear = d.side === DimensionSide.TOP || d.side === DimensionSide.LEFT;
  const rawLineCoord = isNear ? boundary - offsetMm(viewport) : boundary + offsetMm(viewport);
  const push = columnAxisPush(d.axis, viewport);
  const lineCoord = d.axis === 'X'
    ? (isNear ? Math.max(rawLineCoord, gridBounds.top + 2 * push) : Math.min(rawLineCoord, gridBounds.bottom - 2 * push))
    : (isNear ? Math.max(rawLineCoord, gridBounds.left + 2 * push) : Math.min(rawLineCoord, gridBounds.right - 2 * push));

  const gridCLs = d.axis === 'X' ? graph.gridXs : graph.gridYs;
  const offsets = graph.columnAxisOffsets;
  const points = [];
  [...gridCLs].sort((a, b) => a.value - b.value).forEach(cl => {
    const off = offsets.get(cl.id) ?? 0;
    // :axis 点＝柱芯（通り芯+偏芯量）。○「柱芯」ラベルは全グリッド芯に付ける（偏芯0の内部芯も
    // 柱芯＝通り芯位置に表示）。偏芯≠0 のときは別途 :grid 点（通り芯位置・ラベル無し）も置く。
    if (off !== 0) points.push({ id: `${cl.id}:grid`, value: cl.effectiveValue, isColumnAxis: false });
    points.push({ id: `${cl.id}:axis`, value: cl.effectiveValue + off, isColumnAxis: true });
  });
  points.sort((a, b) => a.value - b.value);
  return { boundary, lineCoord, anchors: points };
}

// 柱芯（一点鎖線）の端点を伸ばす先＝○「柱芯」ラベルの中心座標を4辺分まとめて返す。
// ラベルは柱芯寸法線（lineCoord）の外側 push 分（GutterLayer.jsx buildColumnAxisRowElementsと同じ）に
// 置くため、その push 分を足した位置を返す。通り芯が丸ラベル中心（gutterEdgeCoord）まで伸びるのと
// 同じ見た目になり、かつ寸法線側に足を引かずに軸線自体をラベルへ届かせる（足無しの見た目を保つ）。
export function columnAxisLabelCoords(graph, viewport, width, height) {
  const gridBounds = gridLineBounds(viewport, width, height);
  const rows   = graph.dimensionLines.filter(d => d.dimensionKind === DimensionKind.CENTER);
  const find   = side => rows.find(d => d.side === side);
  const labelCoordFor = side => {
    const d = find(side);
    if (!d) return null;
    const { lineCoord } = buildColumnAxisAnchors(d, graph, viewport, gridBounds);
    if (lineCoord == null) return null;
    const isNear = side === DimensionSide.TOP || side === DimensionSide.LEFT;
    const push   = columnAxisPush(d.axis, viewport);
    return isNear ? lineCoord - push : lineCoord + push;
  };
  return {
    top:    labelCoordFor(DimensionSide.TOP),
    bottom: labelCoordFor(DimensionSide.BOTTOM),
    left:   labelCoordFor(DimensionSide.LEFT),
    right:  labelCoordFor(DimensionSide.RIGHT),
  };
}

// ○「柱芯」ラベルの当たり判定用に、各ラベル中心のスクリーン座標を {cl, sx, sy} で列挙する。
// 描画（GutterLayer.jsx buildColumnAxisRowElements）と同じ幾何：X通り芯ラベルは上下辺、Y通り芯ラベルは
// 左右辺に各2つ（柱芯位置＝通り芯+偏芯量に沿う）。columnAxisLabelCoords（ラベル線の直交座標）を再利用する。
export function columnAxisLabelHits(graph, viewport, width, height) {
  if (!graph) return [];
  const coords  = columnAxisLabelCoords(graph, viewport, width, height);
  const offsets = graph.columnAxisOffsets;
  const toScreen = (wx, wy) => ({ sx: wx * viewport.scaleX + viewport.offsetX, sy: wy * viewport.scaleY + viewport.offsetY });
  const hits = [];
  for (const cl of graph.gridXs) {           // 縦CL（X通り芯）→ 上下辺
    const ax = cl.effectiveValue + (offsets.get(cl.id) ?? 0);
    for (const perp of [coords.top, coords.bottom]) {
      if (perp == null) continue;
      hits.push({ cl, ...toScreen(ax, perp) });
    }
  }
  for (const cl of graph.gridYs) {           // 横CL（Y通り芯）→ 左右辺
    const ay = cl.effectiveValue + (offsets.get(cl.id) ?? 0);
    for (const perp of [coords.left, coords.right]) {
      if (perp == null) continue;
      hits.push({ cl, ...toScreen(perp, ay) });
    }
  }
  return hits;
}
