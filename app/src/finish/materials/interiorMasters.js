// ================================================================
// 内装マスター（部屋単位の設計上の共通事項）
//
// 部屋種別ごとに「壁材・壁仕上げ・天井高さ」などの既定値をまとめて定義する。
// 部屋は templateKey でここを参照し、個別変更は customOverrides（ポケット）で上書きする。
//   getFinishInfo() = { ...INTERIOR_MASTERS[templateKey], ...customOverrides }
//
// フィールド:
//   label         : 表示名（日本語）
//   wallMaterial  : 壁材の材料コード（面材, materialData.js 参照）
//   wallFinish    : 壁仕上げの材料コード（仕上げ材）
//   ceilingHeight : 天井高さ mm（数値）
//
// ※ マスター自体の編集 UI は本課題の範囲外（静的データとして扱う）。
// ※ 材データと同様、仕上げモード突入時にロードして使う想定。
// ================================================================

export const INTERIOR_MASTERS = Object.freeze({
  // 居室
  LIVING_ROOM: Object.freeze({
    label:         '居室',
    wallMaterial:  '111111111166', // せっこうボード t=12.5
    wallFinish:    '111111111201', // ビニールクロス
    ceilingHeight: 2700,
  }),
  // 便所
  RESTROOM: Object.freeze({
    label:         '便所',
    wallMaterial:  '111111111166', // せっこうボード t=12.5
    wallFinish:    '111111111201', // ビニールクロス
    ceilingHeight: 2400,
  }),
});
