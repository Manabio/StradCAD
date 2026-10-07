/**
 * 在来木造の折返し階段（SWITCHBACK）の「隔て壁（隔て板）」の判定と幾何を返す純モジュール。
 *
 * 隔て壁は往路・復路レーンの間（レーン間中心線 s=0.5）に立つ壁。仕様（問題.md）:
 *   - 端部（踊り場側）に90角の材を建てる（下地厚 PARTITION_BACKING_MM）
 *   - 両面 PB ア)12.5
 *   - 天端は、設置階上階FL+800（上り口・下り口側）から、復路直進部の開始段の段鼻高さ+800
 *     （踊り場側）まで斜めの途中壁
 *   - 上下に折返し階段が続く場合は各層フルハイトの壁。斜め天端は最上階（連鎖の末尾）のみ
 *
 * 設計意図: 隔て壁は保存せず毎回この関数で導出する（階段・階高・主構造から一意に決まるため）。
 * 2a壁（stairUnderWalls.js のルール6・レーン間中心線壁）と同じライフサイクル（仕上げ脱出時の
 * 再生成）を壁生成側（S2）で与える予定。ここは判定と幾何だけで、壁・描画・構造への配線は持たない。
 *
 * 幾何は stairUnderWalls.js の buildUTurnContext と同じ枠（roomBounds + makeFrame + uTurnSpans）を
 * 使い、回転部前縁 tRun を再導出しない（2a壁・描画と同じ値を読む）。
 *
 * 純モジュール: store.js / snap.js / *.jsx を静的 import しない（node:test から単体 import 可能）。
 * 主構造の判定は structural/structureRules.js の isTraditionalWoodStructure（core非依存の静的データのみ）。
 */

import { StairType } from '@core';
import { roomBounds } from '../gridCells.js';
import { makeFrame } from './stairFrame.js';
import { uTurnSpans, defaultSections } from './stairClassify.js';
import { riserOf } from './stairDimensions.js';
import { isTraditionalWoodStructure } from '../../structural/structureRules.js';

/** 端部の90角（下地厚）mm。仕様で固定した値で、既定の壁材（DEFAULT_WALL_BASE）とは連動させない */
export const PARTITION_BACKING_MM = 90;
/** 両面のPB仕上げ厚 mm（ア)12.5）。仕様で固定した値で、既定の壁材（DEFAULT_WALL_FINISH）とは連動させない */
export const PARTITION_FINISH_MM = 12.5;
/** 天端が段鼻高さ（および上階FL）から上がる量 mm */
export const PARTITION_TOP_ABOVE_NOSING_MM = 800;
/** 壁の総厚 = 下地 + 両面仕上げ（115） */
export const PARTITION_THICKNESS_MM = PARTITION_BACKING_MM + 2 * PARTITION_FINISH_MM;

const FULL = Object.freeze({ kind: 'full' });

// 斜め天端。復路直進部の開始段＝復路の最初の踏面。stairGeometry.js buildSwitchback では
// 踏面番号 = 往路マス数(n1-1) + 踊り場マス数(sections[1]) + 1 に取りつき回転部の蹴上数(entryTurnSteps)
// を足した値（stairParts の numberStart＋ numberStart += turnStepsE）。踏面 k の面は k×蹴上
// （総蹴上数 = 総マス数+1。stairLanding.js landingZ が 踊り場 = (n1+entryTurnSteps)×riser とするのと同じ規約）。
// よって復路の最初の踏面の段鼻高さ = (entryTurnSteps + sections[0] + sections[1]) × riser。
// entryTurnSteps は landingZ と同じく無条件に足す: 出入口が走行端のとき 0 に保たれるのは portSideChange 側
// （Stair の仕様）で、ここで ports を再解決せず landingZ と揃える。
// riser・sections が解決できなければ null（呼び出し側はフルハイトへ安全側に倒す）。
function slopeTop(stair, floorHeight) {
  const sections = stair.sections ?? defaultSections(stair);
  if (!Array.isArray(sections) || sections.length !== 3 || !sections.every(Number.isFinite)) return null;
  const riser = riserOf(stair, floorHeight);
  if (!Number.isFinite(riser) || !(riser > 0) || !Number.isFinite(floorHeight)) return null;
  const nosingIndex = (stair.entryTurnSteps || 0) + sections[0] + sections[1];
  return {
    kind: 'slope',
    zAtEntryEnd: floorHeight + PARTITION_TOP_ABOVE_NOSING_MM,
    zAtLandingEnd: nosingIndex * riser + PARTITION_TOP_ABOVE_NOSING_MM,
  };
}

/**
 * 折返し階段の隔て壁の幾何を返す。隔て壁が無い（対象外）なら null。
 * 対象は在来木造・SWITCHBACK のみ。WINDING（回り階段）は仕様未裁定のため対象外。
 * 両レーンが並走する区間だけに立つ（短い方のレーンの基端〜回転部前縁 tRun）。
 * 既知の限界（裁定事項）: 復路レーンが長い場合も上り口側の天端は上階FL+800のままとしている。
 *
 * @param {import('@core').Stair} stair
 * @param {object} graph
 * @param {{ structure:string|null, continuesAbove?:boolean, floorHeight?:number|null }} opts
 *   structure … 実効の主構造（isTraditionalWoodStructure に渡す値）。
 *   continuesAbove … 上に続きの折返し階段がある（stairChains の末尾でない）→ フルハイト。
 *   floorHeight … 設置階〜上階の階高(mm)（floorHeightAbove）。蹴上が決まらなければフルハイト。
 * @returns {{
 *   isVertical:boolean, axisValue:number, lo:number, hi:number,
 *   entryEnd:{x:number,y:number}, landingEnd:{x:number,y:number},
 *   thickness:{backing:number, finish:number, total:number},
 *   top:{kind:'full'}|{kind:'slope', zAtEntryEnd:number, zAtLandingEnd:number},
 * }|null}
 */
export function resolveStairPartition(stair, graph, { structure = null, continuesAbove = false, floorHeight = null } = {}) {
  if (!stair || stair.type !== StairType.SWITCHBACK) return null;
  if (!isTraditionalWoodStructure(structure)) return null;

  const b = roomBounds(stair.cells, graph);
  if (![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite)) return null;
  const us = uTurnSpans(stair, graph, b);
  if (!us) return null;
  const f = makeFrame(stair, b);

  const tEntry = us.tRun - Math.min(us.laneA, us.laneB) / f.runLength;
  const entryEnd = f.pt(tEntry, 0.5);
  const landingEnd = f.pt(us.tRun, 0.5);
  const along = (p) => (f.vertical ? p.y : p.x);
  const axisValue = f.vertical ? entryEnd.x : entryEnd.y;

  return {
    isVertical: f.vertical,
    axisValue,
    lo: Math.min(along(entryEnd), along(landingEnd)),
    hi: Math.max(along(entryEnd), along(landingEnd)),
    entryEnd, landingEnd,
    thickness: { backing: PARTITION_BACKING_MM, finish: PARTITION_FINISH_MM, total: PARTITION_THICKNESS_MM },
    top: continuesAbove ? FULL : (slopeTop(stair, floorHeight) ?? FULL),
  };
}
