// 天伏（ceiling/）の依存の向きの不変条件（部分詳細図 8b-4c）。
//   (1) ceiling/ の製品ファイルは detail/ を直接引かない（部分詳細図は finish/partDetail.js 経由。静的・再輸出・動的とも）。
//   (2) ceilingStepDetailLines.js は store.js・snap.js・.jsx を直接引かず、node:test から単体 import できる。
// elevation/importGraph.test.js と同じ書き方（ソーステキストを正規表現で検査する不変条件テスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ceilingDir = import.meta.dirname;
const srcDir = path.resolve(ceilingDir, '..');
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

const productFiles = fs.readdirSync(ceilingDir)
  .filter(n => /\.(js|jsx)$/.test(n) && !/\.test\.js$/.test(n))
  .map(n => path.join(ceilingDir, n));
const importsOf = file => importTargetsOf(rel(file), fs.readFileSync(file, 'utf8'));

test('【不変条件】この検査自身が空振りしない（ceiling/ の製品ファイルと import を実際に読めている）', () => {
  assert.ok(productFiles.length > 20, `製品ファイルが少なすぎる: ${productFiles.length}`);
  const detailLines = importsOf(path.join(ceilingDir, 'ceilingStepDetailLines.js'));
  assert.ok(detailLines.includes('finish/partDetail.js'), 'ceilingStepDetailLines.js の import を読めていない');
  assert.ok(detailLines.includes('ceiling/ceilingSurfaces.js'));
  // 動的 import・再輸出・1 行に 2 つの import も拾う
  assert.deepEqual(importTargetsOf('ceiling/x.js', "const m = await import('../detail/detailPen.js');"), ['detail/detailPen.js']);
  assert.deepEqual(importTargetsOf('ceiling/x.js', "export { a } from '../detail/detailModel.js';"), ['detail/detailModel.js']);
  assert.deepEqual(importTargetsOf('ceiling/x.js', "import { a } from './y.js';import { b } from '../detail/z.js';"), ['ceiling/y.js', 'detail/z.js']);
});

test('【不変条件】ceiling/ の製品ファイルは detail/ を直接引かない（finish/partDetail.js 経由）', () => {
  const offenders = productFiles.flatMap(f => importsOf(f).filter(t => t.startsWith('detail/')).map(t => `${rel(f)} -> ${t}`));
  assert.deepEqual(offenders, []);
});

test('【不変条件】ceilingStepDetailLines.js は store.js・snap.js・.jsx を直接引かず、単体で import できる', async () => {
  const targets = importsOf(path.join(ceilingDir, 'ceilingStepDetailLines.js'));
  assert.deepEqual(targets.filter(t => /(^|\/)(store|snap)(\.js)?$/.test(t) || t.endsWith('.jsx')), []);
  const mod = await import('./ceilingStepDetailLines.js');
  assert.equal(typeof mod.ceilingStepDetailSpecs, 'function');
});
