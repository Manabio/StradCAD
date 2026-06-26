/**
 * 図面定義（FigureDef）のレジストリ。
 *
 * 各ディシプリンが自分の図面定義を id で登録し、App/レンダラは id で引く（直接 import しない）。
 * 新しい図面型は FigureDef を1個登録するだけで追加でき、FigureBindingManager・レンダラ・編集パネルの
 * 改修は不要——供給階は figureTypes.js の source リゾルバ、表示スタイルは figureStyle.js、編集役割は
 * MemberListTab がそれぞれ解釈する。拡張手順は structural-model.md / figure 関連ドキュメント参照。
 *
 * 例（将来）:
 *   天井伏図   … 自階/天井 + { source:'above', categories:['beamMap'], style:DASHED, role:REFERENCE }
 *   PS検討重ね … { source:'allFloors', categories:['beamMap'], style:GHOST, role:REFERENCE }
 */

const registry = new Map(); // figureId → FigureDef

export function registerFigure(id, def) {
  registry.set(id, def);
}

export function getFigure(id) {
  const def = registry.get(id);
  if (!def) throw new Error(`未登録の図面定義: ${id}`);
  return def;
}
