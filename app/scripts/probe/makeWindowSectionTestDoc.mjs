// 窓の展開図の**断面**（隅の建具断面）の従来の描き＝枠 40｜障子 40｜枠 40 の全高矩形 3 本（帯幅 120）を、
// 窓の種類・窓台高さ・壁厚を振って確かめるためのテスト用 .stq を作るスクリプト（S8f-3a-0）。
// 実データ・既存 golden に窓の断面は 1 本も無かったので、S8f-3a で窓の断面を描き直す前の「比べる元」を採る。
//
// 構成（1 階建て・S造・階高 3000。通り芯は X0..X5＝0・3000・6000・9000・12000・15000 / Y0=0・Y1=3500）:
//   部屋 R1〜R5（X(i-1)-X(i) × Y0-Y1。屋内・feature なし）が横一列。縦の壁 W0〜W5（W0・W5＝外壁、W1〜W4＝間仕切り）の
//   Y0 側の端（上）と Y1 側の端（下）に建具を 1 つずつ置く＝展開の隅の建具断面として両隣の部屋の面の端に現れる
//   （elevationFigure.js cornerSectionsOf。壁の端から始まる建具が面の隅に届く。三方枠の probe と同じ置き方）。
//   窓の一覧（subType・窓台・高さ・幅は makeSpecs の表。壁厚は外壁と間仕切りの 2 種）:
//     W0 外壁  上: casement（swingSide +1）   下: casement（swingSide −1）
//     W1 間仕切 上: inswing                    下: fixed
//     W2 間仕切 上: doubleSliding（窓台 800）  下: doubleSliding3（3 枚建て）
//     W3 間仕切 上: singleSliding              下: doubleHung
//     W4 間仕切 上: 掃き出し窓＝窓台 0 の引き違い窓（R1）  下: 戸 singleSwing（片開き戸。窓でない対照）
//     W5 外壁  上: 高さ 40 の fixed（見付の頭打ち min(25, 高さ/2) の検証用）  下: 戸 sliding（引き戸。窓でない対照）
// 壁は本番の仕上げ脱出境界（runFinishExitBoundary。makeFrameOnlySectionTestDoc.mjs と同じ手順）で生成する。
// 書き出し前に往復テスト（壁・部屋・建具のダイジェスト一致）、書き出し後に展開（ElevationModeState）の帯に
// 幅 40 の矩形 3 本の窓の断面が出ていることを数える。NG は終了コード 1。
//
// 使い方: cd app && node --import ./scripts/testSetup.mjs scripts/probe/makeWindowSectionTestDoc.mjs [--out 出力先.stq]
// 出力先の既定は D:/tatsuya/Download/window-section-test.stq。既存ファイルは上書きしない。
import fs from 'node:fs';
import { Project, CenterLineType, Discipline, OpeningCategory } from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { findHostWall, wallFaceRange } from '../../src/openings/openingGeometry.js';
import { ElevationModeState } from '../../src/modes/ElevationModeState.js';
import { loadDocument } from './loadDoc.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = (outIndex >= 0 ? args[outIndex + 1] : args.find(a => !a.startsWith('--')))
  ?? 'D:/tatsuya/Download/window-section-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// 構造反映が storage/db.js saveFloor を直呼びするため、実 IDB に触れない最小のインメモリ IDB を差す
// （makeFrameOnlySectionTestDoc.mjs の withFakeIndexedDB と同じ。本番では使わない）。
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
const project = new Project('window-section-test', '窓の断面テスト');
project.structuralInfo.setField('mainStructure', 'S造');
const { plane, graph: g } = project.addPlane(0, '1階', 'p1', 1, 1);

const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const XS = [0, 3000, 6000, 9000, 12000, 15000].map(v => addAxis(CenterLineType.VERTICAL, v));
const Y0 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 3500);
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
for (let i = 1; i < XS.length; i++) g.addRoom(new Set([cellKey(XS[i - 1], Y0, XS[i], Y1)]), `R${i}`);

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

// ---- 建具を置く（壁ができてから。軸 CL と基準 CL は壁・グラフ側の実体を引く）----
const clOf = (id) => g.centerLines.find(c => c.id === id);
const wallsAt = (v) => [...g.walls].filter(w => w.isVertical && Math.abs(w.axisCL.effectiveValue - v) < 1);
check(XS.every((x, i) => wallsAt([0, 3000, 6000, 9000, 12000, 15000][i]).length > 0), '縦の壁 W0〜W5 が引ける');
if (failed) process.exit(1);

const W = OpeningCategory.WINDOW;
const F = OpeningCategory.FITTING;
// 表: [壁の番号, 'top'|'bottom', category, subType, 窓台, 高さ, 幅, 追加の props]
const specs = [
  [0, 'top', W, 'casement', 900, 1100, 600, { swingSide: 1 }],
  [0, 'bottom', W, 'casement', 900, 1100, 600, { swingSide: -1 }],
  [1, 'top', W, 'inswing', 900, 1100, 600, {}],
  [1, 'bottom', W, 'fixed', 900, 900, 600, {}],
  [2, 'top', W, 'doubleSliding', 800, 1170, 1690, {}],
  [2, 'bottom', W, 'doubleSliding3', 800, 1170, 2550, {}],
  [3, 'top', W, 'singleSliding', 800, 1170, 1235, {}],
  [3, 'bottom', W, 'doubleHung', 900, 1100, 600, {}],
  [4, 'top', W, 'doubleSliding', 0, 2000, 1690, {}],
  [4, 'bottom', F, 'singleSwing', null, 2000, 800, { fixtureType: 'WD' }],
  [5, 'top', W, 'fixed', 1000, 40, 600, {}],
  [5, 'bottom', F, 'sliding', null, 2000, 800, { fixtureType: 'WD' }],
];
const placed = [];
for (const [wi, end, category, subType, sill, height, width, extra] of specs) {
  const walls = wallsAt([0, 3000, 6000, 9000, 12000, 15000][wi]);
  // 端に届く壁（上＝座標最小・下＝座標最大の端を持つ壁。同じ端に複数あれば axisOffset の絶対値が小さい＝CL 側の壁）
  const endOf = w => (end === 'top' ? Math.min(w.coord1, w.coord2) : Math.max(w.coord1, w.coord2));
  const extreme = end === 'top' ? Math.min(...walls.map(endOf)) : Math.max(...walls.map(endOf));
  const sideWall = walls.filter(w => Math.abs(endOf(w) - extreme) < 1e-6).sort((a, c) => Math.abs(a.axisOffset) - Math.abs(c.axisOffset))[0];
  const center = end === 'top' ? extreme + width / 2 : extreme - width / 2; // 壁の端から始まる＝面の隅に届く
  const wallSide = Math.sign(sideWall.axisOffset) || 1;
  console.log(`  [W${wi} ${end}] 端の壁 axisOffset=${sideWall.axisOffset} coord ${sideWall.coord1}..${sideWall.coord2} 材 ${JSON.stringify(sideWall.materialRange)} 外壁=${sideWall.isExteriorWall}`);
  const props = { fixtureType: category === W ? 'AW' : 'WD', height, ...(sill === null ? {} : { sillHeight: sill }), ...extra };
  const o = g.addOpening(wallsAt([0, 3000, 6000, 9000, 12000, 15000][wi])[0].axisCL, wallSide, true, clOf(Y0.id), center, width, category, subType, props);
  const host = findHostWall(o, g);
  const face = host ? wallFaceRange(host, g) : null;
  console.log(`  W${wi} ${end} ${category}/${subType} center=${center} w=${width} h=${height} sill=${sill} wallSide=${wallSide} host=${host ? 'あり' : 'なし'} 壁の面 ${JSON.stringify(face)} 壁厚=${face ? Math.abs(face[1] - face[0]) : '-'}`);
  check(!!host, `W${wi} ${end} ${subType}（center ${center}）のホスト壁が引ける`);
  placed.push(o);
}

// ---- 往復テスト（書いて読み直してダイジェスト一致）----
function digestProject(proj) {
  const out = {};
  for (const pl of proj.planes) {
    const gr = proj.graphMap.get(pl.id);
    out[pl.name] = {
      walls: gr.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${Math.round(w.axisCL.effectiveValue)}`).sort(),
      rooms: gr.rooms.map(r => `${r.name}:${r.feature}:${[...r.cells].sort().join(',')}`).sort(),
      openings: gr.openings.map(o => `${o.category}:${o.subType}:${o.wallSide}:${Math.round(o.centerCoord)}:${o.width}:${o.height}:${o.sillHeight}:${o.swingSide}`).sort(),
    };
  }
  return JSON.stringify(out);
}
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
  check(digestProject(project) === digestProject(project2), '往復テスト一致（壁・部屋・建具のダイジェスト）');
}
if (failed) process.exit(1);
fs.writeFileSync(outPath, json);
console.log('wrote', outPath, json.length, 'bytes');

// ---- 書いたファイルを loadDocument で読み戻して構成を確認 ----
const { project: P } = loadDocument(outPath);
const G = P.graphMap.get(P.planes[0].id);
check(P.planes.length === 1 && G.rooms.length === 5 && G.openings.length === 12,
  `1 階・部屋 5・建具 12（rooms ${G.rooms.length}・openings ${G.openings.length}）`);
check(G.openings.filter(o => o.category === W).length === 10 && G.openings.filter(o => o.category === F).length === 2, '窓 10・戸 2');

// ---- 展開（ElevationModeState）: 帯に幅 40 の矩形 3 本の窓の断面が出ていること ----
const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
const result = await st.init();
check(result.ok !== false && st.bands.length > 0, `展開が生成できる（bands ${st.bands.length}・err ${st.materialError}）`);
let totalRects = 0;
for (const b of st.bands) {
  const name = G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId;
  const w40 = b.primitives.filter(p => p.type === 'rect' && Math.abs(p.w - 40) < 1e-6);
  // 同じ x 範囲・同じ高さで横に 3 本並ぶ組（枠 40｜障子 40｜枠 40＝帯幅 120）を数える
  const keyOf = p => `${p.y}:${p.h}`;
  const groups = new Map();
  for (const p of w40) { const k = keyOf(p); groups.set(k, [...(groups.get(k) ?? []), p]); }
  const triples = [...groups.values()].filter(list => {
    const xs = list.map(p => p.x).sort((a, c) => a - c);
    return xs.some((x, i) => i + 2 < xs.length && Math.abs(xs[i + 1] - x - 40) < 1e-6 && Math.abs(xs[i + 2] - x - 80) < 1e-6);
  });
  totalRects += w40.length;
  console.log(`帯 ${name}: 幅 40 の矩形 ${w40.length} 本・3 本組 ${triples.length} 組 ${JSON.stringify(triples.map(l => ({ y: l[0].y, h: l[0].h, xs: l.map(p => p.x).sort((a, c) => a - c) })))}`);
}
// 窓 10 のうち、隣り合う部屋の面の隅に出るのは外壁 W0・W5 の窓が 1 室、間仕切り W1〜W4 の窓が 2 室。窓 10 のうち外壁の 3 つ（W0 上下・W5 上）＋
// 間仕切り 7 つ＝3×1＋7×2＝17 の窓断面が帯に現れうる（扉 2 は幅 40 の矩形を描かない別構成）。窓の矩形は 1 つ 3 本。
console.log(`幅 40 の矩形の合計 ${totalRects} 本`);
check(totalRects > 0 && totalRects % 3 === 0, `帯に幅 40 の矩形が 3 本ずつ出ている（合計 ${totalRects} 本＝窓の断面 ${totalRects / 3} 個）`);
if (failed) {
  fs.unlinkSync(outPath); // 書き出し後の検査 NG は不良な文書を残さない（上書き防止があるので残すと手で消すしかない）
  console.error(`検査 NG のため削除しました: ${outPath}`);
  process.exit(1);
}
