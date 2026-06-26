/**
 * 図面合成（Figure Composition）の汎用型と供給階リゾルバ。
 *
 * 1枚の図面を「複数階×複数カテゴリのレイヤ合成」として宣言的に定義するための土台。
 * ディシプリン非依存（構造に限らない）。構造固有の図面定義は structural/structuralFigure.js。
 *
 * 用語:
 *   LayerSpec   … { source, categories, style, role }。1レイヤ＝「どの階の・何を・どう描き・どう触れるか」。
 *   FigureDef   … { id, layers: LayerSpec[] }。図面型ごとの定義。
 *   Binding     … { plane, graph, roles }。レイヤが解決された自己完結グラフ（階固有CL＋通り芯参照を内包）。
 */

// レイヤの編集役割。primary=自階主編集、secondaryEdit=非アクティブ階を編集可能peekで編集、reference=参照のみ。
export const LayerRole = {
  PRIMARY: 'primary',
  SECONDARY_EDIT: 'secondaryEdit',
  REFERENCE: 'reference',
};

// レイヤの表示スタイル。Phase 3 で Konva 属性へマッピングする。
export const LayerStyle = {
  SOLID: 'solid',
  DASHED: 'dashed',
  GHOST: 'ghost',
  DIM: 'dim',
};

/**
 * source トークンを供給階の配列（0..N階）に解決する。
 *   'self'                       … subjectPlane 自身
 *   (subjectPlane, project) => Plane[] … 関数 source（'below' 等のディシプリン固有解決はこちらで渡す）
 * 将来 'above' / 'allFloors' / { offset } / { set } などの汎用トークンをここに追加する。
 */
export function resolveSourcePlanes(source, subjectPlane, project) {
  if (source === 'self') return [subjectPlane];
  if (typeof source === 'function') return source(subjectPlane, project) ?? [];
  throw new Error(`未対応の source: ${JSON.stringify(source)}`);
}
