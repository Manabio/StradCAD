// 立面図（facade/）の依存の向きの不変条件（elevation/importGraph.test.js と同じ書き方。ソーステキストの静的 import を検査する）。
//   (1) facade/ から elevation/ へ引いてよいのは elevationPrimitives.js・elevationLayout.js・elevationStyle.js の3本だけ。
//   (2) elevation/ は facade/ を引かない（逆向き禁止）。
//   (3) facade/ の製品ファイルから（推移的にも）store.js・snap.js・appViewport.js・storage/・.jsx・react-konva/konva/react を
//       静的に引かない（node:test から単体 import できる純モジュールに保つ）。屋根（S2）の facadeRoof.js が引く
//       structural/roofFramingGeometry.js・finish/roof/roofPlanFigure.js、建具（S3）の facadeOpenings.js が引く
//       openings/openingElevationFigure.js・openings/openingCatalog.js（catalog/ を含む）はこれを満たす。region を作る structural/roofFramingRegions.js は
//       storage/（FloorSwapManager・db）を推移的に引くので facade/ からは引かず、modes/FacadeModeState.js が解決して渡す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const facadeDir = import.meta.dirname;
const srcDir = path.resolve(facadeDir, '..');
const elevDir = path.join(srcDir, 'elevation');
const CORE_FILE = path.join(srcDir, 'core.js');
const norm = p => p.replace(/\\/g, '/');
const rel = p => norm(path.relative(srcDir, p));

const ALLOWED_ELEVATION_TARGETS = new Set(['elevationPrimitives.js', 'elevationLayout.js', 'elevationStyle.js']);
const FORBIDDEN_SRC_FILES = new Set(['store.js', 'snap.js', 'appViewport.js']);
const FORBIDDEN_PACKAGES = new Set(['react-konva', 'konva', 'react', 'react-dom']);
const FORBIDDEN_SRC_DIR = 'storage/'; // IndexedDB（FloorSwapManager・db）。facade/ は永続化を引かない

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

function specifiersOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].map(m => m[1] || m[2]);
}
function relativeImportsOf(file) {
  return specifiersOf(file).filter(s => s.startsWith('.')).map(s => norm(path.resolve(path.dirname(file), s)));
}

const facadeFiles = productFilesUnder(facadeDir);

test('【不変条件】この検査自身が空振りしない（facade/ の製品ファイルと import を読めている）', () => {
  assert.ok(facadeFiles.length >= 5, `製品ファイルが少なすぎる: ${facadeFiles.length}`);
  const fig = relativeImportsOf(path.join(facadeDir, 'facadeFigure.js')).map(rel);
  assert.ok(fig.includes('elevation/elevationPrimitives.js'), 'facadeFigure.js の import を読めていない');
  const layout = specifiersOf(path.join(facadeDir, 'facadeLayout.js'));
  assert.ok(layout.includes('../elevation/elevationLayout.js'), 'export … from を読めていない');
  // コメント行の import は拾わない。
  assert.deepEqual([..."// import { a } from './x.js';\nconst b = 1;".matchAll(IMPORT_RE)].length, 0);
});

test('【不変条件】facade/ から elevation/ へ引くのは elevationPrimitives.js・elevationLayout.js・elevationStyle.js だけ', () => {
  const offenders = [];
  for (const file of facadeFiles) {
    for (const t of relativeImportsOf(file).map(rel)) {
      const m = t.match(/^elevation\/(.+)$/);
      if (m && !ALLOWED_ELEVATION_TARGETS.has(m[1])) offenders.push(`${rel(file)} -> ${t}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('【不変条件】elevation/ は facade/ を引かない', () => {
  const offenders = [];
  for (const file of productFilesUnder(elevDir)) {
    for (const t of relativeImportsOf(file).map(rel)) if (t.startsWith('facade/')) offenders.push(`${rel(file)} -> ${t}`);
  }
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
      let target;
      if (spec === '@core') target = norm(CORE_FILE);
      else if (spec.startsWith('.')) target = norm(path.resolve(path.dirname(file), spec));
      else {
        if (FORBIDDEN_PACKAGES.has(spec)) offenders.push(`${chain} -> ${spec}`);
        continue;
      }
      const r = rel(target);
      if (FORBIDDEN_SRC_FILES.has(r) || r.startsWith(FORBIDDEN_SRC_DIR) || r.endsWith('.jsx')) { offenders.push(`${chain} -> ${r}`); continue; }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) stack.push([target, `${chain} > ${r}`]);
    }
  }
  return { offenders, seen };
}

test('【不変条件】facade/ は推移的にも store.js・snap.js・appViewport.js・storage/・.jsx・react 系を静的に引かない', () => {
  const { offenders, seen } = transitiveOffenders(facadeFiles);
  assert.ok(seen.size > facadeFiles.length, `推移的に辿れていない: ${seen.size}`);
  assert.ok(seen.has(norm(path.join(srcDir, 'structural', 'roofFramingGeometry.js'))), '屋根の幾何（facadeRoof.js の依存）まで辿れていない');
  // 建具（S3）の facadeOpenings.js が引く姿図・カタログ（catalog/ の照合を含む）もこの検査の対象に入っている
  assert.ok(seen.has(norm(path.join(srcDir, 'openings', 'openingElevationFigure.js'))), '建具の姿図（facadeOpenings.js の依存）まで辿れていない');
  assert.ok(seen.has(norm(path.join(srcDir, 'openings', 'openingCatalog.js'))), '建具のカタログ（facadeOpenings.js の依存）まで辿れていない');
  assert.deepEqual(offenders, []);
});

test('【不変条件】検出力: region を作る structural/roofFramingRegions.js を起点にすると storage/ を検出する（facade/ から引けない理由）', () => {
  const { offenders } = transitiveOffenders([norm(path.join(srcDir, 'structural', 'roofFramingRegions.js'))]);
  assert.ok(offenders.some(o => / -> storage\//.test(o)), JSON.stringify(offenders));
});
