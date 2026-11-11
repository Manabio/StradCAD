// 外付け引き戸の袖柱（問題2.md S9・Q-S9）の目視用テスト .stq（在来木造）を作るスクリプト。
// makeSlidingDoorTestDoc.mjs（S造・袖柱なし）の流儀（本番の仕上げ脱出境界で壁を生成→建具を置く→構造再計算→往復テスト→書き出し→読み戻し検査）。
//
// 構成（1 階建て・在来木造。通り芯 X0..X2＝0・4000・8000 / Y0..Y2＝0・4000・8000 の 2×2 ＝部屋 R1〜R4）:
//   内壁の引き戸 2 本＝縦 X1（行 1・引き代 −1＝coord1 側）・横 Y1（列 2・引き代 +1＝coord2 側）。
//   構造再計算（recomputeStructuralForGraph）で袖柱が立ち、woodJambRef.outset が付いて AXIS が穴（J 込み cut）の両端±(5＋柱寸/2) になるのを確かめる。
// 書き出し前に往復テスト、書き出し後に読み戻して outset 付き袖柱 4 本（引き戸 2 本×両袖）の AXIS を検査する。NG は終了コード 1。
//
// 使い方: cd app && node --import ./scripts/testSetup.mjs scripts/probe/makeSlidingDoorWoodTestDoc.mjs [--out 出力先.stq]
// 出力先の既定は D:/tatsuya/Download/sliding-door-wood-test.stq。既存ファイルは上書きしない。
import fs from 'node:fs';
import { Project, CenterLineType, Discipline, OpeningCategory } from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { findHostWall } from '../../src/openings/openingGeometry.js';
import { outsetSlideCutSpanOf } from '../../src/core/slideOutsetGeometry.js';
import { recomputeStructuralForGraph } from '../../src/structural/structuralRecompute.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../src/structural/structureRules.js';
import { findSectionEntry } from '../../src/structural/sectionCatalog.js';
import { loadDocument } from './loadDoc.mjs';

// ---- この probe 内の寸法（本体の定数にはしない）----
const COL_X = [0, 4000, 8000];
const ROW_Y = [0, 4000, 8000];
const SLIDE_WIDTH = 1550; // 扉幅 800
const SLIDE_HEIGHT = 2000;
const JAMB_CLEARANCE = 5; // 在来ルールの袖のクリアランス（jambClearanceMm）

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = (outIndex >= 0 ? args[outIndex + 1] : args.find(a => !a.startsWith('--')))
  ?? 'D:/tatsuya/Download/sliding-door-wood-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// 構造反映が storage/db.js saveFloor を直呼びするため、実 IDB に触れない最小のインメモリ IDB を差す
// （makeSlidingDoorTestDoc.mjs と同じ。本番では使わない）。
function withFakeIndexedDB(fn) {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      this.data.set(value.planeId ?? value.projectId, value);
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
    get(key) {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
      return req;
    }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore());
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
      return req;
    },
  };
  return fn().finally(() => { globalThis.indexedDB = original; });
}

let failed = false;
const check = (ok, msg) => {
  if (ok) console.log(`OK: ${msg}`);
  else { console.error(`NG: ${msg}`); failed = true; }
};

// ---- 構築 ----
const project = new Project('sliding-door-wood-test', '引き戸（在来木造）テスト');
project.structuralInfo.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);
const { plane, graph: g } = project.addPlane(0, '1階', 'p1', 1, 1);

const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const XS = COL_X.map(v => addAxis(CenterLineType.VERTICAL, v));
const YS = ROW_Y.map(v => addAxis(CenterLineType.HORIZONTAL, v));
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
let roomNo = 0;
for (let j = 0; j < YS.length - 1; j++) {
  for (let i = 0; i < XS.length - 1; i++) { roomNo += 1; g.addRoom(new Set([cellKey(XS[i], YS[j], XS[i + 1], YS[j + 1])]), `R${roomNo}`); }
}

// ---- 壁生成（本番の仕上げ脱出境界）----
const materialMap = await loadMaterialMap();
const originalPeek = floorSwapManager.peek;
floorSwapManager.peek = async (p) => project.graphMap.get(p.id);
try {
  await withFakeIndexedDB(async () => { await runFinishExitBoundary(g, project, { materialMap }, {}); });
} finally {
  floorSwapManager.peek = originalPeek;
}
console.log(`1階: walls=${g.walls.length} rooms=${g.rooms.map(r => r.name).join(',')}`);

// ---- 建具を置く（内壁の引き戸 2 本）----
const clOf = (id) => g.centerLines.find(c => c.id === id);
const hostWalls = (isVertical, axisValue, lo, hi) => [...g.walls]
  .filter(w => w.isVertical === isVertical && Math.abs(w.axisCL.effectiveValue - axisValue) < 1
    && Math.min(w.coord1, w.coord2) <= lo + 1e-6 && Math.max(w.coord1, w.coord2) >= hi - 1e-6 && !w.isExteriorWall)
  .sort((a, b) => Math.abs(a.axisOffset) - Math.abs(b.axisOffset));
const specs = [
  { name: '内壁 縦 X1 行1 引き代−1', isVertical: true, axisValue: COL_X[1], span: [ROW_Y[0], ROW_Y[1]], hingeSide: -1 },
  { name: '内壁 横 Y1 列2 引き代+1', isVertical: false, axisValue: ROW_Y[1], span: [COL_X[1], COL_X[2]], hingeSide: 1 },
];
const placed = [];
for (const s of specs) {
  const mid = (s.span[0] + s.span[1]) / 2;
  const hosts = hostWalls(s.isVertical, s.axisValue, mid - SLIDE_WIDTH / 2, mid + SLIDE_WIDTH / 2);
  check(hosts.length > 0, `${s.name}: 壁が引ける（${hosts.length} 本）`);
  if (hosts.length === 0) continue;
  const host = hosts[0];
  const wallSide = Math.sign(host.axisOffset) || 1;
  const refCL = clOf((s.isVertical ? YS[0] : XS[0]).id);
  const o = g.addOpening(host.axisCL, wallSide, s.isVertical, refCL, mid, SLIDE_WIDTH, OpeningCategory.FITTING, 'sliding',
    { height: SLIDE_HEIGHT, swingSide: wallSide, hingeSide: s.hingeSide });
  check(findHostWall(o, g)?.id === host.id, `${s.name}: ホスト壁が意図した壁`);
  placed.push({ o, name: s.name });
}
if (failed) process.exit(1);

// ---- 構造再計算（袖柱を立てる）----
await withFakeIndexedDB(async () => {
  floorSwapManager.peek = async (p) => project.graphMap.get(p.id);
  try {
    for (let i = 0; i < 3; i++) await recomputeStructuralForGraph(g, project, TRADITIONAL_WOOD_STRUCTURE);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// 袖柱の検査（メモリ上と読み戻し後の両方で使う）。AXIS＝cut の端±(5＋柱寸/2)。走行方向は縦壁なら y・横壁なら x。
function checkJambs(graph, label) {
  for (const { o, name } of placed) {
    const o2 = graph.openings.find(x => x.id === o.id);
    const cut = outsetSlideCutSpanOf(o2.coord1, o2.coord2, o2.hingeSide);
    const jambs = graph.columns.filter(c => c.woodJambRef?.openingId === o.id);
    const bySide = Object.fromEntries(jambs.map(c => [c.woodJambRef.side, c]));
    check(jambs.length === 2 && jambs.every(c => c.woodJambRef.outset === true), `${label} ${name}: 袖柱 2 本・outset 付き（${jambs.length} 本）`);
    for (const side of [-1, 1]) {
      const c = bySide[side];
      if (!c) continue;
      const half = JAMB_CLEARANCE + findSectionEntry(c.sectionDefId).width / 2;
      const want = side < 0 ? cut[0] - half : cut[1] + half;
      const got = o2.isVertical ? c.axisY : c.axisX;
      check(Math.abs(got - want) < 1e-6, `${label} ${name}: side ${side} の AXIS ${got}（期待 ${want}＝cut ${cut}）`);
    }
  }
}
checkJambs(g, '構築後');
if (failed) process.exit(1);

// ---- 往復テスト ----
const digest = (gr) => JSON.stringify({
  columns: gr.columns.map(c => `${c.woodJambRef ? `${c.woodJambRef.openingId}:${c.woodJambRef.side}:${c.woodJambRef.outset === true}` : '-'}:${Math.round(c.axisX)}:${Math.round(c.axisY)}`).sort(),
  openings: gr.openings.map(o => `${o.subType}:${Math.round(o.centerCoord)}:${o.width}:${o.hingeSide}`).sort(),
});
const floors = [{ planeId: plane.id, bytes: serializeGraph(g) }];
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: plane.id, catalogs: null });
{
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of planes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
  }
  for (const f of doc.floors) {
    const gr = project2.graphMap.get(f.planeId);
    if (gr) restoreGraph(gr, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  check(digest(g) === digest(project2.graphMap.get(plane.id)), '往復テスト一致（袖柱の outset・AXIS・建具）');
}
if (failed) process.exit(1);
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');

// ---- 書いたファイルを loadDocument で読み戻して検査 ----
const { project: P } = loadDocument(outPath);
const G = P.graphMap.get(P.planes[0].id);
check(P.planes.length === 1 && G.rooms.length === 4 && G.openings.filter(o => o.subType === 'sliding').length === placed.length,
  `1 階・部屋 4・引き戸 ${placed.length}`);
checkJambs(G, '読み戻し後');
if (failed) {
  fs.unlinkSync(outPath);
  console.error(`検査 NG のため削除しました: ${outPath}`);
  process.exit(1);
}
