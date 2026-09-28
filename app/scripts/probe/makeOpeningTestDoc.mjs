// 実装指示書「スラブ開口と補強・S造梁芯選定」ステップ7・項目6: 規則O（開口由来梁芯）を
// 目視確認するための合成 .stq を作るスクリプト。実データ（13.stq・14.stq）は2階建てのため
// 中間階が存在せず、stairBeyond由来の規則O（openingBeamAxes.js stairFilterFor）が発火しない
// （.claude/team-lessons「実データに無い構成は往復テスト先行でテスト用.stqを作る」に従う）。
//
// 構成（S造3階建て）:
//   通り芯（labeled、structGraph共有）: X -1000/3500/8000（3本・2スパン4500mm）、
//     Y -1000/5000/9500（3本・スパン6000mm/4500mm）。gridIntersections（S造の柱配置選択子）・
//     gridEdges（大梁配置選択子）で柱・大梁が立つ間隔にし、開口辺（階段0/1000/2000・
//     EV/VOID 6000/6500/7000/7500）とは一切重ならない座標を選んだ（QAレビュー指摘対応：
//     柱0本・大梁0本では小梁の受け先＝hostが無く「開口梁芯に小梁が架かる」ところまで
//     目視できないため追加）。
//   通り芯格子は2×2の4マス（セルA〜D）に分割され、全階とも「main」部屋で埋めてfootprint
//     （wallGate＝部材生成の可否を決める鉛直連続性ゲート）を確立する:
//     セルA(x:[-1000,3500] y:[-1000,5000])＝階段ゾーン。ゾーン内の4方向ストリップだけ
//       main部屋にし、内側（階段本体のfootprint）は各階の階段関連部屋（1F/2F=階段、
//       3F=STAIR_VOID）が占める。
//     セルB(x:[3500,8000] y:[5000,9500])＝EV/VOIDゾーン。2Fのみ内側をEV、3Fのみ内側を
//       VOIDにし、1Fは丸ごとmain。
//     セルC・セルDは全階ともmain部屋1つでそのまま埋める。
//   1階: 鉄骨SWITCHBACK階段（landing+outboundのみを部屋化。returnKeyが破れ先＝2階からの
//        見下ろし開口）。踊り場受け梁(LG)は設置階(1F)ではなく到達階(2F)へ生成される
//        （ユーザー裁定2026-09-28。floorHeightAbove(1F)=2Fの階高を使ってlevelOffsetを換算する）。
//   2階: syncUpperFloors（実装本体・本番同関数）で1階の階段を自動設置（フットプリント一致の
//        コピー。stairFilterForの「下階に到達元の階段がある」条件を満たす中間階）＋
//        EV部屋（isShaftFeature。床なし＝上階スラブ開口）を1部屋、階段と別ゾーンに独立で追加。
//        1階階段の到達階でもあるため、踊り場受け梁(LG)がここに生成される。
//   3階（最上階）: syncUpperFloorsが自動でSTAIR_VOID Room（階段吹抜け。1階階段のfootprintを
//        丸ごと翻訳）を指定する＋VOID部屋を1部屋、別ゾーンに独立で追加。2階階段（1階の
//        自動設置コピー）の到達階でもあるため、踊り場受け梁(LG)もここに生成される。
//
// 使い方: node --import ./scripts/testSetup.mjs scripts/probe/makeOpeningTestDoc.mjs [出力先.stq]
// 既定の出力先は D:/tatsuya/Download/opening-test.stq（兄弟スクリプト makeClDeleteTest.mjs・
// makeKneeDropTest.mjs・makeWoodKneeDropTest.mjs と同じ規約。目視用にユーザーが開くのはここ）。
import fs from 'node:fs';
import path from 'node:path';
import {
  Project, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType,
} from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { syncUpperFloors } from '../../src/finish/stair/stairFloorSync.js';

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

// syncUpperFloors は非アクティブ階（2階・3階）を変更すると storage/db.js の saveFloor
// （実IndexedDB）を呼ぶ。実IDBに触れないよう、makeClDeleteTest.mjsと同じ最小限のインメモリ
// IndexedDBシムを使う（fake-indexeddb等の新規依存を追加しない。openDB/saveFloorが使うAPIだけを
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

const outPath = process.argv[2] ?? 'D:/tatsuya/Download/opening-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

const project = new Project('opening-test', '規則O目視確認テスト');
project.structuralInfo.setField('mainStructure', 'S造');

const { plane: plane1, graph: g1 } = project.addPlane(0,    '1階', 'p1', 1, 1);
const { plane: plane2, graph: g2 } = project.addPlane(3000, '2階', 'p2', 2, 1);
const { plane: plane3, graph: g3 } = project.addPlane(6000, '3階', 'p3', 3, 1);
g1.structureOverride = 'S造';
g2.structureOverride = 'S造';
g3.structureOverride = 'S造';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const GRID = { labeled: true, discipline: Discipline.STRUCT };

// ---- 通り芯（structGraph共有・全階共通）----
const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, GRID);
const GX0 = addAxis(CenterLineType.VERTICAL,   -1000);
const GX1 = addAxis(CenterLineType.VERTICAL,    3500);
const GX2 = addAxis(CenterLineType.VERTICAL,    8000);
const GY0 = addAxis(CenterLineType.HORIZONTAL, -1000);
const GY1 = addAxis(CenterLineType.HORIZONTAL,  5000);
const GY2 = addAxis(CenterLineType.HORIZONTAL,  9500);
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;

// ---- 1階: 鉄骨SWITCHBACK階段（openingBeamAxes.test.js makeSwitchbackStairGraphと同じ形状）----
// landing: x[0,2000] y[0,1500]（踊り場。踊り場受け梁(LG)はここのback辺=y0に立つ）
// outbound: x[0,1000] y[1500,4500]／return: x[1000,2000] y[1500,4500]（破れ先＝2階からの開口）
// セルA(x:[-1000,3500] y:[-1000,5000])の内側に収まる（開口辺0/1000/2000は通り芯-1000/3500と重ならない）。
const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
const xm = g1.addCenterLine(CenterLineType.VERTICAL, 1000, ARCH);
const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
const ym = g1.addCenterLine(CenterLineType.HORIZONTAL, 1500, ARCH);
const y1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 4500, ARCH);
const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
const stairRoom1 = g1.addRoom(new Set([landingKey, outboundKey]), '階段');
stairRoom1.setFeature(RoomFeature.STAIR); // 本番同様、階段ペアRoomにfeature=STAIRを立てる（ensureStairRoomsと同じ規約）
g1.addStair({
  type: StairType.SWITCHBACK, cells: new Set([landingKey, outboundKey, returnKey]), roomId: stairRoom1.id,
  sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  structure: StructuralMaterialType.STEEL,
});

// セルA を埋める「main」部屋（階段本体の外側4ストリップ。1F自身の x0/xm/x1/y0/ym/y1 を使う）。
function cellAStrips(g, gx0, gx1, gy0, gy1, sx0, sx1, sy0, sy1) {
  return [
    cellKey(gx0, gy0, sx0, gy1), // left  (x:[gx0,sx0] y:[gy0,gy1])
    cellKey(sx1, gy0, gx1, gy1), // right (x:[sx1,gx1] y:[gy0,gy1])
    cellKey(sx0, gy0, sx1, sy0), // bottom(x:[sx0,sx1] y:[gy0,sy0])
    cellKey(sx0, sy1, sx1, gy1), // top   (x:[sx0,sx1] y:[sy1,gy1])
  ];
}
const g1CellA = cellAStrips(g1, GX0, GX1, GY0, GY1, x0, x1, y0, y1);

// ---- 2階: EV部屋（階段ゾーンと重ならない別ゾーン。セルB(x:[3500,8000] y:[5000,9500])内側。
// isShaftFeature=床なし=上階スラブ開口）。syncUpperFloorsより前に追加しておく（同期処理は
// 階段footprintだけを見るため順序は無関係）。
// CenterLineはextent省略時「全幅/全高」の無限直線として扱われるため、EV/VOIDのX/Y範囲は
// 階段のfootprint(x:0-2000,y:0-4500)とも通り芯(-1000/3500/8000, -1000/5000/9500)とも
// 重ならない内側の座標(6000-7000, 6500-7500)を選ぶ（実測で確認済み。重なると意図せずセルが
// 分割される——team-lessons「実データに無い構成は合成テストだけで確定させない」と同型の罠）。
const evXa = g2.addCenterLine(CenterLineType.VERTICAL, 6000, ARCH);
const evXb = g2.addCenterLine(CenterLineType.VERTICAL, 7000, ARCH);
const evYa = g2.addCenterLine(CenterLineType.HORIZONTAL, 6500, ARCH);
const evYb = g2.addCenterLine(CenterLineType.HORIZONTAL, 7500, ARCH);
const evKey = `${evXa.id}:${evYa.id}:${evXb.id}:${evYb.id}`;
g2.addRoom(new Set([evKey])).setFeature(RoomFeature.EV);

function cellBStrips(g, gx1, gx2, gy1, gy2, zx0, zx1, zy0, zy1) {
  return [
    cellKey(gx1, gy1, zx0, gy2), // left
    cellKey(zx1, gy1, gx2, gy2), // right
    cellKey(zx0, gy1, zx1, zy0), // bottom
    cellKey(zx0, zy1, zx1, gy2), // top
  ];
}
const g2CellB = cellBStrips(g2, GX1, GX2, GY1, GY2, evXa, evXb, evYa, evYb);

// ---- 3階: VOID部屋（階段吹抜け予定地とも別ゾーン。セルB内側。EVと同じ座標帯を使う——
// 階が違うため干渉しない）----
const voidXa = g3.addCenterLine(CenterLineType.VERTICAL, 6000, ARCH);
const voidXb = g3.addCenterLine(CenterLineType.VERTICAL, 7000, ARCH);
const voidYa = g3.addCenterLine(CenterLineType.HORIZONTAL, 6500, ARCH);
const voidYb = g3.addCenterLine(CenterLineType.HORIZONTAL, 7500, ARCH);
const voidKey = `${voidXa.id}:${voidYa.id}:${voidXb.id}:${voidYb.id}`;
g3.addRoom(new Set([voidKey])).setFeature(RoomFeature.VOID);
const g3CellB = cellBStrips(g3, GX1, GX2, GY1, GY2, voidXa, voidXb, voidYa, voidYb);

// セルC(x:[-1000,3500] y:[5000,9500])・セルD(x:[3500,8000] y:[-1000,5000])は全階とも
// 通り芯4隅だけで埋まる単一セル（サブ分割不要）。
const cellCKey = cellKey(GX0, GY1, GX1, GY2);
const cellDKey = cellKey(GX1, GY0, GX2, GY1);

// 1階: セルB（row2,col2 = x:[3500,8000] y:[5000,9500]）は丸ごとmain（EV/VOIDが無いため単一キー）。
const g1CellB = [cellKey(GX1, GY1, GX2, GY2)];

g1.addRoom(new Set([...g1CellA, ...g1CellB, cellCKey, cellDKey]), 'main');
g2.addRoom(new Set([...g2CellB, cellCKey, cellDKey]), 'main'); // セルAは後段(syncUpperFloors後)で追加
g3.addRoom(new Set([...g3CellB, cellCKey, cellDKey]), 'main'); // 同上

// ---- syncUpperFloors（本番同関数）で2階へ階段を自動設置・3階へSTAIR_VOIDを自動指定 ----
const originalPeek = floorSwapManager.peek;
floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
try {
  await withFakeIndexedDB(async () => {
    await syncUpperFloors(project, g1);
  });
} finally {
  floorSwapManager.peek = originalPeek;
}

// ---- 2階・3階のセルA外側4ストリップを「main」部屋として追加する（syncUpperFloorsが
// addMissingCLsで階段footprint用のCL(値0/1000/2000, 0/1500/4500)を各階の自グラフへ複製済み
// ——同じ値のCLを graph.centerLines から検索して使う）----
function findLocal(g, type, value) {
  const cl = g.centerLines.find(c => c.centerLineType === type && c.value === value);
  if (!cl) throw new Error(`centerLine not found: type=${type} value=${value}`);
  return cl;
}
function addCellAMainStrips(g) {
  const lx0 = findLocal(g, CenterLineType.VERTICAL, 0);
  const lxm = findLocal(g, CenterLineType.VERTICAL, 1000);
  const lx1 = findLocal(g, CenterLineType.VERTICAL, 2000);
  const ly0 = findLocal(g, CenterLineType.HORIZONTAL, 0);
  const lym = findLocal(g, CenterLineType.HORIZONTAL, 1500);
  const ly1 = findLocal(g, CenterLineType.HORIZONTAL, 4500);
  void lxm; void lym;
  const strips = cellAStrips(g, GX0, GX1, GY0, GY1, lx0, lx1, ly0, ly1);
  const mainRoom = g.rooms.find(r => r.name === 'main');
  for (const key of strips) mainRoom.cells.add(key);
}
addCellAMainStrips(g2);
addCellAMainStrips(g3);

console.log('1階: stairs=', g1.stairs.length, 'rooms=', g1.rooms.map(r => `${r.name ?? ''}(${r.feature ?? 'none'})`));
console.log('2階: stairs=', g2.stairs.length, 'rooms=', g2.rooms.map(r => `${r.name ?? ''}(${r.feature ?? 'none'})`));
console.log('3階: stairs=', g3.stairs.length, 'rooms=', g3.rooms.map(r => `${r.name ?? ''}(${r.feature ?? 'none'})`));

// ---- シリアライズ ----
const floors = [plane1, plane2, plane3].map(p => ({ planeId: p.id, bytes: serializeGraph(project.graphMap.get(p.id)) }));
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const planes = serializePlanes(project);
const json = buildDocumentJson({ floors, struct, planes, site: null, info: null, bootPlaneId: plane1.id });

// ---- 往復テスト（書いて読み直して部屋・階段のダイジェスト一致を確認。team-lessons「実データに
// 無い構成は往復テスト先行」）----
function digestProject(proj) {
  const out = {};
  for (const plane of proj.planes) {
    const g = proj.graphMap.get(plane.id);
    out[plane.name] = {
      rooms: g.rooms.map(r => `${r.feature ?? 'none'}:${[...r.cells].sort().join(',')}`).sort(),
      stairs: g.stairs.map(s => `${s.type}:${s.structure}:${[...s.cells].sort().join(',')}`).sort(),
    };
  }
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
  console.log('OK: 往復テスト一致（部屋・階段のダイジェストが書き戻し後も同一）');
}

if (process.exitCode) process.exit(process.exitCode);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');
