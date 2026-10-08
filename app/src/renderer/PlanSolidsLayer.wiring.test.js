// 平面の断面解決の新レイヤ（S4）: renderer/PlanSolidsLayer.jsx が、判断を純モジュール（plan/planSolidsLayerFilter.js）に
// 任せて写すだけであること、SceneLayers・App.jsx の配線を、ソーステキスト検査で固定する（.jsx は node:test から
// 単体 import できないため）。コメント行・ブロックコメントを除いた本体に対し、
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
  assert.equal(imports.length, 8, `import 行: ${imports.length}`);
  assert.match(layer, /^import \{ planHoleMarksOf, planHoleMarkPrimitives \} from '\.\.\/plan\/planHoleMarks\.js';$/m);
  assert.match(layer, /^import \{ floorOpeningGroups \} from '\.\.\/finish\/stair\/slabOpening\.js';$/m);
  assert.match(layer, /^import \{ useRef \} from 'react';$/m);
  assert.match(layer, /^import \{ observer \} from 'mobx-react-lite';$/m);
  assert.match(layer, /^import \{ Group, Line, Text \} from 'react-konva';$/m);
  assert.match(layer, /^import \{ planSolidsLayerResolve, visiblePlanPrimitives \} from '\.\.\/plan\/planSolidsLayerFilter\.js';$/m);
  assert.match(layer, /^import \{ stairRiserOf \} from '\.\.\/finish\/stair\/stairDimensions\.js';$/m);
  assert.match(layer, /^import \{ graphComputed \} from '\.\/graphDerived\.js';$/m);
  for (const line of imports) assert.ok(!/store\.js|snap\.js|appViewport/.test(line), `禁止の import: ${line}`);
});

test('【配線】PlanSolidsLayer.jsx は判断を planSolidsLayerResolve に任せ、memo は graphComputed・前回の線は ref（同じ階のものだけ）・蹴上は stairRiserOf（1行まるごと）', () => {
  assert.match(layer, /^\s*const resolved = planSolidsLayerResolve\(\{\s*$/m);
  assert.match(layer, /^\s*graph, belowPeek, memo: graphComputed,\s*$/m);
  assert.match(layer, /^\s*prevPrims: prevRef\.current\?\.planeId === graph\.plane\.id \? prevRef\.current\.prims : null,\s*$/m);
  assert.match(layer, /^\s*selfRiserOf: s => stairRiserOf\(s, project, graph\.plane\),\s*$/m);
  assert.match(layer, /^\s*if \(resolved\) prevRef\.current = \{ planeId: graph\.plane\.id, prims: resolved \};\s*$/m, 'ref には LOD で絞る前の線を持つ');
  assert.match(layer, /^\s*const prevRef = useRef\(null\);/m);
  assert.match(layer, /^\s*if \(prims\.length === 0 && holePrims\.length === 0\) return null;\s*$/m, '線も注記も無いときだけ null（ドラッグ直後で resolved が null でも注記は描く）');
  assert.equal(count(layer, /graphComputed/g), 3, 'import・解決器の memo 引数・上階の穴の memo だけ（置き場・鍵はレイヤに書かない）');
  assert.equal(count(layer, /planSolidsLayerResolve\(/g), 1);
  assert.equal(count(layer, /graph\.plane\.id\}:/g), 0, '鍵の文字列はレイヤに無い（planSolidsLayerCacheSpec が唯一の場所）');
  // useRef は早期 return より前（フックの呼び出し順）
  assert.ok(layer.indexOf('useRef(null)') < layer.indexOf('if (!graph) return null;'));
});

test('【配線】planSolidsLayerFilter.js: 置き場・鍵・使う peek は planSolidsLayerCacheSpec の1か所。自階と違う階の peek は使わない。ドラッグ中は prevPrims・未解決（undefined）は null（1行まるごと）', () => {
  assert.match(filter, /^\s*const peek = belowPeek && belowPeek\.activePlaneId === graph\.plane\.id \? belowPeek : null;\s*$/m);
  assert.match(filter, /^\s*const cutZ = planCutHeightMmOf\(graph\.plane\);\s*$/m);
  assert.match(filter, /^\s*home: peek\?\.graph \?\? graph,\s*$/m);
  assert.match(filter, /^\s*key: `planSection:\$\{graph\.plane\.id\}:\$\{cutZ\}:\$\{peek\?\.graph\?\.plane\?\.id \?\? \(belowPeek === undefined \? 'pending' : '-'\)\}`,\s*$/m);
  assert.match(filter, /^\s*if \(!graph\) return null;\s*$/m);
  assert.equal(count(filter, /belowPeek === undefined/g), 1, '未解決は鍵の pending だけで扱う（描かない分岐を持たない）');
  assert.match(filter, /^\s*if \(isCenterLineDragging\(graph\)\) return prevPrims;\s*$/m);
  assert.match(filter, /^\s*return memo\(home, key, \(\) => planSolidsLayerPrimitives\(\{ graph, belowPeek: peek, selfRiserOf, cutZ \}\)\);\s*$/m);
  assert.match(filter, /^\s*return \(graph\?\.centerLines \?\? \[\]\)\.some\(cl => \(cl\.pendingDelta \?\? 0\) !== 0\);\s*$/m);
});

test('【配線】PlanSolidsLayer.jsx は <Line を3つ（線・矢印本体・矢じり）と <Text を1つだけ。Line は細線を含む viewport.lineWeightsPx[p.weight]・strokeScaleEnabled={false}・listening={false}、Text は fontSize={p.fontSizeMm}・listening={false}（Group にも）', () => {
  const solidsPart = layer.slice(0, layer.indexOf('<Group name="plan-hole-marks"')); // 立体の線・ラベルの部分（注記は別 Group）
  assert.ok(solidsPart.includes('<Group name="plan-solids"'));
  assert.equal(count(solidsPart, /<Line\b/g), 3, '線・矢印本体・矢じり');
  assert.equal(count(solidsPart, /<Text\b/g), 1);
  assert.equal(count(solidsPart, /listening=\{false\}/g), 5, 'Group・Line 3本・Text の5箇所');
  assert.match(layer, /^\s*<Group name="plan-solids" listening=\{false\}>\s*$/m);
  const lines = solidsPart.match(/<Line\b[\s\S]*?\/>/g) ?? [];
  assert.equal(lines.length, 3);
  for (const el of lines) { // 要素ごとに1行まるごと（行末コメントに残す変異を検出）
    assert.match(el, /^\s*listening=\{false\}\s*$/m, 'Line の listening={false}');
    assert.match(el, /^\s*strokeWidth=\{viewport\.lineWeightsPx\[p\.weight\]\}\s*$/m, 'Line の線幅は p.weight（thin/thick）');
    assert.match(el, /^\s*strokeScaleEnabled=\{false\}\s*$/m, 'Line は画面px固定');
    assert.match(el, /^\s*stroke=\{PLAN_SOLIDS_COLOR\}\s*$/m);
  }
  assert.match(lines[0], /^\s*points=\{p\.points\}\s*$/m, 'arrow 本体');
  assert.match(lines[1], /^\s*points=\{p\.head\}\s*$/m, '矢じり');
  assert.match(lines[1], /^\s*lineCap="round"\s*$/m);
  assert.match(lines[1], /^\s*lineJoin="round"\s*$/m);
  assert.match(lines[2], /^\s*points=\{p\.points\}\s*$/m);
  assert.match(lines[2], /^\s*key=\{p\.key\}\s*$/m);
  assert.match(lines[2], /^\s*dash=\{p\.dash\}\s*$/m, '線は dash を渡す');
  const text = (solidsPart.match(/<Text\b[\s\S]*?\/>/g) ?? [])[0];
  assert.ok(text, '<Text 要素が見つかる');
  for (const re of [/^\s*x=\{p\.x\}\s*$/m, /^\s*y=\{p\.y\}\s*$/m, /^\s*text=\{p\.text\}\s*$/m, /^\s*fontSize=\{p\.fontSizeMm\}\s*$/m,
    /^\s*fill=\{PLAN_SOLIDS_COLOR\}\s*$/m, /^\s*listening=\{false\}\s*$/m]) assert.match(text, re, String(re));
  assert.match(layer, /^const PLAN_SOLIDS_COLOR = '#1e293b';/m);
  assert.match(layer, /^\s*if \(p\.kind === 'text'\) \{\s*$/m);
  assert.match(layer, /^\s*if \(p\.kind === 'arrow'\) \{\s*$/m);
  assert.equal(count(layer, /appMode/g), 0, '表示するモードの判断は SceneLayers の showPlanFigure');
});

test('【配線】PlanSolidsLayer.jsx の LOD 分岐は visiblePlanPrimitives(resolved, viewport.lodLevel) の1行だけ（memo の外・判断は純モジュール）', () => {
  assert.match(layer, /^\s*const prims = resolved \? visiblePlanPrimitives\(resolved, viewport\.lodLevel\) : \[\];\s*$/m);
  assert.equal(count(layer, /lodLevel/g), 2, 'LOD の参照は visiblePlanPrimitives への引数と、注記の planHoleMarkPrimitives への引数だけ');
  assert.equal(count(layer, /visiblePlanPrimitives\(/g), 1);
  assert.ok(layer.indexOf('visiblePlanPrimitives(') > layer.indexOf('planSolidsLayerResolve({'), 'resolve（memo）の後で絞る');
});

test('【配線】SceneLayers は <PlanSolidsLayer> を showPlanFigure で1行まるごとの形でゲートし、EquipmentSymbolLayer の前に置き、belowPlanPeek・abovePlanPeek を渡す。RoofPlanLayer・VoidLayer は使わない', () => {
  assert.match(scene,
    /^\s*\{showPlanFigure && <PlanSolidsLayer graph=\{graph\} project=\{project\} viewport=\{viewport\} belowPeek=\{belowPlanPeek\} abovePeek=\{abovePlanPeek\} \/>\}\s*$/m);
  assert.match(scene, /^\s*import \{ PlanSolidsLayer \} from '\.\/PlanSolidsLayer\.jsx';\s*$/m);
  assert.equal(count(scene, /<PlanSolidsLayer\b/g), 1);
  assert.match(scene, /^\s*const showPlanFigure = shouldShowPlanFigure\(appMode\);\s*$/m);
  assert.match(scene, /^\s*structComposition, belowPlanPeek, abovePlanPeek,\s*$/m);
  assert.equal(count(scene, /RoofPlanLayer/g), 0, '下屋は PlanSolidsLayer が描く（S5）');
  assert.equal(count(scene, /VoidLayer|upperVoidCrosses/g), 0, '吹抜けの注記は PlanSolidsLayer が描く（S6b）');
  const solidsAt = scene.indexOf('<PlanSolidsLayer'), equipAt = scene.indexOf('<EquipmentSymbolLayer');
  assert.ok(solidsAt >= 0 && equipAt > solidsAt, `順序 PlanSolidsLayer(${solidsAt}) < EquipmentSymbolLayer(${equipAt})`);
});

test('【配線】PlanSolidsLayer.jsx の吹抜けの注記: Group plan-hole-marks・listening=false。自階の×は planSolidsLayerResolve の外で毎回求め、上階の穴は peek した graph に memo。階の違う peek は使わない', () => {
  const marksPart = layer.slice(layer.indexOf('<Group name="plan-hole-marks"'));
  assert.match(layer, /^\s*<Group name="plan-hole-marks" listening=\{false\}>\s*$/m);
  assert.equal(count(layer, /<Group\b/g), 2, 'plan-solids と plan-hole-marks');
  assert.equal(count(marksPart, /<Line\b/g), 1);
  assert.equal(count(marksPart, /<Text\b/g), 1);
  assert.equal(count(marksPart, /listening=\{false\}/g), 3, 'Group・Line・Text');
  assert.match(marksPart, /^\s*strokeWidth=\{viewport\.lineWeightsPx\.thin\}\s*$/m, '注記は細線');
  assert.match(marksPart, /^\s*dash=\{p\.dash\}\s*$/m, '破線は純関数が決めた dashKind→dash をそのまま渡す');
  assert.match(marksPart, /^\s*strokeScaleEnabled=\{false\}\s*$/m);
  assert.match(marksPart, /^\s*offsetX=\{p\.offsetX\}\s*$/m);
  // 上階の穴: abovePeek の graph に memo（キー planHoleGroups）。自階の peek 照合は 1 行まるごと
  assert.match(layer, /^\s*const aboveGroups = abovePeek\?\.activePlaneId === graph\.plane\.id\s*$/m);
  assert.match(layer, /^\s*\? graphComputed\(abovePeek\.graph, 'planHoleGroups', \(\) => floorOpeningGroups\(abovePeek\.graph, \{ stairFilter: \(\) => false \}\)\)\s*$/m);
  assert.match(layer, /^\s*: undefined;\s*$/m, '照合できない peek は未解決扱い');
  assert.equal(count(layer, /graphComputed\(/g), 1, 'memo は上階の穴の1回だけ（解決器の memo は planSolidsLayerResolve の中）');
  // 自階の×: memo の外（graphComputed にも planSolidsLayerResolve にも入れない）。ドラッグ中も毎レンダーで求める
  assert.match(layer, /^\s*const holePrims = planHoleMarkPrimitives\(planHoleMarksOf\(graph, aboveGroups\), \{\s*$/m);
  assert.match(layer, /^\s*thickPx: viewport\.lineWeightsPx\.thick, thinPx: viewport\.lineWeightsPx\.thin, scale: viewport\.scaleX, lod: viewport\.lodLevel,\s*$/m);
  assert.equal(count(layer, /planHoleMarksOf\(/g), 1);
  assert.equal(count(layer, /isCenterLineDragging/g), 0, 'レイヤはドラッグ判定をしない（解決器の中だけ）');
  const resolveAt = layer.indexOf('planSolidsLayerResolve({'), holeAt = layer.indexOf('planHoleMarksOf(');
  assert.ok(holeAt > resolveAt, '注記は解決器の呼び出しの後（独立した経路）');
  assert.ok(!/planHoleMarksOf|planHoleMarkPrimitives/.test(filter), '注記は planSolidsLayerFilter（ドラッグ固定の経路）に入れない');
});

test('【配線】planHoleMarks.js: dashKind→破線の写像は HOLE_MARK_DASH の1か所。openingCrossDash( はコード本体に1回・UPPER_VOID_DASH_PX は定義とその参照だけ', () => {
  const marks = read('../plan/planHoleMarks.js');
  assert.equal(count(marks, /openingCrossDash\(/g), 1);
  assert.match(marks, /^\s*openingCross: thinPx => openingCrossDash\(thinPx\),\s*$/m);
  assert.match(marks, /^\s*upperVoid: \(\) => UPPER_VOID_DASH_PX,\s*$/m);
  assert.match(marks, /^\s*const dash = HOLE_MARK_DASH\[m\.dashKind\]\(thinPx\);\s*$/m);
  assert.match(marks, /^\s*if \(m\.label && lod !== LodLevel\.SCHEMATIC\) \{\s*$/m, 'LOD でラベルだけ落とす条件');
  assert.match(marks, /^export const UPPER_VOID_DASH_PX = \[8, 4\];\s*$/m);
});

test('【不変条件】旧経路（VoidLayer・voidGeometry）は削除済みで、どこからも参照されない', () => {
  for (const f of ['VoidLayer.jsx', 'VoidLayer.wiring.test.js', '../finish/voidGeometry.js', '../finish/voidGeometry.test.js']) {
    assert.ok(!fs.existsSync(path.resolve(import.meta.dirname, f)), `${f} は削除済み`);
  }
  assert.equal(count(app, /voidGeometry|VoidLayer|upperVoidCrosses|computeVoidCrosses/g), 0);
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

test('【配線】App.jsx の上階 peek の effect が abovePlanPeek を3状態で set し（冒頭 undefined／上階なし null／peek 後 {graph, activePlaneId}）、SceneLayers へ渡す。upperVoidCrosses は無い', () => {
  const start = app.indexOf('setAbovePlanPeek(undefined);');
  assert.ok(start >= 0, '上階 peek の effect が見つかる');
  const end = app.indexOf('}, [appMode, activeFloorId, floorSyncTick, planesKey]);', start);
  assert.ok(end > start, 'effect の deps 行が見つかる');
  const effect = app.slice(start, end);
  assert.equal(count(effect, /floorSwapManager\.peek\(/g), 1, 'effect の peek は1回のまま（新しい peek を増やさない）');
  const noAboveGuardAt = effect.indexOf('if (!above || !active || !shouldShowPlanFigure(appMode)) {');
  const nullAt = effect.search(/^\s*setAbovePlanPeek\(null\);/m);
  const peekAt = effect.indexOf('await floorSwapManager.peek(above, project.structGraph)');
  const cancelAt = effect.indexOf('if (cancelled) return;', peekAt);
  const setAt = effect.search(/^\s*setAbovePlanPeek\(\{ graph: temp, activePlaneId: active\.id \}\);\s*$/m);
  assert.ok(noAboveGuardAt >= 0 && nullAt > noAboveGuardAt && nullAt < peekAt, '上階なしの分岐で null');
  assert.equal(count(effect, /setAbovePlanPeek\(null\)/g), 1, 'null にするのは上階なしの1箇所だけ（冒頭は undefined）');
  assert.ok(peekAt > 0 && cancelAt > peekAt && setAt > cancelAt, `順序 peek(${peekAt}) < cancelled ガード(${cancelAt}) < set(${setAt})`);
  assert.match(app, /^\s*const \[abovePlanPeek, setAbovePlanPeek\] = useState\(undefined\);\s*$/m);
  assert.match(app, /^\s*abovePlanPeek=\{abovePlanPeek\}\s*$/m);
  assert.equal(count(app, /abovePlanPeek=\{abovePlanPeek\}/g), 1);
  assert.equal(count(app, /upperVoidCrosses|UpperVoidCrosses/g), 0);
  assert.match(effect, /^\s*setUpperSlabOpenings\(openings\);\s*$/m, 'スラブ開口（階段の破れ先のクリップ用）は残す');
});

test('【不変条件】planSolidsLayerFilter.js（純モジュール）は store.js・snap.js・.jsx・react-konva・graphDerived・mobx を import しない。描く種別の集合は1か所', () => {
  const imports = filter.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.equal(imports.length, 4);
  for (const line of imports) assert.ok(!/store\.js|snap\.js|\.jsx|react-konva|graphDerived|mobx/.test(line), `禁止の import: ${line}`);
  assert.match(filter, /^export const S4_DRAWN_KINDS = Object\.freeze\(\['beam', 'generic', 'roof'\]\);\s*$/m);
  assert.match(filter, /^\s*return lod === LodLevel\.DETAIL \? prims : prims\.filter\(p => !p\.detailOnly\);\s*$/m);
  assert.match(filter, /^export const BELOW_DRAWN_KINDS = 'all';\s*$/m, '下階の層は全種別（S6c）。集合は1か所');
  assert.match(filter, /^\s*: S4_DRAWN_KINDS\.includes\(kind\)\);\s*$/m);
  assert.match(filter, /^\s*return \(prims \?\? \[\]\)\.filter\(p => p\?\.source\?\.kind != null && isDrawn\(p\.source\.kind, p\.source\.layerFloorZ\)\);\s*$/m);
  assert.equal(count(filter, /S4_DRAWN_KINDS\.includes\(/g), 1, '自階の集合の判定は isDrawn の1か所');
  assert.match(filter, /^\s*return drawnPrimitives\(planSectionFigure\(planSolidsLayerSolids\(\{ graph, belowPeek, selfRiserOf \}\), cutZ\)\);\s*$/m);
});

test('【配線】planSolidsLayerFilter.js は自階（FL=0）＋直下階（FL=-階高）の2層だけを解決器へ渡す（上階は渡さない）', () => {
  assert.match(filter, /^\s*const layers = \[\{ graph, floorZMm: 0, role: 'self' \}\];\s*$/m);
  assert.match(filter, /^\s*layers\.push\(\{ graph: belowGraph, floorZMm: -belowPeek\.floorHeightMm, role: 'below' \}\);\s*$/m);
  assert.equal(count(filter, /role: 'above'/g), 0);
  assert.equal(count(filter, /layers\.push\(/g), 1);
});
