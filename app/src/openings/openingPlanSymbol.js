// ================================================================
// 建具モード 平面記号（renderer/OpeningsLayer.jsx renderOpeningSymbol）の純関数化。
// ステップ11（作図P2）11a: 器＋線幅役割＋SCHEMATICディスパッチ＋tick/slideDouble leafのみ移行。
//
// buildOpeningPlanSymbol(opening, ctx) → PlanPrimitive[] | null。
// **STANDARD/DETAILで entry があり IMPLEMENTED_MECHANISMS に含まれる機構は null を返す**
// （呼び出し側 renderer/OpeningsLayer.jsx は null なら旧経路（otherMechanismSymbol等）を
// そのまま実行する暫定契約。11b〜11e で機構ごとに移行し、11eでnull経路自体を削除する）。
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
import { planFrameBand, bandPerp } from './openingPlanSymbolGeometry.js';
import { LodLevel } from '../viewport.js';
import { wallFinishLineWeight } from '../finish/wallFinishJoin.js';

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
 *   に含まれる機構は暫定契約としてnull（呼び出し側は旧経路を実行する。11e で削除予定）。
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

  // STANDARD/DETAILでentryが実装済み機構を指す場合は未移行——旧経路(OpeningsLayer.jsx側の
  // otherMechanismSymbol等)がそのまま描くため、ここではband計算（exteriorDirOfの呼び出しを
  // 含む）自体を行わない（呼び出し側と二重に計算・二重にthunkを呼ばないため）。
  if (lodLevel !== LodLevel.SCHEMATIC && entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism)) {
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

  // STANDARD/DETAILでentryが無い・未実装機構: ティックマークのみ。
  return tickPrimitives(opening, band, symbolWeight);
}
