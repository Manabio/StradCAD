// 階設定表の確定（HEIGHTS）の undo/redo 往復（階設定表 S5）。App.jsx の withFloorOpUndo が使う部品
// （collectPlaneMetas／collectProjectLevels／diffFloorOpSnapshot／applyPlaneMetas／applyProjectLevels／
// followRoofPlaneToTop）を App.jsx と同じ順で呼び、「OK → undo → redo」で各階の elevation・最上階の階高・GL・
// 屋根専用平面の elevation が往復することを本物の Project で確かめる（App.jsx 自体は import できないため、
// 配線は App.wiring.floorHeights.test.js のソース走査で固定）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from './core.js';
import { applyFloorOrderChange, floorOrderFollowers, FLOOR_ORDER_KIND } from './floorOrderChange.js';
import { computeFloorHeightEdit, resolveTopStoryHeightMm } from './floorHeights.js';
import {
  collectPlaneMetas, applyPlaneMetas, collectProjectLevels, applyProjectLevels, diffFloorOpSnapshot,
} from './floorOps.js';
import { followRoofPlaneToTop } from './structural/roofPlane.js';

/** p1(0)・p2(3000)・p3(6000)・屋根専用平面(6001, p3 の直上)。GL=0。 */
function makeProject() {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(6001, '小屋伏', 'roof', 3, 1, false, null, 0, true, 'p3');
  project.activePlaneId = 'p1';
  return project;
}

const ui = { notify() {}, switchFloor: async () => true, onFloorSyncChanged() {} };
const roofOnly = floorOrderFollowers.filter(f => f.name === 'roofPlaneHeight');
const state = (project) => ({
  elevations: Object.fromEntries(project.planes.map(p => [p.id, p.elevation])),
  top: project.planes[project.planes.length - 1].topStoryHeightMm,
  gl: project.glBelow1FlMm,
  roof: project.roofPlane.elevation,
});

/** withFloorOpUndo と同じ順の「OK」: 採取 → run（GL → applyFloorOrderChange HEIGHTS）→ 採取 → diff。 */
async function confirmLikeApp(project, draft) {
  const edit = computeFloorHeightEdit(project.planes, draft, resolveTopStoryHeightMm(project), project.glBelow1FlMm);
  assert.ok(edit.ok);
  const metasBefore = collectPlaneMetas(project);
  const levelsBefore = collectProjectLevels(project);
  if (edit.glBelow1FlMm !== null) project.setGlBelow1FlMm(edit.glBelow1FlMm);
  await applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.HEIGHTS, updates: edit.updates, ui }, roofOnly);
  const metasAfter = collectPlaneMetas(project);
  const levelsAfter = collectProjectLevels(project);
  const bytes = (metas) => new Map(metas.map(m => [m.id, null])); // 階のバイト列は不変（IDB 未保存の階）
  const diff = diffFloorOpSnapshot({ before: bytes(metasBefore), after: bytes(metasAfter), metasBefore, metasAfter, levelsBefore, levelsAfter });
  return { metasBefore, metasAfter, levelsBefore, levelsAfter, diff };
}

// App.jsx の undoFloorOp／redoFloorOp の状態部分と同じ順。
function undo(project, { metasBefore, levelsBefore }) {
  applyPlaneMetas(project, metasBefore);
  applyProjectLevels(project, levelsBefore);
  followRoofPlaneToTop(project);
}
function redo(project, { metasAfter, levelsAfter }) {
  applyPlaneMetas(project, metasAfter);
  applyProjectLevels(project, levelsAfter);
  followRoofPlaneToTop(project);
}

test('OK → undo → redo: 階高（2階 +200）で3階と屋根専用平面の elevation、GL が往復する', async () => {
  const project = makeProject();
  const s0 = state(project);
  const c = await confirmLikeApp(project, { heights: { p2: 3200 }, glBelow1FlMm: 500 });
  const s1 = state(project);
  assert.deepEqual(s1.elevations, { p1: 0, p2: 3000, p3: 6200 });
  assert.equal(s1.gl, 500);
  assert.equal(s1.roof, 6201);
  assert.ok(c.diff.hasChanges);

  undo(project, c);
  assert.deepEqual(state(project), s0);

  redo(project, c);
  assert.deepEqual(state(project), s1);
});

test('OK → undo → redo: 最上階の階高(topStoryHeightMm)が往復する', async () => {
  const project = makeProject();
  const s0 = state(project);
  assert.equal(s0.top, 0); // 未設定（0）。読む側が legacy 値へ解決する
  const c = await confirmLikeApp(project, { heights: { p3: 2600 } });
  const s1 = state(project);
  assert.equal(s1.top, 2600);
  assert.ok(c.diff.hasChanges);
  undo(project, c);
  assert.deepEqual(state(project), s0);
  redo(project, c);
  assert.deepEqual(state(project), s1);
});

test('GL だけの変更も undo エントリになる（levelsChanged。メタは不変）。undo/redo で GL が往復する', async () => {
  const project = makeProject();
  const c = await confirmLikeApp(project, { glBelow1FlMm: '-300' });
  assert.equal(project.glBelow1FlMm, -300);
  assert.equal(c.diff.metasChanged, false);
  assert.equal(c.diff.levelsChanged, true);
  assert.equal(c.diff.hasChanges, true);
  undo(project, c);
  assert.equal(project.glBelow1FlMm, 0);
  redo(project, c);
  assert.equal(project.glBelow1FlMm, -300);
});

test('【失敗系】変更が何も無い OK（編集値＝現在値）は undo を積まない（hasChanges=false）', async () => {
  const project = makeProject();
  const c = await confirmLikeApp(project, { heights: { p2: 3000 }, glBelow1FlMm: 0 });
  assert.equal(c.diff.hasChanges, false);
});

test('【失敗系】屋根専用平面の追従が無いと undo 後も屋根が新しい高さのまま残る（M1 の再現）', async () => {
  const project = makeProject();
  const c = await confirmLikeApp(project, { heights: { p2: 3200 } });
  assert.equal(project.roofPlane.elevation, 6201);
  applyPlaneMetas(project, c.metasBefore);          // メタだけ戻す（追従なし）
  assert.equal(project.planeMap.get('p3').elevation, 6000);
  assert.equal(project.roofPlane.elevation, 6201);  // 古いまま
  followRoofPlaneToTop(project);                    // App.jsx の undo/redo が最後に呼ぶ追従
  assert.equal(project.roofPlane.elevation, 6001);
});

test('屋根専用平面が無い文書でも追従は何もしない（undo/redo が落ちない）', async () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.activePlaneId = 'p1';
  const edit = computeFloorHeightEdit(project.planes, { heights: { p1: 3200 } }, resolveTopStoryHeightMm(project), 0);
  const metasBefore = collectPlaneMetas(project);
  applyPlaneMetas(project, edit.updates);
  assert.equal(followRoofPlaneToTop(project), false);
  applyPlaneMetas(project, metasBefore);
  assert.equal(followRoofPlaneToTop(project), false);
  assert.equal(project.planeMap.get('p2').elevation, 3000);
});
