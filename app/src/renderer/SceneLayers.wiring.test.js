// 昇降機の仕様追加ステップ3（S4・平面のハイライト）: SceneLayers.jsx が <FinishModeLayer> へ
// mode.selectedEquipmentCellKeys を highlightCellKeys として渡していることをソーステキスト検査で
// 固定する（.jsx は node:test から単体 import できないため。VoidLayer.wiring.test.js と同じ型。
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

// 下屋の平面表示（ステップ1）: RoofPlanLayer は平面図一式の述語 showPlanFigure（構造モード・展開モードだけ偽）で出し入れし、
// VoidLayer のブロックの直後・EquipmentSymbolLayer の前に置く。新しいモード述語は作らない。
test('【配線・強化】SceneLayers は <RoofPlanLayer> を showPlanFigure で1行まるごとの形でゲートする（appMode の直書き・別条件にしない）', () => {
  assert.match(codeOnly, /^\s*\{showPlanFigure && <RoofPlanLayer graph=\{graph\} viewport=\{viewport\} \/>\}\s*$/m,
    '{showPlanFigure && <RoofPlanLayer graph={graph} viewport={viewport} />} が1行まるごとの形で見つからない');
  assert.match(codeOnly, /^\s*import \{ RoofPlanLayer \} from '\.\/RoofPlanLayer\.jsx';\s*$/m);
  assert.equal((codeOnly.match(/<RoofPlanLayer\b/g) || []).length, 1, '使うのは1箇所だけ');
  assert.match(codeOnly, /^\s*const showPlanFigure = shouldShowPlanFigure\(appMode\);\s*$/m, 'showPlanFigure の定義は既存の述語のまま');
});

test('【配線】SceneLayers は <RoofPlanLayer> を VoidLayer のブロックの直後・EquipmentSymbolLayer の前に置く', () => {
  const voidAt = codeOnly.indexOf('<VoidLayer');
  const roofAt = codeOnly.indexOf('<RoofPlanLayer');
  const equipAt = codeOnly.indexOf('<EquipmentSymbolLayer');
  assert.ok(voidAt >= 0 && roofAt > voidAt && equipAt > roofAt, `順序 VoidLayer(${voidAt}) < RoofPlanLayer(${roofAt}) < EquipmentSymbolLayer(${equipAt})`);
});

// QA指摘W4（昇降機の仕様追加 ステップ4・S4）: catalogは建物全体（全採用階。project.equipmentIndex経由）
// のbuildingEquipmentCatalog(project, graph)から作る——floorplan/finish両モードとも同じ供給源にする
// （selfFloorEquipmentCatalogへの後退・空配列固定を防ぐ）。
test('【配線・強化・W4】SceneLayers は symbols の catalog引数を buildingEquipmentCatalog(project, graph) から1行まるごとの形で作る', () => {
  assert.match(src, /^\s*graph, buildingEquipmentCatalog\(project, graph\),\s*$/m,
    'graph, buildingEquipmentCatalog(project, graph), が1行まるごとの形で見つからない');
});
