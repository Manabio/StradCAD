// 昇降機の仕様追加ステップ3（S4・平面のハイライト）: SceneLayers.jsx が <FinishModeLayer> へ
// mode.selectedEquipmentCellKeys を highlightCellKeys として渡していることをソーステキスト検査で
// 固定する（.jsx は node:test から単体 import できないため。PlanSolidsLayer.wiring.test.js と同じ型。
// コメントは除外して検査する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(import.meta.dirname, 'SceneLayers.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

test('【不変条件】SceneLayers は <FinishModeLayer ...> へ highlightCellKeys={mode.selectedEquipmentCellKeys} を渡す', () => {
  const startIdx = codeOnly.indexOf('<FinishModeLayer');
  assert.ok(startIdx >= 0, '<FinishModeLayer が見つからない');
  const endIdx = codeOnly.indexOf('/>', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 2);
  assert.ok(/highlightCellKeys=\{mode\.selectedEquipmentCellKeys\}/.test(block),
    '<FinishModeLayer ...> に highlightCellKeys={mode.selectedEquipmentCellKeys} が見つからない');
});

// QA指摘（ステップ3全体・C）: 部分一致（コメント除去のみ）は「実装を無効化しつつ元の式を
// 同じ行の行末コメントとして残す変異」（JSX式内のJS行末コメント）を検出できない。
// 1行まるごとをmフラグの行頭・行末アンカー（^\s*…$）で照合する形へ直す（生のsrcに対して照合し、
// 行末に何か続くと$の前提が崩れて不一致になる）。
test('【配線・強化】SceneLayers は <FinishModeLayer ...> へ highlightCellKeys={mode.selectedEquipmentCellKeys} を1行まるごとの形で渡す', () => {
  assert.match(src, /^\s*highlightCellKeys=\{mode\.selectedEquipmentCellKeys\}\s*$/m,
    'highlightCellKeys={mode.selectedEquipmentCellKeys} が1行まるごとの形で見つからない');
});

test('【不変条件】SceneLayers は <EquipmentSymbolLayer ...> を shouldShowEquipmentSymbols(appMode) でゲートする', () => {
  assert.ok(/\{shouldShowEquipmentSymbols\(appMode\) && \(\s*<EquipmentSymbolLayer/.test(codeOnly),
    '<EquipmentSymbolLayer ...> が shouldShowEquipmentSymbols(appMode) でゲートされていない');
});

test('【配線・強化】SceneLayers は EquipmentSymbolLayer のゲート行・symbols算出行が各1行まるごとの形である', () => {
  assert.match(src, /^\s*\{shouldShowEquipmentSymbols\(appMode\) && \(\s*$/m,
    '{shouldShowEquipmentSymbols(appMode) && ( が1行まるごとの形で見つからない');
  assert.match(src, /^\s*symbols=\{computeEquipmentSymbols\(\s*$/m,
    'symbols={computeEquipmentSymbols( が1行まるごとの形で見つからない');
});

// 下屋の平面表示（S5）: 下屋は PlanSolidsLayer（平面の断面解決。屋根立体＋解決器）が描くので、SceneLayers は RoofPlanLayer を使わない
// （旧 RoofPlanLayer.jsx は S5b で削除済み。再導入の検出）。PlanSolidsLayer は showPlanFigure でゲートし、
// EquipmentSymbolLayer の前に置く（配線は PlanSolidsLayer.wiring.test.js）。
test('【配線】SceneLayers は RoofPlanLayer を import も使用もしない（下屋は PlanSolidsLayer が描く）。showPlanFigure の定義は既存の述語のまま', () => {
  assert.equal((codeOnly.match(/RoofPlanLayer/g) || []).length, 0, 'RoofPlanLayer が出ない');
  assert.match(codeOnly, /^\s*const showPlanFigure = shouldShowPlanFigure\(appMode\);\s*$/m, 'showPlanFigure の定義は既存の述語のまま');
});

test('【配線】SceneLayers は VoidLayer を使わず、<PlanSolidsLayer abovePeek=…> を EquipmentSymbolLayer の前に置く（吹抜けの注記も PlanSolidsLayer が描く）', () => {
  assert.equal(codeOnly.indexOf('VoidLayer'), -1, 'VoidLayer は削除済み');
  assert.equal(codeOnly.indexOf('upperVoidCrosses'), -1);
  const solidsAt = codeOnly.indexOf('<PlanSolidsLayer');
  const equipAt = codeOnly.indexOf('<EquipmentSymbolLayer');
  assert.ok(solidsAt >= 0 && equipAt > solidsAt, `順序 PlanSolidsLayer(${solidsAt}) < EquipmentSymbolLayer(${equipAt})`);
  assert.ok(/<PlanSolidsLayer [^>]*abovePeek=\{abovePlanPeek\}/.test(codeOnly), 'abovePeek を渡す');
});

// QA指摘W4（昇降機の仕様追加 ステップ4・S4）: catalogは建物全体（全採用階。project.equipmentIndex経由）
// のbuildingEquipmentCatalog(project, graph)から作る——floorplan/finish両モードとも同じ供給源にする
// （selfFloorEquipmentCatalogへの後退・空配列固定を防ぐ）。
test('【配線・強化・W4】SceneLayers は symbols の catalog引数を buildingEquipmentCatalog(project, graph) から1行まるごとの形で作る', () => {
  assert.match(src, /^\s*graph, buildingEquipmentCatalog\(project, graph\),\s*$/m,
    'graph, buildingEquipmentCatalog(project, graph), が1行まるごとの形で見つからない');
});
