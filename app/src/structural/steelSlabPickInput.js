// ================================================================
// S造スラブ指定（構造リストの「スラブ指定」トグル）の入力を組み立てる純モジュール。
//
// 指定できるベイの一覧と、指定の検証（assignSteelSlabBays）が必須で受ける床開口のセル矩形 openingRects を、
// structuralRecompute.js のS造の小梁割付け（slabOpeningRects）と同じ式で作る:
//   openingCellRects(graph, { riserOf: s => stairRiserOf(s, project, graph.plane), belowGraph })
// belowGraph は呼び出し側が渡す。構造モードの伏図は「1つ下の階」を柱の供給階として図面合成（composition）に
// 持っており（graphForCategory('columnMap')）、床開口の×の描画（renderer/StructuralLayer.jsx）も同じものを
// belowGraph に使う——ここも同じ供給元を使うため、非同期の他階 peek を新設せずに済む（peek の規則を二重に持たない）。
// belowGraph が効くのは階段の「到達元」判定（stairFilterFor）だけで、階段の無い階では結果に影響しない。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない（node:test から単体 import できる）。
// ================================================================
import { SlabBayFillSkip } from '../core/constants.js';
import { openingCellRects } from './openingBeamAxes.js';
import { listSlabBays } from './slabSecondaryBeamAxes.js';
import { stairRiserOf } from '../finish/stair/stairDimensions.js';

/**
 * ベイ指定の入力を作る。
 * @param {{graph: object, project: object, belowGraph?: object|null}} args belowGraph＝1つ下の実体階（無ければ null）
 * @returns {{bays: Array<{key: string, cell: object}>, openingRects: Array<object>}}
 *   bays＝指定可能なベイ（key が決まっていて床開口のベイでないもの）。openingRects＝assignSteelSlabBays にそのまま渡す。
 */
export function prepareSteelSlabPick({ graph, project, belowGraph: belowOpt = null }) {
  // 主題階自身が来たら（基礎伏図など下階が無いとき composition が自階を返しうる）下階なし扱い——
  // 自階の階段を自分の到達元とみなさない（renderer/StructuralLayer.jsx の belowGraph !== graph と同じ式）。
  const belowGraph = belowOpt !== graph ? belowOpt : null;
  const openingRects = openingCellRects(graph, { riserOf: (s) => stairRiserOf(s, project, graph.plane), belowGraph });
  const bays = listSlabBays(graph, project, openingRects)
    .filter(b => b.key != null && b.skip !== SlabBayFillSkip.OPENING)
    .map(b => ({ key: b.key, cell: b.cell }));
  return { bays, openingRects };
}
