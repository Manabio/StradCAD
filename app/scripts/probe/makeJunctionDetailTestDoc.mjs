// 部屋の取り合い（junction。部分詳細図 S8a）の目視用 .stq を作る probe。
// 1 階・部屋 3 つ（LDK 4000×3000 / 洋室 3000×1500 / 納戸 3000×1500。LDK だけ Room.detailRefs を割当て、洋室・納戸は未割当ての対照）。
// 同梱の詳細図: df-jn-baseboard（floorWall。巾木 150×60＋面取り・下地 1 本・印なし）／df-jn-cornice（wallCeiling。廻り縁 40×20・1 辺 air）／
// df-jn-countertop（kneeTop。カウンター天板 厚 30・表の側へ 150・裏へ 12。S8b-2 の帯の端の切断面の差し替え確認用）。
// 腰壁（LDK|洋室の仕切り壁の y 500..1400＝組込み天板）・帯の端の腰壁（同 y 1400..1800＝カウンター天板。洋室・納戸の仕切り壁 y=1500 が突き当たる隅）・
// 戸 1（仕切り壁）・窓 1（LDK 南外壁）を含む。
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
import { loadMaterialMap } from '../../src/finish/wallRegeneration.js';
import { floorSwapManager } from '../../src/storage/FloorSwapManager.js';
import { emptyBundle, withEntries } from '../../src/catalog/catalogBundle.js';
import { CatalogKind } from '../../src/catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../../src/catalog/catalogRegistry.js';
import { DetailSlot, DetailDash, DetailEdgeMark, DetailParam, PenDir, DETAIL_PRIM_SOURCE, KneeDropFrontSide } from '../../src/core/constants.js';
import detailBuiltins, { KNEE_CAP_20_KEY } from '../../src/detail/detailBuiltins.js';
import { junctionFigure, partFigure, paramLen, fixedLen, move } from '../../src/finish/roomDetailTestFixtures.js';
import { ElevationModeState } from '../../src/modes/ElevationModeState.js';
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
const cellKey = (L, T, R, B) => `${L.id}:${T.id}:${R.id}:${B.id}`;
const ldk = graph.addRoom(new Set([cellKey(X0, Y0, X1, Y1)]), 'LDK');
const yoshitsu = graph.addRoom(new Set([cellKey(X1, Y0, X2, Yb)]), '洋室');
const nando = graph.addRoom(new Set([cellKey(X1, Yb, X2, Y1)]), '納戸');
ldk.setOverride('ceilingHeight', '2400');
yoshitsu.setOverride('ceilingHeight', '2400');
nando.setOverride('ceilingHeight', '2400');

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

// ---- 保存 ----
const catalogs = withEntries(emptyBundle(), CatalogKind.DETAIL_FIGURE, [baseboard, cornice, counterTop]);
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
check(figs.map(f => f.key).sort().join(',') === [KEY_FW, KEY_WC, KEY_CT].sort().join(','), '同梱の detailFigure 3 件');
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
    return { ok: result.ok, bands: st.bands.length, err: st.materialError, by, n: det.length, kneeCapBy };
  };
}
const withRefs = await countFor()();
console.log('展開 割当てあり:', JSON.stringify(withRefs));
check(withRefs.n > 0, '割当て部屋の展開に source=detail のプリミティブが出る');
console.log('腰壁の天端の下の細線（高さ別の本数。帯ごと）:', JSON.stringify(withRefs.kneeCapBy));
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
