// ================================================================
// 伏図（framing plan）の描画規則を主構造ルール（structureRules.js drawing）から解決する純モジュール。
//
// 在来木造の伏図（.claude/structural-model.md「ステップ4」節）は全部材が黒（framingPlanColor:'mono'）、
// 柱は下階柱＝断面□に対角線2本（×）、自階柱＝輪郭のみの□（framingColumnSymbol:'crossBox'）で描く。
// 他の主構造（S造/SRC造/RC造×2/木造2"×4"/未定）は従来どおり材種色・断面そのまま
// （framingPlanColor:'material'／framingColumnSymbol:'section'）——ここが恒等写像であることが
// 非在来の伏図を完全不変に保つ唯一の根拠（structureRules.js の値を直書きしない）。
//
// react/konva/store/.jsx を静的に引かない（team-lessons「抽出モジュールは本番経路をテストで守る」）。
// ================================================================
import { findSectionEntry } from './sectionCatalog.js';

/** 伏図の全黒色（PLAN_WALL_LINE_COLOR とは根拠が別＝「平面は柱断面を壁と同じ黒」に対し
 *  こちらは「伏図（躯体図）は全部材を黒で描く」という別の指示。統合しない。 */
export const FRAMING_MONO_COLOR = '#000000';

/** 柱のフォールバック辺長(mm)。sectionDefId がカタログに未登録のときに使う（従来の COLUMN_SIZE_MM と同値）。 */
export const COLUMN_FALLBACK_SIZE_MM = 120;

/** 伏図の柱グループ定義。レンダラはこの配列を map して描くだけにする——「どの記号か」と
 *  「輪郭線を強制するか」を1箇所（ここ）で決め、レンダラ側の条件分岐に判断を持たせない
 *  （持たせると非在来でも輪郭が強制される回帰になる。実機QA指摘2026-09-15）。
 *  配列の先頭要素は常に下階柱（columnMap）——呼び出し側はここに diaphragm を渡す。
 *  drawing.framingColumnSymbol が 'crossBox'（在来木造）以外——'section'（既定）はもちろん、
 *  未知の値もすべて非在来と同じ既定側（下階のみ・断面そのまま・輪郭強制なし）に倒す。 */
export function framingColumnGroups(drawing) {
  if (drawing.framingColumnSymbol === 'crossBox') {
    return [
      { category: 'columnMap', symbol: 'boxCross', outline: true },
      { category: 'columnMapSelf', symbol: 'box', outline: true },
    ];
  }
  return [{ category: 'columnMap', symbol: 'section', outline: false }];
}

/** 伏図の部材線色。drawing.framingPlanColor: 'mono'（在来木造）→ 常に FRAMING_MONO_COLOR。
 *  'material'（既定）→ 引数の材種色をそのまま返す（恒等写像）。 */
export function framingColor(drawing, materialColor) {
  return drawing.framingPlanColor === 'mono' ? FRAMING_MONO_COLOR : materialColor;
}

/** 伏図の柱の色上書き（colorOverride）。drawing.framingPlanColor: 'mono'（在来木造）→ FRAMING_MONO_COLOR。
 *  それ以外（既定）→ null（ColumnsLayer 側の材種色フォールバックに委ねる）。framingColor と値は同じだが、
 *  引数側（materialColor）を持たない colorOverride 専用の形——StructuralLayer.jsx で二重実装しない。 */
export function framingColorOverride(drawing) {
  return drawing.framingPlanColor === 'mono' ? FRAMING_MONO_COLOR : null;
}

/** 柱の断面外形寸法(mm)。カタログ未登録は COLUMN_FALLBACK_SIZE_MM 角にフォールバックする。 */
export function columnSectionSize(column) {
  const sec = findSectionEntry(column.sectionDefId);
  return { width: sec?.width ?? COLUMN_FALLBACK_SIZE_MM, height: sec?.height ?? COLUMN_FALLBACK_SIZE_MM };
}

/** 柱の断面に乗せる対角線2本（×）のローカル座標（中心原点）。柱の rotation を持つ親 Group の中で使う想定。
 *  返り値は Konva Line 2本ぶんの points 配列 [[x1,y1,x2,y2], [x1,y1,x2,y2]]。 */
export function columnCrossPointsLocal(width, height) {
  const hw = width / 2, hh = height / 2;
  return [
    [-hw, -hh, hw, hh],
    [-hw, hh, hw, -hh],
  ];
}
