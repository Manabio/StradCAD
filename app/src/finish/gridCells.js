import { CenterLineType, Discipline } from '@core';
import { scopedValue, graphList } from '../graphReadScope.js';

// ================================================================
// グリッド索引（分割格子のスナップショット）
// ================================================================
//
// worldToCell / getCellsInRect / refreshCells は「全 CL を filter+sort して分割格子を組む」
// 処理を呼び出しのたびに繰り返していた。graph.centerLines は MobX の computed だが観測者の
// いない文脈では読み出しのたびに再計算されるため（graphReadScope.js のヘッダ参照）、
// 「部屋×面×セル」の三重ループから引くとこれだけで支配的なコストになる。
//
// そこで分割格子をプレーンオブジェクト（POJO）のスナップショットとして組み、
// withGraphReadScope（graphReadScope.js）のスコープ内ではそれを使い回す。
// スコープ外で呼ばれた場合は従来どおり毎回組み直す（挙動は完全に同じ・遅いだけ）。
const GRID_INDEX_KEY = 'gridCells:index';

// CL の分割判定に必要な値だけを持つ POJO。ホットループから MobX の observable 読み出し
// （cl.value / cl.extentLo は computed）を取り除くために確定値としてコピーする。
function snapshotCL(cl) {
  return {
    id: cl.id, value: cl.value, labeled: cl.labeled, discipline: cl.discipline,
    lineType: cl.lineType, extentLo: cl.extentLo, extentHi: cl.extentHi,
    centerLineType: cl.centerLineType,
    // 実CLへの参照。スナップショットに無いフィールド（effectiveValue 等）を要する
    // 公開APIは、返り値としてこちらを返す（dividerCLsBetween）。
    cl,
  };
}

function buildGridIndex(graph) {
  const verticals = [], horizontals = [], all = [], clById = new Map();
  for (const cl of graphList(graph, 'centerLines') ?? []) {
    const s = snapshotCL(cl);
    all.push(s);
    clById.set(s.id, s);
    if (!isDividerCL(s)) continue;
    if (s.centerLineType === CenterLineType.VERTICAL) verticals.push(s);
    else if (s.centerLineType === CenterLineType.HORIZONTAL) horizontals.push(s);
  }
  verticals.sort((a, b) => a.value - b.value);
  horizontals.sort((a, b) => a.value - b.value);
  const xValues = [...new Set(verticals.map(v => v.value))];
  const yValues = [...new Set(horizontals.map(h => h.value))];
  // allXValues/allYValues は「分割CLに限らない全CLの座標値」（展開図の区間刻み
  // ＝elevationFloorProfile.js の collectRunBreaks が使う。分割格子とは別の集合）。
  const valuesOfType = t => [...new Set(all.filter(c => c.centerLineType === t).map(c => c.value))]
    .sort((a, b) => a - b);
  return {
    verticals, horizontals, xValues, yValues, all, clById,
    allXValues: valuesOfType(CenterLineType.VERTICAL),
    allYValues: valuesOfType(CenterLineType.HORIZONTAL),
    xIndex: new Map(xValues.map((v, i) => [v, i])),
    yIndex: new Map(yValues.map((v, i) => [v, i])),
  };
}

/**
 * 分割格子の索引（スナップショット）を返す。読み取りスコープ内なら使い回す。
 * 返り値の CL は POJO（id/value/labeled/discipline/lineType/extentLo/extentHi/centerLineType/cl）
 * ——実 CL と同じフィールド名のため isDividerCL / isActiveAcrossRange はそのまま使える。
 */
export function gridIndexOf(graph) {
  return scopedValue(graph, GRID_INDEX_KEY, () => buildGridIndex(graph));
}

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
  const g = gridIndexOf(graph);
  const values = new Set([lo, hi]);
  const src = centerLineType === CenterLineType.VERTICAL ? g.xValues
    : centerLineType === CenterLineType.HORIZONTAL ? g.yValues : [];
  for (const v of src) { if (v > lo && v < hi) values.add(v); }
  return [...values].sort((a, b) => a - b);
}

/**
 * 区間 (lo, hi) に厳密に含まれる分割CLを value 昇順で返す（lo/hi 自身は含まない）。
 * 部屋の外周抽出（wallGeneration.js）で、自部屋のセルには存在しない区切りCL
 * （隣接セルが別部屋・未割当に分かれる境界）もサンプリング候補に含めるために使う。
 */
export function dividerCLsBetween(graph, centerLineType, lo, hi) {
  const g = gridIndexOf(graph);
  const src = centerLineType === CenterLineType.VERTICAL ? g.verticals
    : centerLineType === CenterLineType.HORIZONTAL ? g.horizontals : [];
  return src.filter(s => s.value > lo && s.value < hi).map(s => s.cl); // 既に value 昇順
}

// ================================================================
// 公開 API
// ================================================================

// 昇順の値配列から w を含むマイクロ区間 [lo, hi) を返す（格子外は null）。
// 値上の点は大きい側の区間に属する（呼び出し側は線上を避けた代表点を使う前提。
// structuralAutoFill.js の端境界曖昧性コメント参照）。
function microInterval(values, w) {
  if (w < values[0] || w >= values[values.length - 1]) return null;
  let lo = values[0];
  for (const v of values) {
    if (v <= w) lo = v;
    else return [lo, v];
  }
  return null;
}

// 値 value 上の CL が直交区間 (rangeLo, rangeHi) を分割しているか
function isSeparatingAt(cls, value, rangeLo, rangeHi) {
  return cls.some(cl => cl.value === value && isActiveAcrossRange(cl, rangeLo, rangeHi));
}

// マイクロ列 [colLo, colHi] 内で wy を含む縦区間 { top, bottom } を返す。
// この列区間で分割として働く水平CLだけを境界に採用する。上下いずれかの
// 境界が見つからなければ null（格子の縦方向の外）。
function columnPiece(horizontals, colLo, colHi, wy) {
  let top = -Infinity, bottom = Infinity;
  for (const h of horizontals) {
    if (!isActiveAcrossRange(h, colLo, colHi)) continue;
    if (h.value <= wy && h.value > top) top = h.value;
    if (h.value > wy && h.value < bottom) bottom = h.value;
  }
  if (top === -Infinity || bottom === Infinity) return null;
  return { top, bottom };
}

/**
 * ワールド座標 (wx, wy) がどのセルに属するかを返す。
 * その点でアクティブな CL（extentLo〜extentHi を尊重）だけを使って判定するため、
 * 中心線の線分外では分割されない。
 *
 * 中心線の部分短縮でL字状の連結領域ができると「点を含む極大矩形」は一意に
 * 定まらず、開始点によって互いに重なる矩形が得られてしまう（グリッド背景の
 * 二重塗り・実在しないセル境界線の原因）。そこで全分割CL値で切ったマイクロ
 * 格子を土台に「列内の縦区間 → 同一縦区間が続く隣接列との横結合」という
 * 列優先の正準マージで一意な平面分割を定義する。どの点から呼んでもセル同士は
 * 重ならず、同じ領域片には同じキー・同じ矩形が返る。
 *
 * @returns {{ key, x1, x2, y1, y2 } | null}
 *   key = "leftId:topId:rightId:bottomId"（4 CL で境界を完全に記述。L字の内部
 *   分割位置に接する辺では、その区間で非アクティブなCLが識別子として使われる）
 */
export function worldToCell(wx, wy, graph) {
  // 同じ点への再問い合わせが多い（面ごと・区間ごとのプローブ）ためスコープ内でmemo化する。
  return scopedValue(graph, `gridCells:p:${wx},${wy}`, () => _worldToCell(wx, wy, graph));
}

function _worldToCell(wx, wy, graph) {
  const { verticals, horizontals, xValues, xIndex } = gridIndexOf(graph);
  if (verticals.length < 2 || horizontals.length < 2) return null;

  const col = microInterval(xValues, wx);
  if (!col) return null;
  const piece = columnPiece(horizontals, col[0], col[1], wy);
  if (!piece) return null;
  const { top, bottom } = piece;

  // 同一縦区間 [top, bottom] が続く限り、非分割の列境界を越えて左右へ結合する
  let loIdx = xIndex.get(col[0]);
  let hiIdx = xIndex.get(col[1]);
  while (!isSeparatingAt(verticals, xValues[loIdx], top, bottom)) {
    if (loIdx === 0) return null; // 左境界CLなし（領域が格子外へ抜ける）
    const p = columnPiece(horizontals, xValues[loIdx - 1], xValues[loIdx], wy);
    if (!p || p.top !== top || p.bottom !== bottom) break; // 縦区間が変わる → ここがL字の内部分割位置
    loIdx--;
  }
  while (!isSeparatingAt(verticals, xValues[hiIdx], top, bottom)) {
    if (hiIdx === xValues.length - 1) return null; // 右境界CLなし
    const p = columnPiece(horizontals, xValues[hiIdx], xValues[hiIdx + 1], wy);
    if (!p || p.top !== top || p.bottom !== bottom) break;
    hiIdx++;
  }

  const left = xValues[loIdx], right = xValues[hiIdx];
  // 境界CLの解決。分割として働くCLを優先し、L字の内部分割位置（その区間では
  // 非アクティブ）では値一致のCLを識別子として使う
  const findBoundaryCL = (cls, value, rangeLo, rangeHi) =>
    cls.find(cl => cl.value === value && isActiveAcrossRange(cl, rangeLo, rangeHi))
    ?? cls.find(cl => cl.value === value);
  const leftCL   = findBoundaryCL(verticals,   left,   top,  bottom);
  const rightCL  = findBoundaryCL(verticals,   right,  top,  bottom);
  const topCL    = findBoundaryCL(horizontals, top,    left, right);
  const bottomCL = findBoundaryCL(horizontals, bottom, left, right);
  if (!leftCL || !rightCL || !topCL || !bottomCL) return null;

  return {
    key: `${leftCL.id}:${topCL.id}:${rightCL.id}:${bottomCL.id}`,
    x1: left,  x2: right,
    y1: top,   y2: bottom,
  };
}

/**
 * 点 (wx, wy) を含む「連結領域」の全セルを返す。
 * セル境界のCLがその区間で非アクティブ（短縮などで実在しない）なら、境界の
 * 向こう側のセルも同じ領域とみなして flood-fill で集める。通常の格子では
 * 自セル1個、部分短縮でL字化した領域ではそれを構成する矩形セル群が返る。
 *
 * @returns {Array<{ key, x1, x2, y1, y2 }>} セルなしなら空配列
 */
export function regionCellsAt(wx, wy, graph) {
  const start = worldToCell(wx, wy, graph);
  if (!start) return [];

  const { verticals, horizontals, xValues, yValues } = gridIndexOf(graph);

  const cells = new Map([[start.key, start]]);
  const queue = [start];

  // 辺（値 edgeValue、直交区間 [lo, hi]）を CL 値で小区間に割り、CL が分割して
  // いない開いた小区間の向こう側のセルを探索キューに加える
  const probeAcross = (edgeCLs, edgeValue, probeOrtho, orthoValues, lo, hi, isVerticalEdge) => {
    const breaks = [lo, ...orthoValues.filter(v => v > lo && v < hi), hi];
    for (let i = 0; i < breaks.length - 1; i++) {
      if (isSeparatingAt(edgeCLs, edgeValue, breaks[i], breaks[i + 1])) continue;
      const mid = (breaks[i] + breaks[i + 1]) / 2;
      const cell = isVerticalEdge
        ? worldToCell(probeOrtho, mid, graph)
        : worldToCell(mid, probeOrtho, graph);
      if (cell && !cells.has(cell.key)) {
        cells.set(cell.key, cell);
        queue.push(cell);
      }
    }
  };

  while (queue.length > 0) {
    const c = queue.pop();
    const xi1 = xValues.indexOf(c.x1), xi2 = xValues.indexOf(c.x2);
    const yi1 = yValues.indexOf(c.y1), yi2 = yValues.indexOf(c.y2);
    if (xi1 > 0)
      probeAcross(verticals, c.x1, (xValues[xi1 - 1] + c.x1) / 2, yValues, c.y1, c.y2, true);
    if (xi2 !== -1 && xi2 < xValues.length - 1)
      probeAcross(verticals, c.x2, (c.x2 + xValues[xi2 + 1]) / 2, yValues, c.y1, c.y2, true);
    if (yi1 > 0)
      probeAcross(horizontals, c.y1, (yValues[yi1 - 1] + c.y1) / 2, xValues, c.x1, c.x2, false);
    if (yi2 !== -1 && yi2 < yValues.length - 1)
      probeAcross(horizontals, c.y2, (c.y2 + yValues[yi2 + 1]) / 2, xValues, c.x1, c.x2, false);
  }
  return [...cells.values()];
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
  const { verticals: allXs, horizontals: allYs } = gridIndexOf(graph);
  if (allXs.length < 2 || allYs.length < 2) return [];
  return getCellsInRect(
    allXs[0].value, allYs[0].value,
    allXs[allXs.length - 1].value, allYs[allYs.length - 1].value,
    graph,
  );
}

/**
 * グリッド区割り線の実在区間を列挙する（FinishModeLayer の背景描画用）。
 * 各分割CLのアクティブ区間（通り芯は全長、それ以外は extent）を格子の外周で
 * クリップした線分を返す。セル矩形の stroke で枠線を描くと、L字領域の内部
 * 分割位置に実在しない線が見えてしまうため、区割り線はこの線分で描く。
 *
 * @returns {Array<{ key, isVertical, value, lo, hi }>}
 */
export function gridDividerSegments(graph) {
  const { verticals, horizontals } = gridIndexOf(graph);
  if (verticals.length < 2 || horizontals.length < 2) return [];

  const xMin = verticals[0].value,   xMax = verticals[verticals.length - 1].value;
  const yMin = horizontals[0].value, yMax = horizontals[horizontals.length - 1].value;

  const segs = [];
  const push = (cl, isVertical, rangeLo, rangeHi) => {
    const full = cl.labeled && cl.discipline === Discipline.STRUCT; // 通り芯は常に全長
    const lo = full ? rangeLo : Math.max(cl.extentLo ?? -Infinity, rangeLo);
    const hi = full ? rangeHi : Math.min(cl.extentHi ?? Infinity, rangeHi);
    if (lo < hi) segs.push({ key: cl.id, isVertical, value: cl.value, lo, hi });
  };
  for (const v of verticals)   push(v, true,  yMin, yMax);
  for (const h of horizontals) push(h, false, xMin, xMax);
  return segs;
}

// 区間群の被覆数が奇数の部分区間を返す（外周＝1、集合内の共有辺＝2で打ち消し）
function oddCoverageIntervals(intervals) {
  const events = [];
  for (const [lo, hi] of intervals) { events.push([lo, 1], [hi, -1]); }
  events.sort((a, b) => a[0] - b[0]);
  const result = [];
  let count = 0, prev = null;
  for (const [v, d] of events) {
    if (prev !== null && v > prev && count % 2 === 1) result.push([prev, v]);
    count += d;
    prev = v;
  }
  return result;
}

/**
 * 矩形群（パーティションのセル bounds。重なりなし・接する辺は同一値）の
 * 外周線分を返す。集合内の2セルが共有する辺区間は打ち消され、輪郭だけが残る。
 * 選択枠・プレビュー枠のように「領域の外形だけ」を描くために使う
 * （セル矩形ごとの stroke だとL字領域の内部に実在しない線が入る）。
 *
 * @param {Array<{x1,y1,x2,y2}>} boundsList
 * @returns {Array<{ isVertical, value, lo, hi }>}
 */
export function outlineSegments(boundsList) {
  const vEdges = new Map(); // x値 → [y区間]
  const hEdges = new Map(); // y値 → [x区間]
  const add = (map, value, lo, hi) => {
    if (!map.has(value)) map.set(value, []);
    map.get(value).push([lo, hi]);
  };
  for (const b of boundsList) {
    add(vEdges, b.x1, b.y1, b.y2);
    add(vEdges, b.x2, b.y1, b.y2);
    add(hEdges, b.y1, b.x1, b.x2);
    add(hEdges, b.y2, b.x1, b.x2);
  }
  const segs = [];
  for (const [value, intervals] of vEdges) {
    for (const [lo, hi] of oddCoverageIntervals(intervals)) segs.push({ isVertical: true, value, lo, hi });
  }
  for (const [value, intervals] of hEdges) {
    for (const [lo, hi] of oddCoverageIntervals(intervals)) segs.push({ isVertical: false, value, lo, hi });
  }
  return segs;
}

/**
 * 4-part キーから CL を引いて実際の bounds を返す。
 * CL の value は MobX computed なので CLが動いたとき自動追従する。
 */
export function cellBoundsFromKey(key, graph) {
  // 同じキーを何度も引く（部屋×面×区間）ためスコープ内でmemo化する。
  // **返り値は読み取り専用**（同じオブジェクトが使い回される）。
  return scopedValue(graph, `gridCells:b:${key}`, () => _cellBoundsFromKey(key, graph));
}

function _cellBoundsFromKey(key, graph) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  // 索引（graph.centerLines のスナップショット。structGraph 分も含む）を先に引く。
  // 見つからない id だけ shapeMap へ問い合わせる（CL 以外の shape・削除済み id）。
  const clById = gridIndexOf(graph).clById;
  const getCL = (id) =>
    clById.get(id) ?? graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
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
  // 同じ Room.cells に対して面ごと・部屋ごとに何度も呼ばれるためスコープ内でmemo化する
  // （キーは Set の同一性。スコープ内で cells を変更しないことが前提）。
  return scopedValue(graph, cells, () => _refreshCells(cells, graph));
}

function _refreshCells(cells, graph) {
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
 * cells (Set<key>) を各セルの bounds 配列に解決する。
 * 選択枠・ヒット領域のように「実際のセル占有形状」で描く用途に使う
 * （包絡矩形だとL字・中空きなど非矩形占有で空きマスまで含んでしまう）。
 * 消失キー（CL削除で解決不能）は除外する。
 */
export function cellBoundsList(cells, graph) {
  return [...cells].map(key => cellBoundsFromKey(key, graph)).filter(Boolean);
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
