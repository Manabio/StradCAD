// ガター内「柱芯」丸ラベル・CENTER寸法「足」の位置計算・当たり判定（純関数群。react-konva 等の
// JSX依存を持たない）。GutterLayer.jsx（描画）と interaction/gutterHitTest.js・snap.js
// （長押し/ポインタのヒット判定）の両方から参照される単一の真実源——描画とヒット判定の位置が
// ズレないよう、幾何計算はここに一本化する。
import { DimensionKind, DimensionSide, CenterLineType, Discipline } from '@core';
import { INSET, OUTWARD, labelCircleRadius } from '../layout.js';
import { nonLabeledClExtent } from '../snapGeometry.js';

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

// ================================================================
// CENTER寸法（中心線寸法）の「足」(引出線) — 位置計算・当たり判定。
// GutterLayer.jsx CenterDimensions（描画。buildRowAnchors/buildRowElements）と単一の真実源を
// 共有する（重複実装しない）。GutterLayer.jsx 側もここを import して使う。
// columnAxisMode（構造モード・ラーメン系）時は CENTER 行が柱芯(SX/SY)表示に専有され、
// 中心線の足は一切存在しない（GutterLayer.jsx CenterDimensions 参照）——呼び出し側で
// columnAxisMode を見て呼び分けること（本ファイルの関数はcolumnAxisMode非対応＝常に通常表示前提）。
// ================================================================

export const MIN_GAP_CM  = 1;  // 建物外端と寸法線の最小紙面距離。これを割ったら部屋内書きへ退避
export const NUM_FONT_PX = 11;
export const TEXT_GAP_PX = 2;

// 「実画面でMIN_GAP_CM cm」相当のワールド距離（mm）。offsetMmと同じく scaleDenominator に比例し、
// 画面px一定（ズーム非依存）。建物外端と寸法線の最小離隔の判定に使う。
export function minGapMm(viewport) {
  return MIN_GAP_CM * 10 * viewport.scaleDenominator;
}

// 描画エリア（ガター内側・論理上の表示領域）のワールド座標範囲を返す。
export function drawingAreaBounds(viewport, width, height) {
  const a = viewport.screenToWorld(INSET.left, INSET.top);
  const b = viewport.screenToWorld(width - INSET.right, height - INSET.bottom);
  return {
    xMin: Math.min(a.x, b.x), xMax: Math.max(a.x, b.x),
    yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y),
  };
}

// 中心線寸法の基準線(lineCoord)を算出する単一の真実源。
// - 通常域: 建物外5cm(offsetMm)を維持。
// - クッションゾーン: ガター側へ最も近い要素（near=寸法値の外端 / far=寸法線そのもの）が
//   ガター内端(areaBounds=INSET内端)から「寸法線↔寸法値の離れ」(reach)以上内側に留まるよう
//   lineCoord をクランプする。クランプ境界は画面固定の INSET 由来なので、パンに自然に追従する
//   （詰める量＝パンニング量依存）。
// - 建物内移動: 建物外端(boundary)と lineCoord の距離が minGapMm を割ったら null を返し、
//   呼び出し元はその行を捨てて部屋内書きフォールバックへ回す。
export function centerLineCoord(d, boundary, viewport, areaBounds) {
  const isNear  = d.side === DimensionSide.TOP || d.side === DimensionSide.LEFT;
  const rawLine = isNear ? boundary - offsetMm(viewport) : boundary + offsetMm(viewport);
  const reach   = (NUM_FONT_PX + TEXT_GAP_PX) / viewport.scaleX; // 寸法線↔寸法値の離れ
  const guInner = d.axis === 'X'
    ? (isNear ? areaBounds.yMin : areaBounds.yMax)
    : (isNear ? areaBounds.xMin : areaBounds.xMax);
  // near は寸法値(lineCoord-reach)がガター側に出るため線をさらに reach 内側へ、
  // far は寸法線自身がガター側のため reach 内側へクランプする。
  const lineCoord = isNear
    ? Math.max(rawLine, guInner + 2 * reach)
    : Math.min(rawLine, guInner - reach);
  if (Math.abs(boundary - lineCoord) < minGapMm(viewport)) return null;
  return lineCoord;
}

// 梁芯（discipline:'fuse'）は中心線（discipline:'arch'）と同じ寸法処理を共用するが、構造モード
// （appMode==='structure'）以外では対象外にする——CenterLinesLayer の描画スキップ（appMode限定表示）
// と寸法行の出し分けを一致させ、非表示の線が寸法だけ出る食い違いを防ぐ。
// 逆に構造モードでは意匠中心線（discipline:'arch'）を対象外にする——CenterLinesLayer が同モードで
// 意匠CLの描画をスキップするのと対にする（非表示の線に寸法だけ出る食い違いを防ぐ、上と同じ理由の逆方向）。
export function isCenterDimensionTarget(cl, appMode) {
  if (cl.labeled || cl.lineType === 'dashed') return false;
  if (appMode === 'structure') return cl.discipline === Discipline.FUSE;
  return cl.discipline === Discipline.ARCH;
}

function segKey(seg) { return `${seg.from.id}:${seg.to.id}`; }

// 隣接アンカー間のセグメント。両端が通り芯(labeled)のみの区間はGRID寸法に表示を委ねるため除外。
function buildSegments(anchors) {
  const segs = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i], to = anchors[i + 1];
    if (from.labeled && to.labeled) continue;
    segs.push({ from, to, length: Math.round(to.effectiveValue - from.effectiveValue) });
  }
  return segs;
}

// 1行（TOP/BOTTOM/LEFT/RIGHT）分のアンカーのうち、実際に点(丸)・足が描画されるアンカーのidを返す
// （両方の境界に届く中心線の区間は両行に重複して出るため、TOP/LEFT を優先側として
// BOTTOM/RIGHT側では同一区間の数値・引出線を抑制する——GutterLayer.jsx buildRowElements と同じ
// dotIds算出。描画（Konva要素）とヒット判定（centerDimensionLegHits）の両方がこれを共有する）。
export function rowDotIds(anchors, suppressKeys) {
  const segs        = buildSegments(anchors);
  const segKeys      = new Set(segs.map(segKey));
  const visibleSegs  = segs.filter(s => !suppressKeys.has(segKey(s)));
  const dotIds = new Set();
  visibleSegs.forEach(s => { dotIds.add(s.from.id); dotIds.add(s.to.id); });
  return { dotIds, segKeys, visibleSegs };
}

// 1行（TOP/BOTTOM/LEFT/RIGHT）分のアンカー（通り芯CL + 境界に到達している中心線CL）を
// value 昇順で返す。境界に到達しているかは nonLabeledClExtent（オーバーハング込み）で判定する
// （renderer/CenterLinesLayer.jsx clExtent の非labeled分岐と同一——centerCLs は
// isCenterDimensionTarget によりlabeled:falseのみに絞られるため、clExtent の代わりに直接使える）。
// この行の基準線（lineCoord）が描画エリアの外に出る場合は、外書き自体を諦めて
// 中心線を部屋内書きフォールバックに回すため、アンカーを空にする。
export function buildCenterRowAnchors(d, graph, viewport, areaBounds, appMode) {
  // floorSwapManager.deactivate() がフロアを IDB にスワップアウトする際、
  // activePlaneId 切替前の一瞬だけ graph.clearFloorData() 後の状態（CENTER 寸法行が0件）を
  // 観測してしまうことがある（正規のスワップアウト動作）。d が無い場合は単に何も描かない。
  if (!d) return { boundary: null, lineCoord: null, anchors: [] };
  const boundary = d.centerBoundary;
  if (boundary == null) return { boundary: null, lineCoord: null, anchors: [] };

  const lineCoord = centerLineCoord(d, boundary, viewport, areaBounds);
  if (lineCoord == null) return { boundary, lineCoord: null, anchors: [] };

  const gridCLs = d.axis === 'X' ? graph.gridXs : graph.gridYs;
  const myType  = d.axis === 'X' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const centerCLs = graph.centerLines.filter(cl => {
    if (cl.centerLineType !== myType || !isCenterDimensionTarget(cl, appMode)) return false;
    const ext = nonLabeledClExtent(cl, graph, viewport);
    return !!ext && ext[0] <= boundary && boundary <= ext[1];
  });
  const anchors = [...gridCLs, ...centerCLs].sort((a, b) => a.value - b.value);
  return { boundary, lineCoord, anchors };
}

// 1行分の「足」情報（実際に描画されるもののみ）を { cl, side, boundary, lineCoord } の配列で返す。
// side は 'lo'（TOP/LEFT行）/'hi'（BOTTOM/RIGHT行）——snapGeometry.js clSideReachesCenterBoundary と
// 同じ向き規約。labeled(通り芯)アンカーは足を持たない（GutterLayer.jsx buildRowElements と同じ）。
function rowLegs(d, rowResult, suppressKeys) {
  const { boundary, lineCoord, anchors } = rowResult;
  if (!d || boundary == null || lineCoord == null || anchors.length === 0) return { legs: [], segKeys: new Set() };
  const { dotIds, segKeys, visibleSegs } = rowDotIds(anchors, suppressKeys);
  if (visibleSegs.length === 0) return { legs: [], segKeys };
  const side = (d.side === DimensionSide.TOP || d.side === DimensionSide.LEFT) ? 'lo' : 'hi';
  const legs = anchors
    .filter(a => dotIds.has(a.id) && !a.labeled)
    .map(a => ({ cl: a, side, boundary, lineCoord }));
  return { legs, segKeys };
}

// CENTER寸法4行（TOP/BOTTOM/LEFT/RIGHT）ぶんの「足」を GutterLayer.jsx CenterDimensions と
// 同じ優先順（TOP→BOTTOM, LEFT→RIGHT の suppressKeys連鎖）で計算し、フラットな配列で返す。
// columnAxisMode 中は呼ばないこと（呼び出し側の責務。本関数は常に通常表示のCENTER行として扱う）。
export function centerDimensionLegHits(graph, viewport, width, height, appMode) {
  if (!graph) return [];
  const areaBounds = drawingAreaBounds(viewport, width, height);
  const rows   = graph.dimensionLines.filter(d => d.dimensionKind === DimensionKind.CENTER);
  const find   = side => rows.find(d => d.side === side);
  const top    = find(DimensionSide.TOP);
  const bottom = find(DimensionSide.BOTTOM);
  const left   = find(DimensionSide.LEFT);
  const right  = find(DimensionSide.RIGHT);

  const topR    = buildCenterRowAnchors(top,    graph, viewport, areaBounds, appMode);
  const bottomR = buildCenterRowAnchors(bottom, graph, viewport, areaBounds, appMode);
  const leftR   = buildCenterRowAnchors(left,   graph, viewport, areaBounds, appMode);
  const rightR  = buildCenterRowAnchors(right,  graph, viewport, areaBounds, appMode);

  const topLegs    = rowLegs(top,    topR,    new Set());
  const bottomLegs = rowLegs(bottom, bottomR, topLegs.segKeys);
  const leftLegs   = rowLegs(left,   leftR,   new Set());
  const rightLegs  = rowLegs(right,  rightR,  leftLegs.segKeys);

  return [...topLegs.legs, ...bottomLegs.legs, ...leftLegs.legs, ...rightLegs.legs];
}

// ポインタ位置（ワールド座標）に最も近いCENTER寸法の「足」上の端点ヒットを返す
// （interaction/usePointerInteraction.js 長押しメニュー起点＝snap.js resolvePointerTargets から
// 呼ばれる。snapGeometry.js findNearestCenterLineEndpoint の突端8px円・はね出し線分ヒットとは別の
// 追加ヒット域——足は境界(boundary)からlineCoordまで、CLの延伸方向にさらに外側へ続く実際の描画
// ジオメトリのため、この専用ジオメトリで判定する）。
// columnAxisMode中は足が存在しないため常にnullを返す。
export function findCenterDimensionLegEndpoint(graph, wx, wy, thresholdPx, scaleX, scaleY, viewport, width, height, appMode, columnAxisMode) {
  if (!graph || columnAxisMode) return null;
  // 性能ガード: 足は必ず最外通り芯より外側にしか無い（境界(boundary)からlineCoordはさらに外へ）ため、
  // ポインタが最外通り芯のX・Y範囲の内側（建物内）に完全に収まっている場合は、centerDimensionLegHits
  // のフル計算（4行ぶんのアンカー・セグメント・suppressKeys算出）を待たずに打ち切る。
  const gx = graph.gridXs, gy = graph.gridYs;
  if (gx.length && gy.length
      && wx > gx[0].value && wx < gx[gx.length - 1].value
      && wy > gy[0].value && wy < gy[gy.length - 1].value) return null;
  let nearest = null, minDist = Infinity;
  for (const { cl, side, boundary, lineCoord } of centerDimensionLegHits(graph, viewport, width, height, appMode)) {
    const isV = cl.centerLineType === CenterLineType.VERTICAL;
    const perp = isV ? Math.abs(cl.value - wx) * scaleX : Math.abs(cl.value - wy) * scaleY;
    if (perp >= thresholdPx || perp >= minDist) continue;
    const along = isV ? wy : wx;
    const lo = Math.min(boundary, lineCoord), hi = Math.max(boundary, lineCoord);
    if (along < lo || along > hi) continue;
    minDist = perp;
    nearest = { cl, side };
  }
  return nearest;
}
