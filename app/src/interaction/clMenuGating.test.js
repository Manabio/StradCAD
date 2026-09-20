// convertMenuFlags（中心⇔通り芯の入替えメニュー可否判定）の単体テスト。
// 処理側ガード（transform/centerLineConvert.js checkPromoteToGridGuards／checkDemoteToCenterGuards）と
// 同じ主体判定（centerLineKindPolicy.js isConvertSubject）を共有することを固定する
// （以前は usePointerInteraction.js が独自のインライン種別比較を持ち、UIと処理の判定が食い違っていた）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { CONTEXT } from './menuItems.js';
import { convertMenuFlags } from './clMenuGating.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// ---- canToGrid（CL端点長押し。中心線→通り芯の提案）----

test('convertMenuFlags: 平面モード・中心線の端点ならcanToGrid=true', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const { canToGrid } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE_ENDPOINT, cl: null, clEndpoint: { cl, side: 'lo' } });
  assert.equal(canToGrid, true);
});

test('convertMenuFlags: 平面モード以外ならcanToGrid=false（主体は妥当でも文脈がfloorplan限定）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const { canToGrid } = convertMenuFlags(graph, { appMode: 'structure', menuContext: CONTEXT.CENTER_LINE_ENDPOINT, cl: null, clEndpoint: { cl, side: 'lo' } });
  assert.equal(canToGrid, false);
});

test('convertMenuFlags: clEndpointがnullならcanToGrid=false（短絡評価でclEndpoint.clを参照しない）', () => {
  const graph = makeGraph();
  const { canToGrid } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.EMPTY, cl: null, clEndpoint: null });
  assert.equal(canToGrid, false);
});

test('convertMenuFlags: 端点のCLが中心線でない（通り芯）ならcanToGrid=false', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const { canToGrid } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE_ENDPOINT, cl: null, clEndpoint: { cl, side: 'lo' } });
  assert.equal(canToGrid, false);
});

// ---- canToCenter（通り芯の線上長押し。通り芯→中心線の提案）----

test('convertMenuFlags: 平面モード・通り芯（labeled:true）の線上ならcanToCenter=true', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const { canToCenter } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(canToCenter, true);
});

test('【旧データ限定・種別ベースへ統一】convertMenuFlags: {labeled:false, discipline:STRUCT}の異常値はcanToCenter=false（移行前はlabeled不問でtrueだった）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  const { canToCenter } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(canToCenter, false, '移行前のcanToCenter（centerLineKind(cl)===\'struct\'のみ・labeled不問）ではtrueだったが、isConvertSubject（isGridCenterLine＝labeled必須）でfalseになる');
});

test('convertMenuFlags: 平面モード以外ならcanToCenter=false（主体は妥当でも文脈がfloorplan限定）', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const { canToCenter } = convertMenuFlags(graph, { appMode: 'structure', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(canToCenter, false);
});

test('convertMenuFlags: menuContextがCENTER_LINEでなければcanToCenter=false（clがnullでも短絡評価でisConvertSubjectを呼ばない）', () => {
  const graph = makeGraph();
  const { canToCenter } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.WALL, cl: null, clEndpoint: null });
  assert.equal(canToCenter, false);
});

// ---- isLastGridOnAxis（canToCenter・cl-del両方のグレー化に使う共有値。appMode条件を付けない）----

test('convertMenuFlags: isDemoteSubjectが真ならappModeを問わずisLastGridOnAxisを算出する（cl-delはfloorplan限定ではないため）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // VERTICAL軸唯一の通り芯
  const result = convertMenuFlags(graph, { appMode: 'structure', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(result.canToCenter, false, 'appMode!==floorplanのためcanToCenterはfalse');
  assert.equal(result.isLastGridOnAxis, true, 'isLastGridOnAxisはappMode条件を付けずに算出される（軸最後の1本）');
});

test('convertMenuFlags: 同軸に他の通り芯があればisLastGridOnAxis=false', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸に他の通り芯
  const { isLastGridOnAxis } = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(isLastGridOnAxis, false);
});

test('convertMenuFlags: isDemoteSubjectが偽（中心線・menuContext不一致等）ならisLastGridOnAxisはundefined', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const onCenterLine = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });
  assert.equal(onCenterLine.isLastGridOnAxis, undefined, '中心線（isConvertSubject(cl,\'demote\')=false）はundefined');

  const wrongContext = convertMenuFlags(graph, { appMode: 'floorplan', menuContext: CONTEXT.WALL, cl: null, clEndpoint: null });
  assert.equal(wrongContext.isLastGridOnAxis, undefined, 'menuContext!==CENTER_LINEはundefined（clがnullでも例外にならない）');
});

// ---- RADIAL（R）はisConvertSubject自体がV/Hゲートで除外する（ヒットテスト到達不能の二重防御）----

test('convertMenuFlags: RADIAL(R)の中心線・通り芯はcanToGrid/canToCenterともfalse（ヒットテストでも到達しないが述語で二重に除外する）', () => {
  const graph = makeGraph();
  const radialCenter = graph.addCenterLine(CenterLineType.RADIAL, 30, { labeled: false, discipline: Discipline.ARCH });
  const radialGrid    = graph.addCenterLine(CenterLineType.RADIAL, 30, { labeled: true, discipline: Discipline.STRUCT });

  const forEndpoint = convertMenuFlags(graph, {
    appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE_ENDPOINT, cl: null, clEndpoint: { cl: radialCenter, side: 'lo' },
  });
  assert.equal(forEndpoint.canToGrid, false);

  const forCenterLine = convertMenuFlags(graph, {
    appMode: 'floorplan', menuContext: CONTEXT.CENTER_LINE, cl: radialGrid, clEndpoint: null,
  });
  assert.equal(forCenterLine.canToCenter, false);
  assert.equal(forCenterLine.isLastGridOnAxis, undefined, 'isDemoteSubjectが偽（RADIALはisConvertSubjectでfalse）のためundefined');
});

// convertMenuFlagsはisConvertSubject(cl, 'promote'/'demote')を固定direction文字列で呼ぶため、
// direction由来のthrowはここでは起こりえない——起こりうるのはclそのものがfalsyなのに
// isConvertSubjectへ渡ってしまう実装ミスのみ。短絡評価でそれを防いでいることを上記テストで確認済み。

test('convertMenuFlags: 未知のappModeでもthrowしない（appMode===\'floorplan\'の単純な文字列比較のみで、assertKnownMode等の検証は行わない）', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  const result = convertMenuFlags(graph, { appMode: 'renovation', menuContext: CONTEXT.CENTER_LINE, cl, clEndpoint: null });

  assert.equal(result.canToGrid, false);
  assert.equal(result.canToCenter, false, 'appMode!==\'floorplan\'のためfalse（未知appModeでもthrowせず単に条件不成立扱い）');
  assert.equal(result.isLastGridOnAxis, true, 'isLastGridOnAxisはappMode条件を持たないため通常どおり算出される（軸最後の1本）');
});

// ---- 【不変条件】本番配線（usePointerInteraction.js・transform/centerLineConvert.js）----
// テストがヘルパ（convertMenuFlags/isConvertSubject）を直接呼ぶだけでは、呼び出し側が実際に
// それを使っているかは検証できない（team-lessons「回帰テストがトートロジー化する」）。

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

test('【不変条件】usePointerInteraction.js: clMenuGating.jsからconvertMenuFlagsをimportし、buildMenuStateの引数にスプレッドで渡す', () => {
  const src = readSrc('./usePointerInteraction.js');
  assert.ok(/import \{ convertMenuFlags \} from '\.\/clMenuGating\.js';/.test(src),
    'usePointerInteraction.js が clMenuGating.js から convertMenuFlags を import していない');
  assert.ok(/buildMenuState\(appMode,\s*\{[\s\S]{0,600}?\.\.\.convertMenuFlags\(graph,\s*\{\s*appMode,\s*menuContext,\s*cl,\s*clEndpoint\s*\}\),/.test(src),
    'buildMenuState(...) の引数に ...convertMenuFlags(graph, { appMode, menuContext, cl, clEndpoint }) のスプレッドが無い');
});

test('【不変条件】usePointerInteraction.js: centerLineKindを@coreからimportしていない（変換ガードの種別比較を個別に持たない）', () => {
  const src = readSrc('./usePointerInteraction.js');
  assert.ok(!/\bcenterLineKind\b/.test(src), 'centerLineKind への参照が残っている（clMenuGating.js経由に移行しきれていない疑い）');
});

test('【不変条件】usePointerInteraction.js: CL移動中pointermoveの梁芯専用スナップ呼び分けがusesBeamAxisMoveSnap(cl, appMode)を使う', () => {
  const src = readSrc('./usePointerInteraction.js');
  assert.ok(/import \{ usesBeamAxisMoveSnap \} from '\.\.\/core\/centerLineKindPolicy\.js';/.test(src),
    'usePointerInteraction.js が centerLineKindPolicy.js から usesBeamAxisMoveSnap を import していない');
  assert.ok(/usesBeamAxisMoveSnap\(cl,\s*appMode\)\s*\n?\s*\?\s*findBeamAxisMoveSnap/.test(src),
    'CL移動中pointermoveの梁芯専用スナップ呼び分けが usesBeamAxisMoveSnap(cl, appMode) を使っていない');
});

test('【不変条件】transform/centerLineConvert.js: 昇格・降格ガードの両方がisConvertSubject(cl, direction)を呼ぶ', () => {
  const src = readSrc('../transform/centerLineConvert.js');
  assert.ok(/isConvertSubject\(cl,\s*'promote'\)/.test(src), 'checkPromoteToGridGuards が isConvertSubject(cl, \'promote\') を呼んでいない');
  assert.ok(/isConvertSubject\(cl,\s*'demote'\)/.test(src), 'checkDemoteToCenterGuards が isConvertSubject(cl, \'demote\') を呼んでいない');
});
