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
  assert.equal(shapes, 11, '通り芯の Line・屋根の Line・敷地の Line・寸法線の足の Line・寸法線上の点の Circle・角の見える Circle・角の当たり Circle・通り芯ラベルの当たり Circle・番号の Text・境界線ラベルの Text・Group');
  assert.equal(count(layer, /listening=\{false\}/g), shapes - 3, '当たり用の丸（角・通り芯ラベル）と Group 以外は listening={false}');
});

test('SitePlacementLayer: はなれ寸法の足（row.extensions）は GRID_DIM_COLOR・寸法線と同じ線幅・画面 px 幅（strokeScaleEnabled false）・listening しない Line。点より前に描く', () => {
  const at = layer.indexOf('...row.extensions.map((e, i) => (');
  const dotsAt = layer.indexOf('...row.dots.map(');
  assert.ok(at > 0 && dotsAt > at, '足は row.dots より前に描く');
  const block = layer.slice(at, dotsAt);
  assert.equal(count(block, /<Line\b/g), 1);
  assert.match(block, /key=\{`\$\{row\.key\}\/ext\/\$\{i\}`\}/);
  assert.match(block, /points=\{e\.points\}/);
  assert.match(block, /stroke=\{GRID_DIM_COLOR\}/);
  assert.match(block, /strokeWidth=\{viewport\.lineWeightsPx\[DIMENSION_LINE_WEIGHT\]\}/);
  assert.match(block, /strokeScaleEnabled=\{false\}/);
  assert.match(block, /listening=\{false\}/);
});

test('SitePlacementLayer: 角の当たり丸は SITE_HIT_NODE_NAME・透明ストローク（HIT_PX_MAX / scale）で、onClick/onTap が mode.pickPlacementVertex（敷地座標）を呼ぶ', () => {
  assert.match(layer, /\(\{ view, viewport, mode, didPanEnd, onToast \}\) =>/, 'mode・onToast prop を受ける');
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

test('SitePlacementLayer: 選択中の頂点は placementVertexLabelText で引き、塗り＋番号（1 対目「1」「2」・2 対目「1\'」「2\'」・共有は「1·1\'」）を選択色で。選択中の通り芯は選択色の線', () => {
  assert.match(layer, /const input = mode\.placementInput;/);
  assert.match(layer, /const idx = placementVertexLabelText\(input, c\);/);
  assert.ok(!/placementVertexIndex/.test(layer), '番号の組み立ては純モジュール 1 か所');
  assert.match(layer, /const color = VERTEX_COLOR_BY_KIND\[placementVertexColorKind\(input, c\)\] \?\? SITE_LINE_COLOR;/, '色は純モジュールの種別から（1 対目＝選択色・2 対目＝赤・共有＝紫）');
  assert.match(layer, /\[PlacementVertexColorKind\.FIRST\]: MEMBER_SELECTION_COLOR,/);
  assert.match(layer, /\[PlacementVertexColorKind\.SECOND\]: SITE_PLACEMENT_SECOND_PAIR_COLOR,/);
  assert.match(layer, /\[PlacementVertexColorKind\.SHARED\]: SITE_PLACEMENT_SHARED_VERTEX_COLOR,/);
  assert.match(layer, /fill=\{idx \? color : undefined\}/);
  assert.match(layer, /text=\{idx\}/);
  assert.match(layer, /fontSize=\{numFontSize\}/);
  assert.match(layer, /const numFontSize = NUM_FONT_PX \/ viewport\.scaleX;/);
  assert.match(layer, /text=\{idx\}\s+fontSize=\{numFontSize\}\s+fill=\{color\}/, '番号の文字も角と同じ色');
  assert.match(layer, /rotation=\{-view\.siteTransform\.rotationDeg\}/, 'Group の回転を打ち消して正立');
  assert.match(layer, /const selectedGridId = mode\.placementCenterLine\?\.id \?\? null;/, '失効した通り芯は印を出さない（R9）');
  assert.match(layer, /view\.grid\.lines\.find\(l => l\.id === selectedGridId\)/);
  assert.match(layer, /const selected = l\.key === selectedGridKey \|\| l\.key === selectedAlongKey;/);
  assert.match(layer, /stroke=\{selected \? MEMBER_SELECTION_COLOR : originColor\(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY\)\}/);
  assert.ok(!/Math\.abs\(/.test(layer), '一致判定を描画側に書かない（純モジュールの口だけ）');
});

test('SitePlacementLayer: 境界線ラベルは layoutBoundaryLabels の結果を敷地 Group の外の Text に写す（箱幅・offset・align・listening・色）', () => {
  assert.match(layer, /const BOUNDARY_LABEL_BOX_PX = 200;/);
  assert.match(layer, /const boundaryBoxW = BOUNDARY_LABEL_BOX_PX \/ viewport\.scaleX;/);
  assert.match(layer, /const fallbackCenter = view\.siteCenter \? applySiteTransform\(view\.siteCenter, view\.siteTransform\) : null;/);
  assert.match(layer, /layoutBoundaryLabels\(view\.boundaryPieces, view\.siteTransform, viewport\.scaleX, fallbackCenter\)/);
  const at = layer.indexOf('boundaryLabels.map');
  assert.ok(at > layer.indexOf('</Group>'), '敷地 Group の外（配置図座標）');
  const block = layer.slice(at);
  assert.match(block, /<Text\b/);
  assert.match(block, /x=\{l\.x\} y=\{l\.y\}/);
  assert.match(block, /rotation=\{l\.rotation\}/);
  assert.match(block, /text=\{l\.text\}/);
  assert.match(block, /fontSize=\{numFontSize\}/);
  assert.match(block, /fill=\{SITE_LINE_COLOR\}/);
  assert.match(block, /width=\{boundaryBoxW\}/);
  assert.match(block, /offsetX=\{boundaryBoxW \/ 2\}/);
  assert.match(block, /offsetY=\{numFontSize\}/);
  assert.match(block, /align="center"/);
  assert.match(block, /listening=\{false\}/);
});

test('編集画面（SiteLinesLayer・SiteRectsLayer）には境界線ラベルを出さない', () => {
  assert.ok(!/layoutBoundaryLabels|siteBoundaryLabels/.test(code('./SiteLinesLayer.jsx')));
  assert.ok(!/layoutBoundaryLabels|siteBoundaryLabels/.test(code('./SiteRectsLayer.jsx')));
});

test('SiteModeState: 頂点の一致判定は純モジュール（samePlacementVertex・alongSharedVertex）だけを使う（比較を2か所に書かない）', () => {
  const state = code('../modes/SiteModeState.js');
  assert.match(state, /samePlacementVertex\(slotPoint\(inp, s\), p\)/);
  assert.match(state, /samePlacementVertex\(c, v\)/);
  assert.match(state, /alongSharedVertex\(this\.placementInput\)/);
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
  assert.match(layer, /g\.labels\.flatMap\(l => \{/);
  assert.match(layer, /\.\.\.labelCircle\(l\.key, l\.x, l\.y, l\.label, viewport, selected/);
  assert.match(layer, /: originColor\(SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY\)\}/);
  assert.match(layer, /dash=\{gridLineDash\(width\)\}/);
  assert.match(layer, /const gridLineWidth = viewport\.lineWeightsPx\[SITE_PLACEMENT_GRID_LINE_WEIGHT\];/);
  assert.match(layer, /color: GRID_DIM_COLOR, strokeWidth: viewport\.lineWeightsPx\[DIMENSION_LINE_WEIGHT\]/);
  assert.match(layer, /fontSize: NUM_FONT_PX \/ viewport\.scaleX, gap: TEXT_GAP_PX \/ viewport\.scaleX/);
  assert.match(layer, /const dimDotR = GRID_DIM_DOT_RADIUS_PX \/ viewport\.scaleX;/);
});

test('SitePlacementLayer: 押せない（外周でない）通り芯ラベルは塗りなし、選択中は選択色の塗り・縁・白文字、選択中の線は太線のキー', () => {
  assert.match(layer, /\? \{ fill: MEMBER_SELECTION_COLOR, stroke: MEMBER_SELECTION_COLOR, textFill: SITE_PLACEMENT_SELECTED_LABEL_TEXT_COLOR \}/);
  assert.match(layer, /: l\.exterior \? \{\} : \{ fill: 'transparent' \}\),/, '外周のラベルは従来の塗り（opts 空）・外周でないものだけ透明');
  assert.match(layer, /const selectedLineWidth = viewport\.lineWeightsPx\[SITE_PLACEMENT_SELECTED_LINE_WEIGHT\];/);
  assert.match(layer, /const width = selected \? selectedLineWidth : gridLineWidth;/);
  assert.match(layer, /strokeWidth=\{width\}/);
});

test('SceneLayers: 配置図の表示中（sitePlacementShown）は敷地の3レイヤを出さず、SitePlacementLayer を出す（平面図一式は述語 shouldShowPlanFigure が site で false）', () => {
  assert.match(scene, /const sitePlacementShown = appMode === 'site' && !!mode\?\.showPlacement;/);
  assert.match(scene, /const showPlanFigure = shouldShowPlanFigure\(appMode\);/);
  assert.match(scene, /\{appMode === 'site' && mode && !sitePlacementShown && \(\s*<SiteLinesLayer/);
  assert.match(scene, /\{appMode === 'site' && mode && !sitePlacementShown && \(\s*<SiteRectsLayer/);
  assert.match(scene, /\{appMode === 'site' && !sitePlacementShown && <SiteDrawPreview /);
  assert.match(scene, /\{isStairMode && \(\s*<StairLayer/);
  assert.match(scene, /\{shouldShowPlacedFigures\(appMode\) && <PlacedFiguresLayer/);
  assert.match(scene, /\{sitePlacementShown && mode\.placementView && <SitePlacementLayer view=\{mode\.placementView\} viewport=\{viewport\} mode=\{mode\} didPanEnd=\{didPanEnd\} onToast=\{onToast\} \/>\}/);
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
  assert.ok(!/setPlacementCenterLine|setPlacementAlongCenterLine|placementAlongCenterLines|CenterLineType\./.test(panel), '通り芯のボタン列は廃止（配置図の丸ラベルをタップ）');
  assert.match(panel, /\{SITE_PLACEMENT_CENTER_LINE_LABEL\}：<\/span>\s*\{lineText\(mode\.placementCenterLine, mode\.placementCenterLineStale\)\}/);
  assert.match(panel, /const lineText = \(line, stale\) => \(stale \? SITE_PLACEMENT_STALE_LABEL : line \? \(line\.label \|\| String\(line\.value\)\) : SITE_PLACEMENT_VERTEX_NONE\);/);
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

test('SitePlacementLayer: 通り芯の丸ラベルの当たりは外周（exterior）のラベルだけ・敷地 Group の外・半径は labelCircleRadius・透明ストローク・パン直後は無視・toast は onToast', () => {
  const at = layer.indexOf('g.labels.flatMap');
  assert.ok(at > layer.indexOf('</Group>'), '丸ラベルは敷地 Group の外（世界座標）');
  const block = layer.slice(at);
  assert.match(block, /\.\.\.\(l\.exterior \? \[\s*<Circle\b/, '当たりは exterior のラベルにだけ');
  assert.equal(count(block, /name=\{SITE_HIT_NODE_NAME\}/g), 1);
  assert.match(block, /x=\{l\.x\} y=\{l\.y\}/);
  assert.match(block, /radius=\{labelR\}/);
  assert.match(block, /stroke="transparent"\s+strokeWidth=\{hitW\}/);
  assert.match(block, /onClick=\{\(\) => pickLabel\(l\.id\)\}/);
  assert.match(block, /onTap=\{\(\) => pickLabel\(l\.id\)\}/);
  assert.match(layer, /const labelR = labelCircleRadius\(viewport\);/);
  assert.match(layer, /const pickLabel = id => \{\s*if \(didPanEnd\?\.\(\)\) return;\s*const r = mode\.pickPlacementCenterLine\(id\);\s*if \(r\?\.toast\) onToast\?\.\(r\.toast\);\s*\};/);
  assert.match(block, /const selected = l\.id === selectedGridId \|\| l\.id === selectedAlongId;/, '選択中の A・B の丸ラベルを選択色に');
});

test('gutterPrimitives.labelCircle: 色の上書きは省略可能な opts.fill・opts.stroke・opts.textFill で、既定は固定色（GutterLayer の呼び出しは不変）', () => {
  const prim = code('./gutterPrimitives.jsx');
  assert.match(prim, /export function labelCircle\(keyBase, x, y, label, viewport, opts = \{\}\) \{/);
  assert.match(prim, /const \{ fill = '#dbeafe', stroke = '#93c5fd', textFill = '#3b82f6' \} = opts;/, '既定は従来の固定色');
  assert.match(prim, /fill=\{fill\} stroke=\{stroke\} strokeWidth/);
  assert.match(prim, /fill=\{textFill\} listening/);
  assert.ok(!/fill="#dbeafe"/.test(prim), '塗りの固定色は既定値の 1 か所だけ');
});

test('SceneLayers: SitePlacementLayer へ onToast を渡す（通り芯タップの即時再配置の拒否理由を App のトーストへ）', () => {
  assert.match(scene, /<SitePlacementLayer [^>]*onToast=\{onToast\} \/>/);
});

test('SitePlacementLayer: 位置（2 段目）の通り芯B は input.along.centerLineId から引き、1 段目の通り芯と同じ選択色で描く', () => {
  assert.match(layer, /const selectedAlongId = mode\.placementAlongCenterLine\?\.id \?\? null;/, '失効した通り芯Bは印を出さない（R9）');
  assert.match(layer, /view\.grid\.lines\.find\(l => l\.id === selectedAlongId\)/);
  assert.equal(count(layer, /selectedAlongKey/g), 2, '定義と色の判定の 2 か所だけ');
});

test('SiteInfoPanel: 1 対目・2 対目の段（見出し・頂点1/頂点2 の状態・通り芯B・離れ・側反転・解除）が SiteModeState の口と文言定数に配線されている。共有点の切替は撤去', () => {
  for (const name of [
    'SITE_PLACEMENT_ALONG_LABEL', 'SITE_PLACEMENT_FIRST_PAIR_LABEL', 'SITE_PLACEMENT_ALONG_UNSHARED_LABEL',
    'SITE_PLACEMENT_ALONG_DISTANCE_LABEL', 'SITE_PLACEMENT_ALONG_DISTANCE_NUMPAD_LABEL',
    'SITE_PLACEMENT_ALONG_FLIP_SIDE_LABEL', 'SITE_PLACEMENT_ALONG_CLEAR_LABEL',
  ]) {
    assert.ok(count(panel, new RegExp(`\\{?${name}\\b`, 'g')) >= 2, `${name} を import して使う`);
  }
  assert.ok(!/SitePlacementAlongVertex|setPlacementAlongVertex|SITE_PLACEMENT_ALONG_VERTEX_LABEL|placementAlongVertexStale/.test(panel), '共有点の［頂点1｜頂点2］切替は撤去');
  assert.ok(!/SITE_PLACEMENT_ALONG_VERTEX_LABEL/.test(code('../core/constants.js')), '共有点ラベル定数は削除');
  assert.match(panel, /const ast = mode\.placementAlongVertexStates;/);
  assert.match(panel, /const alongVertexText = s => \(s === 'unshared' \? SITE_PLACEMENT_ALONG_UNSHARED_LABEL : vertexText\(s\)\);/);
  assert.match(panel, /\{SITE_PLACEMENT_VERTEX1_LABEL\}：<\/span>\s*\{alongVertexText\(ast\.v1\)\}/, '2 対目の頂点1（共有）');
  assert.match(panel, /\{SITE_PLACEMENT_VERTEX2_LABEL\}：<\/span>\s*\{alongVertexText\(ast\.v2\)\}/, '2 対目の頂点2');
  assert.match(panel, /\{SITE_PLACEMENT_FIRST_PAIR_LABEL\}<\/div>/);
  assert.ok(panel.indexOf('SITE_PLACEMENT_FIRST_PAIR_LABEL}</div>') < panel.indexOf('vertexText(st.v1)'), '1 対目の見出しは頂点1 行の上');
  assert.match(panel, /\{SITE_PLACEMENT_ALONG_CENTER_LINE_LABEL\}：<\/span>\s*\{lineText\(mode\.placementAlongCenterLine, mode\.placementAlongStale\)\}/, '「位置の通り芯：<ラベル>」（見出しは定数 1 つ）');
  assert.ok(!/SITE_PLACEMENT_ALONG_HINT/.test(panel), '1 段目未選択の案内文は廃止');
  assert.ok(!/SITE_PLACEMENT_ALONG_HINT/.test(code('../core/constants.js')), '定数も削除');
  assert.match(code('../core/constants.js'), /export const SITE_PLACEMENT_HINT = '配置図の敷地の角（1 対目→2 対目の順）と通り芯ラベルをタップ';/);
  assert.match(code('../core/constants.js'), /export const SITE_PLACEMENT_ALONG_LABEL = '2 対目';/);
  assert.match(code('../core/constants.js'), /export const SITE_PLACEMENT_FIRST_PAIR_LABEL = '1 対目';/);
  assert.match(panel, /onClick=\{\(\) => mode\.setPlacementAlongDistanceFocused\(true\)\}/);
  assert.match(panel, /\{mode\.placementAlongState !== 'none' && \(\s*<>\s*<button style=\{actionButton\} onClick=\{\(\) => reportPlacement\(mode\.togglePlacementAlongSide\(\)\)\}>[^<]*<\/button>\s*<button style=\{actionButton\} onClick=\{\(\) => reportPlacement\(mode\.clearPlacementAlong\(\)\)\}>/, '側反転（位置）・位置の解除は位置が none でないときだけ');
  // 位置の段は 1 段目の最終ボタン列（回転反転・側反転・配置・解除）の前
  assert.ok(panel.indexOf('SITE_PLACEMENT_ALONG_LABEL}</div>') < panel.indexOf('mode.togglePlacementRotation()'));
});

test('SiteInfoPanel: 位置の離れの NumPad は placementAlongDistanceFocused の間だけ出し、変更・確定（commit）・取消が配線されている', () => {
  assert.match(panel, /\{placing && pin && mode\.placementAlongDistanceFocused && \(\s*<NumPad\s+value=\{pin\.along\.distanceValue\}\s+label=\{SITE_PLACEMENT_ALONG_DISTANCE_NUMPAD_LABEL\}/);
  assert.match(panel, /onChange=\{val => mode\.setPlacementAlongDistanceValue\(val\)\}/);
  assert.match(panel, /onConfirm=\{\(\) => \{ mode\.setPlacementAlongDistanceFocused\(false\); reportPlacement\(mode\.commitPlacement\(\)\); \}\}/);
  assert.match(panel, /onCancel=\{\(\) => mode\.setPlacementAlongDistanceFocused\(false\)\}/);
});

test('SiteInfoPanel: 位置の離れ欄の物理キーボードは placementAlongDistanceFocused の間だけ（Escape で解除・Enter で確定・数字と演算子は位置の離れの値へ）', () => {
  assert.match(panel, /const alongDistanceEditing = !!\(placing && pin && mode\.placementAlongDistanceFocused\);/);
  assert.match(panel, /if \(!alongDistanceEditing\) return;/);
  assert.match(panel, /mode\.setPlacementAlongDistanceValue\(applyKeyToNumpadValue\(mode\.placementInput\?\.along\?\.distanceValue \?\? '', numpadKey\)\)/);
  assert.match(panel, /e\.key === 'Enter'\) \{\s*mode\.setPlacementAlongDistanceFocused\(false\);\s*const r = mode\.commitPlacement\(\);\s*if \(r\?\.toast\) onToast\?\.\(r\.toast\);/);
  assert.match(panel, /\}, \[alongDistanceEditing, mode, onToast\]\);/);
  assert.equal(count(panel, /document\.addEventListener\('keydown', onKey\)/g), 4, '三斜・長方形・距離欄・位置の離れ欄の 4 つの effect');
});

test('App: SiteInfoPanel へ onToast を渡す（配置の拒否理由を既存の setToast 経路に乗せる）', () => {
  const app = code('../App.jsx');
  assert.match(app, /onDeleteSiteRow=\{handleDeleteSiteRow\}\s+onToast=\{msg => setToast\(\{ msg, key: Date\.now\(\) \}\)\}/);
});

test('usePointerInteraction: 敷地の pointerDown は inputSubMode を読む（subMode を直接読む箇所は pointerUp の1つだけ）', () => {
  assert.match(pointer, /const sm = modeRef\.current\?\.inputSubMode;/);
  assert.equal(count(pointer, /modeRef\.current\?\.subMode/g), 1, 'pointerUp の rect/三斜の分岐用の1箇所（押下が記録されなければ到達しない）');
});
