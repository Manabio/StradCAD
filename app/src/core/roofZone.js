/**
 * 屋根区画（RoofZone）。core/ceilingZone.js と並ぶ値クラス（区画の殻は不変・observable にしない）。
 *
 * 最上階の主屋根（PlanGraph.mainRoofSpec）を区画ごとに指定するための保存先。PlanGraph.roofZones が持つ。
 * 区画＝最上階の部屋セルの上に重なるセル集合＋RoofSpec。区画に入らないセルは従来の mainRoofSpec に従う。
 * 項目集合の定義は ROOF_ZONE_KEYS と toData()/fromData() の1か所だけ——直列化（FBS・graphSnapshot）・
 * 仕上げモード undo・テストの突合はここを共通の入口にする。
 *
 * 殻（id・cells）は凍結するが、spec は既存の可変 RoofSpec のまま持つ（setField で編集できる）。
 * セルは保存では生キーのまま持ち、読む側（finish/roof/roofZones.js）が refreshCells とフットプリントとの交差で守る。
 */
import { RoofSpec } from './roofSpec.js';

/** RoofZone の項目集合（toData() のキーと一致する。唯一の定義）。 */
export const ROOF_ZONE_KEYS = Object.freeze(['id', 'cells', 'spec']);

/** 文字列だけを残し、空文字・重複を除いて昇順にした凍結配列。 */
function normalizeCells(cells) {
  const set = new Set();
  for (const c of cells ?? []) if (typeof c === 'string' && c !== '') set.add(c);
  return Object.freeze([...set].sort());
}

export class RoofZone {
  /**
   * @param {{id: string, cells?: Iterable<string>, spec?: RoofSpec}} init
   */
  constructor({ id, cells = [], spec = null }) {
    this.id = id;                         // 区画 id（グラフの中で一意。uuid）
    this.cells = normalizeCells(cells);   // セルキー（重複なし・昇順）
    // RoofSpec（可変。setField で編集する）。null・plain object が来ても必ず RoofSpec にする（null のまま持つと保存の toData で落ちる。QA 指摘）
    this.spec = spec instanceof RoofSpec ? spec : RoofSpec.fromData(spec);
    Object.freeze(this);
  }

  /** 直列化・undo・FBS が共通して使う plain object 表現。項目集合の定義をここへ集約する。 */
  toData() {
    return { id: this.id, cells: [...this.cells], spec: this.spec.toData() };
  }

  /**
   * plain object から RoofZone を作る（id が非文字列・空なら null）。
   * cells は空でない文字列だけ・重複除去・昇順／spec は RoofSpec.fromData（欠落は既定の RoofSpec）。
   * @returns {RoofZone|null}
   */
  static fromData(d) {
    if (!d || typeof d.id !== 'string' || d.id === '') return null;
    return new RoofZone({
      id: d.id,
      cells: Array.isArray(d.cells) ? d.cells : [],
      spec: RoofSpec.fromData(d.spec),
    });
  }

  withCells(cells) { return new RoofZone({ id: this.id, cells, spec: this.spec }); }
}

/**
 * 保存データ（plain の配列）から区画の凍結配列を復元する。不正（id なし）・セルが空の区画を捨て、
 * 同じ id は先勝ち（後のものを捨てる）、区画をまたいだ生キーの重複も先勝ちで後の区画から除く
 * （除いて空になれば区画ごと捨てる）。配列でない入力（旧データ・欠落）は空配列。
 * @returns {ReadonlyArray<RoofZone>}
 */
export function restoreRoofZones(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const claimed = new Set();
  const ids = new Set();
  const out = [];
  for (const d of list) {
    const z = RoofZone.fromData(d);
    if (!z || z.cells.length === 0 || ids.has(z.id)) continue;
    const own = z.cells.filter(c => !claimed.has(c));
    if (own.length === 0) continue;
    const kept = own.length === z.cells.length ? z : z.withCells(own);
    for (const c of kept.cells) claimed.add(c);
    ids.add(kept.id);
    out.push(kept);
  }
  return Object.freeze(out);
}
