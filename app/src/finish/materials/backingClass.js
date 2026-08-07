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

// 木質下地材の材コード（openings/sashDetailCatalog.js のサッシ納まり判定「木造下地材の断面寸法
// ≥90mmでフィン直付け」に使う）。RC_WALL_BACKING_CODES と同じ理由（materialData.js は仕上げ
// モードのみ動的import・sashDetailCatalog.js は静的import）でコード集合だけをここに分離する。
// materialData.js の BACKING（category:'backing'）中、spec が杉・桧・松・栂等の木質材である
// 13件（□-90×90 〜 □-30×30）と同じコード（配列はこちらが真実のソース）。
export const WOOD_WALL_BACKING_CODES = Object.freeze([
  '111111111152', // □-90×90  杉・桧等（集成材/製材）
  '111111111153', // □-75×75  杉・桧等（集成材/製材）
  '111111111154', // □-60×60  杉・松等（製材）
  '111111111155', // □-90×45  杉・松等（間柱/大壁用）
  '111111111156', // □-90×30  杉・松等（間柱/薄口）
  '111111111157', // □-60×45  杉・松等（床根太/下地材）
  '111111111158', // □-45×45  杉・地生材等（寸五角）
  '111111111159', // □-45×15  杉等（通気胴縁/外壁用）
  '111111111160', // □-45×30  杉等（壁胴縁/内装用）
  '111111111161', // □-36×16  杉等（関東間胴縁）
  '111111111162', // □-45×36  杉等（野縁/一般天井用）
  '111111111163', // □-36×36  杉等（寸二角）
  '111111111164', // □-30×30  杉・栂等（一寸角）
]);

const WOOD_WALL_BACKING_CODE_SET = new Set(WOOD_WALL_BACKING_CODES);

/** code（下地材コード）が木質下地かどうか。 */
export function isWoodWallBacking(code) {
  return WOOD_WALL_BACKING_CODE_SET.has(code);
}
