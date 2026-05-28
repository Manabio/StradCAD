import { CenterLineType, Discipline } from '@core';

// ================================================================
// 内部ヘルパー
// ================================================================

// 領域分割に使う CL かどうか（補助線は除外）
function isDividerCL(cl) {
  return (cl.labeled && cl.discipline === Discipline.STRUCT) ||
         (!cl.labeled && cl.lineType !== 'dashed' && cl.discipline === Discipline.ARCH);
}

// ある垂直方向の位置 perpCoord でアクティブな CL を昇順で返す
//   verticalCL の perpCoord = wy （中心線の extentLo/Hi は y軸方向の範囲）
//   horizontalCL の perpCoord = wx
function getActiveCLs(graph, centerLineType, perpCoord) {
  return graph.centerLines
    .filter(cl => {
      if (cl.centerLineType !== centerLineType) return false;
      if (!isDividerCL(cl)) return false;
      // 通り芯は常にアクティブ
      if (cl.labeled && cl.discipline === Discipline.STRUCT) return true;
      // 中心線: extentLo〜extentHi の範囲内のみアクティブ
      const lo = cl.extentLo, hi = cl.extentHi;
      if (lo == null || hi == null) return true;
      return perpCoord >= lo && perpCoord <= hi;
    })
    .sort((a, b) => a.value - b.value);
}

// 区間 [lo, hi] 内に存在する全 CL 値をブレークポイントとして収集
function collectBreaks(graph, centerLineType, lo, hi) {
  const values = new Set([lo, hi]);
  graph.centerLines
    .filter(cl => cl.centerLineType === centerLineType && isDividerCL(cl))
    .forEach(cl => { if (cl.value > lo && cl.value < hi) values.add(cl.value); });
  return [...values].sort((a, b) => a - b);
}

// ================================================================
// 公開 API
// ================================================================

/**
 * ワールド座標 (wx, wy) がどのセルに属するかを返す。
 * その点でアクティブな CL（extentLo〜extentHi を尊重）だけを使って判定するため、
 * 中心線の線分外では分割されない。
 *
 * @returns {{ key, x1, x2, y1, y2 } | null}
 *   key = "leftId:topId:rightId:bottomId"（4 CL で境界を完全に記述）
 */
export function worldToCell(wx, wy, graph) {
  const xs = getActiveCLs(graph, CenterLineType.VERTICAL,   wy);
  const ys = getActiveCLs(graph, CenterLineType.HORIZONTAL, wx);
  if (xs.length < 2 || ys.length < 2) return null;

  let leftCL = null, rightCL = null;
  for (let i = 0; i < xs.length - 1; i++) {
    if (wx >= xs[i].value && wx < xs[i + 1].value) {
      leftCL = xs[i]; rightCL = xs[i + 1]; break;
    }
  }
  let topCL = null, bottomCL = null;
  for (let j = 0; j < ys.length - 1; j++) {
    if (wy >= ys[j].value && wy < ys[j + 1].value) {
      topCL = ys[j]; bottomCL = ys[j + 1]; break;
    }
  }
  if (!leftCL || !topCL) return null;

  return {
    key: `${leftCL.id}:${topCL.id}:${rightCL.id}:${bottomCL.id}`,
    x1: leftCL.value,  x2: rightCL.value,
    y1: topCL.value,   y2: bottomCL.value,
  };
}

/**
 * ワールド矩形 [xMin,xMax] × [yMin,yMax] 内に存在する全セルを列挙する。
 * 矩形内の全 CL 値をブレークポイントとし、各小区間の中点から worldToCell を呼ぶ。
 * extent 外の分割は worldToCell が自然に無効化するため正しい集合が得られる。
 */
export function getCellsInRect(xMin, yMin, xMax, yMax, graph) {
  const xBreaks = collectBreaks(graph, CenterLineType.VERTICAL,   xMin, xMax);
  const yBreaks = collectBreaks(graph, CenterLineType.HORIZONTAL, yMin, yMax);

  const seen = new Set();
  const result = [];
  for (let i = 0; i < xBreaks.length - 1; i++) {
    for (let j = 0; j < yBreaks.length - 1; j++) {
      const midX = (xBreaks[i] + xBreaks[i + 1]) / 2;
      const midY = (yBreaks[j] + yBreaks[j + 1]) / 2;
      const cell = worldToCell(midX, midY, graph);
      if (cell && !seen.has(cell.key)) {
        seen.add(cell.key);
        result.push(cell);
      }
    }
  }
  return result;
}

/**
 * グラフ全体の全有効セルを列挙する（FinishModeLayer のグリッド背景描画用）。
 */
export function getAllCells(graph) {
  const allXs = graph.centerLines
    .filter(cl => cl.centerLineType === CenterLineType.VERTICAL   && isDividerCL(cl))
    .sort((a, b) => a.value - b.value);
  const allYs = graph.centerLines
    .filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && isDividerCL(cl))
    .sort((a, b) => a.value - b.value);
  if (allXs.length < 2 || allYs.length < 2) return [];
  return getCellsInRect(
    allXs[0].value, allYs[0].value,
    allXs[allXs.length - 1].value, allYs[allYs.length - 1].value,
    graph,
  );
}

/**
 * 4-part キーから CL を引いて実際の bounds を返す。
 * CL の value は MobX computed なので CLが動いたとき自動追従する。
 */
export function cellBoundsFromKey(key, graph) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  const leftCL   = graph.shapeMap.get(leftId);
  const topCL    = graph.shapeMap.get(topId);
  const rightCL  = graph.shapeMap.get(rightId);
  const bottomCL = graph.shapeMap.get(bottomId);
  if (!leftCL || !topCL || !rightCL || !bottomCL) return null;
  return {
    x1: leftCL.value,  x2: rightCL.value,
    y1: topCL.value,   y2: bottomCL.value,
  };
}

/**
 * Room の cells (Set<key>) からその部屋全体の包絡矩形を返す。
 */
export function roomBounds(cells, graph) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const key of cells) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    if (b.x1 < x1) x1 = b.x1;
    if (b.y1 < y1) y1 = b.y1;
    if (b.x2 > x2) x2 = b.x2;
    if (b.y2 > y2) y2 = b.y2;
  }
  return { x1, y1, x2, y2 };
}
