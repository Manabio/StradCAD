// 平面図一式（壁・建具・柱＋柱の仕上げ包み）を描くモードかの**単一の供給源**。
//
// なぜ必要か: 壁は柱の位置で欠き取られる——`renderer/wallDrawPlan.js` が
// `finish/columnWrap.js` の `columnWallCuts` をモードに関係なく常に適用する。欠いた分は
// 柱側（`ColumnsLayer` の断面＋仕上げ包み）が埋める前提なので、**壁を描くのに柱を描かない
// モード**があると柱まわりの壁が穴のまま残り「柱と柱まわりの壁が消える」ように見える
// （不具合2026-09: 建具モード。仕上げ・敷地モードでも同じ穴が開いていた）。
// 「壁を描くモード＝柱を描くモード」をこの述語ひとつに閉じ込め、レイヤー側の appMode 直書きを禁じる。
//
// 描かないのは2モードだけ:
//   structure — 伏図（躯体の図）。平面図は描かず、柱は `StructuralLayer` が図面合成の帰属で描く。
//   elevation — 室内展開図の専用画面（`SceneLayers` が早期returnし平面レイヤー群を一切通らない）。
export function shouldShowPlanFigure(appMode) {
  return appMode !== 'structure' && appMode !== 'elevation';
}
