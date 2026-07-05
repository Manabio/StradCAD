import { CenterLineType, Discipline } from '@core';

// ================================================================
// 内部ヘルパー
// ================================================================

// 領域分割に使う CL かどうか（補助線は除外）
export function isDividerCL(cl) {
  return (cl.labeled && cl.discipline === Discipline.STRUCT) ||
         (!cl.labeled && cl.lineType !== 'dashed' && cl.discipline === Discipline.ARCH);
}

// cl の延長区間 [extentLo, extentHi] が [rangeLo, rangeHi] と重なるか（通り芯は常にアクティブ）
export function isActiveAcrossRange(cl, rangeLo, rangeHi) {
  if (cl.labeled && cl.discipline === Discipline.STRUCT) return true;
  const lo = cl.extentLo, hi = cl.extentHi;
  if (lo == null || hi == null) return true;
  return lo < rangeHi && hi > rangeLo;
}

// 区間 [lo, hi] 内に存在する全 CL 値をブレークポイントとして収集
function collectBreaks(graph, centerLineType, lo, hi) {
  const values = new Set([lo, hi]);
  graph.centerLines
    .filter(cl => cl.centerLineType === centerLineType && isDividerCL(cl))
    .forEach(cl => { if (cl.value > lo && cl.value < hi) values.add(cl.value); });
  return [...values].sort((a, b) => a - b);
}

/**
 * 区間 (lo, hi) に厳密に含まれる分割CLを value 昇順で返す（lo/hi 自身は含まない）。
 * 部屋の外周抽出（wallGeneration.js）で、自部屋のセルには存在しない区切りCL
 * （隣接セルが別部屋・未割当に分かれる境界）もサンプリング候補に含めるために使う。
 */
export function dividerCLsBetween(graph, centerLineType, lo, hi) {
  return graph.centerLines
    .filter(cl => cl.centerLineType === centerLineType && isDividerCL(cl) && cl.value > lo && cl.value < hi)
    .sort((a, b) => a.value - b.value);
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
  const verticals   = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL   && isDividerCL(cl));
  const horizontals = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && isDividerCL(cl));
  if (verticals.length < 2 || horizontals.length < 2) return null;

  // 中心線を部分的に短縮・延長してL字状の分割になっている場合、片軸だけの判定
  // （wyだけで左右境界、wxだけで上下境界を決める）では矩形の内部を別の中心線が
  // 横切っていても気づけない、あるいは逆に短縮で無効化されたCLをいつまでも境界と
  // 誤認し続ける（本来はより外側の中心線まで広がるべきセルが広がらない）。
  // 毎周、直交軸の現在値を使って両軸を毎回ゼロから（-Infinity/Infinityから）
  // 計算し直す不動点反復にすることで、狭まる方向・広がる方向のどちらの変化も
  // 正しく収束させる（前回値を起点に「narrowのみ」で継ぎ足すと、無効化された
  // 境界が居座ったまま外側の中心線が見つからなくなる）。
  let left = -Infinity, right = Infinity, top = -Infinity, bottom = Infinity;
  let leftCL = null, rightCL = null, topCL = null, bottomCL = null;
  let changed = true;
  const maxIterations = verticals.length + horizontals.length + 4; // 収束保証の安全弁
  for (let iter = 0; changed && iter < maxIterations; iter++) {
    changed = false;

    let newLeft = -Infinity, newRight = Infinity, newLeftCL = null, newRightCL = null;
    for (const v of verticals) {
      if (!isActiveAcrossRange(v, top, bottom)) continue;
      if (v.value > wx && v.value < newRight) { newRight = v.value; newRightCL = v; }
      if (v.value < wx && v.value > newLeft)  { newLeft  = v.value; newLeftCL  = v; }
    }
    if (newLeft !== left || newRight !== right) changed = true;
    left = newLeft; right = newRight; leftCL = newLeftCL; rightCL = newRightCL;

    let newTop = -Infinity, newBottom = Infinity, newTopCL = null, newBottomCL = null;
    for (const h of horizontals) {
      if (!isActiveAcrossRange(h, left, right)) continue;
      if (h.value > wy && h.value < newBottom) { newBottom = h.value; newBottomCL = h; }
      if (h.value < wy && h.value > newTop)    { newTop    = h.value; newTopCL    = h; }
    }
    if (newTop !== top || newBottom !== bottom) changed = true;
    top = newTop; bottom = newBottom; topCL = newTopCL; bottomCL = newBottomCL;
  }
  if (!leftCL || !rightCL || !topCL || !bottomCL) return null;

  return {
    key: `${leftCL.id}:${topCL.id}:${rightCL.id}:${bottomCL.id}`,
    x1: left,  x2: right,
    y1: top,   y2: bottom,
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
  const getCL = (id) => graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
  const leftCL   = getCL(leftId);
  const topCL    = getCL(topId);
  const rightCL  = getCL(rightId);
  const bottomCL = getCL(bottomId);
  if (!leftCL || !topCL || !rightCL || !bottomCL) return null;
  return {
    x1: leftCL.value,  x2: rightCL.value,
    y1: topCL.value,   y2: bottomCL.value,
  };
}

// セル内部代表点の算出に使うオフセット(mm)。片側の辺しか生存していない場合、
// その辺からこの距離だけ内側の点を「セル内部」とみなす（実寸の部屋なら十分小さい値）。
const INTERIOR_EPS = 10;

/**
 * 4-part キーの各辺が、現在も分割線として機能しているかを判定する。
 * 生存条件: 参照CLがshapeMapに存在し、isDividerCLかつ、直交区間でisActiveAcrossRangeであること。
 * 対辺CLも消失していて直交区間が求まらない場合は、存在チェックのみで判定する。
 *
 * floorplanモードでのCL削除・短縮により部屋のセル区切りが失われたかどうかを、
 * finishモード再突入時に検出するために使う（roomReinterpret.js）。
 *
 * @returns {string[]} 喪失した辺名（'left'|'top'|'right'|'bottom'）の配列
 */
export function lostSides(key, graph) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  const getCL = (id) => graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
  const left = getCL(leftId), top = getCL(topId), right = getCL(rightId), bottom = getCL(bottomId);

  const alive = (cl, rangeLo, rangeHi) => {
    if (!cl || !isDividerCL(cl)) return false;
    if (rangeLo == null || rangeHi == null) return true; // 直交区間不明 → 存在チェックのみ
    return isActiveAcrossRange(cl, rangeLo, rangeHi);
  };

  const vRangeLo = top?.value ?? null, vRangeHi = bottom?.value ?? null; // left/right の直交区間
  const hRangeLo = left?.value ?? null, hRangeHi = right?.value ?? null; // top/bottom の直交区間

  const lost = [];
  if (!alive(left,   vRangeLo, vRangeHi)) lost.push('left');
  if (!alive(right,  vRangeLo, vRangeHi)) lost.push('right');
  if (!alive(top,    hRangeLo, hRangeHi)) lost.push('top');
  if (!alive(bottom, hRangeLo, hRangeHi)) lost.push('bottom');
  return lost;
}

/**
 * 4-part キーが表す旧セルの内部代表点を、生存している辺の値から復元する。
 * 対辺2本（left&right または top&bottom）が同時に消失している場合は復元不能としてnullを返す。
 */
export function cellInteriorPoint(key, graph) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  const getCL = (id) => graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
  const left = getCL(leftId), top = getCL(topId), right = getCL(rightId), bottom = getCL(bottomId);

  let x;
  if (left && right)  x = (left.value + right.value) / 2;
  else if (left)       x = left.value + INTERIOR_EPS;
  else if (right)      x = right.value - INTERIOR_EPS;
  else return null;

  let y;
  if (top && bottom)  y = (top.value + bottom.value) / 2;
  else if (top)        y = top.value + INTERIOR_EPS;
  else if (bottom)     y = bottom.value - INTERIOR_EPS;
  else return null;

  return { x, y };
}

/**
 * Room の cells (Set<key>) を現在のグリッド分割に展開し直す。
 *
 * 部屋指定後に floorplan モードでその領域内部へ新しい区切りCL（中心線等）が
 * 追加されると、保存済みの cellKey は古い（粗い）分割を指したままになり、
 * worldToCell が返す現在のキーと一致しなくなる（部屋の所属判定が壊れる）。
 * 各保存済みセルの矩形を cellBoundsFromKey で求め、その矩形内の現在のセルを
 * getCellsInRect で再列挙することで、物理的な領域は変えずに現在のキー集合へ
 * 正規化する（分割されていなければ実質そのまま返る）。
 */
export function refreshCells(cells, graph) {
  const result = new Set();
  for (const key of cells) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    for (const cell of getCellsInRect(b.x1, b.y1, b.x2, b.y2, graph)) {
      result.add(cell.key);
    }
  }
  return result;
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
