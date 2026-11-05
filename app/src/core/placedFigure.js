/**
 * 姿図の配置（PlacedFigure）。core/roofZone.js と並ぶ値クラス（凍結・observable にしない）。
 *
 * 部分詳細図（category=figure）の図を、平面上の 1 点に置いた実体。PlanGraph.placedFigures が持つ。
 * 図そのものは持たず、図のキー（figureKey）で参照する（図の本体は詳細図カタログ側）。
 * 項目集合の定義は PLACED_FIGURE_KEYS と toData()/fromData() の1か所だけ——直列化（FBS・graphSnapshot）・
 * 仕上げモード undo・テストの突合はここを共通の入口にする。
 *
 * 座標は mm（y 軸下向き正）。回転は PLACED_FIGURE_ROTATION_STEP_DEG の整数倍だけ許し、[0, FULL_TURN_DEG) に正規化する。
 * mirror は図の s 軸方向の左右反転。zMm は置く高さ（配置した部屋の床面＝展開の床線からの mm。建具と同じ floorDyAt 基準。0＝床面）。
 */
import { PLACED_FIGURE_ROTATION_STEP_DEG, FULL_TURN_DEG } from './constants.js';

/** PlacedFigure の項目集合（toData() のキーと一致する。唯一の定義）。 */
export const PLACED_FIGURE_KEYS = Object.freeze(['id', 'figureKey', 'x', 'y', 'rotationDeg', 'mirror', 'zMm', 'note']);

const isNonEmptyString = v => typeof v === 'string' && v !== '';
const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);

/**
 * 回転角（度）を [0, FULL_TURN_DEG) に正規化する。有限かつ PLACED_FIGURE_ROTATION_STEP_DEG の整数倍でなければ null。
 * 例: -90 → 270・450 → 90・45 → null・NaN → null。
 * @returns {number|null}
 */
export function normalizePlacedFigureRotation(deg) {
  if (!isFiniteNumber(deg)) return null;
  const steps = deg / PLACED_FIGURE_ROTATION_STEP_DEG;
  if (!Number.isInteger(steps)) return null;
  const turned = ((deg % FULL_TURN_DEG) + FULL_TURN_DEG) % FULL_TURN_DEG;
  return turned === 0 ? 0 : turned; // -0 を 0 にそろえる
}

/** 入力から項目を正規化して返す（不正なら null。例外にしない）。 */
function normalizeFields(d) {
  if (d === null || typeof d !== 'object') return null;
  if (!isNonEmptyString(d.id) || !isNonEmptyString(d.figureKey)) return null;
  if (!isFiniteNumber(d.x) || !isFiniteNumber(d.y) || !isFiniteNumber(d.zMm)) return null;
  const rotationDeg = normalizePlacedFigureRotation(d.rotationDeg);
  if (rotationDeg === null) return null;
  return {
    id: d.id,
    figureKey: d.figureKey,
    x: d.x,
    y: d.y,
    rotationDeg,
    mirror: d.mirror === true,
    zMm: d.zMm,
    note: typeof d.note === 'string' ? d.note : '',
  };
}

export class PlacedFigure {
  /**
   * 不正な値は RangeError（UI 経路の誤りをその場で気づかせる）。保存データの復元は fromData（null を返す）を使う。
   * @param {{id: string, figureKey: string, x: number, y: number, rotationDeg?: number, mirror?: boolean, zMm?: number, note?: string}} init
   */
  constructor(init) {
    const f = normalizeFields({ ...init, rotationDeg: init?.rotationDeg ?? 0, zMm: init?.zMm ?? 0 });
    if (f === null) throw new RangeError(`PlacedFigure: 不正な値です: ${JSON.stringify(init)}`);
    this.id = f.id;                     // 配置 id（グラフの中で一意。uuid）
    this.figureKey = f.figureKey;       // 詳細図のキー
    this.x = f.x;
    this.y = f.y;
    this.rotationDeg = f.rotationDeg;   // [0, FULL_TURN_DEG)・STEP の整数倍
    this.mirror = f.mirror;
    this.zMm = f.zMm;
    this.note = f.note;
    Object.freeze(this);
  }

  /** 直列化・undo・FBS が共通して使う plain object 表現。項目集合の定義をここへ集約する。 */
  toData() {
    return {
      id: this.id, figureKey: this.figureKey, x: this.x, y: this.y,
      rotationDeg: this.rotationDeg, mirror: this.mirror, zMm: this.zMm, note: this.note,
    };
  }

  /**
   * plain object から PlacedFigure を作る。不正（id・figureKey が空／x・y・zMm が非有限／回転が STEP の整数倍でない）は null。
   * mirror は === true だけ true・note は非文字列なら ''。
   * @returns {PlacedFigure|null}
   */
  static fromData(d) {
    const f = normalizeFields(d);
    return f === null ? null : new PlacedFigure(f);
  }

  /**
   * 項目を差し替えた新しい PlacedFigure。未知の項目・不正な値は RangeError。id は変えられない。
   * @param {Partial<ReturnType<PlacedFigure['toData']>>} changes
   */
  with(changes) {
    for (const key of Object.keys(changes ?? {})) {
      if (!PLACED_FIGURE_KEYS.includes(key)) throw new RangeError(`PlacedFigure: 未知の項目です: ${key}`);
      if (key === 'id') throw new RangeError('PlacedFigure: id は変えられません');
    }
    return new PlacedFigure({ ...this.toData(), ...changes });
  }
}

/**
 * 保存データ（plain の配列）から配置の凍結配列を復元する。不正な要素を捨て、同じ id は先勝ち（後のものを捨てる）。
 * 配列でない入力（旧データ・欠落）は空配列。
 * @returns {ReadonlyArray<PlacedFigure>}
 */
export function restorePlacedFigures(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const ids = new Set();
  const out = [];
  for (const d of list) {
    const pf = PlacedFigure.fromData(d);
    if (!pf || ids.has(pf.id)) continue;
    ids.add(pf.id);
    out.push(pf);
  }
  return Object.freeze(out);
}
