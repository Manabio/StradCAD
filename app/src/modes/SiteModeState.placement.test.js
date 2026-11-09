// SiteModeState の配置図（屋根伏せ図＋図芯合わせした敷地の外周）の状態。
// 他階の解決は IDB（floorSwapManager.peek）経由のため、その1点だけ差し替える（FacadeModeState.test.js と同じ作法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import {
  SITE_PLACEMENT_EMPTY_MESSAGE, SITE_PLACEMENT_READ_ERROR_MESSAGE, SITE_PLACEMENT_LOADING_MESSAGE,
  SitePlacementCenterSource,
} from '../core/constants.js';
import { SiteModeState } from './SiteModeState.js';

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

/** n 階建て（p1..pn・3000 ピッチ）。在来木造（最上階に主屋根の region ができる）。 */
function makeProject(n, { activeId = 'p2' } = {}) {
  const project = new Project('proj', 'test');
  for (let i = 1; i <= n; i++) {
    const { graph } = project.addPlane((i - 1) * 3000, `${i}階`, `p${i}`);
    makeRectRoom(graph, 0, 0, 6000 + i * 1000, 4000, `${i}F`);
  }
  project.activePlaneId = activeId;
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  return project;
}

/** peek を差し替えて fn を実行する（finally で戻す）。 */
async function withPeek(peek, fn) {
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = peek;
  try { return await fn(); } finally { floorSwapManager.peek = orig; }
}

/** 外から解決できる Promise。 */
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** 三斜の線1本・長方形1枚を持つ敷地を project.site に作る。 */
function seedSite(project) {
  const site = project.site;
  const a = site.addPoint(0, 0), b = site.addPoint(5000, 0);
  const line = site.addLine(a, b);
  site.addRect(10000, 0, 3000, 2000);
  return line;
}

test('setShowPlacement(true): 全採用階を読み（自階は peek しない）、屋根の線と図芯合わせ済みの配置図ができる。通知文なし', async () => {
  const project = makeProject(3);
  seedSite(project);
  const peeked = [];
  await withPeek(async plane => { peeked.push(plane.id); return project.graphMap.get(plane.id); }, async () => {
    const sm = new SiteModeState(project.site, project);
    assert.equal(sm.placementView, null, '非表示のあいだは配置図なし');
    await sm.setShowPlacement(true);
    assert.deepEqual(peeked.sort(), ['p1', 'p3'], '自階（p2）は peek せず、他の採用階は全部 peek する');
    assert.equal(sm.showPlacement, true);
    assert.equal(sm.placementLoading, false);
    assert.equal(sm.placementRoof.readFailed, false);
    const view = sm.placementView;
    assert.ok(view, '配置図が組める');
    assert.ok(view.roofLines.length > 0, '最上階（p3）の主屋根の線が出る');
    assert.ok(view.roofLines.every(l => l.key.startsWith('p3/')), '屋根があるのは最上階 p3 だけ（下屋なし）');
    assert.equal(view.centerSource, SitePlacementCenterSource.ROOF);
    assert.equal(sm.placementMessage, null);
    sm.dispose();
  });
});

test('setShowPlacement(true): 選択・入力・描画中の線を捨て、inputSubMode は null（非表示に戻すと subMode に戻る）', async () => {
  const project = makeProject(3);
  const line = seedSite(project);
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const sm = new SiteModeState(project.site, project);
    sm.selectLine(line.id); // 三斜: 選択＋入力状態
    sm.startSiteDraw(10, 20);
    assert.ok(sm.selectedLineId && sm.inputState && sm.siteDrawState);
    assert.equal(sm.inputSubMode, 'sansha');
    const p = sm.setShowPlacement(true);
    // 読込みの完了を待たず、同期で入力が止まる
    assert.equal(sm.selectedLineId, null);
    assert.equal(sm.inputState, null);
    assert.equal(sm.rectInputState, null);
    assert.equal(sm.selectedRectEdge, null);
    assert.equal(sm.siteDrawState, null);
    assert.equal(sm.inputSubMode, null);
    assert.equal(sm.placementMessage, SITE_PLACEMENT_LOADING_MESSAGE, '読込み中は通知文');
    await p;
    assert.equal(sm.subMode, 'sansha', 'subMode 自体は変えない');
    await sm.setShowPlacement(false);
    assert.equal(sm.inputSubMode, 'sansha');
    assert.equal(sm.placementView, null);
    assert.equal(sm.placementRoof, null);
    assert.equal(sm.placementMessage, null);
    sm.dispose();
  });
});

test('【失敗系】setShowPlacement(true): 他階の peek が例外でも reject せず、残りの階で描いて readFailed・通知文は読込みエラー', async () => {
  const project = makeProject(3);
  seedSite(project);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withPeek(async plane => {
      if (plane.id === 'p1') throw new Error('idb boom');
      return project.graphMap.get(plane.id);
    }, async () => {
      const sm = new SiteModeState(project.site, project);
      await sm.setShowPlacement(true); // reject しない
      assert.equal(sm.placementRoof.readFailed, true);
      assert.ok(sm.placementView.roofLines.length > 0, '読めた階（p3）の屋根は描く');
      assert.equal(sm.placementMessage, SITE_PLACEMENT_READ_ERROR_MESSAGE);
      sm.dispose();
    });
  } finally { console.warn = warn; }
});

test('【失敗系】setShowPlacement(true): 屋根の解決で例外の階があっても reject せず、その階を飛ばして readFailed', async () => {
  const project = makeProject(3);
  seedSite(project);
  // peek の await が then を読むので then だけは素通しにし、屋根の解決（leanToPlanRegions）が graph を読んだ時に初めて投げる
  const boom = new Proxy({}, { get(_t, key) { if (key === 'then') return undefined; throw new Error('graph boom'); } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    let peeked = 0;
    await withPeek(async plane => { peeked++; return plane.id === 'p1' ? boom : project.graphMap.get(plane.id); }, async () => {
      const sm = new SiteModeState(project.site, project);
      await sm.setShowPlacement(true);
      assert.equal(sm.placementRoof.readFailed, true);
      assert.deepEqual(sm.placementRoof.floors.map(f => f.planeId), ['p2', 'p3']);
      assert.equal(peeked, 2, '他階 p1・p3 の peek は両方成功している（peek の失敗ではなく屋根の解決の失敗）');
      assert.equal(sm.placementMessage, SITE_PLACEMENT_READ_ERROR_MESSAGE);
      sm.dispose();
    });
  } finally { console.warn = warn; }
});

test('【失敗系】project 無し（旧形式の生成）でも reject せず、屋根なし＝通知文「屋根伏図がありません」・図芯合わせなし', async () => {
  const project = makeProject(1);
  seedSite(project);
  const sm = new SiteModeState(project.site); // project 引数なし
  await sm.setShowPlacement(true);
  assert.equal(sm.placementRoof.readFailed, false);
  assert.equal(sm.placementView.roofEmpty, true);
  assert.equal(sm.placementView.centerSource, SitePlacementCenterSource.NONE);
  assert.equal(sm.placementMessage, SITE_PLACEMENT_EMPTY_MESSAGE);
  sm.dispose();
});

test('【失敗系】読込みの await 中に dispose() すると、結果を捨てる（placementRoof は null のまま）', async () => {
  const project = makeProject(3);
  const gate = deferred();
  let fired = 0;
  await withPeek(async plane => { fired++; await gate.promise; return project.graphMap.get(plane.id); }, async () => {
    const sm = new SiteModeState(project.site, project);
    const p = sm.setShowPlacement(true);
    sm.dispose();
    gate.resolve();
    await p;
    assert.equal(fired, 2, '他階 p1・p3 の peek が実際に走った（空振りでない）');
    assert.equal(sm.placementRoof, null);
  });
});

test('【失敗系】読込みの await 中に非表示へ戻すと、結果を捨てる（placementRoof は null・通知文なし）', async () => {
  const project = makeProject(3);
  const gate = deferred();
  let fired = 0;
  await withPeek(async plane => { fired++; await gate.promise; return project.graphMap.get(plane.id); }, async () => {
    const sm = new SiteModeState(project.site, project);
    const p = sm.setShowPlacement(true);
    assert.equal(sm.placementLoading, true);
    await sm.setShowPlacement(false);
    assert.equal(sm.placementLoading, false);
    gate.resolve();
    await p;
    assert.equal(fired, 2);
    assert.equal(sm.showPlacement, false);
    assert.equal(sm.placementRoof, null);
    assert.equal(sm.placementMessage, null);
    sm.dispose();
  });
});

test('【失敗系】表示→非表示→表示の連打: 古い世代の読込みが後から戻っても新しい結果を上書きしない', async () => {
  const project = makeProject(3);
  const staleGate = deferred();
  let calls = 0;
  await withPeek(async plane => {
    // 最初の表示（世代1）の peek 2 本だけ遅らせ、2回目の表示（世代3）は即座に返す
    if (++calls <= 2) await staleGate.promise;
    return project.graphMap.get(plane.id);
  }, async () => {
    const sm = new SiteModeState(project.site, project);
    const p1 = sm.setShowPlacement(true);
    await sm.setShowPlacement(false);
    await sm.setShowPlacement(true);
    assert.equal(sm.placementLoading, false, '2回目の読込みは完了している');
    const fresh = sm.placementRoof;
    assert.ok(fresh);
    staleGate.resolve();
    await p1;
    assert.equal(calls, 4, '古い世代の peek 2 本と新しい世代の peek 2 本が実際に走った');
    assert.equal(sm.placementRoof, fresh, '古い結果で上書きしない');
    assert.equal(sm.placementLoading, false);
    sm.dispose();
  });
});

test('setShowPlacement: 同じ値への切替は何もしない（再読込みしない）', async () => {
  const project = makeProject(3);
  let calls = 0;
  await withPeek(async plane => { calls++; return project.graphMap.get(plane.id); }, async () => {
    const sm = new SiteModeState(project.site, project);
    await sm.setShowPlacement(false);
    assert.equal(calls, 0);
    await sm.setShowPlacement(true);
    await sm.setShowPlacement(true);
    assert.equal(calls, 2, '2回目の true では再読込みしない');
    sm.dispose();
  });
});

test('屋根なし・通り芯あり: 図芯の基準は通り芯の範囲の中心（GRID）で、屋根が無いので通知文は「屋根伏図がありません」', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1'); // 部屋なし＝屋根なし
  project.activePlaneId = 'p1';
  // 通り芯（全階共有の structGraph）: X=12000,18000／Y=30000,34000（原点から離す）
  for (const v of [12000, 18000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT });
  for (const v of [30000, 34000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT });
  seedSite(project);
  const sm = new SiteModeState(project.site, project);
  await sm.setShowPlacement(true);
  const view = sm.placementView;
  assert.equal(view.roofEmpty, true);
  assert.equal(view.centerSource, SitePlacementCenterSource.GRID);
  assert.deepEqual(view.buildingCenter, { x: 15000, y: 32000 }, '通り芯の範囲 X12000〜18000・Y30000〜34000 の中心');
  assert.equal(view.siteTransform.tx, 15000 - view.siteCenter.x);
  assert.equal(view.siteTransform.ty, 32000 - view.siteCenter.y);
  assert.equal(sm.placementMessage, SITE_PLACEMENT_EMPTY_MESSAGE);
  sm.dispose();
});

test('【失敗系】通知文の優先: 他の階を全部読めず自階に屋根も無いとき、「屋根伏図がありません」でなく読込みエラーを出す', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.addPlane(3000, '2階', 'p2'); // どちらも部屋なし＝屋根なし
  project.activePlaneId = 'p2';
  seedSite(project);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withPeek(async () => { throw new Error('idb boom'); }, async () => {
      const sm = new SiteModeState(project.site, project);
      await sm.setShowPlacement(true);
      assert.equal(sm.placementRoof.readFailed, true);
      assert.equal(sm.placementView.roofEmpty, true, '屋根の線は1本も無い（EMPTY の条件も成立している）');
      assert.equal(sm.placementMessage, SITE_PLACEMENT_READ_ERROR_MESSAGE);
      sm.dispose();
    });
  } finally { console.warn = warn; }
});

test('通り芯の写し: placementRoof.gridLines は本数・昇順・ラベル付き（中心線は含めない）で、配置図の grid に線と寸法が出る。図芯の基準は据え置き', async () => {
  const project = makeProject(3);
  seedSite(project);
  const st = { labeled: true, discipline: Discipline.STRUCT };
  for (const v of [12000, 9000, 15000]) project.structGraph.addCenterLine(CenterLineType.VERTICAL, v, st); // 昇順でない順
  for (const v of [-2000, 1000]) project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, v, st);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 13000, { labeled: false, discipline: Discipline.ARCH }); // 中心線は通り芯でない
  await withPeek(async plane => project.graphMap.get(plane.id), async () => {
    const sm = new SiteModeState(project.site, project);
    await sm.setShowPlacement(true);
    const lines = sm.placementRoof.gridLines;
    assert.deepEqual(lines.map(l => [l.centerLineType, l.value, l.label]), [
      [CenterLineType.VERTICAL, 9000, 'X1'], [CenterLineType.VERTICAL, 12000, 'X2'], [CenterLineType.VERTICAL, 15000, 'X3'],
      [CenterLineType.HORIZONTAL, -2000, 'Y2'], [CenterLineType.HORIZONTAL, 1000, 'Y1'], // Y は下（y 大）から Y1
    ]);
    const view = sm.placementView;
    assert.equal(view.grid.lines.length, 5);
    assert.equal(view.grid.rows.length, 3, 'X=間隔＋全長・Y=間隔');
    assert.equal(view.centerSource, SitePlacementCenterSource.ROOF);
    sm.dispose();
  });
});

test('【失敗系】通り芯の写し: project 無しは gridLines が [] で reject せず、配置図の grid は空', async () => {
  const project = makeProject(1);
  seedSite(project);
  const sm = new SiteModeState(project.site); // project 引数なし
  await sm.setShowPlacement(true);
  assert.deepEqual(sm.placementRoof.gridLines, []);
  assert.deepEqual(sm.placementView.grid.lines, []);
  assert.deepEqual(sm.placementView.grid.rows, []);
  sm.dispose();
});

test('【失敗系】通り芯の写し: 読込み全体が例外（catch 経路）でも reject せず、gridLines は [] で readFailed', async () => {
  const project = makeProject(2);
  seedSite(project);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 9000, { labeled: true, discipline: Discipline.STRUCT });
  const broken = new Proxy(project, { get(t, k) { if (k === 'planes') throw new Error('planes boom'); return Reflect.get(t, k, t); } });
  const err = console.error;
  console.error = () => {};
  try {
    const sm = new SiteModeState(project.site, broken);
    await sm.setShowPlacement(true); // reject しない
    assert.equal(sm.placementRoof.readFailed, true);
    assert.deepEqual(sm.placementRoof.gridLines, []);
    assert.deepEqual(sm.placementView.grid.lines, []);
    assert.equal(sm.placementMessage, SITE_PLACEMENT_READ_ERROR_MESSAGE);
    sm.dispose();
  } finally { console.error = err; }
});

test('最上階の主屋根の線の外接矩形の中心へ敷地の図芯を合わせる（原点から離した建物・dx,dy を数値で検証）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  makeRectRoom(graph, 20000, 30000, 26000, 34000, '1F'); // 原点から離す
  project.activePlaneId = 'p1';
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  seedSite(project);
  const sm = new SiteModeState(project.site, project);
  await sm.setShowPlacement(true);
  const view = sm.placementView;
  assert.equal(view.centerSource, SitePlacementCenterSource.ROOF);
  // 期待値は出力の線から独立に求める（屋根の線の外接矩形・敷地の外周の外接矩形）
  const ext = lists => {
    const xs = lists.flatMap(p => p.filter((_, i) => i % 2 === 0)), ys = lists.flatMap(p => p.filter((_, i) => i % 2 === 1));
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  };
  const roofC = ext(view.roofLines.map(l => l.points));
  const siteC = ext(view.siteSegments.map(s => s.points));
  assert.deepEqual(view.buildingCenter, roofC);
  assert.deepEqual(view.siteCenter, siteC);
  assert.ok(Math.abs(roofC.x - 23000) < 1000 && Math.abs(roofC.y - 32000) < 1000, '屋根の図芯は建物（X20000〜26000・Y30000〜34000）の中心付近＝原点から離れている');
  assert.equal(view.siteTransform.tx, roofC.x - siteC.x);
  assert.equal(view.siteTransform.ty, roofC.y - siteC.y);
  sm.dispose();
});
