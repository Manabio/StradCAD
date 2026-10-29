// ================================================================
// S造スラブのベイ指定（指定・解除・照会）の純関数。
//
// S造スラブ（SteelSlab）は、梁で囲まれた区画「ベイ」を単位に指定する。cells はベイキー
// （slabSecondaryBeamAxes.js bayCellKey＝`左:上:右:下` の4辺の軸CL id。finish/gridCells.js の
// セルキーと同形で cellBoundsFromKey がそのまま矩形に解決する）の集合。ベイの計算は
// slabSecondaryBeamAxes.js buildBays が唯一（listSlabBays 経由）。設計意図は structural-model.md「S造スラブ（ベイ指定）」。
//
// 変更系（assign/release）は graph を直接変える素の関数。MobX の action ラッパーは持たない
// （呼び出し側が onStructureChanged / runInAction で包む。manualMemberAdd.js と同じ流儀）。
//
// 純モジュール: react/.jsx/store.js/snap.js を静的 import しない。依存方向は
// steelSlabBays → slabSecondaryBeamAxes（ベイ計算）→ steelSlabBayIndex（ベイキー・ブレースのベイ）・steelSlabSpec。循環なし。
// ================================================================
import { StructuralMaterialType, isBayKeyedSlab } from '../core.js';
import { SlabBayFillSkip } from '../core/constants.js';
import { rulesFor, effectiveStructure } from './structureRules.js';
import { isFoundationPlane } from './drawingDesignation.js';
import { listSlabBays, bayBraceInfos, defaultChildDepthMm } from './slabSecondaryBeamAxes.js';
import { bayCellKey, braceBayMap } from './steelSlabBayIndex.js';
import { resolveSteelSlabSpec, resolveBraceHeightMm } from './steelSlabSpec.js';

// bayCellKey・braceBayMap は steelSlabBayIndex.js（slabSecondaryBeamAxes.js からも引かれる低層）が本体。
export { bayCellKey, braceBayMap };

/**
 * この階で S造スラブをベイ指定できるか。主構造の選択子（steelSlabAssignment＝S造だけ）が真、かつ
 * 基礎伏図（最下階）でも屋根専用平面でもないこと。ベイの計算（buildBays）の対象＝slabSecondaryBeams 非 null が前提。
 */
export function canAssignSteelSlab(graph, project) {
  if (!rulesFor(effectiveStructure(graph, project)).steelSlabAssignment) return false;
  if (graph.plane.isRoofPlane) return false;
  return !isFoundationPlane(graph.plane, project);
}

// ベイキーを保持する S造スラブだけ（RcSlab・べた基礎などには触らない）。
const steelSlabs = (graph) => graph.slabs.filter(isBayKeyedSlab);

/** key を保持している S造スラブ。無ければ null。 */
export function steelSlabForBay(graph, key) {
  return steelSlabs(graph).find(s => s.cells.has(key)) ?? null;
}

// keys を S造スラブから外し、空になったスラブを削除する。触ったスラブ id（削除分を含む）と削除したスラブ id を返す。
function detachKeys(graph, keys) {
  const touched = [], removed = [];
  for (const slab of steelSlabs(graph)) {
    const rest = [...slab.cells].filter(k => !keys.has(k));
    if (rest.length === slab.cells.size) continue;
    touched.push(slab.id);
    if (rest.length === 0) { graph.removeSlab(slab.id); removed.push(slab.id); } else slab.setCells(new Set(rest));
  }
  return { touched, removed };
}

/**
 * keys のベイを1枚の S造スラブとして指定する。すでに別の S造スラブが持つキーは先にそちらから外す
 * （空になったスラブは削除。RcSlab などベイキーでないスラブには触らない）。検証はすべて変更の前に行い、
 * 失敗しても graph は変わらない。
 * @param {object} graph
 * @param {object} project
 * @param {Iterable<string>} keys ベイキー（listSlabBays の key）
 * @param {{steelSpec?: object|null, openingRects: Array<object>}} opts steelSpec＝個別仕様（null＝共通に従う）。
 *   openingRects＝床開口のセル矩形（必須。開口なしは []）。呼び出し側（UI）は structuralRecompute と同じ
 *   `openingCellRects(graph, {riserOf, belowGraph})`（openingBeamAxes.js）の結果を渡す。省略すると開口ベイを
 *   指定できてしまうため、undefined は例外にする。
 * @returns {{slabId: string, releasedFrom: string[]}} releasedFrom＝キーを奪われた既存スラブ id（削除されたものを含む）
 * @throws {Error} S造の階でない・openingRects 未指定・keys が空・現況のベイでない・開口のベイ
 */
export function assignSteelSlabBays(graph, project, keys, { steelSpec = null, openingRects = undefined } = {}) {
  if (!canAssignSteelSlab(graph, project)) throw new Error('S造の階だけ、スラブをベイ指定できます');
  if (openingRects === undefined) throw new Error('openingRects は必須（開口なしは [] を渡す）');
  const keySet = new Set(keys);
  if (keySet.size === 0) throw new Error('指定するベイがありません');
  const bays = new Map(listSlabBays(graph, project, openingRects).filter(b => b.key != null).map(b => [b.key, b]));
  for (const key of keySet) {
    const bay = bays.get(key);
    if (!bay) throw new Error(`現在のベイではありません: ${key}`);
    if (bay.skip === SlabBayFillSkip.OPENING) throw new Error(`床開口のベイは指定できません: ${key}`);
  }
  const { touched } = detachKeys(graph, keySet);
  const slab = graph.addSlab(StructuralMaterialType.STEEL, null, keySet, { steelSpec });
  // ユーザーが指定したスラブは手動追加材と同じ扱い＝locked（auto のままだと主構造変更の撤去段
  // deleteClassificationOverflow が「×」化したスラブとして黙って消す。structural-model.md「手動追加は locked」）。
  slab.setDimensionStatus('locked');
  return { slabId: slab.id, releasedFrom: touched };
}

/**
 * keys のベイを S造スラブから解除する。空になったスラブは削除する。どのスラブにも無いキーは無視する（例外なし）。
 * @returns {string[]} 削除したスラブの id
 */
export function releaseSteelSlabBays(graph, keys) {
  return detachKeys(graph, new Set(keys)).removed;
}

/**
 * ブレース設置高さの解決結果（スラブカードの読取専用の注記用。S7）。ブレースの高さは子梁成に依る
 * （null＝自動は子梁成の1/2、指定は 0〜子梁成に丸める）。スラブが複数ベイを持つときは**各ベイの子梁成の最小**で
 * 解決する（どのベイでも子梁成を超えない値を示すため。リード裁定）。ベイが現況に無い（辺のCLが消えた等）ときは
 * そのベイを数えず、全部無ければ主構造の既定の梁断面→フォールバック断面の成。
 * exceededBays＝対角線長が上限を超えるベイ数（短辺が上限以上で 2500 ピッチへ戻るベイ・U1 で n 固定のベイ）。
 * @returns {{childDepthMm:number, resolvedMm:number, clamped:boolean, exceededBays:number}} clamped＝指定値が子梁成を超えて丸められた
 */
export function steelSlabBraceHeightInfo(graph, project, slab) {
  const spec = resolveSteelSlabSpec(slab.steelSpec, project.structuralInfo?.steelSlabSpec);
  const infos = [...bayBraceInfos(graph, project, slab.cells).values()];
  const childDepthMm = infos.length > 0 ? Math.min(...infos.map(i => i.childDepthMm)) : defaultChildDepthMm(graph, project);
  const resolvedMm = resolveBraceHeightMm(spec, childDepthMm);
  const requested = spec.braceHeightMm;
  return {
    childDepthMm, resolvedMm, clamped: requested != null && requested > childDepthMm,
    exceededBays: infos.filter(i => i.exceeded).length,
  };
}
