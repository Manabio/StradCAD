// 構造パネルの外部タブ（RoofSpecTab.jsx・StructuralPanel.jsx）の配線。.jsx は node:test から import できないため、
// ソースを走査して固定する（commonInfoTab.wiring.test.js と同じ流儀。コメントは除いてから照合する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const read = name => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8'));

test('【配線】StructuralPanel.jsx: タブ「外部」（id roof）を持ち、RoofSpecTab に graph・composition・project・onStructureChanged を渡す', () => {
  const code = read('StructuralPanel.jsx');
  assert.ok(/\{ id: 'roof',\s*label: '外部' \}/.test(code), 'タブ定義に外部が無い');
  assert.ok(/activeTab === 'roof' && <RoofSpecTab graph=\{graph\} composition=\{composition\} project=\{project\} onStructureChanged=\{onStructureChanged\} \/>/.test(code),
    'RoofSpecTab の描画と props が想定と違う');
});

test('【配線】RoofSpecTab.jsx: spec.setField( は onStructureChanged( の閉包の中だけ（構造再計算＋undo 1件に統一）。withFinishUndo／commitRoofSpecField は使わない', () => {
  const code = read('RoofSpecTab.jsx');
  assert.ok(!/withFinishUndo|commitRoofSpecField/.test(code), '仕上げモードの undo 経路を使わない');
  const writes = [...code.matchAll(/\.setField\(/g)];
  assert.equal(writes.length, 1, '書き込み箇所は1つ');
  assert.ok(/onStructureChanged\(\(\) => \{ spec\.setField\(field, value\); \}\);\s*markDirty\(\);/.test(code),
    'setField が onStructureChanged の閉包になっていない／確定の直後に markDirty が無い（auto-save の autorun は roofSpec を見ない）');
  assert.ok(/if \(!roofSpecFieldChanges\(spec, field, value\)\) return false;/.test(code), '無変更・不正な値は再計算も undo も起こさない（roofSpecFieldChanges を先に）');
  assert.ok(/if \(!room \|\| !isRoofFeature\(room\.feature\)\) return false;/.test(code), '下屋の確定は仕上げモードと同じ isRoofFeature の判定を通す');
});

test('【配線】RoofSpecTab.jsx: 群と編集対象は roofSpecTabGroups（純モジュール）に任せ、下階は composition の columnMap、材料は共有フック', () => {
  const code = read('RoofSpecTab.jsx');
  assert.ok(/composition\?\.graphForCategory\('columnMap'\) \?\? null/.test(code));
  assert.ok(/roofSpecTabGroups\(\{ graph, belowGraph, project \}\)/.test(code));
  assert.equal([...code.matchAll(/useSteelSlabMaterials\(\)/g)].length, 1, '材料は共有フック経由で1回だけ');
  assert.ok(/<MainRoofGroup graph=\{target\} mode=\{mode\}/.test(code) && /<RoofGroup room=\{roofRoom\} graph=\{target\} mode=\{mode\}/.test(code)
    && /<RoofZoneGroup zone=\{roofZone\} graph=\{target\} mode=\{mode\}/.test(code),
  '群の描画は仕上げモードと同じ RoofGroup／MainRoofGroup／RoofZoneGroup で、graph は編集対象（target）');
});

test('【配線】RoofSpecTab.jsx: 屋根区画の確定は同じ commit（roofSpecFieldChanges → onStructureChanged の閉包 → markDirty）を通る。不明な zoneId は spec なしで commit が false', () => {
  const code = read('RoofSpecTab.jsx');
  assert.ok(/setRoofZoneField: \(zoneId, field, value\) => commit\(target\?\.roofZones\.find\(z => z\.id === zoneId\)\?\.spec, field, value\),/.test(code),
    'setRoofZoneField が commit(区画の spec, …) になっていない');
  assert.equal([...code.matchAll(/commit\(/g)].length, 3, 'commit の呼び出しは 下屋・主屋根・区画 の3か所');
});

test('【配線】roofSpecTabModel.js は react／store.js／.jsx を静的に import しない（node:test から単体 import 可能に保つ）', () => {
  const code = read('roofSpecTabModel.js');
  assert.ok(!/from '(react|mobx-react-lite|\.\.\/store\.js)'|\.jsx'/.test(code));
});
