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
  '111111111239', // □-120×45 杉・松等（間柱/大壁用）（在来木造 柱120角。2026-09-14追加）
  '111111111240', // □-120×30 杉・松等（間柱/薄口）（同上。柱寸×30）
  '111111111241', // □-105×45 杉・松等（間柱/大壁用）（柱105角）
  '111111111242', // □-105×30 杉・松等（間柱/薄口）（柱105角。柱寸×30）
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

// 在来木造の壁下地＝「柱同寸×30」（仕様2026-09-14）を自動選択するための、寸法 → 材コード表。
// キーは `${幅}x${見込み}`。幅＝柱寸法（正角。90/105/120）、見込み＝30（壁下地材）／45（間柱）。
// materialData.js の BACKING は新規4件のコードをこの表から取る（二重管理防止。90×45/90×30 は既存コード）。
export const WOOD_STUD_CODE_BY_SIZE = Object.freeze({
  '120x45': '111111111239',
  '120x30': '111111111240',
  '105x45': '111111111241',
  '105x30': '111111111242',
  '90x45':  '111111111155',
  '90x30':  '111111111156',
});

/** 柱寸法（幅）と見込みから木質下地材（間柱）のコードを返す。表に無い組み合わせは null。 */
export function woodStudCodeFor(widthMm, depthMm) {
  return WOOD_STUD_CODE_BY_SIZE[`${widthMm}x${depthMm}`] ?? null;
}

/** 下地材分類（structural/structureRules.js の BACKING_RULES＝壁下地材ごとのルールのキー）。 */
export const BackingClass = Object.freeze({ WOOD: 'wood', RC: 'rc', OTHER: 'other' });

/** code（下地材コード）の下地材分類。分類の真実はこのファイルの材コード集合。 */
export function backingClassOf(code) {
  if (WOOD_WALL_BACKING_CODE_SET.has(code)) return BackingClass.WOOD;
  if (RC_WALL_BACKING_CODE_SET.has(code)) return BackingClass.RC;
  return BackingClass.OTHER;
}
