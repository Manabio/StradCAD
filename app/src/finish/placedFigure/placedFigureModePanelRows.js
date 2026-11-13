/**
 * 図面モード（姿図配置モード）の汎用パネル（PlacedFigureModePanel.jsx）の判断を持つ純モジュール。
 * .jsx は node:test から読めないため、「置ける図の候補」「一覧の行のデータ」の判断をここへ出す（store.js・snap.js・.jsx・react を静的に引かない）。
 * 製品情報（product）は図から引いて表示するだけ——編集は部分詳細図ヘルパー。
 */
import { DetailProductField, DETAIL_PRODUCT_FIELD } from '../../core/constants.js';
import { canHaveDetailViews } from '../../detail/detailModel.js';
import { DETAIL_PRODUCT_TEXT } from '../../error.js';
import { productDisplayName } from '../../catalog/catalogMaintenance.js';

/**
 * 置ける図の候補。カタログ（キー→図エントリの Map 相当）のうち、平面の配置図（canHaveDetailViews）で、
 * 分類（entry.subject）が subjects（そのモードの分類）に含まれるものだけ。表示名は 製品名 → 呼称 → キー。
 * @returns {{key: string, label: string}[]} カタログの並びのまま
 */
export function placeableFigureCandidates(catalog, subjects) {
  if (catalog === null || typeof catalog !== 'object' || typeof catalog[Symbol.iterator] !== 'function' || !Array.isArray(subjects)) return [];
  return [...catalog]
    .filter(([, entry]) => canHaveDetailViews(entry) && subjects.includes(entry.subject))
    .map(([key, entry]) => ({ key, label: productDisplayName(entry) || key }));
}

/** 製品情報の項目のうち、値がある（空白だけでない文字列）ものだけを 名称・メーカー・型番・色 の順で。図が無い・product が無いときは []。 */
export function productLinesOf(entry) {
  const product = entry?.[DETAIL_PRODUCT_FIELD];
  if (product === null || typeof product !== 'object') return [];
  return Object.values(DetailProductField)
    .filter(field => typeof product[field] === 'string' && product[field].trim() !== '')
    .map(field => ({ label: DETAIL_PRODUCT_TEXT[field], value: product[field].trim() }));
}

/**
 * 一覧の行のデータ。placedFigures はモードに所属する配置（State の placedFiguresInMode の結果）、figureOf はキー→図エントリ（引けなければ null）、
 * roomNameAt は (x, y)→部屋の表示名|null。図が引けない配置（分類不明）は title がキー・productLines が空。
 * @returns {{id: string, title: string, productLines: {label: string, value: string}[], roomName: string|null,
 *            x: number, y: number, zMm: number, rotationDeg: number, mirror: boolean, note: string}[]}
 */
export function placedFigureRows(placedFigures, figureOf, roomNameAt) {
  if (!Array.isArray(placedFigures)) return [];
  return placedFigures.filter(pf => pf !== null && typeof pf === 'object').map(pf => {
    const entry = figureOf(pf.figureKey) ?? null;
    return {
      id: pf.id,
      title: entry === null ? pf.figureKey : (productDisplayName(entry) || pf.figureKey),
      productLines: productLinesOf(entry),
      roomName: roomNameAt(pf.x, pf.y),
      x: pf.x, y: pf.y, zMm: pf.zMm, rotationDeg: pf.rotationDeg, mirror: pf.mirror, note: pf.note,
    };
  });
}
