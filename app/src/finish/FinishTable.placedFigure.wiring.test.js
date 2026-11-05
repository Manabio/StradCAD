// FinishTable.jsx の「衛生・家具・空調」タブ（姿図の配置。S10 P4）の配線不変条件。.jsx は node:test から単体 import
// できないため、ソーステキスト検査で固定する（FinishTable.wiring.test.js と同じ型）。
// 検査は「コメントを除いたトリム後の 1 行がまるごと一致」——行末コメントに元の式を残す変異を通さない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const text = fs.readFileSync(path.resolve(import.meta.dirname, 'FinishTable.jsx'), 'utf8');
const code = text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .join('\n');
// 行末コメントも除いたトリム済みの行
const lines = code.split('\n').map(l => l.replace(/\s\/\/.*$/, '').trim());

test('【配線】TABS は equipment の直後に placedFigure（タブ名「衛生・家具・空調」）を 1 行まるごと置く', () => {
  const equipmentAt = lines.indexOf("{ id: 'equipment', label: '機械器具' },");
  assert.ok(equipmentAt >= 0, 'equipment のタブ行が見つからない');
  assert.equal(lines[equipmentAt + 1], "{ id: 'placedFigure', label: '衛生・家具・空調' },");
});

test('【配線】描画分岐は equipment の次・accessory の前で <PlacedFigureTab graph mode /> を 1 行まるごと置く', () => {
  const at = lines.indexOf("? <PlacedFigureTab graph={graph} mode={mode} />");
  assert.ok(at >= 1, '<PlacedFigureTab の行が見つからない');
  assert.equal(lines[at - 1], ": activeTab === 'placedFigure'");
  assert.equal(lines[at + 1], ": activeTab === 'accessory'");
  const equipmentAt = lines.indexOf(": activeTab === 'equipment'");
  assert.ok(equipmentAt >= 0 && equipmentAt < at, 'equipment の分岐より後');
  assert.ok(lines.includes("import { PlacedFigureTab } from './placedFigure/PlacedFigureTab.jsx';"));
});

test('【配線】姿図の配置が選択されたらタブを自動切替する effect を 1 行まるごと置く（昇降機の effect の次）', () => {
  const eq = lines.indexOf("useEffect(() => { if (mode.selectedEquipmentId) setActiveTab('equipment'); }, [mode.selectedEquipmentId]);");
  assert.ok(eq >= 0, '昇降機の effect が見つからない');
  assert.equal(lines[eq + 1], "useEffect(() => { if (mode.selectedPlacedFigureId) setActiveTab('placedFigure'); }, [mode.selectedPlacedFigureId]);");
});
