/**
 * 平面の断面解決（S3 の planSectionFigure）を新レイヤ `renderer/PlanSolidsLayer.jsx`（S4）へ渡すための純モジュール。
 * 「何を描くか」の集合と、層スタックの組み立て（自階＋直下階）をここ1か所に置く。
 *
 * 自階で描くのは S4＝梁・汎用立体、S5＝下屋（屋根の外形線・棟木・隅木・谷木と傾斜ラベル）。自階の柱・壁・床は既存レイヤが
 * 描くので、解決器には全立体を渡して**遮蔽物としてだけ**参加させ、出力のうち source.kind が S4_DRAWN_KINDS のものだけを描く。
 * 下階の層（自階の床の穴の窓越し）は S6c から全種別を細線で描く（BELOW_DRAWN_KINDS）。壁・柱・床を既存レイヤが描いていないため。
 *
 * store.js / snap.js / *.jsx / graphDerived を import しない（node:test から単体 import 可）。
 *
 * @typedef {import('./planSectionFigure.js').Primitive} Primitive
 */
import { planCutHeightMmOf, ceilingCutHeightMmOf } from '@core';
import { ceilingSurfacesOf } from '../ceiling/ceilingSurfaces.js';
import { markSameHeightCeilingBoundaries } from '../ceiling/ceilingBoundaryStyle.js';
import { planSolids } from './planSolids.js';
import { planSectionFigure } from './planSectionFigure.js';
import { planSectionFigureUp } from './planSectionUp.js';
import { LodLevel } from '../viewport.js';

/**
 * 新レイヤが**自階**で描く線・ラベルの source.kind（唯一の場所）。S4＝梁・汎用立体、S5＝下屋（屋根）を加えた。
 * 階段の段（stairTread。S7b）は含めない——遮蔽専用（drawEdges:false で線を持たない）で、階段の線を描くのは StairLayer だけ。
 */
export const S4_DRAWN_KINDS = Object.freeze(['beam', 'generic', 'roof']);

/**
 * 新レイヤが**下階の層**（layerFloorZ < 0。自階の床の穴の窓越しに見える線）で描く source.kind（唯一の場所）。
 * 'all'＝全種別（壁・柱・床・梁・屋根・汎用立体。S6c）。下階の層の立体は全部 below（細線）で、窓の中だけに出る。
 * 自階の壁・柱・床は既存レイヤ（ShapesLayer など）が描くので S4_DRAWN_KINDS のまま。
 */
export const BELOW_DRAWN_KINDS = 'all';

/** 層（layerFloorZ。省略は自階）と source.kind から、描く種別かを決める（唯一の判定）。 */
const isDrawn = (kind, layerFloorZ) => ((layerFloorZ ?? 0) < 0
  ? BELOW_DRAWN_KINDS === 'all' || BELOW_DRAWN_KINDS.includes(kind)
  : S4_DRAWN_KINDS.includes(kind));

/**
 * 見上げ（天伏）で**自階**に描く source.kind（唯一の場所）。天井・梁・汎用立体。壁・柱は ShapesLayer が描くので遮蔽物としてだけ参加する
 * （自階の床・下屋は鏡像で非表示側に落ちる）。
 */
export const UP_SELF_DRAWN_KINDS = Object.freeze(['ceiling', 'beam', 'generic']);

/** 見上げで**上階の層**（layerFloorZ > 0）に描く source.kind。'all'＝全種別を細線で（天井の無い所＝吹抜け・穴の中だけ見える）。 */
export const UP_ABOVE_DRAWN_KINDS = 'all';

/** 見上げの isDrawn（層は layerFloorZ。上階の層は > 0、自階は 0・省略）。 */
const isDrawnUp = (kind, layerFloorZ) => ((layerFloorZ ?? 0) > 0
  ? UP_ABOVE_DRAWN_KINDS === 'all' || UP_ABOVE_DRAWN_KINDS.includes(kind)
  : UP_SELF_DRAWN_KINDS.includes(kind));

/**
 * 解決器の出力から、描く種別の線・ラベルだけを残す（順序は保つ）。
 * direction 'down'（既定。見下げ）＝自階は S4_DRAWN_KINDS、下階の層は BELOW_DRAWN_KINDS。'up'（見上げ）＝自階は UP_SELF_DRAWN_KINDS、上階の層は UP_ABOVE_DRAWN_KINDS。
 */
export function drawnPrimitives(prims, direction = 'down') {
  const drawn = direction === 'up' ? isDrawnUp : isDrawn;
  return (prims ?? []).filter(p => p?.source?.kind != null && drawn(p.source.kind, p.source.layerFloorZ));
}

/**
 * 表示する図形。詳細（DETAIL）は全部、他の LOD は詳細だけの図形（detailOnly。下屋の傾斜ラベル＝矢印・文字）を除く。
 * 線は全 LOD で出す。memo（graphComputed）は LOD に依らず、レイヤが viewport.lodLevel でここへ絞る。
 * @param {Array<{detailOnly?: boolean}>} prims planSolidsLayerPrimitives の結果
 * @param {string} lod LodLevel
 */
export function visiblePlanPrimitives(prims, lod) {
  return lod === LodLevel.DETAIL ? prims : prims.filter(p => !p.detailOnly);
}

/**
 * 自階（＋あれば直下階）の層スタックから立体を作る（解決の入力。planSolidsLayerPrimitives と probe の穴の検査が共有）。
 * 上階は渡さない（切断高が階高より低い限り 0 件で、費用だけ掛かる）。
 * @param {{
 *   graph: object|null,
 *   belowPeek?: {graph: object|null, floorHeightMm: number}|null  直下の採用階の peek と、その階の階高（直下階 FL〜自階 FL）。無ければ null
 *   selfRiserOf?: (stair:object)=>number|null  自階の階段の蹴上（破れ先の位置）。省略は null 扱い
 * }} args
 * @returns {import('./planSolids.js').Solid[]}
 */
export function planSolidsLayerSolids({ graph, belowPeek = null, selfRiserOf = () => null }) {
  if (!graph) return [];
  const belowGraph = belowPeek?.graph ?? null;
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (belowGraph && Number.isFinite(belowPeek.floorHeightMm) && belowPeek.floorHeightMm > 0) {
    layers.push({ graph: belowGraph, floorZMm: -belowPeek.floorHeightMm, role: 'below' });
  }
  // 蹴上（破れ先の位置）を問われるのは自階の階段だけ: 破れ先が穴になるのは「下階に同じ階段があるとき」で、下階の床の
  // 穴は更に下の階が要るため求めない（belowGraphOf が下階に null を返す＝下階の階段は破れ先を問われない）。
  return planSolids(layers, { riserOf: selfRiserOf, belowGraphOf: g => (g === graph ? belowGraph : null) });
}

/**
 * 自階（＋あれば直下階）を層スタックにして解決し、描く線を返す。cutZ＝切断高（自階 FL からの mm。planCutHeightMmOf(graph.plane)）。
 * 引数は planSolidsLayerSolids と cutZ。graph なし・cutZ が有限でなければ空配列。
 * @returns {Primitive[]}
 */
export function planSolidsLayerPrimitives({ graph, belowPeek = null, selfRiserOf = () => null, cutZ }) {
  if (!graph || !Number.isFinite(cutZ)) return [];
  return drawnPrimitives(planSectionFigure(planSolidsLayerSolids({ graph, belowPeek, selfRiserOf }), cutZ));
}

/**
 * 見上げ（天伏）用の立体: 自階（FL=0）＋直上の採用階（FL=+階高。role 'above'）の層スタック。自階に天井立体を足す（ceilings:true）。
 * 下階は見ない（belowGraphOf は常に null）。
 * 最上の層は上階なので、蹴上（段の高さ・破れ先の位置）は上階の plane で解く aboveRiserOf（planSolids の「最上の層は opts.riserOf」）。
 * 自階の階段の蹴上は自階〜上階の階高から求まる。上階スラブの階段の破れ先は、下階（見上げでは自階）に同じ階段があるときだけ穴になる。
 * @param {{graph: object|null, abovePeek?: {graph: object|null, floorHeightMm: number}|null, aboveRiserOf?: (stair:object)=>number|null}} args
 * @returns {import('./planSolids.js').Solid[]}
 */
export function planSolidsLayerSolidsUp({ graph, abovePeek = null, aboveRiserOf = () => null }) {
  if (!graph) return [];
  const aboveGraph = abovePeek?.graph ?? null;
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  if (aboveGraph && Number.isFinite(abovePeek.floorHeightMm) && abovePeek.floorHeightMm > 0) {
    layers.push({ graph: aboveGraph, floorZMm: abovePeek.floorHeightMm, role: 'above' });
  }
  return planSolids(layers, { riserOf: aboveRiserOf, belowGraphOf: g => (g === aboveGraph ? graph : null), ceilings: true });
}

/**
 * 見上げの線（自階＋直上階。planSectionFigureUp）。cutZ＝切断高（自階 FL からの mm）。graph なし・cutZ が有限でなければ空配列。
 * @returns {Primitive[]}
 */
export function planSolidsLayerPrimitivesUp({ graph, abovePeek = null, aboveRiserOf = () => null, cutZ }) {
  if (!graph || !Number.isFinite(cutZ)) return [];
  const drawn = drawnPrimitives(planSectionFigureUp(planSolidsLayerSolidsUp({ graph, abovePeek, aboveRiserOf }), cutZ), 'up');
  // 同じ高さで隣り合う部屋の天井の境目は細線グレー（裁定 2026-10-10）。見下げの経路は通らない
  return markSameHeightCeilingBoundaries(drawn, ceilingSurfacesOf(graph));
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
 * direction 'up'（見上げ）は peek に**直上階**の peek を渡す。鍵は `planSection:up:…`（見下げの鍵と衝突しない）、置き場は上階 peek の graph（無ければ自階）。
 * @param {object} graph
 * @param {object|null|undefined} belowPeek  direction 'down' は直下階の peek、'up' は直上階の peek（undefined＝未解決／null＝その階なし）
 * @param {'down'|'up'} [direction]
 * @returns {{home: object, key: string, peek: object|null, cutZ: number}}
 */
export function planSolidsLayerCacheSpec(graph, belowPeek, direction = 'down') {
  const peek = belowPeek && belowPeek.activePlaneId === graph.plane.id ? belowPeek : null;
  // 見上げは天伏専用の切断高（裁定 2026-10-10）、見下げは平面の切断高
  const cutZ = direction === 'up' ? ceilingCutHeightMmOf(graph.plane) : planCutHeightMmOf(graph.plane);
  const tail = `${graph.plane.id}:${cutZ}:${peek?.graph?.plane?.id ?? (belowPeek === undefined ? 'pending' : '-')}`;
  return {
    home: peek?.graph ?? graph,
    key: direction === 'up' ? `planSection:up:${tail}` : `planSection:${tail}`,
    peek, cutZ,
  };
}

/**
 * レイヤが描く線の決定（ドラッグ中・未解決・キャッシュ）。
 *   - graph なし → null
 *   - 通り芯ドラッグ中 → prevPrims（前回の結果。無ければ null）。memo も呼ばない
 *   - それ以外 → memo(home, key, compute)（graphComputed）。belowPeek が undefined（下階の peek が未解決。階切替直後。
 *     null は「下階なし」で解決済み）の間は**自階だけの層**で解決して描く（鍵は下階 '-' と区別して 'pending'。下屋などが
 *     階切替のたびに消えないため）。peek が届くと通常の鍵で再計算され、下階の線だけが後から現れる
 * direction 'up'（見上げ・天伏）は belowPeek でなく abovePeek（直上階。3状態は同じ）を使い、見上げの線を解く。省略・'down' は従来どおり。
 * @param {{graph: object|null, belowPeek: object|null|undefined, abovePeek?: object|null|undefined, direction?: 'down'|'up', prevPrims?: Primitive[]|null,
 *   memo: (home: object, key: string, compute: () => Primitive[]) => Primitive[],
 *   selfRiserOf?: (stair: object) => number|null,
 *   aboveRiserOf?: (stair: object) => number|null  direction 'up' の上階の階段の蹴上（上階の plane で解く）}} args
 * @returns {Primitive[]|null}
 */
export function planSolidsLayerResolve({ graph, belowPeek, abovePeek, direction = 'down', prevPrims = null, memo, selfRiserOf, aboveRiserOf }) {
  if (!graph) return null;
  if (isCenterLineDragging(graph)) return prevPrims;
  if (direction === 'up') {
    const spec = planSolidsLayerCacheSpec(graph, abovePeek, 'up');
    return memo(spec.home, spec.key, () => planSolidsLayerPrimitivesUp({ graph, abovePeek: spec.peek, aboveRiserOf, cutZ: spec.cutZ }));
  }
  const { home, key, peek, cutZ } = planSolidsLayerCacheSpec(graph, belowPeek);
  return memo(home, key, () => planSolidsLayerPrimitives({ graph, belowPeek: peek, selfRiserOf, cutZ }));
}
