// sectionStructure.js（WP-C: 構造梁の展開図への加算寄与）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { structuralContribution, structuralPrimitivesForCut } from './sectionStructure.js';

function makeGraph(name = 'p1') {
  const plane = new Plane(name, 0, `${name}階`, 1, 1);
  return new PlanGraph(plane);
}

// 水平梁（isVertical=false）: 通り芯y=1000に沿ってx=0〜2000。STEEL-H200x100（幅100・成200）。
function addHorizontalBeam(graph, levelOffset, role = 'landing') {
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  return graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', axisCL, false, x0, x1, { role, levelOffset });
}

// ---- structuralContribution ----
test('【WP-C】structuralContribution: 1層1梁からBeamSolid1件（axisWorld/spanLo-Hi/widthMm/topZ/depthMm/role）を組み立てる', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, -20);
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(contribution.length, 1);
  const b = contribution[0];
  assert.equal(b.isVertical, false);
  assert.equal(b.axisWorld, 1000);
  assert.equal(b.spanLo, 0);
  assert.equal(b.spanHi, 2000);
  assert.equal(b.widthMm, 100, 'STEEL-H200x100の幅は100のはず');
  assert.equal(b.depthMm, 200, 'STEEL-H200x100の成は200のはず');
  assert.equal(b.topZ, -20, 'topZ=layer.floorZMm(0)+levelOffset(-20)');
  assert.equal(b.role, 'landing');
});

test('【WP-C】structuralContribution: 複数層（自階・上階）のgraph.beamsをそれぞれ拾い、topZは各層floorZMm基準になる', () => {
  const selfGraph = makeGraph('p1');
  addHorizontalBeam(selfGraph, 890);
  const aboveGraph = makeGraph('p2');
  addHorizontalBeam(aboveGraph, -100, 'primary');
  const contribution = structuralContribution([
    { graph: selfGraph, floorZMm: 0, role: 'self' },
    { graph: aboveGraph, floorZMm: 2400, role: 'above' },
  ]);
  assert.equal(contribution.length, 2);
  assert.equal(contribution.find(b => b.role === 'landing').topZ, 890);
  assert.equal(contribution.find(b => b.role === 'primary').topZ, 2400 - 100);
});

test('【失敗系・WP-C】structuralContribution: layersが空配列・undefinedでも例外を投げず空配列', () => {
  assert.deepEqual(structuralContribution([]), []);
  assert.deepEqual(structuralContribution(undefined), []);
});

// ---- structuralPrimitivesForCut ----
test('【WP-C】structuralPrimitivesForCut: 切断線が梁を横切る（直交・spanが重なる）と幅×せいのCUT断面矩形(4本・太線)を出す', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // topZ=500（baseFloorZ=0より上）
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  const prims = structuralPrimitivesForCut(contribution, cut, []);
  assert.equal(prims.length, 4, '断面矩形4辺のはず');
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.weight, 'thick', '断面はCUT(太線)のはず');
    assert.equal(p.dash, undefined, 'baseFloorZより上のためdash無しのはず');
  }
  const xs = prims.flatMap(p => [p.x1, p.x2]);
  assert.ok(Math.min(...xs) <= 950 + 1e-6 && Math.max(...xs) >= 1050 - 1e-6, '幅100mm分(1000±50)の断面幅のはず');
});

test('【WP-C】structuralPrimitivesForCut: 切断線が梁に平行かつ幅の帯内・spanが重なると上端/下端/両端縦線(4本・DETAIL細線)を出す', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500);
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'y', line: { isVertical: false, axisValue: 1000, lo: -500, hi: 2500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  const prims = structuralPrimitivesForCut(contribution, cut, []);
  assert.equal(prims.length, 4);
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.weight, 'thin', '見えがかりはDETAIL(細線)のはず');
  }
  const xs = prims.flatMap(p => [p.x1, p.x2]);
  assert.ok(Math.abs(Math.min(...xs) - 500) < 1e-6, 'spanLo(0)のローカルxは500(=0-lo(-500))のはず');
  assert.ok(Math.abs(Math.max(...xs) - 2500) < 1e-6, 'spanHi(2000)のローカルxは2500(=2000-lo(-500))のはず');
});

test('【WP-C】structuralPrimitivesForCut: baseFloorZより下の梁は既存フィルタでDETAIL+破線へ降格する（新規判定を持たない）', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, -500); // topZ=-500, depth=200 → zBot=-700。ともにbaseFloorZ(0)より下
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -1000, hiZ: 3000 }, baseFloorZ: 0,
  };
  const prims = structuralPrimitivesForCut(contribution, cut, []);
  assert.equal(prims.length, 4);
  for (const p of prims) {
    assert.equal(p.weight, 'thin', 'baseFloorZより下はDETAILへ降格するはず');
    assert.equal(p.dash, 'dashed');
  }
});

test('【失敗系・WP-C】structuralPrimitivesForCut: 切断線と無関係（直交でも平行でもspan外）な梁は何も出さない', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500);
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    // 平行(isVertical一致)だがaxisValueが梁の幅帯(1000±50)から外れている＝視線がその位置を通らない。
    seqNo: 'z', line: { isVertical: false, axisValue: 5000, lo: -500, hi: 2500 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  assert.deepEqual(structuralPrimitivesForCut(contribution, cut, []), []);
});

test('【失敗系・WP-C】structuralPrimitivesForCut: contribution空配列・columns省略でも例外を投げず空配列', () => {
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  assert.deepEqual(structuralPrimitivesForCut([], cut), []);
  assert.deepEqual(structuralPrimitivesForCut(undefined, cut), []);
});
