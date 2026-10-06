// finish/clEccentricity.js applyCLEccentricity のコーナー追従: 直交壁の端が追従するのは、端の offset が
// 偏芯を適用する壁 w の「変更前の axisOffset」と一致する端（コーナーマップ規約どおりの隅の端）だけ。
// 閾値方式（|offset| ≤ 250 のとき追従）は、偏芯を大きく適用（offset が 250 超）→0 に戻すと隅の端がそのまま残る
// （HEAD は 57.5 へ戻る）回帰を作ったため、変更前の axisOffset との一致に改めた。階段の開口で切った端
// （端CLのままだが offset は開口の座標までの距離）は一致しないので追従しない。
// IDB は最小の fake を globalThis に置く（eccentricityExitNoWrite.test.js と同じ。ファイルごとに別プロセス）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from './finishBoundary.js';
import { loadMaterialMap } from './wallRegeneration.js';
import { applyCLEccentricity } from './clEccentricity.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) { const req = new FakeRequest(); this.data.set(value.planeId ?? value.projectId ?? value.key, value); queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } })); return req; }
    get(key) { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } })); return req; }
    getAll() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: [...this.data.values()] } })); return req; }
  }
  const stores = new Map(['floors', 'projects', 'savedFloors', 'catalogs'].map(n => [n, new FakeStore()]));
  const fakeDb = { objectStoreNames: { contains: (n) => stores.has(n) }, transaction: (n) => ({ objectStore: () => stores.get(n) }) };
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
}
installFakeIndexedDB();

const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 3000x3000 の部屋 A（上）と B（下）が y=3000 の間仕切りで接する1階建て。仕上げ脱出で壁を生成して返す。
async function setup() {
  const project = new Project('proj', 'test');
  const g = project.addPlane(0, '1階', 'p1').graph;
  project.activePlaneId = 'p1';
  const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0, ARCH), x1 = g.addCenterLine(CenterLineType.VERTICAL, 3000, ARCH);
  const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH), ym = g.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 6000, ARCH);
  const roomA = g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${ym.id}`]), '部屋A');
  g.addRoom(new Set([`${x0.id}:${ym.id}:${x1.id}:${y1.id}`]), '部屋B');
  g.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const orig = floorSwapManager.peek;
  floorSwapManager.peek = async () => g;
  const materialMap = await loadMaterialMap();
  try {
    await runFinishEntryBoundary(g, project);
    await runFinishExitBoundary(g, project, { materialMap, stairUnderRooms: () => [] }, { goingToStructure: false });
  } finally {
    floorSwapManager.peek = orig;
  }
  // 部屋Aの側面の壁（左・x=0）。y=3000（間仕切り）側の端が隅
  const side = g.walls.find(w => roomA.generatedWallIds.has(w.id) && w.isVertical && w.axisCL === x0);
  return { g, ym, side, materialMap };
}

function applyValue(g, ym, materialMap, value) {
  g.setCLEccentricity(ym.id, { mode: 'center', value, side: 1, backing: '' });
  applyCLEccentricity(g, ym.id, { materialMap });
}

test('偏芯（center・value=400）を適用→0 に戻すと、隅の壁の端は元の offset に戻る（閾値方式では 327.5 のまま残った回帰）', async () => {
  const { g, ym, side, materialMap } = await setup();
  assert.ok(side, '前提: 部屋Aの左の壁がある');
  const end = side.clEnd === ym ? 'endOffset' : 'startOffset';
  assert.ok(side.clEnd === ym || side.clStart === ym, '前提: 左の壁の端が間仕切りCLで終わる');
  const initial = side[end];
  applyValue(g, ym, materialMap, 400);
  assert.notEqual(side[end], initial, '前提: 偏芯の適用で隅の端が追従した');
  assert.ok(Math.abs(side[end]) > 250, `前提: 追従後の offset は旧い閾値250を超える（実測 initial=${initial} → ${side[end]}）`);
  applyValue(g, ym, materialMap, 0);
  assert.ok(Math.abs(side[end] - initial) < 1e-6, `隅の端は元の offset（${initial}）へ戻る（実測 ${side[end]}）`);
});

test('階段の開口で切った端（offset が変更前の axisOffset と一致しない端）は、偏芯の適用で追従して動かない', async () => {
  const { g, ym, side, materialMap } = await setup();
  const end = side.clEnd === ym ? 'endOffset' : 'startOffset';
  const cut = side[end] > 0 ? side[end] - 900 : side[end] + 900; // 開口の座標までの距離（隅の offset とは別の値）
  side[end] = cut;
  applyValue(g, ym, materialMap, 400);
  assert.equal(side[end], cut, '切った端は動かない');
  applyValue(g, ym, materialMap, 0);
  assert.equal(side[end], cut, '解除でも動かない');
});
