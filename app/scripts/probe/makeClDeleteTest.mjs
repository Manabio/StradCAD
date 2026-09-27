// 通り芯削除の他階伝播（部屋再解釈・壁再生成）検証用のテスト .stq を作るスクリプト。実データ（13.stq・moku4.stq）は
// 全通り芯×全階で外壁線または復元不能に該当し削除可能な通り芯が1本も無いため（実測済み）、
// 削除可能な通り芯（内部の間仕切りグリッド線）を持つ最小構成を新規に作る
// （.claude/team-lessons「実データに無い構成は往復テスト先行でテスト用.stqを作る」に従う）。
//
// 構成（主構造=在来木造。moku4.stqと同じ設定）:
//   通り芯: X1=0, X2=4000, X3=8000（X2が削除対象）, Y1=0, Y2=6000（各軸2本以上でisLastGridOnAxisに
//   掛からない。X軸は3本、Y軸は2本）。
//   1階: 部屋A(X1–X2 × Y1–Y2)・部屋B(X2–X3 × Y1–Y2)。2階: 同じ2部屋。
//   3階: 部屋C（X1–X3 × Y1–Y2の1部屋・単一セルキー）。部屋セル・壁ではX2を参照しないが、
//   仕上げ脱出の構造反映（runFinishExitBoundary→reflectStructuralAfterFinishExit）でX2上に
//   床梁が乗るため hasExternalCenterLineReferences(X2)===true（参照あり階）になる（実測:
//   _structuralRefsToCL(X2).beamsが14本）。削除で部屋・壁は不変、X2上の梁だけ撤去される
//   （orphanOnlyの実機再現は範囲外——centerLineOps.test.jsのorphanOnly系単体テストで固定済み）。
//   各階とも仕上げモード脱出と同じ経路（runFinishExitBoundary）で壁を生成する。
//
// 2階建て以上の仕上げ脱出はresolveStairContextが「1つ下の階」をfloorSwapManager.peekするため、
// ここでは実IDBに触れないよう一時的にfloorSwapManager.peekをproject.graphMap直読みへ差し替える
// （階段が無いためstairUnderEntries/extraStairOpeningsは常に空になるが、peek自体は例外を投げない
// スタブが要る）。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeClDeleteTest.mjs [出力先.stq]
import fs from 'node:fs';
import {
  Project, CenterLineType, Discipline,
} from '../../src/core.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../src/structural/structureRules.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { findFloorsBlockingGridDeletion } from '../../src/transform/centerLineFloorSync.js';
import { isFootprintBoundaryCL } from '../../src/transform/centerLineConvert.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

// runFinishExitBoundary→reflectStructuralAfterFinishExit（他階への構造反映）は
// structural/structuralPeek.js saveVia経由でstorage/db.js saveFloorを直呼びする（ctx省略時のowned
// コンテキストはpeek/saveを差し替えない）ため、floorSwapManager.peekのスタブだけでは足りない。
// structuralOrchestration.test.js withFakeIndexedDBと同じ最小限のインメモリIndexedDBシムを使う
// （fake-indexeddb等の新規依存を追加しない。このシムはopenDB/saveFloor/loadFloorが使うAPIだけを
// 模す最小限のもので、本番では使わない）。
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
      for (const name of ['floors', 'projects', 'savedFloors']) {
        this.stores.set(name, new FakeStore());
      }
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

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/cl-delete-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const project = new Project('cl-delete-test', 'CL削除境界テスト');
project.structuralInfo.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);

const { plane: plane1, graph: g1 } = project.addPlane(0,    '1階', 'p1', 1, 1);
const { plane: plane2, graph: g2 } = project.addPlane(3000, '2階', 'p2', 2, 1);
const { plane: plane3, graph: g3 } = project.addPlane(6000, '3階', 'p3', 3, 1);

// ---- 通り芯（labeled struct CL。project.structGraph側へ追加。全階共通）----
const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const X1 = addAxis(CenterLineType.VERTICAL,   0);
const X2 = addAxis(CenterLineType.VERTICAL,   4000);
const X3 = addAxis(CenterLineType.VERTICAL,   8000);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y2 = addAxis(CenterLineType.HORIZONTAL, 6000);

const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;

// ---- 部屋 ----
g1.addRoom(new Set([cellKey(X1, Y1, X2, Y2)]), 'A');
g1.addRoom(new Set([cellKey(X2, Y1, X3, Y2)]), 'B');
g2.addRoom(new Set([cellKey(X1, Y1, X2, Y2)]), 'A');
g2.addRoom(new Set([cellKey(X2, Y1, X3, Y2)]), 'B');
// 3階: X1-X3の1部屋（単一セルキー。X2をセル境界として使わない＝部屋セルではX2を参照しないが、
// 仕上げ脱出の構造反映でX2上に床梁が乗るため参照あり階になる。冒頭コメント参照）。
g3.addRoom(new Set([cellKey(X1, Y1, X3, Y2)]), 'C');

console.log('通り芯:', { X1: X1.id.slice(0, 8), X2: X2.id.slice(0, 8), X3: X3.id.slice(0, 8), Y1: Y1.id.slice(0, 8), Y2: Y2.id.slice(0, 8) });

// ---- 壁生成（本番の仕上げモード脱出境界と同じ経路。fmode={}=既定寸法）----
// 2階・3階は resolveStairContext が「1つ下の階」を floorSwapManager.peek するため、実IDBに触れない
// よう一時的に project.graphMap 直読みへ差し替える（階段が無いためstairUnderEntries等は常に空）。
const materialMap = await loadMaterialMap();
const fmode = { materialMap };
const originalPeek = floorSwapManager.peek;
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id);
try {
  await withFakeIndexedDB(async () => {
    await runFinishExitBoundary(g1, project, fmode, {});
    await runFinishExitBoundary(g2, project, fmode, {});
    await runFinishExitBoundary(g3, project, fmode, {});
  });

  for (const [name, g] of [['1階', g1], ['2階', g2], ['3階', g3]]) {
    console.log(`${name}: walls=${g.walls.length} exterior=${g.walls.filter(w => w.isExteriorWall).length} rooms=${g.rooms.map(r => r.name).join(',')}`);
  }

  // ---- X2の参照内訳を階ごとに表示する（前提が変わったら気付けるように。QA指摘・2026-09-28）:
  // 壁参照（片端含む。hasExternalCenterLineReferences）・部材参照（_structuralRefsToCLの内訳）・
  // 部屋セル参照（cellKeyにX2のidを含むか）の3種を分けて出す。
  console.log('--- X2参照内訳（階ごと） ---');
  for (const [name, g] of [['1階', g1], ['2階', g2], ['3階', g3]]) {
    const refs = g._structuralRefsToCL(X2.id);
    const cellRef = g.rooms.some(r => [...r.cells].some(k => k.split(':').includes(X2.id)));
    console.log(`${name}: hasExternalCenterLineReferences=${g.hasExternalCenterLineReferences(X2.id)} ` +
      `walls=${refs.walls.length} columns=${refs.columns.length} beams=${refs.beams.length} footings=${refs.footings.length} ` +
      `部屋セル参照=${cellRef}`);
  }

  // ---- 先読みの確認: X2は各階とも外壁線でなく、X1/X3/Y1/Y2は外壁線 ----
  for (const [name, g] of [['1階', g1], ['2階', g2], ['3階', g3]]) {
    const boundary = { X1: isFootprintBoundaryCL(g, X1), X2: isFootprintBoundaryCL(g, X2), X3: isFootprintBoundaryCL(g, X3), Y1: isFootprintBoundaryCL(g, Y1), Y2: isFootprintBoundaryCL(g, Y2) };
    console.log(`${name} isFootprintBoundaryCL:`, boundary);
  }
  const blocking1 = await findFloorsBlockingGridDeletion(project, g1, X2);
  console.log('1階アクティブでX2削除: findFloorsBlockingGridDeletion =', {
    footprintPlanes: blocking1.footprintPlanes.map(p => p.name),
    unresolvablePlanes: blocking1.unresolvablePlanes.map(p => p.name),
    anyOtherFloorNeedsWallRegen: blocking1.anyOtherFloorNeedsWallRegen,
  });
} finally {
  floorSwapManager.peek = originalPeek;
}

// ---- シリアライズ ----
const floors = [plane1, plane2, plane3].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const planes = serializePlanes(project);
const json = buildDocumentJson({ floors, struct, planes, site: null, info: null, bootPlaneId: plane1.id });

// ---- 往復テスト（書いて読み直して壁・部屋・通り芯のダイジェスト一致を確認） ----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${Math.round(w.axisCL.effectiveValue)}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${[...r.cells].sort().join(',')}`).sort(),
    };
  }
  out.__grid = proj.structGraph.centerLines.map(cl => `${cl.centerLineType}:${Math.round(cl.effectiveValue)}:${cl.label}`).sort();
  return JSON.stringify(out);
}

const doc = parseDocumentEnvelope(JSON.parse(json));
const project2 = new Project('probe', 'probe');
restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
const { planes: decodedPlanes, activePlaneId } = decodePlanes(doc.planes);
for (const p of decodedPlanes) {
  project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId);
}
for (const f of doc.floors) {
  const g = project2.graphMap.get(f.planeId);
  if (g) restoreGraph(g, f.bytes);
}
if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;

const before = digestProject(project);
const after = digestProject(project2);
if (before !== after) {
  console.error('NG: 往復テスト不一致（書いて読み直したダイジェストが元と異なる）');
  console.error('before:', before);
  console.error('after :', after);
  process.exitCode = 1;
} else {
  console.log('OK: 往復テスト一致（壁・部屋・通り芯のダイジェストが書き戻し後も同一）');
}

if (process.exitCode) process.exit(process.exitCode);

fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
