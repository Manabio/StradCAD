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
  assert.match(layer, /<Group \{\.\.\.siteTransformGroupProps\(view\.siteTransform\)\} listening=\{false\}>/);
  const groupAt = layer.indexOf('<Group ');
  const roofAt = layer.indexOf('view.roofLines.map');
  const siteAt = layer.indexOf('view.siteSegments.map');
  const cornerAt = layer.indexOf('view.siteCorners.map');
  assert.ok(roofAt > 0 && roofAt < groupAt, '屋根線は変換の Group より前（外）');
  assert.ok(groupAt < siteAt && siteAt < cornerAt, '敷地の外周線・角の丸は Group の中');
});

test('SitePlacementLayer: 屋根線は PLAN_SOLIDS_COLOR・細線、敷地は SITE_LINE_COLOR・一点鎖線で、すべて listening しない', () => {
  assert.match(layer, /stroke=\{PLAN_SOLIDS_COLOR\}/);
  assert.match(layer, /viewport\.lineWeightsPx\[SITE_PLACEMENT_ROOF_LINE_WEIGHT\]/);
  assert.match(layer, /dash=\{\[\.\.\.SITE_BOUNDARY_DASH\]\}/);
  assert.match(layer, /viewport\.lineWeightsPx\[siteLineWeightKey\(true, false\)\]/);
  assert.match(layer, /radius=\{markR\}/);
  assert.match(layer, /const markR = SITE_CORNER_MARK_RADIUS_PX \/ viewport\.scaleX;/);
  const shapes = count(layer, /<(Line|Circle|Group)\b/g);
  assert.equal(shapes, 6, '通り芯の Line・屋根の Line・敷地の Line・寸法線上の点の Circle・角の Circle・Group');
  assert.equal(count(layer, /listening=\{false\}/g), shapes, '全図形が listening={false}');
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
  assert.match(layer, /stroke=\{originColor\(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY\)\}/);
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
  assert.match(scene, /\{sitePlacementShown && mode\.placementView && <SitePlacementLayer view=\{mode\.placementView\} viewport=\{viewport\} \/>\}/);
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
  assert.match(panel, /\{placing \? \(\s*mode\.placementMessage && \(/);
  assert.match(panel, /\{!placing && subMode === 'sansha' && mode\.inputState && /);
  assert.match(panel, /\{!placing && subMode === 'rect' && mode\.rectInputState && \(/);
});

test('usePointerInteraction: 敷地の pointerDown は inputSubMode を読む（subMode を直接読む箇所は pointerUp の1つだけ）', () => {
  assert.match(pointer, /const sm = modeRef\.current\?\.inputSubMode;/);
  assert.equal(count(pointer, /modeRef\.current\?\.subMode/g), 1, 'pointerUp の rect/三斜の分岐用の1箇所（押下が記録されなければ到達しない）');
});
