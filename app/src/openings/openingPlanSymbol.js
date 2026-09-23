// ================================================================
// 建具モード 平面記号（renderer/OpeningsLayer.jsx renderOpeningSymbol）の純関数化。
// ステップ11（作図P2）11a: 器＋線幅役割＋SCHEMATICディスパッチ＋tick/slideDouble leafのみ移行。
// 11b-1: 蝶番系その1（SWING・SWING_IN・PROJECT_V・DREH_KIPP）を追加移行。
//
// buildOpeningPlanSymbol(opening, ctx) → PlanPrimitive[] | null。
// **STANDARD/DETAILで entry があり IMPLEMENTED_MECHANISMS に含まれる機構のうち、まだ移行して
// いないものは null を返す**（呼び出し側 renderer/OpeningsLayer.jsx は null なら旧経路
// （otherMechanismSymbol等）をそのまま実行する暫定契約。11c〜11e で残りの機構を移行し、
// 11eでnull経路自体を削除する）。SWING_GROUP_MECHANISMS（本ステップで移行した4機構）は
// 非nullを返す。
//
// openingPlanSymbolGeometry.js と同じ抽出方針: react-konva/store.js/snap.js/.jsxを静的に
// 引かないことで node:test から単体 import できるようにする（抽出純モジュールはnode:testから
// 単体import可能に保つという不変条件）。
//
// プリミティブ語彙（ワールドmm。共通に role と weightMm を持つ）:
//   line{x1,y1,x2,y2,dash?} / polyline{points,closed} / rect{x,y,w,h,dash?} /
//   arc{cx,cy,r,startDeg,sweepDeg,dash?}
// role: 'symbol'(=opening.lineWeight) | 'frame'(=壁仕上げ材と同じ太さ) |
//       'leaf'(=中線。開いた扉本体) | 'arc'(=細線。開き勝手の動作弧)
// ================================================================

import { LINE_WEIGHT_MM } from '../core.js';
import { IMPLEMENTED_MECHANISMS, OpeningMechanism } from './openingCatalog.js';
import {
  planFrameBand, bandPerp, planSymbolPlan, swingOpenPerpDir, innerSpanOpening,
  swingClosedLeafSpan, closedAngleFor, leafOpenAngle, angleVectors,
  DOOR_OPEN_ANGLE_DEG, FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM,
} from './openingPlanSymbolGeometry.js';
import { LodLevel } from '../viewport.js';
import { wallFinishLineWeight } from '../finish/wallFinishJoin.js';

// 蝶番系その1（本ステップで移行）。SWINGのみ専用の「閉じた扉(詳細LOD)＋専用inset」扱いを持ち、
// 他3機構は汎用の notched（枠内法へ寄せる）経路を共有する（renderer/OpeningsLayer.jsx 旧
// entry.mechanism===SWING分岐／plan.frame==='notched'分岐と同じ判断の移設）。
const SWING_GROUP_MECHANISMS = new Set([
  OpeningMechanism.SWING,
  OpeningMechanism.SWING_IN,
  OpeningMechanism.PROJECT_V,
  OpeningMechanism.DREH_KIPP,
]);

// 開き戸 詳細LOD専用 枠寸法（すべてmm。旧 renderer/OpeningsLayer.jsxから移設。SWING専用）。
const DOOR_HINGE_GAP_MM = 5; // 開いた扉と吊元側の方立との隙間
// 吊元側後退量: 方立の全幅(30) - 吊元と方立の隙間(5)
export const FRAME_HINGE_INSET_MM = FRAME_JAMB_WIDTH_MM - DOOR_HINGE_GAP_MM;
// 戸先側後退量: 反対側の方立の「本体20mm」境界にぴったり納まる位置
export const FRAME_LATCH_INSET_MM = FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM;

// 記号未実装の機構のティックマーク半長（mm。renderer/OpeningsLayer.jsxから移設）。
// export＝唯一の定義箇所。renderer/OpeningsLayer.jsx側は独自の値を持たず、tickEndpoints
// （本ファイル）を経由してこの値を使う（QA指摘: 定数の二重管理・ドリフトの防止）。
export const TICK_HALF_MM = 30;

const VALID_LOD_LEVELS = new Set(Object.values(LodLevel));

// 長さ方向(along)・直交方向(perp)のワールド座標 → {x, y}（renderer/OpeningsLayer.jsxと同じ規約）。
function toWorld(isVertical, along, perp) {
  return isVertical ? { x: perp, y: along } : { x: along, y: perp };
}

function linePrim(role, weightMm, p1, p2) {
  return {
    type: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, role, weightMm,
  };
}

// 長さ方向[alongLo,alongHi]・直交方向[perpLo,perpHi]のワールド矩形 → rectプリミティブ
// （旧 renderer/OpeningsLayer.jsx rectSpec と同じ規約。role/weightMmを直接持たせる）。
function rectPrim(role, weightMm, isVertical, alongLo, alongHi, perpLo, perpHi) {
  return isVertical
    ? { type: 'rect', x: perpLo, y: alongLo, w: perpHi - perpLo, h: alongHi - alongLo, role, weightMm }
    : { type: 'rect', x: alongLo, y: perpLo, w: alongHi - alongLo, h: perpHi - perpLo, role, weightMm };
}

function polylinePrim(role, weightMm, points, closed) {
  return { type: 'polyline', points, closed, role, weightMm };
}

function arcPrim(role, weightMm, cx, cy, r, startDeg, sweepDeg) {
  return { type: 'arc', cx, cy, r, startDeg, sweepDeg, role, weightMm };
}

/**
 * 役割(role)→線の太さ(mm)。太さの供給源を1箇所に集約する（旧: OpeningsLayer.jsx内に
 * sp/fsp/dsp/aspの4種のオブジェクト生成として分散していた）。
 * - 'symbol' 記号本体（開口自身のlineWeight。既定medium）
 * - 'frame'  枠（方立・見込帯の外形）＝壁の仕上げ材と同じ太さ（wallFinishLineWeight）
 * - 'leaf'   蝶番系の扉本体（開いた位置の1本線・閉じた位置の四角）＝中線固定
 * - 'arc'    蝶番系の動作線円弧（開き勝手90/180°）＝細線固定
 * @param {'symbol'|'frame'|'leaf'|'arc'} role
 * @param {object} opening
 * @param {boolean} detail
 */
export function planSymbolWeightMm(role, opening, detail) {
  switch (role) {
    case 'symbol': return opening.lineWeight;
    case 'frame':  return wallFinishLineWeight(detail);
    case 'leaf':   return LINE_WEIGHT_MM.medium;
    case 'arc':    return LINE_WEIGHT_MM.thin;
    default: throw new TypeError(`planSymbolWeightMm: 未知のrole: ${role}`);
  }
}

/**
 * 記号未実装の機構のティック2本ぶんの端点（ワールド座標）。renderer/OpeningsLayer.jsx の
 * 新経路（tickPrimitives。role/weightMm付き）と旧経路（jsx側 tickSymbol。Konva Lineを直接返す）
 * の**両方がこの関数を呼ぶ**——生成処理（TICK_HALF_MM・toWorldの適用）を1箇所に一本化し、
 * 定数だけでなく計算そのものの二重管理を無くす（QA指摘）。
 * @returns {[[{x,y},{x,y}], [{x,y},{x,y}]]} [coord1側の[a,b], coord2側の[a,b]]
 */
export function tickEndpoints(opening, band) {
  const { coord1, coord2, isVertical } = opening;
  const axisValue = band.center;
  const endpoints = (along) => [
    toWorld(isVertical, along, axisValue - TICK_HALF_MM),
    toWorld(isVertical, along, axisValue + TICK_HALF_MM),
  ];
  return [endpoints(coord1), endpoints(coord2)];
}

// 記号未実装の機構: 開口端に短いティックマーク2本のみ描き、ギャップの存在を視認できるようにする
// （旧 renderer/OpeningsLayer.jsx tickSymbol）。role='symbol'固定。
function tickPrimitives(opening, band, weightMm) {
  return tickEndpoints(opening, band).map(([a, b]) => linePrim('symbol', weightMm, a, b));
}

// 引き違い leaf線2本のみ（枠矩形なし）。SCHEMATIC LODでの略図表現専用（旧 slideDoubleLeafLines）。
// role='symbol'固定（SCHEMATICは機構を問わずopening自身のlineWeightで描く旧仕様のまま）。
function slideDoubleLeafPrimitives(opening, band, weightMm) {
  const { coord1, coord2, centerCoord, isVertical } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);
  const leaf1Perp = bandPerp(band, 0.25);
  const leaf2Perp = bandPerp(band, 0.75);
  return [
    linePrim('symbol', weightMm,
      toWorld(isVertical, coord1, leaf1Perp), toWorld(isVertical, centerCoord + overlap / 2, leaf1Perp)),
    linePrim('symbol', weightMm,
      toWorld(isVertical, centerCoord - overlap / 2, leaf2Perp), toWorld(isVertical, coord2, leaf2Perp)),
  ];
}

// exteriorDirOfを1回だけ呼ぶ薄いメモ化（見込帯のexteriorDir計算専用。呼び出し元がbandを何度
// 参照しても実際の探査（wallFaceRange由来の反対壁探索等、host/graphを叩く重い処理）は1回で済む）。
// 11aでは呼び出し箇所が帯計算1箇所のみで効果が見えにくいが、11e（OVERHEAD/EMERGENCYを移行）で
// 帯計算と機構自身のopeningExteriorDir参照の2箇所から同じthunkを呼ぶようになるため残す。
function memoizeThunk(fn) {
  let called = false;
  let value;
  return () => {
    if (!called) { value = fn(); called = true; }
    return value;
  };
}

// ================================================================
// 蝶番系その1（SWING・SWING_IN・PROJECT_V・DREH_KIPP）のプリミティブ列（旧 renderer/
// OpeningsLayer.jsx swingLeafSymbol/swingSymbol/jambOutlinePoints/swingFrameSymbolの移設）。
// ================================================================

// 開き戸leaf1枚（開いた位置の扉線1本＋開き勝手の動作弧）。吊元位置・leaf長を引数化する
// （旧swingLeafSymbol）。swingSideの規約はopeningGeometry.js swingSideTowardPerpのperpDir=
// (isVertical?1:-1)*swingSide*hingeSideと整合（openingPlanSymbolGeometry.js leafOpenAngle参照）。
function swingLeafPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, leafWeight, arcWeight) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, DOOR_OPEN_ANGLE_DEG);
  const { dir } = angleVectors(openAngle);
  const far = { x: hinge.x + dir.x * leafLength, y: hinge.y + dir.y * leafLength };
  return [
    linePrim('leaf', leafWeight, hinge, far),
    arcPrim('arc', arcWeight, hinge.x, hinge.y, leafLength, closedAngle, openAngle - closedAngle),
  ];
}

// SWING（片開き）・SWING_IN/PROJECT_V/DREH_KIPP共通: 開口全幅（または内法へ寄せた区間）を
// 1本のleafとして描く（旧swingSymbol）。closedLeaf（詳細LODのSWINGのみ。{thickness,outward}）を
// 渡すと「閉じた状態の扉」を厚みのある矩形で追加する（区間計算はswingClosedLeafSpanに一本化）。
function swingPrimitives(opening, pivotPerp, leafWeight, arcWeight, hingeInset, latchInset, closedLeaf) {
  const { width, hingeSide, swingSide, isVertical } = opening;
  const effHingeInset = Math.min(hingeInset, width);
  const effLatchInset = Math.min(latchInset, width);
  const leafLength = Math.max(0, width - effHingeInset - effLatchInset);
  const hingeAlong = hingeSide < 0 ? opening.coord1 + effHingeInset : opening.coord2 - effHingeInset;
  const openLeaf = swingLeafPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, leafWeight, arcWeight);
  if (!closedLeaf) return openLeaf;
  const span = swingClosedLeafSpan({
    hingeAlong, hingeSide, leafLength, pivotPerp, outward: closedLeaf.outward, thickness: closedLeaf.thickness,
  });
  return [rectPrim('leaf', leafWeight, isVertical, span.alongLo, span.alongHi, span.perpLo, span.perpHi), ...openLeaf];
}

// 1つの方立の外形を単一の輪郭（六角形）として返す（旧jambOutlinePoints。内部に分割線を作らない）。
// outward>0: かかり代はtotalPerpLo側に残り、totalPerpHi側（室内・欠き込み側）が窄まる。outward<0はその逆。
function jambOutlinePoints(isVertical, outerAlong, dir, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward) {
  const A = outerAlong;
  const B = outerAlong + dir * (jambW - kakariW);
  const C = outerAlong + dir * jambW;
  const seq = outward > 0
    ? [[A, totalPerpLo], [C, totalPerpLo], [C, kakariPerpHi], [B, kakariPerpHi], [B, totalPerpHi], [A, totalPerpHi]]
    : [[A, totalPerpHi], [C, totalPerpHi], [C, kakariPerpLo], [B, kakariPerpLo], [B, totalPerpLo], [A, totalPerpLo]];
  return seq.flatMap(([along, perp]) => {
    const p = toWorld(isVertical, along, perp);
    return [p.x, p.y];
  });
}

// 開き戸 詳細LOD専用: 両端の方立（縦枠）を描く（旧swingFrameSymbol。リーフ・円弧はswingPrimitives
// が別途描画）。方立は全幅30mm（本体20mm＋かかり代10mm）だが、扉が通過する位置（pivotPerpから
// 室内側へ扉厚ぶん）だけかかり代が欠き込まれた段付き断面になる。pivotPerp・outwardは呼び出し側の
// planSymbolPlanの結果をそのまま使う（Math.sign(host.axisOffset)は使わない。J9/J11参照）。
function swingFramePrimitives(opening, band, pivotPerp, outward, frameWeight) {
  const { coord1, coord2, width, isVertical } = opening;
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, width / 2);
  const kakariW = Math.min(FRAME_KAKARI_WIDTH_MM, jambW);
  const totalPerpLo = band.lo;
  const totalPerpHi = band.hi;
  const notchFarRaw = pivotPerp - outward * DOOR_LEAF_THICKNESS_MM;
  const notchFar = Math.min(Math.max(notchFarRaw, totalPerpLo), totalPerpHi);
  const kakariPerpLo = outward > 0 ? totalPerpLo : notchFar;
  const kakariPerpHi = outward > 0 ? notchFar : totalPerpHi;
  return [
    polylinePrim('frame', frameWeight,
      jambOutlinePoints(isVertical, coord1, 1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward), true),
    polylinePrim('frame', frameWeight,
      jambOutlinePoints(isVertical, coord2, -1, jambW, kakariW, totalPerpLo, totalPerpHi, kakariPerpLo, kakariPerpHi, outward), true),
  ];
}

// 蝶番系その1（SWING_GROUP_MECHANISMS）のディスパッチ（J7: jambW・swingOpenPerpDir・
// planSymbolPlan／J9: SWING専用枝／J11: notched→swingFrame＋innerSpanの移設）。
// SWINGは「詳細LODで専用inset(FRAME_HINGE_INSET_MM/FRAME_LATCH_INSET_MM)＋閉じた扉」を
// 常に使う専用扱い（旧jsx entry.mechanism===SWING分岐。plan.frame==='notched'の一般経路には
// 乗らない＝innerSpanは使わない＝現状維持）。他3機構はplan.frameが'notched'（詳細LOD）のときだけ
// swingFrame＋内法へ寄せたopeningで描き、'none'（STANDARD）のときは開口全幅のまま描く。
function buildSwingGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi) {
  const leafWeight = planSymbolWeightMm('leaf', opening, detail);
  const arcWeight = planSymbolWeightMm('arc', opening, detail);
  const frameWeight = planSymbolWeightMm('frame', opening, detail);
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, opening.width / 2);
  const openPerpDir = swingOpenPerpDir(opening.isVertical, opening.hingeSide, opening.swingSide, entry.mechanism, entry);
  const plan = planSymbolPlan({
    mechanism: entry.mechanism, lodLevel, coord1: opening.coord1, coord2: opening.coord2,
    axisValue, band, jambWidth: jambW, faceLo, faceHi, openPerpDir,
  });

  if (entry.mechanism === OpeningMechanism.SWING) {
    const frame = detail ? swingFramePrimitives(opening, band, plan.pivotPerp, plan.leafOutward, frameWeight) : [];
    const leaf = swingPrimitives(opening, plan.pivotPerp, leafWeight, arcWeight,
      detail ? FRAME_HINGE_INSET_MM : 0,
      detail ? FRAME_LATCH_INSET_MM : 0,
      detail ? { thickness: DOOR_LEAF_THICKNESS_MM, outward: plan.leafOutward } : null);
    return [...frame, ...leaf];
  }

  // SWING_IN / PROJECT_V / DREH_KIPP
  if (plan.frame === 'notched') {
    const spanOpening = innerSpanOpening(opening, plan.innerSpan);
    const frame = swingFramePrimitives(opening, band, plan.pivotPerp, plan.leafOutward, frameWeight);
    const leaf = swingPrimitives(spanOpening, plan.pivotPerp, leafWeight, arcWeight, 0, 0, null);
    return [...frame, ...leaf];
  }
  return swingPrimitives(opening, plan.pivotPerp, leafWeight, arcWeight, 0, 0, null);
}

/**
 * 建具1件の平面記号プリミティブ列を返す純関数。
 * @param {object} opening core.js の Opening 相当（coord1/coord2/centerCoord/isVertical/width/
 *   frameDepth/lineWeightを読む）
 * @param {{entry: object|null, lodLevel: string, axisValue: number, faceLo?: number,
 *   faceHi?: number, exteriorDirOf: () => number}} ctx
 *   entry: findCatalogEntryの結果（無ければnull）。lodLevel: viewport.js LodLevel。
 *   axisValue: host.axisValue。faceLo/faceHi: 壁面線（略図LODでは未定義）。
 *   exteriorDirOf: 開口の外部側方向(±1)を返すthunk（詳細LODかつframeDepth>0のときだけ
 *   呼ぶ。呼ぶたびに再計算しないよう内部で1回だけメモ化して呼ぶ）。
 * @returns {object[]|null} プリミティブ配列。STANDARD/DETAILでentryがありIMPLEMENTED_MECHANISMS
 *   に含まれる機構のうちSWING_GROUP_MECHANISMS以外は暫定契約としてnull（呼び出し側は旧経路を
 *   実行する。11c〜11e で残りの機構を移行し尽くした後に削除予定）。
 */
export function buildOpeningPlanSymbol(opening, ctx) {
  const { entry = null, lodLevel, axisValue, faceLo, faceHi, exteriorDirOf } = ctx ?? {};

  if (!Number.isFinite(axisValue)) {
    throw new TypeError(`buildOpeningPlanSymbol: ctx.axisValueは有限数が必要です（受け取った値: ${axisValue}）`);
  }
  if (typeof exteriorDirOf !== 'function') {
    throw new TypeError('buildOpeningPlanSymbol: ctx.exteriorDirOfは関数が必要です');
  }
  if (!VALID_LOD_LEVELS.has(lodLevel)) {
    throw new TypeError(`buildOpeningPlanSymbol: ctx.lodLevelが未知です: ${lodLevel}`);
  }

  const detail = lodLevel === LodLevel.DETAIL;

  // STANDARD/DETAILでentryが実装済み機構を指す場合、SWING_GROUP_MECHANISMS（本ステップで
  // 移行済み）以外は未移行——旧経路(OpeningsLayer.jsx側のotherMechanismSymbol等)がそのまま
  // 描くため、ここではband計算（exteriorDirOfの呼び出しを含む）自体を行わない（呼び出し側と
  // 二重に計算・二重にthunkを呼ばないため）。
  const implemented = lodLevel !== LodLevel.SCHEMATIC && entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism);
  const swingGroup = implemented && SWING_GROUP_MECHANISMS.has(entry.mechanism);
  if (implemented && !swingGroup) {
    return null;
  }

  const memoExteriorDirOf = memoizeThunk(exteriorDirOf);
  const band = detail
    ? planFrameBand({
        axisValue, faceLo, faceHi, frameDepth: opening.frameDepth,
        exteriorDir: opening.frameDepth > 0 ? memoExteriorDirOf() : undefined,
        detail: true,
      })
    : planFrameBand({ axisValue, detail: false });

  const symbolWeight = planSymbolWeightMm('symbol', opening, detail);

  // 略図: 機構を問わずティックマークのみ（視認ノイズを減らす簡略表示）。ただし引き違い
  // （戸・窓）だけはtickに加えてleaf線2本（枠矩形なし）も描く。
  if (lodLevel === LodLevel.SCHEMATIC) {
    const prims = tickPrimitives(opening, band, symbolWeight);
    if (entry?.mechanism === OpeningMechanism.SLIDE_DOUBLE) {
      prims.push(...slideDoubleLeafPrimitives(opening, band, symbolWeight));
    }
    return prims;
  }

  // STANDARD/DETAILで蝶番系その1（SWING_GROUP_MECHANISMS）: 専用ディスパッチへ。
  if (swingGroup) {
    return buildSwingGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi);
  }

  // STANDARD/DETAILでentryが無い・未実装機構: ティックマークのみ。
  return tickPrimitives(opening, band, symbolWeight);
}
