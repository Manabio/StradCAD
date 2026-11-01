// ヘルパー画面の純ロジック（ui/detailHelperForm.js）の依存の向きの不変条件（detail/importGraph.test.js と同じ書き方）。
//   (1) 直接の import 先は許可表の内側だけ（core/constants・detail/・catalog/catalogKinds・catalog/catalogMaintenance・
//       openings/openingCatalog・openings/openingDetailFrame・ui/numpadUtils・structural/sectionFigure/svgFigurePrimitives）。
//   (2) 推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない（node:test から単体 import できる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '..');
const target = path.join(srcDir, 'ui', 'detailHelperForm.js');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const FORBIDDEN_SRC_FILES = new Set(['store.js', 'snap.js', 'appViewport.js']);
const FORBIDDEN_PACKAGES = new Set(['react-konva', 'konva', 'react', 'react-dom']);
const ALLOWED_DIRECT = new Set([
  'core/constants.js',
  'detail/detailModel.js', 'detail/detailPreview.js', 'detail/detailPlacement.js',
  'detail/dxf/dxfImport.js', 'detail/dxf/dxfProvenance.js', 'error.js',
  'catalog/catalogKinds.js', 'catalog/catalogMaintenance.js',
  'openings/openingCatalog.js', 'openings/openingDetailFrame.js',
  'ui/numpadUtils.js',
  'structural/sectionFigure/svgFigurePrimitives.js',
]);

const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
const specifiersOfSource = src => [...src.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
const specifiersOf = file => specifiersOfSource(fs.readFileSync(file, 'utf8'));

// 直接 import の違反（許可表に無い相対 import・禁止パッケージ）。srcText と自分の位置（src からの相対）を渡す。
function directOffenders(relFile, srcText) {
  const offenders = [];
  for (const spec of specifiersOfSource(srcText)) {
    if (!spec.startsWith('.')) {
      if (FORBIDDEN_PACKAGES.has(spec)) offenders.push(`${relFile} -> ${spec}`);
      continue;
    }
    const t = norm(path.relative(srcDir, path.resolve(srcDir, path.dirname(relFile), spec)));
    if (!ALLOWED_DIRECT.has(t)) offenders.push(`${relFile} -> ${t}`);
  }
  return offenders;
}

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
      const t = norm(path.resolve(path.dirname(file), spec));
      const r = rel(t);
      if (FORBIDDEN_SRC_FILES.has(r) || r.startsWith('storage/') || r.endsWith('.jsx')) { offenders.push(`${chain} -> ${r}`); continue; }
      if (fs.existsSync(t) && fs.statSync(t).isFile()) stack.push([t, `${chain} > ${r}`]);
    }
  }
  return { offenders, seen };
}

test('【不変条件】検査自身が空振りしない（detailHelperForm.js の import を読めている）', () => {
  const specs = specifiersOf(target);
  assert.ok(specs.includes('../detail/detailPlacement.js'), JSON.stringify(specs));
  assert.ok(specs.includes('../openings/openingCatalog.js'), JSON.stringify(specs));
  assert.equal([..."// import { a } from './x.js';\nconst b = 1;".matchAll(IMPORT_RE)].length, 0);
});

test('【不変条件】detailHelperForm.js の直接 import は許可表の内側だけ', () => {
  assert.deepEqual(directOffenders('ui/detailHelperForm.js', fs.readFileSync(target, 'utf8')), []);
});

test('【不変条件】detailHelperForm.js は推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const { offenders, seen } = transitiveOffenders([target]);
  assert.ok(seen.size > 10, `推移的に辿れていない: ${seen.size}`);
  assert.ok(seen.has(norm(path.join(srcDir, 'openings', 'openingCatalog.js'))), 'openingCatalog.js まで辿れていない');
  assert.deepEqual(offenders, []);
});

test('【不変条件】検出力: 禁止先・許可表の外を引くソース文字列は offenders に出る', () => {
  const bad = [
    "import { x } from '../store.js';",
    "import { x } from '../snap.js';",
    "import { x } from '../storage/db.js';",
    "import { x } from './Panel.jsx';",
    "import React from 'react';",
    "import { x } from '../elevation/elevationStyle.js';",
  ];
  for (const src of bad) assert.ok(directOffenders('ui/detailHelperForm.js', src).length > 0, `検出できない: ${src}`);
  assert.deepEqual(directOffenders('ui/detailHelperForm.js', "import { A } from '../core/constants.js';"), []);
});

test('【不変条件】検出力: 推移的検査は storage/ へ届く鎖を検出する（structural/roofFramingRegions.js を起点にする）', () => {
  const { offenders } = transitiveOffenders([norm(path.join(srcDir, 'structural', 'roofFramingRegions.js'))]);
  assert.ok(offenders.some(o => / -> storage\//.test(o)), JSON.stringify(offenders));
});
