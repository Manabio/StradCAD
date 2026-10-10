/**
 * 材名の表示用言い換え（純モジュール。展開図の壁2段書き・天伏パネルの天井材/仕上げが共有する）。
 * 表示専用の変換——材マスター側のデータ（materialData.js）は変更しない。
 * 「せっこうボード」→「PB」（複合名「強化せっこうボード」等も部分一致で「強化PB」に
 * なる。単純な文字列置換のため）、「t=<数値>」→「ア)<数値>」（せっこうボードに限らず全材共通。
 * 仕様に略記の指定が無いためt=表記の変換のみ全材適用する）。
 * @param {string} name
 * @returns {string}
 */
export function formatMaterialLabel(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/せっこうボード/g, 'PB').replace(/t=(\d+(?:\.\d+)?)/g, 'ア)$1');
}
