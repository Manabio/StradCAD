// sectionStructure.js（WP-C: 構造梁の展開図への加算寄与）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { structuralContribution, structuralPrimitivesForCut } from './sectionStructure.js';
import { cutDrawRange } from './sectionTypes.js';

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
  // 期待値更新（ユーザー実機指摘2026-08「断面形状を指定構造材に合わせて」）: STEEL-H200x100は
  // H形鋼なのでフランジ・ウェブの実形状＝12辺の閉じた輪郭になる（矩形4辺ではない）。
  assert.equal(prims.length, 12, 'H形鋼の断面輪郭は12辺のはず');
  for (const p of prims) {
    assert.equal(p.type, 'line');
    assert.equal(p.weight, 'thick', '断面はCUT(太線)のはず');
    assert.equal(p.dash, undefined, 'baseFloorZより上のためdash無しのはず');
  }
  const xs = prims.flatMap(p => [p.x1, p.x2]);
  assert.ok(Math.min(...xs) <= 950 + 1e-6 && Math.max(...xs) >= 1050 - 1e-6, '幅100mm分(1000±50)の断面幅のはず');
});

// ---- ユーザー実機指摘2026-08「壁の中にある2階床梁の断面 描画不要」----
// 実機「6」では面の描画範囲がx=0..2885／-285..3442.5なのに、梁の断面矩形がx=-6882.5..-6782.5や
// x=-3325..-3225（＝別スパンの梁）に描かれていた。docコメントは元から「梁の位置(axisWorld)が
// 切断線の範囲(lo..hi)内」を契約としていたが、その判定の実装が抜けていた。
test('【実機指摘】structuralPrimitivesForCut: 梁の位置が切断線の描画範囲の外なら断面矩形を描かない', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // 梁の軸はworld y=1000
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  // 切断線はx=1000上の縦線だが、描画範囲は y=4000..6000（梁の軸y=1000は範囲外）。
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 4000, hi: 6000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  assert.deepEqual(structuralPrimitivesForCut(contribution, cut, []), [],
    '面のはるか外にある梁は描かないはず');
});

test('【実機指摘】cutDrawRange: 壁のない端部の探査延長ぶんも描画範囲に含む', () => {
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 0, lo: 0, hi: 2000, probeExtendLoMm: 150 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  assert.deepEqual(cutDrawRange(cut), { lo: -150, hi: 2000 });
  const plain = { ...cut, line: { isVertical: true, axisValue: 0, lo: 0, hi: 2000 } };
  assert.deepEqual(cutDrawRange(plain), { lo: 0, hi: 2000 });
});

test('【失敗系・実機指摘】structuralPrimitivesForCut: 範囲の端の通り芯上に乗る梁は半壁厚ぶんの許容で描かれる', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // 梁の軸はworld y=1000
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  // 描画範囲の端(lo=1057.5)が、梁の乗る通り芯(y=1000)より半壁厚(57.5)ぶん内側に詰まっている構成。
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 1057.5, hi: 3000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
    face: { faceValue: 1057.5, axisCL: { effectiveValue: 1000 } }, // halfWallThicknessMm=57.5
  };
  assert.equal(structuralPrimitivesForCut(contribution, cut, []).length, 12,
    'CL上の梁は取りこぼさないはず（梁の半幅＋半壁厚の許容。H形鋼なので12辺）');
});

// ---- ユーザー実機指摘2026-08「6」「Y2の壁際、2FL床高付近に謎の構造材断面」 ----
// 実機の2階床梁はspan=-7625..-3290のように建物を貫いて走るため、既定の「壁の中なら描画しない」
// （梁の全スパンを1枚の壁が覆うことを要求）が一度も発動しない。断面は切断線と交わる**一点**で
// 描かれるので、判定もその位置で行う。
test('【実機指摘】structuralPrimitivesForCut: 切断位置で壁の中に納まる梁の断面は描かない', () => {
  const graph = makeGraph();
  const beam = addHorizontalBeam(graph, 500); // 通り芯y=1000に沿ってx=0〜2000・幅100
  // 梁芯と同じy=1000に、梁より短い壁（x=800〜1200）を置く。全スパンは覆わないが切断位置は覆う。
  const wall = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: 800, coord2: 1200 };
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(contribution.length, 1, '前提: 全スパン基準の既定フィルタでは落ちない');
  const cutAt = axisValue => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [{ graph: { walls: [wall] }, floorZMm: 0, role: 'self' }],
    zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  assert.deepEqual(structuralPrimitivesForCut(contribution, cutAt(1000), []), [],
    '壁が覆う位置(x=1000)で切ると断面は描かないはず');
  assert.equal(structuralPrimitivesForCut(contribution, cutAt(1800), []).length, 12,
    '壁の無い位置(x=1800)で切れば従来どおり断面を描くはず（H形鋼なので12辺）');
  void beam;
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
  assert.equal(prims.length, 12, 'H形鋼の断面輪郭は12辺のはず');
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
