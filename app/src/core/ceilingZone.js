/**
 * 天井区画（CeilingZone）。core.js から分離。core/roofSpec.js と並ぶ値クラス（ただし不変・observable にしない）。
 *
 * 天伏モードで選んだセル群ごとの天井の高さ（と、S6 以降の形状・寸法）の保存先。Room.ceilingZones が持つ。
 * 項目集合の定義は CEILING_ZONE_KEYS と toData()/fromData() の1か所だけ——直列化（FBS・graphSnapshot）・
 * 仕上げモード undo・テストの突合はここを共通の入口にする。
 *
 * 不変条件（.claude/ceiling-model.md「天井区画（S5）」）:
 *   Z1: 区画のセルは、その部屋が今の分割で持つセルの部分集合。保存は生キーのまま持ち、読む側（ceilingSurfaces.js）が
 *       refreshCells と部屋の所属との交差で守る（setCells/removeCell では間引かない）。
 *   Z2: 同じ部屋の区画どうしはセルが重ならない（書く側 ceiling/ceilingZones.js が奪い合いで守る）。区画をまたいだ生キーの重複は
 *       復元（restoreCeilingZones）で先勝ちに除く。
 *   Z3: heightMm＝部屋の FL からの天井高（null＝部屋の CH）。部屋の CH 欄（仕上げ表）には書かない。
 */
import { CeilingShape } from './constants.js';

/** CeilingZone の項目集合（toData() のキーと一致する。唯一の定義）。 */
export const CEILING_ZONE_KEYS = Object.freeze(['id', 'cells', 'heightMm', 'shape', 'dims']);

const finite = v => typeof v === 'number' && Number.isFinite(v);

/**
 * 形状ごとの寸法の個数（汎用の「寸法1・寸法2…」欄。形状が違っても欄を共用する。S6a）。
 *   flat=[] ／ slope=[ライズ mm>0, 上がる向き 度] ／ arc=[ライズ mm>0, 軸 度] ／ dome=[ライズ mm>0]
 * heightMm（基準高）の意味は形状で変わる: 平面＝天井高／傾斜＝低い側の高さ／円弧・ドーム＝周縁の高さ（null＝部屋の CH）。
 */
export const CEILING_SHAPE_DIM_COUNT = Object.freeze({
  [CeilingShape.FLAT]: 0, [CeilingShape.SLOPE]: 2, [CeilingShape.ARC]: 2, [CeilingShape.DOME]: 1,
});
/** 傾斜の「上がる向き」（度。y 下向き座標で 0=+x 右・90=+y 下・180=左・270=上）。 */
export const SLOPE_DIRS_DEG = Object.freeze([0, 90, 180, 270]);
/** 円弧の軸（度。0=x に平行・90=y に平行）。 */
export const ARC_AXES_DEG = Object.freeze([0, 90]);

/** 寸法の個数と値域が形状に合うか（個数は過不足なし。ライズ>0、向き・軸は列挙値）。未知の shape は false。 */
export function validCeilingDims(shape, dims) {
  const n = CEILING_SHAPE_DIM_COUNT[shape];
  if (n === undefined || !Array.isArray(dims) || dims.length !== n || !dims.every(finite)) return false;
  if (shape === CeilingShape.FLAT) return true;
  if (!(dims[0] > 0)) return false;
  if (shape === CeilingShape.SLOPE) return SLOPE_DIRS_DEG.includes(dims[1]);
  if (shape === CeilingShape.ARC) return ARC_AXES_DEG.includes(dims[1]);
  return true;
}

/**
 * 形状と寸法を正規化する。余分な dims は形状の個数へ切り詰め、足りない・非有限・値域外（ライズ≤0、向き・軸が列挙外）・未知の shape は
 * 平面（flat・寸法なし）に落とす（区画そのものは捨てない）。
 * @returns {{shape: string, dims: number[]}}
 */
export function normalizeCeilingShape(shape, dims) {
  const n = CEILING_SHAPE_DIM_COUNT[shape];
  if (n === undefined || !Array.isArray(dims)) return { shape: CeilingShape.FLAT, dims: [] };
  const cut = dims.slice(0, n);
  return validCeilingDims(shape, cut) ? { shape, dims: cut } : { shape: CeilingShape.FLAT, dims: [] };
}

/** 文字列だけを残し、空文字・重複を除いて昇順にした凍結配列。 */
function normalizeCells(cells) {
  const set = new Set();
  for (const c of cells ?? []) if (typeof c === 'string' && c !== '') set.add(c);
  return Object.freeze([...set].sort());
}

export class CeilingZone {
  /**
   * @param {{id: string, cells?: Iterable<string>, heightMm?: number|null, shape?: string, dims?: number[]}} init
   */
  constructor({ id, cells = [], heightMm = null, shape = CeilingShape.FLAT, dims = [] }) {
    this.id = id;                              // 区画 id（部屋の中で一意。uuid）
    this.cells = normalizeCells(cells);        // セルキー（重複なし・昇順）
    this.heightMm = heightMm;                  // 部屋の FL からの天井高 mm | null（null＝部屋の CH）
    this.shape = shape;                        // CeilingShape
    this.dims = Object.freeze([...dims]);      // 形状の寸法（個数・意味は CEILING_SHAPE_DIM_COUNT）
    Object.freeze(this);
  }

  /** 直列化・undo・FBS が共通して使う plain object 表現。項目集合の定義をここへ集約する。 */
  toData() {
    return { id: this.id, cells: [...this.cells], heightMm: this.heightMm, shape: this.shape, dims: [...this.dims] };
  }

  /**
   * plain object から CeilingZone を作る（壊れた値は正規化。id が非文字列・空なら null）:
   * cells は空でない文字列だけ・重複除去・昇順／heightMm は有限かつ >0 だけ採り他は null／
   * shape・dims は normalizeCeilingShape（未知 shape・個数違い・非有限・値域外は flat・寸法なし。余分な dims は切り詰め。区画は捨てない）。
   * @returns {CeilingZone|null}
   */
  static fromData(d) {
    if (!d || typeof d.id !== 'string' || d.id === '') return null;
    const { shape, dims } = normalizeCeilingShape(d.shape, d.dims);
    return new CeilingZone({
      id: d.id,
      cells: Array.isArray(d.cells) ? d.cells : [],
      heightMm: finite(d.heightMm) && d.heightMm > 0 ? d.heightMm : null,
      shape,
      dims,
    });
  }

  withCells(cells) { return new CeilingZone({ ...this.toData(), cells }); }
  withHeight(mm) { return new CeilingZone({ ...this.toData(), heightMm: mm }); }
}

/** 空の区画か（セルが無い、または何の指定もない＝高さ null かつ flat かつ寸法なし）。 */
export function isEmptyCeilingZone(z) {
  return z.cells.length === 0 || (z.heightMm === null && z.shape === CeilingShape.FLAT && z.dims.length === 0);
}

/**
 * 保存データ（plain の配列）から区画の凍結配列を復元する。不正（id なし）・空の区画を捨て、
 * 区画をまたいだ生キーの重複は先勝ちで後の区画から除く（除いて空になれば区画ごと捨てる）。同じ id の区画は後のものを捨てる。
 * 配列でない入力（旧データ・欠落）は空配列。
 * @returns {ReadonlyArray<CeilingZone>}
 */
export function restoreCeilingZones(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const claimed = new Set();
  const ids = new Set();
  const out = [];
  for (const d of list) {
    const z = CeilingZone.fromData(d);
    if (!z || isEmptyCeilingZone(z) || ids.has(z.id)) continue;
    const own = z.cells.filter(c => !claimed.has(c));
    const kept = own.length === z.cells.length ? z : z.withCells(own);
    if (isEmptyCeilingZone(kept)) continue;
    for (const c of kept.cells) claimed.add(c);
    ids.add(kept.id);
    out.push(kept);
  }
  return Object.freeze(out);
}
