// 姿図の配置レイヤ（renderer/PlacedFiguresLayer.jsx。部分詳細図 S10 P3）の配線をソーステキスト検査で固定する
// （.jsx は node:test から単体 import できないため）。コメントを除いた本体に対し、m フラグの行頭・行末アンカーで
// 1行まるごと照合する（行末コメントで式を無効化する変異を検出するため）。PlanSolidsLayer.wiring.test.js と同じ型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripBlockAndCommentLines as stripComments } from '../uiBusySourceScan.js';

const read = name => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8'));
const layer = read('PlacedFiguresLayer.jsx');
const count = (text, re) => (text.match(re) || []).length;

test('【配線】PlacedFiguresLayer は graphComputed のキーに direction・subjects・overlayGeneration() を入れ、figureOf は detailFigureEntry（1行まるごと）', () => {
  assert.match(layer,
    /^\s*const plan = graphComputed\(graph, `placedFigures:\$\{direction\}:\$\{String\(subjects\)\}:\$\{overlayGeneration\(\)\}`, \(\) => placedFigureDrawPlan\(graph\.placedFigures, detailFigureEntry, \{ direction, subjects \}\)\);\s*$/m);
  assert.equal(count(layer, /graphComputed\(/g), 1);
  assert.equal(count(layer, /placedFigureDrawPlan\(/g), 1);
  assert.match(layer, /^export const PlacedFiguresLayer = observer\(\(\{ graph, viewport, direction = 'down', selectedId = null, subjects = null \}\) => \{\s*$/m);
  assert.match(layer, /^\s*if \(!graph\) return null;\s*$/m);
});

test('【配線】PlacedFiguresLayer は Group name="placed-figures"・Line は画面 px 固定（strokeScaleEnabled・listening とも false）で、LOD で絞らない', () => {
  assert.match(layer, /^\s*<Group name="placed-figures" listening=\{false\}>\s*$/m);
  const elements = layer.match(/<(?:Line|Rect)\b[\s\S]*?\/>/g) ?? [];
  assert.equal(elements.length, 3, '線・×・選択枠');
  for (const el of elements) {
    assert.match(el, /^\s*strokeScaleEnabled=\{false\}\s*$/m);
    assert.match(el, /^\s*listening=\{false\}\s*$/m);
  }
  assert.equal(count(layer, /lodLevel/g), 0, '全 LOD で描く（LOD をキーにも条件にも使わない）');
  assert.match(layer, /^\s*strokeWidth=\{viewport\.lineWeightsPx\[l\.weight\]\}\s*$/m);
  assert.match(layer, /^\s*dash=\{l\.dashed \? DASH_DASHED : undefined\}\s*$/m);
  assert.match(layer, /^\s*points=\{l\.points\}\s*$/m, '線の頂点は計画の points そのもの');
  assert.equal(count(layer, /^\s*stroke=\{PLAN_SOLIDS_COLOR\}\s*$/gm), 2, '線と × は平面の線色');
  assert.equal(count(layer, /^\s*stroke=\{MEMBER_SELECTION_COLOR\}\s*$/gm), 1, '選択枠だけ選択色');
});

test('【配線】× は配置点を中心に半幅 half の 2 本の対角線（1行まるごと）・細線', () => {
  assert.match(layer, /^\s*\[`\$\{m\.figureId\}:x1`, \[m\.x - half, m\.y - half, m\.x \+ half, m\.y \+ half\]\],\s*$/m);
  assert.match(layer, /^\s*\[`\$\{m\.figureId\}:x2`, \[m\.x - half, m\.y \+ half, m\.x \+ half, m\.y - half\]\],\s*$/m);
  assert.equal(count(layer, /^\s*strokeWidth=\{viewport\.lineWeightsPx\.thin\}\s*$/gm), 2, '× と選択枠は細線');
});

test('【配線】× の半幅は PLACED_FIGURE_MISSING_MARK_PX / viewport.scaleX（画面 px 一定・1行まるごと）', () => {
  assert.match(layer, /^\s*const half = PLACED_FIGURE_MISSING_MARK_PX \/ viewport\.scaleX;\s*$/m);
});

test('【不変条件】PlacedFiguresLayer の色は PlanSolidsLayer の PLAN_SOLIDS_COLOR を使い回す（色を新設しない）。判断は純モジュール', () => {
  assert.match(layer, /^import \{ PLAN_SOLIDS_COLOR \} from '\.\/PlanSolidsLayer\.jsx';$/m);
  assert.equal(count(layer, /#[0-9a-fA-F]{6}\b/g), 0, '色リテラルを持たない');
  assert.match(layer, /^import \{ placedFigureDrawPlan \} from '\.\/placedFigureDrawPlan\.js';$/m);
  assert.equal(count(layer, /appMode/g), 0, '表示するモードの判断は SceneLayers');
  for (const line of layer.split('\n').filter(l => /^\s*import\b/.test(l))) assert.ok(!/store\.js|snap\.js|appViewport/.test(line), `禁止の import: ${line}`);
});
