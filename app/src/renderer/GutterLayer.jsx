import { observer } from 'mobx-react-lite';
import { Line, Circle } from 'react-konva';
import { DimensionKind, DimensionSide, CenterLineType, Discipline } from '@core';
import { CenterLinesLayer, clExtent } from './CenterLinesLayer.jsx';
import { DIMENSION_LINE_WEIGHT } from './dimensionStyle.js';
import { OUTWARD, gutterEdgeCoord, labelCircle, labelCircleRadius, dimensionRow } from './gutterPrimitives.jsx';
import { INSET } from '../layout.js';

// ================================================================
// ガーターレイヤー (window全体にフィットする1枚のレイヤー、描画エリアと同倍率)
//
// 通り芯本体・丸ラベル・通り芯寸法(GRID/CENTER)をまとめて描画する。位置はワールド座標
// (mm) で与え、Konva の親Group変換(viewport.offsetX/Y, scaleX/Y)にそのまま乗せる。
// 「画面端から固定px」という見た目を保つ要素は viewport.screenToWorld() でワールド座標に
// 変換してから配置し、フォントサイズ・線太さ・半径などの「画面定数px」は scaleX で割って
// ワールド単位に変換する（描画時に親Groupのscaleで再度掛け戻され、画面上は常に一定pxになる）。
// この手法は元々 CenterDimensionLayer（CENTER寸法）が使っていたものを全体に適用している。
// ================================================================

// ---- ガター内 通り芯丸ラベル ----
// 位置・見た目は gutterPrimitives.jsx の gutterEdgeCoord/labelCircle を参照（柱芯側と共通）。
const GutterCircleLabels = observer(({ graph, viewport, width, height }) => {
  if (!graph) return null;
  const topY    = gutterEdgeCoord(viewport, width, height, DimensionSide.TOP);
  const bottomY = gutterEdgeCoord(viewport, width, height, DimensionSide.BOTTOM);
  const leftX   = gutterEdgeCoord(viewport, width, height, DimensionSide.LEFT);
  const rightX  = gutterEdgeCoord(viewport, width, height, DimensionSide.RIGHT);

  return graph.centerLines
    .filter(cl => cl.labeled && cl.discipline === Discipline.STRUCT)
    .flatMap(cl => {
      if (cl.centerLineType === CenterLineType.VERTICAL) {
        const sx = cl.effectiveValue * viewport.scaleX + viewport.offsetX;
        if (sx < INSET.left || sx > width - INSET.right) return [];
        return [
          ...labelCircle(`${cl.id}-t`, cl.effectiveValue, topY,    cl.label, viewport),
          ...labelCircle(`${cl.id}-b`, cl.effectiveValue, bottomY, cl.label, viewport),
        ];
      }
      if (cl.centerLineType === CenterLineType.HORIZONTAL) {
        const sy = cl.effectiveValue * viewport.scaleY + viewport.offsetY;
        if (sy < INSET.top || sy > height - INSET.bottom) return [];
        return [
          ...labelCircle(`${cl.id}-l`, leftX,  cl.effectiveValue, cl.label, viewport),
          ...labelCircle(`${cl.id}-r`, rightX, cl.effectiveValue, cl.label, viewport),
        ];
      }
      return [];
    });
});

// ================================================================
// GRID寸法 (通り芯間距離)
// ================================================================
const GRID_LINE_INSET   = 4;   // 上・左右: 線のガター内端からの距離 (px)
const GRID_NUM_INSET    = 12;  // 上・左右: 数字中心のガター内端からの距離 (px)
const GRID_B_NUM_INSET  = 8;   // 下: 数字中心のガター内端からの距離 (px)
const GRID_B_LINE_INSET = 14;  // 下: 線のガター内端からの距離 (px)
const GRID_DOT_RADIUS_PX = 2;
const GRID_NUM_FONT_PX   = 11;
const GRID_NUM_GAP_PX    = 2;   // オーバーフロー時の数値とびだし用ギャップ (px、寸法線の新しい仕様)
const GRID_LINE_COLOR    = '#475569';

const GridDimensions = observer(({ graph, viewport, width, height }) => {
  if (!graph) return null;
  const dotR        = GRID_DOT_RADIUS_PX / viewport.scaleX;
  const fontSize    = GRID_NUM_FONT_PX / viewport.scaleX;
  const strokeWidth = viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT];
  const gap         = GRID_NUM_GAP_PX / viewport.scaleX;

  return graph.dimensionLines.flatMap(d => {
    if (d.dimensionKind !== DimensionKind.GRID) return [];
    const segs = d.segments;
    if (segs.length === 0) return [];

    const values = d.effectiveAnchors.map(a => a.value);

    if (d.axis === 'X') {
      // 横並び寸法 — 上下ガター
      const isTop = d.side === DimensionSide.TOP;
      const lineY = viewport.screenToWorld(0, isTop ? INSET.top - GRID_LINE_INSET : height - INSET.bottom + GRID_B_LINE_INSET).y;
      const numY  = viewport.screenToWorld(0, isTop ? INSET.top - GRID_NUM_INSET  : height - INSET.bottom + GRID_B_NUM_INSET).y - fontSize / 2;

      const segs2 = segs.map(s => ({ v1: Math.min(s.from.value, s.to.value), v2: Math.max(s.from.value, s.to.value), length: s.length }));
      const { line, labels } = dimensionRow({
        keyBase: d.id, axis: 'X', side: d.side, lineCoord: lineY, normalNumCoord: numY,
        segments: segs2, color: GRID_LINE_COLOR, strokeWidth, fontSize, gap,
      });
      const els = [line];
      values.forEach((x, i) => els.push(
        <Circle key={`${d.id}-dot-${i}`} x={x} y={lineY} radius={dotR} fill={GRID_LINE_COLOR} listening={false} />
      ));
      els.push(...labels);
      return els;
    }

    if (d.axis === 'Y') {
      // 縦並び寸法 — 左右ガター
      const isLeft = d.side === DimensionSide.LEFT;
      const lineX = viewport.screenToWorld(isLeft ? INSET.left - GRID_LINE_INSET : width - INSET.right + GRID_NUM_INSET, 0).x;
      const numX  = viewport.screenToWorld(isLeft ? INSET.left - GRID_NUM_INSET  : width - INSET.right + GRID_LINE_INSET, 0).x - fontSize / 2;

      const segs2 = segs.map(s => ({ v1: Math.min(s.from.value, s.to.value), v2: Math.max(s.from.value, s.to.value), length: s.length }));
      const { line, labels } = dimensionRow({
        keyBase: d.id, axis: 'Y', side: d.side, lineCoord: lineX, normalNumCoord: numX,
        segments: segs2, color: GRID_LINE_COLOR, strokeWidth, fontSize, gap,
      });
      const els = [line];
      values.forEach((y, i) => els.push(
        <Circle key={`${d.id}-dot-${i}`} x={lineX} y={y} radius={dotR} fill={GRID_LINE_COLOR} listening={false} />
      ));
      els.push(...labels);
      return els;
    }

    return [];
  });
});

// ================================================================
// CENTER寸法 (中心線寸法・柱芯)
//
// 最外通り芯から「印刷スケール換算で5cm」外側（ワールド空間、offsetMm参照）に、
// ラベルなし中心線（補助線除く）の位置を寸法表示する。
// GRID寸法とは独立してワールド空間の実寸オフセットで描画する。
//
// 軸ごとに最大2行（X軸=TOP/BOTTOM、Y軸=LEFT/RIGHT）。各行は「自分の境界
// （直交する最外通り芯の座標）に到達している中心線」のみをアンカーにする。
// 「到達」の判定は CenterLinesLayer が実際に描画するオーバーハング込みの延伸範囲
// （clExtent、ズーム依存）を基準にする —— 生データの extentLo/Hi だけで判定すると、
// 見た目上は通り芯まで届いている（オーバーハングで繋がっている）のに判定上は届いて
// いない扱いになり、行が出ない不具合になるため。
// 両方の境界に届く中心線の区間は両行に重複して出るため、TOP/LEFT を優先側として
// BOTTOM/RIGHT 側では同一区間（起点・終点CLが同一）の数値表示を抑制する。
// どちらの境界にも届かない中心線、または届いてはいるがその行の基準線（lineCoord）自体が
// 描画エリア（ガター内側の論理範囲）の外に出てしまっている中心線（buildRowAnchors が
// areaBounds 外なら anchors を空にする → 同じ経路に合流）は、自身の中点付近に部屋内書き
// フォールバックを表示する。連鎖した部屋内寸法の一部だけが倍率で消えると不自然なため、
// LODに関わらず常時表示する。
//
// 引出線（足）: 通り芯アンカーには描かない（交点の丸のみ）。中心線アンカーには
// CenterLinesLayer と同じ色・線種(ダッシュパターン)で描き、かつ dashOffset を
// 中心線自身の張り出し線分からの距離で計算することで、見た目上パターンが連続して見えるようにする。
// ================================================================

const OFFSET_CM_AT_SCALE = 5; // 印刷スケール換算で5cm（例: 1/100 なら 50mm×100 = 5000mm）
const DOT_RADIUS_PX      = 2;
const NUM_FONT_PX        = 11;
const FALLBACK_FONT_PX   = 10;
const TEXT_GAP_PX        = 2;
const LINE_COLOR         = '#000000';

// 中心線自身の見た目（CenterLinesLayer の非ラベルCL描画と同じにする）
const CL_LEG_COLOR   = '#64748b';
const CL_LEG_DASH    = [12, 4, 2, 4];
const CL_LEG_OPACITY = 0.5;
const CL_LEG_PERIOD  = CL_LEG_DASH.reduce((a, b) => a + b, 0);

function positiveMod(n, m) { return ((n % m) + m) % m; }

// 「実画面で5cm」= 印刷スケール 1/N の紙面上で5cm相当のワールド距離（mm）。
// N（=scaleDenominator）に比例するため、ズームに応じてリアルタイムに伸縮する。
function offsetMm(viewport) {
  return OFFSET_CM_AT_SCALE * 10 * viewport.scaleDenominator;
}

function isCenterDimensionTarget(cl) {
  return !cl.labeled && cl.lineType !== 'dashed' && cl.discipline === Discipline.ARCH;
}

function segKey(seg) { return `${seg.from.id}:${seg.to.id}`; }

// 描画エリア（ガター内側・論理上の表示領域）のワールド座標範囲を返す。
function drawingAreaBounds(viewport, width, height) {
  const a = viewport.screenToWorld(INSET.left, INSET.top);
  const b = viewport.screenToWorld(width - INSET.right, height - INSET.bottom);
  return {
    xMin: Math.min(a.x, b.x), xMax: Math.max(a.x, b.x),
    yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y),
  };
}

// 通り芯寸法(GRID)の基準線スクリーン位置を4辺分まとめてワールド座標で返す
// （GridDimensions の lineY/lineX と同じ式。位置がずれるとクランプ後の見た目も狂うため必ず揃える）。
// 柱芯寸法線がガターへ逃げて停止する位置をここへ揃えることで、丸ラベルから見た
// 「通り芯寸法側の離れ」と「柱芯寸法線側の離れ」を一致させる（丸ラベルは自分の寸法線から
// 外側へpush分ずらした位置にあるだけなので、寸法線同士が同じ座標になれば両者の離れも揃う）。
function gridLineBounds(viewport, width, height) {
  return {
    top:    viewport.screenToWorld(0, INSET.top - GRID_LINE_INSET).y,
    bottom: viewport.screenToWorld(0, height - INSET.bottom + GRID_B_LINE_INSET).y,
    left:   viewport.screenToWorld(INSET.left - GRID_LINE_INSET, 0).x,
    right:  viewport.screenToWorld(width - INSET.right + GRID_NUM_INSET, 0).x,
  };
}

// 1行（TOP/BOTTOM/LEFT/RIGHT）分のアンカー（通り芯CL + 境界に到達している中心線CL）を
// value 昇順で返す。境界に到達しているかは clExtent（オーバーハング込み）で判定する。
// この行の基準線（lineCoord）が描画エリアの外に出る場合は、外書き自体を諦めて
// 中心線を部屋内書きフォールバックに回すため、アンカーを空にする。
function buildRowAnchors(d, graph, viewport, areaBounds) {
  // floorSwapManager.deactivate() がフロアを IDB にスワップアウトする際、
  // activePlaneId 切替前の一瞬だけ graph.clearFloorData() 後の状態（CENTER 寸法行が0件）を
  // 観測してしまうことがある（正規のスワップアウト動作）。d が無い場合は単に何も描かない。
  if (!d) return { boundary: null, anchors: [] };
  const boundary = d.centerBoundary;
  if (boundary == null) return { boundary: null, anchors: [] };

  const isNear    = d.side === DimensionSide.TOP || d.side === DimensionSide.LEFT;
  const lineCoord = isNear ? boundary - offsetMm(viewport) : boundary + offsetMm(viewport);
  const visible = d.axis === 'X'
    ? (lineCoord >= areaBounds.yMin && lineCoord <= areaBounds.yMax)
    : (lineCoord >= areaBounds.xMin && lineCoord <= areaBounds.xMax);
  if (!visible) return { boundary, anchors: [] };

  const gridCLs = d.axis === 'X' ? graph.gridXs : graph.gridYs;
  const myType  = d.axis === 'X' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const centerCLs = graph.centerLines.filter(cl => {
    if (cl.centerLineType !== myType || !isCenterDimensionTarget(cl)) return false;
    const ext = clExtent(cl, graph, viewport);
    return !!ext && ext[0] <= boundary && boundary <= ext[1];
  });
  const anchors = [...gridCLs, ...centerCLs].sort((a, b) => a.value - b.value);
  return { boundary, anchors };
}

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

// 中心線アンカー1本分の「足」(引出線) を、その中心線自身の張り出し線分パターンと
// 位相が連続するように dashOffset を計算して返す。
function legDashOffset(cl, graph, viewport, boundary) {
  const ext = clExtent(cl, graph, viewport);
  if (!ext) return 0;
  return positiveMod(boundary - ext[0], CL_LEG_PERIOD);
}

// 1行（TOP/BOTTOM/LEFT/RIGHT）分の Konva 要素を生成する。
// suppressKeys: 優先側の行で既に表示済みの区間キー（このセットに含まれる区間は数値・引出線を描かない）
function buildRowElements(d, boundary, anchors, suppressKeys, viewport, graph) {
  if (!d || boundary == null || anchors.length === 0) return { elements: [], segKeys: new Set() };

  const segs        = buildSegments(anchors);
  const segKeys     = new Set(segs.map(segKey));
  const visibleSegs = segs.filter(s => !suppressKeys.has(segKey(s)));
  // 表示すべき区間が無い（中心線が1本も絡まない＝純グリッド区間のみ）場合は基準線も含めて何も描かない
  if (visibleSegs.length === 0) return { elements: [], segKeys };

  const isNear    = d.side === DimensionSide.TOP || d.side === DimensionSide.LEFT;
  const offset    = offsetMm(viewport);
  const lineCoord = isNear ? boundary - offset : boundary + offset;

  const dotIds = new Set();
  visibleSegs.forEach(s => { dotIds.add(s.from.id); dotIds.add(s.to.id); });

  const fontSize = NUM_FONT_PX / viewport.scaleX;
  const dotR     = DOT_RADIUS_PX / viewport.scaleX;
  const gap      = TEXT_GAP_PX / viewport.scaleX;

  const keyBase = d.id;
  const segs2 = visibleSegs.map(s => ({
    v1: Math.min(s.from.effectiveValue, s.to.effectiveValue),
    v2: Math.max(s.from.effectiveValue, s.to.effectiveValue),
    length: s.length,
  }));
  const normalNumCoord = lineCoord - fontSize - gap;
  const { line, labels } = dimensionRow({
    keyBase, axis: d.axis, side: d.side, lineCoord, normalNumCoord,
    segments: segs2, color: LINE_COLOR, strokeWidth: viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT], fontSize, gap,
  });

  const els = [line];

  if (d.axis === 'X') {
    anchors.forEach(a => {
      if (!dotIds.has(a.id)) return;
      if (!a.labeled) {
        els.push(
          <Line key={`${keyBase}-ext-${a.id}`} points={[a.effectiveValue, boundary, a.effectiveValue, lineCoord]}
            stroke={CL_LEG_COLOR} strokeWidth={viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT]} strokeScaleEnabled={false}
            dash={CL_LEG_DASH} dashOffset={legDashOffset(a, graph, viewport, boundary)}
            opacity={CL_LEG_OPACITY} listening={false} />
        );
      }
      els.push(
        <Circle key={`${keyBase}-dot-${a.id}`} x={a.effectiveValue} y={lineCoord} radius={dotR}
          fill={LINE_COLOR} listening={false} />
      );
    });
  } else {
    anchors.forEach(a => {
      if (!dotIds.has(a.id)) return;
      if (!a.labeled) {
        els.push(
          <Line key={`${keyBase}-ext-${a.id}`} points={[boundary, a.effectiveValue, lineCoord, a.effectiveValue]}
            stroke={CL_LEG_COLOR} strokeWidth={viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT]} strokeScaleEnabled={false}
            dash={CL_LEG_DASH} dashOffset={legDashOffset(a, graph, viewport, boundary)}
            opacity={CL_LEG_OPACITY} listening={false} />
        );
      }
      els.push(
        <Circle key={`${keyBase}-dot-${a.id}`} x={lineCoord} y={a.effectiveValue} radius={dotR}
          fill={LINE_COLOR} listening={false} />
      );
    });
  }

  els.push(...labels);
  return { elements: els, segKeys };
}

// labeled(通り芯)は常に全域に存在するとみなし制約なし。中心線は生の延伸範囲（はね出し抜き）。
function rawExtent(cl) {
  if (cl.labeled) return [-Infinity, Infinity];
  if (cl.extentLo == null || cl.extentHi == null) return null;
  return [cl.extentLo, cl.extentHi];
}

// cl と neighbor の生の延伸範囲が重なる区間の2/3点を返す。重ならなければ null
// （= その位置には中心線が実在しないので部屋内寸法を書かない）。
// lo === hi（幅ゼロ、単に同じ境界CLを参照していて触れているだけ）は無効とする —
// 例えば中心A=[中心X,Y1]、中心B=[Y2,中心X] のように両者が同じ中心Xを境界に
// 使っているだけで、実際にはどちらの延伸範囲にも互いが入り込んでいないケースがあるため。
// 一方、neighbor が cl の内側に完全に収まる（どちらの端にも届かない）場合でも、
// 実在する中心線であれば鎖の一区間として有効に連結する（隣のさらに隣へと連鎖させる）。
function overlapPos(cl, neighbor) {
  const a = rawExtent(cl), b = rawExtent(neighbor);
  if (!a || !b) return null;
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (!(lo < hi) || !isFinite(lo) || !isFinite(hi)) return null;
  return lo + (hi - lo) * (2 / 3);
}

// all（value昇順）の idx から dir 方向（-1=前方向 / +1=後方向）に進み、
// cl と生の延伸範囲が重なる（=実在が確認できる）最初のCLを返す。
// 直近の隣接CLが重なっていなくても、そのまま諦めずにさらに先を探す
// （例: 中心2の直前が重なりのない中心5でも、その先のX3となら重なるので連結する）。
function findOverlappingNeighbor(all, idx, cl, dir) {
  for (let i = idx + dir; i >= 0 && i < all.length; i += dir) {
    if (overlapPos(cl, all[i]) != null) return all[i];
  }
  return null;
}

// all（value昇順）の idx から dir 方向に進み、最初に見つかる通り芯（labeled）を返す。
// 中心線の重なり判定は無視し、最外フレームとなる通り芯を直接探す
// （連鎖（findOverlappingNeighbor）とは別に、外枠の寸法も合わせて表示するため）。
function findNearestGrid(all, idx, dir) {
  for (let i = idx + dir; i >= 0 && i < all.length; i += dir) {
    if (all[i].labeled) return all[i];
  }
  return null;
}

// neighbor が cl の延伸範囲のどちらの端にも触れず、完全に内側に浮いているかどうか。
// 触れている（=自然に連結している）場合、鎖がそのまま外側まで繋がっていくとみなし、
// cl の段階で別途「外枠」を表示する必要はない（次の要素が自分の外枠を表示する）。
// neighbor が無い場合は常に true（外枠表示の妨げにしない）。
function isNestedWithin(neighbor, cl) {
  if (!neighbor) return true;
  const a = rawExtent(cl), b = rawExtent(neighbor);
  if (!a || !b) return true;
  return !(b[0] <= a[0] || b[1] >= a[1]);
}

// cl と neighbor の間の部屋内寸法（1区間）を描く。重なりが無ければ何も描かない。
function pushFallbackSegment(els, axis, cl, neighbor, suffix, fontSize, dotR, gap, viewport) {
  if (!neighbor) return;
  const pos = overlapPos(cl, neighbor);
  if (pos == null) return; // 中心線の存在しない位置・はね出し部分には書かない
  const clV = cl.effectiveValue;
  const nV  = neighbor.effectiveValue;
  const vA  = Math.min(clV, nV), vB = Math.max(clV, nV);
  const length  = Math.round(Math.abs(nV - clV));
  const keyBase = `fallback-${cl.id}-${suffix}`;

  const side            = axis === 'X' ? DimensionSide.TOP : DimensionSide.LEFT;
  const normalNumCoord  = pos - fontSize - gap;
  const { line, labels } = dimensionRow({
    keyBase, axis, side, lineCoord: pos, normalNumCoord,
    segments: [{ v1: vA, v2: vB, length }], color: LINE_COLOR,
    strokeWidth: viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT], fontSize, gap,
  });

  els.push(line);
  if (axis === 'X') {
    els.push(<Circle key={`${keyBase}-dot-a`} x={clV} y={pos} radius={dotR} fill={LINE_COLOR} listening={false} />);
    els.push(<Circle key={`${keyBase}-dot-b`} x={nV}  y={pos} radius={dotR} fill={LINE_COLOR} listening={false} />);
  } else {
    els.push(<Circle key={`${keyBase}-dot-a`} x={pos} y={clV} radius={dotR} fill={LINE_COLOR} listening={false} />);
    els.push(<Circle key={`${keyBase}-dot-b`} x={pos} y={nV}  radius={dotR} fill={LINE_COLOR} listening={false} />);
  }
  els.push(...labels);
}

// 部屋内書きフォールバック。外書き行（TOP/BOTTOM/LEFT/RIGHT）に表示済みの中心線を除き、
// 最外通り芯に届いていない・外書き行が描画エリア外で出せない、いずれの理由であっても
// LODに関わらず常時表示する（連鎖した部屋内寸法の一部だけが倍率で消えると不自然なため）。
// 隣接CL（prev/next）とは生の延伸範囲が重なる位置（横寸法は下1/3・縦寸法は右1/3点）にのみ描く。
// 重ならない場合（隣接CLがそこに実在しない）はその区間を描かない。
function buildFallbackElements(graph, viewport, axis, anchorsA, anchorsB) {
  const visibleReachIds = new Set([
    ...anchorsA.map(a => a.id),
    ...anchorsB.map(a => a.id),
  ]);

  const myType   = axis === 'X' ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL;
  const gridCLs  = axis === 'X' ? graph.gridXs : graph.gridYs;
  const centerCLs = graph.centerLines.filter(cl => cl.centerLineType === myType && isCenterDimensionTarget(cl));
  const all = [...gridCLs, ...centerCLs].sort((a, b) => a.effectiveValue - b.effectiveValue);

  const fontSize = FALLBACK_FONT_PX / viewport.scaleX;
  const dotR     = DOT_RADIUS_PX / viewport.scaleX;
  const gap      = TEXT_GAP_PX / viewport.scaleX;
  const els = [];

  centerCLs.forEach(cl => {
    if (visibleReachIds.has(cl.id)) return; // 外書き行に表示済み
    if (cl.extentLo == null || cl.extentHi == null) return;

    const idx  = all.findIndex(c => c.id === cl.id);
    const prev = findOverlappingNeighbor(all, idx, cl, -1);
    const next = findOverlappingNeighbor(all, idx, cl, 1);
    if (!prev && !next) return;

    pushFallbackSegment(els, axis, cl, prev, 'prev', fontSize, dotR, gap, viewport);
    pushFallbackSegment(els, axis, cl, next, 'next', fontSize, dotR, gap, viewport);

    // 連鎖の相手が cl の延伸範囲に完全に内包されている（どちらの端にも触れていない）場合のみ、
    // 最外フレームとなる最も近い通り芯も別途表示する。連鎖の相手が cl の端に触れて自然に
    // 繋がっている場合は、その相手自身が次に外枠を表示するので、ここでは重複表示しない。
    const prevGrid = findNearestGrid(all, idx, -1);
    const nextGrid = findNearestGrid(all, idx, 1);
    if (prevGrid && prevGrid !== prev && isNestedWithin(prev, cl)) {
      pushFallbackSegment(els, axis, cl, prevGrid, 'prev-grid', fontSize, dotR, gap, viewport);
    }
    if (nextGrid && nextGrid !== next && isNestedWithin(next, cl)) {
      pushFallbackSegment(els, axis, cl, nextGrid, 'next-grid', fontSize, dotR, gap, viewport);
    }
  });
  return els;
}

// 柱芯寸法線を通り芯寸法(GRID)の基準線から内側へ離す余白（半径相当+OUTWARD、行の軸に応じた向きの
// スケールで換算）。○ラベル廃止後は、ガター逃げ時に柱芯寸法線がGRID基準線へ重ならない離隔としてのみ使う。
function columnAxisPush(axis, viewport) {
  const pushScale = axis === 'X' ? viewport.scaleY : viewport.scaleX;
  return labelCircleRadius(viewport) + OUTWARD / pushScale;
}

// 1行分の柱芯アンカーを value 昇順で返す。中心線版の部屋内フォールバックとは異なり、
// 柱芯はグリッドからのオフセットのみで決まる1:1の点で「浮いた中心線」が存在しないため、
// 重なり判定・連鎖探索は不要——外側オフセット位置が描画エリア外に出る（柱芯がガーターへ
// 逃げる）場合でも、柱芯寸法線は通り芯寸法(GRID)の基準線（gridBounds、gridLineBounds参照）
// より外（ガーター側）へは出さず、その内側（モデル側）2*push分の位置で止める。丸ラベルは
// 自分の寸法線からpush分しか離れない（buildColumnAxisRowElements参照）ため、停止位置を
// GRID基準線とちょうど揃える（=0オフセット）と二つの寸法線自体が重なってしまう。2*push分
// 内側に留めることで「GRID基準線 → 丸ラベル → 柱芯寸法線」の順にpush間隔で並び、GRID基準線が
// 常に最も外側、丸ラベルが両方の寸法線からちょうどpushずつ離れた、重なりのない配置になる
// （丸ラベル自体のクランプは buildColumnAxisRowElements 側で行う）。
function buildColumnAxisAnchors(d, graph, viewport, gridBounds) {
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
    if (off !== 0) points.push({ id: `${cl.id}:grid`, value: cl.effectiveValue });
    points.push({ id: `${cl.id}:axis`, value: cl.effectiveValue + off });
  });
  points.sort((a, b) => a.value - b.value);
  return { boundary, lineCoord, anchors: points };
}

// 隣接アンカー間のセグメント（中心線版と異なり「両端通り芯のみは除外」のような間引きは行わない —
// 柱芯アンカーは通り芯と同位置の点を重複して持たないため、間引く対象が発生しない）。
function buildColumnAxisSegments(anchors) {
  const segs = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    segs.push({ from: anchors[i], to: anchors[i + 1], length: Math.round(anchors[i + 1].value - anchors[i].value) });
  }
  return segs;
}

// 1行（TOP/BOTTOM/LEFT/RIGHT）分の柱芯Konva要素を生成する。lineCoord は
// buildColumnAxisAnchors が算出済み（描画エリア外ならGRID基準線の内側2*push分にクランプ済み）の値を使う。
// ○ラベル（旧 SX/SY 丸）は廃止したため、寸法線・寸法値・アンカー点（通り芯⇄柱芯の偏芯量を示す点）のみを描く。
function buildColumnAxisRowElements(d, boundary, lineCoord, anchors, viewport) {
  if (!d || boundary == null || anchors.length < 2) return [];

  const segs = buildColumnAxisSegments(anchors);

  const fontSize = NUM_FONT_PX / viewport.scaleX;
  const dotR     = DOT_RADIUS_PX / viewport.scaleX;
  const gap      = TEXT_GAP_PX / viewport.scaleX;
  const normalNumCoord = lineCoord - fontSize - gap;

  const keyBase = d.id;

  const segs2 = segs.map(s => ({
    v1: Math.min(s.from.value, s.to.value), v2: Math.max(s.from.value, s.to.value), length: s.length,
  }));
  const { line, labels } = dimensionRow({
    keyBase, axis: d.axis, side: d.side, lineCoord, normalNumCoord,
    segments: segs2, color: LINE_COLOR, strokeWidth: viewport.lineWeightsPx[DIMENSION_LINE_WEIGHT], fontSize, gap,
  });

  const els = [line, ...labels];

  anchors.forEach(a => {
    const [dx, dy] = d.axis === 'X' ? [a.value, lineCoord] : [lineCoord, a.value];
    els.push(
      <Circle key={`${keyBase}-dot-${a.id}`} x={dx} y={dy} radius={dotR} fill={LINE_COLOR} listening={false} />
    );
  });
  return els;
}

// 柱芯寸法線の位置（lineCoord、ガター逃げ時はGRID基準線の内側にクランプ済み）を4辺分まとめて返す。
// CenterLinesLayer が建物内の柱芯（一点鎖線）の端点をこの位置まで伸ばすために使う——○ラベル廃止後は
// 寸法線側に足を引かず、軸線自体を自分の柱芯寸法線まで届かせることで足無しの見た目を保つ。
function columnAxisLineCoords(graph, viewport, width, height) {
  const gridBounds = gridLineBounds(viewport, width, height);
  const rows   = graph.dimensionLines.filter(d => d.dimensionKind === DimensionKind.CENTER);
  const find   = side => rows.find(d => d.side === side);
  const lineCoordFor = side => {
    const d = find(side);
    if (!d) return null;
    const { lineCoord } = buildColumnAxisAnchors(d, graph, viewport, gridBounds);
    return lineCoord;
  };
  return {
    top:    lineCoordFor(DimensionSide.TOP),
    bottom: lineCoordFor(DimensionSide.BOTTOM),
    left:   lineCoordFor(DimensionSide.LEFT),
    right:  lineCoordFor(DimensionSide.RIGHT),
  };
}

const CenterDimensions = observer(({ graph, viewport, width, height, columnAxisMode = false }) => {
  if (!graph) return null;

  const areaBounds = drawingAreaBounds(viewport, width, height);

  const rows   = graph.dimensionLines.filter(d => d.dimensionKind === DimensionKind.CENTER);
  const top    = rows.find(d => d.side === DimensionSide.TOP);
  const bottom = rows.find(d => d.side === DimensionSide.BOTTOM);
  const left   = rows.find(d => d.side === DimensionSide.LEFT);
  const right  = rows.find(d => d.side === DimensionSide.RIGHT);

  if (columnAxisMode) {
    const gridBounds = gridLineBounds(viewport, width, height);
    const { boundary: topB,    lineCoord: topL,    anchors: topA    } = buildColumnAxisAnchors(top,    graph, viewport, gridBounds);
    const { boundary: bottomB, lineCoord: bottomL, anchors: bottomA } = buildColumnAxisAnchors(bottom, graph, viewport, gridBounds);
    const { boundary: leftB,   lineCoord: leftL,   anchors: leftA   } = buildColumnAxisAnchors(left,   graph, viewport, gridBounds);
    const { boundary: rightB,  lineCoord: rightL,  anchors: rightA  } = buildColumnAxisAnchors(right,  graph, viewport, gridBounds);
    return [
      ...buildColumnAxisRowElements(top,    topB,    topL,    topA,    viewport),
      ...buildColumnAxisRowElements(bottom, bottomB, bottomL, bottomA, viewport),
      ...buildColumnAxisRowElements(left,   leftB,   leftL,   leftA,   viewport),
      ...buildColumnAxisRowElements(right,  rightB,  rightL,  rightA, viewport),
    ];
  }

  const { boundary: topB,    anchors: topA    } = buildRowAnchors(top,    graph, viewport, areaBounds);
  const { boundary: bottomB, anchors: bottomA } = buildRowAnchors(bottom, graph, viewport, areaBounds);
  const { boundary: leftB,   anchors: leftA   } = buildRowAnchors(left,   graph, viewport, areaBounds);
  const { boundary: rightB,  anchors: rightA  } = buildRowAnchors(right,  graph, viewport, areaBounds);

  const topRes    = buildRowElements(top,    topB,    topA,    new Set(),         viewport, graph);
  const bottomRes = buildRowElements(bottom, bottomB, bottomA, topRes.segKeys,    viewport, graph);
  const leftRes   = buildRowElements(left,   leftB,   leftA,   new Set(),         viewport, graph);
  const rightRes  = buildRowElements(right,  rightB,  rightA,  leftRes.segKeys,   viewport, graph);

  const fallbackX = buildFallbackElements(graph, viewport, 'X', topA,  bottomA);
  const fallbackY = buildFallbackElements(graph, viewport, 'Y', leftA, rightA);

  return [
    ...topRes.elements, ...bottomRes.elements,
    ...leftRes.elements, ...rightRes.elements,
    ...fallbackX, ...fallbackY,
  ];
});

// ---- 統合エクスポート ----
export const GutterLayer = observer(({ graph, viewport, width, height, columnAxisMode = false }) => {
  if (!graph) return null;
  const axisLineCoords = columnAxisMode
    ? columnAxisLineCoords(graph, viewport, width, height)
    : null;
  return (
    <>
      <CenterLinesLayer graph={graph} viewport={viewport} width={width} height={height}
        columnAxisMode={columnAxisMode} axisLineCoords={axisLineCoords} />
      <GutterCircleLabels graph={graph} viewport={viewport} width={width} height={height} />
      <GridDimensions graph={graph} viewport={viewport} width={width} height={height} />
      <CenterDimensions graph={graph} viewport={viewport} width={width} height={height} columnAxisMode={columnAxisMode} />
    </>
  );
});
