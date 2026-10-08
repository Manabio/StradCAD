// 平面の断面解決の新レイヤ（S4）: renderer/PlanSolidsLayer.jsx が、判断を純モジュール（plan/planSolidsLayerFilter.js）に
// 任せて写すだけであること、SceneLayers・App.jsx の配線を、ソーステキスト検査で固定する（.jsx は node:test から
// 単体 import できないため。RoofPlanLayer.wiring.test.js と同じ型）。コメント行・ブロックコメントを除いた本体に対し、
// m フラグの行頭・行末アンカーで1行まるごと照合する（行末コメントで式を無効化する変異を検出するため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentLines } from '../uiBusySourceScan.js';

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}
const read = name => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8'));

const layer = read('PlanSolidsLayer.jsx');
const scene = read('SceneLayers.jsx');
const filter = read('../plan/planSolidsLayerFilter.js');
const app = stripCommentLines(readAppSrc()).replace(/\r\n/g, '\n');
const count = (text, re) => (text.match(re) || []).length;

test('【不変条件】PlanSolidsLayer.jsx の import は react・mobx・react-konva・@core・純モジュール・graphDerived だけ（store.js / snap.js を引かない）', () => {
  const imports = layer.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.equal(imports.length, 6, `import 行: ${imports.length}`);
  assert.match(layer, /^import \{ useRef \} from 'react';$/m);
  assert.match(layer, /^import \{ observer \} from 'mobx-react-lite';$/m);
  assert.match(layer, /^import \{ Group, Line \} from 'react-konva';$/m);
  assert.match(layer, /^import \{ planSolidsLayerResolve \} from '\.\.\/plan\/planSolidsLayerFilter\.js';$/m);
  assert.match(layer, /^import \{ stairRiserOf \} from '\.\.\/finish\/stair\/stairDimensions\.js';$/m);
  assert.match(layer, /^import \{ graphComputed \} from '\.\/graphDerived\.js';$/m);
  for (const line of imports) assert.ok(!/store\.js|snap\.js|appViewport/.test(line), `禁止の import: ${line}`);
});

test('【配線】PlanSolidsLayer.jsx は判断を planSolidsLayerResolve に任せ、memo は graphComputed・前回の線は ref（同じ階のものだけ）・蹴上は stairRiserOf（1行まるごと）', () => {
  assert.match(layer, /^\s*const prims = planSolidsLayerResolve\(\{\s*$/m);
  assert.match(layer, /^\s*graph, belowPeek, memo: graphComputed,\s*$/m);
  assert.match(layer, /^\s*prevPrims: prevRef\.current\?\.planeId === graph\.plane\.id \? prevRef\.current\.prims : null,\s*$/m);
  assert.match(layer, /^\s*selfRiserOf: s => stairRiserOf\(s, project, graph\.plane\),\s*$/m);
  assert.match(layer, /^\s*if \(prims\) prevRef\.current = \{ planeId: graph\.plane\.id, prims \};\s*$/m);
  assert.match(layer, /^\s*const prevRef = useRef\(null\);/m);
  assert.match(layer, /^\s*if \(!prims \|\| prims\.length === 0\) return null;\s*$/m);
  assert.equal(count(layer, /graphComputed/g), 2, 'import と memo 引数だけ（置き場・鍵はレイヤに書かない）');
  assert.equal(count(layer, /planSolidsLayerResolve\(/g), 1);
  assert.equal(count(layer, /graph\.plane\.id\}:/g), 0, '鍵の文字列はレイヤに無い（planSolidsLayerCacheSpec が唯一の場所）');
  // useRef は早期 return より前（フックの呼び出し順）
  assert.ok(layer.indexOf('useRef(null)') < layer.indexOf('if (!graph) return null;'));
});

test('【配線】planSolidsLayerFilter.js: 置き場・鍵・使う peek は planSolidsLayerCacheSpec の1か所。自階と違う階の peek は使わない。ドラッグ中は prevPrims・未解決（undefined）は null（1行まるごと）', () => {
  assert.match(filter, /^\s*const peek = belowPeek && belowPeek\.activePlaneId === graph\.plane\.id \? belowPeek : null;\s*$/m);
  assert.match(filter, /^\s*const cutZ = planCutHeightMmOf\(graph\.plane\);\s*$/m);
  assert.match(filter, /^\s*home: peek\?\.graph \?\? graph,\s*$/m);
  assert.match(filter, /^\s*key: `planSection:\$\{graph\.plane\.id\}:\$\{cutZ\}:\$\{peek\?\.graph\?\.plane\?\.id \?\? '-'\}`,\s*$/m);
  assert.match(filter, /^\s*if \(!graph \|\| belowPeek === undefined\) return null;\s*$/m);
  assert.match(filter, /^\s*if \(isCenterLineDragging\(graph\)\) return prevPrims;\s*$/m);
  assert.match(filter, /^\s*return memo\(home, key, \(\) => planSolidsLayerPrimitives\(\{ graph, belowPeek: peek, selfRiserOf, cutZ \}\)\);\s*$/m);
  assert.match(filter, /^\s*return \(graph\?\.centerLines \?\? \[\]\)\.some\(cl => \(cl\.pendingDelta \?\? 0\) !== 0\);\s*$/m);
});

test('【配線】PlanSolidsLayer.jsx は <Line を1つだけ。線幅は viewport.lineWeightsPx[p.weight]・dash は p.dash・strokeScaleEnabled={false}・listening={false}（Group にも）。LOD 分岐は無い', () => {
  assert.equal(count(layer, /<Line\b/g), 1);
  assert.equal(count(layer, /listening=\{false\}/g), 2, 'Group と Line');
  assert.match(layer, /^\s*<Group name="plan-solids" listening=\{false\}>\s*$/m);
  const el = (layer.match(/<Line\b[\s\S]*?\/>/g) ?? [])[0];
  assert.ok(el, '<Line 要素が見つかる');
  for (const re of [/^\s*key=\{p\.key\}\s*$/m, /^\s*points=\{p\.points\}\s*$/m, /^\s*stroke=\{PLAN_SOLIDS_COLOR\}\s*$/m,
    /^\s*strokeWidth=\{viewport\.lineWeightsPx\[p\.weight\]\}\s*$/m, /^\s*dash=\{p\.dash\}\s*$/m,
    /^\s*strokeScaleEnabled=\{false\}\s*$/m, /^\s*listening=\{false\}\s*$/m]) assert.match(el, re, String(re));
  assert.match(layer, /^const PLAN_SOLIDS_COLOR = '#1e293b';/m);
  assert.equal(count(layer, /lodLevel/g), 0, 'LOD 分岐は入れない（線幅は px で倍率非依存）');
  assert.equal(count(layer, /appMode/g), 0, '表示するモードの判断は SceneLayers の showPlanFigure');
});

test('【配線】SceneLayers は <PlanSolidsLayer> を showPlanFigure で1行まるごとの形でゲートし、RoofPlanLayer の直後・EquipmentSymbolLayer の前に置き、belowPlanPeek を渡す', () => {
  assert.match(scene,
    /^\s*\{showPlanFigure && <PlanSolidsLayer graph=\{graph\} project=\{project\} viewport=\{viewport\} belowPeek=\{belowPlanPeek\} \/>\}\s*$/m);
  assert.match(scene, /^\s*import \{ PlanSolidsLayer \} from '\.\/PlanSolidsLayer\.jsx';\s*$/m);
  assert.equal(count(scene, /<PlanSolidsLayer\b/g), 1);
  assert.match(scene, /^\s*const showPlanFigure = shouldShowPlanFigure\(appMode\);\s*$/m);
  assert.match(scene, /^\s*structComposition, upperVoidCrosses, belowPlanPeek,\s*$/m);
  const roofAt = scene.indexOf('<RoofPlanLayer'), solidsAt = scene.indexOf('<PlanSolidsLayer'), equipAt = scene.indexOf('<EquipmentSymbolLayer');
  assert.ok(roofAt >= 0 && solidsAt > roofAt && equipAt > solidsAt, `順序 RoofPlanLayer(${roofAt}) < PlanSolidsLayer(${solidsAt}) < EquipmentSymbolLayer(${equipAt})`);
});

test('【配線】App.jsx の上階ビュー peek の effect が、同じ peek から belowPlanPeek を set し（新しい peek を増やさない）、SceneLayers へ渡す', () => {
  const start = app.indexOf('setUpperStairEntries(null);');
  assert.ok(start >= 0, '上階ビュー peek の effect が見つかる');
  const end = app.indexOf('}, [appMode, activeFloorId, floorSyncTick, planesKey]);', start);
  assert.ok(end > start, 'effect の deps 行が見つかる');
  const effect = app.slice(start, end);
  assert.equal(count(effect, /floorSwapManager\.peek\(/g), 1, 'effect の peek は1回のまま');
  // 3状態: 冒頭＝undefined（未解決）、下階なしの分岐＝null（解決済み）、peek 後＝オブジェクト
  const resetAt = effect.search(/^\s*setBelowPlanPeek\(undefined\);/m);
  const noBelowAt = effect.search(/^\s*setBelowPlanPeek\(null\);/m);
  const noBelowGuardAt = effect.indexOf('if (!below || !active || !shouldShowPlanFigure(appMode)) {');
  assert.ok(noBelowGuardAt > resetAt && noBelowAt > noBelowGuardAt && noBelowAt < effect.indexOf('await floorSwapManager.peek('), '下階なしの分岐で null');
  assert.equal(count(effect, /setBelowPlanPeek\(null\)/g), 1, 'null にするのは下階なしの1箇所だけ（冒頭は undefined）');
  const peekAt = effect.indexOf('await floorSwapManager.peek(below, project.structGraph)');
  const setAt = effect.search(/^\s*setBelowPlanPeek\(\{ graph: temp, floorHeightMm: floorHeight, activePlaneId: active\.id \}\);\s*$/m);
  assert.ok(resetAt >= 0 && peekAt > resetAt && setAt > peekAt, `順序 リセット(${resetAt}) < peek(${peekAt}) < set(${setAt})`);
  const cancelAt = effect.indexOf('if (cancelled) return;', peekAt);
  assert.ok(cancelAt > peekAt && cancelAt < setAt, 'peek の後に cancelled ガードがあり、set はその後');
  assert.match(app, /^\s*const \[belowPlanPeek, setBelowPlanPeek\] = useState\(undefined\);\s*$/m);
  assert.match(app, /^\s*belowPlanPeek=\{belowPlanPeek\}\s*$/m);
  assert.equal(count(app, /belowPlanPeek=\{belowPlanPeek\}/g), 1);
});

test('【不変条件】planSolidsLayerFilter.js（純モジュール）は store.js・snap.js・.jsx・react-konva・graphDerived・mobx を import しない。描く種別の集合は1か所', () => {
  const imports = filter.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.equal(imports.length, 3);
  for (const line of imports) assert.ok(!/store\.js|snap\.js|\.jsx|react-konva|graphDerived|mobx/.test(line), `禁止の import: ${line}`);
  assert.match(filter, /^export const S4_DRAWN_KINDS = Object\.freeze\(\['beam', 'generic'\]\);\s*$/m);
  assert.match(filter, /^\s*return \(prims \?\? \[\]\)\.filter\(p => S4_DRAWN_KINDS\.includes\(p\?\.source\?\.kind\)\);\s*$/m);
  assert.match(filter, /^\s*return drawnPrimitives\(planSectionFigure\(solids, cutZ\)\);\s*$/m);
});

test('【配線】planSolidsLayerFilter.js は自階（FL=0）＋直下階（FL=-階高）の2層だけを解決器へ渡す（上階は渡さない）', () => {
  assert.match(filter, /^\s*const layers = \[\{ graph, floorZMm: 0, role: 'self' \}\];\s*$/m);
  assert.match(filter, /^\s*layers\.push\(\{ graph: belowGraph, floorZMm: -belowPeek\.floorHeightMm, role: 'below' \}\);\s*$/m);
  assert.equal(count(filter, /role: 'above'/g), 0);
  assert.equal(count(filter, /layers\.push\(/g), 1);
});
