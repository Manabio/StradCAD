// 部屋の取り合い（junction。部分詳細図 S8a）の目視用 .stq を作る probe。
// 1 階・部屋 3 つ（LDK 4000×3000 / 洋室 3000×1500 / 納戸 3000×1500。LDK だけ Room.detailRefs を割当て、洋室・納戸は未割当ての対照）。
// 同梱の詳細図: df-jn-baseboard（floorWall。巾木 150×60＋面取り・下地 1 本・印なし）／df-jn-cornice（wallCeiling。廻り縁 40×20・1 辺 air）／
// df-jn-countertop（kneeTop。カウンター天板 厚 30・表の側へ 150・裏へ 12。S8b-2 の帯の端の切断面の差し替え確認用）。
// 腰壁（LDK|洋室の仕切り壁の y 500..1400＝組込み天板）・帯の端の腰壁（同 y 1400..1800＝カウンター天板。洋室・納戸の仕切り壁 y=1500 が突き当たる隅）・
// 戸 1（仕切り壁）・窓 1（LDK 南外壁）を含む。
// 小上がり（LDK の x 0..1500 の部分指定の子・床 +300＝高い側）に df-jn-stepnose（floorStep。段鼻 出 120・厚 40＋見切り 30＝形状差 120。S8b-3）を割当て、
// 段差見付け面の派生線と壁面上の riser の差し替え（上辺・下辺の 2 面）を割当ての有無の差で数える。
// 使い方: cd app && MSYS_NO_PATHCONV=1 node --import ./scripts/testSetup.mjs scripts/probe/makeJunctionDetailTestDoc.mjs --out D:/tatsuya/Download/junction-detail-test.stq
// 既存ファイルは上書きしない（再生成は先に削除する）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Project, CenterLineType, Discipline, OpeningCategory, edgeKey } from '../../src/core.js';
import { serializeGraph, serializeStructCLs, serializePlanes } from '../../src/graphSnapshot.js';
import { buildDocumentJson } from '../../src/storage/documentFile.js';
import { runFinishExitBoundary } from '../../src/finish/finishBoundary.js';
import { placeOpeningWithDefaults } from '../../src/openings/openingEdit.js';
import { kneeDropWallGeometry, effectiveCeilingHeight, validateKneeDropWall } from '../../src/finish/kneeDropWall.js';
import { buildCellToRoom } from '../../src/finish/edgeClassify.js';
import { getCellsInRect } from '../../src/finish/gridCells.js';
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { emptyBundle, withEntries } from '../../src/catalog/catalogBundle.js';
import { CatalogKind } from '../../src/catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../../src/catalog/catalogRegistry.js';
import { DetailSlot, DetailDash, DetailEdgeMark, DetailParam, PenDir, DETAIL_PRIM_SOURCE, KneeDropFrontSide } from '../../src/core/constants.js';
import detailBuiltins, { KNEE_CAP_20_KEY } from '../../src/detail/detailBuiltins.js';
import { junctionFigure, partFigure, paramLen, fixedLen, move, stepNoseFigure, ceilingNoseFigure } from '../../src/finish/roomDetailTestFixtures.js';
import { CeilingZone } from '../../src/core/ceilingZone.js';
import { createZone } from '../../src/ceiling/ceilingZones.js';
import { ElevationModeState } from '../../src/modes/ElevationModeState.js';
import { composeRoomFaces } from '../../src/elevation/elevationFaceList.js';
import { loadDocument } from './loadDoc.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : 'D:/tatsuya/Download/junction-detail-test.stq';
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }

let failed = false;
const check = (ok, msg) => { if (ok) console.log(`OK: ${msg}`); else { console.error(`NG: ${msg}`); failed = true; } };

// ---- 詳細図 ----
const KEY_FW = 'df-jn-baseboard';
const KEY_WC = 'df-jn-cornice';
// (1) 巾木: 壁面 s=0・FL t=0 から 上へ 150 → 出 100 → 面取り（+20,+40）→ 下へ 110 で閉。
//     形状差（室内側の最大 s）＝120 > DETAIL_SECTION_SWAP_MIN_DIFF_MM 100 なので、倍率が詳細（分母 ≤ 60）なら帯の切断面が差し替わる
//     （目視用に出を大きくしてある。実際の巾木の出 10〜40 では形状差が閾値に届かず差し替えは起きない＝規則どおり）。
const baseboard = junctionFigure(KEY_FW, DetailSlot.FLOOR_WALL, [
  move(PenDir.UP, fixedLen(150)),
  move(PenDir.RIGHT, fixedLen(100)),
  { dir: PenDir.VECTOR, dx: fixedLen(20), dy: fixedLen(40), ss: 1, st: 1 },
  move(PenDir.DOWN, fixedLen(110)),
], { closed: true, over: { label: '巾木150 出120（差し替え確認用）' } });
// 下地 1 本（壁の中: s 0 → −30、FL から高さ 100。閉）。基準は同じ ds0／dt0 を stroke b の頂点 0 に載せる。
baseboard.strokes.push({
  id: 'b', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
  moves: [move(PenDir.LEFT, fixedLen(30)), move(PenDir.UP, fixedLen(100)), move(PenDir.RIGHT, fixedLen(30))],
});
baseboard.anchors.push({ datumId: 'ds0', strokeId: 'b', vertexIndex: 0 }, { datumId: 'dt0', strokeId: 'b', vertexIndex: 0 });
// (2) 廻り縁: 天井面 t=0 から 下へ 40 → 出 20（この辺を air）→ 上へ 40 で閉。形状差 20。
const cornice = junctionFigure(KEY_WC, DetailSlot.WALL_CEILING, [
  move(PenDir.DOWN, fixedLen(40)),
  { ...move(PenDir.RIGHT, fixedLen(20)), edge: DetailEdgeMark.AIR },
  move(PenDir.UP, fixedLen(40)),
], { closed: true, over: { label: '廻り縁40×20（下面 air）' } });
// (3) カウンター天板（kneeTop。S8b-2 の差し替え確認用）: 表の側へ 150 出て厚 30・裏の側へ 12 出る閉じた図（組込み天板は出 12 で形状差が閾値に届かない）。
//     頂点 (150,0)→(150,30)→(0,30)→(−壁厚,30)→(−壁厚−12,30)→(−壁厚−12,0)。s の origin＝頂点 2（表の側の仕上げ面）・t の origin＝頂点 0（天端）。
const KEY_CT = 'df-jn-countertop';
const counterTop = partFigure(KEY_CT, DetailSlot.KNEE_TOP, [
  move(PenDir.DOWN, fixedLen(30)), move(PenDir.LEFT, fixedLen(150)), move(PenDir.LEFT, paramLen(DetailParam.WALL_THICKNESS, 100)),
  move(PenDir.LEFT, fixedLen(12)), move(PenDir.UP, fixedLen(30)),
], { sVertex: 2, tVertex: 0 });
counterTop.label = 'カウンター天板 厚30 出150＋壁厚＋12（差し替え確認用）';
// (4) 段鼻（floorStep。S8b-3）: 高い側の床から 出 120 → 厚 40 → 見切り（内へ 90・下へ 30・内へ 30）→ 低い側の床まで伸縮。形状差 120 > 100 なので壁面上の riser が差し替わる。
const KEY_ST = 'df-jn-stepnose';
const stepNose = stepNoseFigure(KEY_ST);
stepNose.label = '段鼻 出120 厚40＋見切り30（差し替え確認用）';
// (5) 天井の見切り（ceilingStep。S8b-4a）: 低い側の天井面から 出 150 → 厚 40 → 見切り（内へ 120・上へ 30・内へ 30）→ 高い側の天井面まで伸縮。形状差 150 > 100 なので壁面上の天井段差の縦線が差し替わる。
const KEY_CS = 'df-jn-ceilstep';
const ceilStep = ceilingNoseFigure(KEY_CS, { overhang: 150 });
ceilStep.label = '天井の見切り 出150 厚40＋見切り30（差し替え確認用）';

// ---- 構築 ----
const project = new Project('junction-detail-test', '部屋の取り合い詳細図テスト');
const { plane, graph } = project.addPlane(0, '1階');
const sg = project.structGraph;
const addAxis = (type, value) => sg.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
const X0 = addAxis(CenterLineType.VERTICAL, 0);
const X1 = addAxis(CenterLineType.VERTICAL, 4000);
const X2 = addAxis(CenterLineType.VERTICAL, 7000);
const Y0 = addAxis(CenterLineType.HORIZONTAL, 0);
const Y1 = addAxis(CenterLineType.HORIZONTAL, 3000);
const addCL = (type, value) => graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
const Ya = addCL(CenterLineType.HORIZONTAL, 500);   // 腰壁の区間 y 500..1400（仕切り壁 X1）
const Yb = addCL(CenterLineType.HORIZONTAL, 1500);
const Yd = addCL(CenterLineType.HORIZONTAL, 1400);
const Yc = addCL(CenterLineType.HORIZONTAL, 1800);   // 帯の端の腰壁の区間 y 1400..1800（S8b-2。洋室の南面・納戸の北面の端が仕切り壁 X1 の隅に突き当たる）
const Xs = addCL(CenterLineType.VERTICAL, 1500);    // 小上がり（LDK の部分指定の子。床 +300）の境（S8b-3。S8b-2 の確認箇所＝仕切り壁 X1 の LDK 側から離す）
const Xz = addCL(CenterLineType.VERTICAL, 5500);    // 洋室の下がり天井の区画の境（S8b-4a。洋室の東半分＝x 5500..7000 の天井を 2100 に下げる）
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
const ldk = graph.addRoom(new Set([cellKey(X0, Y0, X1, Y1)]), 'LDK');
const yoshitsu = graph.addRoom(new Set([cellKey(X1, Y0, Xz, Yb), cellKey(Xz, Y0, X2, Yb)]), '洋室');
const nando = graph.addRoom(new Set([cellKey(X1, Yb, X2, Y1)]), '納戸');
ldk.setOverride('ceilingHeight', '2400');
yoshitsu.setOverride('ceilingHeight', '2400');
nando.setOverride('ceilingHeight', '2400');
// 洋室・納戸は detailRefs 未割当てでも巾木高さ（h=60）があれば組込み巾木が既定で描かれる（S8c の確認用）
yoshitsu.finish.setField('baseboardHeight', 'h=60');
nando.finish.setField('baseboardHeight', 'h=60');
// 小上がり: LDK の x 0..1500 の全セルを部分指定の子にし、床を +300（高い側）。df-jn-stepnose を割り当てる（S8b-3）
const kamiagari = graph.addRoom(new Set(getCellsInRect(X0.value, Y0.value, Xs.value, Y1.value, graph).map(c => c.key)), '小上がり', undefined, new Set([ldk.id]));
kamiagari.setFloorLevel(300);
// 小上がりの天井は LDK より 300 低い（絶対高さ 300＋1800＝2100。LDK は 2400）。天井の段差は部屋単位の割当て（Room.detailRefs.ceilingStep。S8b-4a）で持つ
kamiagari.setOverride('ceilingHeight', '1800');
// 洋室の東半分（Xz..X2）を下がり天井の区画（2100）にする（区画の割当て＝CeilingZone.detailRefs.ceilingStep。S8b-4a）
{
  const { zones, zoneId } = createZone(graph, yoshitsu, [cellKey(Xz, Y0, X2, Yb)], { heightMm: 2100, shape: 'flat', dims: [] });
  yoshitsu.setCeilingZones(zones.map(z => (z.id === zoneId ? new CeilingZone({ ...z.toData(), detailRefs: { [DetailSlot.CEILING_STEP]: KEY_CS } }) : z)));
}

// 構造反映が storage/db.js saveFloor を直呼びするため、最小のインメモリ IDB を差す（makeFrameOnlySectionTestDoc.mjs と同じ）。
function withFakeIndexedDB(fn) {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) { const req = new FakeRequest(); this.data.set(value.planeId ?? value.projectId, value); queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } })); return req; }
    get(key) { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } })); return req; }
  }
  class FakeDB {
    constructor() { this.stores = new Map(); this.objectStoreNames = { contains: (n) => this.stores.has(n) }; for (const name of ['floors', 'projects', 'savedFloors']) this.stores.set(name, new FakeStore()); }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open() { const req = new FakeRequest(); queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } })); return req; } };
  return fn().finally(() => { globalThis.indexedDB = original; });
}
project.structuralInfo.setField('mainStructure', 'S造');
const materialMap = await loadMaterialMap();
const originalPeek = floorSwapManager.peek;
floorSwapManager.peek = async (p) => project.graphMap.get(p.id);
try {
  await withFakeIndexedDB(async () => { await runFinishExitBoundary(graph, project, { materialMap }, {}); });
} finally {
  floorSwapManager.peek = originalPeek;
}
console.log(`walls=${graph.walls.length} rooms=${graph.rooms.map(r => r.name).join(',')}`);

// 腰壁（仕切り壁 X1 の y 500..1400、天端 800）
const cellToRoom = buildCellToRoom(graph);
const kneeKey = edgeKey(X1.id, Ya.id, Yd.id);
const kneeCheck = validateKneeDropWall(800, null, effectiveCeilingHeight(graph, kneeKey, cellToRoom));
console.log('knee validate:', JSON.stringify(kneeCheck), 'geometry:', kneeDropWallGeometry(graph, kneeKey, cellToRoom) ? 'resolved' : 'UNRESOLVED');
// 腰壁の天端に組込み「天板 厚 20×（12＋壁厚＋12）」を割り当て（S8b-1）。表の側＝LDK 側（LDK が区間の負側なら roomNeg・正側なら roomPos）
const kneeGeo = kneeDropWallGeometry(graph, kneeKey, cellToRoom);
const frontSide = kneeGeo?.roomPos === ldk ? KneeDropFrontSide.ROOM_POS : KneeDropFrontSide.ROOM_NEG;
if (kneeCheck.valid) {
  graph.setKneeDropWall(kneeKey, { knee: { topHeight: 800 }, drop: null, detailRefs: { [DetailSlot.KNEE_TOP]: KNEE_CAP_20_KEY }, frontSide });
} else console.log('WARNING: 腰壁を省きます');
// 帯の端に腰壁が来る箇所（仕切り壁 X1 の y 1400..1800、天端 900）にカウンター天板を割り当て（S8b-2）。
// 納戸の北面（仕切り壁 Yb）の西端が X1 の腰壁に突き当たり、その切断面（LDK 側へ出 150 の天板を裏の側から見る）が輪郭に差し替わる。
// 洋室の南面の西端（仕切り壁との隅）は、F の部屋の側の探索点（仕上げ面 1442.5 から洋室側へ 2 mm）に立つ仕切り壁の一片 ..1500 が
// 500..1400 の組込み天板の構成壁（1400..1800 とは重なり 100 で構成壁でない）＝組込み天板（出 12・形状差が閾値に届かない）で差し替えない対照。
// 納戸の北面の西端は一片 1500.. が 1400..1800 の構成壁＝カウンター天板で差し替わる。
const cornerKneeKey = edgeKey(X1.id, Yd.id, Yc.id);
const cornerKneeCheck = validateKneeDropWall(900, null, effectiveCeilingHeight(graph, cornerKneeKey, cellToRoom));
console.log('corner knee validate:', JSON.stringify(cornerKneeCheck), 'geometry:', kneeDropWallGeometry(graph, cornerKneeKey, cellToRoom) ? 'resolved' : 'UNRESOLVED');
if (cornerKneeCheck.valid) {
  graph.setKneeDropWall(cornerKneeKey, { knee: { topHeight: 900 }, drop: null, detailRefs: { [DetailSlot.KNEE_TOP]: KEY_CT }, frontSide });
} else console.log('WARNING: 端の腰壁を省きます');

// 戸（仕切り壁 y=2300）・窓（LDK 南外壁 x=2000）
const partition = graph.walls.find(w => w.isVertical && !w.isExteriorWall && Math.abs(w.axisCL.effectiveValue - 4000) < 1);
const south = graph.walls.find(w => w.isExteriorWall && !w.isVertical && Math.abs(w.axisCL.effectiveValue - 3000) < 1
  && Math.min(w.coord1, w.coord2) <= 2000 && Math.max(w.coord1, w.coord2) >= 2000);
check(!!partition && !!south, '仕切り壁と LDK 南外壁が引ける');
const door = placeOpeningWithDefaults(graph, project, partition, { x: 4000, y: 2300 }, OpeningCategory.FITTING);
const win = placeOpeningWithDefaults(graph, project, south, { x: 2000, y: 3000 }, OpeningCategory.WINDOW);
console.log('door:', !!door.opening, door.error ?? '', ' window:', !!win.opening, win.error ?? '');
check(!!door.opening && !!win.opening, '戸 1・窓 1 を配置');

// 割当て（LDK のみ）
ldk.setDetailRefs({ [DetailSlot.FLOOR_WALL]: KEY_FW, [DetailSlot.WALL_CEILING]: KEY_WC });
// 床の段差は高い側の部屋（小上がり）に割り当てる（S8b-3）
kamiagari.setDetailRefs({ [DetailSlot.FLOOR_STEP]: KEY_ST, [DetailSlot.CEILING_STEP]: KEY_CS });

// ---- 保存 ----
const catalogs = withEntries(emptyBundle(), CatalogKind.DETAIL_FIGURE, [baseboard, cornice, counterTop, stepNose, ceilStep]);
const floors = [{ planeId: plane.id, bytes: serializeGraph(graph) }];
const struct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
const json = buildDocumentJson({ floors, struct, planes: serializePlanes(project), site: null, info: null, bootPlaneId: plane.id, catalogs });
if (failed) process.exit(1);
fs.writeFileSync(outPath, json);
const buf = fs.readFileSync(outPath);
console.log('wrote', outPath, buf.length, 'bytes sha256', crypto.createHash('sha256').update(buf).digest('hex'));

// ---- 読み戻し ----
const { project: P, doc } = loadDocument(outPath);
const G = P.graphMap.get(P.planes[0].id);
for (const r of G.rooms) console.log(`room ${r.name}: detailRefs=${JSON.stringify(r.detailRefs)}`);
const rl = G.rooms.find(r => r.name === 'LDK');
const ry = G.rooms.find(r => r.name === '洋室');
check(rl?.detailRefs?.floorWall === KEY_FW && rl?.detailRefs?.wallCeiling === KEY_WC, 'LDK の detailRefs が往復する');
check(ry && ry.detailRefs == null, '洋室は未割当て');
const figs = doc.catalogs?.catalogs?.[CatalogKind.DETAIL_FIGURE] ?? [];
console.log('同梱の詳細図:', figs.map(f => f.key).join(','));
check(figs.map(f => f.key).sort().join(',') === [KEY_FW, KEY_WC, KEY_CT, KEY_ST, KEY_CS].sort().join(','), '同梱の detailFigure 5 件');
const rk = G.rooms.find(r => r.name === '小上がり');
check(rk?.detailRefs?.floorStep === KEY_ST && rk.referenceRoomIds.has(rl.id) && G.effectiveFloorLevel(rk) - G.effectiveFloorLevel(rl) === 300,
  '小上がり（LDK の部分指定の子・床 +300）の detailRefs.floorStep が往復する');
check(rk?.detailRefs?.ceilingStep === KEY_CS, '小上がりの部屋単位の detailRefs.ceilingStep が往復する');
check(ry?.ceilingZones.length === 1 && ry.ceilingZones[0].heightMm === 2100 && ry.ceilingZones[0].detailRefs?.ceilingStep === KEY_CS,
  '洋室の下がり天井の区画（2100）の detailRefs.ceilingStep が往復する');
check(G.openings.length === 2, `建具 2（${G.openings.length}）`);
const kneeRecs = [...G.kneeDropWalls.values()];
console.log('腰壁の記録:', JSON.stringify(kneeRecs));
check(kneeRecs.length === 2 && kneeRecs.some(r => r.detailRefs?.kneeTop === KNEE_CAP_20_KEY) && kneeRecs.some(r => r.detailRefs?.kneeTop === KEY_CT),
  '腰壁の記録の detailRefs.kneeTop（組込み天板・カウンター天板）が往復する');

// ---- 展開（ElevationModeState）----
function countFor() {
  return async () => {
    clearOverlays();
    // 組込み層（天板）はアプリが非同期に載せる。probe では利用者層に載せて同じ三層合成に通す
    setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
    const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
    const result = await st.init();
    const prims = st.bands.flatMap(b => b.primitives);
    const det = prims.filter(p => p.source === DETAIL_PRIM_SOURCE);
    const by = {};
    for (const p of det) { const k = `${p.type}/${p.weight}`; by[k] = (by[k] ?? 0) + 1; }
    // 腰壁の天端（800）の下の細線の高さ別の本数（帯ごと）。天板の派生線（厚 20）は最小描画幅（0.5mm×縮尺の分母）へ調整され、
    // 既存の天端の下の細線（max(20, 最小幅)）と同じ高さに重なって 1 本になる（source は残らない）。
    // y=−750（天端の 50 下）＝最小幅 50（分母 ≥ 100）・y=−780（20 下）＝最小幅 ≤ 20（分母 ≤ 40）
    const kneeCapBy = {};
    for (const b of st.bands) {
      const thinAt = y => b.primitives.filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === y && p.y2 === y).length;
      kneeCapBy[G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId] = { 'y-750(50下)': thinAt(-750), 'y-780(20下)': thinAt(-780) };
    }
    // 巾木（h=60）の線 y=−60 の本数（帯ごと）。derived＝図の派生線（source=detail）・legacy＝従来経路（appendBaseboard。フォールバック）
    const baseboardBy = {};
    for (const b of st.bands) {
      const at60 = b.primitives.filter(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60);
      baseboardBy[G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId] = {
        derived: at60.filter(p => p.source === DETAIL_PRIM_SOURCE).length, legacy: at60.filter(p => p.source === undefined).length,
      };
    }
    return { ok: result.ok, bands: st.bands.length, err: st.materialError, by, n: det.length, kneeCapBy, baseboardBy };
  };
}
const withRefs = await countFor()();
console.log('展開 割当てあり:', JSON.stringify(withRefs));
check(withRefs.n > 0, '割当て部屋の展開に source=detail のプリミティブが出る');
console.log('腰壁の天端の下の細線（高さ別の本数。帯ごと）:', JSON.stringify(withRefs.kneeCapBy));
console.log('巾木 y=−60 の本数（帯ごと）:', JSON.stringify(withRefs.baseboardBy));
// S8c: 未割当ての洋室・納戸でも巾木は組込みの図の派生線（source=detail）。従来経路の線（source なし）は引かれない
check(withRefs.baseboardBy['洋室'].derived > 0 && withRefs.baseboardBy['洋室'].legacy === 0, '洋室（未割当て）の巾木が組込みの既定から描かれる');
check(withRefs.baseboardBy['納戸'].derived > 0 && withRefs.baseboardBy['納戸'].legacy === 0, '納戸（未割当て）の巾木が組込みの既定から描かれる');
check(withRefs.err === null, `暗黙の既定は通知しない（${withRefs.err}）`);
check(Object.values(withRefs.kneeCapBy).some(c => c['y-750(50下)'] + c['y-780(20下)'] > 0), '腰壁の天端（kneeTop）の下に細線が出る（天板は最小描画幅へ調整され既存線と重なる）');

// ---- 帯の端の腰壁の切断面（S8b-2）: カウンター天板の輪郭 polyline（CUT・source=detail）----
{
  clearOverlays();
  setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
  const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
  await st.init();
  // カウンター天板（天端 900・厚 30）の輪郭は、端の天端 y=−900 を最上点・y=−870 を壁の面に戻る点に持つ折り返しの折れ線
  const isCounterOutline = p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick'
    && Math.min(...p.points.map(q => q[1])) === -900;
  const byRoom = {};
  for (const b of st.bands) {
    const name = G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId;
    const polys = b.primitives.filter(isCounterOutline);
    byRoom[name] = polys.length;
    console.log(`帯 ${name}: 腰壁の端の輪郭 polyline（CUT・source=detail）${polys.length} 本`);
    for (const p of polys) {
      console.log('  ', JSON.stringify(p.points));
      // 端の CUT 縦線は天端側 [−900,−870] だけが消えている（z1 の一致の実測）
      const x = p.points[0][0];
      const v = b.primitives.filter(q => q.type === 'line' && q.weight === 'thick' && Math.abs(q.x1 - x) < 1e-6 && Math.abs(q.x2 - x) < 1e-6).map(q => [q.y1, q.y2].sort((a, c) => a - c)).sort((a, c) => a[0] - c[0]);
      console.log('   端の CUT 縦線:', JSON.stringify(v));
      check(v.length === 2 && v[0][1] === -900 && v[1][0] === -870, `${name}: 端の縦線が [−900,−870] で割れている`);
      // 向こう側（LDK）の面: 天板の下から向こう側の床まで連なる CUT の縦線（source=detail）。輪郭の最後の点の x が向こう側の面
      const farX = p.points[p.points.length - 1][0];
      const far = b.primitives.filter(q => q.type === 'line' && q.source === DETAIL_PRIM_SOURCE && Math.abs(q.x1 - farX) < 1e-6 && Math.abs(q.x2 - farX) < 1e-6);
      console.log('   向こう側の縦線:', JSON.stringify(far.map(q => [q.y1, q.y2].sort((a, c) => a - c))));
      check(far.length === 1 && Math.min(far[0].y1, far[0].y2) === -870 && Math.max(far[0].y1, far[0].y2) === 0, `${name}: 向こう側の縦線が [−870, 向こう側の床 0]`);
    }
  }
  check(byRoom['洋室'] === 0 && byRoom['納戸'] === 1 && !byRoom['LDK'], '洋室の南面の西端（組込み天板＝形状差が閾値以下）は差し替えず、納戸の北面の西端（カウンター天板）が輪郭 polyline 1 本に差し替わる');
}

// ---- 床の段差（S8b-3）: 小上がりの floorStep の有無で展開の source=detail の差を見る ----
{
  const runElev = async () => {
    clearOverlays();
    setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
    const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
    await st.init();
    return { prims: st.bands.flatMap(b => b.primitives), err: st.materialError };
  };
  const refs = rk.detailRefs;
  const withStep = await runElev();
  rk.setDetailRefs(null);
  const withoutStep = await runElev();
  rk.setDetailRefs(refs);
  const isStepLine = p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thin' && p.y1 === p.y2;
  const isNose = p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick' && p.points.length === 7 && p.points[0][1] === -300;
  const lineDiff = withStep.prims.filter(isStepLine).length - withoutStep.prims.filter(isStepLine).length;
  const noses = withStep.prims.filter(isNose);
  console.log(`段差見付け面の派生線（細線・水平）の増分=${lineDiff}  riser の差し替え輪郭 polyline=${noses.length}`);
  for (const p of noses) console.log('  ', JSON.stringify(p.points));
  check(withStep.err === null && withoutStep.err === null, `床の段差の通知なし（${withStep.err}）`);
  check(lineDiff >= 2, `段差見付け面に派生線（段鼻の厚 40・見切り 70 の高さ）が引かれる（増分 ${lineDiff}）`);
  const isRiser = p => p.type === 'line' && p.weight === 'thick' && p.x1 === p.x2 && Math.min(p.y1, p.y2) === -300 && Math.max(p.y1, p.y2) === 0;
  check(noses.length >= 2 && noses.length === withoutStep.prims.filter(isRiser).length - withStep.prims.filter(isRiser).length,
    `壁面（上辺・下辺）の riser 縦線 [−300,0] が段鼻の輪郭 ${noses.length} 本に差し替わる（割当て無しの縦線本数と一致）`);
}

// ---- 天井の段差（S8b-4a）: 洋室の下がり天井の区画（区画の割当て）と小上がり（部屋単位の割当て）の ceilingStep の有無で展開の輪郭の差を見る ----
{
  const runElev = async () => {
    clearOverlays();
    setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
    const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
    await st.init();
    return { bands: st.bands.map(b => ({ name: G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId, prims: b.primitives })), err: st.materialError };
  };
  // 天井の見切りの輪郭: 高い側の天井（y=−2400）→ 低い側の天井（y=−2100）の 7 点の折れ線（CUT・source=detail）
  const isCeilingNose = p => p.type === 'polyline' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thick' && p.points.length === 7
    && p.points[0][1] === -2400 && p.points.at(-1)[1] === -2100 && p.points[0][0] === p.points.at(-1)[0];
  const noseCountBy = r => Object.fromEntries(r.bands.map(b => [b.name, b.prims.filter(isCeilingNose).length]));
  const zoneRefs = ry.ceilingZones.map(z => z.toData());
  const roomRefs = rk.detailRefs;
  const both = await runElev();
  ry.setCeilingZones(ry.ceilingZones.map(z => new CeilingZone({ ...z.toData(), detailRefs: null })));
  const noZone = await runElev();
  ry.setCeilingZones(zoneRefs.map(d => CeilingZone.fromData(d)));
  rk.setDetailRefs({ floorStep: KEY_ST });
  const noRoom = await runElev();
  rk.setDetailRefs(roomRefs);
  console.log('天井の見切りの輪郭 polyline（帯ごと）割当てあり:', JSON.stringify(noseCountBy(both)), ' 区画の割当て無し:', JSON.stringify(noseCountBy(noZone)), ' 小上がり（部屋単位）の割当て無し:', JSON.stringify(noseCountBy(noRoom)));
  for (const b of both.bands) for (const p of b.prims.filter(isCeilingNose)) console.log(`   ${b.name}`, JSON.stringify(p.points));
  check(both.err === null && noZone.err === null && noRoom.err === null, `天井の段差の通知なし（${both.err}）`);
  const c = noseCountBy(both);
  check(c['洋室'] === 2 && c['LDK'] === 2, `洋室の区画（上辺・下辺の 2 面）と小上がり（LDK の帯の上辺・下辺の 2 面）の天井段差の縦線が輪郭 polyline に差し替わる（${JSON.stringify(c)}）`);
  check(noseCountBy(noZone)['洋室'] === 0 && noseCountBy(noZone)['LDK'] === 2, '区画の割当てを外すと洋室の輪郭が消える（小上がりの分は残る）');
  check(noseCountBy(noRoom)['LDK'] === 0 && noseCountBy(noRoom)['洋室'] === 2, '小上がりの割当てを外すと LDK の帯の輪郭が消える（洋室の分は残る）');
}

// ---- 天井の段差見付け面（S8b-4b-1）: 割当てに関係なく面ができる。洋室の下がり天井の区画＝天井だけの面・小上がり（床 +300・CH 1800）＝床の面へ合流 ----
{
  const faceInfo = r => composeRoomFaces(r, G).filter(f => f.kind === 'step').map(f => ({
    label: f.label, floor: f.stepHeightMm, run: Math.round(f.run), cs: (f.ceilingSteps ?? []).map(c => [Math.round(c.loX), Math.round(c.hiX), c.lowCeilAbsMm, c.ceilStepHeightMm]),
  }));
  const ldk = faceInfo(rl), yoshitsu = faceInfo(ry);
  console.log('LDK の段差見付け面:', JSON.stringify(ldk));
  console.log('洋室の段差見付け面:', JSON.stringify(yoshitsu));
  const ceilingOnly = list => list.filter(f => f.floor === 0 && f.cs.length > 0);
  check(ceilingOnly(yoshitsu).length === 1 && ceilingOnly(yoshitsu)[0].cs[0][2] === 2100 && ceilingOnly(yoshitsu)[0].cs[0][3] === 300,
    '洋室: 下がり天井の区画（2100）の境界に天井だけの面が 1 枚（見付け下端 2100・段差 300）');
  check(ldk.filter(f => f.floor === 300 && f.cs.length === 1 && f.cs[0][2] === 2100).length >= 1 && ceilingOnly(ldk).length === 0,
    'LDK: 小上がり（床 +300・天井 2100）は床の面に ceilingSteps が合流し、天井だけの面は重ならない');
}

// ---- 天井の段差見付け面の派生線（S8b-4b-2）: 割当ての有無の差で source=detail の水平な細線の増分（y ごとの本数）を見る ----
{
  const runElev = async () => {
    clearOverlays();
    setOverlay(CatalogKind.DETAIL_FIGURE, { doc: figs, user: detailBuiltins });
    const st = new ElevationModeState(G, P, { width: 1600, height: 1200 });
    await st.init();
    return { bands: st.bands.map(b => ({ name: G.rooms.find(r => r.id === b.roomId)?.name ?? b.roomId, prims: b.primitives })), err: st.materialError };
  };
  const isDetailHLine = p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE && p.weight === 'thin' && p.y1 === p.y2;
  const countsBy = (r, name) => {
    const m = {};
    for (const b of r.bands.filter(x => x.name === name)) for (const p of b.prims.filter(isDetailHLine)) m[p.y1] = (m[p.y1] ?? 0) + 1;
    return m;
  };
  const added = (a, b) => Object.fromEntries(Object.entries(a).map(([y, n]) => [y, n - (b[y] ?? 0)]).filter(([, n]) => n !== 0));
  const zoneData = ry.ceilingZones.map(z => z.toData());
  const roomRefs = rk.detailRefs;
  const both = await runElev();
  ry.setCeilingZones(ry.ceilingZones.map(z => new CeilingZone({ ...z.toData(), detailRefs: null })));
  const noZone = await runElev();
  ry.setCeilingZones(zoneData.map(d => CeilingZone.fromData(d)));
  rk.setDetailRefs({ floorStep: KEY_ST });
  const noRoom = await runElev();
  rk.setDetailRefs(roomRefs);
  const yoshitsuAdd = added(countsBy(both, '洋室'), countsBy(noZone, '洋室'));
  const ldkAdd = added(countsBy(both, 'LDK'), countsBy(noRoom, 'LDK'));
  console.log('区画の割当てによる洋室の水平細線の増分（y: 本数）:', JSON.stringify(yoshitsuAdd), ' 小上がりの天井割当てによる LDK の増分:', JSON.stringify(ldkAdd));
  check(both.err === null && noZone.err === null && noRoom.err === null, `天井の段差の派生線の通知なし（${both.err}）`);
  check(Object.keys(yoshitsuAdd).sort().join(',') === '-2140,-2170' && Object.values(yoshitsuAdd).every(n => n === 1),
    '洋室の帯の中の細い水平の detail 線: 見付け下端 2100 の上 40・70（見切りの厚の上端と見切りの天端）の y に 1 本ずつ増える（帯全体の数。面の x 範囲での絞り込みは帯が faceRuns を公開しないため不可）');
  check(ldkAdd['-2140'] === 1 && ldkAdd['-2170'] === 1 && Object.keys(ldkAdd).length === 2,
    'LDK の帯の中の細い水平の detail 線: 小上がりの部屋単位の割当てで −2140・−2170 の y に増える（床の面へ合流した面の分。床の派生線 −260・−230 は割当て無しでも残る。帯全体の数）');
}
