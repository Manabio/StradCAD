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

test('【Minor-1・QA裁定2026-09-18】structuralContribution: 土台（role:\'sill\'）は基礎梁と同じく展開図の加算寄与に含まれない', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, -100, 'sill');
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.deepEqual(contribution, [], '土台は床下の横架材で室内展開に寄与しないため除外される（階段帯はclipを通さないため床下線が出る）');
});

test('【C2a】structuralContribution: 小屋梁（role:\'roofBeam\'）は展開図・断面の加算寄与に含まれない。他roleは従来どおり含まれる', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, -100, 'roofBeam');
  assert.deepEqual(structuralContribution([{ graph, floorZMm: 0, role: 'self' }]), [], '小屋梁は構造モードの伏図専用（ユーザー裁定2026-10-02）');
  for (const role of ['primary', 'secondary', 'floor', 'landing', 'eaves']) {
    const g = makeGraph(`p-${role}`);
    addHorizontalBeam(g, -100, role);
    const c = structuralContribution([{ graph: g, floorZMm: 0, role: 'self' }]);
    assert.equal(c.length, 1, `role:${role}は従来どおり寄与する`);
  }
  // 小屋梁と大梁が同じ階に混在しても、除外されるのは小屋梁だけ
  const mixed = makeGraph('mixed');
  addHorizontalBeam(mixed, -100, 'roofBeam');
  addHorizontalBeam(mixed, -100, 'primary');
  const roles = structuralContribution([{ graph: mixed, floorZMm: 0, role: 'self' }]).map(b => b.role);
  assert.deepEqual(roles, ['primary']);
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

// ---- ユーザー指示2026-10-07「隠す範囲を1箇所に集約して柱と共有」 ----
// 外壁は backingDepth 未指定の対称壁で materialRange が軸〜外面の片側 [0,72.5] しか返さない（実機
// moku1-3）。柱と同じ wallConcealRange（下地帯 [-60,60] を含む）で判定しないと、通り芯上の胴差・桁
// （幅120）が「壁の外」になり、階段帯などクリップの無い帯に断面が出る。
const exteriorWallFake = {
  isVertical: false, materialRange: { lo: 0, hi: 72.5 }, backingRange: { lo: -60, hi: 60 },
  coord1: -72.5, coord2: 3712.5, wallFinish: 12.5, axisCL: { effectiveValue: 0 },
};
const girderOnAxis = (sectionWidth = 120) => ({
  role: 'primary', isVertical: false, axisValue: 0, coord1: 0, coord2: 3640,
  sectionWidth, sectionDefId: 'WOOD-120x120', levelOffset: 0,
});

test('【集約2026-10】structuralContribution: 外壁の下地帯に収まる通り芯上の梁は寄与しない（柱と同じ隠す範囲）', () => {
  const layer = { graph: { walls: [exteriorWallFake], beams: [girderOnAxis()] }, floorZMm: 0, role: 'self' };
  assert.deepEqual(structuralContribution([layer]), [], '幅120の胴差は下地帯120＋仕上げに収まるはず');
  const fat = { graph: { walls: [exteriorWallFake], beams: [girderOnAxis(150)] }, floorZMm: 0, role: 'self' };
  assert.equal(structuralContribution([fat]).length, 1, '壁より太い梁は室内へ出るので従来どおり寄与する');
});

test('【集約2026-10】structuralPrimitivesForCut: 切断位置の判定も柱と同じ隠す範囲（外壁の中の胴差は描かない）', () => {
  // 全スパン基準では落ちない（梁が壁より長い）構成にして、切断位置の判定だけを通す。
  const longGirder = { ...girderOnAxis(), coord1: -5000, coord2: 8000 };
  const contribution = structuralContribution([{ graph: { walls: [], beams: [longGirder] }, floorZMm: 0, role: 'self' }]);
  assert.equal(contribution.length, 1, '前提: 壁の無い層では寄与する');
  const cutAt = (walls, axisValue) => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: -1000, hi: 1000 },
    viewSign: 1, dirSign: 1, layers: [{ graph: { walls }, floorZMm: 0, role: 'self' }],
    zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  assert.deepEqual(structuralPrimitivesForCut(contribution, cutAt([exteriorWallFake], 1820), []), [],
    '外壁が覆う位置で切った断面は描かないはず');
  assert.equal(structuralPrimitivesForCut(contribution, cutAt([exteriorWallFake], 6000), []).length, 4,
    '壁の無い位置で切れば従来どおり断面（矩形4辺）');
});

test('【失敗系・集約2026-10】structuralContribution: 下地を持たない薄壁（backingRange=null）の片側の材厚は通り芯上の梁を隠さない', () => {
  const thin = { ...exteriorWallFake, backingRange: null };
  const layer = { graph: { walls: [thin], beams: [girderOnAxis()] }, floorZMm: 0, role: 'self' };
  assert.equal(structuralContribution([layer]).length, 1);
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

// ---- 断面線（floorProfile）より下の梁は描かない（2026-10-08裁定「断面の外側は描かない」）----
test('【2026-10-08】structuralPrimitivesForCut: 断面線があるとき、上端が輪郭より下の梁（設置階FLの梁）は出さず、輪郭に接する踊り場受け梁は残す', () => {
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  };
  const profile = [[0, 1200], [2000, 1200]];
  const gFloor = makeGraph('f');
  addHorizontalBeam(gFloor, 0, 'floor'); // 上端0＝設置階FL・成200（輪郭1200に届かない＝階段下に浮く）
  const floorBeam = structuralContribution([{ graph: gFloor, floorZMm: 0, role: 'self' }]);
  assert.ok(structuralPrimitivesForCut(floorBeam, cut, [], null).length > 0, '前提: 輪郭なしでは描かれる');
  assert.deepEqual(structuralPrimitivesForCut(floorBeam, cut, [], profile), [], '輪郭より下の梁は出さない');

  const gLanding = makeGraph('l');
  addHorizontalBeam(gLanding, 890, 'landing'); // 踊り場受け梁（天は踊り場1200より下がる）は落とさない
  const gUpper = makeGraph('u');
  addHorizontalBeam(gUpper, 1100, 'floor'); // 天1100＋成200≧輪郭1200＝階段寄与に届く梁は残す
  const landingBeam = structuralContribution([{ graph: gLanding, floorZMm: 0, role: 'self' }]);
  assert.equal(structuralPrimitivesForCut(landingBeam, cut, [], profile).length,
    structuralPrimitivesForCut(landingBeam, cut, [], null).length, '踊り場受け梁は従来どおり');
  const reaching = structuralContribution([{ graph: gUpper, floorZMm: 0, role: 'self' }]);
  assert.equal(structuralPrimitivesForCut(reaching, cut, [], profile).length,
    structuralPrimitivesForCut(reaching, cut, [], null).length, '輪郭に梁成以内で届く梁は従来どおり');
});
