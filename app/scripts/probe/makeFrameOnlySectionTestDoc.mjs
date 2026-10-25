// 三方枠（建具サブタイプ WF/SF/SSF＝機構 FRAME_ONLY）の展開図の**断面**を、実データに無い構成で確かめるための
// テスト用 .stq を作るスクリプト（S10-10 F2）。実データの三方枠は 14.stq の 1 件だけで、切断線が切る面・
// 出幅を編集した枠・鋼板の返し（SF）を持つ文書が無かった。
//
// 構成（1 階建て・S造・階高 3000。通り芯は X0=0・X1=3000・X2=7000 / Y0=0・Y1=3500・Y2=7000）:
//   部屋: A＝X0-X1 × Y0-Y1、B＝X1-X2 × Y0-Y1、C＝X0-X2 × Y1-Y2（いずれも屋内・feature なし）。
//   間仕切り壁 X1（A と B の境。縦）に三方枠を 3 つ、間仕切り壁 Y1（A・B と C の境。横）に 1 つ:
//     X1 の y=457.5 … WF（木製＝solid）・既定の見付 20／出幅 12・幅 800。壁の端（57.5）から始まり、A・B の面の隅（Y0 側）に届く
//     X1 の y=3042.5 … SF（鉄製＝bent）・既定・幅 800。壁の反対の端（3442.5）に届く＝A・B の面の隅（Y1 側）
//     Y1 の x=357.5 … WF・見付 40／出幅 30・幅 600・高さ 2100（A 側の壁）。出幅の編集が見込みと始点に追随するかの確認。A の X0 側の隅
//     Y1 の x=2492.5 … SSF（ステンレス＝bent）・既定・幅 900（A 側の壁）。A の X1 側の隅
//   建具の断面は面の両端の隅（直交壁の建具が面の端にかかるとき）に出る。切断線が壁を切る面（階段帯）は含めない
//   （それは sectionProbe.test.js・sectionEmit.test.js の合成テストで見る）。
// 壁は本番の仕上げ脱出境界（runFinishExitBoundary。makeCeilingSteelStairTestDoc.mjs と同じ手順）で生成する。
// 書き出し前に往復テスト（書いて読み直して壁・部屋・建具のダイジェスト一致）。NG は終了コード 1。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeFrameOnlySectionTestDoc.mjs [出力先.stq]
// 既存ファイルは上書きしない。
import fs from 'node:fs';
import { Project, CenterLineType, Discipline, OpeningCategory } from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { findHostWall, wallFaceRange } from '../../src/openings/openingGeometry.js';
import { loadDocument } from './loadDoc.mjs';

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/frame-only-section-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// 構造反映が storage/db.js saveFloor を直呼びするため、実 IDB に触れない最小のインメモリ IDB を差す
// （makeCeilingSteelStairTestDoc.mjs の withFakeIndexedDB と同じ。本番では使わない）。
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
const project = new Project('frame-only-section-test', '三方枠の断面テスト');
project.structuralInfo.setField('mainStructure', 'S造');
const { plane, graph: g } = project.addPlane(0, '1階', 'p1', 1, 1);

const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const X0 = addAxis(CenterLineType.VERTICAL, 0);
const X1 = addAxis(CenterLineType.VERTICAL, 3000);
const X2 = addAxis(CenterLineType.VERTICAL, 7000);
const Y0 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 3500);
const Y2 = addAxis(CenterLineType.HORIZONTAL, 7000);
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
g.addRoom(new Set([cellKey(X0, Y0, X1, Y1)]), 'A');
g.addRoom(new Set([cellKey(X1, Y0, X2, Y1)]), 'B');
g.addRoom(new Set([cellKey(X0, Y1, X2, Y2)]), 'C');

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

// ---- 三方枠を置く（壁ができてから。軸 CL と基準 CL は壁・グラフ側の実体を引く）----
const clOf = (id) => g.centerLines.find(c => c.id === id);
const partitionX = [...g.walls].find(w => w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1)?.axisCL;
const partitionY = [...g.walls].find(w => !w.isVertical && Math.abs(w.axisCL.effectiveValue - 3500) < 1)?.axisCL;
check(!!partitionX && !!partitionY && !!clOf(Y0.id) && !!clOf(X0.id), '間仕切り壁 X1・Y1 の軸 CL と基準 CL が引ける');
for (const w of g.walls) {
  if (w.axisCL === partitionX || w.axisCL === partitionY) console.log(`  壁 ${w.isVertical ? 'X' : 'Y'}${w.axisCL.effectiveValue} offset=${w.axisOffset} coord ${w.coord1}..${w.coord2} 材 ${JSON.stringify(w.materialRange)}`);
}
if (failed) process.exit(1);
const frame = (axisCL, wallSide, isVertical, refCL, center, width, fixtureType, props = {}) =>
  g.addOpening(axisCL, wallSide, isVertical, refCL, center, width, OpeningCategory.FITTING, 'threeSidedFrame',
    { fixtureType, height: 2000, ...props });
const placed = [
  frame(partitionX, 1, true, clOf(Y0.id), 457.5, 800, 'WF'),
  frame(partitionX, -1, true, clOf(Y0.id), 3042.5, 800, 'SF'),
  frame(partitionY, -1, false, clOf(X0.id), 357.5, 600, 'WF', { height: 2100, frameFaceWidth: 40, frameProjection: 30 }),
  frame(partitionY, -1, false, clOf(X0.id), 2492.5, 900, 'SSF'),
];
for (const o of placed) {
  const host = findHostWall(o, g);
  const face = host ? wallFaceRange(host, g) : null;
  console.log(`  ${o.fixtureType} ${o.isVertical ? 'X1' : 'Y1'} center=${o.centerCoord} w=${o.width} host=${host ? 'あり' : 'なし'} 壁の面 ${JSON.stringify(face)}`);
  check(!!host, `${o.fixtureType}（center ${o.centerCoord}）のホスト壁が引ける`);
}

// ---- 往復テスト（書いて読み直してダイジェスト一致）----
function digestProject(proj) {
  const out = {};
  for (const pl of proj.planes) {
    const gr = proj.graphMap.get(pl.id);
    out[pl.name] = {
      walls: gr.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${Math.round(w.axisCL.effectiveValue)}`).sort(),
      rooms: gr.rooms.map(r => `${r.name}:${r.feature}:${[...r.cells].sort().join(',')}`).sort(),
      openings: gr.openings.map(o => `${o.subType}:${o.fixtureType}:${o.isVertical}:${o.wallSide}:${Math.round(o.centerCoord)}:${o.width}:${o.height}:${o.frameFaceWidth}:${o.frameProjection}`).sort(),
    };
  }
  return JSON.stringify(out);
}
const floors = [{ planeId: plane.id, bytes: serializeGraph(g) }];
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: plane.id });
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
  check(digestProject(project) === digestProject(project2), '往復テスト一致（壁・部屋・三方枠のダイジェスト）');
}
if (failed) process.exit(1);
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');

// ---- 書いたファイルを loadDocument で読み戻して構成を確認 ----
const { project: P } = loadDocument(outPath);
const G = P.graphMap.get(P.planes[0].id);
check(P.planes.length === 1 && G.rooms.length === 3 && G.openings.length === 4, `1 階・部屋 3・三方枠 4（rooms ${G.rooms.length}・openings ${G.openings.length}）`);
check(G.openings.every(o => o.subType === 'threeSidedFrame'), '全建具が threeSidedFrame');
if (failed) {
  fs.unlinkSync(outPath); // 書き出し後の検査 NG は不良な文書を残さない（上書き防止があるので残すと手で消すしかない）
  console.error(`検査 NG のため削除しました: ${outPath}`);
  process.exit(1);
}
