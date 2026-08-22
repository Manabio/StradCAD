/**
 * 2.5D断面エンジン: 扇形レーンを持つ階段タイプ（WINDING/L_TURN/FLARED/OPEN_WELL）の切断定義表。
 * WP-E6完了条件「失敗系 WINDING等null」・設計書§4ファイル構成の指示により、cuts/配下へ
 * 「未対応」を明記した枠だけ置く——第3層（sectionStair.jsのFlight。区分線形=直進区間のみを
 * 表現できる型）では、回り段・矩折コーナー・扇形レーンの踏面形状（放射状に広がる踏面）を
 * 表現できないため、今回のWP-E6スコープでは対応しない。呼び出し側（elevationStairSequence.js）
 * はnullを受けて既存のcomposeRoomFaces+rotateFacesToStartフォールバック経路（手書きの2層枠）を
 * そのまま使う。
 * @module
 */
import { StairType } from '@core';

/** 第3層(Flight)で表現できない＝本エンジンが未対応の階段タイプ一覧。 */
export const UNSUPPORTED_FAN_LANE_TYPES = Object.freeze([
  StairType.WINDING, StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL,
]);

/**
 * WINDING/L_TURN/FLARED/OPEN_WELL（扇形レーンを持つタイプ）は常にnull（未対応。上記コメント
 * 参照）。それ以外のタイプは対象外（switchbackCuts/straightCutsが担当）だが、防御的にnullを返す。
 * @param {import('@core').Stair} stair
 * @returns {null}
 */
export function fanLaneCuts(stair) {
  void stair; // 型を見て「未対応」を返すだけの枠——引数は使わない（意図的）
  return null;
}
