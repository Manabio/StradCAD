// structuralAutoFill.js（WP-B2: 踊り場受け梁 autoFillStairLandingBeams）の単体テスト。
// フィクスチャはelevation/section/sectionStair.test.js／finish/stair/stairLanding.test.jsの
// makeSwitchbackFixtureと同一構成（コメントも参照。sections:[6,1,6]→n1=6・totalSteps=12）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomFeature, spanKey } from '../core.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import {
  autoFillStairLandingBeams, autoFillBeamsForStructure, autoFillStructuralGrid, beamAxisCenterLines,
  autoFillColumns, autoFillBeams, autoFillFootings, autoFillRoofBeams, secondaryBeamSpansFor, autoFillSecondaryBeams,
  convertMembersToEffectiveMaterial, deleteClassificationOverflow,
} from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments, wallBeamSourcesFor } from './wallBeamAxes.js';
import { openingBeamSourcesFor, autoFillOpeningBeamAxes } from './openingBeamAxes.js';
import { resolveSecondaryBeamsForAxis } from './beamAxisMove.js';
import { getAllCells } from '../finish/gridCells.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { RC_WALL_BACKING_CODES } from '../finish/materials/backingClass.js';

// 1階(elevation:0)・2階(elevation:2400)の2フロアProject。floorHeightAbove(project, 1階plane)=2400。
function makeProjectWithFloors() {
  const project = new Project('proj1', 'test');
  const { graph } = project.addPlane(0, '1階');
  project.addPlane(2400, '2階');
  return { project, graph };
}

// autoFillBeamsForStructure/autoFillStructuralGrid（beamPlacementの選択子）テスト用の4000角グリッド。
function makeGridGraph(structure) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  return { graph, x1, x2, y1, y2 };
}
const GRID_PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };

// role・向き・軸位置・端点座標（CL idはgraphごとに乱数のため使わない）で正規化した梁の識別キー。
function beamKey(b) {
  const ends = [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((x, y) => x - y);
  return `${b.role}:${b.isVertical}:${Math.round(b.axisValue)}:${Math.round(ends[0])}:${Math.round(ends[1])}`;
}

// ---- ステップC2a: 小屋梁（role:'roofBeam'）は材種変換・表A削除の対象外 ----
test('【C2a】convertMembersToEffectiveMaterial: 小屋梁(role:roofBeam)は主構造をS造へ変えても変換しない（対照: 小梁は変換される）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const roofBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', y1, false, x1, x2, { role: 'roofBeam', beamType: '小屋梁' });
  const secondary = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x1, x2, { role: 'secondary' });
  graph.structureOverride = 'S造';
  const { convertedBeams } = convertMembersToEffectiveMaterial(graph, GRID_PROJECT, 'S造');
  assert.deepEqual(convertedBeams, [secondary.id], '変換されたのは小梁だけ');
  // convertBeamMaterial は梁を作り直す（idは同じ・オブジェクトは別）ため map から引き直す
  assert.equal(graph.beamMap.get(secondary.id).materialType, StructuralMaterialType.STEEL, '対照: 小梁はS造の材種へ変換された');
  const roofAfter = graph.beamMap.get(roofBeam.id);
  assert.equal(roofAfter.materialType, StructuralMaterialType.WOOD, '小屋梁の材種は不変');
  assert.equal(roofAfter.sectionDefId, 'WOOD-120x210', '小屋梁の断面は不変（木造専用の断面を壊さない）');
});

test('【C2a・失敗系】deleteClassificationOverflow: 梁が×の主構造では auto の小梁は削除されるが、auto の小屋梁は削除されない（表A対象外）', () => {
  const { graph, x1, x2, y1 } = makeGridGraph('RC造(壁式)');
  const roofBeam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x210', y1, false, x1, x2, { role: 'roofBeam', beamType: '小屋梁' });
  const secondary = graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y1, false, x1, x2, { role: 'secondary' });
  assert.equal(roofBeam.dimensionStatus, 'auto');
  assert.equal(secondary.dimensionStatus, 'auto');
  const removed = deleteClassificationOverflow(graph, GRID_PROJECT);
  assert.deepEqual(removed, [secondary.id], '対照: 表Aで×の小梁だけ削除');
  assert.equal(graph.beamMap.has(roofBeam.id), true, '小屋梁は残る');
});

test('beamAxisCenterLines: core/centerLineKindPolicy.jsへの委譲後もcenterLineKind===\'beam\'のCLをgraph順のまま返す（既存export名はstructural/MemberListTab.jsxが直接importする）', () => {
  const { graph } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const beamV = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beamH = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.FUSE });
  graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH }); // 中心線は含まない
  assert.deepEqual(beamAxisCenterLines(graph), [beamV, beamH]);
});

// ---- 撤去段（一般則。ユーザー裁定・案A・2026-09-25）: autoFillColumns/autoFillBeams/autoFillFootings
// （S造/RC造のgridIntersections方式）はADD-ONLYのため、通り芯が降格・削除されて候補キー集合から
// 外れても、そのキーに紐づくauto柱・梁・基礎はそれまで自然には消えなかった（gridAddStructuralSyncProbe.mjs
// のA4で発見）。在来木造のwoodAutoFill.jsの撤去ループと同型の対称撤去を足す。----

test('autoFillColumns: 通り芯を降格すると、その位置のauto柱は撤去されlocked柱は保護される', () => {
  const { graph, x2, y1, y2 } = makeGridGraph('S造');
  const first = autoFillColumns(graph, GRID_PROJECT, null);
  assert.equal(first.created.length, 4, '4交点に柱が立つ');
  assert.deepEqual(first.removed, []);

  const colAtX2Y1 = graph.columns.find(c => c.verticalCL === x2 && c.horizontalCL === y1);
  const colAtX2Y2 = graph.columns.find(c => c.verticalCL === x2 && c.horizontalCL === y2);
  runInAction(() => {
    colAtX2Y1.dimensionStatus = 'locked'; // ユーザーが手動固定した想定
    x2.discipline = Discipline.ARCH; x2.labeled = false; // 通り芯→中心線への降格を模す（gridXsから外れる）
  });

  const second = autoFillColumns(graph, GRID_PROJECT, null);
  assert.equal(second.created.length, 0, '新規交点は無い');
  assert.deepEqual(second.removed, [colAtX2Y2.id], 'lockedでない側だけ撤去される');
  assert.equal(graph.columnMap.has(colAtX2Y1.id), true, 'locked柱は残る');
  assert.equal(graph.columnMap.has(colAtX2Y2.id), false, 'auto柱は撤去される');

  const third = autoFillColumns(graph, GRID_PROJECT, null);
  assert.deepEqual(third, { created: [], removed: [], originsUpdated: [] }, '2回目の撤去後はもう一度呼んでも変化が無い（冪等）');
});

test('【失敗系】autoFillColumns: 候補キー集合にある柱（現存する通り芯交点）は撤去されない', () => {
  const { graph } = makeGridGraph('S造');
  const first = autoFillColumns(graph, GRID_PROJECT, null);
  assert.equal(first.created.length, 4);
  const second = autoFillColumns(graph, GRID_PROJECT, null);
  assert.deepEqual(second, { created: [], removed: [], originsUpdated: [] }, '通り芯を何も変えていなければ撤去は起きない');
});

test('autoFillBeams: 通り芯を降格すると、その辺のauto梁（同role）は撤去されるがlocked梁・別roleの梁は残る', () => {
  const { graph, x1, x2, y1 } = makeGridGraph('S造');
  const firstPrimary = autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  assert.equal(firstPrimary.created.length, 4);

  // 別role（foundation）の梁を直接1本置く（primary側と同じ辺。role跨ぎで巻き込まないことの確認用。
  // 実運用では基礎伏図と通常階は別グラフのため同居しないが、role分離ロジック自体を単体で検証する）。
  const foundationBeam = graph.addBeam(StructuralMaterialType.RC, 'SEC-FBEAM', y1, false, x1, x2, { role: 'foundation' });

  // x2に接続するprimary梁（axisCL===x2 の縦梁1本・clEnd===x2 の横梁2本＝計3本）のうち1本だけをlocked化。
  const primaryAtX2 = graph.beams.filter(b => b.role === 'primary' && (b.axisCL === x2 || b.clStart === x2 || b.clEnd === x2));
  assert.equal(primaryAtX2.length, 3, 'x2に接続するprimary梁は縦1本・横2本の計3本のはず');
  const [lockedBeam, ...toBeRemoved] = primaryAtX2;
  runInAction(() => {
    lockedBeam.dimensionStatus = 'locked'; // ユーザーが手動固定した想定
    x2.discipline = Discipline.ARCH; x2.labeled = false; // 通り芯→中心線への降格を模す
  });

  const secondPrimary = autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  assert.deepEqual(secondPrimary.created, [], '新規辺は無い');
  assert.deepEqual(secondPrimary.removed.sort(), toBeRemoved.map(b => b.id).sort(), 'lockedの1本を除く2本が撤去される');
  assert.equal(graph.beamMap.has(lockedBeam.id), true, 'locked梁は残る');
  assert.equal(graph.beamMap.has(foundationBeam.id), true, 'primaryの撤去はfoundation梁（別role）を巻き込まない');

  const thirdPrimary = autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  assert.deepEqual(thirdPrimary, { created: [], removed: [] }, '2回目以降は変化が無い（冪等）');
});

test('autoFillFootings: 通り芯を降格すると、その交点のauto独立フーチングは撤去されlocked基礎は保護される', () => {
  const { graph, x2, y1, y2 } = makeGridGraph('S造');
  const first = autoFillFootings(graph, null);
  assert.equal(first.created.length, 4);

  const footingAtX2Y1 = graph.footings.find(f => f.verticalCL === x2 && f.horizontalCL === y1);
  const footingAtX2Y2 = graph.footings.find(f => f.verticalCL === x2 && f.horizontalCL === y2);
  runInAction(() => {
    footingAtX2Y1.dimensionStatus = 'locked';
    x2.discipline = Discipline.ARCH; x2.labeled = false; // 降格
  });

  const second = autoFillFootings(graph, null);
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.removed, [footingAtX2Y2.id]);
  assert.equal(graph.footingMap.has(footingAtX2Y1.id), true, 'locked基礎は残る');
  assert.equal(graph.footingMap.has(footingAtX2Y2.id), false, 'auto基礎は撤去される');
});

test('autoFillRoofBeams: 通り芯を降格すると、その辺のauto軒桁（role:eaves）は撤去されるがlocked軒桁は残る（撤去段。ユーザー裁定・案A・2026-09-25。QA指摘m-1）', () => {
  const { graph, x2 } = makeGridGraph('S造');
  const first = autoFillRoofBeams(graph, GRID_PROJECT, 'S造', null);
  assert.equal(first.created.length, 4, '4辺に軒桁が立つ');
  assert.deepEqual(first.removed, []);

  // x2に接続する軒桁（axisCL===x2 の縦1本・clStart/clEnd===x2 の横2本＝計3本）のうち1本だけをlocked化。
  const eavesAtX2 = graph.beams.filter(b => b.role === 'eaves' && (b.axisCL === x2 || b.clStart === x2 || b.clEnd === x2));
  assert.equal(eavesAtX2.length, 3, 'x2に接続する軒桁は縦1本・横2本の計3本のはず');
  const [lockedBeam, ...toBeRemoved] = eavesAtX2;
  runInAction(() => {
    lockedBeam.dimensionStatus = 'locked'; // ユーザーが手動固定した想定
    x2.discipline = Discipline.ARCH; x2.labeled = false; // 通り芯→中心線への降格を模す
  });

  const second = autoFillRoofBeams(graph, GRID_PROJECT, 'S造', null);
  assert.deepEqual(second.created, [], '新規辺は無い');
  assert.deepEqual(second.removed.sort(), toBeRemoved.map(b => b.id).sort(), 'lockedの1本を除く2本が撤去される');
  assert.equal(graph.beamMap.has(lockedBeam.id), true, 'locked軒桁は残る');

  const third = autoFillRoofBeams(graph, GRID_PROJECT, 'S造', null);
  assert.deepEqual(third, { created: [], removed: [] }, '2回目以降は変化が無い（冪等）');
});

test('autoFillBeamsForStructure: role!=="primary"（基礎梁等）は在来木造でも通り芯グリッド方式のまま（wallSegmentsは使われない）', () => {
  const { graph } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const wallSegments = [{ isVertical: false, coord: 0, lo: 0, hi: 4000 }]; // 渡されても使われないはず
  const { created, removed } = autoFillBeamsForStructure(graph, GRID_PROJECT, 'foundation', null, wallSegments);
  assert.equal(created.length, 4, '通り芯4辺の基礎梁が生成される（壁線方式は使わない）');
  assert.deepEqual(removed, []);
  assert.ok(created.every(b => b.role === 'foundation' && b.materialType === StructuralMaterialType.RC));
});

test('autoFillBeamsForStructure: role==="primary"の非在来（S造）は wallSegments を渡しても通り芯グリッド方式のまま', () => {
  const { graph } = makeGridGraph('S造');
  const wallSegments = [{ isVertical: false, coord: 0, lo: 0, hi: 4000 }];
  const { created, removed } = autoFillBeamsForStructure(graph, GRID_PROJECT, 'primary', null, wallSegments);
  assert.equal(created.length, 4, '通り芯4辺の大梁が生成される');
  assert.deepEqual(removed, []);
  assert.ok(created.every(b => b.materialType === StructuralMaterialType.STEEL));
});

test('【失敗系】autoFillBeamsForStructure: role==="primary"の在来木造は壁線方式へ委譲し、壁ゼロなら通り芯グリッドへフォールバックしない', () => {
  const { graph } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const { created, removed } = autoFillBeamsForStructure(graph, GRID_PROJECT, 'primary', null, []);
  assert.equal(created.length, 0);
  assert.deepEqual(removed, []);
});

test('【不変条件】autoFillStructuralGrid: 非在来（S造）は wallSegments を渡しても結果が従来（通り芯グリッド方式）と同一', () => {
  const build = () => {
    const { graph } = makeGridGraph('S造');
    const project = { planes: [graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
    return { graph, project };
  };
  const { graph: gA, project: pA } = build();
  const rA = autoFillStructuralGrid(gA, pA, 'S造', null, [], []);
  const { graph: gB, project: pB } = build();
  // S造では使われないはずの壁線を渡す（無視されるはず）。
  const wallSegments = [{ isVertical: false, coord: 2000, lo: 0, hi: 4000 }];
  const rB = autoFillStructuralGrid(gB, pB, 'S造', null, [], wallSegments);
  assert.deepEqual(rA.removedBeams, [], 'S造は常にremovedBeams=[]');
  assert.deepEqual(rB.removedBeams, []);
  assert.deepEqual(rA.newBeams.map(beamKey).sort(), rB.newBeams.map(beamKey).sort(), 'wallSegmentsの有無で生成される梁が変わらない');
});

// ---- ステップ3e-2（床梁 role:'floor'）: autoFillStructuralGrid への配線 ----

test('【統合・3e-2】autoFillStructuralGrid: 在来木造は壁線上の通し梁の直後に床梁(role:floor)も生成し、newBeamsへ含める', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(graph, room);
  // 最下階にしない（基礎伏図扱いだとrole:'primary'の壁線通し梁自体が生成されず床梁の前提が崩れるため）。
  const project = { planes: [new Plane('p0', -3000, '0階', 0, 1), graph.plane], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const segs = selfWallSegments(graph);
  const r = autoFillStructuralGrid(graph, project, TRADITIONAL_WOOD_STRUCTURE, null, segs, segs);
  const floors = graph.beams.filter(b => b.role === 'floor');
  assert.ok(floors.length > 0, '3640×5460の部屋（短辺3640>1820）には床梁が生成されるはず');
  assert.ok(floors.every(fb => r.newBeams.some(b => b.id === fb.id)), '生成された床梁はnewBeamsへ含まれる');
});

test('【3e・屋根ガード】autoFillStructuralGrid: 屋根専用平面(isRoofPlane)ではrole:primaryの梁があっても床梁(role:floor)を生成しない', () => {
  // 小屋伏図に梁・柱ルールを適用する計画（.claude/structural-model.md）でも3e（床梁）は明示的に対象外
  // ——屋根に自階の床は無いため。将来（ステップ5）屋根の梁がrole:'primary'へ切り替わっても3eだけは
  // 対象外のままであることを、role:'primary'の梁を先に手動で置いた状態で固定する。
  const graph = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 2, 1, false, null, 0, true, 'p1'));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5460, { labeled: true, discipline: Discipline.STRUCT });
  const sec = 'WOOD-120x120';
  graph.addBeam(StructuralMaterialType.WOOD, sec, y0, false, x0, x1, { role: 'primary' });
  graph.addBeam(StructuralMaterialType.WOOD, sec, y1, false, x0, x1, { role: 'primary' });
  graph.addBeam(StructuralMaterialType.WOOD, sec, x0, true, y0, y1, { role: 'primary' });
  graph.addBeam(StructuralMaterialType.WOOD, sec, x1, true, y0, y1, { role: 'primary' });
  const project = { planes: [new Plane('p1', 3000, '3階', 1, 1)], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const r = autoFillStructuralGrid(graph, project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(graph.beams.filter(b => b.role === 'floor').length, 0, '屋根専用平面には床梁を生成しない');
  assert.ok(!r.newBeams.some(b => b.role === 'floor'), 'newBeamsにも床梁を含めない');
});

test('【不変条件】structuralAutoFill.js: autoFillStructuralGrid はbeamPlacement==="wallRuns"のときautoFillWoodFloorBeamsを呼び、created/removedを戻り値へ含める（ステップ3e-2）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralAutoFill.js'), 'utf8');
  // C2d-1: 第3引数に対象の下屋のセルキー集合（roofCellKeys）を渡す。呼び出し行まるごと一致で固定する（配線の確認は leanToPerimeter.test.js）。
  assert.ok(/^\s*\? autoFillWoodFloorBeams\(graph, project, roofCellKeys\) : \{ created: \[\], removed: \[\] \};$/m.test(src), 'autoFillWoodFloorBeams(graph, project, roofCellKeys) の呼び出しが無い');
  assert.ok(/floorBeamsResult\.created/.test(src), 'floorBeamsResult.created をnewBeamsへ含めていない');
  assert.ok(/floorBeamsResult\.removed/.test(src), 'floorBeamsResult.removed をremovedBeamsへ含めていない');
});

function makeSwitchbackFixture(graph, structure = StructuralMaterialType.STEEL) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });

  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);

  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);

  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, structure,
  });
  return { room, stair, ids: { x0, xm, x1, y0, ym, y1 } };
}

// 最上階の自動指定（stairFloorSync.js addStairVoidRoom）を模す: 階段実体は持たず、
// makeSwitchbackFixtureと同じfootprint（世界座標）のSTAIR_VOID Roomだけを置く。
function makeStairVoidFixture(graph) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const cells = new Set([landingKey, outboundKey, returnKey]);
  const room = graph.addRoom(cells);
  room.setFeature(RoomFeature.STAIR_VOID);
  return { room, ids: { x0, xm, x1, y0, ym, y1 } };
}

// n階（elevation配列）のProject。makeProjectWithFloorsのn階版。
function makeProjectWithNFloors(elevations) {
  const project = new Project('proj1', 'test');
  const graphs = elevations.map((elevation, i) => project.addPlane(elevation, `${i + 1}階`).graph);
  return { project, graphs };
}

test('【WP-B2改訂・2026-09-28裁定】autoFillStairLandingBeams: belowGraphが無ければ設置階自身は常に0本（既存の自動生成LGが無ければ撤去も0件）', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const result = autoFillStairLandingBeams(graph, project); // belowGraph省略
  assert.deepEqual(result, { created: [], removedG: [], removedStale: [], updated: [], skippedConflicts: 0 });
});

test('【WP-B2改訂】autoFillStairLandingBeams: 到達階に上階自動設置コピー(graph.stairs)があれば、そのback辺(y0)に1本生成する（levelOffset=landingZ-階高-310）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL); // 設置階
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL); // 到達階＝上階自動設置コピー

  const onInstall = autoFillStairLandingBeams(floor1, project, null, null); // 1F自身にはbelowGraphが無い
  assert.deepEqual(onInstall.created, [], '設置階(1F)自身は常に0本のはず');

  const onArrival = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(onArrival.created.length, 1, '到達階(2F)のback辺の1本だけのはず');
  const beam = onArrival.created[0];
  assert.equal(beam.role, 'landing');
  assert.equal(beam.materialType, StructuralMaterialType.STEEL);
  assert.equal(beam.isVertical, false, 'back辺(y0)は走行軸に直交＝水平梁のはず');
  assert.equal(beam.axisCL.id, ids2.y0.id, '解決したCLは到達階(2F)自身のものであるはず');
  assert.deepEqual([beam.clStart.id, beam.clEnd.id].sort(), [ids2.x0.id, ids2.x1.id].sort());
  // landingZ(設置階FL基準)=n1(6)*riser(2400/12=200)=1200。設置階〜到達階の階高=2400。
  // levelOffset(到達階FL基準)=1200-2400-300-10=-1510
  assert.equal(beam.levelOffset, -1510);
  assert.ok(floor2.beams.includes(beam));
  assert.equal(onArrival.removedG.length, 0);
  assert.equal(onArrival.removedStale.length, 0);
  assert.equal(onArrival.updated.length, 0);
  assert.equal(onArrival.skippedConflicts, 0);
});

test('【WP-B2改訂】autoFillStairLandingBeams: 最上階（コピーが無くSTAIR_VOID Roomのみ）でもfootprint一致のRoomからshimでLGを1本生成する', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.RC);
  makeStairVoidFixture(floor2); // 最上階: stair実体は無くSTAIR_VOID Roomだけ

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(result.created.length, 1, 'STAIR_VOID Room由来のshimからも1本生成されるはず');
  assert.equal(result.created[0].materialType, StructuralMaterialType.RC);
  assert.equal(result.created[0].sectionDefId, 'RC-300x300');
});

test('【WP-B2改訂】autoFillStairLandingBeams: 3階建て（1F設置・2Fコピー・3FはSTAIR_VOIDのみ）は2F・3Fに各1本、1Fは0本', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400, 4800]);
  const [floor1, floor2, floor3] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL); // 2F: 1F階段の上階自動設置コピー
  makeStairVoidFixture(floor3); // 3F: 最上階のSTAIR_VOID Room（2F階段の到達先）

  const onFloor1 = autoFillStairLandingBeams(floor1, project, null, null);
  const onFloor2 = autoFillStairLandingBeams(floor2, project, null, floor1);
  const onFloor3 = autoFillStairLandingBeams(floor3, project, null, floor2);
  assert.equal(onFloor1.created.length, 0, '1F(設置階)は常に0本');
  assert.equal(onFloor2.created.length, 1, '2F(1F階段の到達階)は1本');
  assert.equal(onFloor3.created.length, 1, '3F(2F階段の到達階)は1本');
});

// ---- QA指摘F1是正・2026-09-29: 撤去・更新段（ADD-ONLYの穴を塞ぐ一般則）----

test('【失敗系・QA指摘F1是正】autoFillStairLandingBeams: 旧仕様で設置階自身に保存された自動生成LGは撤去される（belowGraph省略でも走る）', () => {
  const { project, graph } = makeProjectWithFloors();
  const { ids } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  // 旧仕様（設置階生成）で保存されたauto LGを模す——現行仕様では設置階自身は常に有効な源が0件のため、
  // このLGは「今回の有効spanKey集合に無い既存の自動生成LG」に該当し撤去対象になる。
  const staleLg = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ids.y0, false, ids.x0, ids.x1, { role: 'landing', levelOffset: 890 });
  const sleeve = graph.addSleeve('beam', { hostBeamId: staleLg.id });

  const result = autoFillStairLandingBeams(graph, project); // belowGraph省略（設置階自身の再計算を模す）
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.removedStale, [staleLg.id], '旧仕様のLGは撤去されるはず');
  assert.equal(graph.beamMap.has(staleLg.id), false, '撤去された旧LGはbeamMapに残らないはず');
  assert.equal(graph.sleeveMap.has(sleeve.id), false, '旧LGの貫通スリーブも連鎖削除されるはず');
  assert.equal(graph.excludedBeamSlots.size, 0, '撤去段は除外集合を汚さないはず');
});

test('【QA指摘F1是正】autoFillStairLandingBeams: 到達階の既存auto LGは、levelOffsetが最新値と異なれば再計算値へ更新される（冪等スキップで直らない不良の是正）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  // 旧仕様（設置階生成の頃）のlevelOffset値(+890)で保存された到達階のauto LGを模す。
  // 現行仕様の正しい値は-1510（levelOffset=1200-2400-300-10）。
  const oldLg = floor2.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ids2.y0, false, ids2.x0, ids2.x1, { role: 'landing', levelOffset: 890 });

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.deepEqual(result.created, [], '既存LGがあるため新規生成はしない');
  assert.deepEqual(result.removedStale, [], '有効な源のためstale撤去の対象ではない');
  assert.deepEqual(result.updated, [oldLg.id], 'levelOffsetが変わったため更新対象として返す');
  assert.equal(oldLg.levelOffset, -1510, 'levelOffsetは最新値(-1510)へ更新されるはず（+890→-1510）');
  assert.equal(floor2.beams.filter(b => b.role === 'landing').length, 1, 'LGは1本のまま（新規生成しない）');
});

test('【QA指摘F1是正】autoFillStairLandingBeams: levelOffsetが既に最新値と一致していれば更新対象に含めない（無駄な書込みをしない）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const currentLg = floor2.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ids2.y0, false, ids2.x0, ids2.x1, { role: 'landing', levelOffset: -1510 });

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.deepEqual(result.updated, [], '既に最新値のため更新対象に含めないはず');
  assert.equal(currentLg.levelOffset, -1510);
});

test('【QA指摘F1再確認】autoFillStairLandingBeams: locked（手動固定）のLGはlevelOffsetを更新せず撤去もしない', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  // (i) 到達階(2F)に手動固定(locked)のLGを、古いlevelOffset(890)で置く。
  const lockedLg = floor2.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ids2.y0, false, ids2.x0, ids2.x1, { role: 'landing', levelOffset: 890 });
  runInAction(() => { lockedLg.dimensionStatus = 'locked'; });

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.deepEqual(result.updated, [], 'locked（非auto）のLGは更新対象に含めないはず');
  assert.equal(lockedLg.levelOffset, 890, 'locked（非auto）のLGのlevelOffsetは書き換えないはず');
  assert.equal(result.created.length, 0, '既にLG（locked）があるため新規生成はしないはず');
  assert.equal(floor2.beamMap.has(lockedLg.id), true, 'locked（非auto）のLGは残るはず');
});

test('【QA指摘F1再確認】autoFillStairLandingBeams: 設置階（belowGraph null）に残るlocked（手動固定）のLGは撤去段の対象外', () => {
  const { project, graph } = makeProjectWithFloors();
  const { ids } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  // (ii) 設置階自身（belowGraphが無い＝有効spanKey集合が常に空）に残るlocked（手動固定）のLGを模す。
  const lockedLg = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', ids.y0, false, ids.x0, ids.x1, { role: 'landing', levelOffset: 890 });
  runInAction(() => { lockedLg.dimensionStatus = 'locked'; });

  const result = autoFillStairLandingBeams(graph, project); // belowGraph省略
  assert.deepEqual(result.removedStale, [], 'locked（非auto）のLGは撤去段の対象外のはず');
  assert.equal(graph.beamMap.has(lockedLg.id), true, 'locked（非auto）のLGは設置階に残ったままのはず');
});

test('【統合・QA指摘F1(c)是正】autoFillStructuralGrid: 下階の階段が削除されると到達階のLGが撤去され、同区間に大梁(G)が次のautoFillで復活する', () => {
  // back辺(y0・x0〜x1)を実際の構造グリッド辺（labeled STRUCT）と一致させ、LG↔G(role:'primary')の
  // 置換・復活を同一spanKeyで検証できるようにしたフィクスチャ（xm/ym/y1はセル分割用のARCHのまま）。
  function makeGridBackSwitchbackFixture(g, structure) {
    const x0 = g.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const xm = g.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const x1 = g.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
    const y0 = g.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const ym = g.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
    const y1 = g.addCenterLine(CenterLineType.HORIZONTAL, 4500, { labeled: false, discipline: Discipline.ARCH });
    const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
    const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
    const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
    const cells = new Set([landingKey, outboundKey, returnKey]);
    const room = g.addRoom(cells, '階段');
    generateRoomWallsFromOutline(g, room);
    const stair = g.addStair({
      type: StairType.SWITCHBACK, cells, roomId: room.id,
      sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, structure,
    });
    return { room, stair, ids: { x0, xm, x1, y0, ym, y1 } };
  }

  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  floor1.structureOverride = 'S造';
  floor2.structureOverride = 'S造';
  const { stair: stair1 } = makeGridBackSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeGridBackSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const backKey = spanKey(ids2.y0, ids2.x0, ids2.x1);

  autoFillStructuralGrid(floor2, project, 'S造', null, [], [], [], [], [], undefined, undefined, undefined, [], floor1);
  assert.equal(floor2.beams.filter(b => b.role === 'landing').length, 1, '前提: 1F階段の到達階(2F)にLGが1本生成される');
  assert.equal(floor2.beams.some(b => b.role === 'primary' && spanKey(b.axisCL, b.clStart, b.clEnd) === backKey), false,
    '前提: LGと同spanKeyには大梁(G)は生成されない（置換分岐で吸収）');

  // 1F階段を削除する（下階の階段が消える）。
  floor1.removeStair(stair1.id);
  autoFillStructuralGrid(floor2, project, 'S造', null, [], [], [], [], [], undefined, undefined, undefined, [], floor1);
  assert.equal(floor2.beams.filter(b => b.role === 'landing').length, 0, 'LGは撤去されるはず');
  assert.equal(floor2.beams.some(b => b.role === 'primary' && spanKey(b.axisCL, b.clStart, b.clEnd) === backKey), true,
    '同区間に大梁(G)が次のautoFillで復活するはず');
});

test('【WP-B2改訂】autoFillStairLandingBeams: 同spanKeyに自動生成のG(role:primary・auto)があれば撤去してLGへ置換する（貫通スリーブも連鎖削除）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  // 到達階(2F)に、踊り場back辺と同じspanKeyの自動生成G(role:'primary')を先に置いておく
  // （旧仕様＝設置階生成の頃の状態、または大梁の通常生成が先に走った状態を模す）。
  const staleG = floor2.addBeam(StructuralMaterialType.STEEL, 'S-H-300x150', ids2.y0, false, ids2.x0, ids2.x1, { role: 'primary' });
  assert.equal(staleG.dimensionStatus, 'auto', '既定はauto生成のはず');
  const sleeve = floor2.addSleeve('beam', { hostBeamId: staleG.id });

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(result.created.length, 1, 'Gを撤去した上でLGが1本生成されるはず');
  assert.deepEqual(result.removedG, [staleG.id]);
  assert.equal(floor2.beamMap.has(staleG.id), false, '旧Gは削除されているはず');
  assert.equal(floor2.sleeveMap.has(sleeve.id), false, '旧Gの貫通スリーブも連鎖削除されるはず');
  assert.equal(floor2.excludedBeamSlots.size, 0, 'G撤去は除外集合を汚さないはず');
  assert.equal(result.created[0].role, 'landing');
});

test('【WP-B2改訂】autoFillStairLandingBeams: 同spanKeyに手動固定(非auto)の梁があればLGを作らずスキップする（skippedConflicts）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const lockedG = floor2.addBeam(StructuralMaterialType.STEEL, 'S-H-300x150', ids2.y0, false, ids2.x0, ids2.x1, { role: 'primary' });
  runInAction(() => { lockedG.dimensionStatus = 'locked'; });

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(result.created.length, 0, '手動固定の梁は上書きしないはず');
  assert.equal(result.removedG.length, 0);
  assert.equal(result.skippedConflicts, 1);
  assert.equal(floor2.beamMap.has(lockedG.id), true, '手動固定の梁は残るはず');
});

test('【WP-B2改訂】autoFillStairLandingBeams: 手動削除したLGはexcludedBeamSlotsに記録され再生成されない', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const [beam] = autoFillStairLandingBeams(floor2, project, null, floor1).created;
  floor2.removeBeam(beam.id); // excludedBeamSlotsへ記録される
  const second = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(second.created.length, 0, '手動削除された辺は自動補完で復活しないはず');
  assert.equal(second.removedG.length, 0, 'excluded済みの辺ではGの撤去も行わないはず（Gは元々無い）');
});

test('【失敗系・QA指摘F7是正・2026-09-29】autoFillStairLandingBeams: 同spanKeyに自動生成のGがあっても、LGスロットがexcludedBeamSlots済みならGは置換されず残る', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  const { ids: ids2 } = makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  // 同spanKeyに自動生成のG(role:'primary')を先に置き、かつユーザーがそのLGスロットを既に
  // 手動削除済み（excludedBeamSlots）の状態を模す——「Gが実在するのにexcludedのため置換しない」
  // ことを検証する（旧テストはGが無いまま検証しており恒真だった。QA指摘F7是正）。
  const g = floor2.addBeam(StructuralMaterialType.STEEL, 'S-H-300x150', ids2.y0, false, ids2.x0, ids2.x1, { role: 'primary' });
  const key = spanKey(ids2.y0, ids2.x0, ids2.x1);
  floor2.excludedBeamSlots.add(key);

  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(result.created.length, 0, '除外済みのため生成しないはず');
  assert.deepEqual(result.removedG, [], '除外済みのためGの撤去も行わないはず');
  assert.equal(floor2.beamMap.has(g.id), true, 'Gは置換されず残るはず');
  assert.equal(floor2.beams.filter(b => b.role === 'landing').length, 0, 'LGは生成されないはず');
});

test('【WP-B2改訂】autoFillStairLandingBeams: 2回連続で呼んでも重複生成しない（冪等）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const first = autoFillStairLandingBeams(floor2, project, null, floor1);
  const second = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(first.created.length, 1);
  assert.equal(second.created.length, 0, '既存梁と同じspanKeyのため2回目は生成しないはず');
  assert.equal(floor2.beams.filter(b => b.role === 'landing').length, 1);
});

test('【失敗系・WP-B2改訂】autoFillStairLandingBeams: 設置階が木造階段(既定structure)なら到達階も0本', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.WOOD);
  makeSwitchbackFixture(floor2, StructuralMaterialType.WOOD);
  const result = autoFillStairLandingBeams(floor2, project, null, floor1);
  assert.equal(result.created.length, 0);
});

test('【失敗系・WP-B2改訂】autoFillStairLandingBeams: 設置階の階段がSWITCHBACK以外(STRAIGHT)なら到達階も0本・例外なし', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  const { stair } = makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  stair.setField('type', StairType.STRAIGHT);
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  assert.doesNotThrow(() => {
    const result = autoFillStairLandingBeams(floor2, project, null, floor1);
    assert.equal(result.created.length, 0);
  });
});

test('【失敗系・WP-B2改訂】autoFillStairLandingBeams: 設置階のstair.cellsが空でも到達階は0本・例外なし', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  const { stair } = makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  stair.setCells(new Set());
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  assert.doesNotThrow(() => {
    const result = autoFillStairLandingBeams(floor2, project, null, floor1);
    assert.equal(result.created.length, 0);
  });
});

test('【失敗系・WP-B2改訂】autoFillStairLandingBeams: belowGraph.stairsが空（下階に階段が無い）でも0本・例外なし', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  assert.doesNotThrow(() => {
    assert.equal(autoFillStairLandingBeams(floor2, project, null, floor1).created.length, 0);
  });
});

test('【失敗系・WP-B2改訂】autoFillStairLandingBeams: 到達階に一致するコピー・STAIR_VOID Roomのどちらも無ければ0本・例外なし', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  // floor2には何も置かない（上階自動設置が未反映の想定）。
  assert.doesNotThrow(() => {
    assert.equal(autoFillStairLandingBeams(floor2, project, null, floor1).created.length, 0);
  });
});

test('【WP-B2改訂】autoFillStairLandingBeams: wallGateを渡しても呼び出さない（適用しない設計どおり・例外なし）', () => {
  const { project, graphs } = makeProjectWithNFloors([0, 2400]);
  const [floor1, floor2] = graphs;
  makeSwitchbackFixture(floor1, StructuralMaterialType.STEEL);
  makeSwitchbackFixture(floor2, StructuralMaterialType.STEEL);
  const poisonWallGate = {
    spanInBuilding() { throw new Error('wallGateは踊り場受け梁には適用しないはず'); },
    intersectionInBuilding() { throw new Error('wallGateは踊り場受け梁には適用しないはず'); },
  };
  const result = autoFillStairLandingBeams(floor2, project, poisonWallGate, floor1);
  assert.equal(result.created.length, 1, 'wallGateが渡されても通常どおり1本生成されるはず');
});

// ---- 規則O（床開口由来の梁芯。openingBeamAxes.js）の配線 ----
test('【不変条件】structuralAutoFill.js: autoFillStructuralGrid はautoFillWallBeamAxesの直後にautoFillOpeningBeamAxesを呼び、newBeamsへ含める', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralAutoFill.js'), 'utf8');
  assert.ok(/import \{ autoFillOpeningBeamAxes, reconcileOpeningBeamAxes, retargetOpeningBeamAxisShortExtents \} from '\.\/openingBeamAxes\.js';/.test(src),
    'openingBeamAxes.jsのautoFillOpeningBeamAxes/reconcileOpeningBeamAxes/retargetOpeningBeamAxisShortExtentsをimportしていない');
  const wallIdx = src.indexOf('autoFillWallBeamAxes(graph, wallSources)');
  const reconcileIdx = src.indexOf('reconcileOpeningBeamAxes(graph, openingSources, wallSources)');
  const openingIdx = src.indexOf('autoFillOpeningBeamAxes(graph, openingSources)');
  const retargetShortIdx = src.indexOf('retargetOpeningBeamAxisShortExtents(graph, openingSources)');
  assert.ok(wallIdx >= 0 && reconcileIdx >= 0 && openingIdx >= 0 && retargetShortIdx >= 0
    && reconcileIdx > wallIdx && openingIdx > reconcileIdx && retargetShortIdx > openingIdx,
    'reconcileOpeningBeamAxesはautoFillWallBeamAxesの直後・autoFillOpeningBeamAxesの直前に呼び、' +
    'retargetOpeningBeamAxisShortExtentsはautoFillOpeningBeamAxesの直後に呼ぶ（ステップ6・M-1\'是正）');
  assert.ok(/newBeams: \[.*newOpeningBeamAxes.*\]/.test(src), 'newOpeningBeamAxesをnewBeamsへ含めていない');
  assert.ok(/removedBeams: \[.*removedOpeningBeamAxes.*\]/.test(src),
    'removedOpeningBeamAxesをremovedBeamsへ含めていない（ステップ6の撤去がchanged判定に乗る必要がある）');
  assert.ok(/changedOpeningBeamAxes: \[.*retargetedOpeningBeamAxesShort.*\]/.test(src),
    'retargetedOpeningBeamAxesShortをchangedOpeningBeamAxesへ含めていない（M-1\'是正・changed判定に乗る必要がある）');
});

test('【不変条件】structuralRecompute.js: openingBeamSourcesForを呼び、autoFillStructuralGridの末尾引数へ渡す', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralRecompute.js'), 'utf8');
  assert.ok(/import \{ openingBeamSourcesFor \} from '\.\/openingBeamAxes\.js';/.test(src),
    'openingBeamAxes.jsのopeningBeamSourcesForをimportしていない');
  assert.ok(/openingBeamSourcesFor\(targetGraph, project,/.test(src), 'openingBeamSourcesForの呼び出しが無い');
  assert.ok(/autoFillStructuralGrid\([^)]*openingSources, belowGraph, roofRegions, roofCellKeys, roofColumnFilter\)/.test(src),
    'autoFillStructuralGridの末尾引数にopeningSources, belowGraph, roofRegions, roofCellKeysを渡していない（belowGraphはWP-B2改訂＝踊り場受け梁の到達階生成、roofRegionsはC2b＝小屋梁の生成、roofCellKeysはC2d-1＝下屋の範囲の床梁ガードが追加した引数）');
});

test('autoFillStructuralGrid: openingSourcesを渡すと規則Oの梁芯（discipline:fuse・beamAxisOrigin:opening）が生成される', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = 'RC造(ラーメン)';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: true, discipline: Discipline.STRUCT });
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: 'RC造(ラーメン)', foundationType: 'ベタ基礎' } };
  const openingSources = [
    { isVertical: false, coord: 2000, lo: 1000, hi: 5000, outwardSign: -1, through: true, onGrid: false, source: 'void', sources: ['void'], beamWidthUnresolved: false },
  ];
  const r = autoFillStructuralGrid(graph, project, 'RC造(ラーメン)', null, [], [], [], [], [], undefined, undefined, undefined, openingSources);
  const created = r.newBeams.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 2000);
  assert.ok(created, '規則Oの梁芯がnewBeamsへ含まれる');
  assert.equal(created.discipline, Discipline.FUSE);
  assert.equal(created.beamAxisOrigin, BeamAxisOrigin.OPENING);
  void x0; void x1;
});

// ---- ステップ5（規則O層C）: 開口由来の短辺梁芯が通し梁芯の小梁を host にする ----
// 通り芯4本の格子（X:0,10000 / Y:0,10000）の内側に、通し辺・短辺のどちらも通り芯上にない矩形の
// 吹抜け（X:[2000,5000] / Y:[3000,4000]。width=3000>height=1000→通しは水平辺）を置く。壁は無し
// （openingBeamAxes.test.jsの makeRectOpeningGraph と同型フィクスチャ）。
function makeOpeningRectFixtureForSecondaryHost() {
  const graph = new PlanGraph(new Plane('p1', 3000, '2階', 2, 1));
  graph.structureOverride = 'RC造(ラーメン)';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 2000,  { labeled: false, discipline: Discipline.ARCH });
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 5000,  { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const ya = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000,  { labeled: false, discipline: Discipline.ARCH });
  const yb = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000,  { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const cells = getAllCells(graph);
  const centerKey = cells.find(c => c.x1 === 2000 && c.x2 === 5000 && c.y1 === 3000 && c.y2 === 4000).key;
  graph.addRoom(new Set([centerKey])).setFeature(RoomFeature.VOID);
  // graph.planeを最下階(index0=基礎伏図)にしない——基礎伏図は梁のrole既定が'foundation'に切り替わり
  // 通り芯グリッドのrole:'primary'梁（host候補）が生成されないため、ダミーの1階を先に置く
  // （既存テストのproject.planes: [new Plane('p0', -3000, ...), graph.plane]と同じ回避パターン）。
  const project = { planes: [new Plane('p0', 0, '1階', 1, 1), graph.plane], structuralInfo: { mainStructure: 'RC造(ラーメン)', foundationType: 'ベタ基礎' } };
  return { graph, project, x0, xa, xb, x1, y0, ya, yb, y1 };
}

function runOpeningRecomputeOnce(graph, project) {
  const openingSources = openingBeamSourcesFor(graph, project);
  return autoFillStructuralGrid(graph, project, 'RC造(ラーメン)', null, [], [], [], [], [], undefined, undefined, undefined, openingSources);
}

test('【ステップ5統合】規則Oの通し梁芯2本にそれぞれ小梁1本、短辺梁芯2本にもそれぞれ小梁1本が生成され、短辺の小梁は通し小梁の縁+クリアランスで止まる', () => {
  const { graph, project } = makeOpeningRectFixtureForSecondaryHost();
  runOpeningRecomputeOnce(graph, project);

  const throughAxes = graph.centerLines.filter(cl =>
    cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.HORIZONTAL);
  const shortAxes = graph.centerLines.filter(cl =>
    cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.VERTICAL);
  assert.equal(throughAxes.length, 2, '通し梁芯2本（y=3000,4000）');
  assert.equal(shortAxes.length, 2, '短辺梁芯2本（x=2000,5000）');

  for (const axis of throughAxes) {
    const secondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === axis.id);
    assert.equal(secondaries.length, 1, `通し梁芯(y=${axis.value})に小梁がちょうど1本`);
    assert.equal(secondaries[0].coord1, 200, '通し小梁は通り芯(primary)の縁+クリアランス(150+50)で止まる');
    assert.equal(secondaries[0].coord2, 9800);
  }
  for (const axis of shortAxes) {
    const secondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === axis.id);
    assert.equal(secondaries.length, 1, `短辺梁芯(x=${axis.value})に小梁がちょうど1本`);
    const [lo, hi] = [secondaries[0].coord1, secondaries[0].coord2].sort((a, b) => a - b);
    assert.equal(lo, 3200, '短辺の小梁は通し小梁の縁(y=3000側。300/2+50=200)で止まる');
    assert.equal(hi, 3800, '短辺の小梁は通し小梁の縁(y=4000側)で止まる');
  }

  // 通し小梁は短辺の位置(x=2000/5000)で分断されない（通し梁芯ごとにちょうど1本のまま）。
  for (const axis of throughAxes) {
    assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === axis.id).length, 1);
  }

  // 冪等: 2回目の autoFillSecondaryBeams（recompute再実行）で増えない。
  const before = graph.beams.filter(b => b.role === 'secondary').length;
  runOpeningRecomputeOnce(graph, project);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, before, '2回目で増えない（冪等）');
});

test('【ステップ5統合・beamAxisMove連携】resolveSecondaryBeamsForAxis（梁芯移動確定）も短辺梁芯の小梁を通し小梁hostで張り直す', () => {
  const { graph, project } = makeOpeningRectFixtureForSecondaryHost();
  runOpeningRecomputeOnce(graph, project);

  const shortAxis2000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  // 一旦削除して「小梁0本」の状態を作る（移動直後にhostが変わり張り直しが必要になる状況の代用）。
  const original = graph.beams.find(b => b.role === 'secondary' && b.axisCL.id === shortAxis2000.id);
  graph.beamMap.delete(original.id);
  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === shortAxis2000.id).length, 0);

  const result = resolveSecondaryBeamsForAxis(graph, shortAxis2000, project);
  assert.deepEqual(result, { before: 0, after: 1 }, 'secondaryBeamSpansFor経由で通し小梁2本をhostとして再解決する');

  const rebuilt = graph.beams.find(b => b.role === 'secondary' && b.axisCL.id === shortAxis2000.id);
  const [lo, hi] = [rebuilt.coord1, rebuilt.coord2].sort((a, b) => a - b);
  assert.equal(lo, 3200, '張り直し後も通し小梁の縁+クリアランスで止まる（生成経路と同じ判定を共有）');
  assert.equal(hi, 3800);
});

test('【ステップ5統合・生成順序の効果】通し梁芯に小梁がまだ無い時点では、短辺梁芯のsecondaryBeamSpansForは0本（順序が結果を左右する実測）', () => {
  const { graph, project } = makeOpeningRectFixtureForSecondaryHost();
  const openingSources = openingBeamSourcesFor(graph, project);
  autoFillOpeningBeamAxes(graph, openingSources); // 梁芯CLのみ生成（小梁はまだ無い）
  autoFillColumns(graph, project, null);
  autoFillBeams(graph, project, 'primary', null); // 通り芯の大梁(primary)を生成

  const through3000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  const through4000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 4000);
  const shortAxis = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);

  // 通し梁芯にまだ小梁が無い段階では、短辺梁芯のhost候補（通し梁芯2本）はどちらもfindHostBeamに
  // 失敗し0本になる——生成順序（通し→短辺）が結果を左右する直接の証拠。
  assert.equal(secondaryBeamSpansFor(graph, shortAxis).length, 0,
    '通し梁芯にまだ小梁が無いため、短辺のhost判定は0本');

  // 通し梁芯側を先に処理（本来のorderForSecondaryBeamFillの順序）すれば、通し小梁2本が生成され、
  // 直後の短辺梁芯のsecondaryBeamSpansForは2本（通し小梁2本）を返すようになる。
  for (const throughAxis of [through3000, through4000]) {
    const throughHosts = secondaryBeamSpansFor(graph, throughAxis);
    assert.equal(throughHosts.length, 2, '通し梁芯はgridXs(x0,x1)の2本がhost候補になる');
    graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', throughAxis, false, throughHosts[0], throughHosts[1], { role: 'secondary' });
  }
  assert.equal(secondaryBeamSpansFor(graph, shortAxis).length, 2,
    '両方の通し小梁の生成後は、短辺梁芯のhost候補が2本（通し小梁2本）に増える');
});

test('【ステップ5統合・変異(2)検出用】graph.centerLinesの並びが短辺→通しの順（restoreGraph等の前方参照）でも、autoFillSecondaryBeamsは短辺の小梁を1回目で生成する（orderForSecondaryBeamFillが並べ替える）', () => {
  // 通常経路（autoFillOpeningBeamAxes）は通し→短辺の順でgraph.centerLinesへ追加するため、
  // beamAxisCenterLines(graph)の走査順は自然に通し先行になる（このファイルの直前のテストで確認）。
  // ここではrestoreGraph（IDB読込み）のようにCLの追加順が保存順（短辺→通し）になり、
  // resolveCenterLineRefsで後から参照解決される前方参照ケースを人工的に再現する——
  // orderForSecondaryBeamFillが無いと、この並びのままautoFillSecondaryBeamsが短辺を先に処理し
  // hostが見つからず1回目は0本になる（変異(2)の効果）。
  const graph = new PlanGraph(new Plane('p1', 3000, '2階', 2, 1));
  graph.structureOverride = 'RC造(ラーメン)';
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const project = { planes: [new Plane('p0', 0, '1階', 1, 1), graph.plane], structuralInfo: { mainStructure: 'RC造(ラーメン)', foundationType: 'ベタ基礎' } };
  void y0; void y1; // 通り芯グリッドの生成に必要（autoFillBeamsのperimeter生成）。以降は参照しない

  // 短辺梁芯を先に追加する（extentLoRef/HiRefは、まだ存在しないid文字列を指す前方参照）。
  const shortAxis = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: 'through3000', offset: 0 }, extentHiRef: { clId: 'through4000', offset: 0 },
  });
  // 通し梁芯を後から追加する（idを明示し、shortAxisの前方参照先と一致させる）。
  const throughAxis3000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: x0.id, offset: 0 }, extentHiRef: { clId: x1.id, offset: 0 },
  }, 'through3000');
  const throughAxis4000 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: x0.id, offset: 0 }, extentHiRef: { clId: x1.id, offset: 0 },
  }, 'through4000');
  graph.resolveCenterLineRefs(); // restoreGraph相当: shortAxisのextentLoRef/HiRefを後から解決する
  assert.equal(graph.centerLines.indexOf(shortAxis) < graph.centerLines.indexOf(throughAxis3000), true,
    '前提: graph.centerLinesの並びは短辺が通しより先（restoreGraph等の保存順を模す）');

  autoFillColumns(graph, project, null);
  autoFillBeams(graph, project, 'primary', null); // 通り芯の大梁(primary)を生成
  const created = autoFillSecondaryBeams(graph, project);

  const shortSecondary = created.find(b => b.axisCL.id === shortAxis.id);
  assert.ok(shortSecondary, '1回目のautoFillSecondaryBeamsで短辺梁芯にも小梁が生成される（orderForSecondaryBeamFillが通しを先に処理するため）');
  const [lo, hi] = [shortSecondary.coord1, shortSecondary.coord2].sort((a, b) => a - b);
  assert.equal(lo, 3200);
  assert.equal(hi, 3800);
  void throughAxis4000;
});

test('【ステップ5・失敗系】開口由来でない梁芯（壁由来wall）はextentが梁芯を参照していても小梁のhostはprimaryのみ（従来どおり）', () => {
  const { graph, project, x1, y1 } = makeOpeningRectFixtureForSecondaryHost();
  // 壁由来(WALL)の梁芯を人工的に作り、extentLoRef/HiRefへ既存の梁芯（beam種別。通し梁芯3000）と
  // 通り芯（x1。extentHiを実在の範囲にするためのダミー）を参照させる——実運用でwallBeamAxes.jsが
  // 作る参照は通常通り芯・壁だが、ここではopeningHostRefIdsがbeamAxisOrigin===OPENING以外は
  // 空集合を返すこと（extentが梁芯を指していてもcrossへ加えない）を確かめるため人工構成にする。
  runOpeningRecomputeOnce(graph, project); // 通し・短辺の梁芯と小梁を用意する（through3000は小梁を持つ）
  const through3000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === through3000.id).length, 1,
    '前提: through3000は小梁を1本持つ（=座標6000をカバーするhost候補になり得る状態）');
  const wallOriginAxis = graph.addCenterLine(CenterLineType.VERTICAL, 6000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.WALL,
    extentLoRef: { clId: through3000.id, offset: 0 }, extentHiRef: { clId: x1.id, offset: 0 },
  });
  const hosts = secondaryBeamSpansFor(graph, wallOriginAxis);
  // cross集合はgridYs（y0,y1）のみ（through3000は参照集合に含まれない=openingHostRefIdsが空）。
  // extentLo=3000のためy0(0)は範囲外・y1(10000)だけが候補に残り、y1にprimaryの大梁があるため1本。
  // through3000（座標的には範囲内かつ小梁を持つ）がcrossに含まれていれば2本になるはずだが含まれない。
  assert.equal(hosts.length, 1, 'wall由来の梁芯はopeningHostRefIdsが空集合＝通し梁芯をcrossへ加えない（従来どおりgridYsのみ）');
  assert.equal(hosts[0].id, y1.id);
});

test('【ステップ5・I-9】RC下地壁の通し辺では短辺小梁が壁由来小梁をhostにする', () => {
  const { graph, project, x0, x1, ya } = makeOpeningRectFixtureForSecondaryHost();
  // y=3000（通し辺）の全長(x0〜x1)を覆うRC下地の下地オーナー壁を張る（I-9是正: この辺は開口由来の
  // 梁芯を新設せず、壁由来の梁芯(壁芯)をそのまま短辺のextentLoRefが参照する）。
  graph.interiorWallBacking = RC_WALL_BACKING_CODES[0];
  graph.addWall(ya, 0, false, x0, 0, x1, 0, { backingDepth: 120, wallFinish: 12.5 });

  const wallSources = wallBeamSourcesFor(graph, project, null);
  assert.ok(wallSources.some(s => !s.isVertical && Math.abs(s.coord - 3000) < 1), '前提: RC下地壁が壁由来梁芯の源になっている');
  const openingSources = openingBeamSourcesFor(graph, project);
  const topSrc = openingSources.find(s => !s.isVertical && s.through === true && Math.abs(s.coord - 3000) < 1);
  assert.equal(topSrc.rcBacked, true, '前提: y=3000の通し辺はRC下地壁ありでrcBacked:true');

  // autoFillStructuralGrid内部の順序（autoFillWallBeamAxes→autoFillOpeningBeamAxes→…→autoFillSecondaryBeams）
  // をそのまま通す（openingBeamSourcesFor→autoFillStructuralGridの実配線どおり）。
  autoFillStructuralGrid(graph, project, 'RC造(ラーメン)', null, wallSources, [], [], [], [], undefined, undefined, undefined, openingSources);

  const wallAxisCL = graph.centerLines.find(cl =>
    cl.beamAxisOrigin === BeamAxisOrigin.WALL && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  assert.ok(wallAxisCL, '前提: 壁由来の梁芯(壁芯)がy=3000に生成されている（開口由来の新規梁芯は作らない）');

  const shortLeft = graph.centerLines.find(cl =>
    cl.beamAxisOrigin === BeamAxisOrigin.OPENING && cl.centerLineType === CenterLineType.VERTICAL && cl.value === 2000);
  assert.equal(shortLeft.extentLoRef?.clId, wallAxisCL.id, '短辺V2000のextentLoRefは壁芯の梁芯(origin=wall)を指す');

  // 壁由来小梁は短辺の位置(x=2000/5000)で分断されず1本のまま。
  const wallSecondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === wallAxisCL.id);
  assert.equal(wallSecondaries.length, 1, '壁由来小梁は1本のまま');

  // 短辺V2000の小梁は1本、描画端は通し小梁の縁+クリアランスで[3200,3800]。
  const shortSecondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === shortLeft.id);
  assert.equal(shortSecondaries.length, 1, '短辺V2000の小梁がちょうど1本（壁由来小梁をhostにできる）');
  const [lo, hi] = [shortSecondaries[0].coord1, shortSecondaries[0].coord2].sort((a, b) => a - b);
  assert.equal(lo, 3200, '壁由来小梁の縁(y=3000側。300/2+50=200)で止まる');
  assert.equal(hi, 3800, '開口由来小梁の縁(y=4000側)で止まる');

  // 冪等: 2回目で本数が増えない。
  const before = graph.beams.filter(b => b.role === 'secondary').length;
  const openingSources2 = openingBeamSourcesFor(graph, project);
  autoFillStructuralGrid(graph, project, 'RC造(ラーメン)', null, wallSources, [], [], [], [], undefined, undefined, undefined, openingSources2);
  assert.equal(graph.beams.filter(b => b.role === 'secondary').length, before, '2回目で増えない（冪等）');
});

test('【ステップ5・T2】通し梁芯の小梁スロットが最初からexcludedBeamSlotsなら短辺小梁は生成されない（0本）', () => {
  // autoFillSecondaryBeams（自動補完）はADD-ONLY——既存の短辺小梁を持ったまま通し小梁だけ後から
  // 除外しても、既存の短辺小梁は削除されない（他のautoFill*系と同じ規律。resolveSecondaryBeamsForAxis
  // だけが張り替えの巻き戻しを持つ）。そのため本テストは「最初の生成より前に除外を仕込む」形で、
  // host欠落が生成時点に効くことを確かめる。
  const { graph, project } = makeOpeningRectFixtureForSecondaryHost();
  const openingSources = openingBeamSourcesFor(graph, project);
  autoFillOpeningBeamAxes(graph, openingSources);
  autoFillColumns(graph, project, null);
  autoFillBeams(graph, project, 'primary', null); // 通り芯の大梁(primary)を生成（小梁はまだ無い）

  const through3000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000);
  const [hostA, hostB] = secondaryBeamSpansFor(graph, through3000);
  assert.equal([hostA, hostB].length, 2, '前提: 通し梁芯(y=3000)は本来gridXs(x0,x1)2本がhost候補になる');
  // 通し梁芯(y=3000)の小梁スロットを、一度も生成しないまま最初から除外集合に記録する
  // （ユーザーが「この位置には小梁を置かない」と事前に選んだ状態を模す）。
  graph.excludedBeamSlots.add(spanKey(through3000, hostA, hostB));

  const created = autoFillSecondaryBeams(graph, project);

  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === through3000.id).length, 0,
    '通し梁芯(y=3000)の小梁は除外集合により生成されない');
  const shortAxes = graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.VERTICAL);
  assert.equal(shortAxes.length, 2, '前提: 短辺梁芯2本');
  for (const axis of shortAxes) {
    assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === axis.id).length, 0,
      'host(通し小梁)が最初から欠けているため短辺小梁も生成されない（0本）');
  }
  // 対照: もう一方の通し梁芯(y=4000)は除外していないので通常どおり1本生成される。
  const through4000 = graph.centerLines.find(cl => cl.beamAxisOrigin === BeamAxisOrigin.OPENING
    && cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 4000);
  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === through4000.id).length, 1,
    '対照: 除外していない通し梁芯(y=4000)は通常どおり生成される');
  void created;
});
