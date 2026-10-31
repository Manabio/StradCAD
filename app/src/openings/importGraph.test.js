// 建具（openings/）から部分詳細図（detail/）への依存の向きの不変条件（facade/importGraph.test.js と同じ書き方。ソーステキストの静的 import を検査する）。
//   (1) openings/ の製品ファイルが detail/ から引いてよいのは detailPlacement.js だけ（反映の唯一の口。部分詳細図 S3）。
//   (2) 逆向き（detail/ が openings/ を引く）は detail/importGraph.test.js が禁止している。
// 製品ファイルとは *.test.js 以外の .js（テスト部品 *TestFixtures.js は製品ではないので対象外）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const openingsDir = import.meta.dirname;
const srcDir = path.resolve(openingsDir, '..');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const ALLOWED_DETAIL_TARGETS = new Set(['detail/detailPlacement.js']);

function productFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...productFilesUnder(p));
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && !e.name.endsWith('TestFixtures.js')) out.push(norm(p));
  }
  return out;
}

// 行頭が import/export の静的 import だけを拾う（コメント中の言及・動的 import(...) は含まない）。
const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
const specifiersOfSource = src => [...src.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
const specifiersOf = file => specifiersOfSource(fs.readFileSync(file, 'utf8'));

// 動的 import も含めて detail/ へ向かう指定子を返す（静的だけを検査すると遅延読込みで抜け道になる）。
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const dynamicSpecifiersOfSource = src => [...src.matchAll(DYNAMIC_IMPORT_RE)].map(m => m[1]);

// relFile（src からの相対パス）のソースが detail/ の許可外を引く指定子（静的・動的）を返す。
function detailOffenders(relFile, srcText) {
  const offenders = [];
  for (const spec of [...specifiersOfSource(srcText), ...dynamicSpecifiersOfSource(srcText)]) {
    if (!spec.startsWith('.')) continue;
    const target = norm(path.relative(srcDir, path.resolve(srcDir, path.dirname(relFile), spec)));
    if (target.startsWith('detail/') && !ALLOWED_DETAIL_TARGETS.has(target)) offenders.push(`${relFile} -> ${target}`);
  }
  return offenders;
}

const openingFiles = productFilesUnder(openingsDir);

test('【不変条件】この検査自身が空振りしない（openings/ の製品ファイルと import を読めている）', () => {
  assert.ok(openingFiles.length >= 10, `製品ファイルが少なすぎる: ${openingFiles.length}`);
  assert.ok(!openingFiles.some(f => f.endsWith('.test.js') || f.endsWith('TestFixtures.js')), 'テストファイルを製品として数えている');
  assert.ok(specifiersOf(path.join(openingsDir, 'openingCatalog.js')).includes('../detail/detailPlacement.js'), 'openingCatalog.js の import を読めていない');
  assert.ok(specifiersOf(path.join(openingsDir, 'openingDetailFrame.js')).includes('../detail/detailPlacement.js'), 'openingDetailFrame.js の import を読めていない');
  assert.equal([..."// import { a } from '../detail/x.js';\nconst b = 1;".matchAll(IMPORT_RE)].length, 0);
});

test('【不変条件】openings/ が引く detail/ のファイルは detailPlacement.js だけ', () => {
  const offenders = openingFiles.flatMap(f => detailOffenders(rel(f), fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
  // 実際に引いているファイルの集合も固定する（使われなくなった許可を放置しない）
  const used = new Set(openingFiles.flatMap(f => specifiersOf(f)
    .filter(s => s.startsWith('.'))
    .map(s => norm(path.relative(srcDir, path.resolve(path.dirname(f), s))))
    .filter(t => t.startsWith('detail/'))));
  assert.deepEqual([...used].sort(), [...ALLOWED_DETAIL_TARGETS]);
});

test('【不変条件】検出力: detailPlacement.js 以外の detail/ を引くソース文字列（静的・再輸出・動的）は offenders に出る', () => {
  const bad = [
    "import { x } from '../detail/detailFit.js';",
    "import { x } from '../detail/detailModel.js';",
    "import { x } from '../detail/detailPen.js';",
    "import { x } from '../detail/detailPreview.js';",
    "import { x } from '../detail/detailBuiltins.js';",
    "export { x } from '../detail/detailFit.js';",
    "import '../detail/detailFit.js';",
    "const m = await import('../detail/detailFit.js');",
  ];
  for (const src of bad) {
    assert.ok(detailOffenders('openings/openingCatalog.js', src).length > 0, `検出できない: ${src}`);
  }
  // 許可される import は通る（detailPlacement.js・detail/ 以外）
  assert.deepEqual(detailOffenders('openings/openingCatalog.js',
    "import { fitLocal } from '../detail/detailPlacement.js';\nimport { A } from '../core/constants.js';\nimport { b } from './openingDetailFrame.js';"), []);
});
