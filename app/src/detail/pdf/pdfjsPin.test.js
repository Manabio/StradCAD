// pdfjs-dist の固定版の照合。constants.js の PdfDrawOp は pdfjs の DrawOPS（export されない）を固定版に合わせて写したもの。
// 版を上げたらここが落ちる＝DrawOPS・constructPath の形を確かめ直す合図。ファイルが無ければ skip でなく fail にする。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PdfDrawOp } from '../../core/constants.js';

const PINNED_VERSION = '6.4.299';
const appDir = path.resolve(import.meta.dirname, '..', '..', '..');
// ワークスペース構成では node_modules はリポジトリのルートにある（app/ 直下にあればそちら）。
const pkgDir = [path.join(appDir, 'node_modules', 'pdfjs-dist'), path.join(appDir, '..', 'node_modules', 'pdfjs-dist')]
  .find(d => fs.existsSync(path.join(d, 'package.json')));

// 純モジュールの名前（PdfDrawOp のキー）と pdfjs の DrawOPS のキーの対応。
const NAME_OF = Object.freeze({ moveTo: 'MOVE_TO', lineTo: 'LINE_TO', curveTo: 'CURVE_TO', quadraticCurveTo: 'QUAD_TO', closePath: 'CLOSE' });

test('固定版: app/package.json の pdfjs-dist は 6.4.299 と完全一致（範囲指定にしない）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['pdfjs-dist'], PINNED_VERSION);
});

test('固定版: インストール済みの pdfjs-dist も 6.4.299', () => {
  assert.ok(pkgDir, 'node_modules/pdfjs-dist が見つからない（npm install が要る）');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version, PINNED_VERSION);
});

for (const rel of [['legacy', 'build', 'pdf.mjs'], ['build', 'pdf.mjs']]) {
  test(`固定版: ${rel.join('/')} の DrawOPS が constants.js の PdfDrawOp と一致する`, () => {
    assert.ok(pkgDir, 'node_modules/pdfjs-dist が見つからない（npm install が要る）');
    const file = path.join(pkgDir, ...rel);
    assert.ok(fs.existsSync(file), `${file} が無い`);
    const m = /const DrawOPS = \{([^}]*)\}/.exec(fs.readFileSync(file, 'utf8'));
    assert.ok(m, 'const DrawOPS = {…} を読み取れない（pdfjs の内部構造が変わった）');
    const actual = Object.fromEntries([...m[1].matchAll(/(\w+):\s*(\d+)/g)].map(([, k, v]) => [NAME_OF[k] ?? k, Number(v)]));
    assert.deepEqual(actual, { ...PdfDrawOp });
  });
}

// class 宣言の本文（次の行頭の class まで）。コメント中の語に当たらないよう、行頭の宣言だけを起点にする。
const classBody = (src, name) => {
  const start = src.search(new RegExp(`^class ${name}\\b`, 'm'));
  if (start < 0) return null;
  const next = src.indexOf('\nclass ', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};

for (const rel of [['legacy', 'build', 'pdf.mjs'], ['build', 'pdf.mjs']]) {
  test(`固定版: ${rel.join('/')} の破棄は loadingTask.destroy()（PDFDocumentProxy に destroy は無い）`, () => {
    assert.ok(pkgDir, 'node_modules/pdfjs-dist が見つからない（npm install が要る）');
    const src = fs.readFileSync(path.join(pkgDir, ...rel), 'utf8');
    const proxy = classBody(src, 'PDFDocumentProxy');
    const task = classBody(src, 'PDFDocumentLoadingTask');
    assert.ok(proxy && task, 'class PDFDocumentProxy／PDFDocumentLoadingTask を読み取れない（pdfjs の内部構造が変わった）');
    assert.match(proxy, /^\s*get loadingTask\(\) \{/m);
    assert.match(task, /^\s*async destroy\(\) \{/m);
    assert.doesNotMatch(proxy, /^\s*(async )?destroy\(\) \{/m);
  });
}

test('検出力: class 本文の切り出しは次の class までで止まり、get loadingTask が無ければ不一致', () => {
  const src = 'class A {\n  get loadingTask() {}\n}\nclass B {\n  async destroy() {}\n}\n';
  assert.match(classBody(src, 'A'), /^\s*get loadingTask\(\) \{/m);
  assert.doesNotMatch(classBody(src, 'A'), /async destroy/);
  assert.doesNotMatch(classBody(src.replace('get loadingTask', 'get other'), 'A'), /^\s*get loadingTask\(\) \{/m);
});

test('検出力: 読み取りの正規表現は DrawOPS の本文を拾い、値が違えば不一致になる', () => {
  const m = /const DrawOPS = \{([^}]*)\}/.exec('const DrawOPS = {\n  moveTo: 0,\n  lineTo: 2\n};');
  const actual = Object.fromEntries([...m[1].matchAll(/(\w+):\s*(\d+)/g)].map(([, k, v]) => [NAME_OF[k] ?? k, Number(v)]));
  assert.deepEqual(actual, { MOVE_TO: 0, LINE_TO: 2 });
  assert.notDeepEqual(actual, { MOVE_TO: 0, LINE_TO: PdfDrawOp.LINE_TO });
});
