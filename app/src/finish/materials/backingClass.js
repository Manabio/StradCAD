// RC壁下地の材コード（構造モード「壁由来の梁芯・小梁自動生成」の生成条件(a)判定に使う。
// .claude/structural-model.md 参照）。
//
// materialData.js は仕上げモード突入時にのみ動的importされるコード分割対象のため、構造モード側
// （静的import）からは本体を読み込めない／読み込むべきではない。判定に必要なのは材コード集合だけで
// 材データ本体（名称・寸法等）は不要なため、このファイル（データのみ・依存ゼロ）を分離し、
// materialData.js の該当エントリ（category:'backing'）と同じ配列を参照させることで
// コードの二重管理を防ぐ（配列はこちらが真実のソース）。
export const RC_WALL_BACKING_CODES = Object.freeze([
  '111111111236', // RC壁 t=150
  '111111111237', // RC壁 t=180
  '111111111238', // RC壁 t=200
]);

const RC_WALL_BACKING_CODE_SET = new Set(RC_WALL_BACKING_CODES);

/** code（下地材コード）がRC壁下地かどうか。 */
export function isRcWallBacking(code) {
  return RC_WALL_BACKING_CODE_SET.has(code);
}
