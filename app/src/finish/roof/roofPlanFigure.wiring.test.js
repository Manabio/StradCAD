// 下屋の平面図形（finish/roof/roofPlanFigure.js）が純モジュールのままであることと、傾斜ラベルの作り方を、
// ソーステキスト検査で固定する（旧 RoofPlanLayer.wiring.test.js のうち、レイヤに依らない2件を S5b で引き継いだ）。
// コメント行・ブロックコメントを除いた本体に対し、m フラグの行頭・行末アンカーで1行まるごと照合する
// （行末コメントで式を無効化する変異を検出するため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}
const figure = stripComments(fs.readFileSync(path.resolve(import.meta.dirname, 'roofPlanFigure.js'), 'utf8'));
const count = (text, re) => (text.match(re) || []).length;

test('【不変条件】roofPlanFigure.js（純モジュール）は store.js・snap.js・.jsx・react-konva・graphDerived・壁の読み取りを import しない', () => {
  const imports = figure.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.ok(imports.length >= 3, `import 行が読めている: ${imports.length}`);
  for (const line of imports) {
    assert.ok(!/store\.js|snap\.js|\.jsx|react-konva|graphDerived|mobx|wallFaces|roofPlanWallTrim/.test(line), `禁止の import: ${line}`);
  }
});

test('【配線】roofPlanRegionFigure は水下ごとの基準点（drainFaceAnchors）から傾斜ラベルを作る（面を間引かない＝傾斜面1つにつき1つ）。矢じりは renderer/chevron.js（1行まるごと）', () => {
  assert.match(figure, /^\s*const anchors = drainFaceAnchors\(\{ rects: region\.rect \? \[region\.rect\] : region\.rects, drains: region\.planDrains, tolMm \}\);\s*$/m);
  assert.equal(count(figure, /anchors\s*\.filter\(/g), 0, '基準点を間引かない');
  assert.match(figure, /^\s*prims: roofSlopeLabelPrimitives\(\{ key: region\.key, anchors: \[a\], slope: region\.slope \}\),\s*$/m);
  assert.match(figure, /^\s*import \{ chevronPoints \} from '\.\.\/\.\.\/renderer\/chevron\.js';\s*$/m);
  assert.equal(count(figure, /drainFaceAnchors\(/g), 1);
  assert.equal(count(figure, /chevronPoints\(/g), 1);
});
