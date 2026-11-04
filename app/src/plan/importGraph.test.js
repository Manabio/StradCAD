// 平面の断面解決（plan/）の依存の向きの不変条件（部分詳細図 8b-4c C2）。
//   plan/ の製品ファイルは detail/ も finish/partDetail.js も直接引かない（部分詳細図はデータ＝ceilingStepDetail として受け取るだけ。
//   見切りの線の材料の算出は ceiling/ceilingStepDetailLines.js、材マスタの配線は renderer 側）。静的・再輸出・動的とも。
// ceiling/importGraph.test.js と同じ書き方（ソーステキストを正規表現で検査する不変条件テスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const planDir = import.meta.dirname;
const srcDir = path.resolve(planDir, '..');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** relFile（src からの相対パス）のソースが引く相対指定子を src からの相対パスにして返す（静的・再輸出・動的）。 */
function importTargetsOf(relFile, srcText) {
  const specs = [...srcText.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
  for (const m of srcText.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
  return specs.filter(s => s.startsWith('.')).map(s => norm(path.relative(srcDir, path.resolve(srcDir, path.dirname(relFile), s))));
}

const productFiles = fs.readdirSync(planDir)
  .filter(n => /\.(js|jsx)$/.test(n) && !/\.test\.js$/.test(n))
  .map(n => path.join(planDir, n));
const importsOf = file => importTargetsOf(rel(file), fs.readFileSync(file, 'utf8'));

test('【不変条件】この検査自身が空振りしない（plan/ の製品ファイルと import を実際に読めている）', () => {
  assert.ok(productFiles.length >= 8, `製品ファイルが少なすぎる: ${productFiles.length}`);
  const filter = importsOf(path.join(planDir, 'planSolidsLayerFilter.js'));
  assert.ok(filter.includes('ceiling/ceilingStepDetailLines.js'), 'planSolidsLayerFilter.js の import を読めていない');
  assert.ok(filter.includes('plan/planSolids.js'));
  // 動的 import・再輸出・1 行に 2 つの import も拾う
  assert.deepEqual(importTargetsOf('plan/x.js', "const m = await import('../detail/detailPen.js');"), ['detail/detailPen.js']);
  assert.deepEqual(importTargetsOf('plan/x.js', "export { a } from '../finish/partDetail.js';"), ['finish/partDetail.js']);
  assert.deepEqual(importTargetsOf('plan/x.js', "import { a } from './y.js';import { b } from '../detail/z.js';"), ['plan/y.js', 'detail/z.js']);
});

test('【不変条件】plan/ の製品ファイルは detail/ も finish/partDetail.js も直接引かない', () => {
  const offenders = productFiles.flatMap(f => importsOf(f)
    .filter(t => t.startsWith('detail/') || t === 'finish/partDetail.js')
    .map(t => `${rel(f)} -> ${t}`));
  assert.deepEqual(offenders, []);
});

test('【不変条件】planSolidsLayerFilter.js・planSolids.js は store.js・snap.js・.jsx を直接引かず、単体で import できる', async () => {
  for (const name of ['planSolidsLayerFilter.js', 'planSolids.js']) {
    const targets = importsOf(path.join(planDir, name));
    assert.deepEqual(targets.filter(t => /(^|\/)(store|snap)(\.js)?$/.test(t) || t.endsWith('.jsx')), [], name);
  }
  const mod = await import('./planSolidsLayerFilter.js');
  assert.equal(typeof mod.planSolidsLayerPrimitivesUp, 'function');
});
