// sectionStructure.js（WP-C: 構造梁の展開図への加算寄与）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { structuralContribution, structuralPrimitivesForCut, beamDepthMm } from './sectionStructure.js';
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

test('beamDepthMm: カタログ断面の成 → beamDepth → 既定105。structuralContribution の depthMm と同じ式', () => {
  assert.equal(beamDepthMm({ sectionDefId: 'STEEL-H200x100', beamDepth: 999 }), 200, 'カタログが優先');
  assert.equal(beamDepthMm({ sectionDefId: 'NO-SUCH', beamDepth: 240 }), 240);
  assert.equal(beamDepthMm({ sectionDefId: 'NO-SUCH', beamDepth: null }), 105);
  assert.equal(beamDepthMm(undefined), 105, '梁が無くても例外にしない');
  const graph = makeGraph();
  addHorizontalBeam(graph, 0);
  const [b] = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(b.depthMm, 200, 'STEEL-H200x100 の成');
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

// ---- ユーザー指示 2026-10-15「2FL にある横架材見え掛かりは、天井仕上げ面より上（=天井裏）につき描画不要」----
// 空中を横断する梁は、opts.ceilZAtWorld（その位置の天井）より梁の下端が上なら描かない。天井が取れない点は見える側。
test('【指示2026-10-15】structuralPrimitivesForCut: 空中横断の梁は、その位置の天井より下端が上なら描かない。天井が無い・天井より低ければ従来どおり中線 2 本', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 3000); // 軸 y=1000・天 3000・成 200（下端 2800）
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'x', line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0,
  };
  const airborne = prims => prims.filter(p => p.weight === 'medium' && p.y1 === p.y2);
  assert.equal(airborne(structuralPrimitivesForCut(contribution, cut, [])).length, 2, '前提: 空中横断の中線 2 本');
  const seen = [];
  const hidden = structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: (x, y) => { seen.push([x, y]); return 2476; } });
  assert.equal(airborne(hidden).length, 0, '天井 2476 より下端 2800 が上＝天井裏');
  assert.ok(seen.length >= 3 && seen.every(([, y]) => Math.abs(y - 999) < 1e-9), '評価点は梁の芯から切断線側へ 1mm 寄せる');
  assert.equal(airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: () => 3000 })).length, 2, '天井 3000 なら下端 2800 は見える');
  assert.equal(airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: () => null })).length, 2, '天井が取れなければ見える側');
  assert.equal(airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: (x) => (x < 1000 ? 2476 : 3000) })).length, 2, 'どこかで天井より下に出ていれば描く');
});

// ---- ユーザー指摘 2026-10-19「roof-test1 2階 展開 階段 A: 3FL 下に 3階床梁がらみの見え掛かり」----
// 3階の到達辺の床梁が柱で分かれておらず（60..1760 の 1 本）、往路側の 3階の壁の足元を越えて復路レーンの上まで続く。
// 旧判定は (1) 天井より上か を区間の 3 点全部で見る全か無か、(2) 壁の中か を 1 枚の壁がスパン全体を覆うときだけ、
// の 2 つで、どちらにも掛からず全長が中線で出た。両方を「覆う区間だけ引く」へ一般化する。
test('【指摘2026-10-19】structuralPrimitivesForCut: 空中横断の梁は、天井より上の部分だけ描かず、天井より下に出る区間は描く', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 3000); // 軸 y=1000・天 3000・成 200（下端 2800）・x 0〜2000
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'x', line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0,
  };
  const airborne = prims => prims.filter(p => p.weight === 'medium' && p.y1 === p.y2).sort((a, b) => a.x1 - b.x1);
  // x<1000 は天井 2476（下端 2800 が上＝天井裏）・x≥1000 は天井 3000（見える）
  const half = airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: (x) => (x < 1000 ? 2476 : 3000) }));
  assert.equal(half.length, 2, '見える区間 1 つ＝天地 2 本');
  for (const p of half) {
    assert.ok(Math.abs(p.x1 - 1000) < 0.5, `始点は天井が変わる x=1000（実測 ${p.x1}）`);
    assert.equal(p.x2, 2000);
  }
  // 逆（x≥1000 が天井裏）
  const other = airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: (x) => (x >= 1000 ? 2476 : 3000) }));
  assert.equal(other.length, 2);
  for (const p of other) { assert.equal(p.x1, 0); assert.ok(Math.abs(p.x2 - 1000) < 0.5, `終点 x=1000（実測 ${p.x2}）`); }
  // 中央だけ天井裏（600..1400）→ 見える区間 2 つ＝4 本
  const mid = airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: (x) => (x > 600 && x < 1400 ? 2476 : 3000) }));
  assert.equal(mid.length, 4);
  assert.ok(Math.abs(mid[0].x2 - 600) < 0.5 && Math.abs(mid[2].x1 - 1400) < 0.5, `境界 600/1400（実測 ${mid[0].x2}/${mid[2].x1}）`);
  // 失敗系: 天井が取れない点（null）は見える側。全部 null なら従来どおり全長 2 本
  assert.deepEqual(airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: () => null })).map(p => [p.x1, p.x2]), [[0, 2000], [0, 2000]]);
  // 全部天井裏なら 0 本（従来どおり）
  assert.equal(airborne(structuralPrimitivesForCut(contribution, cut, [], null, { ceilZAtWorld: () => 2476 })).length, 0);
});

test('【指摘2026-10-19】structuralContribution: スパンの一部だけを覆う壁の足元は hiddenSpans（梁のスパンで切る）。全体を覆えば従来どおり寄与しない・壁より太い梁は空', () => {
  // exteriorWallFake: span -72.5..3712.5。区間の控除は壁のスパンそのまま（隅の許容は全スパン判定だけ）→ 0..3712.5
  const longGirder = { ...girderOnAxis(), coord1: 0, coord2: 8000 };
  const [solid] = structuralContribution([{ graph: { walls: [exteriorWallFake], beams: [longGirder] }, floorZMm: 0, role: 'self' }]);
  assert.ok(solid, '壁より長い梁は寄与する');
  assert.deepEqual(solid.hiddenSpans, [[0, 3712.5]], '壁の足元を梁のスパンで切った区間（許容なし）');
  assert.deepEqual(structuralContribution([{ graph: { walls: [exteriorWallFake], beams: [girderOnAxis()] }, floorZMm: 0, role: 'self' }]), [],
    '全スパンを覆う壁の中の梁は従来どおり落ちる');
  const [fat] = structuralContribution([{ graph: { walls: [exteriorWallFake], beams: [{ ...girderOnAxis(150), coord2: 8000 }] }, floorZMm: 0, role: 'self' }]);
  assert.deepEqual(fat.hiddenSpans, [], '壁より太い梁は室内へ出るので隠す区間なし');
  const [noWall] = structuralContribution([{ graph: { walls: [], beams: [longGirder] }, floorZMm: 0, role: 'self' }]);
  assert.deepEqual(noWall.hiddenSpans, [], '壁が無ければ空');
  // 失敗系: 別の層（上階）の壁は、梁の天がその層に無ければ足元が届かない（2階の床下の梁を 3階の壁が隠さない）
  const twoLayers = (levelOffset) => structuralContribution([
    { graph: { walls: [], beams: [{ ...longGirder, levelOffset }] }, floorZMm: 0, role: 'self' },
    { graph: { walls: [exteriorWallFake], beams: [] }, floorZMm: 3000, role: 'above' },
  ]);
  assert.deepEqual(twoLayers(0)[0].hiddenSpans, [], '天 0 の梁に 3000 から立つ壁の足元は届かない');
  assert.deepEqual(twoLayers(3000)[0].hiddenSpans, [[0, 3712.5]], '天 3000（上階の床）の梁は上階の壁の足元に入る');
  // QA 指摘 2026-10-19: 在来木造の横架材は再計算（conformWoodBeamLevels）で天端 FL−100 になる。壁が立つ床の下の床梁（天が床−梁成以上）も足元に入る
  assert.deepEqual(twoLayers(2900)[0].hiddenSpans, [[0, 3712.5]], '天 FL−100（成 120 の WOOD-120x120）の床梁も上階の壁の足元に入る');
  assert.deepEqual(twoLayers(3000 - 120 - 1)[0].hiddenSpans, [], '天が床−梁成より下なら上階の壁の足元ではない');
  const selfWall = structuralContribution([
    { graph: { walls: [exteriorWallFake], beams: [{ ...longGirder, levelOffset: -3000 }] }, floorZMm: 0, role: 'self' },
    { graph: { walls: [], beams: [] }, floorZMm: 3000, role: 'above' },
  ]);
  assert.deepEqual(selfWall[0].hiddenSpans, [], '自階の層の床より下の天の梁は自階の壁の足元に入らない');
});

test('【指摘2026-10-19】structuralPrimitivesForCut: hiddenSpans の区間は空中横断（中線）・平行（細線）とも描かない。柱で分かれた梁と 1 本の梁で描画が変わらない', () => {
  // 天 3000（levelOffset）: 天 0 だと下端 −120 が baseFloorZ より下で細破線に降格し中線の数が数えられない
  const longGirder = { ...girderOnAxis(), coord1: 0, coord2: 8000, levelOffset: 3000 };
  const walls = [exteriorWallFake];
  const contribution = structuralContribution([{ graph: { walls, beams: [longGirder] }, floorZMm: 0, role: 'self' }]);
  const cutAt = (axisValue, viewSign) => ({
    seqNo: 'x', line: { isVertical: false, axisValue, lo: -1000, hi: 9000 },
    viewSign, dirSign: 1, layers: [], zRange: { loZ: -500, hiZ: 5400 }, baseFloorZ: 0,
  });
  // 空中横断（切断線 y=-500 から +y を見る。梁は y=0）: 壁の足元 0..3712.5 を引いた 3712.5..8000 だけ中線 2 本
  const air = structuralPrimitivesForCut(contribution, cutAt(-500, 1), [], null, { columnSolids: null })
    .filter(p => p.weight === 'medium' && p.y1 === p.y2);
  assert.equal(air.length, 2);
  for (const p of air) assert.ok(Math.abs((p.x2 - p.x1) - (8000 - 3712.5)) < 1e-6, `長さ 4287.5（実測 ${p.x2 - p.x1}）`);
  // 平行（切断線が梁の帯の中）: 天地 2 本＋残っている端（8000 側）の縦線 1 本＝3 本（旧: 4 本・0..8000）
  const par = structuralPrimitivesForCut(contribution, cutAt(0, 1), [], null, { columnSolids: null }).filter(p => p.weight === 'thin');
  assert.equal(par.length, 3, `天地 2 本＋縦線 1 本（実測 ${par.length}）`);
  assert.equal(par.filter(p => p.x1 === p.x2).length, 1, '壁の足元で切れた側（0）には縦線を出さない');
  // 分割された 2 本（0..3640 は壁の中〔隅の許容込み〕で寄与しない／3640..8000 は 3712.5 まで足元）と同じ結果になること
  const split = structuralContribution([{ graph: { walls, beams: [{ ...girderOnAxis(), levelOffset: 3000 }, { ...girderOnAxis(), coord1: 3640, coord2: 8000, levelOffset: 3000 }] }, floorZMm: 0, role: 'self' }]);
  const airSplit = structuralPrimitivesForCut(split, cutAt(-500, 1), [], null, { columnSolids: null }).filter(p => p.weight === 'medium' && p.y1 === p.y2);
  assert.deepEqual(airSplit.map(p => [p.x1, p.x2, p.y1]), air.map(p => [p.x1, p.x2, p.y1]));
  // 平行（細線・縦線）も分割された梁と 1 本の梁で一致する
  const parSplit = structuralPrimitivesForCut(split, cutAt(0, 1), [], null, { columnSolids: null }).filter(p => p.weight === 'thin');
  const key = p => [p.x1, p.y1, p.x2, p.y2].join(',');
  assert.deepEqual(parSplit.map(key).sort(), par.map(key).sort(), '平行の天地・縦線も一致');
  // 在来木造の再計算後（天端 FL−100）でも同じ: 上階（床 3000）の壁の足元に、天 2900 の 1 本の梁と分割された梁が同じ中線
  const layersAt = (beams) => [
    { graph: { walls: [], beams }, floorZMm: 0, role: 'self' },
    { graph: { walls, beams: [] }, floorZMm: 3000, role: 'above' },
  ];
  const cutUp = { ...cutAt(-500, 1), layers: [], zRange: { loZ: -500, hiZ: 6000 } };
  const airOne = structuralPrimitivesForCut(structuralContribution(layersAt([{ ...longGirder, levelOffset: 2900 }])), cutUp, [], null, { columnSolids: null })
    .filter(p => p.weight === 'medium' && p.y1 === p.y2);
  const airTwo = structuralPrimitivesForCut(structuralContribution(layersAt([{ ...girderOnAxis(), levelOffset: 2900 }, { ...girderOnAxis(), coord1: 3640, coord2: 8000, levelOffset: 2900 }])), cutUp, [], null, { columnSolids: null })
    .filter(p => p.weight === 'medium' && p.y1 === p.y2);
  assert.equal(airOne.length, 2, 'FL−100 の 1 本の梁: 壁の足元を引いた中線 2 本');
  for (const p of airOne) assert.ok(Math.abs((p.x2 - p.x1) - (8000 - 3712.5)) < 1e-6, `FL−100 でも壁の足元 0..3712.5 を引く（実測 ${p.x2 - p.x1}）`);
  assert.deepEqual(airTwo.map(key).sort(), airOne.map(key).sort(), 'FL−100 でも分割の有無で一致');
});
