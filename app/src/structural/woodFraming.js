// ================================================================
// 在来木造の部材寸法・割付の純関数（仕様: 2026-09-14 ユーザー確認。設計意図は .claude/structural-model.md）。
//
// 値（表・係数）は structureRules.js の TRADITIONAL_WOOD_FRAMING / TRADITIONAL_WOOD_BACKING が持ち、
// ここは「その値をどう適用するか」だけを持つ（core.js 非依存の純モジュール。node:test から単体で読める。
// core/constants.js は import 無しの純定数なので参照してよい＝beamAxisMove.js と同じ経路）。
// 生成（壁交点柱・壁下梁・頭つなぎ・床梁・火打ち梁）や描画（伏図の×／□・下地割付線）は次ステップ以降の
// 消費側が、これらを呼ぶ形で載せる。
// ================================================================
import { RoomFeature } from '../core/constants.js';
import { WOOD_BEAM_DEPTH_TABLE, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { woodRectSectionKey } from './sectionCatalog.js';

/**
 * 梁成（成D mm）を「支持する2点間距離」と「中間荷重の数」から梁成表で引く。
 * 距離は区分の上限以下で最初に当てはまる列（1820以下／2730以下／3640以下）。
 * 表の外（3640超・中間荷重4か所以上）は**表の最大側の値**を使う（ユーザー裁定2026-09-14:
 * 「表の最大値360を使う」＝既定120のまま過小断面が図に出るより、最大値を入れて auto のまま気付けるようにする）。
 * 中間荷重の数＝その梁に取りつく梁（受梁・床梁）＋その梁の上に立つ上階の柱の本数（同裁定）。
 * 非数・0以下の距離・負や非整数の荷重数は null（入力の誤り＝呼び出し側が扱う）。
 * @param {number} spanMm - 支持点間距離(mm)
 * @param {number} intermediateLoads - 中間荷重の数（0〜。3超は3扱い）
 * @param {typeof WOOD_BEAM_DEPTH_TABLE} [table]
 * @returns {number|null}
 */
export function woodBeamDepthMm(spanMm, intermediateLoads, table = WOOD_BEAM_DEPTH_TABLE) {
  if (!Number.isFinite(spanMm) || spanMm <= 0) return null;
  if (!Number.isInteger(intermediateLoads) || intermediateLoads < 0) return null;
  const found = table.spanLimitsMm.findIndex(limit => spanMm <= limit);
  const col = found < 0 ? table.spanLimitsMm.length - 1 : found;
  const row = table.depthsByLoads[Math.min(intermediateLoads, table.depthsByLoads.length - 1)];
  return row[col];
}

/**
 * 梁の断面キー（材幅＝柱同寸 × 梁成表の成）。「支持間距離と中間荷重から梁断面を決める」という
 * 呼び出し側の判断をここ1か所に置く（生成側が別式で組み直さないため）。
 * @param {number} spanMm
 * @param {number} intermediateLoads
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @returns {string|null} 例 'WOOD-120x240'。梁成が引けない・カタログに無い幅は null
 */
export function woodBeamSectionKey(spanMm, intermediateLoads, columnWidthMm) {
  const depth = woodBeamDepthMm(spanMm, intermediateLoads);
  if (depth == null || !Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  // 成が材幅より小さくなる組み合わせ（例: 柱120で成120未満）は無い（表の最小が120）ため、幅×max(成,幅)で引く。
  return woodRectSectionKey(columnWidthMm, Math.max(depth, columnWidthMm));
}

/**
 * 壁下地材（縦下地）の割付位置＝**材の中心**のA端からの距離 mm（昇順）。
 * 仕様「A,B間を割り付ける場合、AB間の両端に (AB間距離 − (AB間距離/455の商 − 1)×455) / 2 をとり、
 * 残りを455で割付」——両端の余りを等分し、内側を等ピッチにする。
 * 商が1以下（距離 < 2ピッチ）は中央に1本、距離がピッチ未満でも中央1本（0本にはしない。
 * 仕様の式が未定義な領域の解釈＝ASSUMED。.claude/structural-model.md に記録）。
 * 距離0以下・非数・ピッチ0以下は空配列。
 * @param {number} lengthMm - AB間距離
 * @param {number} [pitchMm] - 割付ピッチ（既定455。外壁は仕上げモードの「縦下地間隔」で変更可）
 * @returns {number[]} 材の中心位置（A端からの距離）
 */
export function studPositions(lengthMm, pitchMm = TRADITIONAL_WOOD_BACKING.studPitchMm) {
  if (!Number.isFinite(lengthMm) || lengthMm <= 0 || !Number.isFinite(pitchMm) || pitchMm <= 0) return [];
  const q = Math.floor(lengthMm / pitchMm);
  const n = Math.max(0, q - 1); // 内側のピッチ数
  const end = (lengthMm - n * pitchMm) / 2;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(end + i * pitchMm);
  return out;
}

/**
 * 壁下地材（縦下地）の断面＝柱寸×30（幅＝柱寸、見込み＝30）。
 * @param {number} columnWidthMm
 * @param {typeof TRADITIONAL_WOOD_BACKING} [backing]
 * @returns {{width:number, depth:number}|null} 非数・0以下は null
 */
export function studSpec(columnWidthMm, backing = TRADITIONAL_WOOD_BACKING) {
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  return { width: columnWidthMm, depth: backing.studDepthMm };
}

/**
 * 外壁アルミ製の窓／扉の両袖に立てる材の断面（幅×見込み）とクリアランス。
 * 窓＝柱寸×45、扉＝柱と同寸。どちらも左右クリアランス5mm。
 * @param {'window'|'door'} kind
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @param {typeof TRADITIONAL_WOOD_BACKING} [backing]
 * @returns {{width:number, depth:number, clearanceMm:number}|null} 不明な種別・非数は null
 */
export function openingJambSpec(kind, columnWidthMm, backing = TRADITIONAL_WOOD_BACKING) {
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  if (kind === 'window') return { width: columnWidthMm, depth: backing.windowJambDepthMm, clearanceMm: backing.jambClearanceMm };
  if (kind === 'door')   return { width: columnWidthMm, depth: backing.doorJambDepthMm ?? columnWidthMm, clearanceMm: backing.jambClearanceMm };
  return null;
}

/**
 * 玄関建具部分（1FL以下に設置する建具＝ユーザー裁定2026-09-14）の基礎・両袖取付柱の開口幅
 * ＝扉幅＋両端クリアランス。
 * @param {number} doorWidthMm
 * @param {number} [clearanceMm] - 既定は在来ルールの entranceClearanceMm(5)
 * @returns {number|null} 非数・0以下は null
 */
export function entranceOpeningWidthMm(doorWidthMm, clearanceMm = rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.entranceClearanceMm) {
  if (!Number.isFinite(doorWidthMm) || doorWidthMm <= 0 || !Number.isFinite(clearanceMm) || clearanceMm < 0) return null;
  return doorWidthMm + 2 * clearanceMm;
}

/**
 * 火打ち梁を設けられる四角か（16㎡以下の四角の4隅。吹抜け（VOID）は可、階段（STAIR・階段吹抜け STAIR_VOID）内は不可）。
 * 「EV」（仕上げモードで指定＝吹抜け扱い・EV側に部屋仕上げ材なし）は本リポにまだ表現が無く、
 * 表現方法の裁定後に不可条件へ加える。削除済み部屋（UNDEFINED＝外壁線維持のための残置）は床が
 * 無いものとして不可（ASSUMED）。
 * @param {{areaM2:number, isRectangle:boolean, feature?:string|null}|null|undefined} cell
 *   feature: RoomFeature の値（null/undefined＝通常の床）。
 * @param {number} [maxAreaM2] - 既定は在来ルールの hipBraceMaxAreaM2(16)
 * @returns {boolean} 入力が無い・不正なら false（例外を投げない）
 */
export function hipBraceAllowed(cell, maxAreaM2 = TRADITIONAL_WOOD_FRAMING.hipBraceMaxAreaM2) {
  if (!cell) return false;
  const { areaM2, isRectangle, feature = null } = cell;
  if (!isRectangle) return false;
  if (!Number.isFinite(areaM2) || areaM2 <= 0 || areaM2 > maxAreaM2) return false;
  if (feature === RoomFeature.STAIR || feature === RoomFeature.STAIR_VOID || feature === RoomFeature.UNDEFINED) return false;
  return true;
}
