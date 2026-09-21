/**
 * floors ストアへの書込み世代（in-memoryのみ・永続化しない）。
 *
 * 設計意図: 非アクティブ階の IDB を書く経路（saveFloor・deleteFloor・seedFromDocument・
 * clearAllStores）を個別に列挙せず、floors ストアへの書込み1点（本モジュール）で一括検知する
 * ——構造の解決コンテキスト（後続ステップB）が、1回の境界処理の間だけ保持する各階の peek 結果
 * について「その間に誰かがこの階の floors を書き換えていないか」を鮮度判定するために使う。
 * 文字列の `===` 比較でのみ使うこと（数値としての大小比較・シリアライズは想定しない）。
 * 葉モジュール: 他の src を import しない（node:test から単体 import 可能に保つ。
 * storage/sessionLock.js と同じ規律）。
 */

let epoch = 0;                 // floors ストア全体を作り直す操作（seedFromDocument・clear）で進む
const byPlaneId = new Map();   // planeId → 個別書込み回数（saveFloor・deleteFloor）

/** 特定の plane の floors を書いた（saveFloor・deleteFloor）ことを記録する。 */
export function noteFloorWrite(planeId) {
  byPlaneId.set(planeId, (byPlaneId.get(planeId) ?? 0) + 1);
}

/** floors ストア全体を作り直した（seedFloorsFromDocument・clearAllStores）ことを記録する。 */
export function noteAllFloorsWritten() {
  epoch++;
}

/** 指定 planeId の現在の世代を返す（`===` 比較専用の不透明な文字列）。 */
export function floorWriteGeneration(planeId) {
  return `${epoch}:${byPlaneId.get(planeId) ?? 0}`;
}
