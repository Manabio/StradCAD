// finish/equipment/equipmentFloorPlan.js（昇降機の上階事前チェック・上階自動生成の純関数）の単体テスト。
// 昇降機の仕様追加 ステップ4・S2。
//
// 上階・下階のグラフは本番同型のスタブ（makeStorePeek。equipmentTestFixtures.js）で復元したものを
// judgeElevatorInstall に渡す（team-lessons「他階peekのテストスタブが生きたグラフを返し、復元時に
// 捨てられる壁を検出できない」対応。設置階＝activeIndexの位置だけ生きているグラフ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Project, CenterLineType, Discipline, RoomKind, RoomFeature, StructuralMaterialType,
} from '../../core.js';
import { worldToCell, refreshCells } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { makeStorePeek, assertShaftInvariant } from './equipmentTestFixtures.js';
import { installEquipment } from './equipmentOps.js';
import {
  prepareUpperShaftCells, findShaftInstallConflicts, judgeElevatorInstall, installOnUpperFloor,
} from './equipmentFloorPlan.js';
import { ERR_ELEVATOR_UPPER_CONFLICT, ERR_ELEVATOR_UPPER_UNCLOSABLE } from '../../error.js';

// ---- 共通フィクスチャ ----
// structGraph の通り芯グリッド X:[0,1000,2000] Y:[0,1000] を全階共通で持つ。
// 「left」セル=[0,1000]x[0,1000]・「right」セル=[1000,2000]x[0,1000]（既定の昇降機footprintはleft）。
function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1000, grid);
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}

function leftKey(graph)  { return worldToCell(500, 500, graph).key; }
function rightKey(graph) { return worldToCell(1500, 500, graph).key; }

/**
 * liveGraphs（あらかじめ populate 済み）から floors 配列を組み立てる。activeIndex の位置だけ
 * 生きているグラフ、それ以外は store 経由（本番同型の makeStorePeek）で復元したグラフにする。
 */
function buildFloors(project, liveGraphs, activeIndex) {
  const store = new Map();
  for (const g of liveGraphs) store.set(g.plane.id, serializeGraph(g));
  const peek = makeStorePeek(project, store);
  return liveGraphs.map((g, i) => ({
    plane: g.plane,
    graph: i === activeIndex ? g : peek(g.plane),
  }));
}

// ================================================================
// prepareUpperShaftCells
// ================================================================

test('prepareUpperShaftCells: 通り芯のみで閉じるfootprintはCLを1本も足さずclosed:trueを返す', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  const sourceCells = new Set([leftKey(g1)]);
  const beforeCount = g2.centerLines.length;

  const { cells, closed } = prepareUpperShaftCells(g2, g1, project.structGraph, sourceCells);

  assert.equal(closed, true);
  assert.deepEqual([...cells], [leftKey(g2)]);
  assert.equal(g2.centerLines.length, beforeCount, '通り芯だけで閉じるためCLは足さない');
});

test('prepareUpperShaftCells: 上階の同じ座標に梁芯だけ→中心線が足されて閉じる（S0で実データに実在を確認済み）', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  // 設置階に per-floor 中心線（区画を割る）を足し、footprintをleft内の半分にする
  g1.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const sourceCells = new Set([worldToCell(250, 500, g1).key]);
  // 上階には同座標に梁芯（区画を割らない）だけを置く
  g2.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.FUSE });

  const beforeCount = g2.centerLines.length;
  const { cells, closed } = prepareUpperShaftCells(g2, g1, project.structGraph, sourceCells);

  assert.equal(closed, true, '梁芯は分割線ではないので新しい中心線が足されて閉じる');
  assert.equal(g2.centerLines.length, beforeCount + 1, '中心線が1本追加される（梁芯はそのまま残る）');
  assert.equal(cells.size, 1);
});

// L字（左セル全体＋右セルの上半分。範囲が限定された横方向の分割線で作る）はisRectangularCellSetが
// falseになるため、closed:falseになる——prepareUpperShaftCells単体の「isRectangularCellSetの分岐」を
// 直接踏む構成として残す（QA指摘・2026-09-30: sourceCells自体がL字＝非矩形のため、本番では
// validateElevatorInstall（設置階側の矩形判定）で先に拒否され、この入力のままprepareUpperShaftCells
// まで届くことは無い。実際に本番で起きうる「上階の対応する中心線はあるが範囲が短く閉じない」
// （Q1）は、下のT1（boundsEqualの分岐を踏む）が正しい再現——両方のfalse分岐を別々に固定するため
// 意図して残す）。
function makeLShapeSourceCells(g1) {
  const x1000 = [...g1.centerLines].find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000);
  const x2000 = [...g1.centerLines].find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 2000);
  const hDiv = g1.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  g1.setCenterLineExtentRef(hDiv, 'lo', { clId: x1000.id });
  g1.setCenterLineExtentRef(hDiv, 'hi', { clId: x2000.id });
  const leftFull = worldToCell(500, 500, g1).key;  // 左セル全体（[0,1000]x[0,1000]）
  const rightTop = worldToCell(1500, 250, g1).key; // 右セル上半分（[1000,2000]x[0,500]）
  return new Set([leftFull, rightTop]);
}

test('【失敗系】prepareUpperShaftCells: L字（矩形でない）footprintはisRectangularCellSet=falseによりclosed:false', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  const sourceCells = makeLShapeSourceCells(g1);

  const { closed } = prepareUpperShaftCells(g2, g1, project.structGraph, sourceCells);
  assert.equal(closed, false);
});

// ---- T1（QA指摘・2026-09-30）: 本番で実際に起きうるQ1の再現。設置階側は矩形だが、上階の
// 対応する中心線の範囲が短く、変換後セルが矩形に閉じない。 ----
// 構図: X通り芯0/2000/4000/8000・Y通り芯0/3000（全階共通）。1階はY1500の中心線を全長
// （extent指定なし＝自由端）で持ち、X0-2000/Y0-1500に設置する。2階には同座標(Y1500)の中心線が
// 既にあるが、範囲がX4000〜8000だけ（＝設置予定のX0-2000列には及ばない）。addMissingCLsは
// 「同種別のCLが既にある」ため新しい中心線を足さない（isCounterpart判定は値の一致だけで範囲を
// 見ない）が、その中心線はX0-2000の列では分割線として働かない（isActiveAcrossRangeは範囲の
// 重なりで判定するため）ので、変換後セルがY3000まで漏れ、矩形に閉じない。
function setupT1Project() {
  const project = new Project('proj', 'test');
  const grid = { labeled: true, discipline: Discipline.STRUCT };
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   2000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   4000, grid);
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   8000, grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    grid);
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, grid);
  const { graph: g1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');

  g1.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH }); // 1階: 全長
  const x4000 = g2.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x8000Id = [...g2.centerLines].find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 8000).id;
  const y1500g2 = g2.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  g2.setCenterLineExtentRef(y1500g2, 'lo', { clId: x4000.id });
  g2.setCenterLineExtentRef(y1500g2, 'hi', { clId: x8000Id }); // 2階: X4000〜8000だけ

  const sourceCells = new Set([worldToCell(1000, 750, g1).key]); // X0-2000/Y0-1500
  return { project, g1, g2, sourceCells };
}

test('【T1・失敗系】prepareUpperShaftCells: 上階の対応する中心線の範囲が短く（本番相当の入力）矩形に閉じない場合closed:false・CLは足されない', () => {
  const { project, g1, g2, sourceCells } = setupT1Project();
  const before = g2.centerLines.length;

  const { closed } = prepareUpperShaftCells(g2, g1, project.structGraph, sourceCells);

  assert.equal(closed, false);
  assert.equal(g2.centerLines.length, before, '既に同座標の中心線があるため新規には足さない');
});

test('【T1・失敗系】judgeElevatorInstall: 上階の対応する中心線の範囲が短い（本番相当）→reject・文言はERR_ELEVATOR_UPPER_UNCLOSABLE(\'2階\')', () => {
  const { project, g1, g2, sourceCells } = setupT1Project();
  const floors = buildFloors(project, [g1, g2], 0);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });

  assert.equal(result.kind, 'reject');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_UNCLOSABLE('2階'));
});

// ================================================================
// findShaftInstallConflicts（表1行ずつ）
// ================================================================

test('findShaftInstallConflicts: 未定義（UNDEFINED）は衝突にしない', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const room = g.addRoom(new Set([leftKey(g)]));
  room.setFeature(RoomFeature.UNDEFINED);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, []);
});

test('findShaftInstallConflicts: 未指定セル（重なるRoomなし）は衝突にしない', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, []);
});

test('findShaftInstallConflicts: 階段の実体（Stair）はkind:stair 名「階段」', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const stair = g.addStair({ structure: StructuralMaterialType.WOOD, cells: new Set([leftKey(g)]) });
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, [{ kind: 'stair', name: '階段', id: stair.id }]);
});

test('findShaftInstallConflicts: feature=STAIRのRoom（ペアRoom）はkind:stair 名「階段」', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const room = g.addRoom(new Set([leftKey(g)]));
  room.setFeature(RoomFeature.STAIR);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, [{ kind: 'stair', name: '階段', id: room.id }]);
});

test('findShaftInstallConflicts: VOIDはkind:void 名「吹抜け」', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const room = g.addRoom(new Set([leftKey(g)]));
  room.setFeature(RoomFeature.VOID);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, [{ kind: 'void', name: '吹抜け', id: room.id }]);
});

test('findShaftInstallConflicts: STAIR_VOIDはkind:void 名「階段吹抜け」', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const room = g.addRoom(new Set([leftKey(g)]));
  room.setFeature(RoomFeature.STAIR_VOID);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, [{ kind: 'void', name: '階段吹抜け', id: room.id }]);
});

test('findShaftInstallConflicts: 別の器具行はkind:equipment 名=記号（equipmentSymbolsByIdから引く）', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const { equipmentId } = installEquipment(g, {
    id: 'ev-other', category: 'ev', usage: 'passenger', no: 2, cells: new Set([leftKey(g)]),
  });
  const symbols = new Map([[equipmentId, 'EV2']]);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), symbols);
  assert.deepEqual(conflicts, [{ kind: 'equipment', name: 'EV2', id: equipmentId }]);
});

test('findShaftInstallConflicts: 行の無い昇降路Room（旧データ）はkind:equipment 名「昇降路」', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const room = g.addRoom(new Set([leftKey(g)]));
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const conflicts = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflicts, [{ kind: 'equipment', name: '昇降路', id: room.id }]);
});

test('findShaftInstallConflicts: それ以外のRoom（屋外・部分指定を含む）はkind:room 名=room.name（空なら「部屋」）', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const named = g.addRoom(new Set([leftKey(g)]), '居間');
  const conflictsNamed = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflictsNamed, [{ kind: 'room', name: '居間', id: named.id }]);

  g.removeRoom(named.id);
  const empty = g.addRoom(new Set([leftKey(g)]));
  empty.setKind(RoomKind.EXTERIOR);
  const conflictsEmpty = findShaftInstallConflicts(g, new Set([leftKey(g)]), new Map());
  assert.deepEqual(conflictsEmpty, [{ kind: 'room', name: '部屋', id: empty.id }]);
});

test('findShaftInstallConflicts: 複数の衝突があるとき、階段>吹抜け>器具>部屋の順で最初の1件がpickFirstConflict相当の並びで含まれる', () => {
  // findShaftInstallConflictsは全件返す（優先順の選択はjudgeElevatorInstall側）。ここでは全種別が
  // 混在したcellsで全件検出できることだけを確認する。
  const { graphs } = setupProject(1);
  const [g] = graphs;
  g.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH }); // right内を2分割
  const stairCellKey = leftKey(g);
  const roomCellKey = worldToCell(1250, 500, g).key;
  const stair = g.addStair({ structure: StructuralMaterialType.WOOD, cells: new Set([stairCellKey]) });
  const room = g.addRoom(new Set([roomCellKey]), '納戸');
  const both = new Set([stairCellKey, roomCellKey]);
  const conflicts = findShaftInstallConflicts(g, both, new Map());
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.some(c => c.kind === 'stair' && c.id === stair.id));
  assert.ok(conflicts.some(c => c.kind === 'room' && c.id === room.id));
});

// ================================================================
// judgeElevatorInstall（正常系）
// ================================================================

test('judgeElevatorInstall: 1階設置→2・3階が対象。installOnUpperFloorで同じidの行・RoomができI1成立', () => {
  const { project, graphs } = setupProject(3);
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(graphs[0])]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });

  assert.equal(result.kind, 'new');
  assert.equal(result.upperTargets.length, 2, '2・3階が対象');
  assert.equal(result.equipment.no, 1);

  for (const { graph, cells } of result.upperTargets) {
    installOnUpperFloor(graph, { ...result.equipment, cells });
    assertShaftInvariant(graph, `upper ${graph.plane.name}`);
    assert.equal(graph.equipmentRows.length, 1);
    assert.equal(graph.equipmentRows[0].id, result.equipment.id);
  }
});

test('judgeElevatorInstall: 上階の未定義Roomと重なる→可（新規扱い）。installOnUpperFloor後に未定義からセルが抜ける', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  const undef = g2.addRoom(new Set([leftKey(g2), rightKey(g2)]));
  undef.setFeature(RoomFeature.UNDEFINED);
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'new');
  assert.equal(result.upperTargets.length, 1);

  const { graph, cells } = result.upperTargets[0];
  installOnUpperFloor(graph, { ...result.equipment, cells });
  const remainingUndef = graph.rooms.find(r => r.feature === RoomFeature.UNDEFINED);
  assert.ok(remainingUndef, '右半分は未定義のまま残る');
  assert.deepEqual(refreshCells(remainingUndef.cells, graph), new Set([rightKey(graph)]));
});

test('judgeElevatorInstall: 上階に隣接する別グループの昇降路→統合されI1成立', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  // 上階に既存の昇降路Room（隣接するright側。left側に新規設置するとrightと辺で隣接）
  installEquipment(g2, { id: 'ev-existing', category: 'ev', usage: 'passenger', no: 5, cells: new Set([rightKey(g2)]) });
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'new');
  const { graph, cells } = result.upperTargets[0];
  installOnUpperFloor(graph, { ...result.equipment, cells });

  assertShaftInvariant(graph);
  const rooms = graph.rooms.filter(r => r.feature === RoomFeature.ELEVATOR_EQUIPMENT);
  assert.equal(rooms.length, 1, '隣接する既存の昇降路Roomへ統合され1つにまとまる');
  assert.equal(graph.equipmentRows.length, 2, '既存の器具行(ev-existing)と新規行の2行');
  assert.ok(graph.equipmentRows.every(r => r.roomId === rooms[0].id));
});

test('judgeElevatorInstall: 直上階(k+1)に完全一致する器具行がちょうど1件→extend（id・no・usageを引き継ぐ）', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  installEquipment(g2, { id: 'ev-existing', category: 'ev', usage: 'passengerFreight', no: 3, cells: new Set([leftKey(g2)]) });
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.deepEqual(result, {
    kind: 'extend',
    equipment: { id: 'ev-existing', category: 'ev', usage: 'passengerFreight', no: 3 },
  });
});

test('judgeElevatorInstall: 3階だけに器具A(no=1)がある状態で1階に新設→no=2（重複しないよう全採用階から採番）', () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  installEquipment(g3, { id: 'ev-a', category: 'ev', usage: 'passenger', no: 1, cells: new Set([rightKey(g3)]) }); // rightにして非重複
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'new');
  assert.equal(result.equipment.no, 2);
});

test('judgeElevatorInstall: Q3（中間の階が抜けている）2階に無く3階に完全一致するグループがあるとき延長にせず新規判定し、上の既存グループと重なるのでreject', () => {
  const { project, graphs } = setupProject(3);
  const [g1, , g3] = graphs;
  installEquipment(g3, { id: 'ev-a', category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKey(g3)]) }); // 同位置
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts[0].kind, 'equipment');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('3階', 'EV'));
});

// ================================================================
// judgeElevatorInstall（失敗系）
// ================================================================

function makeConflictOnFloor2(setupFn) {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  setupFn(g2);
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);
  return judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
}

test('【失敗系】judgeElevatorInstall: 名前付き部屋との重なりはreject・正確な文言', () => {
  const result = makeConflictOnFloor2(g2 => g2.addRoom(new Set([leftKey(g2)]), '居間'));
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts[0].kind, 'room');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '居間'));
});

test('【失敗系】judgeElevatorInstall: 屋外部屋との重なりはreject（kind:room）', () => {
  const result = makeConflictOnFloor2(g2 => {
    const r = g2.addRoom(new Set([leftKey(g2)]));
    r.setKind(RoomKind.EXTERIOR);
  });
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts[0].kind, 'room');
});

test('【失敗系】judgeElevatorInstall: 階段との重なりはreject・文言「階段」', () => {
  const result = makeConflictOnFloor2(g2 =>
    g2.addStair({ structure: StructuralMaterialType.WOOD, cells: new Set([leftKey(g2)]) }));
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts[0].kind, 'stair');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '階段'));
});

test('【失敗系】judgeElevatorInstall: VOIDとの重なりはreject・文言「吹抜け」', () => {
  const result = makeConflictOnFloor2(g2 => {
    const r = g2.addRoom(new Set([leftKey(g2)]));
    r.setFeature(RoomFeature.VOID);
  });
  assert.equal(result.kind, 'reject');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '吹抜け'));
});

test('【失敗系】judgeElevatorInstall: STAIR_VOIDとの重なりはreject・文言「階段吹抜け」', () => {
  const result = makeConflictOnFloor2(g2 => {
    const r = g2.addRoom(new Set([leftKey(g2)]));
    r.setFeature(RoomFeature.STAIR_VOID);
  });
  assert.equal(result.kind, 'reject');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '階段吹抜け'));
});

test('【失敗系】judgeElevatorInstall: 別グループ（部分一致。k+1の器具行がsourceCellsの一部としか重ならず矩形も一致しない）との重なりはreject（kind:equipment。extendにならない）', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  // k+1（2階）に既存グループがleftのみで存在（設置階側はleft+rightの2セルを設置しようとする→
  // 矩形が一致しないためfindExtensionTargetはnullになり、新規グループとしてreject判定に落ちる）
  installEquipment(g2, { id: 'ev-x', category: 'ev', usage: 'passenger', no: 9, cells: new Set([leftKey(g2)]) });
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1), rightKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts[0].kind, 'equipment');
});

test('【失敗系】judgeElevatorInstall: 行の無い昇降路との重なりはreject・文言「昇降路」', () => {
  const result = makeConflictOnFloor2(g2 => {
    const r = g2.addRoom(new Set([leftKey(g2)]));
    r.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  });
  assert.equal(result.kind, 'reject');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '昇降路'));
});

test('【失敗系】judgeElevatorInstall: L字（範囲が足りず区画できない）footprintはreject（ERR_ELEVATOR_UPPER_UNCLOSABLE）', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const sourceCells = makeLShapeSourceCells(g1);
  const floors = buildFloors(project, graphs, 0);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'reject');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_UNCLOSABLE('2階'));
});

test('【失敗系】judgeElevatorInstall: 複数の衝突があるとき、階の昇順で最初の階の中で階段>吹抜け>器具>部屋の順で最初の1件だけが文言になる', () => {
  const { project, graphs } = setupProject(2);
  const [g1, g2] = graphs;
  // leftKeyに階段実体と別Roomを意図的に重ねる（優先順の選択を確かめるための構成。実運用では
  // 通常起きない重なりだが、findShaftInstallConflicts自体は重なりを機械的に列挙するだけなので
  // pickFirstConflictの優先順を確かめるにはこの形が最短）。
  g2.addStair({ structure: StructuralMaterialType.WOOD, cells: new Set([leftKey(g2)]) });
  g2.addRoom(new Set([leftKey(g2)]), '納戸');
  const floors = buildFloors(project, graphs, 0);
  const sourceCells = new Set([leftKey(g1)]);

  const result = judgeElevatorInstall({ structGraph: project.structGraph, floors, activeIndex: 0, sourceCells });
  assert.equal(result.kind, 'reject');
  assert.equal(result.conflicts.length, 1, 'judgeElevatorInstallは優先順で選んだ最初の1件だけを返す');
  assert.equal(result.conflicts[0].kind, 'stair', '階段>吹抜け>器具>部屋の順で階段が最優先');
  assert.equal(result.message, ERR_ELEVATOR_UPPER_CONFLICT('2階', '階段'));
});

// ================================================================
// installOnUpperFloor
// ================================================================

test('installOnUpperFloor: 未定義Roomからセルを引き抜いてからinstallEquipmentする（subtractCellsFromUndefinedRoomsを経由）', () => {
  const { graphs } = setupProject(1);
  const [g] = graphs;
  const undef = g.addRoom(new Set([leftKey(g), rightKey(g)]));
  undef.setFeature(RoomFeature.UNDEFINED);

  const { equipmentId, roomId } = installOnUpperFloor(g, {
    id: 'ev-1', category: 'ev', usage: 'passenger', no: 1, cells: new Set([leftKey(g)]),
  });

  assert.ok(equipmentId);
  const remaining = g.rooms.find(r => r.feature === RoomFeature.UNDEFINED);
  assert.deepEqual(refreshCells(remaining.cells, g), new Set([rightKey(g)]));
  const shaft = g.roomMap.get(roomId);
  assert.equal(shaft.feature, RoomFeature.ELEVATOR_EQUIPMENT);
});
