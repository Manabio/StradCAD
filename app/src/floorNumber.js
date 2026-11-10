/**
 * 階番号・名称ユーティリティ
 *
 * - addSkipZero / subtractSkipZero : 0 をまたぐ加減算（0 階を存在させない）
 * - makeFloorName                  : {startFloor, stories} → 表示名称
 * - isGroundFloorEquivalent        : 1 階（相当）の階か
 */
import { GROUND_FLOOR_NUMBER } from './core/constants.js';

/**
 * plane が「1 階（相当）」の階か。階番号（startFloor）1 の階があればそれ、無ければ GL 以上（elevation ≥ 0）で最も低い階。
 * 検討案（isAlternative）は参照元の採用階（referenceId）で判定する。屋根専用平面・plane/planes が無い・該当階なしは false。
 * @param {{id:string, startFloor?:number, elevation?:number, isAlternative?:boolean, referenceId?:string|null, isRoofPlane?:boolean}|null|undefined} plane
 * @param {Array<{id:string, startFloor?:number, elevation?:number}>|null|undefined} planes 採用階（project.planes。屋根専用平面・検討案を含まない）
 * @returns {boolean}
 */
export function isGroundFloorEquivalent(plane, planes) {
  if (!plane || plane.isRoofPlane || !planes?.length) return false;
  const targetId = plane.isAlternative ? plane.referenceId : plane.id;
  const ground = planes.find(p => p.startFloor === GROUND_FLOOR_NUMBER)
    ?? planes.filter(p => p.elevation >= 0).reduce((low, p) => (low === null || p.elevation < low.elevation ? p : low), null);
  return ground !== null && ground !== undefined && ground.id === targetId;
}

/** 0 をスキップする加算。b > 0 で上方向、b < 0 で下方向。 */
export function addSkipZero(a, b) {
  const result = a + b;
  if (result === 0) return b > 0 ? 1 : -1;
  return result;
}

/** 0 をスキップする減算。b > 0 で下方向、b < 0 で上方向。 */
export function subtractSkipZero(a, b) {
  const result = a - b;
  if (result === 0) return b > 0 ? -1 : 1;
  return result;
}

/**
 * ドラッグ割り込み後の名称書換えルールを適用する。
 *
 * 優先順位で元名称のパターンを探し、数字部分を newStartFloor に置き換える。
 * どのパターンにも合致しない場合:
 *   - 数字があれば置換
 *   - 数字がなければ makeFloorName(n, 1) + ":" を先頭に追加
 */
export function renameFloor(oldName, newStartFloor) {
  const n = newStartFloor;
  if (n < 0) {
    const abs = Math.abs(n);
    if (/地下\d+階/.test(oldName)) return oldName.replace(/地下\d+階/, `地下${abs}階`);
    if (/B\d+/.test(oldName))      return oldName.replace(/B\d+/, `B${abs}`);
    // 符号またぎ（地上→地下）: "1階"のような地上表記の階が振り直しで地下へ入ったときも
    // 「地下n階」へ書き換える（QA指摘。renumberPlanesFrom等の振り直しが地下/地上境界を
    // 越えるときに「地下1階」のまま残って重複する不良の修正）。
    if (/\d+階/.test(oldName))     return oldName.replace(/\d+階/, `地下${abs}階`);
  }
  if (n > 0) {
    // 符号またぎ（地下→地上）: 既存の "\d+階"・"M\d+"・"中\d+階" の判定より前に置く
    // （"地下1階"がそのまま"1階"へ書き換わらず、部分一致の"\d+階"にマッチして
    // "地下1階"のまま残ってしまう不良の修正。QA指摘）。
    if (/地下\d+階/.test(oldName)) return oldName.replace(/地下\d+階/, `${n}階`);
    if (/B\d+/.test(oldName))      return oldName.replace(/B\d+/, `${n}`);
    if (/\d+階/.test(oldName))   return oldName.replace(/\d+階/, `${n}階`);
    if (/^M\d+/.test(oldName))   return oldName.replace(/\d+/, String(n));
    if (/中\d+階/.test(oldName)) return oldName.replace(/\d+/, String(n));
  }
  if (/\d+/.test(oldName)) return oldName.replace(/\d+/, String(Math.abs(n)));
  return makeFloorName(n, 1) + ':' + oldName;
}

/**
 * 床レベル表記の階プレフィックスを返す（例: 2階→"2"、地下1階→"B1"）。
 * 「2FL」「B1FL」のように FL 表記の頭へ付ける用途。
 */
export function makeFloorLevelPrefix(startFloor) {
  return startFloor < 0 ? `B${Math.abs(startFloor)}` : `${startFloor}`;
}

/**
 * {startFloor: n, stories: m} から表示名称を生成する。
 *
 * m が小数（中間階）:
 *   "<nの整数部>ML" + ポストフィックス（0.125倍数→"3", 0.25倍数→"2", 0.5倍数→""）
 * m が整数 かつ m=1:
 *   n < 0 → "地下|n|階"
 *   n > 0 → "n階"
 * m が整数 かつ m>1（一般階）:
 *   "一般階"
 */
export function makeFloorName(startFloor, stories) {
  if (!Number.isInteger(stories)) {
    const intPart = Math.trunc(startFloor);
    let postfix = '';
    if (stories % 0.125 === 0 && stories % 0.25 !== 0)      postfix = '3';
    else if (stories % 0.25 === 0 && stories % 0.5 !== 0)   postfix = '2';
    return `${intPart}ML${postfix}`;
  }
  if (stories === 1) {
    if (startFloor < 0) return `地下${Math.abs(startFloor)}階`;
    return `${startFloor}階`;
  }
  return '一般階';
}
