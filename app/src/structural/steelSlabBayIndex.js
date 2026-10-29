// ================================================================
// S造スラブのベイキーの索引（ベイキーの組み立てと、ブレース指定のベイの引き）。
//
// 置き場がここなのは依存方向を一方向にするため: slabSecondaryBeamAxes.js（ベイの割付け。ブレースのベイは
// 子梁の分割数が変わる＝S7）も steelSlabBays.js（指定・解除）もこのモジュールを引く。import は core / 定数 /
// steelSlabSpec だけ（slabSecondaryBeamAxes.js・steelSlabBays.js を引かない＝循環なし）。
// 純モジュール: store.js / snap.js / .jsx を静的に引かない。
// ================================================================
import { isBayKeyedSlab } from '../core.js';
import { SteelSlabKind } from '../core/constants.js';
import { resolveSteelSlabSpec } from './steelSlabSpec.js';

/**
 * ベイキー（S造スラブのセルキー）: ベイの4辺の軸CL id を finish/gridCells.js のセルキーと同じ
 * `左:上:右:下`（x1Id:y1Id:x2Id:y2Id）で連結する。cellBoundsFromKey がそのまま矩形に解決できる。
 * 純粋な文字列結合（検証しない）。
 * @param {{x1Id:string, y1Id:string, x2Id:string, y2Id:string}} ids
 * @returns {string}
 */
export function bayCellKey({ x1Id, y1Id, x2Id, y2Id }) {
  return [x1Id, y1Id, x2Id, y2Id].join(':');
}

/**
 * ブレース指定のベイ → ブレース部材種別（BraceMemberType）。実効仕様（個別＞共通）の種別がブレースのベイだけ。
 * 現在のベイかどうかは見ない（保持しているキーをそのまま返す）。
 * @returns {Map<string, string>}
 */
export function braceBayMap(graph, project) {
  const map = new Map();
  for (const slab of graph.slabs.filter(isBayKeyedSlab)) {
    const spec = resolveSteelSlabSpec(slab.steelSpec, project.structuralInfo?.steelSlabSpec);
    if (spec.kind !== SteelSlabKind.BRACE) continue;
    for (const key of slab.cells) map.set(key, spec.braceMemberType);
  }
  return map;
}
