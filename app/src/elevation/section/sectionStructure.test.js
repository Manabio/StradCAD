// sectionStructure.js（WP-C: 構造梁の展開図への加算寄与）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { structuralContribution, structuralPrimitivesForCut, beamDepthMm, occludeByFloor } from './sectionStructure.js';
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
// 描かれるので、判定もその位置で行う（2026-10-22: 切断位置の1点判定 isBeamInWallAt を一般化。
// (A) 切断位置が平行な壁の足元の内部〔直交壁の帯を除く・端は含めない〕なら埋まっているので描かない
// (B) 室内側へ続く残りから壁の足元〔embeddedSpans〕・直交壁の帯・柱を引いて残りが無ければ描かない）。
// このテストの「描かない」は (A) で落ちている（切断位置 x=1000 が壁 800..2200 の内部）。(B) は下の T1・T2 が守る。
test('【実機指摘】structuralPrimitivesForCut: 切断位置が平行な壁の内部にある梁の断面は描かない（(A)）', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // 通り芯y=1000に沿ってx=0〜2000・幅100
  // 梁芯と同じy=1000に、梁の途中から先の端まで覆う壁（x=800〜2200）を置く。全スパンは覆わない。
  const wall = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: 800, coord2: 2200 };
  const layers = [{ graph: { walls: [wall], beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const contribution = structuralContribution(layers);
  assert.equal(contribution.length, 1, '前提: 全スパン基準の既定フィルタでは落ちない');
  const cutAt = axisValue => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers,
    zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  assert.deepEqual(structuralPrimitivesForCut(contribution, cutAt(1000), []), [],
    '壁が覆う位置(x=1000)で切り、室内側(1000..2000)が壁の中に納まるなら断面は描かないはず');
  assert.equal(structuralPrimitivesForCut(contribution, cutAt(500), []).length, 12,
    '壁の手前(x=500)で切れば室内側に壁の外の残り(500..800)があるので断面を描くはず（H形鋼なので12辺）');
});

// ---- (B) 室内側へ続く残りの控除（embeddedSpans）を守るテスト ----
// 配置: 梁 x0..2000（y=1000・幅100）、直交する面の壁 x=1200（帯 1140..1260・梁の帯を覆う）。
const PERP_1200 = { isVertical: true, materialRange: { lo: 1140, hi: 1260 }, coord1: -100, coord2: 2100 };
const par = (c1, c2) => ({ isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: c1, coord2: c2 });
function tFixture(walls) {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500);
  const layers = [{ graph: { walls, beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const cutAt = (axisValue, viewSign = 1) => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: 0, hi: 2000 },
    viewSign, dirSign: 1, layers, zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  return { contribution: structuralContribution(layers), cutAt };
}

test('【T1・(B)】A2 の型でも、室内側の平行壁（T字）で梁が終わるなら描かない', () => {
  // 向こう側 800..1250 と室内側 1250..2000 の 2 枚。(A) は直交壁の帯を除くと通るので、(B) の控除だけが落とす
  const { contribution, cutAt } = tFixture([par(800, 1250), par(1250, 2000), PERP_1200]);
  assert.equal(contribution.length, 1, '前提: 壁は梁の始端(0)を覆わない');
  assert.deepEqual(structuralPrimitivesForCut(contribution, cutAt(1200), []), [],
    '室内側(1200..2000)が直交壁の帯と平行壁に覆われて残りが無い → 描かない');
  // 失敗系の対: 室内側の平行壁が無ければ描く
  const open = tFixture([par(800, 1250), PERP_1200]);
  assert.equal(structuralPrimitivesForCut(open.contribution, open.cutAt(1200), []).length, 12, '室内側が壁の外へ続くなら描く');
});

test('【T2・(B)】室内側の壁が梁の端から材厚（120）以内で終わるなら切れ端は残りと数えない。材厚を超えて短ければ描く', () => {
  const near = tFixture([par(800, 1250), par(1250, 1900), PERP_1200]);
  assert.deepEqual(structuralPrimitivesForCut(near.contribution, near.cutAt(1200), []), [],
    '端 1900..2000（< 材厚120）は隅の取り合いの許容で隠れる → 描かない');
  const far = tFixture([par(800, 1250), par(1250, 1700), PERP_1200]);
  assert.equal(structuralPrimitivesForCut(far.contribution, far.cutAt(1200), []).length, 12,
    '端 1700..2000（> 材厚120）は壁の外へ出ている → 描く');
});

test('【T3】切断位置の直交壁が梁の芯で終わる（スパンが梁の帯を覆わない L 字の隅）なら帯を除かず、埋まっている扱い', () => {
  const stopAtAxis = { ...PERP_1200, coord2: 1000 }; // y=1000（梁の芯）で終わる＝梁の帯 950..1050 を覆わない
  const { contribution, cutAt } = tFixture([par(800, 1250), stopAtAxis]);
  assert.deepEqual(structuralPrimitivesForCut(contribution, cutAt(1200), []), [],
    '直交壁の帯を除かない（保守側）→ 平行壁 800..1250 の内部 → 描かない');
  const full = tFixture([par(800, 1250), PERP_1200]);
  assert.equal(structuralPrimitivesForCut(full.contribution, full.cutAt(1200), []).length, 12, '対照: 帯を覆う直交壁なら描く');
});

test('【T4】直交壁の層も平行壁と同じ述語（梁の天が層の床−成〜直上の床）: 上階の層の直交壁で A2 型・天2900・成300 でも描く', () => {
  const fakeBeam = { role: 'primary', isVertical: false, axisValue: 1000, coord1: 0, coord2: 2000,
    sectionWidth: 100, sectionDefId: 'NO-SUCH', beamDepth: 300, levelOffset: 2900 };
  const layers = [
    { graph: { walls: [], beams: [fakeBeam] }, floorZMm: 0, role: 'self' },
    { graph: { walls: [par(800, 1250), PERP_1200], beams: [] }, floorZMm: 3000, role: 'above' },
  ];
  const contribution = structuralContribution(layers);
  assert.equal(contribution.length, 1);
  assert.equal(contribution[0].topZ, 2900);
  const cut = { seqNo: 'x', line: { isVertical: true, axisValue: 1200, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers, zRange: { loZ: 0, hiZ: 6000 }, baseFloorZ: 0 };
  assert.equal(structuralPrimitivesForCut(contribution, cut, []).length, 4,
    '上階FL直下の床梁は上階の直交壁の帯を除いて描く（矩形4辺）');
});

test('【失敗系・2026-10-22 階段帯型】structuralPrimitivesForCut: 切断位置が平行な壁の途中（内部）なら、梁が先で壁の外へ出ても描かない。端ちょうどは描く', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // x=0〜2000
  // 壁はx=800〜1200だけ。x=1200の端で切る（壁のスパンの端＝面の壁芯）と、その先(1200..2000)は壁の外へ続く。
  const wall = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: 800, coord2: 1200 };
  const layers = [{ graph: { walls: [wall], beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const contribution = structuralContribution(layers);
  const cut = (axisValue, viewSign) => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: 0, hi: 2000 },
    viewSign, dirSign: 1, layers, zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  assert.deepEqual(structuralPrimitivesForCut(contribution, cut(1000, 1), []), [],
    '階段帯の型: 平行な壁の途中(x=1000)で切るなら、先(1200..2000)が壁の外へ続いても壁に埋まっているので描かない');
  assert.equal(structuralPrimitivesForCut(contribution, cut(500, 1), []).length, 12,
    '壁の外(x=500)で切れば描く');
  assert.equal(structuralPrimitivesForCut(contribution, cut(1200, 1), []).length, 12,
    '壁の区間の端ちょうど(x=1200)は内部に含めない → 描く');
  assert.equal(structuralPrimitivesForCut(contribution, cut(1000, -1), []).length, 0,
    '反対向きでも、切断位置が壁の中なら描かない（埋没は切断位置の判定）');
  const inner = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: -100, coord2: 1200 };
  const layers2 = [{ graph: { walls: [inner], beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const cut2 = { ...cut(1000, -1), layers: layers2 };
  assert.deepEqual(structuralPrimitivesForCut(structuralContribution(layers2), cut2, []), [],
    '室内側(0..1000)が壁(-100..1200)に覆われて残りが無ければ描かない');
});

// ---- 自階の床（スラブ）の遮蔽（occludeByFloor。2026-10-23 ユーザー裁定: 展開面の姿も断面も・一般解） ----
// 配置: 水平梁 y=1000・x0..2000・STEEL-H200x100（成200）。天端 = levelOffset。
function floorFixture(levelOffset) {
  const graph = makeGraph();
  addHorizontalBeam(graph, levelOffset);
  const contribution = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  const section = { seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 };
  const airborne = { seqNo: 'y', line: { isVertical: false, axisValue: 500, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 };
  return { contribution, section, airborne };
}
const FLOOR = { floorZ: 0, floorlessRanges: [] };

test('【床の遮蔽】床がある列では、天端が FL 以下の梁は見え掛かり（空中）も断面も描かない。遮蔽なしなら描く（対照）', () => {
  const { contribution, section, airborne } = floorFixture(-100);
  assert.equal(structuralPrimitivesForCut(contribution, section, []).length, 12, '対照: 遮蔽なしの断面');
  assert.equal(structuralPrimitivesForCut(contribution, airborne, []).length, 2, '対照: 遮蔽なしの空中の見え掛かり（天地2本）');
  assert.deepEqual(structuralPrimitivesForCut(contribution, section, [], null, { floorOcclusion: FLOOR }), [], '断面');
  assert.deepEqual(structuralPrimitivesForCut(contribution, airborne, [], null, { floorOcclusion: FLOOR }), [], '見え掛かり');
});

test('【床の遮蔽】床が無い列（階段の穴）では描く。区間の外の部分だけ消える', () => {
  const { contribution, section, airborne } = floorFixture(-100);
  const hole = { floorZ: 0, floorlessRanges: [{ lo: 900, hi: 1100 }] }; // 断面（x950..1050）は穴の中
  assert.equal(structuralPrimitivesForCut(contribution, section, [], null, { floorOcclusion: hole }).length, 12, '穴の中の断面は残る');
  const half = structuralPrimitivesForCut(contribution, airborne, [], null, { floorOcclusion: { floorZ: 0, floorlessRanges: [{ lo: 0, hi: 1000 }] } });
  assert.equal(half.length, 2, '見え掛かりは穴の範囲(0..1000)だけ残る');
  for (const p of half) assert.ok(Math.max(p.x1, p.x2) <= 1000 + 1e-6, '穴の外へはみ出さない');
});

test('【床の遮蔽・A\'-1】天端が FL ちょうどの鉄骨梁も隠れる。FL をまたぐ梁は FL より上だけ残る', () => {
  const flush = floorFixture(0);
  assert.deepEqual(structuralPrimitivesForCut(flush.contribution, flush.section, [], null, { floorOcclusion: FLOOR }), [], '天端＝FL の断面');
  assert.deepEqual(structuralPrimitivesForCut(flush.contribution, flush.airborne, [], null, { floorOcclusion: FLOOR }), [], '天端＝FL の見え掛かり');
  const across = floorFixture(100); // 天端 100・下端 -100（FL をまたぐ）
  const prims = structuralPrimitivesForCut(across.contribution, across.section, [], null, { floorOcclusion: FLOOR });
  assert.ok(prims.length > 0, 'FL より上の部分は残る');
  for (const p of prims) assert.ok(-p.y1 >= -1e-6 && -p.y2 >= -1e-6, `FL より下の線が残っている: ${JSON.stringify(p)}`);
  assert.ok(prims.some(p => Math.abs(p.y1 + 100) < 1e-6 && Math.abs(p.y2 + 100) < 1e-6), '天端の水平線(z=100)は残る');
  const above = floorFixture(500);
  assert.equal(structuralPrimitivesForCut(above.contribution, above.section, [], null, { floorOcclusion: FLOOR }).length, 12, '全体が FL より上なら不変');
});

// ---- 穴の縁をまたぐ断面は輪郭 1 つの単位で判定する（ユーザー裁定 2026-10-23: 階段側の壁が覆わなければ丸ごと描く） ----
// 配置: 水平梁 y=1000（H形 幅100・成200・天端 -100＝FL より下）。切断は x=1000 の縦線で断面は面ローカル x 950..1050（中心 1000）。
// 穴は x>=1000（境界が梁の芯）。梁と平行な壁（y=1000 に沿う水平壁）の階段側（+x）の面までの距離 ≦ 半幅 50 なら覆っていない。
function edgeFixture({ wall = null, extraWalls = [] } = {}) {
  const graph = makeGraph();
  addHorizontalBeam(graph, -100);
  const layers = [{ graph: { walls: wall ? [wall, ...extraWalls] : [], beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const contribution = structuralContribution(layers);
  const cut = { seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers, zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 };
  const run = (ranges, wallLineCuts = undefined) => structuralPrimitivesForCut(contribution, cut, [], null,
    { floorOcclusion: { floorZ: 0, floorlessRanges: ranges }, wallLineCuts });
  return { run };
}
const horizWall = (lo, hi) => ({ isVertical: false, materialRange: { lo, hi }, coord1: -100, coord2: 2100 });

test('【穴の縁・Major-1】穴の縁が梁の芯を通り階段側の壁が覆わなければ、断面は 12 辺とも丸ごと描く（開いた半分を残さない）。壁が無くても同じ', () => {
  const noWall = edgeFixture();
  const rects = [];
  assert.equal(noWall.run([{ lo: 1000, hi: 2000 }], rects).length, 12, '壁が無ければ覆っていない → 丸ごと描く');
  assert.deepEqual(rects, [], '壁内の梁ではない（切断位置に平行な壁が無い）ので壁の線は分けない');
  const open = edgeFixture({ wall: horizWall(960, 1040) }); // 階段側の面までの距離 40 < 半幅 50 → 断面が壁の面からはみ出す
  const cuts = [];
  assert.equal(open.run([{ lo: 1000, hi: 2000 }], cuts).length, 12, '壁がより薄ければ覆っていない → 丸ごと描く');
  assert.deepEqual(cuts, [{ xLo: 950, xHi: 1050, zLo: -300, zHi: -100, xs: [960, 1040] }],
    '壁内の梁が壁の面から出ている → その壁の面（x960・1040）の線を梁の z 範囲（-300..-100）で分ける矩形を報告する');
  const reverse = edgeFixture({ wall: horizWall(960, 1040) }); // 穴が反対側（-x）: 境界 1000 の -x 側
  assert.equal(reverse.run([{ lo: 0, hi: 1000 }]).length, 12, '穴が -x 側でも同じ');
});

test('【穴の縁・Major-1】同じ配置で階段側の壁が断面を覆うなら 12 辺とも描かない。等号（距離＝半幅）は描く', () => {
  // 壁は梁の帯 950..1050 を完全には隠さない非対称（-x 側 960）にする——完全に隠す壁は (A) の埋没判定が先に断面を落とす
  const covered = edgeFixture({ wall: horizWall(960, 1060) }); // 階段側(+x)の面までの距離 60 > 半幅 50 → 壁の中
  const rects = [];
  assert.deepEqual(covered.run([{ lo: 1000, hi: 2000 }], rects), [], '壁が覆う → 描かない（半分も残さない）');
  assert.deepEqual(rects, [], '描かないので矩形は報告しない');
  const equal = edgeFixture({ wall: horizWall(960, 1050) }); // 距離 50 = 半幅 50
  assert.equal(equal.run([{ lo: 1000, hi: 2000 }]).length, 12, '等号は覆っていない → 描く');
  const other = edgeFixture({ wall: { ...horizWall(960, 1060), coord1: 1200, coord2: 2100 } }); // 壁のスパンが切断位置を含まない
  assert.equal(other.run([{ lo: 1000, hi: 2000 }]).length, 12, '切断位置に壁が無ければ覆っていない');
  const minus = edgeFixture({ wall: horizWall(940, 1040) }); // 穴が -x 側なら階段側は -x。-x 側の面までの距離 60 > 50 → 覆う
  assert.deepEqual(minus.run([{ lo: 0, hi: 1000 }]), [], '穴が -x 側なら -x 側の面で判定する（覆う）');
});

test('【M3】同じ軸 CL 上の下地オーナー壁＋階段側の仕上げ薄壁は材を合併して判定する（半幅が下地の面と仕上げ面の間なら覆う）', () => {
  const cl = { id: 'cl-1' };
  const owner = { ...horizWall(960, 1030), axisCL: cl }; // 下地の面までの距離 30 < 半幅 50
  const finish = { ...horizWall(1030, 1060), axisCL: cl }; // 仕上げ薄壁（階段側）。仕上げ面までの距離 60 > 半幅 50
  const merged = edgeFixture({ wall: owner, extraWalls: [finish] });
  assert.deepEqual(merged.run([{ lo: 1000, hi: 2000 }]), [], '合併した帯の階段側の面（1060）で判定 → 覆う → 描かない');
  const alone = edgeFixture({ wall: owner });
  assert.equal(alone.run([{ lo: 1000, hi: 2000 }]).length, 12, '対照: 仕上げ薄壁が無ければ下地の面（1030）で判定 → 覆っていない → 描く');
  const otherCl = edgeFixture({ wall: owner, extraWalls: [{ ...finish, axisCL: { id: 'cl-2' } }] });
  assert.equal(otherCl.run([{ lo: 1000, hi: 2000 }]).length, 12, '別の軸 CL の壁とは合併しない');
});

// 外壁の対称壁: materialRange は軸〜外面の片側だけ、下地帯（backingRange）が両側。隠せる材（wallConcealRange）は両者の合併 [940,1072.5]
const symmetricWall = { isVertical: false, materialRange: { lo: 1000, hi: 1072.5 }, backingRange: { lo: 940, hi: 1060 },
  coord1: -100, coord2: 2100, axisCL: { id: 'ext' } };
const fakeBeamAt = (axisValue, sectionWidth) => ({ role: 'primary', isVertical: false, axisValue, coord1: 0, coord2: 2000,
  sectionWidth, sectionDefId: 'NO-SUCH', beamDepth: 200, levelOffset: -100 });
function fakeCut(beam, walls) {
  const layers = [{ graph: { walls, beams: [beam] }, floorZMm: 0, role: 'self' }];
  return { layers, contribution: structuralContribution(layers),
    cut: { seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 }, viewSign: 1, dirSign: 1, layers,
      zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 } };
}

test('【所見3】階段側の壁の判定は wallConcealRange（外壁の対称壁の下地帯を含む）。materialRange だけだと壁を見落として描いてしまう', () => {
  // 梁（芯 955・幅 60 → 925..985）は壁の隠せる材 [940,1072.5] に完全には収まらない（(A) で落ちない）。芯は材（1000..）の外・隠せる材の中。
  const { cut, contribution } = fakeCut(fakeBeamAt(955, 60), [symmetricWall]);
  assert.equal(contribution.length, 1);
  const run = (ranges) => structuralPrimitivesForCut(contribution, cut, [], null, { floorOcclusion: { floorZ: 0, floorlessRanges: ranges } });
  assert.deepEqual(run([{ lo: 955, hi: 2000 }]), [],
    '穴は +x 側。階段側の面は隠せる材の外面 1072.5（距離 117.5 > 半幅 30）→ 覆う → 描かない');
  assert.equal(run([{ lo: 0, hi: 955 }]).length, 4, '穴が -x 側なら階段側の面は 940（距離 15 ≦ 30）→ 覆っていない → 丸ごと描く（矩形 4 辺）');
});

test('【所見4】壁の線の分断の面には、壁の材の面だけでなく隠せる材（下地）の面も含める', () => {
  // 梁（芯 960・幅 100 → 910..1010）の断面の内側に入るのは、材の面 1000 と下地の面 940（隠せる材の下端）。1072.5 は外
  const { cut, contribution } = fakeCut(fakeBeamAt(960, 100), [symmetricWall]);
  const cuts = [];
  structuralPrimitivesForCut(contribution, cut, [], null, { wallLineCuts: cuts });
  assert.equal(cuts.length, 1);
  assert.deepEqual([...cuts[0].xs].sort((a, b) => a - b), [940, 1000], '下地の面 940 と材の面 1000 の両方');
});

test('【壁の線の分断】壁内の梁が壁の面から出ているときだけ矩形を報告する（穴の縁に限らない）。壁が覆う・壁の無い梁・描かない断面は報告しない', () => {
  const run = (wall, levelOffset = 500) => {
    const graph = makeGraph();
    addHorizontalBeam(graph, levelOffset);
    const layers = [{ graph: { walls: wall ? [wall] : [], beams: graph.beams }, floorZMm: 0, role: 'self' }];
    const cut = { seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
      viewSign: 1, dirSign: 1, layers, zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 };
    const cuts = [];
    const prims = structuralPrimitivesForCut(structuralContribution(layers), cut, [], null, { wallLineCuts: cuts });
    return { prims, cuts };
  };
  const poke = run(horizWall(960, 1040)); // 梁（950..1050）が壁の面（960・1040）から出ている
  assert.equal(poke.prims.length, 12);
  assert.deepEqual(poke.cuts, [{ xLo: 950, xHi: 1050, zLo: 300, zHi: 500, xs: [960, 1040] }], '穴の縁でなくても、壁内の梁が面から出ていれば壁の線を分ける');
  assert.deepEqual(run(null).cuts, [], '壁の無い梁（壁内の梁ではない）は分けない');
  const covered = run(horizWall(940, 1060)); // 壁が梁を完全に覆う → 断面は描かれない
  assert.deepEqual(covered.prims, []);
  assert.deepEqual(covered.cuts, [], '描かない断面は報告しない');
  assert.deepEqual(run(horizWall(960, 1060)).cuts, [{ xLo: 950, xHi: 1050, zLo: 300, zHi: 500, xs: [960] }],
    '壁の面が梁の端の内側に入る側（960）だけ。端の外（1060）の面は対象外');
  assert.deepEqual(run({ ...horizWall(960, 1040), coord1: 1200, coord2: 2100 }).cuts, [], '切断位置に壁が無ければ分けない');
});

test('【穴の縁・Major-1】外面が穴の縁ちょうどの矩形（梁以外の型でも）: 穴の側なら丸ごと描き、床の側なら丸ごと描かない', () => {
  const graph = makeGraph();
  const fake = { role: 'primary', isVertical: false, axisValue: 1000, coord1: 0, coord2: 2000,
    sectionWidth: 100, sectionDefId: 'NO-SUCH', beamDepth: 200, levelOffset: -100 };
  const layers = [{ graph: { walls: [], beams: [fake] }, floorZMm: 0, role: 'self' }];
  void graph;
  const contribution = structuralContribution(layers);
  const cut = { seqNo: 'x', line: { isVertical: true, axisValue: 1000, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers, zRange: { loZ: -3000, hiZ: 3000 }, baseFloorZ: -3000 };
  const run = (ranges) => structuralPrimitivesForCut(contribution, cut, [], null, { floorOcclusion: { floorZ: 0, floorlessRanges: ranges } });
  assert.equal(run([{ lo: 1050, hi: 2000 }]).length, 0, '外面 1050 が穴の縁で、断面は床の側 → 描かない');
  assert.equal(run([{ lo: 0, hi: 950 }]).length, 0, '外面 950 が穴の縁で、断面は床の側 → 描かない');
  assert.equal(run([{ lo: 950, hi: 2000 }]).length, 4, '外面 950 が穴の縁で、断面は穴の側 → 丸ごと描く（矩形 4 辺）');
  assert.equal(run([{ lo: 0, hi: 1050 }]).length, 4, '外面 1050 が穴の縁で、断面は穴の側 → 丸ごと描く');
});

test('【Minor】occludeByFloor: 切っても変わらない線は分けない。分けた後に隣り合う同じ線の片はつなぎ直す', () => {
  const holes = [{ lo: 100, hi: 200 }, { lo: 200, hi: 300 }];
  const above = { type: 'line', weight: 'thin', dash: 'dashed', x1: 0, y1: -300, x2: 500, y2: -300 }; // FL より上
  const outA = occludeByFloor([above], { floorZ: 0, floorlessRanges: holes });
  assert.equal(outA.length, 1);
  assert.equal(outA[0], above, '切っても変わらない線は同じ線のまま（床なし区間の境界で分けない）');
  const below = { type: 'line', weight: 'thin', dash: 'dashed', x1: 0, y1: 100, x2: 500, y2: 100 }; // FL より下
  const outB = occludeByFloor([below], { floorZ: 0, floorlessRanges: holes });
  assert.equal(outB.length, 1, '穴 100..200 と 200..300 の片は 1 本につなぐ');
  assert.deepEqual([outB[0].x1, outB[0].x2], [100, 300]);
  assert.equal(outB[0].dash, 'dashed');
});

test('【Major-3】部屋帯の clipBeamsToBand が topZ/depthMm を帯へ切り詰めても、直交壁の層は元の天端・成で判定する（layerTopZ/layerDepthMm）', () => {
  // 上階の下がり梁（天端 2900・成 600）を帯 0..2400 へ切り詰めた形（topZ 2400・成 100）。直交壁は上階の層にだけある。
  const upperWalls = [
    { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: -3000, coord2: 60 }, // 梁と平行・切断位置を越えて 60 まで
    { isVertical: true, materialRange: { lo: -50, hi: 50 }, coord1: 900, coord2: 1100 }, // 直交壁（切断位置 0 を含む帯 -50..50）
  ];
  // 例: (a) 天端 2900・成 600（levelOffset 0）、(b) 天端 2700・成 400（levelOffset −200）。どちらも帯 0..2400 へ切り詰めると上階の層（床 2900）の
  // 述語から外れる（(b) は切り詰めた天端 2400 < 床−元の成 2500 なので、layerTopZ だけが無くても外れる）。
  for (const { levelOffset, beamDepth, top } of [{ levelOffset: 0, beamDepth: 600, top: 2900 }, { levelOffset: -200, beamDepth: 400, top: 2700 }]) {
    const fakeBeam = { role: 'primary', isVertical: false, axisValue: 1000, coord1: -3000, coord2: 3000,
      sectionWidth: 100, sectionDefId: 'NO-SUCH', beamDepth, levelOffset };
    // 層の床は自階 0・上階 2900 にして、壁と梁は上階（2900〜）にだけ置く
    const layers2 = [
      { graph: { walls: [], beams: [] }, floorZMm: 0, role: 'self' },
      { graph: { walls: upperWalls, beams: [fakeBeam] }, floorZMm: 2900, role: 'above' },
    ];
    const [full] = structuralContribution(layers2).filter(b => b.role === 'primary');
    assert.equal(full.topZ, top, '前提: 元の天端');
    const clipped = { ...full, topZ: 2400, depthMm: 100 }; // clipBeamsToBand と同じ切り詰め（layerTopZ/layerDepthMm は残る）
    const cut = { seqNo: 'x', line: { isVertical: true, axisValue: 0, lo: 900, hi: 1100 },
      viewSign: 1, dirSign: 1, layers: layers2, zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0 };
    assert.ok(structuralPrimitivesForCut([clipped], cut, [], null, {}).length > 0,
      `天端 ${full.topZ}・成 ${beamDepth}: 直交壁（上階の層）の帯を除くので、平行壁が帯の中で尽きる A2 型の断面は描かれる`);
    const noTop = structuralPrimitivesForCut([{ ...clipped, layerTopZ: undefined }], cut, [], null, {});
    const noBoth = structuralPrimitivesForCut([{ ...clipped, layerTopZ: undefined, layerDepthMm: undefined }], cut, [], null, {});
    assert.equal(noBoth.length, 0, '対照: 元の値が無ければ切り詰めた値で層を判定して直交壁を落とし、埋まっている扱いで描かれない');
    if (levelOffset === -200) assert.equal(noTop.length, 0, 'layerTopZ だけが無くても（切り詰めた天端 2400 < 2900−400）外れる');
  }
});

test('【床の遮蔽・一般解】occludeByFloor は部材の種類によらず線分の z と x だけで切る（梁以外のダミー・斜めの線・線以外の型）', () => {
  const dummy = [
    { type: 'line', weight: 'thick', x1: 0, y1: 100, x2: 500, y2: 100, tag: 'dummy-member' }, // z=-100 の水平線 → 消える
    { type: 'line', weight: 'thick', x1: 0, y1: -300, x2: 500, y2: -300 }, // z=300 → 残る
    { type: 'line', weight: 'thin', x1: 100, y1: 200, x2: 100, y2: -300 }, // 縦線 z -200..300 → FL まで
    { type: 'line', weight: 'thin', x1: 0, y1: 200, x2: 400, y2: -200 }, // 斜め z -200..200 → 中点(x200)から上
    { type: 'rect', x: 0, y: 0, w: 10, h: 10 }, // 線以外はそのまま
  ];
  const out = occludeByFloor(dummy, FLOOR);
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], dummy[1]);
  assert.ok(Math.abs(out[1].y1) < 1e-6 && out[1].y2 === -300, '縦線は FL(y=0)〜300 に切られる');
  assert.ok(Math.abs(out[2].x1 - 200) < 1e-6 && Math.abs(out[2].y1) < 1e-6 && out[2].x2 === 400 && out[2].y2 === -200, '斜め線は FL との交点から上');
  assert.deepEqual(out[3], dummy[4]);
  // 失敗系: floorZ が数でなければ何も隠さない
  assert.equal(occludeByFloor(dummy, { floorZ: NaN }), dummy);
});

test('【2026-10-22 A2型】structuralPrimitivesForCut: 切断位置が直交する壁の帯の中で、平行な壁がその帯の中で尽きるなら断面を描く（CL・pcut とも）。層が違う直交壁は除かない', () => {
  const graph = makeGraph();
  addHorizontalBeam(graph, 500); // x=0〜2000・y=1000・幅100
  // 平行な壁は x=800..1250（直交壁の帯の中で尽きる）。直交壁は x=1200 の面の壁（帯 1140..1260・梁の帯を覆う）
  const parallel = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: 800, coord2: 1250 };
  const perp = { isVertical: true, materialRange: { lo: 1140, hi: 1260 }, coord1: -100, coord2: 2100 };
  const layers = [{ graph: { walls: [parallel, perp], beams: graph.beams }, floorZMm: 0, role: 'self' }];
  const contribution = structuralContribution(layers);
  assert.equal(contribution.length, 1, '前提: 壁は梁の全スパンを覆わない');
  const cutAt = (axisValue, lyrs = layers) => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: 0, hi: 2000 },
    viewSign: 1, dirSign: 1, layers: lyrs, zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  assert.equal(structuralPrimitivesForCut(contribution, cutAt(1200), []).length, 12, 'CL(x=1200)で切る: 直交壁の帯を除くと平行壁は 800..1140 → 内部でない → 描く');
  assert.equal(structuralPrimitivesForCut(contribution, cutAt(1257), []).length, 12, 'pcut 相当(x=1257・帯の内側の面)でも描く');
  // 失敗系: 直交壁が別の層（上階）なら除かれず、平行壁(800..1250)の内部(1200)として埋まる
  const upper = [
    { graph: { walls: [parallel], beams: graph.beams }, floorZMm: 0, role: 'self' },
    { graph: { walls: [perp], beams: [] }, floorZMm: 3000, role: 'above' },
  ];
  assert.deepEqual(structuralPrimitivesForCut(structuralContribution(upper), cutAt(1200, upper), []), [],
    '直交壁の層が違えば帯を除かない → 平行壁の内部 → 描かない');
});

test('【上階の壁・2026-10-22 梁B型】structuralContribution: 上階（別の層）の壁は、下の層の高さの途中にある梁を隠さない。床梁は上下どちらの階の壁にも埋まる', () => {
  const selfG = makeGraph('p1'); // 梁: 自階 topZ=1800（階の高さの途中）・x=0〜2000
  addHorizontalBeam(selfG, 1800, 'primary');
  // 上階の壁が梁と同じ通り・全スパンを覆う
  const upperWall = { isVertical: false, materialRange: { lo: 940, hi: 1060 }, coord1: -100, coord2: 2100 };
  const layersOf = (beams) => [
    { graph: { walls: [], beams }, floorZMm: 0, role: 'self' },
    { graph: { walls: [upperWall], beams: [] }, floorZMm: 3000, role: 'above' },
  ];
  assert.equal(structuralContribution(layersOf(selfG.beams)).length, 1,
    '3階の壁(floor 3000〜)は topZ=1800・成200 の梁(1600..1800)に届かないので隠さない');
  // 床梁（天端＝上階FL付近 2900）は上階の壁に埋まる
  const floorG = makeGraph('p3');
  addHorizontalBeam(floorG, 2900, 'primary');
  assert.equal(structuralContribution(layersOf(floorG.beams)).length, 0,
    '天端が上階FLの直下(2900・成200)の床梁は、上階の壁に従来どおり埋まる');
  // 失敗系: 同じ上階の壁でも、壁の通りから外れた梁は隠れない
  const offG = makeGraph('p4');
  const offAxis = offG.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = offG.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = offG.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  offG.addBeam(StructuralMaterialType.STEEL, 'STEEL-H200x100', offAxis, false, x0, x1, { role: 'primary', levelOffset: 2900 });
  assert.equal(structuralContribution(layersOf(offG.beams)).length, 1, '壁の通りから外れた床梁は隠れない');
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
  // 全スパン基準では落ちない（梁が壁より長い）構成にして、切断位置から室内側の判定だけを通す。
  const longGirder = { ...girderOnAxis(), coord1: -5000, coord2: 3640 };
  const layersOf = (walls) => [{ graph: { walls, beams: [longGirder] }, floorZMm: 0, role: 'self' }];
  const contribution = structuralContribution(layersOf([]));
  assert.equal(contribution.length, 1, '前提: 壁の無い層では寄与する');
  const cutAt = (walls, axisValue) => ({
    seqNo: 'x', line: { isVertical: true, axisValue, lo: -6000, hi: 6000 },
    viewSign: 1, dirSign: 1, layers: layersOf(walls),
    zRange: { loZ: -500, hiZ: 3000 }, baseFloorZ: 0,
  });
  const withWall = structuralContribution(layersOf([exteriorWallFake]));
  assert.equal(withWall.length, 1, '前提: 全スパン基準では落ちない（梁が壁より長い）');
  assert.deepEqual(structuralPrimitivesForCut(withWall, cutAt([exteriorWallFake], 1820), []), [],
    '外壁が覆う位置から室内側(1820..3640)が外壁の中に納まるなら断面は描かないはず');
  assert.equal(structuralPrimitivesForCut(withWall, cutAt([exteriorWallFake], -3000), []).length, 4,
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
