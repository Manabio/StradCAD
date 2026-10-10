/**
 * 天井区画の形状・寸法の入力欄の表と検証（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏パネル（CeilingPanel.jsx）が欄を組むときの唯一の表。寸法欄は「寸法1・寸法2…」の汎用欄で、形状が違っても欄を共用する
 * （形状ごとに意味とラベルだけ変わる）。個数・値域の定義は core/ceilingZone.js（CEILING_SHAPE_DIM_COUNT・validCeilingDims）。
 *
 * 基準高（heightMm）の意味: 平面＝天井高／傾斜＝低い側の高さ／円弧・ドーム＝周縁の高さ。空欄＝部屋の CH。
 * 4形状とも選べる（S6b）。階段所属のセル群への初期値は stairCeilingSlopeDefaults。
 */
import { CEILING_SHAPE_DIM_COUNT, SLOPE_DIRS_DEG, ARC_AXES_DEG, validCeilingDims } from '../core/ceilingZone.js';
import { CeilingShape as Shape, StairType } from '../core/constants.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { ceilingRefreshCells } from './ceilingGrid.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { riserOf } from '../finish/stair/stairDimensions.js';

/** 形状の選択肢（S6b で4形状とも選べる）。 */
export const CEILING_SHAPE_OPTIONS = Object.freeze([
  { value: Shape.FLAT,  label: '平面' },
  { value: Shape.SLOPE, label: '傾斜' },
  { value: Shape.ARC,   label: '円弧' },
  { value: Shape.DOME,  label: 'ドーム' },
]);

/** 基準高の欄のラベル（形状ごと）。 */
export const CEILING_BASE_LABEL = Object.freeze({
  [Shape.FLAT]: '天井高', [Shape.SLOPE]: '低い側', [Shape.ARC]: '周縁', [Shape.DOME]: '周縁',
});

const UP_DIR_OPTIONS = SLOPE_DIRS_DEG.map(v => ({ value: v, label: { 0: '→ 右', 90: '↓ 下', 180: '← 左', 270: '↑ 上' }[v] }));
const AXIS_OPTIONS = ARC_AXES_DEG.map(v => ({ value: v, label: v === 0 ? '横' : '縦' }));

/** 寸法欄の定義（形状ごと。配列の長さは CEILING_SHAPE_DIM_COUNT と一致する）。 */
export const CEILING_DIM_FIELDS = Object.freeze({
  [Shape.FLAT]: Object.freeze([]),
  [Shape.SLOPE]: Object.freeze([
    { label: 'ライズ', unit: 'mm', input: 'number' },
    { label: '上がる向き', input: 'select', options: UP_DIR_OPTIONS },
  ]),
  [Shape.ARC]: Object.freeze([
    { label: 'ライズ', unit: 'mm', input: 'number' },
    { label: '軸', input: 'select', options: AXIS_OPTIONS },
  ]),
  [Shape.DOME]: Object.freeze([
    { label: 'ライズ', unit: 'mm', input: 'number' },
  ]),
});

/**
 * 階段の upDirection（'up'|'down'|'left'|'right'）→ 傾斜の上がる向き（度。y 下向き座標で 0=右・90=下・180=左・270=上）。 */
export const UP_DIRECTION_TO_DEG = Object.freeze({ right: 0, down: 90, left: 180, up: 270 });

/** セル群（解けるキーだけ）の外接矩形。無ければ null。 */
function cellsBounds(keys, graph) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const key of keys) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    x1 = Math.min(x1, b.x1, b.x2); x2 = Math.max(x2, b.x1, b.x2);
    y1 = Math.min(y1, b.y1, b.y2); y2 = Math.max(y2, b.y1, b.y2);
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null;
}

/**
 * 直進系の階段（STRAIGHT・STRAIGHT_LANDING）のセル群に、階段に沿った傾斜の初期値（パネルの下書き）を作る。
 *   向き＝UP_DIRECTION_TO_DEG[stair.upDirection]／基準高＝対の部屋（stair.roomId）の CH（roomCeilingHeight().mm）／
 *   ライズ＝蹴上×総段数×（区画セル群の外接矩形の上り方向の長さ ÷ 階段セル群の外接矩形の同方向の長さ）を mm に丸めた値。
 *   区画が階段全体ならライズ＝階高（踊り場込みの平均勾配）。蹴上は riserOf（stair.riser 優先・無ければ階高/総段数）。
 * 折返し・回り・矩折等・対の部屋なし・蹴上が決まらない（最上階など）・向きが不明・長さが 0 のときは null（呼び側が平面を初期値にする）。
 * @param {object} graph
 * @param {import('@core').Stair} stair
 * @param {Iterable<string>} cellKeys  区画にするセル群
 * @param {number|null} floorHeight  設置階〜上階の階高(mm)
 * @returns {{heightMm: number, shape: string, dims: number[]}|null}
 */
export function stairCeilingSlopeDefaults(graph, stair, cellKeys, floorHeight) {
  if (!graph || !stair) return null;
  if (stair.type !== StairType.STRAIGHT && stair.type !== StairType.STRAIGHT_LANDING) return null;
  const room = stair.roomId ? graph.roomMap.get(stair.roomId) : null;
  const deg = UP_DIRECTION_TO_DEG[stair.upDirection];
  const riser = riserOf(stair, floorHeight);
  if (!room || deg === undefined || riser == null) return null;
  // 選択は天井セル（天井芯で割れた key）。仕上げの refreshCells で展開すると天井芯の片側が仕上げセル全体へ広がるため、天井版で展開する
  const sel = cellsBounds(ceilingRefreshCells(new Set(cellKeys ?? []), graph), graph);
  const all = cellsBounds(ceilingRefreshCells(stair.cells, graph), graph);
  if (!sel || !all) return null;
  const alongX = deg === 0 || deg === 180;
  const selLen = alongX ? sel.x2 - sel.x1 : sel.y2 - sel.y1;
  const allLen = alongX ? all.x2 - all.x1 : all.y2 - all.y1;
  if (!(allLen > 0) || !(selLen > 0)) return null;
  const rise = Math.round(riser * stair.totalSteps * Math.min(1, selLen / allLen));
  if (!(rise > 0)) return null;
  return { heightMm: roomCeilingHeight(graph, room).mm, shape: Shape.SLOPE, dims: [rise, deg] };
}

const num = text => {
  const t = String(text ?? '').trim();
  return t === '' ? NaN : Number(t);
};

/**
 * パネルの下書きを検証して区画の値にする。例外を投げず値で返す（ui/planCutHeightInput.js の流儀）。
 *  - 基準高: 空＝null（部屋の CH）。入力があれば有限の正数。天端が切断高・階高を超えても弾かない。
 *  - 寸法: 形状の個数ぶん。ライズは有限の正数、向き・軸は列挙値。円弧はライズ ≤ 幅/2（軸に直交する幅）。
 * @param {{shape: string, height: string, dims: Array<string|number>}} draft
 * @param {{spanMm?: number|{xMm: number, yMm: number}|null}} [ctx]  円弧の幅。数値ならそのまま、{xMm,yMm} なら軸に直交する側（軸0=x に平行→yMm、軸90→xMm）。無ければ幅の検査をしない
 * @returns {{ok: true, value: {heightMm: number|null, shape: string, dims: number[]}} | {ok: false, error: string}}
 */
export function parseCeilingZoneDraft(draft, { spanMm = null } = {}) {
  const shape = draft?.shape;
  const count = CEILING_SHAPE_DIM_COUNT[shape];
  if (count === undefined) return { ok: false, error: '形状が不正です' };
  const hText = String(draft.height ?? '').trim();
  let heightMm = null;
  if (hText !== '') {
    heightMm = Number(hText);
    if (!Number.isFinite(heightMm) || heightMm <= 0) return { ok: false, error: `${CEILING_BASE_LABEL[shape]}は正の数を入力してください（空欄は部屋のCH）` };
  }
  const fields = CEILING_DIM_FIELDS[shape];
  const dims = [];
  for (let i = 0; i < count; i++) {
    const v = num(draft.dims?.[i]);
    const f = fields[i];
    if (!Number.isFinite(v)) return { ok: false, error: `${f.label}を入力してください` };
    if (f.input === 'number' && v <= 0) return { ok: false, error: `${f.label}は正の数を入力してください` };
    dims.push(v);
  }
  if (!validCeilingDims(shape, dims)) {
    const bad = fields.findIndex((f, i) => f.input === 'select' && !f.options.some(o => o.value === dims[i]));
    return { ok: false, error: `${fields[bad >= 0 ? bad : 0].label}が不正です` };
  }
  if (shape === Shape.ARC) {
    const span = typeof spanMm === 'number' ? spanMm
      : spanMm ? (dims[1] === 0 ? spanMm.yMm : spanMm.xMm) : null;
    if (Number.isFinite(span) && dims[0] > span / 2) return { ok: false, error: 'ライズは幅の半分以下にしてください' };
  }
  return { ok: true, value: { heightMm, shape, dims } };
}
