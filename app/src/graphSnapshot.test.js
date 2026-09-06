import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory, Project, Site, SiteLineKind } from './core.js';
import {
  serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs, serializePlanes, decodePlanes,
  serializeSite, decodeSite, restoreSite,
} from './graphSnapshot.js';
import { editSiteLineLength } from './transform/siteEdit.js';

// wallBeamAxes.test.js と同じ方針: ダックタイピングでは effectiveValue 等の実挙動を
// 再現できないため、実 core.js（Plane/PlanGraph）を使う。

function makeGraph(planeId = 'p1', elevation = 0) {
  const plane = new Plane(planeId, elevation, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 水平に走る外壁1本 + 引き違い窓1件を持つグラフを作る。
function makeGraphWithWindow(openingProps) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const o = graph.addOpening(axisCL, 1, false, clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding', openingProps);
  return { graph, opening: o };
}

test('Opening.fixtureType/sillHeight は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2, '復元後に同一IDの開口が存在する');
  assert.equal(o2.fixtureType, 'AW');
  assert.equal(o2.sillHeight, 800);
});

test('Opening.fixtureType/sillHeight 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({});

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, null);
  assert.equal(o2.sillHeight, null);
});

test('Opening.fixtureType: JW も往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'JW', sillHeight: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.equal(o2.fixtureType, 'JW');
  assert.equal(o2.sillHeight, 0, '0mm（掃き出し窓相当）は null と区別されて保持される');
});

// ---- 失敗系: 未知の fixtureType（想定外値・データ破損等）----
test('Opening.fixtureType: 未知の値("XX")は encode→decode で例外にならずnullへフォールバックし、他フィールドは無傷', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'XX', sillHeight: 950 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  assert.doesNotThrow(() => restoreGraph(restored, bytes));

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.fixtureType, null, '未知のenum値はFIXTURE_TYPE_ENCに無いため0(なし)相当でエンコードされ、復元時null');
  assert.equal(o2.sillHeight, 950, 'fixtureTypeが無効でも他フィールドは無傷');
  assert.equal(o2.width, 1690);
  assert.equal(o2.subType, 'doubleSliding');
  assert.equal(o2.category, OpeningCategory.WINDOW);
});

// ---- Opening削除→undo相当の復元（App.jsx handleMenuSelect 'opening-del' と同じ操作パターン）----
test('Opening削除→undo相当: removeShape後にaddOpening(同id, {fixtureType, sillHeight})で両フィールドが復元される', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 700 });
  const before = {
    fixtureType: opening.fixtureType, sillHeight: opening.sillHeight,
    axisCL: opening.axisCL, wallSide: opening.wallSide, isVertical: opening.isVertical,
    refCL: opening.refCL, refOffset: opening.refOffset, width: opening.width,
    category: opening.category, subType: opening.subType,
    hingeSide: opening.hingeSide, swingSide: opening.swingSide,
  };

  graph.removeShape(opening.id);
  assert.equal(graph.shapeMap.has(opening.id), false, '削除直後は存在しない');

  // App.jsx の undo（opening-del）と同一パターン: 同一IDで addOpening し直す
  const restored = graph.addOpening(
    before.axisCL, before.wallSide, before.isVertical, before.refCL, before.refOffset, before.width,
    before.category, before.subType,
    { hingeSide: before.hingeSide, swingSide: before.swingSide, fixtureType: before.fixtureType, sillHeight: before.sillHeight },
    opening.id,
  );

  assert.equal(restored.id, opening.id);
  assert.equal(restored.fixtureType, 'AW');
  assert.equal(restored.sillHeight, 700);
});

// ---- Opening.height の FlatBuffers 往復（Finding 4 回帰） ----
test('Opening.height は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, 1170);
});

test('Opening.height 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  assert.equal(opening.height, null, '未指定時はnullが既定');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null);
});

// ---- Finding 3 の決定を明文化: height=0 は不正値としてnullに正規化される ----
test('Opening.height=0 は不正値として encode→decode 後は null に正規化される（sillHeightの0(掃き出し窓)とは異なる規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.height, null, 'graphFbs.js の OP.HEIGHT は「0=未設定」規約（r.f64(OP.HEIGHT) || null）。' +
    'sillHeightの0（掃き出し窓）とは異なり、heightの0は物理的に無効な値のため常にnullへ丸められる');
});

// ---- 建具表の新規5フィールド（finish/materialGlass/frameDepth/hardware/note）のFBS往復 ----
test('建具表の新規5フィールドは FlatBuffers encode→decode で値ありのまま往復する', () => {
  const { graph, opening } = makeGraphWithWindow({
    fixtureType: 'AW', sillHeight: 800, height: 1170,
    finish: '内部塗装', materialGlass: 'アルミ', frameDepth: 105, hardware: 'クレセント錠', note: '網戸付き',
  });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.finish, '内部塗装');
  assert.equal(o2.materialGlass, 'アルミ');
  assert.equal(o2.frameDepth, 105);
  assert.equal(o2.hardware, 'クレセント錠');
  assert.equal(o2.note, '網戸付き');
});

test('建具表の新規5フィールドは未設定（null）なら encode→decode 後も null のまま', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170 });
  assert.equal(opening.finish, null);
  assert.equal(opening.materialGlass, null);
  assert.equal(opening.frameDepth, null);
  assert.equal(opening.hardware, null);
  assert.equal(opening.note, null);

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.finish, null);
  assert.equal(o2.materialGlass, null);
  assert.equal(o2.frameDepth, null);
  assert.equal(o2.hardware, null);
  assert.equal(o2.note, null);
});

// ---- Opening.handleHeight の FlatBuffers 往復 ----
test('Opening.handleHeight は FlatBuffers encode→decode で往復する', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, handleHeight: 900 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, 900);
});

test('Opening.handleHeight 未設定（null）は encode→decode 後も null のまま（既定値に化けない）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800 });
  assert.equal(opening.handleHeight, null, '未指定時はnullが既定');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, null);
});

test('Opening.handleHeight=0 は不正値として encode→decode 後は null に正規化される（heightと同じ規約）', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, handleHeight: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.handleHeight, null);
});

// ---- frameDepth=0 は height と同じ規約で不正値としてnullに正規化される ----
test('Opening.frameDepth=0 は不正値として encode→decode 後は null に正規化される', () => {
  const { graph, opening } = makeGraphWithWindow({ fixtureType: 'AW', sillHeight: 800, height: 1170, frameDepth: 0 });

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const o2 = restored.shapeMap.get(opening.id);
  assert.ok(o2);
  assert.equal(o2.frameDepth, null, '0mmの見込みは物理的に無効な値のためnullへ丸められる（heightと同じ規約）');
});

// ---- QA G2: 巾木を""へクリアした部屋はFlatBuffers往復後も""のまま（既定値へ化けない） ----
// graphSnapshot.js:620-622 は「新しいRoomを作ってから空でないフィールドだけ上書きする」実装
// （if (val) room.finish.setField(...)）のため、RoomFinishコンストラクタの既定値が非空だと
// ユーザーがクリアした""が復元のたびに既定値へ巻き戻ってしまう（回帰防止）。
test('【失敗系・QA G2】Room.finish.baseboardMaterial/Heightを""にクリアした部屋はFlatBuffers往復後も""のまま', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  // 一度初期値を入れてから、ユーザーがクリアした状態を再現する。
  room.finish.setField('baseboardMaterial', '木製出幅木');
  room.finish.setField('baseboardHeight', 'h=60');
  room.finish.setField('baseboardMaterial', '');
  room.finish.setField('baseboardHeight', '');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.ok(r2, '復元後に同一IDの部屋が存在する');
  assert.equal(r2.finish.baseboardMaterial, '', '空にクリアした巾木材が既定値へ化けてはいけない');
  assert.equal(r2.finish.baseboardHeight, '', '空にクリアした巾木高さが既定値へ化けてはいけない');
});

// ---- 巾木に値がある場合は従来どおり往復する（G2修正の非破壊確認） ----
test('Room.finish.baseboardMaterial/Heightに値がある場合はFlatBuffers往復で値のまま保持される', () => {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), 'LDK');
  room.finish.setField('baseboardMaterial', 'タイル巾木');
  room.finish.setField('baseboardHeight', 'h=100');

  const bytes = serializeGraph(graph);
  const restored = makeGraph();
  restoreGraph(restored, bytes);

  const r2 = restored.roomMap.get(room.id);
  assert.equal(r2.finish.baseboardMaterial, 'タイル巾木');
  assert.equal(r2.finish.baseboardHeight, 'h=100');
});

// ---- 起動時復元の順序不変条件（store.js 起動IIFE の回帰防止） ----
// restoreGraph は壁の軸CL・端点CLを resolveCL（自グラフ → _structGraph の順）で解決し、
// 解決できない壁を例外もログもなく捨てる。よって「通り芯（restoreStructCLs）→ フロア
// （restoreGraph）」の順を守らないと、通り芯参照の壁が無音で失われる。

// 通り芯を structGraph に持ち、それを参照する壁をフロアグラフに持つ Project を作る。
function makeProjectWithStructWall() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階'); // _structGraph = project.structGraph が自動配線される
  const axisCL  = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const clStart = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const clEnd   = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { project, graph, axisCL, wall };
}

test('【失敗系】通り芯復元前に restoreGraph すると、通り芯参照の壁は例外なく無音で失われる（順序を誤った場合の挙動の固定）', () => {
  const { project, graph, wall } = makeProjectWithStructWall();
  const bytesFloor = serializeGraph(graph);
  void project; // structGraph は復元しない（順序誤りを再現）

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  // project2.structGraph は空のまま（既定通り芯すら無い＝保存IDは解決不能）
  assert.doesNotThrow(() => restoreGraph(graph2, bytesFloor));
  assert.equal(graph2.shapeMap.has(wall.id), false, '軸CLを解決できない壁は復元されない');
});

test('通り芯（restoreStructCLs）→ フロア（restoreGraph）の順なら、壁が同一IDで復元され軸CLはstructGraph上のCLとオブジェクト同一', () => {
  const { project, graph, axisCL, wall } = makeProjectWithStructWall();
  const bytesFloor  = serializeGraph(graph);
  const bytesStruct = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);

  const project2 = new Project('proj2', 'test');
  const { graph: graph2 } = project2.addPlane(0, '1階');
  restoreStructCLs(project2.structGraph, project2.structuralInfo, bytesStruct, project2.memberGroupLedger);
  restoreGraph(graph2, bytesFloor);

  const w2 = graph2.shapeMap.get(wall.id);
  assert.ok(w2, '復元後に同一IDの壁が存在する');
  assert.equal(w2.axisCL, project2.structGraph.shapeMap.get(axisCL.id), '軸CLは復元後structGraphのCLをオブジェクトとして直接参照する');
});

test('restoreStructCLs は既存の structGraph 内容を置換し、既定通り芯を重複させない', () => {
  const project = new Project('proj', 'test');
  const src = project.structGraph;
  src.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  src.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  src.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const bytes = serializeStructCLs(src, project.structuralInfo, project.memberGroupLedger);

  // 復元先には store.js の起動時と同様の既定通り芯2本が先に入っている。
  const project2 = new Project('proj2', 'test');
  const dst = project2.structGraph;
  const defV = dst.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: true, discipline: Discipline.STRUCT });
  const defH = dst.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });

  restoreStructCLs(dst, project2.structuralInfo, bytes, project2.memberGroupLedger);

  assert.equal(dst.centerLines.length, 3, 'スナップショットの3本に置換され、既定分と重複しない');
  assert.equal(dst.shapeMap.has(defV.id), false, '既定通り芯（縦）は残らない');
  assert.equal(dst.shapeMap.has(defH.id), false, '既定通り芯（横）は残らない');
});

// ---- Ship A: plane一覧（serializePlanes/decodePlanes）の FlatBuffers 往復 ----
test('serializePlanes → decodePlanes は plane一覧（通常階・検討階・屋根平面）を往復する', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階',   'p1', 1, 1);
  project.addPlane(3000, '2階',   'p2', 2, 1);
  project.addPlane(0,    '検討A', 'alt1', 1, 1, true, 'p1', 0);
  project.addPlane(6000, '小屋伏', 'roof1', 2, 1, false, null, 0, true, 'p2');
  project.activePlaneId = 'p2';

  const bytes = serializePlanes(project);
  const { planes, activePlaneId } = decodePlanes(bytes);

  assert.equal(activePlaneId, 'p2');
  assert.equal(planes.length, 4);

  const byId = Object.fromEntries(planes.map(p => [p.id, p]));
  assert.equal(byId.p1.elevation, 0);
  assert.equal(byId.p1.name, '1階');
  assert.equal(byId.p1.startFloor, 1);
  assert.equal(byId.p1.stories, 1);
  assert.equal(byId.p1.isAlternative, false);
  assert.equal(byId.p1.referenceId, null, '検討でない階のreferenceIdはnullのまま戻る');
  assert.equal(byId.p1.isRoofPlane, false);
  assert.equal(byId.p1.roofForPlaneId, null);

  assert.equal(byId.p2.elevation, 3000);
  assert.equal(byId.p2.startFloor, 2);

  assert.equal(byId.alt1.isAlternative, true);
  assert.equal(byId.alt1.referenceId, 'p1');
  assert.equal(byId.alt1.altIndex, 0);

  assert.equal(byId.roof1.isRoofPlane, true);
  assert.equal(byId.roof1.roofForPlaneId, 'p2');
});

test('serializePlanes → decodePlanes: activePlaneId 未設定（null）は往復後も null のまま', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  project.activePlaneId = null; // addPlane は初回のみ自動設定するため明示的に戻す

  const bytes = serializePlanes(project);
  const { activePlaneId } = decodePlanes(bytes);
  assert.equal(activePlaneId, null);
});

// ---- QA指摘: readPlaneの "|| 1" フォールバック（旧データ用の既定値補完）に、有効な負値・非0値が
// 巻き込まれて化けないことを確認する ----
test('serializePlanes → decodePlanes: 地下階(startFloor:-1)・stories:2・altIndex:2 は "|| 1" フォールバックに巻き込まれず往復する', () => {
  const project = new Project('proj', 'test');
  project.addPlane(-3000, 'B1階', 'b1', -1, 2); // 地下階: startFloor=-1（addSkipZeroの符号規約）, 2層分
  project.addPlane(0,     '1階',  'p1', 1, 1);
  project.addPlane(0,     '検討C', 'alt1', 1, 1, true, 'p1', 2); // 3番目の検討（altIndex:2）

  const bytes = serializePlanes(project);
  const { planes } = decodePlanes(bytes);
  const byId = Object.fromEntries(planes.map(p => [p.id, p]));

  assert.equal(byId.b1.startFloor, -1, '負のstartFloor（地下階）は readPlane の "r.f64(START_FLOOR) || 1" フォールバックで1に化けない');
  assert.equal(byId.b1.stories, 2, 'stories:2は "|| 1" フォールバックで1に化けない');
  assert.equal(byId.alt1.altIndex, 2, 'altIndex:2は0扱いされず往復する');
});

// ---- 失敗パス: decodePlanesへの不正バイト列 ----
test('decodePlanes: 不正なバイト列（他データの断片）を渡しても例外を投げず、planes:[]・activePlaneId:nullへグレースフルにフォールバックする', () => {
  // graphFbs.js の手書きreaderはフィールド不在時にデフォルト値（空vec/空str）を返す設計のため、
  // 構造化されていないバイト列でも例外にはならない（GS.PLANES/GS.ACTIVE_PLANE_IDが読めない
  // ＝存在しないフィールド扱いになるだけ）。この挙動はdecode()共通で、planes専用の防御コードは無い。
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotThrow(() => decodePlanes(garbage));
  const { planes, activePlaneId } = decodePlanes(garbage);
  assert.deepEqual(planes, []);
  assert.equal(activePlaneId, null);
});

// ---- 敷地（project.site）の FlatBuffers 往復（serializeSite/decodeSite/restoreSite）----

test('serializeSite → restoreSite: 底辺+三角形1個の往復（id・座標・lineKind・redPointIdまで一致、実体同一性も保つ）', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  // redPointId をあえて startPointId と異なる endPoint 側に設定（RED_PT の書き込みミス検出用）
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY, undefined, ep.id);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const apexPt   = site.addPoint(640, 480);
  const tri       = site.addTriangle(baseLine, apexPt, SiteLineKind.BOUNDARY);
  const redLine   = site.addLine(sp, apexPt, SiteLineKind.BOUNDARY, undefined, sp.id);
  const blueLine  = site.addLine(ep, apexPt, SiteLineKind.ROAD,     undefined, ep.id);
  site.history.push({
    type: 'triangle', baseLineId: baseLine.id,
    redLineId: redLine.id, redLen: 800, redKind: SiteLineKind.BOUNDARY,
    blueLineId: blueLine.id, blueLen: 600, blueKind: SiteLineKind.ROAD,
    triangleId: tri.id, triangleLineKind: SiteLineKind.BOUNDARY, side: 1,
  });

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  const restored = new Site();
  restoreSite(restored, data);

  assert.equal(restored.points.length, 3);
  assert.equal(restored.lines.length, 3);
  assert.equal(restored.triangles.length, 1);
  assert.equal(restored.lineOrder.length, 3);
  assert.equal(restored.history.length, 2);

  const rBase = restored.lineMap.get(baseLine.id);
  assert.ok(rBase);
  assert.equal(rBase.lineKind, SiteLineKind.SURVEY);
  assert.equal(rBase.redPointId, ep.id, 'redPointId(endPoint側)がstartPointIdへ化けずに保持される');
  assert.equal(rBase.startPoint, restored.pointMap.get(sp.id), '実体同一性: startPointは復元後pointMapの同一オブジェクト');
  assert.equal(rBase.endPoint,   restored.pointMap.get(ep.id));

  const rTri = restored.triangleMap.get(tri.id);
  assert.ok(rTri);
  assert.equal(rTri.apexPoint.x, 640);
  assert.equal(rTri.apexPoint.y, 480);
  assert.equal(rTri.lineKind, SiteLineKind.BOUNDARY);
  assert.equal(rTri.baseLine, restored.lineMap.get(baseLine.id), '実体同一性: baseLineは復元後lineMapの同一オブジェクト');

  assert.deepEqual([...restored.lineOrder], [baseLine.id, redLine.id, blueLine.id]);

  assert.equal(restored.history[0].type, 'base');
  assert.equal(restored.history[0].lineId, baseLine.id);
  assert.equal(restored.history[0].length, 1000);
  assert.equal(restored.history[1].type, 'triangle');
  assert.equal(restored.history[1].redLineId, redLine.id);
  assert.equal(restored.history[1].redLen, 800);
  assert.equal(restored.history[1].blueLineId, blueLine.id);
  assert.equal(restored.history[1].side, 1);
});

test('serializeSite → restoreSite: 復元後に editSiteLineLength(本番経路) が編集を継続できる', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  const rLine = restored.lines[0];
  const result = editSiteLineLength(restored, rLine.id, 2000);

  assert.equal(result.ok, true, '復元データでも辺長編集が本番経路（editSiteLineLength）で継続できる');
  assert.equal(rLine.endPoint.x, 2000);
  assert.equal(restored.history[0].length, 2000);
});

test('serializeSite → restoreSite: side=-1の三角形往復でapex座標とhistory.sideの符号が保持される', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const baseLine = site.addLine(sp, ep, SiteLineKind.SURVEY);
  site.history.push({ type: 'base', lineId: baseLine.id, length: baseLine.length });

  const apexPt  = site.addPoint(500, -400); // 底辺の反対側（負のside相当）
  const tri      = site.addTriangle(baseLine, apexPt, SiteLineKind.SURVEY);
  const redLine  = site.addLine(sp, apexPt, SiteLineKind.SURVEY, undefined, sp.id);
  const blueLine = site.addLine(ep, apexPt, SiteLineKind.SURVEY, undefined, ep.id);
  site.history.push({
    type: 'triangle', baseLineId: baseLine.id,
    redLineId: redLine.id, redLen: redLine.length, redKind: SiteLineKind.SURVEY,
    blueLineId: blueLine.id, blueLen: blueLine.length, blueKind: SiteLineKind.SURVEY,
    triangleId: tri.id, triangleLineKind: SiteLineKind.SURVEY, side: -1,
  });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  const rTri = restored.triangleMap.get(tri.id);
  assert.equal(rTri.apexPoint.x, 500, 'apex座標のxが復元前と一致');
  assert.equal(rTri.apexPoint.y, -400, 'apex座標のyが復元前と一致');
  assert.equal(restored.history[1].side, -1, '負のsideが符号を保ったまま復元される');
});

test('serializeSite → restoreSite: SiteLineKind全種が往復する（Object.values参照のため種別追加時に自動で対象拡大する）', () => {
  const site = new Site();
  const kinds = Object.values(SiteLineKind);
  const lineIds = kinds.map((kind, i) => {
    const sp = site.addPoint(i * 1000, 0);
    const ep = site.addPoint(i * 1000 + 500, 0);
    return site.addLine(sp, ep, kind).id;
  });

  const bytes = serializeSite(site);
  const restored = new Site();
  restoreSite(restored, decodeSite(bytes));

  kinds.forEach((kind, i) => {
    assert.equal(restored.lineMap.get(lineIds[i]).lineKind, kind);
  });
});

test('serializeSite → restoreSite: 空siteの往復は例外なく全コレクションが空のまま', () => {
  const site = new Site();
  const bytes = serializeSite(site);
  const restored = new Site();

  assert.doesNotThrow(() => restoreSite(restored, decodeSite(bytes)));
  assert.equal(restored.points.length, 0);
  assert.equal(restored.lines.length, 0);
  assert.equal(restored.triangles.length, 0);
  assert.equal(restored.lineOrder.length, 0);
  assert.equal(restored.history.length, 0);
});

// ---- 失敗系: 参照解決できない敷地線分 ----
test('【失敗系】serializeSite → restoreSite: 参照解決できない線分（存在しないpointIdを指す）は黙って捨てられ他は無傷', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const goodLine = site.addLine(sp, ep, SiteLineKind.SURVEY);

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  // 参照解決できない線分をデータ破損として混入（存在しないpointIdを指す）
  data.lines.push({ id: 'bad-line', startPointId: 'missing-1', endPointId: 'missing-2', lineKind: 'survey', redPointId: 'missing-1' });
  data.lineOrder.push('bad-line');

  const restored = new Site();
  assert.doesNotThrow(() => restoreSite(restored, data));

  assert.equal(restored.lines.length, 1, '解決できない線分は捨てられ、既存の線分だけが残る');
  assert.ok(restored.lineMap.get(goodLine.id), '既存の線分は無傷');
  assert.equal(restored.lineMap.has('bad-line'), false);
  assert.deepEqual([...restored.lineOrder], [goodLine.id], 'lineOrderからも黙って除外される');
});

// ---- 失敗系: lineOrderに載っていない線分（破損データ）は無音でorderedLinesから消える ----
// 注意: data.lineOrder が全体として空（length===0）の場合は restoreSite が
// 「復元値なし＝addLineが自然に積んだ順序を維持」と解釈するため対象外（他の正常系テストで
// カバー済み）。ここでは lineOrder が非空のまま、特定の1本だけが欠落したケースを再現する。
test('【失敗系】serializeSite → restoreSite: lineOrderに載っていない線分はlineMapに残るがorderedLinesに現れない', () => {
  const site = new Site();
  const sp1 = site.addPoint(0, 0);
  const ep1 = site.addPoint(1000, 0);
  const line1 = site.addLine(sp1, ep1, SiteLineKind.SURVEY);
  const sp2 = site.addPoint(0, 1000);
  const ep2 = site.addPoint(1000, 1000);
  const line2 = site.addLine(sp2, ep2, SiteLineKind.SURVEY);

  const bytes = serializeSite(site);
  const data  = decodeSite(bytes);
  // lineOrderから line1 だけを意図的に落とす（データ破損の再現。lines/points側は健全なまま、
  // lineOrder自体は非空を維持=line2は残す）
  data.lineOrder = data.lineOrder.filter(id => id !== line1.id);
  assert.deepEqual(data.lineOrder, [line2.id], '前提: lineOrderはline2だけを含む（空にはしない）');

  const restored = new Site();
  restoreSite(restored, data);

  assert.ok(restored.lineMap.get(line1.id), 'lineMapには残る（実体は失われない）');
  const orderedIds = restored.orderedLines.map(l => l.id);
  assert.equal(orderedIds.includes(line1.id), false, 'lineOrderに無いため三斜タブ表示用のorderedLinesには現れない（現状挙動の固定。末尾補完はしない）');
  assert.deepEqual(orderedIds, [line2.id], 'lineOrderに残った線分だけがorderedLinesに現れる');
});

// ---- 失敗パス: decodeSiteへの不正バイト列 ----
test('decodeSite: 不正なバイト列（他データの断片）を渡しても例外を投げずnullへフォールバックする', () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.doesNotThrow(() => decodeSite(garbage));
  assert.equal(decodeSite(garbage), null, 'GS.SITEフィールドが読めない＝不在扱いでnull');
});

// ==================================================================
// 旧データ互換: 仕上げ面の向きが未指定のまま逆向きに保存された仕上げ薄壁の正規化
// （normalizeLegacyFinishSide。finish/stair/stairUnderWalls.js ルール6の階段側薄壁）。
// 材の帯は変えず、面線と内側線の**役割**だけを正しい向きへ入れ替える。
// ==================================================================
function makeThinWall(axisOffset, props) {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.VERTICAL,   -1500, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.HORIZONTAL, -6000, { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.HORIZONTAL, -3500, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, axisOffset, true, clStart, 0, clEnd, 0,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 0, ...props });
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  return restored.shapeMap.get(wall.id);
}

test('復元: 向き未指定で逆向きに保存された階段側仕上げ薄壁は、帯を変えずに向きだけ正規化される', () => {
  // 旧実装が生成した形: axisOffset=-(50+12.5)、finishSide なし → faceDir=-1（面が帯の遠い側）
  const w = makeThinWall(-62.5, {});

  assert.deepEqual(w.materialRange, { lo: -1562.5, hi: -1550 }, '材の帯は変わらないはず');
  assert.equal(w.faceDir, 1, '仕上げ面は階段側（軸CL寄り）を向くはず');
  assert.equal(w.axisValue, -1550, '面は帯の軸CL寄りの端');
  assert.equal(w.axisValue - w.faceDir * w.wallFinish, -1562.5, '内側線は帯の反対の端');
});

test('【失敗系】復元: finishSide を持つ壁・ルール2の薄壁・下地を持つ壁は正規化の対象外', () => {
  // finishSide 明示済み（通常の壁生成 resolveBackingOwnership・CL偏芯・修正後の生成）
  const explicit = makeThinWall(-62.5, { finishSide: -1 });
  assert.equal(explicit.axisOffset, -62.5);
  assert.equal(explicit.faceDir, -1);

  // ルール2の薄壁（|axisOffset|===wallFinish）は元から正しい向き
  const rule2 = makeThinWall(-12.5, {});
  assert.equal(rule2.axisOffset, -12.5);
  assert.equal(rule2.faceDir, -1);

  // 下地を持つ壁（backingDepth>0）は対象外
  const owner = makeThinWall(-102.5, { backingOffset: -45, backingDepth: 90 });
  assert.equal(owner.axisOffset, -102.5);
  assert.equal(owner.faceDir, -1);
});
