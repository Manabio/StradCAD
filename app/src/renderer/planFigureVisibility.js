// 平面図一式（壁・建具・柱＋柱の仕上げ包み）を描くモードかの**単一の供給源**。
//
// なぜ必要か: 壁は柱の位置で欠き取られる——`renderer/wallDrawPlan.js` が
// `finish/columnWrap.js` の `columnWallCuts` をモードに関係なく常に適用する。欠いた分は
// 柱側（`ColumnsLayer` の断面＋仕上げ包み）が埋める前提なので、**壁を描くのに柱を描かない
// モード**があると柱まわりの壁が穴のまま残り「柱と柱まわりの壁が消える」ように見える
// （不具合2026-09: 建具モード。仕上げ・敷地モードでも同じ穴が開いていた）。
// 「壁を描くモード＝柱を描くモード」をこの述語ひとつに閉じ込め、レイヤー側の appMode 直書きを禁じる。
//
// 描かないのは4モードだけ（壁・建具・柱について。階段は下の shouldShowStairFigure で天伏も除く）:
//   structure — 伏図（躯体の図）。平面図は描かず、柱は `StructuralLayer` が図面合成の帰属で描く。
//   elevation — 室内展開図の専用画面（`SceneLayers` が早期returnし平面レイヤー群を一切通らない）。
//   facade    — 外壁立面図の専用画面（elevation と同じく `SceneLayers` が早期return）。
//   site      — 敷地図の画面。配置図の表示中は屋根伏せ図・通り芯だけ、非表示中は敷地線だけ（ユーザー指示2026-11-09）。
export function shouldShowPlanFigure(appMode) {
  return appMode !== 'structure' && appMode !== 'elevation' && appMode !== 'facade' && appMode !== 'site';
}

// 姿図の配置（renderer/PlacedFiguresLayer.jsx）を描くモードか。平面図一式と同じ述語。天伏も通す
// ——見上げは空調（hvac）だけという絞りは placedFigureDrawPlan 側で行う。
export function shouldShowPlacedFigures(appMode) {
  return shouldShowPlanFigure(appMode);
}

// 階段の図（StairLayer の自階の階段・下階の階段〔upper〕・2a壁の描画クリップ）を描くモードか。
// 平面図一式の述語（上）から天伏（'ceiling'）だけを除く。天伏は壁・建具・柱は描くが、階段は上から見た姿ではなく
// 上階の裏面（planSolids の見上げ。S13a）で表すため、自階の階段の線・外周・矢印も下階の階段の見下げも描かない
// （ユーザー裁定 Q7。2a壁は切断された壁としてそのまま見えるのでクリップも止める）。
export function shouldShowStairFigure(appMode) {
  return shouldShowPlanFigure(appMode) && appMode !== 'ceiling';
}

// 敷地の境界線（境界線・角の丸・境界線ラベル。renderer/SiteBoundaryOverlayLayer.jsx）を重ねるモードか。
// 平面（floorplan）・仕上げ（finish）・天伏（ceiling）・構造（structure）。敷地・展開・立面・建具などは重ねない。
// 実際に出すのはこの述語＋「配置の指定がある」＋「1階（相当）の階を表示中」（floorNumber.js isGroundFloorEquivalent）。
export function shouldShowSiteBoundaryOverlay(appMode) {
  return appMode === 'floorplan' || appMode === 'finish' || appMode === 'ceiling' || appMode === 'structure';
}

// 平面の断面解決の**向き**: 天伏モード（'ceiling'）は切断高より上を見上げる（'up'）、他のモードは見下げる（'down'。未知のモードも）。
// 向きの判断の唯一の供給源（PlanSolidsLayer へは SceneLayers がこの値を渡す）。
export function planSectionDirection(appMode) {
  return appMode === 'ceiling' ? 'up' : 'down';
}

// 平面図の**注記**（階段の段数字）を描くモードか。図形（上記）と違い注記は平面モード限定
// ——室名（RoomLabelsLayer）・段差断面（StepSectionLayer）と同じ「注記は平面のみ」の扱い。
// ユーザー決定2026-09: 他モードへ遷移しても階段の図は出したままにするが、段数字は出さない
// （仕上げモードで従来出ていた段数字もこの規則に揃えて消える）。
export function shouldShowStairStepNumbers(appMode) {
  return appMode === 'floorplan';
}

// 通り芯交点の青丸（CenterLinesLayer.jsx IntersectionMarkers）を描くモードか。
// 敷地モードは通り芯自体を扱わないため従来から描かない。構造モード（伏図）は主構造によらず描かない
// ——伏図では交点に柱記号（×／□）が乗り、青丸がその上に重なって柱が選べない・見分けられない
// （ユーザー裁定2026-09-17「主要構造によらず構造モードでは青丸を廃止」）。
export function shouldShowIntersectionMarkers(appMode) {
  return appMode !== 'site' && appMode !== 'structure';
}

// 柱の由来×（renderer/originColorKey.js columnOriginMarkKey・renderer/StructuralLayer.jsx
// ColumnsLayer の originMarks prop）を描くモードか。平面モード限定——伏図（構造モード）の×は
// 由来色ではなく全黒のまま（renderColumnGroup経路。柱の由来別色分け ステップ3）。
export function shouldShowColumnOriginMarks(appMode) {
  return appMode === 'floorplan';
}

// 昇降機器具の図中記号（renderer/EquipmentSymbolLayer.jsx）を描くモードか。
// 室名が出るモード（floorplan=RoomLabelsLayer・finish=FinishModeLayerの部屋名描画）に揃える
// （昇降路のRoom名は空なので室名自体は出ない。記号だけがこの2モードで出る）。
export function shouldShowEquipmentSymbols(appMode) {
  return appMode === 'floorplan' || appMode === 'finish';
}
