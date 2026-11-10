/**
 * 敷地モードの配置図に重ねる通り芯（線＋両端の丸ラベル）と通り芯どうしの寸法を組む純モジュール。
 * renderer/SitePlacementLayer.jsx がこの結果を写すだけで描く（判断はここに集める）。
 * store.js・snap.js・.jsx・structural/roofFramingRegions.js を静的に import しない（node:test から単体で import できる）。
 *
 * 3段構え:
 *   gridLineSnapshot       … 配置図を開いた時点の通り芯の写し（SiteModeState._loadPlacement が呼ぶ。以降 graph を読まない）
 *   composeSitePlacementGrid … ズーム非依存の判断（枠・描く線・寸法の行と区間）
 *   layoutSitePlacementGrid  … 画面 px の離れを世界座標へ直した配置（ガターと同じ画面注記。ズームで離れが一定 px）
 * 寸法は上（X 行）・左（Y 行）。その外の段に「はなれ寸法」（最外周の通り芯と敷地の境界線の距離）を足す（S14。
 * 下・右は上・左と値が違うときだけ、はなれだけの行）。枠 frame＝屋根の外接矩形 ∪ 通り芯の範囲 ∪ 敷地の外周の外接矩形（siteBounds）。
 * 寸法行も線も丸ラベルも frame の外へ出す（敷地の外。2026-11-10）。屋根∪通り芯が無い軸は敷地があっても描かない。
 * 丸の中心＝枠の縁から（寸法行の外＋OUTWARD＋半径）。線の端は丸の縁で止める。
 * 図芯の基準（sitePlacementView の buildingCenter）には触れない（ここで作る枠は図芯に使わない）。
 */
import { CenterLineType, DimensionSide, CL_OVERLAP_TOL_MM, SITE_PLACEMENT_GRID_DIM_OFFSET_PX, SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX, SITE_PLACEMENT_GRID_TOTAL_MIN_LINES } from '../core/constants.js';
import { gridCenterLinesOnAxis } from '../core/centerLineKindPolicy.js';
import { OUTWARD, labelCircleRadius } from '../layout.js';
import { NUM_FONT_PX, TEXT_GAP_PX } from '../renderer/dimensionStyle.js';

// Konva の key の組み立て部品。種別ごとの id 空間の衝突を避けるためだけに付け、比較には使わない。
const GRID_KEY_PREFIX = Object.freeze({ LINE: 'gl', LABEL: 'gb', ROW: 'gr', GAP: 'gap', DOT: 'gd', END_LO: 'a', END_HI: 'b' });

/** 寸法の段（0＝隣接する通り芯の間隔、1＝最外どうしの全長）。
 *  はなれの行の tier＝既存の段数（上・左）／0（下・右）。GAP は key の部品（行の種別）。 */
const GridDimTier = Object.freeze({ SPACING: 0, TOTAL: 1 });

const { LEFT, RIGHT, TOP, BOTTOM } = DimensionSide;
const isLoSide = side => side === TOP || side === LEFT;

/**
 * 通り芯の写し（VERTICAL 昇順 → HORIZONTAL 昇順）。graph が無ければ []。
 * 通り芯の判定は centerLineKindPolicy.gridCenterLinesOnAxis に任せ、ここで生の labeled・discipline を読まない。
 * @returns {Array<{id:string, centerLineType:string, value:number, label:string}>}
 */
export function gridLineSnapshot(graph) {
  if (!graph) return [];
  return [CenterLineType.VERTICAL, CenterLineType.HORIZONTAL].flatMap(type =>
    gridCenterLinesOnAxis(graph, type).map(cl => ({ id: cl.id, centerLineType: type, value: cl.value, label: cl.label ?? '' })));
}

/**
 * 通り芯の写しの各要素に「外周の通り芯か」（exterior）を付けた新配列（元の配列・要素は変えない）。
 * 外周の通り芯＝建物外形の辺（外壁ループ outer）が載る通り芯。gridLines のうち exteriorIds に一致するものが 0 本
 * （外壁が 1 本も無い・外壁の軸がすべて通り芯でない等で外周が判定できない）ときは全部を候補にする（全部 exterior: true。
 * リード裁定 2026-11-10）。
 * @param {Array<{id:string}>} gridLines
 * @param {Iterable<string>} exteriorIds
 * @returns {Array<object>}
 */
export function markExteriorGridLines(gridLines, exteriorIds) {
  const ids = new Set(exteriorIds ?? []);
  const anyMatch = gridLines.some(g => ids.has(g.id));
  return gridLines.map(g => ({ ...g, exterior: !anyMatch || ids.has(g.id) }));
}

/** 値の列と範囲の端（null 可）を合わせた [最小, 最大]。どちらも無ければ null。 */
function spanOf(values, lo, hi) {
  const all = [...values, ...(lo == null ? [] : [lo, hi])];
  return all.length === 0 ? null : [Math.min(...all), Math.max(...all)];
}

/**
 * 点 (ox, oy) から軸方向 (dx, dy) の半直線が、線分群と最初に交わるまでの距離。交わらなければ null。
 * 線分の端点に当たるときは（端点を共有する 2 本でも）最小の t だけを採るので 1 回と数える（端の判定は CL_OVERLAP_TOL_MM の幅だけ緩める）。
 */
function rayDistance(ox, oy, dx, dy, segs) {
  let best = null;
  for (const [ax, ay, bx, by] of segs) {
    const ex = bx - ax, ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (denom === 0) continue; // 半直線と平行（長さ 0 の線分も）
    const px = ax - ox, py = ay - oy;
    const t = (px * ey - py * ex) / denom;
    const s = (px * dy - py * dx) / denom;
    const tol = CL_OVERLAP_TOL_MM / Math.hypot(ex, ey);
    if (t > 0 && s >= -tol && s <= 1 + tol && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * はなれ寸法（最外周の通り芯と敷地の境界線の距離）。
 * 各側（左・右・上・下）の最外周の通り芯（左右＝VERTICAL の最小・最大、上下＝HORIZONTAL の最小・最大。y 下向き正なので上＝最小）から、
 * 直交する軸の最外周の通り芯 2 本の位置（1 本ならその 1 位置）で外向きに半直線を出し、敷地の外周との最初の交点までを測る。
 * 直交する軸の通り芯が 0 本の側・交点が無い位置は出さない。
 * @param {object} p
 * @param {Array<{centerLineType:string, value:number}>} p.gridLines
 * @param {Array<{points:number[]}>} p.siteSegments 配置図座標へ写した敷地の外周の線分（[x1,y1,x2,y2]）
 * @returns {Array<{side:string, pos:number, from:number, to:number, length:number}>} 側（LEFT・RIGHT・TOP・BOTTOM）ごと pos 昇順。from＝通り芯の値・to＝境界線との交点の座標
 */
export function computeSiteGapDimensions({ gridLines, siteSegments }) {
  const segs = (siteSegments ?? []).map(s => s.points).filter(p => p?.length >= 4);
  const valuesOf = type => gridLines.filter(g => g.centerLineType === type).map(g => g.value);
  const xs = valuesOf(CenterLineType.VERTICAL);
  const ys = valuesOf(CenterLineType.HORIZONTAL);
  if (segs.length === 0 || xs.length === 0 || ys.length === 0) return [];
  const positionsOf = values => {
    const lo = Math.min(...values), hi = Math.max(...values);
    return lo === hi ? [lo] : [lo, hi];
  };
  // [側, 通り芯の値, 測る位置の列, 外向き dx, dy, 水平（x 方向）に測るか]
  const specs = [
    [LEFT, Math.min(...xs), positionsOf(ys), -1, 0, true],
    [RIGHT, Math.max(...xs), positionsOf(ys), 1, 0, true],
    [TOP, Math.min(...ys), positionsOf(xs), 0, -1, false],
    [BOTTOM, Math.max(...ys), positionsOf(xs), 0, 1, false],
  ];
  const out = [];
  for (const [side, value, positions, dx, dy, horizontal] of specs) {
    for (const pos of positions) {
      const d = horizontal ? rayDistance(value, pos, dx, dy, segs) : rayDistance(pos, value, dx, dy, segs);
      if (d === null) continue;
      out.push({ side, pos, from: value, to: value + (horizontal ? dx : dy) * d, length: Math.round(d) });
    }
  }
  return out;
}

/** 位置 pos のはなれを、loSide（−方向）は [to, from]・hiSide（＋方向）は [from, to] の区間（v1 昇順）にしたもの。 */
function gapSegmentsAt(gaps, loSide, hiSide, pos) {
  return gaps.filter(g => g.pos === pos && (g.side === loSide || g.side === hiSide))
    .map(g => (g.side === loSide
      ? { measured: g.side, v1: g.to, v2: g.from, length: g.length }
      : { measured: g.side, v1: g.from, v2: g.to, length: g.length }))
    .sort((a, b) => a.v1 - b.v1);
}

/**
 * はなれ寸法の行。上（x 方向）は上端（HORIZONTAL 最小）で測った左右のはなれ、左（y 方向）は左端（VERTICAL 最小）で測った上下のはなれ。
 * 下・右の行は、反対の端（最大）で測った値が 1 つでも違うときだけ出す（等しければ重複なので出さない）。
 * @param {Array<object>} rows 既存の行（上・左の段数を数える）
 */
function gapRows(gaps, axisOf, rows) {
  const out = [];
  for (const [axis, loSide, hiSide, crossLo, crossHi, perpLo, perpHi] of [
    [CenterLineType.VERTICAL, TOP, BOTTOM, axisOf.minH, axisOf.maxH, LEFT, RIGHT],
    [CenterLineType.HORIZONTAL, LEFT, RIGHT, axisOf.minV, axisOf.maxV, TOP, BOTTOM],
  ]) {
    const lenAt = (side, pos) => gaps.find(g => g.side === side && g.pos === pos)?.length;
    // はなれの行は測った側ごとに 1 行（区間だけに線を引く。左右の区間の間＝通り芯の範囲に数値なしの線を通さない）。同じ段（tier）に並ぶ
    const add = (side, tier, found) => {
      for (const { measured, v1, v2, length } of found) {
        out.push({
          key: `${GRID_KEY_PREFIX.ROW}/${axis}/${GRID_KEY_PREFIX.GAP}/${side}/${measured}`, axis, side, tier,
          segments: [{ v1, v2, length }], anchors: [v1, v2],
        });
      }
    };
    const loTier = new Set(rows.filter(r => r.side === loSide).map(r => r.tier)).size;
    add(loSide, loTier, gapSegmentsAt(gaps, perpLo, perpHi, crossLo));
    if ([perpLo, perpHi].some(side => lenAt(side, crossLo) !== lenAt(side, crossHi))) {
      add(hiSide, 0, gapSegmentsAt(gaps, perpLo, perpHi, crossHi));
    }
  }
  return out;
}

/**
 * ズーム非依存の判断。
 * @param {object} p
 * @param {Array<{id:string, centerLineType:string, value:number, label:string, exterior?:boolean}>} p.gridLines gridLineSnapshot（＋markExteriorGridLines）の結果（軸ごとに value 昇順）
 * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} p.roofBounds 屋根の線の外接矩形
 * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} [p.siteBounds] 配置図座標での敷地の外周の外接矩形
 * @param {Array<{points:number[]}>} [p.siteSegmentsPlaced] 配置図座標へ写した敷地の外周の線分（はなれ寸法の測り先。無ければ出さない）
 * @returns {{
 *   frame: {x:[number,number]|null, y:[number,number]|null},
 *   lines: Array<{key:string, id:string, centerLineType:string, value:number, label:string, exterior:boolean}>,
 *   rows: Array<{key:string, axis:string, side:string, tier:number,
 *                segments:Array<{v1:number, v2:number, length:number}>, anchors:number[]}>,
 * }}
 */
export function composeSitePlacementGrid({ gridLines, roofBounds, siteBounds = null, siteSegmentsPlaced = [] }) {
  const valuesOf = type => gridLines.filter(g => g.centerLineType === type).map(g => g.value);
  const xs = valuesOf(CenterLineType.VERTICAL);
  const ys = valuesOf(CenterLineType.HORIZONTAL);
  // 枠＝屋根の外接矩形 ∪ 通り芯の範囲 ∪ 敷地の外周の外接矩形。屋根∪通り芯が無い軸は null のまま
  // （敷地だけで枠ができて線が描かれないように。描く判定は敷地を含めない枠が有るかどうか＝widen が null を保つ）
  const widen = (span, lo, hi) => (span == null || lo == null ? span : [Math.min(span[0], lo), Math.max(span[1], hi)]);
  const frame = {
    x: widen(spanOf(xs, roofBounds?.minX, roofBounds?.maxX), siteBounds?.minX, siteBounds?.maxX),
    y: widen(spanOf(ys, roofBounds?.minY, roofBounds?.maxY), siteBounds?.minY, siteBounds?.maxY),
  };

  // 縦線（X）は上下の端を決める y の枠、横線（Y）は x の枠が要る。片方の枠が無い軸は線も寸法も描かない。
  const drawable = g => (g.centerLineType === CenterLineType.VERTICAL ? frame.y : frame.x) != null;
  const lines = gridLines.filter(drawable).map(g => ({
    key: `${GRID_KEY_PREFIX.LINE}/${g.id}`, id: g.id, centerLineType: g.centerLineType, value: g.value, label: g.label,
    exterior: !!g.exterior,
  }));

  const rows = [];
  for (const [axis, values, side] of [
    [CenterLineType.VERTICAL, xs, DimensionSide.TOP],
    [CenterLineType.HORIZONTAL, ys, DimensionSide.LEFT],
  ]) {
    if (!drawable({ centerLineType: axis })) continue;
    // dimensionRow（renderer/gutterPrimitives.jsx）の axis は 'X'/'Y'＝CenterLineType の値と同じ前提
    const segOf = (v1, v2) => ({ v1, v2, length: Math.round(v2 - v1) });
    if (values.length >= 2) {
      rows.push({
        key: `${GRID_KEY_PREFIX.ROW}/${axis}/${GridDimTier.SPACING}`, axis, side, tier: GridDimTier.SPACING,
        segments: values.slice(1).map((v, i) => segOf(values[i], v)), anchors: values,
      });
    }
    if (values.length >= SITE_PLACEMENT_GRID_TOTAL_MIN_LINES) {
      const first = values[0], last = values[values.length - 1];
      rows.push({
        key: `${GRID_KEY_PREFIX.ROW}/${axis}/${GridDimTier.TOTAL}`, axis, side, tier: GridDimTier.TOTAL,
        segments: [segOf(first, last)], anchors: [first, last],
      });
    }
  }
  // はなれ寸法（敷地が無ければ無し。配置指定の有無に依らない）。行の位置は両軸の枠が要る
  if (frame.x != null && frame.y != null) {
    const gaps = computeSiteGapDimensions({ gridLines, siteSegments: siteSegmentsPlaced });
    if (gaps.length > 0) {
      rows.push(...gapRows(gaps, { minH: Math.min(...ys), maxH: Math.max(...ys), minV: Math.min(...xs), maxV: Math.max(...xs) }, rows));
    }
  }
  return { frame, lines, rows };
}

/**
 * 画面 px の離れ（寸法線・数値・丸ラベル）を世界座標（mm）へ直した配置。
 * @param {ReturnType<typeof composeSitePlacementGrid>} grid
 * @param {number} scale viewport.scaleX（世界 mm → 画面 px の倍率）
 * @returns {{
 *   lines: Array<{key:string, points:number[]}>,
 *   labels: Array<{key:string, id:string, exterior:boolean, x:number, y:number, label:string}>,
 *   rows: Array<{key:string, axis:string, side:string, lineCoord:number, normalNumCoord:number,
 *                segments:object[], dots:Array<{key:string, x:number, y:number}>}>,
 * }}
 */
export function layoutSitePlacementGrid(grid, scale) {
  const px = n => n / scale;
  const r = labelCircleRadius({ scaleX: scale });
  const { frame } = grid;
  const isX = axis => axis === CenterLineType.VERTICAL;
  // 段数＝tier の種類数（はなれの行が側ごとに分かれても同じ段なので増えない）
  const sideCount = side => new Set(grid.rows.filter(row => row.side === side).map(row => row.tier)).size;
  // 丸の中心の、枠（敷地込み）の縁からの離れ（その側の最も外の寸法行の数値帯の外＋OUTWARD＋半径）。
  // 上・左は上・左の行数。下・右は、その側に行があればその行数、無ければ上・左と同じ（従来どおり両端で同じ距離）
  const labelDistFor = count => px(SITE_PLACEMENT_GRID_DIM_OFFSET_PX + (Math.max(count, 1) - 1) * SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX
    + NUM_FONT_PX + TEXT_GAP_PX + OUTWARD) + r;
  const labelDists = type => {
    const [lo, hi] = type === CenterLineType.VERTICAL ? [TOP, BOTTOM] : [LEFT, RIGHT];
    return { lo: labelDistFor(sideCount(lo)), hi: labelDistFor(sideCount(hi) > 0 ? sideCount(hi) : sideCount(lo)) };
  };

  const lines = [];
  const labels = [];
  for (const g of grid.lines) {
    // 縦線（X）は y の枠の上下、横線（Y）は x の枠の左右の外に丸を置く（枠の縁から labelDist）。
    // 線は丸の縁（中心から r 手前）で止める（塗りなしのラベルの文字の下を線が通らないように）
    const [flo, fhi] = isX(g.centerLineType) ? frame.y : frame.x;
    const d = labelDists(g.centerLineType);
    const a = flo - d.lo, b = fhi + d.hi;
    const [ax, ay, bx, by] = isX(g.centerLineType) ? [g.value, a, g.value, b] : [a, g.value, b, g.value];
    const [lax, lay, lbx, lby] = isX(g.centerLineType) ? [g.value, a + r, g.value, b - r] : [a + r, g.value, b - r, g.value];
    lines.push({ key: g.key, points: [lax, lay, lbx, lby] });
    labels.push({ key: `${GRID_KEY_PREFIX.LABEL}/${g.id}/${GRID_KEY_PREFIX.END_LO}`, id: g.id, exterior: g.exterior, x: ax, y: ay, label: g.label });
    labels.push({ key: `${GRID_KEY_PREFIX.LABEL}/${g.id}/${GRID_KEY_PREFIX.END_HI}`, id: g.id, exterior: g.exterior, x: bx, y: by, label: g.label });
  }

  const rows = grid.rows.map(row => {
    // 上・左の行は枠の lo の縁から外（−）へ、下・右の行は hi の縁から外（＋）へ。数値は線の外側
    const lo = isLoSide(row.side);
    const [flo, fhi] = isX(row.axis) ? frame.y : frame.x;
    const away = px(SITE_PLACEMENT_GRID_DIM_OFFSET_PX + row.tier * SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX);
    const lineCoord = lo ? flo - away : fhi + away;
    return {
      key: row.key, axis: row.axis, side: row.side, lineCoord,
      normalNumCoord: lo ? lineCoord - px(NUM_FONT_PX) - px(TEXT_GAP_PX) : lineCoord + px(TEXT_GAP_PX),
      segments: row.segments,
      dots: row.anchors.map((v, i) => ({
        key: `${GRID_KEY_PREFIX.DOT}/${row.key}/${i}`,
        x: isX(row.axis) ? v : lineCoord, y: isX(row.axis) ? lineCoord : v,
      })),
    };
  });
  return { lines, labels, rows };
}
