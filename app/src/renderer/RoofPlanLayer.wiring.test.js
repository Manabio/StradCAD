// 下屋の平面表示（ステップ1）: renderer/RoofPlanLayer.jsx が、図形の判断を純モジュール（finish/roof/roofPlanFigure.js）に
// 任せて写すだけであることを、ソーステキスト検査で固定する（.jsx は node:test から単体 import できないため。
// PlanSolidsLayer.wiring.test.js と同じ型）。コメント行・ブロックコメントを除いた本体に対し、m フラグの行頭・行末アンカーで
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

test('【配線】RoofPlanLayer.jsx は <Line を3つ（線・矢印本体・矢じり）と <Text を1つだけ。Line は細線（viewport.lineWeightsPx.thin）・strokeScaleEnabled={false}・listening={false}、Text は fontSize={p.fontSizeMm}・listening={false}（Group にも listening={false}）', () => {
  assert.equal(count(layer, /<Line\b/g), 3, '線・矢印本体・矢じり');
  assert.equal(count(layer, /<Text\b/g), 1);
  assert.equal(count(layer, /listening=\{false\}/g), 5, 'Group・Line 3本・Text の5箇所');
  assert.match(layer, /^\s*<Group name="roof-plan" listening=\{false\}>\s*$/m);
  const lines = layer.match(/<Line\b[\s\S]*?\/>/g) ?? [];
  assert.equal(lines.length, 3);
  for (const el of lines) { // 要素ごとに1行まるごと（行末コメントに残す変異を検出）
    assert.match(el, /^\s*listening=\{false\}\s*$/m, 'Line の listening={false}');
    assert.match(el, /^\s*strokeWidth=\{viewport\.lineWeightsPx\.thin\}\s*$/m, 'Line の線幅は細線');
    assert.match(el, /^\s*strokeScaleEnabled=\{false\}\s*$/m, 'Line は画面px固定');
  }
  assert.match(lines[0], /^\s*points=\{p\.points\}\s*$/m, 'arrow 本体');
  assert.match(lines[1], /^\s*points=\{p\.head\}\s*$/m, '矢じり');
  assert.match(lines[1], /^\s*lineCap="round"\s*$/m);
  assert.match(lines[1], /^\s*lineJoin="round"\s*$/m);
  assert.match(lines[2], /^\s*points=\{p\.points\}\s*$/m);
  assert.match(lines[2], /^\s*closed=\{p\.closed\}\s*$/m);
  const text = (layer.match(/<Text\b[\s\S]*?\/>/g) ?? [])[0];
  assert.ok(text, '<Text 要素が見つかる');
  for (const re of [/^\s*x=\{p\.x\}\s*$/m, /^\s*y=\{p\.y\}\s*$/m, /^\s*text=\{p\.text\}\s*$/m, /^\s*fontSize=\{p\.fontSizeMm\}\s*$/m,
    /^\s*fill=\{ROOF_PLAN_COLOR\}\s*$/m, /^\s*listening=\{false\}\s*$/m]) assert.match(text, re, String(re));
  assert.match(layer, /^import \{ Group, Line, Text \} from 'react-konva';\s*$/m);
});

test('【配線】RoofPlanLayer.jsx は kind で arrow・text を分けて写すだけ（判断は純モジュール。LOD は visibleRoofPlanPrimitives）', () => {
  assert.match(layer, /^\s*if \(p\.kind === 'text'\) \{\s*$/m);
  assert.match(layer, /^\s*if \(p\.kind === 'arrow'\) \{\s*$/m);
  assert.equal(count(layer, /viewport\.lodLevel/g), 1, 'LOD の参照は visibleRoofPlanPrimitives への引数だけ');
});

test('【不変条件】roofPlanFigure.js（純モジュール）は store.js・snap.js・.jsx・react-konva・graphDerived を import しない', () => {
  const imports = figure.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.ok(imports.length >= 4, `import 行が読めている: ${imports.length}`);
  for (const line of imports) {
    assert.ok(!/store\.js|snap\.js|\.jsx|react-konva|graphDerived|mobx/.test(line), `禁止の import: ${line}`);
  }
});

test('【配線】roofPlanFigure.js は region ごとの線を trimRoofPlanLinesAtWalls( に通し（faceAt は outerWallFaceNear）、壁に当たる端を外壁面で止める（1行まるごと）', () => {
  assert.match(figure, /^\s*out\.push\(\.\.\.trimRoofPlanLinesAtWalls\(lines, \{ faceAt, zeroZones: region\.zeroZones, reachMm, tolMm \}\)\);\s*$/m,
    'out.push(...trimRoofPlanLinesAtWalls(lines, { faceAt, zeroZones: region.zeroZones, reachMm, tolMm })); が1行まるごとの形で見つからない');
  assert.match(figure, /^\s*const faceAt = q => outerWallFaceNear\(graph, q\);\s*$/m);
  assert.equal(count(figure, /trimRoofPlanLinesAtWalls\(/g), 1);
  assert.match(figure, /^\s*import \{ trimRoofPlanLinesAtWalls \} from '\.\/roofPlanWallTrim\.js';\s*$/m);
  assert.match(figure, /^\s*import \{ outerWallFaceNear \} from '\.\.\/wallFaces\.js';\s*$/m);
});

test('【配線】roofPlanFigure.js は水下ごとの基準点（drainFaceAnchors）から傾斜ラベルを作る（面を間引かない＝傾斜面1つにつき1つ）。矢じりは renderer/chevron.js（1行まるごと）', () => {
  assert.match(figure, /^\s*const anchors = drainFaceAnchors\(\{ rects: region\.rect \? \[region\.rect\] : region\.rects, drains: region\.planDrains, tolMm \}\);\s*$/m);
  assert.equal(count(figure, /anchors\s*\.filter\(/g), 0, '基準点を間引かない');
  // S5: 線とラベルの作り方は roofPlanRegionFigure に抽出（解決器の innerLines・marks と旧 roofPlanFigure の共通の入口）。ラベルは基準点ごと
  assert.match(figure, /^\s*prims: roofSlopeLabelPrimitives\(\{ key: region\.key, anchors: \[a\], slope: region\.slope \}\),\s*$/m);
  assert.match(figure, /^\s*out\.push\(\.\.\.figure\.labels\.flatMap\(l => l\.prims\)\);\s*$/m);
  assert.equal(count(figure, /roofPlanRegionFigure\(/g), 2, '定義と、旧 roofPlanFigure からの呼び出し');
  assert.match(figure, /^\s*import \{ chevronPoints \} from '\.\.\/\.\.\/renderer\/chevron\.js';\s*$/m);
  assert.equal(count(figure, /drainFaceAnchors\(/g), 1);
  assert.equal(count(figure, /chevronPoints\(/g), 1);
});
