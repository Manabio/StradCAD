// structuralAutoFill.js（WP-B2: 踊り場受け梁 autoFillStairLandingBeams）の単体テスト。
// フィクスチャはelevation/section/sectionStair.test.js／finish/stair/stairLanding.test.jsの
// makeSwitchbackFixtureと同一構成（コメントも参照。sections:[6,1,6]→n1=6・totalSteps=12）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, StructuralMaterialType } from '../core.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { autoFillStairLandingBeams } from './structuralAutoFill.js';

// 1階(elevation:0)・2階(elevation:2400)の2フロアProject。floorHeightAbove(project, 1階plane)=2400。
function makeProjectWithFloors() {
  const project = new Project('proj1', 'test');
  const { graph } = project.addPlane(0, '1階');
  project.addPlane(2400, '2階');
  return { project, graph };
}

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
