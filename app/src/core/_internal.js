/**
 * core 内部共有ヘルパー（モジュール横断で使う純関数）。
 *
 * core.js と core/structuralEntities.js の双方から参照される。
 * 公開APIではない（core.js は再エクスポートしない）。
 */

// 中心座標 ± 幅/2 → 開口の両端。Opening（core.js）/ RcWallOpening（structuralEntities.js）共通。
export function coordLo(center, width) { return center - width / 2; }
export function coordHi(center, width) { return center + width / 2; }
