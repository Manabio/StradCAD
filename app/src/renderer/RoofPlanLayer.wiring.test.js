// 下屋の平面表示（ステップ1）: renderer/RoofPlanLayer.jsx が、図形の判断を純モジュール（finish/roof/roofPlanFigure.js）に
// 任せて写すだけであることを、ソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。
// VoidLayer.wiring.test.js と同じ型）。コメント行・ブロックコメントを除いた本体に対し、m フラグの行頭・行末アンカーで
// 1行まるごと照合する（行末コメントで式を無効化する変異を検出するため）。
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
const read = name => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8'));

const layer = read('RoofPlanLayer.jsx');
const figure = read('../finish/roof/roofPlanFigure.js');
const count = (text, re) => (text.match(re) || []).length;

test('【配線】RoofPlanLayer.jsx は図形を graphComputed(graph, \'roofPlanFigure\', …) で graph 単位に memo し、LOD は visibleRoofPlanPrimitives(…, viewport.lodLevel) で絞る（1行まるごと）', () => {
  assert.match(layer,
    /^\s*const prims = visibleRoofPlanPrimitives\(graphComputed\(graph, 'roofPlanFigure', \(\) => roofPlanFigure\(graph\)\), viewport\.lodLevel\);\s*$/m,
    'const prims = visibleRoofPlanPrimitives(graphComputed(graph, \'roofPlanFigure\', () => roofPlanFigure(graph)), viewport.lodLevel); が1行まるごとの形で見つからない');
  assert.equal(count(layer, /roofPlanFigure\(/g), 1, 'roofPlanFigure( の呼び出しはこの1箇所（memo の中）だけ');
  assert.equal(count(layer, /graphComputed\(/g), 1);
  assert.equal(count(layer, /visibleRoofPlanPrimitives\(/g), 1);
});

test('【不変条件】RoofPlanLayer.jsx は純モジュール・graphDerived から import する（判断を .jsx に書かない）', () => {
  assert.match(layer, /^\s*import \{ roofPlanFigure, visibleRoofPlanPrimitives \} from '\.\.\/finish\/roof\/roofPlanFigure\.js';\s*$/m);
  assert.match(layer, /^\s*import \{ graphComputed \} from '\.\/graphDerived\.js';\s*$/m);
});

test('【不変条件】RoofPlanLayer.jsx は appMode・graph.・project を読まない（表示するモードの判断は SceneLayers の showPlanFigure）', () => {
  assert.equal(count(layer, /appMode/g), 0, 'appMode が出ない');
  assert.equal(count(layer, /\bproject\b/g), 0);
  assert.equal(count(layer, /\bgraph\.\w/g), 0, 'graph. を読まない（導出は純モジュール）');
});

test('【配線】RoofPlanLayer.jsx は <Line を1つだけ、細線（viewport.lineWeightsPx.thin）・strokeScaleEnabled={false}・listening={false} で描く（Group にも listening={false}）', () => {
  assert.equal(count(layer, /<Line\b/g), 1);
  assert.equal(count(layer, /listening=\{false\}/g), 2, 'Group と Line の2箇所');
  assert.match(layer, /^\s*<Group name="roof-plan" listening=\{false\}>\s*$/m);
  assert.match(layer, /^\s*listening=\{false\}\s*$/m, 'Line の listening={false} が1行まるごとの形（行末コメントに残す変異を検出）');
  assert.match(layer, /^\s*strokeWidth=\{viewport\.lineWeightsPx\.thin\}\s*$/m);
  assert.match(layer, /^\s*strokeScaleEnabled=\{false\}\s*$/m);
  assert.match(layer, /^\s*points=\{p\.points\}\s*$/m);
  assert.match(layer, /^\s*closed=\{p\.closed\}\s*$/m);
});

test('【不変条件】roofPlanFigure.js（純モジュール）は store.js・snap.js・.jsx・react-konva・graphDerived を import しない', () => {
  const imports = figure.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.ok(imports.length >= 4, `import 行が読めている: ${imports.length}`);
  for (const line of imports) {
    assert.ok(!/store\.js|snap\.js|\.jsx|react-konva|graphDerived|mobx/.test(line), `禁止の import: ${line}`);
  }
});
