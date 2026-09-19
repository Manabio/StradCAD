// structuralAutoFill.js（WP-B2: 踊り場受け梁 autoFillStairLandingBeams）の単体テスト。
// フィクスチャはelevation/section/sectionStair.test.js／finish/stair/stairLanding.test.jsの
// makeSwitchbackFixtureと同一構成（コメントも参照。sections:[6,1,6]→n1=6・totalSteps=12）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, StairType, StructuralMaterialType } from '../core.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { autoFillStairLandingBeams, autoFillBeamsForStructure, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments } from './wallBeamAxes.js';

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
  assert.ok(/autoFillWoodFloorBeams\(graph, project\)/.test(src), 'autoFillWoodFloorBeams(graph, project) の呼び出しが無い');
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

test('【WP-B2】autoFillStairLandingBeams: STEEL階段の踊り場back辺(y0)に1本だけrole:landing梁を生成する（levelOffset=landingZ-310）', () => {
  const { project, graph } = makeProjectWithFloors();
  const { ids } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const created = autoFillStairLandingBeams(graph, project);
  assert.equal(created.length, 1, 'back辺の1本だけのはず（side/frontには生成しない）');
  const beam = created[0];
  assert.equal(beam.role, 'landing');
  assert.equal(beam.materialType, StructuralMaterialType.STEEL);
  assert.equal(beam.isVertical, false, 'back辺(y0)は走行軸に直交＝水平梁のはず');
  assert.equal(beam.axisCL.id, ids.y0.id);
  assert.deepEqual([beam.clStart.id, beam.clEnd.id].sort(), [ids.x0.id, ids.x1.id].sort());
  // landingZ=n1(6)*riser(2400/12=200)=1200 → levelOffset=1200-300-10=890
  assert.equal(beam.levelOffset, 890);
  assert.ok(graph.beams.includes(beam));
});

test('【WP-B2】autoFillStairLandingBeams: RC階段は既定断面RC-300x300でrole:landing梁を生成する', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.RC);
  const created = autoFillStairLandingBeams(graph, project);
  assert.equal(created.length, 1);
  assert.equal(created[0].materialType, StructuralMaterialType.RC);
  assert.equal(created[0].sectionDefId, 'RC-300x300');
});

test('【WP-B2】autoFillStairLandingBeams: excludedBeamSlotsに記録された辺は再生成しない（手動削除の尊重）', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const [beam] = autoFillStairLandingBeams(graph, project);
  graph.removeBeam(beam.id); // excludedBeamSlotsへ記録される
  const second = autoFillStairLandingBeams(graph, project);
  assert.equal(second.length, 0, '手動削除された辺は自動補完で復活しないはず');
});

test('【WP-B2】autoFillStairLandingBeams: 2回連続で呼んでも重複生成しない（冪等）', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const first = autoFillStairLandingBeams(graph, project);
  const second = autoFillStairLandingBeams(graph, project);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0, '既存梁と同じspanKeyのため2回目は生成しないはず');
  assert.equal(graph.beams.filter(b => b.role === 'landing').length, 1);
});

test('【失敗系・WP-B2】autoFillStairLandingBeams: 木造階段(既定structure)は0本', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.WOOD);
  const created = autoFillStairLandingBeams(graph, project);
  assert.equal(created.length, 0);
});

test('【失敗系・WP-B2】autoFillStairLandingBeams: SWITCHBACK以外(STRAIGHT)は0本・例外なし', () => {
  const { project, graph } = makeProjectWithFloors();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  stair.setField('type', StairType.STRAIGHT);
  assert.doesNotThrow(() => {
    const created = autoFillStairLandingBeams(graph, project);
    assert.equal(created.length, 0);
  });
});

test('【失敗系・WP-B2】autoFillStairLandingBeams: stair.cellsが空でも0本・例外なし', () => {
  const { project, graph } = makeProjectWithFloors();
  const { stair } = makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  stair.setCells(new Set());
  assert.doesNotThrow(() => {
    const created = autoFillStairLandingBeams(graph, project);
    assert.equal(created.length, 0);
  });
});

test('【失敗系・WP-B2】autoFillStairLandingBeams: graph.stairsが空（階段の無い階）でも0本・例外なし', () => {
  const { project, graph } = makeProjectWithFloors();
  assert.doesNotThrow(() => {
    assert.equal(autoFillStairLandingBeams(graph, project).length, 0);
  });
});

test('【WP-B2】autoFillStairLandingBeams: wallGateを渡しても呼び出さない（適用しない設計どおり・例外なし）', () => {
  const { project, graph } = makeProjectWithFloors();
  makeSwitchbackFixture(graph, StructuralMaterialType.STEEL);
  const poisonWallGate = {
    spanInBuilding() { throw new Error('wallGateは踊り場受け梁には適用しないはず'); },
    intersectionInBuilding() { throw new Error('wallGateは踊り場受け梁には適用しないはず'); },
  };
  const created = autoFillStairLandingBeams(graph, project, poisonWallGate);
  assert.equal(created.length, 1, 'wallGateが渡されても通常どおり1本生成されるはず');
});
