// RC壁下地の材コード（構造モード「壁由来の梁芯・小梁自動生成」の生成条件(a)判定に使う。
// .claude/structural-model.md 参照）。
//
// materialData.js は仕上げモード突入時にのみ動的importされるコード分割対象のため、構造モード側
// （静的import）からは本体を読み込めない／読み込むべきではない。判定に必要なのは材コード集合だけで
// 材データ本体（名称・寸法等）は不要なため、このファイル（データのみ）を分離し、
// materialData.js の該当エントリ（category:'backing'）と同じ配列を参照させることで
// コードの二重管理を防ぐ（配列はこちらが真実のソース）。
//
// ステップ12c（2026-09-24）: catalog/catalogRegistry.js（overlay。doc/userライブラリ）・
// catalog/catalogKinds.js（CatalogKind）を静的importする——ユーザーが「カタログ保守」で追加した
// 下地材（backingClass:'wood'|'other'。RCは選べない）も backingClassOf で分類できるようにするため
// （固定集合＝builtin下地材だけを見ていた従来の「依存ゼロ」から変更）。どちらも純モジュール
// （store.js/snap.js/.jsxを静的importしない）のため、本ファイルを import する側
// （structural/wallBeamAxes.js・openings/sashDetailCatalog.js 等）の node:test 単体import互換性は
// 崩れない。
import { overlayFor, overlayGeneration } from '../../catalog/catalogRegistry.js';
import { CatalogKind } from '../../catalog/catalogKinds.js';

export const RC_WALL_BACKING_CODES = Object.freeze([
  '501000000001', // RC壁 t=150
  '501000000002', // RC壁 t=180
  '501000000003', // RC壁 t=200
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
// 17件（□-120×45 〜 □-30×30）と同じコード（配列はこちらが真実のソース）。
export const WOOD_WALL_BACKING_CODES = Object.freeze([
  '101400000001', // □-120×45 杉・松等（間柱/大壁用）（在来木造 柱120角。2026-09-14追加）
  '101400000002', // □-120×30 杉・松等（間柱/薄口）（同上。柱寸×30）
  '101400000003', // □-105×45 杉・松等（間柱/大壁用）（柱105角）
  '101400000004', // □-105×30 杉・松等（間柱/薄口）（柱105角。柱寸×30）
  '101000000001', // □-90×90  杉・桧等（集成材/製材）
  '101000000002', // □-75×75  杉・桧等（集成材/製材）
  '101000000003', // □-60×60  杉・松等（製材）
  '101400000005', // □-90×45  杉・松等（間柱/大壁用）
  '101400000006', // □-90×30  杉・松等（間柱/薄口）
  '101400000007', // □-60×45  杉・松等（床根太/下地材）
  '101400000008', // □-45×45  杉・地生材等（寸五角）
  '101400000009', // □-45×15  杉等（通気胴縁/外壁用）
  '101400000010', // □-45×30  杉等（壁胴縁/内装用）
  '101400000011', // □-36×16  杉等（関東間胴縁）
  '101400000012', // □-45×36  杉等（野縁/一般天井用）
  '101400000013', // □-36×36  杉等（寸二角）
  '101400000014', // □-30×30  杉・栂等（一寸角）
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
  '120x45': '101400000001',
  '120x30': '101400000002',
  '105x45': '101400000003',
  '105x30': '101400000004',
  '90x45':  '101400000005',
  '90x30':  '101400000006',
});

/** 柱寸法（幅）と見込みから木質下地材（間柱）のコードを返す。表に無い組み合わせは null。 */
export function woodStudCodeFor(widthMm, depthMm) {
  return WOOD_STUD_CODE_BY_SIZE[`${widthMm}x${depthMm}`] ?? null;
}

/** 下地材分類（structural/structureRules.js の BACKING_RULES＝壁下地材ごとのルールのキー）。 */
export const BackingClass = Object.freeze({ WOOD: 'wood', RC: 'rc', OTHER: 'other' });

// --- overlay（ユーザー追加の下地材）経由の判定＋メモ化（ステップ12c・2026-09-24） -----------------
//
// ユーザーが「カタログ保守」で追加した下地材（catalog/catalogMaintenance.js。category:'backing'・
// backingClass:'wood'|'other'必須・'rc'は選べない）は固定集合（WOOD_WALL_BACKING_CODE_SET・
// RC_WALL_BACKING_CODE_SET）に載らないため、overlay（doc>userの解決順。catalogRegistry.jsの
// overlayFor）のmaterialエントリからbackingClassフィールドを引く。builtin一覧（materialData.js）は
// 静的importしない（本ファイルの依存ゼロ方針の対象——builtinの下地材は上のWOOD/RC固定集合で
// 既に判定済みのため、overlay側でbuiltinを二重に見る必要が無い）。
//
// structural/wallBeamAxes.js・openings/sashDetailCatalog.js からホットパスで呼ばれるため、
// structural/sectionCatalog.js catalogMap() と同型のメモ化（overlayGeneration()をキーにする）を
// 行う——世代が変わらない間はoverlayFor(material)を読み直さない。
let _overlayMaterialMap = null;
let _overlayGen = -1;

// 下地材のcategory値（catalog/catalogMaintenance.js MATERIAL_CATEGORY.BACKINGと同じ文字列）。
// backingClass.jsは catalog/catalogMaintenance.js を import しない（依存を増やさない——MATERIAL_CATEGORY
// と同様、値だけをここに複製する既存パターンを踏襲）。
const BACKING_CATEGORY = 'backing';

function overlayMaterialMap() {
  const gen = overlayGeneration();
  if (_overlayMaterialMap === null || _overlayGen !== gen) {
    const { doc, user } = overlayFor(CatalogKind.MATERIAL);
    const map = new Map();
    // ステップ12c QA指摘n1（2026-09-24再報告）: category:'backing'のエントリだけを入れる
    // （面材・仕上げ材のcodeが偶然この関数に渡された場合に誤判定しない）。
    // doc>userの解決順（catalogRegistry.js composeCatalogと同じ優先順位）——先にuserを入れ、
    // docで上書きする。
    for (const e of user) if (typeof e?.code === 'string' && e.category === BACKING_CATEGORY) map.set(e.code, e);
    for (const e of doc) if (typeof e?.code === 'string' && e.category === BACKING_CATEGORY) map.set(e.code, e);
    _overlayMaterialMap = map;
    _overlayGen = gen;
  }
  return _overlayMaterialMap;
}

/**
 * code（下地材コード）の下地材分類。固定集合（builtinのWOOD/RC）を最優先——同じcodeでユーザーが
 * overlayにbackingClass:'other'等を持つエントリを重ねても、固定集合の判定が勝つ（RC壁下地は
 * 常にRC。「同梱'other'でもRC」——固定集合優先のテストが守る）。固定集合に無ければoverlay
 * （doc>user）のmaterialエントリを見て、backingClass:'wood'ならWOOD、それ以外（'other'・'rc'
 * （選べないはずだが防御的にOTHER扱い）・未設定・エントリ無し）はOTHER。
 */
export function backingClassOf(code) {
  if (WOOD_WALL_BACKING_CODE_SET.has(code)) return BackingClass.WOOD;
  if (RC_WALL_BACKING_CODE_SET.has(code)) return BackingClass.RC;
  const entry = overlayMaterialMap().get(code);
  return entry?.backingClass === BackingClass.WOOD ? BackingClass.WOOD : BackingClass.OTHER;
}
