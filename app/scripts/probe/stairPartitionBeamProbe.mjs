// 在来木造・折返し階段の隔て梁（隔て壁 S5。role:'partitionBeam'）の実データ通し probe。実アプリの操作列
// （全階を下から仕上げ突入→脱出→構造の全階再計算が収束するまで、最大4スイープ）を回し、階ごとに
// 隔て梁と、それ以外の柱・梁・断面の署名（id を除く）を JSON へ出す。同じ probe を基準コミット（git worktree）でも走らせ、
// out/ の2つの JSON を比べる: 隔て梁以外の柱・梁・断面が同じ・隔て梁は「下階に隔て壁があり自階にも同位置の階段がある階」にだけ1本。
// 使い方（app/ で実行）: node --import ./scripts/testSetup.mjs scripts/probe/stairPartitionBeamProbe.mjs [入力.stq] [出力名]
//   既定: D:/tatsuya/Download/moku4.stq・出力 out/stairPartitionBeam-<名>.json
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

// stairPartitionWallsProbe.mjs と同じ最小のインメモリ IndexedDB シム
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
  await runFinishExitBoundary(graph, project, { materialMap, stairUnderRooms: () => [] }, { goingToStructure: false });
}
const sweeps = await sweepUntilConverged(project, 'desc', 4, () => {});
console.log('収束 sweep 数 =', sweeps);

const isPartitionBeam = (b) => b.role === 'partitionBeam';
const beamSig = (b) => [b.role, b.materialType, b.sectionDefId, b.memberNo, b.isVertical ? 'V' : 'H', r(b.axisCL.effectiveValue), r(b.clStart.effectiveValue), r(b.clEnd.effectiveValue), b.beamType ?? '', b.dimensionStatus].join('|');
const out = { __sweeps: sweeps };
for (const plane of project.planes) {
  const g = project.graphMap.get(plane.id);
  const cols = g.columns.map(c => [c.role, c.materialType, c.sectionDefId, c.memberNo, r(c.verticalCL.effectiveValue), r(c.horizontalCL.effectiveValue)].join('|')).sort();
  const beams = g.beams.filter(b => !isPartitionBeam(b)).map(beamSig).sort();
  const partitionBeams = g.beams.filter(isPartitionBeam).map(beamSig).sort();
  out[plane.name] = { cols, beams, partitionBeams };
  console.log(`[${plane.name}] 柱=${cols.length} 梁(隔て梁以外)=${beams.length} 隔て梁=${partitionBeams.length}`);
  for (const p of partitionBeams) console.log('   隔て梁:', p);
  // 2階の踊り場前縁（y=-8190）の頭つなぎ（S3'-fix で 0 のはず）。軸 y=-8190 の水平梁の本数
  const ties = g.beams.filter(b => !b.isVertical && Math.abs(b.axisCL.effectiveValue - (-8190)) < 1).length;
  if (ties) console.log(`   y=-8190 の水平梁: ${ties} 本`);
}
const file = path.join(outDir, `stairPartitionBeam-${tag}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log('wrote', file);
