// 外付け引き戸（問題0.md S1〜S3。W＝2×扉幅−50・穴＝扉幅−50・引き代左右 hingeSide・走る面 swingSide）の目視用テスト .stq を作るスクリプト。
// makeWindowSectionTestDoc.mjs の流儀（本番の仕上げ脱出境界で壁を生成→建具を置く→往復テスト→書き出し→読み戻し検査）。
//
// 構成（1 階建て・S造。通り芯 X0..X3＝0・4000・8000・12000 / Y0..Y2＝0・4000・8000 の 2 行×3 列＝部屋 R1〜R6）:
//   屋内壁の引き戸（外壁ではない壁がホスト）8 本＝{内壁, 外壁境界の室内向き壁} × 引き代 hingeSide {−1, +1} × {縦壁, 横壁}。
//     内壁: 縦 X1（hinge −1）・縦 X2（+1）・横 Y1 の列 1（−1）・横 Y1 の列 2（+1）
//     外壁境界の室内向き壁: 縦 X0（−1）・縦 X3（+1）・横 Y0 の列 1（−1）・横 Y2 の列 3（+1）
//   特殊な壁の引き戸 2 本（部屋の外の通り芯 Y3＝12000 に手動壁を足す）: 壁厚 25 の薄い壁（W≤50 でなく壁厚≤50＝S3b の欠き込み省略の確認用）・
//     通り芯から 300 ずれた壁（偏芯。壁生成の backingOffset ではなく axisOffset のずれで代用）
//   外壁（isExteriorWall）をホストにする引き戸 1 本（外壁 Y2 の列 2）＝R12 の通知（「外壁にある引き戸は外付けにできません」）と従来描きの確認用
// 書き出し前に往復テスト（壁・部屋・建具のダイジェスト一致）、書き出し後に読み戻して引き戸の本数・W・hingeSide、
// 壁の描画スパン（buildWallDrawPlan）の穴の長さ（屋内壁＝扉幅−50・外壁ホスト＝W 全幅）と建具モードの通知 1 件を確かめる。NG は終了コード 1。
//
// 使い方: cd app && node --import ./scripts/testSetup.mjs scripts/probe/makeSlidingDoorTestDoc.mjs [--out 出力先.stq]
// 出力先の既定は D:/tatsuya/Download/sliding-door-test.stq。既存ファイルは上書きしない。
import fs from 'node:fs';
import { Project, CenterLineType, Discipline, OpeningCategory } from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes, restoreGraph, restoreStructCLs, decodePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { findHostWall } from '../../src/openings/openingGeometry.js';
import { slideDoorWidth } from '../../src/openings/slideOutset.js';
import { SLIDE_OUTSET_WIDTH_DEDUCT_MM } from '../../src/core/constants.js';
import { buildWallDrawPlan } from '../../src/renderer/wallDrawPlan.js';
import { LodLevel } from '../../src/viewport.js';
import { collectSlideOnExteriorWall } from '../../src/openings/openingDetailFitCheck.js';
import { loadDocument } from './loadDoc.mjs';

// ---- この probe 内の寸法（本体の定数にはしない）----
const COL_X = [0, 4000, 8000, 12000]; // 通り芯 X0..X3（列の幅 4000）
const ROW_Y = [0, 4000, 8000]; // 通り芯 Y0..Y2（行の高さ 4000）
const SPECIAL_Y = 12000; // 手動壁を足す通り芯 Y3（部屋の外）
const SLIDE_WIDTH = 1550; // 引き戸の W（扉幅 800＝既定の defaultWidth）
const SLIDE_HEIGHT = 2000;
const THIN_WALL_OFFSET = 25; // 薄い手動壁の軸からの距離＝壁厚
const ECCENTRIC_WALL_OFFSET = 300; // 偏芯の手動壁の軸からの距離

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = (outIndex >= 0 ? args[outIndex + 1] : args.find(a => !a.startsWith('--')))
  ?? 'D:/tatsuya/Download/sliding-door-test.stq';
if (fs.existsSync(outPath)) {
  console.error(`既存ファイルを上書きしません: ${outPath}`);
  process.exit(1);
}

// 構造反映が storage/db.js saveFloor を直呼びするため、実 IDB に触れない最小のインメモリ IDB を差す
// （makeWindowSectionTestDoc.mjs の withFakeIndexedDB と同じ。本番では使わない）。
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
const project = new Project('sliding-door-test', '引き戸テスト');
project.structuralInfo.setField('mainStructure', 'S造');
const { plane, graph: g } = project.addPlane(0, '1階', 'p1', 1, 1);

const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const XS = COL_X.map(v => addAxis(CenterLineType.VERTICAL, v));
const YS = ROW_Y.map(v => addAxis(CenterLineType.HORIZONTAL, v));
const YSPECIAL = addAxis(CenterLineType.HORIZONTAL, SPECIAL_Y);
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
for (const w of g.walls) {
  console.log(`  壁 ${w.isVertical ? '縦' : '横'} 軸 ${w.axisCL.effectiveValue}+${w.axisOffset} 範囲 ${w.coord1}..${w.coord2} 外壁=${w.isExteriorWall}`);
}

// ---- 建具を置く ----
const clOf = (id) => g.centerLines.find(c => c.id === id);
// 軸 CL の値 axisValue・向き isVertical の壁のうち、[lo,hi] を覆い isExteriorWall が exterior のもの（軸からの距離が小さい順）
const hostWalls = (isVertical, axisValue, lo, hi, exterior) => [...g.walls]
  .filter(w => w.isVertical === isVertical && Math.abs(w.axisCL.effectiveValue - axisValue) < 1
    && Math.min(w.coord1, w.coord2) <= lo + 1e-6 && Math.max(w.coord1, w.coord2) >= hi - 1e-6 // 壁は部屋の内面どうし（57.5 内側）なので建具の範囲で覆うか判定する
    && Boolean(w.isExteriorWall) === exterior)
  .sort((a, b) => Math.abs(a.axisOffset) - Math.abs(b.axisOffset));

const specs = []; // { name, isVertical, axisValue, lo, hi, exterior, hingeSide }
const rowSpan = j => [ROW_Y[j], ROW_Y[j + 1]];
const colSpan = i => [COL_X[i], COL_X[i + 1]];
specs.push({ name: '内壁 縦 X1 hinge−1', isVertical: true, axisValue: COL_X[1], span: rowSpan(0), exterior: false, hingeSide: -1 });
specs.push({ name: '内壁 縦 X2 hinge+1', isVertical: true, axisValue: COL_X[2], span: rowSpan(0), exterior: false, hingeSide: 1 });
specs.push({ name: '内壁 横 Y1 列1 hinge−1', isVertical: false, axisValue: ROW_Y[1], span: colSpan(0), exterior: false, hingeSide: -1 });
specs.push({ name: '内壁 横 Y1 列2 hinge+1', isVertical: false, axisValue: ROW_Y[1], span: colSpan(1), exterior: false, hingeSide: 1 });
specs.push({ name: '外壁境界(室内向き壁) 縦 X0 hinge−1', isVertical: true, axisValue: COL_X[0], span: rowSpan(0), exterior: false, hingeSide: -1 });
specs.push({ name: '外壁境界(室内向き壁) 縦 X3 hinge+1', isVertical: true, axisValue: COL_X[3], span: rowSpan(0), exterior: false, hingeSide: 1 });
specs.push({ name: '外壁境界(室内向き壁) 横 Y0 列1 hinge−1', isVertical: false, axisValue: ROW_Y[0], span: colSpan(0), exterior: false, hingeSide: -1 });
specs.push({ name: '外壁境界(室内向き壁) 横 Y2 列3 hinge+1', isVertical: false, axisValue: ROW_Y[2], span: colSpan(2), exterior: false, hingeSide: 1 });
specs.push({ name: '外壁ホスト 横 Y2 列2（R12 通知用）', isVertical: false, axisValue: ROW_Y[2], span: colSpan(1), exterior: true, hingeSide: -1 });

const placed = [];
const placeSlide = (name, host, isVertical, span, hingeSide) => {
  const center = (span[0] + span[1]) / 2;
  const wallSide = Math.sign(host.axisOffset) || 1;
  const refCL = clOf((isVertical ? YS[0] : XS[0]).id);
  const o = g.addOpening(host.axisCL, wallSide, isVertical, refCL, center, SLIDE_WIDTH, OpeningCategory.FITTING, 'sliding',
    { height: SLIDE_HEIGHT, swingSide: wallSide, hingeSide });
  console.log(`  ${name}: 壁 axisOffset=${host.axisOffset} 外壁=${host.isExteriorWall} 範囲 ${host.coord1}..${host.coord2} 開口 ${o.coord1}..${o.coord2} wallSide=${wallSide} hingeSide=${hingeSide}`);
  check(findHostWall(o, g)?.id === host.id, `${name}: ホスト壁が意図した壁（外壁=${host.isExteriorWall}）`);
  placed.push({ o, host, name });
};
for (const s of specs) {
  const mid = (s.span[0] + s.span[1]) / 2;
  const hosts = hostWalls(s.isVertical, s.axisValue, mid - SLIDE_WIDTH / 2, mid + SLIDE_WIDTH / 2, s.exterior);
  check(hosts.length > 0, `${s.name}: 壁が引ける（${hosts.length} 本）`);
  if (hosts.length === 0) continue;
  placeSlide(s.name, hosts[0], s.isVertical, s.span, s.hingeSide);
}
if (failed) process.exit(1);

// 手動壁（部屋の外。薄い壁と偏芯した壁）。壁生成の外で足すので isExteriorWall は false（屋内壁扱い）
const manualWall = (axisOffset, from, to) => g.addWall(clOf(YSPECIAL.id), axisOffset, false, clOf(XS[from].id), 0, clOf(XS[to].id), 0, { isExteriorWall: false });
const thinWall = manualWall(THIN_WALL_OFFSET, 0, 1);
const eccentricWall = manualWall(ECCENTRIC_WALL_OFFSET, 1, 2);
placeSlide(`薄い壁（壁厚 ${THIN_WALL_OFFSET}）`, thinWall, false, colSpan(0), -1);
placeSlide(`偏芯した壁（軸から ${ECCENTRIC_WALL_OFFSET}）`, eccentricWall, false, colSpan(1), 1);
if (failed) process.exit(1);

// ---- 往復テスト（書いて読み直してダイジェスト一致）----
function digestProject(proj) {
  const out = {};
  for (const pl of proj.planes) {
    const gr = proj.graphMap.get(pl.id);
    out[pl.name] = {
      walls: gr.walls.map(w => `${w.isVertical}:${Math.round(w.coord1)}:${Math.round(w.coord2)}:${Math.round(w.axisCL.effectiveValue)}:${w.axisOffset}:${w.isExteriorWall}`).sort(),
      rooms: gr.rooms.map(r => `${r.name}:${r.feature}:${[...r.cells].sort().join(',')}`).sort(),
      openings: gr.openings.map(o => `${o.category}:${o.subType}:${o.wallSide}:${Math.round(o.centerCoord)}:${o.width}:${o.height}:${o.swingSide}:${o.hingeSide}`).sort(),
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
const slides = G.openings.filter(o => o.subType === 'sliding');
const EXPECTED_SLIDES = placed.length;
check(P.planes.length === 1 && G.rooms.length === 6 && slides.length === EXPECTED_SLIDES,
  `1 階・部屋 6・引き戸 ${EXPECTED_SLIDES}（rooms ${G.rooms.length}・sliding ${slides.length}）`);
check(slides.every(o => Math.abs(o.coord2 - o.coord1 - SLIDE_WIDTH) < 1e-6), `引き戸の W がすべて ${SLIDE_WIDTH}`);
check(slides.filter(o => o.hingeSide === -1).length + slides.filter(o => o.hingeSide === 1).length === EXPECTED_SLIDES
  && slides.some(o => o.hingeSide === -1) && slides.some(o => o.hingeSide === 1), 'hingeSide が −1・+1 の両方に保存されている');

// 壁の描画スパン（平面）: 屋内壁ホストは穴＝扉幅−50（750）だけ壁が欠け、外壁ホストは W 全幅（従来描き）が欠ける
const plan = buildWallDrawPlan(G, LodLevel.STANDARD);
const gapInside = (segments, lo, hi) => {
  const covered = segments.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, hi) - Math.max(a, lo)), 0);
  return (hi - lo) - covered;
};
for (const o of slides) {
  const host = findHostWall(o, G);
  const segments = plan.wallLines.get(host.id).segments;
  const gap = gapInside(segments, Math.min(o.coord1, o.coord2), Math.max(o.coord1, o.coord2));
  const expected = host.isExteriorWall ? SLIDE_WIDTH : slideDoorWidth(SLIDE_WIDTH) - SLIDE_OUTSET_WIDTH_DEDUCT_MM;
  check(Math.abs(gap - expected) < 1e-6, `壁の欠け ${gap}（期待 ${expected}・外壁=${host.isExteriorWall}・開口 ${o.coord1}..${o.coord2}）`);
}

// 建具モードの通知: 外壁ホストの引き戸があるので 1 件
const notices = collectSlideOnExteriorWall(G);
check(notices.length === 1, `外壁ホストの引き戸の通知が 1 件（${notices.length}）`);
if (failed) {
  fs.unlinkSync(outPath); // 書き出し後の検査 NG は不良な文書を残さない（上書き防止があるので残すと手で消すしかない）
  console.error(`検査 NG のため削除しました: ${outPath}`);
  process.exit(1);
}
