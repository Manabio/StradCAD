// 天伏（見上げ）の「N の階段の足元の上に N+1 の続きの階段の裏面」（S13a）の鉄骨経路を、実データに無い構成で実機確認するための
// テスト用 .stq を作るスクリプト（S13d）。実データ（13.stq など）の鉄骨階段は 1F のみで上階に続きが無く、
// 「N+1 の鉄骨階段の踏面線を全段描く」経路（planSolids の stairTread・drawEdges:true）は合成テストしか通っていなかった。
//
// 構成（3 階建て・階高 3000。1F 0・2F 3000・3F 6000。通り芯は X0=0・X1=3000・X2=7000 / Y0=0・Y1=3500・Y2=7000）:
//   階段: X0-X1 × Y0-Y1（幅 3000 × 奥行 3500。13.stq の 1F の階段と外形・値は同じ。セルは 1 つ〔13 は中間の CL で 3 セル〕）。SWITCHBACK・sections [11,1,11]・upDirection 'up'・flip true
//         （13.stq の 1F の階段の値を写した）。1F と 2F に同じ足元・同じ属性で置く（1F→2F・2F→3F の続き）。対の部屋は feature STAIR。
//   3F の同じ足元は階段吹抜け（STAIR_VOID。reconcileStairVoids＝本番の規則で置く。続きなし）。
//   階段の周りの部屋（屋内・feature なし・CH 既定）: A＝X1-X2 × Y0-Y1、B＝X0-X2 × Y1-Y2 を各階に。
//   既定は鉄骨（階段 STEEL・主構造 S造）→ D:/tatsuya/Download/ceiling-steel-stair-test.stq
//   --wood: 階段 WOOD・主構造 木造（在来）→ ceiling-wood-stair-test.stq（鉄骨との見え方の比較用）
// 作る前後の確認（いずれも NG なら終了コード 1。書き出し前に往復テスト）:
//   - 往復テスト（書いて読み直して部屋・階段・CL のダイジェスト一致）
//   - 階・階段・STAIR_VOID・部屋の数、階段の structure・type・cells、1F→2F の続きが取れ 2F→3F は取れないこと
//   - 見上げ（planSolidsLayerPrimitivesUp）: 1F＝鉄骨は上階の stairTread の線が全段分・stairSoffit 0／木造は stairSoffit が出て stairTread 0、
//     2F＝上階の階段吹抜けの×（一点鎖線）1 件、3F＝STAIR_VOID の平らな天井面の線
// 壁は本番の仕上げ脱出境界（runFinishExitBoundary。makeClDeleteTest.mjs と同じ手順）で生成する。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeCeilingSteelStairTestDoc.mjs [--wood] [出力先.stq]
// 既存ファイルは上書きしない。
import fs from 'node:fs';
import { Project, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType, ceilingCutHeightMmOf } from '../../src/core.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../src/structural/structureRules.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { reconcileStairVoids } from '../../src/finish/stair/stairVoidReconcile.js';
import { findContinuation } from '../../src/finish/stair/stairChains.js';
import { matchingStairBelow } from '../../src/structural/openingBeamAxes.js';
import { floorOpeningGroups } from '../../src/finish/stair/slabOpening.js';
import { stairRiserOf } from '../../src/finish/stair/stairDimensions.js';
import { stairTreadFootprints } from '../../src/finish/stair/stairTreads.js';
import { planHoleMarksOf } from '../../src/plan/planHoleMarks.js';
import { planSolidsLayerPrimitivesUp } from '../../src/plan/planSolidsLayerFilter.js';
import { ceilingSurfacesOf } from '../../src/ceiling/ceilingSurfaces.js';
import { loadDocument } from './loadDoc.mjs';

const WOOD = process.argv.includes('--wood');
const argPath = process.argv.slice(2).find(a => !a.startsWith('--'));
const outPath = argPath ?? `D:/tatsuya/Download/${WOOD ? 'ceiling-wood-stair-test' : 'ceiling-steel-stair-test'}.stq`;
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}
const STAIR_STRUCTURE = WOOD ? StructuralMaterialType.WOOD : StructuralMaterialType.STEEL;

// 構造反映が storage/db.js saveFloor を直呼びするため、実 IDB に触れない最小のインメモリ IDB を差す
// （makeClDeleteTest.mjs の withFakeIndexedDB と同じ。本番では使わない）。
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
const project = new Project('ceiling-stair-test', WOOD ? '天伏階段テスト（木造）' : '天伏階段テスト（鉄骨）');
project.structuralInfo.setField('mainStructure', WOOD ? TRADITIONAL_WOOD_STRUCTURE : 'S造');
const { plane: plane1, graph: g1 } = project.addPlane(0, '1階', 'p1', 1, 1);
const { plane: plane2, graph: g2 } = project.addPlane(3000, '2階', 'p2', 2, 1);
const { plane: plane3, graph: g3 } = project.addPlane(6000, '3階', 'p3', 3, 1);

const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const X0 = addAxis(CenterLineType.VERTICAL, 0);
const X1 = addAxis(CenterLineType.VERTICAL, 3000);
const X2 = addAxis(CenterLineType.VERTICAL, 7000);
const Y0 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 3500);
const Y2 = addAxis(CenterLineType.HORIZONTAL, 7000);
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
const stairCellKey = cellKey(X0, Y0, X1, Y1);

function addStairFloor(g) {
  const room = g.addRoom(new Set([stairCellKey]), '');
  room.setFeature(RoomFeature.STAIR);
  g.addStair({
    type: StairType.SWITCHBACK, structure: STAIR_STRUCTURE, cells: new Set([stairCellKey]),
    sections: [11, 1, 11], upDirection: 'up', flip: true, roomId: room.id,
  });
}
for (const g of [g1, g2, g3]) {
  g.addRoom(new Set([cellKey(X1, Y0, X2, Y1)]), 'A');
  g.addRoom(new Set([cellKey(X0, Y1, X2, Y2)]), 'B');
}
addStairFloor(g1);
addStairFloor(g2);
// 3F の足元は本番と同じ規則（reconcileStairVoids）で STAIR_VOID を置く（2F の階段は対の部屋があるので 2F には何も置かれない）
const rec2 = reconcileStairVoids(g2, g1, sg);
const rec3 = reconcileStairVoids(g3, g2, sg);
console.log(`reconcileStairVoids: 2F added=${rec2.added.length} / 3F added=${rec3.added.length}`);

// ---- 壁生成（本番の仕上げ脱出境界）----
const materialMap = await loadMaterialMap();
const originalPeek = floorSwapManager.peek;
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id);
try {
  await withFakeIndexedDB(async () => {
    for (const g of [g1, g2, g3]) await runFinishExitBoundary(g, project, { materialMap }, {});
  });
} finally {
  floorSwapManager.peek = originalPeek;
}
for (const [name, g] of [['1階', g1], ['2階', g2], ['3階', g3]]) {
  console.log(`${name}: walls=${g.walls.length} rooms=${g.rooms.map(r => `${r.name || '-'}(${r.feature ?? '通常'})`).join(',')} stairs=${g.stairs.length}`);
}

// ---- 往復テスト（書いて読み直してダイジェスト一致）----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      walls: g.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${Math.round(w.axisCL.effectiveValue)}`).sort(),
      rooms: g.rooms.map(r => `${r.name}:${r.feature}:${[...r.cells].sort().join(',')}`).sort(),
      stairs: g.stairs.map(s => `${s.type}:${s.structure}:${JSON.stringify(s.sections)}:${s.upDirection}:${s.flip}:${s.totalSteps}:${[...s.cells].sort().join(',')}`).sort(),
    };
  }
  out.__grid = proj.structGraph.centerLines.map(cl => `${cl.centerLineType}:${Math.round(cl.effectiveValue)}:${cl.label}`).sort();
  return JSON.stringify(out);
}
const floors = [plane1, plane2, plane3].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: plane1.id });
{
  const doc = parseDocumentEnvelope(JSON.parse(json));
  const project2 = new Project('probe', 'probe');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, doc.struct, project2.memberGroupLedger);
  const { planes, activePlaneId } = decodePlanes(doc.planes);
  for (const p of planes) {
    project2.addPlane(p.elevation, p.name, p.id, p.startFloor, p.stories, p.isAlternative, p.referenceId, p.altIndex, p.isRoofPlane, p.roofForPlaneId, p.planCutHeightMm, p.ceilingCutHeightMm);
  }
  for (const f of doc.floors) {
    const g = project2.graphMap.get(f.planeId);
    if (g) restoreGraph(g, f.bytes);
  }
  if (activePlaneId && project2.planeMap.has(activePlaneId)) project2.activePlaneId = activePlaneId;
  check(digestProject(project) === digestProject(project2), '往復テスト一致（壁・部屋・階段・通り芯のダイジェスト）');
}
if (failed) process.exit(1);
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');

// ---- 書いたファイルを loadDocument で読み戻して構成と見上げを確認 ----
const { project: P } = loadDocument(outPath);
const [f1, f2, f3] = P.planes;
check(P.planes.length === 3 && [f1, f2, f3].every((p, i) => p.elevation === i * 3000), `階 3（elevation ${P.planes.map(p => p.elevation)}）`);
const G = [f1, f2, f3].map(p => P.graphMap.get(p.id));
const stairsOk = G.map(g => g.stairs.length).join(',') === '1,1,0'
  && [G[0], G[1]].every(g => g.stairs[0].structure === STAIR_STRUCTURE && g.stairs[0].type === StairType.SWITCHBACK && g.stairs[0].cells.size === 1);
check(stairsOk, `階段数 1F/2F/3F = ${G.map(g => g.stairs.length)}・structure ${STAIR_STRUCTURE}・SWITCHBACK・cells 1`);
const voids = G.map(g => g.rooms.filter(r => r.feature === RoomFeature.STAIR_VOID).length);
const normals = G.map(g => g.rooms.filter(r => r.feature == null).length);
check(voids.join(',') === '0,0,1' && normals.join(',') === '2,2,2', `STAIR_VOID 1F/2F/3F = ${voids}・通常の部屋 = ${normals}`);
const sgP = P.structGraph;
check(findContinuation(G[0].stairs[0], G[0], G[1], sgP)?.id === G[1].stairs[0].id, '1F→2F の続きが取れる（findContinuation）');
check(findContinuation(G[1].stairs[0], G[1], G[2], sgP) == null, '2F→3F の続きは取れない（3F は STAIR_VOID）');
check(matchingStairBelow(G[1].stairs[0], G[1], G[0])?.id === G[0].stairs[0].id, '2F の階段は 1F の階段と足元が一致（matchingStairBelow）');

const up = (i) => {
  const plane = P.planes[i], above = P.planes[i + 1] ?? null, graph = G[i];
  const abovePeek = above ? { graph: G[i + 1], floorHeightMm: above.elevation - plane.elevation } : null;
  const aboveRiserOf = above ? s => stairRiserOf(s, P, above) : undefined;
  return planSolidsLayerPrimitivesUp({ graph, abovePeek, aboveRiserOf, cutZ: ceilingCutHeightMmOf(plane) }).filter(p => p.kind === 'line');
};
const kinds = (prims) => {
  const o = {};
  for (const p of prims) { const k = `${(p.source.layerFloorZ ?? 0) > 0 ? '上階' : '自階'}:${p.cls}/${p.source.kind}`; o[k] = (o[k] ?? 0) + 1; }
  return o;
};
// 1F の見上げ
const up1 = up(0);
console.log('1F 見上げ:', JSON.stringify(kinds(up1)));
const treadLines = up1.filter(p => p.source.kind === 'stairTread' && p.source.layerFloorZ === 3000);
const soffitLines = up1.filter(p => p.source.kind === 'stairSoffit');
const riser2 = stairRiserOf(G[1].stairs[0], P, f2);
const expectParts = new Set(stairTreadFootprints(G[1].stairs[0], G[1], { riser: riser2, insetView: 'upper' }).map(t => t.number));
const gotParts = new Set(treadLines.map(p => p.source.part));
console.log(`  上階 stairTread 線 ${treadLines.length} 本・source.part 集合 ${[...gotParts].sort((a, b) => a - b)}（期待＝stairTreadFootprints の番号 ${[...expectParts].sort((a, b) => a - b)}）・stairSoffit ${soffitLines.length} 本`);
if (WOOD) {
  check(soffitLines.length > 0 && treadLines.length === 0, '木造: 1F の見上げに stairSoffit が出て、上階の stairTread の線は 0 本');
} else {
  check(treadLines.length > 0 && soffitLines.length === 0, '鉄骨: 1F の見上げに上階の stairTread の線が出て、stairSoffit は 0 本');
  check(expectParts.size > 0 && expectParts.size === gotParts.size && [...expectParts].every(n => gotParts.has(n)), '鉄骨: stairTread の source.part の集合が踏面番号の集合と一致（全段）');
}
// 2F の見上げ: 上階の階段吹抜けの×
const aboveStairVoidGroups = floorOpeningGroups(G[2], { stairFilter: () => false, stairVoidRect: true }).filter(g => g.kind === 'stairVoid');
const marks = planHoleMarksOf(G[1], null, { lookUp: true, aboveStairVoidGroups });
const upper = marks.filter(m => m.role === 'upperStairVoid');
console.log(`2F 見上げ: 上階の階段吹抜けの×グループ ${aboveStairVoidGroups.length}・marks ${marks.length}（role ${marks.map(m => m.role)}）`);
check(upper.length === 1 && upper[0].dashKind === 'openingCross', '2F の見上げに上階の階段吹抜けの×が 1 件（一点鎖線 openingCross）');
// 3F の見上げ: STAIR_VOID の平らな天井面
const up3 = up(2);
const ceilLines3 = up3.filter(p => p.source.kind === 'ceiling');
console.log(`3F 見上げ: ${JSON.stringify(kinds(up3))}・天井面 ${ceilingSurfacesOf(G[2]).length}`);
const voidRoom3 = G[2].rooms.find(r => r.feature === RoomFeature.STAIR_VOID);
const voidFace = ceilingSurfacesOf(G[2]).find(s => s.roomId === voidRoom3.id);
const voidArea = voidFace ? voidFace.rects.reduce((a, r) => a + (r.x2 - r.x1) * (r.y2 - r.y1), 0) : 0;
check(voidFace?.zoneId === null && voidFace.shape === 'flat' && voidArea === 3000 * 3500,
  `3F の STAIR_VOID に平らな天井面（zoneId null・flat・zMm ${voidFace?.zMm}・面積 ${voidArea}）`);
check(ceilLines3.length > 0, '3F の見上げに ceiling の線が出る（天井面どうしの境目のグレー線）');
if (failed) {
  fs.unlinkSync(outPath); // 書き出し後の検査 NG は不良な文書を残さない（上書き防止があるので残すと手で消すしかない）
  console.error(`検査 NG のため削除しました: ${outPath}`);
  process.exit(1);
}
