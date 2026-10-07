// 在来木造・折返し階段の隔て壁（S2）の実データ通し probe。実アプリの操作列（全階を下から
// 仕上げ突入→脱出→構造の全階再計算が収束するまで）を回し、壁・柱・梁の署名（id を除く）を JSON へ出す。
// 隔て壁（isStairPartitionWall が真の壁。基準側の ref にこの関数は無いので壁の座標で判定する）を
// 別枠にして、(a) 隔て壁以外の壁集合 (b) 柱・梁の署名 が S2 の有無で変わらないことを、同じ probe を
// 基準コミットのコピーでも走らせて比べる（compare は out/ の2つの JSON を diff するだけ）。
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/stairPartitionWallsProbe.mjs [入力.stq] [出力名]
//   既定: D:/tatsuya/Download/moku4.stq・出力 out/stairPartitionWalls-<名>.json
// 【lint対象外】.mjs は eslint.config.js の対象外。
import fs from 'node:fs';
import path from 'node:path';
import { loadDocument } from './loadDoc.mjs';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { runFinishEntryBoundary, runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { sweepUntilConverged } from './sweepOrder.mjs';

const src = process.argv[2] ?? 'D:/tatsuya/Download/moku4.stq';
const tag = process.argv[3] ?? 'cur';
const outDir = path.join(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// finishExitEccProbe.mjs と同じ最小のインメモリ IndexedDB シム
function installFakeIndexedDB() {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) { const req = new FakeRequest(); this.data.set(value.planeId ?? value.projectId, value); queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } })); return req; }
    get(key) { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } })); return req; }
  }
  class FakeDB {
    constructor() { this.stores = new Map(); this.objectStoreNames = { contains: (n) => this.stores.has(n) }; for (const n of ['floors', 'projects', 'savedFloors']) this.stores.set(n, new FakeStore()); }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
}
installFakeIndexedDB();

const { project } = loadDocument(src);
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
const materialMap = await loadMaterialMap();
const r = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

for (const plane of project.planes) {
  const graph = project.graphMap.get(plane.id);
  project.activePlaneId = plane.id;
  await runFinishEntryBoundary(graph, project);
  // fmode.stairUnderRooms は本番経路では使われない（finishBoundary は resolveStairContext で2aを自分で解決する）。
  // ここで2aを無効にしているわけではない。
  await runFinishExitBoundary(graph, project, { materialMap, stairUnderRooms: () => [] }, { goingToStructure: false });
}
await sweepUntilConverged(project, 'desc', 8, () => {});

// 隔て壁の座標署名: 軸±57.5 で backingDepth 90 / 0・wallFinish 12.5・非外壁・部屋壁
const isPartitionLike = (w) => w.isRoomWall && !w.isExteriorWall && w.wallFinish === 12.5 && Math.abs(Math.abs(w.axisOffset) - 57.5) < 0.01
  && w.backingOffset === 0 && (w.backingDepth === 90 || w.backingDepth === 0);
const out = {};
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  const sig = (w) => [w.isVertical ? 'V' : 'H', r(w.axisCL.effectiveValue), r(w.axisOffset), r(Math.min(w.coord1, w.coord2)), r(Math.max(w.coord1, w.coord2)),
    r(w.backingOffset), r(w.backingDepth), r(w.wallFinish), w.finishSide, r(w.bandOffset), w.isExteriorWall, w.isRoomWall].join('|');
  const partition = g.walls.filter(isPartitionLike).map(sig).sort();
  const others = g.walls.filter(w => !isPartitionLike(w)).map(sig).sort();
  const cols = g.columns.map(c => [c.role, c.materialType, c.sectionDefId, c.memberNo, r(c.verticalCL.effectiveValue), r(c.horizontalCL.effectiveValue)].join('|')).sort();
  const beams = g.beams.map(b => [b.role, b.materialType, b.sectionDefId, b.memberNo, b.isVertical ? 'V' : 'H', r(b.axisCL.effectiveValue), r(b.clStart.effectiveValue), r(b.clEnd.effectiveValue), b.beamType ?? ''].join('|')).sort();
  out[plane.name] = { partition, others, cols, beams };
  console.log(`[${plane.name}] 壁(隔て壁以外)=${others.length} 隔て壁=${partition.length} 柱=${cols.length} 梁=${beams.length}`);
}
const file = path.join(outDir, `stairPartitionWalls-${tag}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log('wrote', file);
