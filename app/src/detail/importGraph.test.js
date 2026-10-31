// 部分詳細図（detail/）の依存の向きの不変条件（facade/importGraph.test.js と同じ書き方。ソーステキストの静的 import を検査する）。
//   (1) detail/ の製品ファイルが引ける src 内のモジュールは core/constants.js と
//       structural/sectionFigure/svgFigurePrimitives.js（detailPreview.js だけ）。それ以外のディレクトリ
//       （elevation/・facade/・plan/・ceiling/・finish/・openings/・catalog/・structural/ ほか）は引かない。
//   (2) 推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない
//       （node:test から単体 import できる純モジュールに保つ）。
//   (3) detailModel.js の import は ../core/constants.js だけ（catalog/ が引ける葉。catalog/catalogImports.test.js でも固定）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const detailDir = import.meta.dirname;
const srcDir = path.resolve(detailDir, '..');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const FORBIDDEN_SRC_FILES = new Set(['store.js', 'snap.js', 'appViewport.js']);
const FORBIDDEN_PACKAGES = new Set(['react-konva', 'konva', 'react', 'react-dom']);
const FORBIDDEN_SRC_DIRS = ['storage/', 'elevation/', 'facade/', 'plan/', 'ceiling/', 'finish/', 'openings/', 'catalog/', 'structural/'];
const ALLOWED_OUTSIDE = new Map([
  ['core/constants.js', null],                                                       // null = どのファイルからでも可
  ['structural/sectionFigure/svgFigurePrimitives.js', new Set(['detail/detailPreview.js'])],
]);

function productFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...productFilesUnder(p));
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(norm(p));
  }
  return out;
}

// 行頭が import/export の静的 import だけを拾う（コメント中の言及・動的 import(...) は含まない）。
const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
const specifiersOfSource = src => [...src.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
const specifiersOf = file => specifiersOfSource(fs.readFileSync(file, 'utf8'));

const detailFiles = productFilesUnder(detailDir);

// 直接 import の違反を返す。srcText とその「自分の位置（src からの相対パス）」を渡す（検出力テストで文字列を渡すため）。
function directOffenders(relFile, srcText) {
  const offenders = [];
  for (const spec of specifiersOfSource(srcText)) {
    if (!spec.startsWith('.')) {
      if (FORBIDDEN_PACKAGES.has(spec)) offenders.push(`${relFile} -> ${spec}`);
      continue;
    }
    const target = norm(path.relative(srcDir, path.resolve(srcDir, path.dirname(relFile), spec)));
    if (target.startsWith('detail/')) continue; // detail/ 内の兄弟
    if (target.endsWith('.jsx') || FORBIDDEN_SRC_FILES.has(target) || FORBIDDEN_SRC_DIRS.some(d => target.startsWith(d))) {
      if (!ALLOWED_OUTSIDE.has(target)) { offenders.push(`${relFile} -> ${target}`); continue; }
    }
    // 許可表に無い外部は、禁止リストの該当有無にかかわらず違反（リストは理由の明示。許可表が唯一の通り道）。
    const allowed = ALLOWED_OUTSIDE.get(target);
    // 許可表に載る例外（structural/ 配下の svgFigurePrimitives.js だけ）は禁止ディレクトリにあっても通す。
    if (allowed !== undefined && (allowed === null || allowed.has(relFile))) continue;
    offenders.push(`${relFile} -> ${target}`);
  }
  return offenders;
}

test('【不変条件】この検査自身が空振りしない（detail/ の製品ファイルと import を読めている）', () => {
  assert.ok(detailFiles.length >= 6, `製品ファイルが少なすぎる: ${detailFiles.length}`);
  assert.ok(specifiersOf(path.join(detailDir, 'detailPreview.js')).includes('../structural/sectionFigure/svgFigurePrimitives.js'), 'detailPreview.js の import を読めていない');
  assert.ok(specifiersOf(path.join(detailDir, 'detailPlacement.js')).includes('./detailFit.js'), 'detailPlacement.js の import を読めていない');
  assert.equal([..."// import { a } from './x.js';\nconst b = 1;".matchAll(IMPORT_RE)].length, 0);
});

test('【不変条件】detail/ が引く src 内の外部モジュールは core/constants.js と（detailPreview.js だけ）svgFigurePrimitives.js だけ', () => {
  const offenders = detailFiles.flatMap(f => directOffenders(rel(f), fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

// startFiles から静的 import を推移的に辿り、禁止先へ届く鎖と辿ったファイルの集合を返す。
function transitiveOffenders(startFiles) {
  const offenders = [];
  const seen = new Set();
  const stack = startFiles.map(f => [f, rel(f)]);
  while (stack.length) {
    const [file, chain] = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (!spec.startsWith('.')) {
        if (FORBIDDEN_PACKAGES.has(spec)) offenders.push(`${chain} -> ${spec}`);
        continue;
      }
      const target = norm(path.resolve(path.dirname(file), spec));
      const r = rel(target);
      if (FORBIDDEN_SRC_FILES.has(r) || r.startsWith('storage/') || r.endsWith('.jsx')) { offenders.push(`${chain} -> ${r}`); continue; }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) stack.push([target, `${chain} > ${r}`]);
    }
  }
  return { offenders, seen };
}

test('【不変条件】detail/ は推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const { offenders, seen } = transitiveOffenders(detailFiles);
  assert.ok(seen.size > detailFiles.length, `推移的に辿れていない: ${seen.size}`);
  assert.ok(seen.has(norm(path.join(srcDir, 'structural', 'sectionFigure', 'svgFigurePrimitives.js'))), 'svgFigurePrimitives.js まで辿れていない');
  assert.deepEqual(offenders, []);
});

test('【不変条件】detailModel.js の静的 import は ../core/constants.js だけ', () => {
  assert.deepEqual(specifiersOf(path.join(detailDir, 'detailModel.js')), ['../core/constants.js']);
  assert.ok(!/\bimport\s*\(/.test(fs.readFileSync(path.join(detailDir, 'detailModel.js'), 'utf8')), '動的 import も持たない');
});

test('【不変条件】検出力: 禁止先を引くソース文字列は offenders に出る', () => {
  const bad = [
    "import { x } from '../store.js';",
    "import { x } from '../snap.js';",
    "import { x } from '../appViewport.js';",
    "import { x } from '../storage/db.js';",
    "import { x } from '../ui/Panel.jsx';",
    "import React from 'react';",
    "import { Layer } from 'react-konva';",
    "import Konva from 'konva';",
    "import { x } from '../elevation/elevationStyle.js';",
    "import { x } from '../facade/facadeStyle.js';",
    "import { x } from '../plan/planSectionFigure.js';",
    "import { x } from '../ceiling/ceilingStyle.js';",
    "import { x } from '../finish/roomMetrics.js';",
    "import { x } from '../openings/openingCatalog.js';",
    "import { x } from '../catalog/catalogKinds.js';",
    "import { x } from '../structural/sectionCatalog.js';",
    "export { x } from '../elevation/elevationStyle.js';",
  ];
  for (const src of bad) {
    assert.ok(directOffenders('detail/detailFit.js', src).length > 0, `検出できない: ${src}`);
  }
  // svgFigurePrimitives.js は detailPreview.js 以外から引くと違反
  const prim = "import { dim } from '../structural/sectionFigure/svgFigurePrimitives.js';";
  assert.equal(directOffenders('detail/detailPreview.js', prim).length, 0);
  assert.equal(directOffenders('detail/detailFit.js', prim).length, 1);
  // 許可される import は通る
  assert.deepEqual(directOffenders('detail/detailFit.js', "import { A } from '../core/constants.js';\nimport { b } from './detailPen.js';"), []);
});

test('【不変条件】検出力: 推移的検査は storage/ へ届く鎖を検出する（structural/roofFramingRegions.js を起点にする）', () => {
  const { offenders } = transitiveOffenders([norm(path.join(srcDir, 'structural', 'roofFramingRegions.js'))]);
  assert.ok(offenders.some(o => / -> storage\//.test(o)), JSON.stringify(offenders));
});
