// ================================================================
// 部屋の取り合い（junction。床と壁・壁と天井）の部分詳細図へ、部屋が供給する基準（Datum）と寸法を割り当てる（部分詳細図 S8a）。
// 局所座標: s＝壁の仕上げ面から室内側が正・t＝下向き正。
//   s: WALL_FINISH_FACE の origin＝0（壁の仕上げ面）・end＝−壁厚（壁の反対の面。壁の中側が負）
//   t: floorWall は FL の origin＝0（床仕上げ面）・wallCeiling は CEILING_FACE の origin＝0（天井面）
//   param: wallThickness＝壁厚 / material: 図が引く材コードの寸法（thickness・x・y）
// それ以外の（role・軸・種別）の組は UNSUPPORTED_DATUM（openings/openingDetailFrame.js と同型の失敗）。
// 腰壁・垂れ壁の部位（part。S8b-1。partTargets）: s は同じ（表の側の仕上げ面が origin 0・end −壁厚）、
//   t は kneeTop が WALL_TOP の origin＝0（腰壁の天端の面）・dropBottom が WALL_BOTTOM の origin＝0（垂れ壁の下端の面）。
// 床の段差の部位（floorStep。S8b-3。floorStepTargets）: s は STEP_EDGE の origin＝0（立ち上がり面。低い側が正）、
//   t は FL の origin＝0（高い側の床）・end＝段差高（低い側の床）。param なし。
// 依存は constants・error・detail/detailPlacement.js だけの葉。
// ================================================================

import { DetailDatumRole, DetailDatumKind, DetailAxis, DetailParam, DetailSlot } from '../core/constants.js';
import { materialCodesOf } from '../detail/detailPlacement.js';
import { ERR_DETAIL_DATUM_UNSUPPORTED, DETAIL_TARGET_JUNCTION, DETAIL_TARGET_PART, DETAIL_TARGET_PART_STEP } from '../error.js';

/** このモジュールが返す失敗の種類（openings/openingDetailFrame.js DetailFrameError と同じ語彙・同じ code）。 */
export const RoomDetailError = Object.freeze({
  UNSUPPORTED_DATUM: 'unsupportedDatum', // 部屋が供給できない基準の組（role・軸・種別）
  UNSUPPORTED_SLOT:  'unsupportedSlot',  // junction の slot でない
  INVALID_STEP_HEIGHT: 'invalidStepHeight', // 床の段差の段差高が正の有限数でない
});

const fail = (code, message) => ({ error: { code, message } });

// slot ごとの t の origin の role
const T_ORIGIN_ROLE = Object.freeze({
  [DetailSlot.FLOOR_WALL]:   DetailDatumRole.FL,
  [DetailSlot.WALL_CEILING]: DetailDatumRole.CEILING_FACE,
});
// 腰壁・垂れ壁の部位（part）の slot ごとの t の origin の role
const PART_T_ORIGIN_ROLE = Object.freeze({
  [DetailSlot.KNEE_TOP]:    DetailDatumRole.WALL_TOP,
  [DetailSlot.DROP_BOTTOM]: DetailDatumRole.WALL_BOTTOM,
});

// 供給する基準の値（局所座標）。供給できない組は undefined。
function datumBase(d, tOriginRole, wallThicknessMm) {
  if (d.role === DetailDatumRole.WALL_FINISH_FACE && d.axis === DetailAxis.S) {
    if (d.kind === DetailDatumKind.ORIGIN) return 0;
    if (d.kind === DetailDatumKind.END) return -wallThicknessMm;
  }
  if (d.role === tOriginRole && d.axis === DetailAxis.T && d.kind === DetailDatumKind.ORIGIN) return 0;
  return undefined;
}

// 床の段差（floorStep。S8b-3）が供給する基準の値。s＝STEP_EDGE の origin（立ち上がり面）・t＝FL の origin（高い側の床）と end（低い側の床＝段差高）
function stepDatumBase(d, stepHeightMm) {
  if (d.role === DetailDatumRole.STEP_EDGE && d.axis === DetailAxis.S && d.kind === DetailDatumKind.ORIGIN) return 0;
  if (d.role === DetailDatumRole.FL && d.axis === DetailAxis.T) {
    if (d.kind === DetailDatumKind.ORIGIN) return 0;
    if (d.kind === DetailDatumKind.END) return stepHeightMm;
  }
  return undefined;
}

function buildTargets(fig, { tOriginRole, wallThicknessMm, stepHeightMm, materialMap, targetName }) {
  const datums = {};
  for (const d of Array.isArray(fig?.datums) ? fig.datums : []) {
    if (d === null || typeof d !== 'object') continue; // 形の不正は fit の検証（INVALID）が理由つきで返す
    const base = stepHeightMm === undefined ? datumBase(d, tOriginRole, wallThicknessMm) : stepDatumBase(d, stepHeightMm);
    if (base === undefined) {
      return fail(RoomDetailError.UNSUPPORTED_DATUM, ERR_DETAIL_DATUM_UNSUPPORTED(d.id, `${d.role}・${d.axis}・${d.kind}`, targetName));
    }
    datums[d.id] = base;
  }
  const materials = {};
  for (const code of materialCodesOf(fig)) {
    const m = materialMap?.get(code);
    if (m) materials[code] = { thickness: m.thickness, x: m.x, y: m.y };
  }
  // 床の段差は壁厚の param を持たない（段差高は FL の end で吸う）
  const params = stepHeightMm === undefined ? { [DetailParam.WALL_THICKNESS]: wallThicknessMm } : {};
  return { targets: { datums, params, materials } };
}

/**
 * fitLocal に渡す targets を作る。datums は図の Datum.id をキーにする（fit が id で引くため）。
 * @param {object} fig DetailFigure（カタログのエントリ。不正でも例外にせず fit の検証へ回す）
 * @param {{slot:string, wallThicknessMm:number, materialMap?:{get:(code:string)=>object|undefined}|null}} p
 *   materialMap＝材コード→材（{thickness, x, y}）。図が material 束縛で引くコードだけ targets.materials に載せる
 *   （材が無い・厚みが無いコードは載せない＝fit が UNRESOLVED_MATERIAL を返す）
 * @returns {{targets:{datums:Object<string,number>, params:Object<string,number>, materials:Object<string,object>}}
 *   | {error:{code:string, message:string}}}
 */
export function junctionTargets(fig, { slot, wallThicknessMm, materialMap = null }) {
  if (!Object.hasOwn(T_ORIGIN_ROLE, slot)) return fail(RoomDetailError.UNSUPPORTED_SLOT, `取り合いの slot ではありません: ${String(slot)}`);
  return buildTargets(fig, { tOriginRole: T_ORIGIN_ROLE[slot], wallThicknessMm, materialMap, targetName: DETAIL_TARGET_JUNCTION });
}

/**
 * 腰壁・垂れ壁の部位（kneeTop・dropBottom）の targets。s は junctionTargets と同じ（表の側の仕上げ面が origin 0）、
 * t は kneeTop が WALL_TOP・dropBottom が WALL_BOTTOM の origin＝0。他の（role・軸・種別）は UNSUPPORTED_DATUM。
 * @param {object} fig
 * @param {{slot:string, wallThicknessMm:number, materialMap?:{get:(code:string)=>object|undefined}|null}} p
 */
export function partTargets(fig, { slot, wallThicknessMm, materialMap = null }) {
  if (!Object.hasOwn(PART_T_ORIGIN_ROLE, slot)) return fail(RoomDetailError.UNSUPPORTED_SLOT, `腰壁・垂れ壁の部位の slot ではありません: ${String(slot)}`);
  return buildTargets(fig, { tOriginRole: PART_T_ORIGIN_ROLE[slot], wallThicknessMm, materialMap, targetName: DETAIL_TARGET_PART });
}

/**
 * 床の段差の部位（floorStep。S8b-3）の targets。s は STEP_EDGE の origin＝0（立ち上がり面。低い側が正）、
 * t は FL の origin＝0（高い側の床）・end＝stepHeightMm（低い側の床。t は下向き正。伸縮で段差高を吸う）。param は持たない。
 * 他の（role・軸・種別）は UNSUPPORTED_DATUM。
 * @param {object} fig
 * @param {{stepHeightMm:number, materialMap?:{get:(code:string)=>object|undefined}|null}} p
 */
export function floorStepTargets(fig, { stepHeightMm, materialMap = null }) {
  if (!Number.isFinite(stepHeightMm) || stepHeightMm <= 0) return fail(RoomDetailError.INVALID_STEP_HEIGHT, `段差高が正の数ではありません: ${String(stepHeightMm)}`);
  return buildTargets(fig, { stepHeightMm, materialMap, targetName: DETAIL_TARGET_PART_STEP });
}
