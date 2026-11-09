/**
 * 敷地モードの配置図に重ねる通り芯（線＋両端の丸ラベル）と通り芯どうしの寸法を組む純モジュール。
 * renderer/SitePlacementLayer.jsx がこの結果を写すだけで描く（判断はここに集める）。
 * store.js・snap.js・.jsx・structural/roofFramingRegions.js を静的に import しない（node:test から単体で import できる）。
 *
 * 3段構え:
 *   gridLineSnapshot       … 配置図を開いた時点の通り芯の写し（SiteModeState._loadPlacement が呼ぶ。以降 graph を読まない）
 *   composeSitePlacementGrid … ズーム非依存の判断（枠・描く線・寸法の行と区間）
 *   layoutSitePlacementGrid  … 画面 px の離れを世界座標へ直した配置（ガターと同じ画面注記。ズームで離れが一定 px）
 * 寸法は上（X 行）・左（Y 行）の片側だけ。枠＝屋根の外接矩形と通り芯の範囲の和（敷地の外周は含めない）。
 * 図芯の基準（sitePlacementView の buildingCenter）には触れない（ここで作る枠は図芯に使わない）。
 */
import { CenterLineType, DimensionSide, SITE_PLACEMENT_GRID_DIM_OFFSET_PX, SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX, SITE_PLACEMENT_GRID_TOTAL_MIN_LINES } from '../core/constants.js';
import { gridCenterLinesOnAxis } from '../core/centerLineKindPolicy.js';
import { OUTWARD, labelCircleRadius } from '../layout.js';
import { NUM_FONT_PX, TEXT_GAP_PX } from '../renderer/dimensionStyle.js';

// Konva の key の組み立て部品。種別ごとの id 空間の衝突を避けるためだけに付け、比較には使わない。
const GRID_KEY_PREFIX = Object.freeze({ LINE: 'gl', LABEL: 'gb', ROW: 'gr', DOT: 'gd', END_LO: 'a', END_HI: 'b' });

/** 寸法の段（0＝隣接する通り芯の間隔、1＝最外どうしの全長）。 */
const GridDimTier = Object.freeze({ SPACING: 0, TOTAL: 1 });

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

/** 値の列と範囲の端（null 可）を合わせた [最小, 最大]。どちらも無ければ null。 */
function spanOf(values, lo, hi) {
  const all = [...values, ...(lo == null ? [] : [lo, hi])];
  return all.length === 0 ? null : [Math.min(...all), Math.max(...all)];
}

/**
 * ズーム非依存の判断。
 * @param {object} p
 * @param {Array<{id:string, centerLineType:string, value:number, label:string}>} p.gridLines gridLineSnapshot の結果（軸ごとに value 昇順）
 * @param {{minX:number, minY:number, maxX:number, maxY:number}|null} p.roofBounds 屋根の線の外接矩形
 * @returns {{
 *   frame: {x:[number,number]|null, y:[number,number]|null},
 *   lines: Array<{key:string, id:string, centerLineType:string, value:number, label:string}>,
 *   rows: Array<{key:string, axis:string, side:string, tier:number,
 *                segments:Array<{v1:number, v2:number, length:number}>, anchors:number[]}>,
 * }}
 */
export function composeSitePlacementGrid({ gridLines, roofBounds }) {
  const valuesOf = type => gridLines.filter(g => g.centerLineType === type).map(g => g.value);
  const xs = valuesOf(CenterLineType.VERTICAL);
  const ys = valuesOf(CenterLineType.HORIZONTAL);
  const frame = {
    x: spanOf(xs, roofBounds?.minX, roofBounds?.maxX),
    y: spanOf(ys, roofBounds?.minY, roofBounds?.maxY),
  };

  // 縦線（X）は上下の端を決める y の枠、横線（Y）は x の枠が要る。片方の枠が無い軸は線も寸法も描かない。
  const drawable = g => (g.centerLineType === CenterLineType.VERTICAL ? frame.y : frame.x) != null;
  const lines = gridLines.filter(drawable).map(g => ({
    key: `${GRID_KEY_PREFIX.LINE}/${g.id}`, id: g.id, centerLineType: g.centerLineType, value: g.value, label: g.label,
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
  return { frame, lines, rows };
}

/**
 * 画面 px の離れ（寸法線・数値・丸ラベル）を世界座標（mm）へ直した配置。
 * @param {ReturnType<typeof composeSitePlacementGrid>} grid
 * @param {number} scale viewport.scaleX（世界 mm → 画面 px の倍率）
 * @returns {{
 *   lines: Array<{key:string, points:number[]}>,
 *   labels: Array<{key:string, x:number, y:number, label:string}>,
 *   rows: Array<{key:string, axis:string, side:string, lineCoord:number, normalNumCoord:number,
 *                segments:object[], dots:Array<{key:string, x:number, y:number}>}>,
 * }}
 */
export function layoutSitePlacementGrid(grid, scale) {
  const px = n => n / scale;
  const r = labelCircleRadius({ scaleX: scale });
  const { frame } = grid;
  const isX = axis => axis === CenterLineType.VERTICAL;
  const rowCount = axis => grid.rows.filter(row => row.axis === axis).length;
  // 丸の中心の、枠からの離れ（最も外の寸法行の数値帯の外＋OUTWARD＋半径。両端とも同じ）
  const labelDist = axis => px(SITE_PLACEMENT_GRID_DIM_OFFSET_PX + (Math.max(rowCount(axis), 1) - 1) * SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX
    + NUM_FONT_PX + TEXT_GAP_PX + OUTWARD) + r;

  const lines = [];
  const labels = [];
  for (const g of grid.lines) {
    // 縦線（X）は y の枠の上下、横線（Y）は x の枠の左右の外に丸を置く
    const [lo, hi] = isX(g.centerLineType) ? frame.y : frame.x;
    const d = labelDist(g.centerLineType);
    const a = lo - d, b = hi + d;
    const [ax, ay, bx, by] = isX(g.centerLineType) ? [g.value, a, g.value, b] : [a, g.value, b, g.value];
    lines.push({ key: g.key, points: [ax, ay, bx, by] });
    labels.push({ key: `${GRID_KEY_PREFIX.LABEL}/${g.id}/${GRID_KEY_PREFIX.END_LO}`, x: ax, y: ay, label: g.label });
    labels.push({ key: `${GRID_KEY_PREFIX.LABEL}/${g.id}/${GRID_KEY_PREFIX.END_HI}`, x: bx, y: by, label: g.label });
  }

  const rows = grid.rows.map(row => {
    const edge = isX(row.axis) ? frame.y[0] : frame.x[0];
    const lineCoord = edge - px(SITE_PLACEMENT_GRID_DIM_OFFSET_PX + row.tier * SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX);
    return {
      key: row.key, axis: row.axis, side: row.side, lineCoord,
      normalNumCoord: lineCoord - px(NUM_FONT_PX) - px(TEXT_GAP_PX),
      segments: row.segments,
      dots: row.anchors.map((v, i) => ({
        key: `${GRID_KEY_PREFIX.DOT}/${row.key}/${i}`,
        x: isX(row.axis) ? v : lineCoord, y: isX(row.axis) ? lineCoord : v,
      })),
    };
  });
  return { lines, labels, rows };
}
