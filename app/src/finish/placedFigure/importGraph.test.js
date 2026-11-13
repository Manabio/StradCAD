// 姿図の配置の基準供給（finish/placedFigure/placedFigureTargets.js）の依存の向きの不変条件。
//   (1) 直接の import 先は許可表の内側だけ（core/constants・error・detail/detailModel・finish/roomDetailTargets）。
//   (2) 推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない（node:test から単体 import できる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(import.meta.dirname, '..', '..');
const target = path.join(srcDir, 'finish', 'placedFigure', 'placedFigureTargets.js');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const FORBIDDEN_SRC_FILES = new Set(['store.js', 'snap.js', 'appViewport.js']);
const FORBIDDEN_PACKAGES = new Set(['react-konva', 'konva', 'react', 'react-dom']);
const ALLOWED_DIRECT = new Set(['core/constants.js', 'error.js', 'detail/detailModel.js', 'finish/roomDetailTargets.js']);

const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;
const specifiersOfSource = src => [...src.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
const specifiersOf = file => specifiersOfSource(fs.readFileSync(file, 'utf8'));

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

function transitiveOffenders(startFile) {
  const offenders = [];
  const seen = new Set();
  const stack = [[startFile, rel(startFile)]];
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

test('【不変条件】検査自身が空振りしない（placedFigureTargets.js の import を読めている）', () => {
  const specs = specifiersOf(target);
  assert.ok(specs.includes('../../detail/detailModel.js'), JSON.stringify(specs));
  assert.equal([..."// import { a } from './x.js';\nconst b = 1;".matchAll(IMPORT_RE)].length, 0);
});

test('【不変条件】placedFigureTargets.js の直接 import は許可表の内側だけ', () => {
  assert.deepEqual(directOffenders('finish/placedFigure/placedFigureTargets.js', fs.readFileSync(target, 'utf8')), []);
});

test('【不変条件】placedFigureTargets.js は推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const { offenders, seen } = transitiveOffenders(target);
  assert.ok(seen.has(norm(path.join(srcDir, 'finish', 'roomDetailTargets.js'))), 'roomDetailTargets.js まで辿れていない');
  assert.deepEqual(offenders, []);
});

test('【不変条件】placedFigureFitCheck.js は直接 import が許可表の内側で、推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const fitCheck = path.join(srcDir, 'finish', 'placedFigure', 'placedFigureFitCheck.js');
  const allowed = new Set([
    'core/constants.js', 'error.js', 'detail/detailModel.js', 'detail/detailPlacement.js', 'openings/openingCatalog.js',
    'finish/placedFigure/placedFigureTargets.js',
  ]);
  const direct = specifiersOf(fitCheck).map(spec => norm(path.relative(srcDir, path.resolve(path.dirname(fitCheck), spec))));
  assert.ok(direct.length > 0);
  assert.deepEqual(direct.filter(t => !allowed.has(t)), []);
  assert.deepEqual(transitiveOffenders(fitCheck).offenders, []);
});

test('【不変条件】placedFigureViews.js は直接 import が許可表の内側で、推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const views = path.join(srcDir, 'finish', 'placedFigure', 'placedFigureViews.js');
  const allowed = new Set(['core/constants.js', 'detail/detailPlacement.js', 'finish/placedFigure/placedFigureTargets.js']);
  const direct = specifiersOf(views).map(spec => norm(path.relative(srcDir, path.resolve(path.dirname(views), spec))));
  assert.ok(direct.length > 0);
  assert.deepEqual(direct.filter(t => !allowed.has(t)), []);
  assert.deepEqual(transitiveOffenders(views).offenders, []);
});

test('【不変条件】図面モードのパネルの純モジュール（placedFigureModePanelRows.js・placedFigureRooms.js）は直接 import が許可表の内側で、推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const cases = [
    ['placedFigureModePanelRows.js', ['core/constants.js', 'detail/detailModel.js', 'error.js', 'catalog/catalogMaintenance.js']],
    ['placedFigureRooms.js', ['finish/edgeClassify.js', 'finish/gridCells.js', 'finish/interiorTabRooms.js']],
  ];
  for (const [name, allowedList] of cases) {
    const file = path.join(srcDir, 'finish', 'placedFigure', name);
    const direct = specifiersOf(file).filter(spec => spec.startsWith('.')).map(spec => norm(path.relative(srcDir, path.resolve(path.dirname(file), spec))));
    assert.ok(direct.length > 0, `${name} の import を読めていない`);
    assert.deepEqual(direct.filter(t => !allowedList.includes(t)), [], name);
    const { offenders, seen } = transitiveOffenders(file);
    assert.ok(seen.size > 1, `${name} から先を辿れていない`);
    assert.deepEqual(offenders, [], name);
  }
});

test('【不変条件】検出力: 禁止先・許可表の外を引くソース文字列は offenders に出る', () => {
  const bad = [
    "import { x } from '../../store.js';",
    "import { x } from '../../snap.js';",
    "import { x } from '../../storage/db.js';",
    "import { x } from '../../ui/Panel.jsx';",
    "import React from 'react';",
    "import { x } from '../../elevation/elevationStyle.js';",
  ];
  for (const src of bad) assert.ok(directOffenders('finish/placedFigure/placedFigureTargets.js', src).length > 0, `検出できない: ${src}`);
  assert.deepEqual(directOffenders('finish/placedFigure/placedFigureTargets.js', "import { A } from '../../core/constants.js';"), []);
});
