// 敷地モードの配置図の配線（.jsx は node:test から単体 import できないため、ソース文字列を検査する。
// 前例: renderer/PlanSolidsLayer.wiring.test.js・finish/FinishModeLayer.wiring.test.js）。
// コメントは除外して検査する（team-lessons「配線テストがコメント文にも一致して変異を見逃す」）。
// 行コメント（行頭 //）とブロックコメントだけを落とす。末尾コメントは落とさない（その場合は安全側＝誤って赤になる）。
// 状態（SiteModeState.placement.test.js）・純モジュール（site/sitePlacementView.test.js）は別ファイルで検査済み。ここは
// 「描画・UI・pointer がその状態に従っているか」の配線だけを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}
const code = rel => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
const count = (text, re) => (text.match(re) ?? []).length;

const layer = code('./SitePlacementLayer.jsx');
const scene = code('./SceneLayers.jsx');
const panel = code('../ui/SiteInfoPanel.jsx');
const pointer = code('../interaction/usePointerInteraction.js');

test('SitePlacementLayer: 敷地の外周は siteTransformGroupProps を spread した Group の中。屋根線は世界座標（Group の外）', () => {
  assert.match(layer, /<Group \{\.\.\.siteTransformGroupProps\(view\.siteTransform\)\}>/, 'Group は listening を切らない（角の当たりを通すため）');
  const groupAt = layer.indexOf('<Group ');
  const roofAt = layer.indexOf('view.roofLines.map');
  const siteAt = layer.indexOf('view.siteSegments.map');
  const cornerAt = layer.indexOf('view.siteCorners.flatMap');
  assert.ok(roofAt > 0 && roofAt < groupAt, '屋根線は変換の Group より前（外）');
  assert.ok(groupAt < siteAt && siteAt < cornerAt, '敷地の外周線・角の丸は Group の中');
});

test('SitePlacementLayer: 屋根線は PLAN_SOLIDS_COLOR・細線、敷地は SITE_LINE_COLOR・一点鎖線で、当たり用の丸と Group 以外は listening しない', () => {
  assert.match(layer, /stroke=\{PLAN_SOLIDS_COLOR\}/);
  assert.match(layer, /viewport\.lineWeightsPx\[SITE_PLACEMENT_ROOF_LINE_WEIGHT\]/);
  assert.match(layer, /dash=\{\[\.\.\.SITE_BOUNDARY_DASH\]\}/);
  assert.match(layer, /viewport\.lineWeightsPx\[siteLineWeightKey\(true, false\)\]/);
  assert.match(layer, /radius=\{markR\}/);
  assert.match(layer, /const markR = SITE_CORNER_MARK_RADIUS_PX \/ viewport\.scaleX;/);
  const shapes = count(layer, /<(Line|Circle|Group|Text)\b/g);
  assert.equal(shapes, 8, '通り芯の Line・屋根の Line・敷地の Line・寸法線上の点の Circle・角の見える Circle・角の当たり Circle・番号の Text・Group');
  assert.equal(count(layer, /listening=\{false\}/g), shapes - 2, '当たり用の丸と Group 以外は listening={false}');
});

test('SitePlacementLayer: 角の当たり丸は SITE_HIT_NODE_NAME・透明ストローク（HIT_PX_MAX / scale）で、onClick/onTap が mode.pickPlacementVertex（敷地座標）を呼ぶ', () => {
  assert.match(layer, /\(\{ view, viewport, mode, didPanEnd \}\) =>/, 'mode prop を受ける');
  assert.match(layer, /const hitW = HIT_PX_MAX \/ viewport\.scaleX;/);
  assert.match(layer, /name=\{SITE_HIT_NODE_NAME\}/);
  assert.match(layer, /stroke="transparent"\s+strokeWidth=\{hitW\}/);
  assert.match(layer, /onClick=\{\(\) => pick\(c\)\}/);
  assert.match(layer, /onTap=\{\(\) => pick\(c\)\}/);
  assert.match(layer, /mode\.pickPlacementVertex\(\{ x: c\.x, y: c\.y \}\)/);
  assert.match(layer, /if \(didPanEnd\?\.\(\)\) return;/, 'パン終了直後の click は無視');
  // 当たりを持つ丸（name 付き）は敷地の Group の中
  assert.ok(layer.indexOf('name={SITE_HIT_NODE_NAME}') > layer.indexOf('<Group '));
  assert.ok(layer.indexOf('name={SITE_HIT_NODE_NAME}') < layer.indexOf('</Group>'));
});

test('SitePlacementLayer: 選択中の頂点は placementVertexIndex で引き、塗り＋番号「1」「2」を選択色で。選択中の通り芯は選択色の線', () => {
  assert.match(layer, /const input = mode\.placementInput;/);
  assert.match(layer, /const idx = placementVertexIndex\(input, c\);/);
  assert.match(layer, /const color = idx \? MEMBER_SELECTION_COLOR : SITE_LINE_COLOR;/);
  assert.match(layer, /fill=\{idx \? color : undefined\}/);
  assert.match(layer, /text=\{String\(idx\)\}/);
  assert.match(layer, /fontSize=\{numFontSize\}/);
  assert.match(layer, /const numFontSize = NUM_FONT_PX \/ viewport\.scaleX;/);
  assert.match(layer, /fill=\{MEMBER_SELECTION_COLOR\}/, '番号の文字も選択色');
  assert.match(layer, /rotation=\{-view\.siteTransform\.rotationDeg\}/, 'Group の回転を打ち消して正立');
  assert.match(layer, /view\.grid\.lines\.find\(l => l\.id === input\.centerLineId\)/);
  assert.match(layer, /stroke=\{l\.key === selectedGridKey \? MEMBER_SELECTION_COLOR : originColor\(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY\)\}/);
  assert.ok(!/Math\.abs\(/.test(layer), '一致判定を描画側に書かない（純モジュールの口だけ）');
});

test('SiteModeState: 頂点の一致判定は純モジュール（samePlacementVertex・placementVertexIndex）だけを使う（比較を2か所に書かない）', () => {
  const state = code('../modes/SiteModeState.js');
  assert.match(state, /placementVertexIndex\(inp, p\)/);
  assert.match(state, /samePlacementVertex\(c, v\)/);
  assert.ok(!/SITE_PLACEMENT_VERTEX_EPS_MM/.test(state), 'EPS を SiteModeState に持ち込まない');
});

test('SitePlacementLayer: 通り芯（線・寸法・丸ラベル）は layoutSitePlacementGrid の結果を敷地の Group の外に描く', () => {
  assert.match(layer, /const g = layoutSitePlacementGrid\(view\.grid, viewport\.scaleX\);/);
  const groupAt = layer.indexOf('<Group ');
  const groupEndAt = layer.indexOf('</Group>');
  const lineAt = layer.indexOf('g.lines.map');
  const rowsAt = layer.indexOf('g.rows.flatMap');
  const labelsAt = layer.indexOf('g.labels.flatMap');
  assert.ok(lineAt > 0 && rowsAt > 0 && labelsAt > 0, 'g.lines・g.rows・g.labels を描く');
  assert.ok(lineAt < groupAt, '通り芯の線は Group より前（外）');
  assert.ok(rowsAt > groupEndAt && labelsAt > groupEndAt, '寸法行・丸ラベルは Group の後（外）');
  assert.ok(lineAt < layer.indexOf('view.roofLines.map'), '通り芯の線は屋根線より下（先に描く）');
  assert.ok(rowsAt < labelsAt, '丸ラベルは寸法行より上（後に描く）');
  assert.match(layer, /dimensionRow\(\{/);
  assert.match(layer, /g\.labels\.flatMap\(l => labelCircle\(l\.key, l\.x, l\.y, l\.label, viewport\)\)/);
  assert.match(layer, /: originColor\(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY\)\}/);
  assert.match(layer, /dash=\{gridLineDash\(gridLineWidth\)\}/);
  assert.match(layer, /const gridLineWidth = viewport\.lineWeightsPx\[SITE_PLACEMENT_GRID_LINE_WEIGHT\];/);
  assert.match(layer, /color: GRID_DIM_COLOR, strokeWidth: viewport\.lineWeightsPx\[DIMENSION_LINE_WEIGHT\]/);
  assert.match(layer, /fontSize: NUM_FONT_PX \/ viewport\.scaleX, gap: TEXT_GAP_PX \/ viewport\.scaleX/);
  assert.match(layer, /const dimDotR = GRID_DIM_DOT_RADIUS_PX \/ viewport\.scaleX;/);
});

test('SceneLayers: 配置図の表示中（sitePlacementShown）は敷地の3レイヤを出さず、SitePlacementLayer を出す（平面図一式は述語 shouldShowPlanFigure が site で false）', () => {
  assert.match(scene, /const sitePlacementShown = appMode === 'site' && !!mode\?\.showPlacement;/);
  assert.match(scene, /const showPlanFigure = shouldShowPlanFigure\(appMode\);/);
  assert.match(scene, /\{appMode === 'site' && mode && !sitePlacementShown && \(\s*<SiteLinesLayer/);
  assert.match(scene, /\{appMode === 'site' && mode && !sitePlacementShown && \(\s*<SiteRectsLayer/);
  assert.match(scene, /\{appMode === 'site' && !sitePlacementShown && <SiteDrawPreview /);
  assert.match(scene, /\{isStairMode && \(\s*<StairLayer/);
  assert.match(scene, /\{shouldShowPlacedFigures\(appMode\) && <PlacedFiguresLayer/);
  assert.match(scene, /\{sitePlacementShown && mode\.placementView && <SitePlacementLayer view=\{mode\.placementView\} viewport=\{viewport\} mode=\{mode\} didPanEnd=\{didPanEnd\} \/>\}/);
  // showPlanFigure に乗る平面図一式（壁・建具・柱・立体）は述語を共有する
  for (const name of ['ShapesLayer', 'OpeningsLayer', 'ColumnsLayer', 'PlanSolidsLayer']) {
    assert.match(scene, new RegExp(`\\{showPlanFigure && <${name} `), `${name} は showPlanFigure の下`);
  }
});

test('SiteInfoPanel: 配置図スイッチ（表示｜非表示）を出し、表示中はタブ・面積行・表・NumPad を出さない', () => {
  assert.match(panel, /const placing {3}= mode\.showPlacement;/);
  assert.match(panel, /onClick=\{\(\) => mode\.setShowPlacement\(opt\.on\)\}/);
  assert.match(panel, /style=\{segmentButtonStyle\(placing === opt\.on\)\}/);
  assert.match(panel, /\{!placing && \(\s*<div style=\{\{ display: 'flex', borderBottom: '1px solid #e2e8f0', flexShrink: 0 \}\}>\s*\{\[\s*\{ key: 'sansha'/);
  assert.match(panel, /style=\{segmentButtonStyle\(subMode === tab\.key\)\}/);
  assert.match(panel, /\{showArea && !placing && \(/);
  assert.match(panel, /\{placing \? \(\s*<>\s*\{pin && \(\(\) => \{/);
  assert.match(panel, /\{mode\.placementMessage && \(/);
  assert.match(panel, /\{!placing && subMode === 'sansha' && mode\.inputState && /);
  assert.match(panel, /\{!placing && subMode === 'rect' && mode\.rectInputState && \(/);
});

test('SiteInfoPanel: 配置指定 UI（案内・頂点の状態・通り芯一覧・距離・反転・配置・解除）が SiteModeState の口と文言定数に配線されている', () => {
  for (const name of [
    'SITE_PLACEMENT_HINT', 'SITE_PLACEMENT_VERTEX1_LABEL', 'SITE_PLACEMENT_VERTEX2_LABEL', 'SITE_PLACEMENT_CENTER_LINE_LABEL',
    'SITE_PLACEMENT_DISTANCE_LABEL', 'SITE_PLACEMENT_DISTANCE_NUMPAD_LABEL', 'SITE_PLACEMENT_FLIP_ROTATION_LABEL',
    'SITE_PLACEMENT_FLIP_SIDE_LABEL', 'SITE_PLACEMENT_COMMIT_LABEL', 'SITE_PLACEMENT_CLEAR_LABEL',
    'SITE_PLACEMENT_VERTEX_NONE', 'SITE_PLACEMENT_VERTEX_SET', 'SITE_PLACEMENT_STALE_LABEL',
  ]) {
    assert.ok(count(panel, new RegExp(`\\{?${name}\\b`, 'g')) >= 2, `${name} を import して使う`);
  }
  assert.match(panel, /const st = mode\.placementVertexStates;/);
  assert.match(panel, /onClick=\{\(\) => mode\.setPlacementCenterLine\(l\.id\)\}/);
  assert.match(panel, /\[CenterLineType\.VERTICAL, CenterLineType\.HORIZONTAL\]\.map\(type =>/);
  assert.match(panel, /\{mode\.placementCenterLineStale && SITE_PLACEMENT_STALE_LABEL\}/);
  assert.match(panel, /onClick=\{\(\) => mode\.setPlacementDistanceFocused\(true\)\}/);
  assert.match(panel, /onClick=\{\(\) => reportPlacement\(mode\.togglePlacementRotation\(\)\)\}/);
  assert.match(panel, /onClick=\{\(\) => reportPlacement\(mode\.togglePlacementSide\(\)\)\}/);
  assert.match(panel, /disabled=\{!mode\.placementCanCommit\}\s+onClick=\{\(\) => reportPlacement\(mode\.commitPlacement\(\)\)\}/);
  assert.match(panel, /\{site\.placement != null && \(\s*<button style=\{actionButton\} onClick=\{\(\) => mode\.clearPlacement\(\)\}>/);
  assert.match(panel, /const reportPlacement = \(r\) => \{ if \(r\?\.toast\) onToast\?\.\(r\.toast\); \};/, '拒否理由は App のトースト（onToast）へ');
});

test('SiteInfoPanel: 距離の NumPad は placementDistanceFocused の間だけ出し、変更・確定（commit）・取消が配線されている', () => {
  assert.match(panel, /\{placing && pin && mode\.placementDistanceFocused && \(\s*<NumPad\s+value=\{pin\.distanceValue\}\s+label=\{SITE_PLACEMENT_DISTANCE_NUMPAD_LABEL\}/);
  assert.match(panel, /onChange=\{val => mode\.setPlacementDistanceValue\(val\)\}/);
  assert.match(panel, /onConfirm=\{\(\) => \{ mode\.setPlacementDistanceFocused\(false\); reportPlacement\(mode\.commitPlacement\(\)\); \}\}/);
  assert.match(panel, /onCancel=\{\(\) => mode\.setPlacementDistanceFocused\(false\)\}/);
});

test('SiteInfoPanel: 距離欄の物理キーボードは placementDistanceFocused の間だけ（Escape で解除・Enter で確定・数字と演算子は applyKeyToNumpadValue）', () => {
  assert.match(panel, /const distanceEditing = !!\(placing && pin && mode\.placementDistanceFocused\);/);
  assert.match(panel, /if \(!distanceEditing\) return;/);
  assert.match(panel, /mode\.setPlacementDistanceValue\(applyKeyToNumpadValue\(mode\.placementInput\?\.distanceValue \?\? '', numpadKey\)\)/);
  // Enter は確定の拒否理由を onToast へ直接流す（reportPlacement を effect の依存に入れないため inline）
  assert.match(panel, /e\.key === 'Enter'\) \{\s*mode\.setPlacementDistanceFocused\(false\);\s*const r = mode\.commitPlacement\(\);\s*if \(r\?\.toast\) onToast\?\.\(r\.toast\);/);
});

test('App: SiteInfoPanel へ onToast を渡す（配置の拒否理由を既存の setToast 経路に乗せる）', () => {
  const app = code('../App.jsx');
  assert.match(app, /onDeleteSiteRow=\{handleDeleteSiteRow\}\s+onToast=\{msg => setToast\(\{ msg, key: Date\.now\(\) \}\)\}/);
});

test('usePointerInteraction: 敷地の pointerDown は inputSubMode を読む（subMode を直接読む箇所は pointerUp の1つだけ）', () => {
  assert.match(pointer, /const sm = modeRef\.current\?\.inputSubMode;/);
  assert.equal(count(pointer, /modeRef\.current\?\.subMode/g), 1, 'pointerUp の rect/三斜の分岐用の1箇所（押下が記録されなければ到達しない）');
});
