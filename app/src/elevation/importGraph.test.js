// 展開図の依存の向きの不変条件（展開図リファクタ S1）。
// 帯ビルダー（elevationBand/Stair/Void/StairSequence）→ 面の体裁（elevationFigure 等）→ 断面エンジン（section/）
// → 空間索引（space/）→ 補助（elevationStyle/elevationPrimitives）の一方向を、ソーステキストの静的 import で固定する。
//   (1) section/・space/ から親ディレクトリ（elevation/ 直下）へ引いてよいのは elevationStyle.js・elevationPrimitives.js だけ。
//   (2) elevation/ 内（テスト除く）に import の循環が無い。
//   (3) plan/planSolids.js が elevation/section/ を引かない（平面の立体モデルが展開図エンジンの内部に依存しない）。
// catalog/catalogImports.test.js と同じ書き方（ソーステキストを正規表現で検査する不変条件テスト）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const elevDir = import.meta.dirname;
const srcDir = path.resolve(elevDir, '..');
const norm = p => p.replace(/\\/g, '/');

// (1) section/・space/ → 親（elevation/ 直下）で許す相手（定数・変換の語彙）。
const ALLOWED_PARENT_TARGETS = new Set(['elevationStyle.js', 'elevationPrimitives.js']);

function productFilesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...productFilesUnder(p));
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(norm(p));
  }
  return out;
}

// 静的 import / `export … from`（複数行可）と副作用のみの `import '…'`。行頭が import/export のものだけを拾うため、
// コメント中の言及・動的 import(...) は含まない。
// 行頭は `;` の直後（1 行に import を 2 つ並べた形）も許す。
const IMPORT_RE = /(?:^|[\n;])[ \t]*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|[\n;])[ \t]*import\s+['"]([^'"]+)['"]/g;

/** ファイルの相対 import 先を絶対パス（スラッシュ区切り）で返す。'@core' 等のエイリアス・パッケージは除く。 */
function relativeImportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (spec.startsWith('.')) out.push(norm(path.resolve(path.dirname(file), spec)));
  }
  return out;
}

const elevFiles = productFilesUnder(elevDir);
const rel = p => norm(path.relative(srcDir, p));

test('【不変条件】この検査自身が空振りしない（elevation/ の製品ファイルと import を実際に読めている）', () => {
  assert.ok(elevFiles.length > 30, `製品ファイルが少なすぎる: ${elevFiles.length}`);
  const edges = elevFiles.reduce((n, f) => n + relativeImportsOf(f).length, 0);
  assert.ok(edges > 100, `import が少なすぎる: ${edges}`);
  // 既知の辺（複数行 import・export … from の両方）を読めていること。
  const sectionStair = relativeImportsOf(path.join(elevDir, 'section', 'sectionStair.js')).map(rel);
  assert.ok(sectionStair.includes('elevation/section/stairSectionProfile.js'), '複数行 import を読めていない');
  const faces = relativeImportsOf(path.join(elevDir, 'elevationFaces.js')).map(rel);
  assert.ok(faces.includes('elevation/section/faceGeometry.js'));
  // (a) 1 行に import が 2 つ並んでも 2 件拾う。
  const sameLine = "import { a } from './x.js';import { b } from '../elevation/section/y.js';";
  assert.deepEqual([...sameLine.matchAll(IMPORT_RE)].map(m => m[1] || m[2]), ['./x.js', '../elevation/section/y.js']);
  // (b) 実ファイル plan/planSolids.js の import（柱包み finish/columnWrap.js を含む）を読めている。
  const planSolids = relativeImportsOf(path.join(srcDir, 'plan', 'planSolids.js')).map(rel);
  assert.ok(planSolids.includes('finish/columnWrap.js'), 'planSolids.js の import を読めていない');
});

test('【不変条件】section/・space/ から親ディレクトリ（elevation/ 直下）へ引くのは elevationStyle.js・elevationPrimitives.js だけ', () => {
  const offenders = [];
  for (const file of elevFiles) {
    const r = rel(file);
    if (!/^elevation\/(section|space)\//.test(r)) continue;
    for (const target of relativeImportsOf(file)) {
      const t = rel(target);
      const m = t.match(/^elevation\/([^/]+\.js)$/); // elevation/ 直下のファイル
      if (m && !ALLOWED_PARENT_TARGETS.has(m[1])) offenders.push(`${r} -> ${t}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('【不変条件】space/ は section/ を引かない（空間索引が断面エンジンへ逆向きに依存しない）', () => {
  const offenders = [];
  for (const file of elevFiles) {
    const r = rel(file);
    if (!/^elevation\/space\//.test(r)) continue;
    for (const target of relativeImportsOf(file)) {
      if (/^elevation\/section\//.test(rel(target))) offenders.push(`${r} -> ${rel(target)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('【不変条件】elevation/ 内（テスト除く）に import の循環が無い', () => {
  const fileSet = new Set(elevFiles);
  // 拡張子付きで解決できる相手だけを辺にする（ディレクトリ・外部は対象外）。
  const graph = new Map(elevFiles.map(f => [f, relativeImportsOf(f).filter(t => fileSet.has(t))]));
  const state = new Map(); // 1=探索中 2=完了
  const cycles = [];
  const dfs = (node, stack) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node)) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].map(rel).join(' > '));
      else if (!state.get(next)) dfs(next, stack);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const f of elevFiles) if (!state.get(f)) dfs(f, []);
  assert.deepEqual(cycles, []);
});

test('【不変条件】plan/planSolids.js は elevation/section/ を引かない', () => {
  const targets = relativeImportsOf(path.join(srcDir, 'plan', 'planSolids.js')).map(rel);
  assert.deepEqual(targets.filter(t => t.startsWith('elevation/section/')), []);
});
