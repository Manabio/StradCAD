// ================================================================
// 建具モード 平面記号（renderer/OpeningsLayer.jsx renderOpeningSymbol）の純関数化。
// ステップ11（作図P2）11a: 器＋線幅役割＋SCHEMATICディスパッチ＋tick/slideDouble leafのみ移行。
// 11b-1: 蝶番系その1（SWING・SWING_IN・PROJECT_V・DREH_KIPP）を追加移行。
// 11b-2: 蝶番系その2（SWING_DOUBLE・SWING_CHILD・FREE・FREE_DOUBLE・FIRE_DOOR・FIRE_FOLD）を追加移行。
// SWINGのような専用inset扱いを持つ機構は無く、全機構が蝶番系その1のSWING_IN等と同じ汎用の
// notched（枠内法へ寄せる）経路を共有する（renderer/OpeningsLayer.jsx 旧
// otherMechanismSymbol内のswingDoubleSymbol/swingChildSymbol/freeSymbol/freeDoubleSymbol/
// fireDoorSymbol/fireFoldSymbolと同じ判断の移設）。
// 11c: 引戸系＋上げ下げ窓（SLIDE_DOUBLE・SLIDE_SINGLE・SLIDE_LAYOUT・HUNG）とsashOpen枠を追加移行。
// SLIDE_DOUBLEはSWINGと同様planSymbolPlanを介さずband直接の専用扱い（旧jsx entry.mechanism===
// SLIDE_DOUBLE早期return）。SLIDE_SINGLE/SLIDE_LAYOUT/HUNGはSASH_OPEN_MECHANISMS（記号自身が
// 開口全幅の枠矩形を描く非蝶番系）のうち本ステップで移行する3機構——旧
// otherMechanismSymbol内のslideSingleSymbol/slideLayoutSymbol/hungSymbol、旧sashFrameOpenSymbol
// と同じ判断の移設（windowLine群10機構は同じSASH_OPEN_MECHANISMSだが11dで移行）。
// 11d: 窓ほか（FIXED/TILT/TILT_OUT/AWNING/PROJECT_OUT/LOUVER/AWNING_MULTI/GARARI/GLASS_BLOCK/
// PIVOT_H の10機構＝windowLine群）・FOLD・PIVOT・sash枠（閉じ矩形）を追加移行。windowLine群は
// openingCatalog.js SASH_OPEN_MECHANISMS（frame='sashOpen'。方立はコの字）と完全一致するため
// SASH_OPEN_GROUP_MECHANISMSへ追加するだけで11cの経路（buildSashOpenGroupPrimitives）に乗る
// （旧windowLineSymbolと同じ判断の移設）。FOLD・PIVOTはHINGED_MECHANISMSにもSASH_OPEN_MECHANISMSにも
// 含まれないためplanSymbolPlanはframe='sash'（詳細LODで方立=閉じた矩形2つ。旧sashFrameSymbol）を
// 返す——11b/11cのどちらの枠経路とも異なるため専用のSASH_GROUP_MECHANISMS・
// buildSashGroupPrimitivesを新設する。PIVOTの弧・線は「動作線ではなく記号の姿そのもの」
// （旧renderer/OpeningsLayer.jsx renderOpeningSymbolのコメント）としてrole='symbol'固定
// （蝶番系のleaf/arcロールは使わない——PIVOTはHINGED_MECHANISMSに含まれない非蝶番系のため）。
// 11e: 残り4機構（SHUTTER・OVERHEAD・EMERGENCY・FRAME_ONLY）を移行し、buildOpeningPlanSymbolの
// 暫定null経路を削除する。SHUTTER・OVERHEAD・EMERGENCYはopeningCatalog.js SASH_OPEN_MECHANISMSに
// 含まれない非蝶番系（同ファイルのコメント「既知の例外」参照）のため、FOLD・PIVOTと同じ
// SASH_GROUP_MECHANISMS（frame='sash'）に合流する——専用の枠経路を新設する必要はない
// （旧shutterSymbol/overheadSymbol/emergencySymbolと同じ判断の移設）。OVERHEAD・EMERGENCYは
// 開口の外部側方向（exteriorDirOf）を参照する——帯計算（見込みexteriorDir）と合わせて呼び出し元が
// 同じthunkを1回だけ評価するよう、buildSashGroupPrimitives以下へmemoizeThunk済みのexteriorDirOfを
// 引き渡す（呼び出し箇所が増える11eでmemoizeThunkの効果が初めて表れる）。FRAME_ONLY（三方枠）は
// planSymbolPlanがlodLevelに関わらず常にframe='frameOnly'を返す唯一の機構——他5グループのどの
// 枠経路にも属さない専用ディスパッチ（buildFrameOnlyPrimitives）を新設する（旧frameOnlySymbolの
// 移設）。
//
// buildOpeningPlanSymbol(opening, ctx) → PlanPrimitive[]。IMPLEMENTED_MECHANISMSの全機構を
// カバーし終えたため（11e）、常に非空の配列を返す（entry無し・未実装機構文字列はtickPrimitives）。
// SWING_GROUP_MECHANISMS（11b-1）・HINGE_GROUP2_MECHANISMS（11b-2）・SLIDE_DOUBLE・
// SASH_OPEN_GROUP_MECHANISMS（11c・11d）・SASH_GROUP_MECHANISMS（11d・11e）・FRAME_ONLY（11e）が
// それぞれ専用ディスパッチを持つ。
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

import { LINE_WEIGHT_MM, OpeningCategory } from '../core.js';
import { IMPLEMENTED_MECHANISMS, OpeningMechanism, frameProfileFor } from './openingCatalog.js';
import {
  planFrameBand, bandPerp, planSymbolPlan, swingOpenPerpDir, innerSpanOpening,
  swingClosedLeafSpan, closedAngleFor, leafOpenAngle, angleVectors,
  swingDoubleLeafSpecs, swingChildLeafSpecs, fireDoorLeafSpecs, fireFoldLeafSpecs,
  trackOf, trackPerp, resolveSlideLayoutPanels, foldZigzagPoints, frameOnlyJambProfiles,
  DOOR_OPEN_ANGLE_DEG, FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM,
} from './openingPlanSymbolGeometry.js';
import { fixtureSymbolOf, effectiveFrameFaceWidth, effectiveFrameProjection } from './openingNumbering.js';
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

// 蝶番系その2（11b-2で移行）。SWINGのような専用inset扱いを持つ機構が無く、全機構が蝶番系その1の
// SWING_IN等と同じ汎用のnotched経路を共有する（buildHingeGroup2Primitives参照）。
const HINGE_GROUP2_MECHANISMS = new Set([
  OpeningMechanism.SWING_DOUBLE,
  OpeningMechanism.SWING_CHILD,
  OpeningMechanism.FREE,
  OpeningMechanism.FREE_DOUBLE,
  OpeningMechanism.FIRE_DOOR,
  OpeningMechanism.FIRE_FOLD,
]);

// 非蝶番sashOpen系（11c: SLIDE_SINGLE/SLIDE_LAYOUT/HUNG、11d: windowLine群10機構を追加）。
// openingCatalog.js SASH_OPEN_MECHANISMS（記号自身が開口全幅の枠矩形を描く非蝶番系。方立は
// 内側縦線を持たない3辺=コの字）と11d時点で完全一致する（旧 renderer/OpeningsLayer.jsx
// otherMechanismSymbol内のslideSingleSymbol/slideLayoutSymbol/hungSymbol/windowLineSymbolと
// 同じ判断の移設）。SASH_OPEN_MECHANISMSそのものを再利用せず独自の集合として持つのは、
// 「SASH_OPEN_MECHANISMSに属する＝このグループで移行済み」という前提がこの先も自明ではない
// ため（buildSashOpenGroupPrimitivesの防御的throw参照。将来SASH_OPEN_MECHANISMSに機構が
// 追加されてもこの集合には自動で入らない）。
const SASH_OPEN_GROUP_MECHANISMS = new Set([
  OpeningMechanism.SLIDE_SINGLE,
  OpeningMechanism.SLIDE_LAYOUT,
  OpeningMechanism.HUNG,
  OpeningMechanism.FIXED,
  OpeningMechanism.TILT,
  OpeningMechanism.TILT_OUT,
  OpeningMechanism.AWNING,
  OpeningMechanism.PROJECT_OUT,
  OpeningMechanism.LOUVER,
  OpeningMechanism.AWNING_MULTI,
  OpeningMechanism.GARARI,
  OpeningMechanism.GLASS_BLOCK,
  OpeningMechanism.PIVOT_H,
]);

// 非蝶番sash系（11dでFOLD・PIVOT、11eでSHUTTER・OVERHEAD・EMERGENCYを追加移行）。
// HINGED_MECHANISMSにもSASH_OPEN_MECHANISMSにも含まれないためplanSymbolPlanはframe='sash'
// （詳細LODで方立=閉じた矩形2つ。旧sashFrameSymbol）を返す（旧 renderer/OpeningsLayer.jsx
// otherMechanismSymbol内のfoldSymbol/pivotSymbol/shutterSymbol/overheadSymbol/emergencySymbolと
// 同じ判断の移設）。SHUTTER/OVERHEADがSASH_OPEN_MECHANISMSに含まれない理由は
// openingCatalog.js側のコメント（「既知の例外」）を参照——記号自身が開口全幅の枠矩形を持たない
// ためsashOpen（内側縦線なしのコの字）へは寄せない。
const SASH_GROUP_MECHANISMS = new Set([
  OpeningMechanism.FOLD,
  OpeningMechanism.PIVOT,
  OpeningMechanism.SHUTTER,
  OpeningMechanism.OVERHEAD,
  OpeningMechanism.EMERGENCY,
]);

// FOLD（折れ戸・折りたたみ窓）ジグザグの振幅（mm。唯一の定義箇所）。
const FOLD_AMPLITUDE_MM = 120;

// 引き違い 詳細LOD用（すべてmm。唯一の定義箇所）。
const SLIDE_TRACK_INSET_MM = 4; // 枠から戸先・召し合わせレールまでの隙間
export const WEATHERSTRIP_DASH = [6, 4]; // 召し合わせ部・気密材(モヘア)の破線パターン

// 開き戸 詳細LOD専用 枠寸法（すべてmm。唯一の定義箇所。SWING専用）。
const DOOR_HINGE_GAP_MM = 5; // 開いた扉と吊元側の方立との隙間
// 吊元側後退量: 方立の全幅(30) - 吊元と方立の隙間(5)
export const FRAME_HINGE_INSET_MM = FRAME_JAMB_WIDTH_MM - DOOR_HINGE_GAP_MM;
// 戸先側後退量: 反対側の方立の「本体20mm」境界にぴったり納まる位置
const FRAME_LATCH_INSET_MM = FRAME_JAMB_WIDTH_MM - FRAME_KAKARI_WIDTH_MM;

// 記号未実装の機構のティックマーク半長（mm。唯一の定義箇所）。
const TICK_HALF_MM = 30;

// FIRE_DOOR/FIRE_FOLD（常時開放式防火戸・防火折戸）専用の破線・振幅定数（mm）。動作弧は
// 「金物が外れた際に開放される軌跡」を示す補助線のため、他の蝶番系（実線）と区別して破線にする
// ——FIRE_ARC_DASH_MMが唯一の定義箇所。
export const FIRE_ARC_DASH_MM = [10, 6];
// 常時開放式防火折戸: 吊元側に畳んだジグザグの山数・振幅（唯一の定義箇所）。
const FIRE_FOLD_PEAKS = 2;
const FIRE_FOLD_AMP_MM = 60;

// SHUTTER/OVERHEAD/EMERGENCYの記号寸法（すべてmm。旧 renderer/OpeningsLayer.jsxから移設。11e）。
const SHUTTER_DASH      = [14, 4, 4, 4]; // シャッターの一点鎖線
const OVERHEAD_DASH     = [10, 6];       // オーバーヘッドドアの跳ね上げ投影（破線）
const OVERHEAD_DEPTH_MM = 200;
const EMERGENCY_SIDE_MM = 400; // 非常用進入口の逆三角形の一辺

const VALID_LOD_LEVELS = new Set(Object.values(LodLevel));

// 長さ方向(along)・直交方向(perp)のワールド座標 → {x, y}。
function toWorld(isVertical, along, perp) {
  return isVertical ? { x: perp, y: along } : { x: along, y: perp };
}

function linePrim(role, weightMm, p1, p2, dash) {
  return {
    type: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, role, weightMm, dash,
  };
}

// 長さ方向[alongLo,alongHi]・直交方向[perpLo,perpHi]のワールド矩形 → rectプリミティブ
// （旧 renderer/OpeningsLayer.jsx rectSpec と同じ規約。role/weightMmを直接持たせる）。dashは
// 省略可（未指定はundefined。OVERHEAD_DASHを持つoverheadPrimitivesのみが渡す。11e）。
function rectPrim(role, weightMm, isVertical, alongLo, alongHi, perpLo, perpHi, dash) {
  return isVertical
    ? { type: 'rect', x: perpLo, y: alongLo, w: perpHi - perpLo, h: alongHi - alongLo, role, weightMm, dash }
    : { type: 'rect', x: alongLo, y: perpLo, w: alongHi - alongLo, h: perpHi - perpLo, role, weightMm, dash };
}

function polylinePrim(role, weightMm, points, closed) {
  return { type: 'polyline', points, closed, role, weightMm };
}

function arcPrim(role, weightMm, cx, cy, r, startDeg, sweepDeg, dash) {
  return { type: 'arc', cx, cy, r, startDeg, sweepDeg, role, weightMm, dash };
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
 * 記号未実装の機構のティック2本ぶんの端点（ワールド座標）。唯一の定義箇所（TICK_HALF_MM・
 * toWorldの適用を1箇所に一本化する）。
 * @returns {[[{x,y},{x,y}], [{x,y},{x,y}]]} [coord1側の[a,b], coord2側の[a,b]]
 */
function tickEndpoints(opening, band) {
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

// ================================================================
// SLIDE_DOUBLE（引き違い）のプリミティブ列（旧 renderer/OpeningsLayer.jsx slideDoubleSymbol/
// slideDoubleDetailSymbolの移設。J10）。SWINGと同様planSymbolPlanを介さない専用扱い
// （旧jsx entry.mechanism===SLIDE_DOUBLE早期return。frame='sash'扱いにはならず、jambW・
// 内法へ寄せる処理も行わない＝現状維持）。
// ================================================================

// STANDARD: 枠矩形(frame)＋leaf線2本(symbol)（旧slideDoubleSymbol）。
function slideDoubleStandardPrimitives(opening, band, symbolWeight, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  return [
    rectPrim('frame', frameWeight, isVertical, coord1, coord2, band.lo, band.hi),
    ...slideDoubleLeafPrimitives(opening, band, symbolWeight),
  ];
}

// DETAIL: 枠矩形(frame)＋2トラックのサッシ矩形(symbol)＋気密材の破線(symbol)＋窓のみガラス線
// (symbol)（旧slideDoubleDetailSymbol）。
function slideDoubleDetailPrimitives(opening, band, symbolWeight, frameWeight) {
  const {
    coord1, coord2, centerCoord, isVertical, category,
  } = opening;
  const overlap = Math.max(opening.width * 0.12, 60);
  const outerLo = band.lo, outerHi = band.hi;
  const sashDepth = Math.max(0, (outerHi - outerLo - SLIDE_TRACK_INSET_MM * 3) / 2);
  const track1 = [outerLo + SLIDE_TRACK_INSET_MM, outerLo + SLIDE_TRACK_INSET_MM + sashDepth];
  const track2 = [outerHi - SLIDE_TRACK_INSET_MM - sashDepth, outerHi - SLIDE_TRACK_INSET_MM];
  const leaves = [
    { span: [coord1, centerCoord + overlap / 2], track: track1 },
    { span: [centerCoord - overlap / 2, coord2], track: track2 },
  ];
  const prims = [rectPrim('frame', frameWeight, isVertical, coord1, coord2, outerLo, outerHi)];
  for (const { span, track } of leaves) {
    prims.push(rectPrim('symbol', symbolWeight, isVertical, span[0], span[1], track[0], track[1]));
    if (category === OpeningCategory.WINDOW) {
      const glassPerp = (track[0] + track[1]) / 2;
      prims.push(linePrim('symbol', symbolWeight, toWorld(isVertical, span[0], glassPerp), toWorld(isVertical, span[1], glassPerp)));
    }
  }
  prims.push(linePrim('symbol', symbolWeight,
    toWorld(isVertical, centerCoord, track1[0]), toWorld(isVertical, centerCoord, track2[1]), WEATHERSTRIP_DASH));
  return prims;
}

// SLIDE_DOUBLEのディスパッチ（J10）。
function buildSlideDoublePrimitives(opening, band, detail, symbolWeight, frameWeight) {
  return detail
    ? slideDoubleDetailPrimitives(opening, band, symbolWeight, frameWeight)
    : slideDoubleStandardPrimitives(opening, band, symbolWeight, frameWeight);
}

// ================================================================
// 非蝶番sashOpen系（SLIDE_SINGLE・SLIDE_LAYOUT・HUNG）のプリミティブ列（旧
// renderer/OpeningsLayer.jsx otherMechanismSymbol内のslideSingleSymbol/slideLayoutSymbol/
// hungSymbol、旧sashFrameOpenSymbolの移設。J12）。frame（'sashOpen'の方立コの字）は下のsashFrameOpenPrimitives
// が別途描くため、ここは各機構固有の枠矩形（自身の全幅Rect）＋leaf線のみを返す
// （旧slideSingleSymbol/slideLayoutSymbol/hungSymbol自身も自前でRect枠を描いていたのと同じ形）。
// ================================================================

// SLIDE_SINGLE（引き戸）: 枠矩形(frame)＋内側トラック1本に全長leaf線(symbol)（旧slideSingleSymbol）。
function slideSinglePrimitives(opening, band, symbolWeight, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  const leafPerp = bandPerp(band, 0.25);
  return [
    rectPrim('frame', frameWeight, isVertical, coord1, coord2, band.lo, band.hi),
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, leafPerp), toWorld(isVertical, coord2, leafPerp)),
  ];
}

// SLIDE_LAYOUT: 枠矩形(frame)＋パネルごとのleaf線(symbol)。パネル幅=width/panels.length、隣接
// パネルは引違いと同じoverlapで重ねる。トラック割付・perp位置はopeningPlanSymbolGeometry.jsの
// trackOf/trackPerp（純関数）に委ねる（旧slideLayoutSymbol）。パネル0枚（entry.slideLayout未設定・
// panels:[]）は枠だけを返す。
function slideLayoutPrimitives(opening, band, entry, symbolWeight, frameWeight) {
  const { coord1, coord2, width, isVertical } = opening;
  const frame = rectPrim('frame', frameWeight, isVertical, coord1, coord2, band.lo, band.hi);
  const panels = resolveSlideLayoutPanels(entry);
  if (panels.length === 0) return [frame];

  const tracks = entry.slideLayout.tracks;
  const overlap = Math.max(width * 0.12, 60);
  const panelWidth = width / panels.length;
  const hasFix = panels.some(p => p.fix);
  const prims = [frame];
  panels.forEach((p, i) => {
    const startBase = coord1 + i * panelWidth;
    const endBase = startBase + panelWidth;
    const start = i === 0 ? startBase : startBase - overlap / 2;
    const end = i === panels.length - 1 ? endBase : endBase + overlap / 2;
    const track = trackOf(p, i, tracks, hasFix);
    const perp = trackPerp(band.center, track, tracks, band.depth);
    prims.push(linePrim('symbol', symbolWeight, toWorld(isVertical, start, perp), toWorld(isVertical, end, perp)));
  });
  return prims;
}

// HUNG（上げ下げ窓）: 枠矩形(frame)＋両トラックに全長線1本ずつ(symbol)（旧hungSymbol）。
function hungPrimitives(opening, band, symbolWeight, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  const leaf1Perp = bandPerp(band, 0.25);
  const leaf2Perp = bandPerp(band, 0.75);
  return [
    rectPrim('frame', frameWeight, isVertical, coord1, coord2, band.lo, band.hi),
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, leaf1Perp), toWorld(isVertical, coord2, leaf1Perp)),
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, leaf2Perp), toWorld(isVertical, coord2, leaf2Perp)),
  ];
}

// 窓一般線（11d）: 枠矩形(frame)＋壁軸上に全長1本線(symbol)。FIXED/TILT/TILT_OUT/AWNING/
// PROJECT_OUT/LOUVER/AWNING_MULTI/GARARI/GLASS_BLOCK/PIVOT_Hの10機構が共有する（旧
// windowLineSymbol。他のsashOpen系記号（slideSingle等）と同じく自前の全幅frame矩形＋symbol線を
// 返す——外側のコの字方立(sashFrameOpenPrimitives)とは別）。
function windowLinePrimitives(opening, band, symbolWeight, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  return [
    rectPrim('frame', frameWeight, isVertical, coord1, coord2, band.lo, band.hi),
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, band.center), toWorld(isVertical, coord2, band.center)),
  ];
}

// SASH_OPEN_GROUP_MECHANISMSの機構ごとの記号プリミティブ（frame='sashOpen'のコの字は含まない）。
function sashOpenGroupSymbolPrimitives(mechanism, opening, band, entry, symbolWeight, frameWeight) {
  switch (mechanism) {
    case OpeningMechanism.SLIDE_SINGLE: return slideSinglePrimitives(opening, band, symbolWeight, frameWeight);
    case OpeningMechanism.SLIDE_LAYOUT: return slideLayoutPrimitives(opening, band, entry, symbolWeight, frameWeight);
    case OpeningMechanism.HUNG:         return hungPrimitives(opening, band, symbolWeight, frameWeight);
    case OpeningMechanism.FIXED:
    case OpeningMechanism.TILT:
    case OpeningMechanism.TILT_OUT:
    case OpeningMechanism.AWNING:
    case OpeningMechanism.PROJECT_OUT:
    case OpeningMechanism.LOUVER:
    case OpeningMechanism.AWNING_MULTI:
    case OpeningMechanism.GARARI:
    case OpeningMechanism.GLASS_BLOCK:
    case OpeningMechanism.PIVOT_H:       return windowLinePrimitives(opening, band, symbolWeight, frameWeight);
    default: return [];
  }
}

// 非蝶番系 詳細LOD専用（frame:'sashOpen'）: 記号自身が開口全幅の枠矩形を描く機構
// （SASH_OPEN_MECHANISMS）専用の方立。内側（開口本体側）の縦線を持たない3辺（コの字）で描く
// ——閉じた矩形のまま描くと、記号側の枠矩形（sashOpenGroupSymbolPrimitivesがframeInnerSpanの
// 内法区間に描く矩形）と方立の内側縦線が座標coord1+jambWidth/coord2-jambWidthで完全に一致し、
// 同じ線を2回描いてしまう（旧sashFrameOpenSymbol。F5の再発防止）。開口を横断する線は描かない
// （上下の横線は各ジャンブの幅ぶんだけに留める）。closedは意図的に渡さない——旧jsx
// sashFrameOpenSymbolの<Line points={...} {...fsp} />はclosed・fill="transparent"のどちらも
// 持たない（swingFrameSymbolのjambOutlinePointsとは異なる。fireFoldPanelPrimitivesと同じ理由で
// probeのprops比較上、旧経路と食い違わせないためfalseを明示しない）。
function sashFrameOpenPrimitives(opening, band, jambWidth, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  const jambPoints = (outerAlong, innerAlong) => [
    [innerAlong, band.lo], [outerAlong, band.lo], [outerAlong, band.hi], [innerAlong, band.hi],
  ].flatMap(([along, perp]) => {
    const p = toWorld(isVertical, along, perp);
    return [p.x, p.y];
  });
  return [
    polylinePrim('frame', frameWeight, jambPoints(coord1, coord1 + jambWidth)),
    polylinePrim('frame', frameWeight, jambPoints(coord2, coord2 - jambWidth)),
  ];
}

// SASH_OPEN_GROUP_MECHANISMSのディスパッチ（J7: jambW・swingOpenPerpDir・planSymbolPlan／
// J12: sashOpen枠＋内法へ寄せたopeningの移設）。非蝶番系のためswingOpenPerpDirは常に0を返し
// （HINGED_MECHANISMSに含まれないため）、plan.pivotPerpはaxisValue（詳細LODはband内へ
// クランプ）のまま——このグループの機構は回転しないためpivotPerp自体は使わない。
function buildSashOpenGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi, symbolWeight, frameWeight) {
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, opening.width / 2);
  const openPerpDir = swingOpenPerpDir(opening.isVertical, opening.hingeSide, opening.swingSide, entry.mechanism, entry);
  const plan = planSymbolPlan({
    mechanism: entry.mechanism, lodLevel, coord1: opening.coord1, coord2: opening.coord2,
    axisValue, band, jambWidth: jambW, faceLo, faceHi, openPerpDir,
  });

  if (plan.frame === 'sashOpen') {
    const spanOpening = innerSpanOpening(opening, plan.innerSpan);
    const frame = sashFrameOpenPrimitives(opening, band, jambW, frameWeight);
    const symbol = sashOpenGroupSymbolPrimitives(entry.mechanism, spanOpening, band, entry, symbolWeight, frameWeight);
    return [...frame, ...symbol];
  }
  // ここに到達するのは plan.frame==='none'（STANDARD）のときだけ——SASH_OPEN_GROUP_MECHANISMSの
  // 機構は全てopeningCatalog.js SASH_OPEN_MECHANISMSに含まれるため、planSymbolPlanはDETAILで
  // 必ず'sashOpen'を返し、'sash'（記号が枠矩形を描かない非蝶番系。FOLD/PIVOT）へは分類されない
  // （REASONED・防御的。現状のSASH_OPEN_GROUP_MECHANISMSの定義では到達不能で、直接呼ぶテストも
  // 書けない）。将来この集合にSASH_OPEN_MECHANISMSに属さない機構を誤って足すと、DETAILで
  // 'sash'が返り黙って方立が消える（sashOpenGroupSymbolPrimitivesは記号自身の枠しか描かない）ため、
  // ここで早期に気付けるようにする。
  if (plan.frame !== 'none') {
    throw new TypeError(`buildSashOpenGroupPrimitives: sashOpenグループの枠種別が想定外: ${plan.frame}`);
  }
  return sashOpenGroupSymbolPrimitives(entry.mechanism, opening, band, entry, symbolWeight, frameWeight);
}

// ================================================================
// 非蝶番sash系（FOLD・PIVOT）のプリミティブ列（旧 renderer/OpeningsLayer.jsx otherMechanismSymbol
// 内のfoldSymbol/pivotSymbol、旧sashFrameSymbolの移設。11d）。frame（'sash'の閉じた矩形2つ）は
// 下のsashFramePrimitivesが別途描くため、ここは各機構固有の記号線・弧のみを返す。
// ================================================================

// 非蝶番系 詳細LOD専用（frame:'sash'）: 開口両端に方立（縦枠）を単純な閉じた矩形2つで描く
// （扉が通過しないためswingFramePrimitivesのような欠き込みは無い。旧sashFrameSymbol）。記号本体
// （sashGroupSymbolPrimitives）が自前で枠矩形を描かない機構（frame='sash'。11d時点では FOLD/PIVOT、
// 11e で SHUTTER/OVERHEAD/EMERGENCY も同じ枠を使う）向け——記号側が枠矩形を
// 描く機構はsashFrameOpenPrimitivesを使う（F5、二重描画防止。既存コメントと同じ理由）。
function sashFramePrimitives(opening, band, jambWidth, frameWeight) {
  const { coord1, coord2, isVertical } = opening;
  return [
    rectPrim('frame', frameWeight, isVertical, coord1, coord1 + jambWidth, band.lo, band.hi),
    rectPrim('frame', frameWeight, isVertical, coord2 - jambWidth, coord2, band.lo, band.hi),
  ];
}

// FOLD（折れ戸・折りたたみ窓）: 開口全長にジグザグ線（W形。role='symbol'固定）。
// 山数=max(2,round(width/450))（旧foldSymbol）。
function foldPrimitives(opening, band, symbolWeight) {
  const { coord1, width, isVertical } = opening;
  const peaks = Math.max(2, Math.round(width / 450));
  const points = foldZigzagPoints(coord1, width, peaks, FOLD_AMPLITUDE_MM).flatMap(({ along, perpOffset }) => {
    const p = toWorld(isVertical, along, band.center + perpOffset);
    return [p.x, p.y];
  });
  // closedは意図的に渡さない——旧jsx foldSymbolの<Line points={pts} {...sp} />はclosedを持たない
  // （fireFoldPanelPrimitivesと同じ理由でprobeのprops比較上、旧経路と食い違わせない）。
  return [polylinePrim('symbol', symbolWeight, points)];
}

// PIVOT（縦軸回転窓）: 開口中央に壁直交方向の障子線（長さ=min(width,600)）＋その両側に90°円弧2つ
// （回転の軌跡、半径=width/2、中心=開口中心）。role='symbol'固定——旧renderOpeningSymbolのコメント
// 「PIVOTの菱形の弧も動作線ではなく記号の姿そのものなのでsp」のとおり、蝶番系のarc役割
// （中心線・弧をopening.lineWeightと切り離す規約）は適用しない（旧pivotSymbol）。
function pivotPrimitives(opening, band, symbolWeight) {
  const { centerCoord, width, isVertical } = opening;
  const leafLen = Math.min(width, 600);
  const p1 = toWorld(isVertical, centerCoord, band.center - leafLen / 2);
  const p2 = toWorld(isVertical, centerCoord, band.center + leafLen / 2);
  const center = toWorld(isVertical, centerCoord, band.center);
  const r = width / 2;
  const alongAngle = isVertical ? 90 : 0;
  const perpAngle = isVertical ? 0 : 90;
  const sweep = perpAngle - alongAngle;
  return [
    linePrim('symbol', symbolWeight, p1, p2),
    arcPrim('symbol', symbolWeight, center.x, center.y, r, alongAngle, sweep),
    arcPrim('symbol', symbolWeight, center.x, center.y, r, alongAngle + 180, sweep),
  ];
}

// SHUTTER（シャッター）: 壁軸上に一点鎖線1本（role='symbol'）＋両端に既存tick（旧shutterSymbol）。
function shutterPrimitives(opening, band, symbolWeight) {
  const { coord1, coord2, isVertical } = opening;
  return [
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, band.center), toWorld(isVertical, coord2, band.center), SHUTTER_DASH),
    ...tickPrimitives(opening, band, symbolWeight),
  ];
}

// OVERHEAD（オーバーヘッドドア）: 開口全長×奥行200mmの破線矩形を室内側（exteriorDirの逆側）の
// 壁面に接して描く（跳ね上げた戸板の投影）＋壁軸上に実線1本（旧overheadSymbol）。exteriorDirは
// 呼び出し側（buildSashGroupPrimitives）がexteriorDirOfサンクを評価した値——境界（host自身または
// 反対側の壁）の外壁面向きを見るため、hostが室内向き壁でもCL偏芯でも正しい室外側を返す
// （Math.sign(host.axisOffset)は使わない。openingPlanSymbolGeometry.js openingExteriorDir参照）。
function overheadPrimitives(opening, band, exteriorDir, symbolWeight) {
  const { coord1, coord2, isVertical } = opening;
  const axisValue = band.center;
  const dir = -exteriorDir;
  const perpLo = dir > 0 ? axisValue : axisValue - OVERHEAD_DEPTH_MM;
  const perpHi = dir > 0 ? axisValue + OVERHEAD_DEPTH_MM : axisValue;
  return [
    rectPrim('symbol', symbolWeight, isVertical, coord1, coord2, perpLo, perpHi, OVERHEAD_DASH),
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, axisValue), toWorld(isVertical, coord2, axisValue)),
  ];
}

// EMERGENCY（非常用進入口）: 壁軸上に全長1本線＋開口中央に逆三角形（一辺400mm、底辺が外部側・
// 頂点が室内側、輪郭のみ）。外部側の判定はoverheadPrimitivesと同じexteriorDir（旧emergencySymbol）。
function emergencyPrimitives(opening, band, exteriorDir, symbolWeight) {
  const { coord1, coord2, centerCoord, isVertical } = opening;
  const axisValue = band.center;
  const height = (EMERGENCY_SIDE_MM * Math.sqrt(3)) / 2;
  const halfBase = EMERGENCY_SIDE_MM / 2;
  const baseL = toWorld(isVertical, centerCoord - halfBase, axisValue);
  const baseR = toWorld(isVertical, centerCoord + halfBase, axisValue);
  const apex = toWorld(isVertical, centerCoord, axisValue - exteriorDir * height);
  return [
    linePrim('symbol', symbolWeight, toWorld(isVertical, coord1, axisValue), toWorld(isVertical, coord2, axisValue)),
    polylinePrim('symbol', symbolWeight, [baseL.x, baseL.y, baseR.x, baseR.y, apex.x, apex.y], true),
  ];
}

// SASH_GROUP_MECHANISMSの機構ごとの記号プリミティブ（frame='sash'の閉じた矩形2つは含まない）。
// exteriorDirOf（メモ化済みサンク）はOVERHEAD/EMERGENCYだけが呼ぶ——他の3機構は開口の外部側方向を
// 参照しないため、呼んでしまうと副作用ゼロの不変条件（暫定契約テスト由来）が崩れる。
function sashGroupSymbolPrimitives(mechanism, opening, band, symbolWeight, exteriorDirOf) {
  switch (mechanism) {
    case OpeningMechanism.FOLD:      return foldPrimitives(opening, band, symbolWeight);
    case OpeningMechanism.PIVOT:     return pivotPrimitives(opening, band, symbolWeight);
    case OpeningMechanism.SHUTTER:   return shutterPrimitives(opening, band, symbolWeight);
    case OpeningMechanism.OVERHEAD:  return overheadPrimitives(opening, band, exteriorDirOf(), symbolWeight);
    case OpeningMechanism.EMERGENCY: return emergencyPrimitives(opening, band, exteriorDirOf(), symbolWeight);
    default: return [];
  }
}

// SASH_GROUP_MECHANISMSのディスパッチ（J7: jambW・swingOpenPerpDir・planSymbolPlan／J12: sash枠＋
// 内法へ寄せたopeningの移設）。非蝶番系のためswingOpenPerpDirは常に0を返し、plan.pivotPerpは
// axisValue（詳細LODはband内へクランプ）のまま——FOLD/PIVOT/SHUTTER/OVERHEAD/EMERGENCYはband.center
// （またはaxisValue）で記号を描くためpivotPerp自体は使わない（buildSashOpenGroupPrimitivesと同じ
// 構造）。exteriorDirOfはOVERHEAD/EMERGENCYのためにsashGroupSymbolPrimitivesへそのまま引き渡す
// （呼び出し元buildOpeningPlanSymbolがmemoizeThunk済みのものを渡す。11e）。
function buildSashGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi, symbolWeight, frameWeight, exteriorDirOf) {
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, opening.width / 2);
  const openPerpDir = swingOpenPerpDir(opening.isVertical, opening.hingeSide, opening.swingSide, entry.mechanism, entry);
  const plan = planSymbolPlan({
    mechanism: entry.mechanism, lodLevel, coord1: opening.coord1, coord2: opening.coord2,
    axisValue, band, jambWidth: jambW, faceLo, faceHi, openPerpDir,
  });

  if (plan.frame === 'sash') {
    const spanOpening = innerSpanOpening(opening, plan.innerSpan);
    const frame = sashFramePrimitives(opening, band, jambW, frameWeight);
    const symbol = sashGroupSymbolPrimitives(entry.mechanism, spanOpening, band, symbolWeight, exteriorDirOf);
    return [...frame, ...symbol];
  }
  // ここに到達するのは plan.frame==='none'（STANDARD）のときだけ——SASH_GROUP_MECHANISMS
  // （FOLD/PIVOT/SHUTTER/OVERHEAD/EMERGENCY）はHINGED_MECHANISMSにもSASH_OPEN_MECHANISMSにも
  // 属さないため、planSymbolPlanはDETAILで必ず'sash'を返す（REASONED・防御的。
  // buildSashOpenGroupPrimitivesと対の早期気付き）。
  if (plan.frame !== 'none') {
    throw new TypeError(`buildSashGroupPrimitives: sashグループの枠種別が想定外: ${plan.frame}`);
  }
  return sashGroupSymbolPrimitives(entry.mechanism, opening, band, symbolWeight, exteriorDirOf);
}

// ================================================================
// FRAME_ONLY（三方枠）のプリミティブ列（旧 renderer/OpeningsLayer.jsx frameOnlySymbolの移設。
// 11e）。三方枠は「枠自身が記号」であり、planSymbolPlanのframe='frameOnly'（lodLevelに関わらず
// 常にこの値。planSymbolPlan参照）に対応する唯一の機構——他機構のような一般/詳細の2段構えを持たず、
// 他5グループのどの枠経路にも属さない専用ディスパッチとして持つ（SASH_GROUP_MECHANISMS等には
// 含めない）。判断（座標・閉曲線か否か・断面の描き分け）はすべてframeOnlyJambProfiles（純関数）に
// 一本化されており、ここではtoWorldへ機械的に展開するだけ（旧frameOnlySymbolと同じ役割分担）。
// ================================================================
function frameOnlyPrimitives(opening, faceLo, faceHi, axisValue, frameWeight) {
  const profile = frameProfileFor(fixtureSymbolOf(opening));
  const jambs = frameOnlyJambProfiles({
    coord1: opening.coord1, coord2: opening.coord2, faceLo, faceHi, axisValue,
    faceWidth: effectiveFrameFaceWidth(opening), projection: effectiveFrameProjection(opening), profile,
  });
  return jambs.map(jamb => polylinePrim('frame', frameWeight, jamb.points.flatMap(({ along, perp }) => {
    const p = toWorld(opening.isVertical, along, perp);
    return [p.x, p.y];
  }), jamb.closed));
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
// 蝶番系その1（SWING・SWING_IN・PROJECT_V・DREH_KIPP）のプリミティブ列（旧
// renderer/OpeningsLayer.jsx swingLeafSymbol/swingSymbol/jambOutlinePoints/swingFrameSymbolの移設）。
// ================================================================

// 開き戸leaf1枚（開いた位置の扉線1本＋開き勝手の動作弧）。吊元位置・leaf長を引数化する
// （旧swingLeafSymbol）。swingSideの規約はopeningGeometry.js swingSideTowardPerpのperpDir=
// (isVertical?1:-1)*swingSide*hingeSideと整合（openingPlanSymbolGeometry.js leafOpenAngle参照）。
// angleDeg・arcDash（既定は蝶番系その1と同じ90°・実線）は蝶番系その2（11b-2）のFIRE_DOORが
// leafSpecGroupPrimitives経由で可変角度・破線弧を指定するための拡張（SWING_DOUBLE/SWING_CHILDは
// angleDeg=DOOR_OPEN_ANGLE_DEG固定・arcDash省略で呼ぶため実質90°実線のまま）
// （旧fireLeafSymbolの角度引数・FIRE_ARC_DASHと同じ判断をここへ一本化。呼び出し側を増やさない
// ため既存の呼び出し元（swingPrimitives）は追加引数を渡さず、既定値で従来どおりの90°実線になる）。
function swingLeafPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, leafWeight, arcWeight, angleDeg = DOOR_OPEN_ANGLE_DEG, arcDash) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, angleDeg);
  const { dir } = angleVectors(openAngle);
  const far = { x: hinge.x + dir.x * leafLength, y: hinge.y + dir.y * leafLength };
  return [
    linePrim('leaf', leafWeight, hinge, far),
    arcPrim('arc', arcWeight, hinge.x, hinge.y, leafLength, closedAngle, openAngle - closedAngle, arcDash),
  ];
}

// leaf仕様の配列（{hingeAlong,hingeSide,sense,leafLength}[]。openingPlanSymbolGeometry.js
// swingDoubleLeafSpecs等）をswingLeafPrimitivesへ機械的に展開する共通ヘルパ
// （旧renderer/OpeningsLayer.jsx swingLeafSymbols・fireDoorSymbol/fireFoldSymbolのspecs.map、
// SWING_DOUBLE/SWING_CHILD/FIRE_DOORが共有する）。leaf仕様の決定（対向leafのsense符号反転を
// 含む）はopeningPlanSymbolGeometry.js側の*LeafSpecs関数に一本化し、ここでは消費するだけにする。
function leafSpecGroupPrimitives(isVertical, pivotPerp, specs, leafWeight, arcWeight, angleDeg, arcDash) {
  return specs.flatMap(s => swingLeafPrimitives(isVertical, pivotPerp, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, leafWeight, arcWeight, angleDeg, arcDash));
}

// 自由開きleaf1枚: 閉じ位置の扉線1本（壁軸上。開いた位置ではない）＋両側（swingSide側とその逆側）
// に開き角度ぶんの円弧2つ（旧freeLeafSymbol）。両方向の弧を描くため、対向leaf（coord2側）に
// swingSideを反転して渡しても和集合（描画結果）は変わらない——他の蝶番系と異なり符号反転は不要
// （旧freeDoubleSymbolのコメント参照）。
function freeLeafPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLength, leafWeight, arcWeight) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const towardFar = hingeSide < 0 ? 1 : -1;
  const far = toWorld(isVertical, hingeAlong + towardFar * leafLength, pivotPerp);
  return [
    linePrim('leaf', leafWeight, hinge, far),
    arcPrim('arc', arcWeight, hinge.x, hinge.y, leafLength, closedAngle, swingSide * DOOR_OPEN_ANGLE_DEG),
    arcPrim('arc', arcWeight, hinge.x, hinge.y, leafLength, closedAngle, -swingSide * DOOR_OPEN_ANGLE_DEG),
  ];
}

// FIRE_FOLD 1袖分: 吊元側に折りたたんだジグザグ（leaf長の1/4程度の幅、2山）＋閉位置までの
// 破線円弧（旧fireFoldPanel）。swingSideの規約はswingLeafPrimitivesと同じ。ジグザグはpolyline
// （閉じない・role='leaf'）として1本にまとめる——旧jsxのptsフラット配列と同じ座標列。
function fireFoldPanelPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, leafLen, angleDeg, leafWeight, arcWeight) {
  const hinge = toWorld(isVertical, hingeAlong, pivotPerp);
  const closedAngle = closedAngleFor(isVertical, hingeSide);
  const openAngle = leafOpenAngle(closedAngle, swingSide, angleDeg);
  const { dir, perp } = angleVectors(openAngle);
  const foldLen = leafLen / 4;
  const segCount = FIRE_FOLD_PEAKS * 2;
  const pts = [hinge.x, hinge.y];
  for (let i = 1; i <= segCount; i += 1) {
    const d = (foldLen * i) / segCount;
    const amp = i === segCount ? 0 : (i % 2 === 1 ? FIRE_FOLD_AMP_MM : -FIRE_FOLD_AMP_MM);
    pts.push(hinge.x + dir.x * d + perp.x * amp, hinge.y + dir.y * d + perp.y * amp);
  }
  return [
    // closedは意図的に渡さない（undefined）——旧jsx fireFoldPanelの<Line points={pts} .../>は
    // closedプロパティ自体を持たず（Konva既定でfalse相当）、renderPlanPrimitiveのcase 'polyline'
    // は`closed={p.closed}`をそのまま転写するため、ここでfalseを明示するとprobeのprops比較上
    // （閉じていないLineのclosedキーの有無）で旧経路と食い違う（見た目は同じでも実測で検出）。
    polylinePrim('leaf', leafWeight, pts),
    arcPrim('arc', arcWeight, hinge.x, hinge.y, leafLen, closedAngle, openAngle - closedAngle, FIRE_ARC_DASH_MM),
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

// 蝶番系その2（HINGE_GROUP2_MECHANISMS）の機構ごとのleafプリミティブ（旧
// renderer/OpeningsLayer.jsx otherMechanismSymbol内のswingDoubleSymbol/swingChildSymbol/
// freeSymbol/freeDoubleSymbol/fireDoorSymbol/fireFoldSymbolの移設）。frameは呼び出し側
// （buildHingeGroup2Primitives）が別途描くため、ここはleaf・arcのみを返す。
// childRatio/fireLeaves/fireAngleの既定値（0.3/1/90）は旧jsx swingChildSymbol/fireDoorSymbol/
// fireFoldSymbolのentry?.xxx ?? 既定値と同じ（唯一の定義箇所）。
function hingeGroup2LeafPrimitives(mechanism, opening, entry, pivotPerp, leafWeight, arcWeight) {
  const { coord1, coord2, width, hingeSide, swingSide, isVertical } = opening;
  switch (mechanism) {
    case OpeningMechanism.SWING_DOUBLE: {
      const specs = swingDoubleLeafSpecs(coord1, coord2, width, swingSide);
      return leafSpecGroupPrimitives(isVertical, pivotPerp, specs, leafWeight, arcWeight, DOOR_OPEN_ANGLE_DEG);
    }
    case OpeningMechanism.SWING_CHILD: {
      const childRatio = entry.childRatio ?? 0.3;
      const specs = swingChildLeafSpecs(coord1, coord2, width, hingeSide, swingSide, childRatio);
      return leafSpecGroupPrimitives(isVertical, pivotPerp, specs, leafWeight, arcWeight, DOOR_OPEN_ANGLE_DEG);
    }
    case OpeningMechanism.FREE: {
      const hingeAlong = hingeSide < 0 ? coord1 : coord2;
      return freeLeafPrimitives(isVertical, pivotPerp, hingeAlong, hingeSide, swingSide, width, leafWeight, arcWeight);
    }
    case OpeningMechanism.FREE_DOUBLE: {
      const leafLength = width / 2;
      return [
        ...freeLeafPrimitives(isVertical, pivotPerp, coord1, -1, swingSide, leafLength, leafWeight, arcWeight),
        ...freeLeafPrimitives(isVertical, pivotPerp, coord2, 1, swingSide, leafLength, leafWeight, arcWeight),
      ];
    }
    case OpeningMechanism.FIRE_DOOR: {
      const fireLeaves = entry.fireLeaves ?? 1;
      const fireAngle = entry.fireAngle ?? 90;
      const specs = fireDoorLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireLeaves);
      return leafSpecGroupPrimitives(isVertical, pivotPerp, specs, leafWeight, arcWeight, fireAngle, FIRE_ARC_DASH_MM);
    }
    case OpeningMechanism.FIRE_FOLD: {
      const fireAngle = entry.fireAngle ?? 90;
      const specs = fireFoldLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireAngle);
      return specs.flatMap(s => fireFoldPanelPrimitives(isVertical, pivotPerp, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, fireAngle, leafWeight, arcWeight));
    }
    default: return [];
  }
}

// 蝶番系その2（HINGE_GROUP2_MECHANISMS）のディスパッチ。SWINGのような専用inset扱いを持つ機構が
// 無いため、蝶番系その1のSWING_IN等と同じnotched/none構造をそのまま使う（J7: jambW・
// swingOpenPerpDir・planSymbolPlan／J11: notched→swingFrame＋innerSpanの移設）。
function buildHingeGroup2Primitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi) {
  const leafWeight = planSymbolWeightMm('leaf', opening, detail);
  const arcWeight = planSymbolWeightMm('arc', opening, detail);
  const frameWeight = planSymbolWeightMm('frame', opening, detail);
  const jambW = Math.min(FRAME_JAMB_WIDTH_MM, opening.width / 2);
  const openPerpDir = swingOpenPerpDir(opening.isVertical, opening.hingeSide, opening.swingSide, entry.mechanism, entry);
  const plan = planSymbolPlan({
    mechanism: entry.mechanism, lodLevel, coord1: opening.coord1, coord2: opening.coord2,
    axisValue, band, jambWidth: jambW, faceLo, faceHi, openPerpDir,
  });

  if (plan.frame === 'notched') {
    const spanOpening = innerSpanOpening(opening, plan.innerSpan);
    const frame = swingFramePrimitives(opening, band, plan.pivotPerp, plan.leafOutward, frameWeight);
    const leaf = hingeGroup2LeafPrimitives(entry.mechanism, spanOpening, entry, plan.pivotPerp, leafWeight, arcWeight);
    return [...frame, ...leaf];
  }
  return hingeGroup2LeafPrimitives(entry.mechanism, opening, entry, plan.pivotPerp, leafWeight, arcWeight);
}

/**
 * 建具1件の平面記号プリミティブ列を返す純関数。
 * @param {object} opening core.js の Opening 相当（coord1/coord2/centerCoord/isVertical/width/
 *   frameDepth/lineWeightを読む）
 * @param {{entry: object|null, lodLevel: string, axisValue: number, faceLo?: number,
 *   faceHi?: number, exteriorDirOf: () => number}} ctx
 *   entry: findCatalogEntryの結果（無ければnull）。lodLevel: viewport.js LodLevel。
 *   axisValue: host.axisValue。faceLo/faceHi: 壁面線（略図LODでは未定義）。
 *   exteriorDirOf: 開口の外部側方向(±1)を返すthunk（詳細LODかつframeDepth>0の見込帯、または
 *   OVERHEAD/EMERGENCYの記号自身が参照するときだけ呼ぶ。呼ぶたびに再計算しないよう内部で
 *   1回だけメモ化して呼ぶ）。
 * @returns {object[]} プリミティブ配列（常に非空。IMPLEMENTED_MECHANISMSの全30機構を
 *   カバーし終えたため、entry無し・未実装機構文字列だけがtickPrimitivesへフォールバックする）。
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

  // STANDARD/DETAILでentryが実装済み機構を指す場合、必ずいずれか1つのグループに属する
  // （SWING_GROUP_MECHANISMS 4・HINGE_GROUP2_MECHANISMS 6・SLIDE_DOUBLE 1・
  // SASH_OPEN_GROUP_MECHANISMS 13・SASH_GROUP_MECHANISMS 5・FRAME_ONLY 1 の合計30が
  // IMPLEMENTED_MECHANISMSの全件と一致する。11eで全機構の移行が完了したため、
  // 「実装済みなのにどのグループにも属さない」ケースは存在しない）。
  const implemented = lodLevel !== LodLevel.SCHEMATIC && entry && IMPLEMENTED_MECHANISMS.has(entry.mechanism);
  const swingGroup = implemented && SWING_GROUP_MECHANISMS.has(entry.mechanism);
  const hingeGroup2 = implemented && HINGE_GROUP2_MECHANISMS.has(entry.mechanism);
  const slideDouble = implemented && entry.mechanism === OpeningMechanism.SLIDE_DOUBLE;
  const sashOpenGroup = implemented && SASH_OPEN_GROUP_MECHANISMS.has(entry.mechanism);
  const sashGroup = implemented && SASH_GROUP_MECHANISMS.has(entry.mechanism);
  const frameOnly = implemented && entry.mechanism === OpeningMechanism.FRAME_ONLY;

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

  // STANDARD/DETAILで蝶番系その2（HINGE_GROUP2_MECHANISMS）: 専用ディスパッチへ。
  if (hingeGroup2) {
    return buildHingeGroup2Primitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi);
  }

  // STANDARD/DETAILでSLIDE_DOUBLE: 専用ディスパッチへ（SWINGと同じくplanSymbolPlanを介さない）。
  if (slideDouble) {
    const frameWeight = planSymbolWeightMm('frame', opening, detail);
    return buildSlideDoublePrimitives(opening, band, detail, symbolWeight, frameWeight);
  }

  // STANDARD/DETAILで非蝶番sashOpen系（SASH_OPEN_GROUP_MECHANISMS）: 専用ディスパッチへ。
  if (sashOpenGroup) {
    const frameWeight = planSymbolWeightMm('frame', opening, detail);
    return buildSashOpenGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi, symbolWeight, frameWeight);
  }

  // STANDARD/DETAILで非蝶番sash系（SASH_GROUP_MECHANISMS＝FOLD・PIVOT・SHUTTER・OVERHEAD・
  // EMERGENCY）: 専用ディスパッチへ。memoExteriorDirOfはOVERHEAD/EMERGENCYだけが評価する
  // （帯計算と合わせて呼んでも実質1回。sashGroupSymbolPrimitives参照）。
  if (sashGroup) {
    const frameWeight = planSymbolWeightMm('frame', opening, detail);
    return buildSashGroupPrimitives(opening, entry, lodLevel, band, detail, axisValue, faceLo, faceHi, symbolWeight, frameWeight, memoExteriorDirOf);
  }

  // STANDARD/DETAILでFRAME_ONLY（三方枠）: 専用ディスパッチへ。bandは他機構と共通に計算済みだが
  // frameOnlyPrimitives自体はbandを使わない（旧frameOnlySymbolと同じ。faceLo/faceHi/axisValueを
  // 直接使う）。
  if (frameOnly) {
    const frameWeight = planSymbolWeightMm('frame', opening, detail);
    return frameOnlyPrimitives(opening, faceLo, faceHi, axisValue, frameWeight);
  }

  // STANDARD/DETAILでentryが無い・未実装機構: ティックマークのみ。
  return tickPrimitives(opening, band, symbolWeight);
}
