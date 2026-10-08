/**
 * 平面の断面解決（S3 の planSectionFigure）を新レイヤ `renderer/PlanSolidsLayer.jsx`（S4）へ渡すための純モジュール。
 * 「何を描くか」の集合と、層スタックの組み立て（自階＋直下階）をここ1か所に置く。
 *
 * S4 で描くのは**今の平面に無い種類だけ**（梁・汎用立体）。柱・壁・床・屋根は既存レイヤが描くので、
 * 解決器には全立体を渡して**遮蔽物としてだけ**参加させ、出力の線のうち source.kind が S4_DRAWN_KINDS のものだけを描く。
 * S5（屋根）・S6（吹抜け）で既存レイヤを寄せるときに、この集合を広げる。
 *
 * store.js / snap.js / *.jsx / graphDerived を import しない（node:test から単体 import 可）。
 *
 * @typedef {import('./planSectionFigure.js').Primitive} Primitive
 */
import { planCutHeightMmOf } from '@core';
import { planSolids } from './planSolids.js';
import { planSectionFigure } from './planSectionFigure.js';

/** S4 で新レイヤが描く線の source.kind（唯一の場所）。 */
export const S4_DRAWN_KINDS = Object.freeze(['beam', 'generic']);

/** 解決器の出力から、S4 で描く種別の線だけを残す（順序は保つ）。 */
export function drawnPrimitives(prims) {
  return (prims ?? []).filter(p => S4_DRAWN_KINDS.includes(p?.source?.kind));
}

/**
 * 自階（＋あれば直下階）を層スタックにして解決し、描く線を返す。上階は渡さない（切断高が階高より低い限り 0 件で、費用だけ掛かる）。
 * @param {{
 *   graph: object|null,
 *   belowPeek?: {graph: object|null, floorHeightMm: number}|null  直下の採用階の peek と、その階の階高（直下階 FL〜自階 FL）。無ければ null
 *   selfRiserOf?: (stair:object)=>number|null  自階の階段の蹴上（破れ先の位置）。省略は null 扱い
 *   cutZ: number  切断高（自階 FL からの mm。planCutHeightMmOf(graph.plane)）
 * }} args
 * @returns {Primitive[]}
 */
export function planSolidsLayerPrimitives({ graph, belowPeek = null, selfRiserOf = () => null, cutZ }) {
  if (!graph || !Number.isFinite(cutZ)) return [];
  const belowGraph = belowPeek?.graph ?? null;
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (belowGraph && Number.isFinite(belowPeek.floorHeightMm) && belowPeek.floorHeightMm > 0) {
    layers.push({ graph: belowGraph, floorZMm: -belowPeek.floorHeightMm, role: 'below' });
  }
  // 蹴上（破れ先の位置）を問われるのは自階の階段だけ: 破れ先が穴になるのは「下階に同じ階段があるとき」で、下階の床の
  // 穴は更に下の階が要るため求めない（belowGraphOf が下階に null を返す＝下階の階段は破れ先を問われない）。
  const solids = planSolids(layers, { riserOf: selfRiserOf, belowGraphOf: g => (g === graph ? belowGraph : null) });
  return drawnPrimitives(planSectionFigure(solids, cutZ));
}

/**
 * 通り芯・中心線をドラッグ中か（どれかの CL の pendingDelta が 0 でない）。ドラッグ中は effectiveValue が毎フレーム変わり、
 * 梁・壁の座標が変わって全再計算になる（moku1-6 の2階で 50〜105ms/回）ので、レイヤは前回の結果を描き続ける。
 * graph.centerLines は階固有の CL と通り芯（structGraph）の両方を返す。
 */
export function isCenterLineDragging(graph) {
  return (graph?.centerLines ?? []).some(cl => (cl.pendingDelta ?? 0) !== 0);
}

/**
 * graphComputed の置き場・鍵・使う peek の決定（唯一の場所）。
 * 置き場は**直下階 peek の graph**（無ければ自階）、鍵は自階×切断高×直下階。graphComputed は (graph,key) ごとに最初の
 * compute を使い回すので、置き場を自階に固定すると階を切り替えて下階の peek が替わっても古い peek 基準の結果を握り続ける。
 * `belowPeek.activePlaneId` が自階と違うもの（階切替直後の1フレームに前の階の peek が残る）は使わない（peek=null）。
 * @returns {{home: object, key: string, peek: object|null, cutZ: number}}
 */
export function planSolidsLayerCacheSpec(graph, belowPeek) {
  const peek = belowPeek && belowPeek.activePlaneId === graph.plane.id ? belowPeek : null;
  const cutZ = planCutHeightMmOf(graph.plane);
  return {
    home: peek?.graph ?? graph,
    key: `planSection:${graph.plane.id}:${cutZ}:${peek?.graph?.plane?.id ?? '-'}`,
    peek, cutZ,
  };
}

/**
 * レイヤが描く線の決定（ドラッグ中・未解決・キャッシュ）。
 *   - graph なし／belowPeek が undefined（下階の peek が未解決。null は「下階なし」で解決済み）→ null（compute を呼ばない）
 *   - 通り芯ドラッグ中 → prevPrims（前回の結果。無ければ null）。memo も呼ばない
 *   - それ以外 → memo(home, key, compute)（graphComputed）
 * @param {{graph: object|null, belowPeek: object|null|undefined, prevPrims?: Primitive[]|null,
 *   memo: (home: object, key: string, compute: () => Primitive[]) => Primitive[],
 *   selfRiserOf?: (stair: object) => number|null}} args
 * @returns {Primitive[]|null}
 */
export function planSolidsLayerResolve({ graph, belowPeek, prevPrims = null, memo, selfRiserOf }) {
  if (!graph || belowPeek === undefined) return null;
  if (isCenterLineDragging(graph)) return prevPrims;
  const { home, key, peek, cutZ } = planSolidsLayerCacheSpec(graph, belowPeek);
  return memo(home, key, () => planSolidsLayerPrimitives({ graph, belowPeek: peek, selfRiserOf, cutZ }));
}
