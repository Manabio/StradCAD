/**
 * 天井区画の形状・寸法の入力欄の表と検証（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 天伏パネル（CeilingPanel.jsx）が欄を組むときの唯一の表。寸法欄は「寸法1・寸法2…」の汎用欄で、形状が違っても欄を共用する
 * （形状ごとに意味とラベルだけ変わる）。個数・値域の定義は core/ceilingZone.js（CEILING_SHAPE_DIM_COUNT・validCeilingDims）。
 *
 * 基準高（heightMm）の意味: 平面＝天井高／傾斜＝低い側の高さ／円弧・ドーム＝周縁の高さ。空欄＝部屋の CH。
 * S6a は平面と傾斜まで。円弧・ドームは選択肢に出すが disabled（S6b で解禁）。
 */
import { CEILING_SHAPE_DIM_COUNT, SLOPE_DIRS_DEG, ARC_AXES_DEG, validCeilingDims } from '../core/ceilingZone.js';
import { CeilingShape as Shape } from '../core/constants.js';

/** 形状の選択肢。disabled は S6b で解禁するもの。 */
export const CEILING_SHAPE_OPTIONS = Object.freeze([
  { value: Shape.FLAT,  label: '平面' },
  { value: Shape.SLOPE, label: '傾斜' },
  { value: Shape.ARC,   label: '円弧',  disabled: true },
  { value: Shape.DOME,  label: 'ドーム', disabled: true },
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
 * S6b（階段からの初期値）で使う先回りの表。S6a では参照元なし（テストで値だけ固定）。
 * 階段の upDirection（'up'|'down'|'left'|'right'）→ 傾斜の上がる向き（度。y 下向き座標で 0=右・90=下・180=左・270=上）。 */
export const UP_DIRECTION_TO_DEG = Object.freeze({ right: 0, down: 90, left: 180, up: 270 });

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
