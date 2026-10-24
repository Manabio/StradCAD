// 2.5D立体の加算レイヤ（構造柱の柱型・上階梁の梁型）と、通り芯丸ナンバーの範囲修正の回帰テスト。
// 実Plane/PlanGraph+実finish/wallGeneration.jsを使う（elevationFaces.test.js/elevationBand.test.jsと
// 同じ方針）——face.lo/hi（仕上げ面へ詰めた端）と壁中心線のズレ・構造材のCL基準スパンはどちらも
// フェイクfaceでは再現できないため。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { collectGridCLs } from './elevationPrimitives.js';
import {
  solidPrimitivesForFace, faceSectionCut, beamBlockerRectsForFace, droppedMemberPrimitivesForFace, memberLayersOf,
} from './elevationSolids.js';
import { buildRoomBand } from './elevationBand.js';
import { cutPlaneOffsetMm } from './section/sectionCutPlane.js';
import { buildRoomBandWithVoidAbove } from './elevationVoid.js';
import {
  structuralContribution, structuralColumnContribution, structuralColumnPrimitivesForCut, memberKey,
} from './section/sectionStructure.js';

const CH = 2400;

// 通り芯（labeled STRUCT CL）で囲った矩形部屋。X1/X2=0/4000・Y1/Y2=0/3000。
function makeGridRoom(name = 'いま') {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  const addGrid = (type, value, label) =>
    graph.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT, label });
  const x0 = addGrid(CenterLineType.VERTICAL, 0, 'X1');
  const x1 = addGrid(CenterLineType.VERTICAL, 4000, 'X2');
  const y0 = addGrid(CenterLineType.HORIZONTAL, 0, 'Y1');
  const y1 = addGrid(CenterLineType.HORIZONTAL, 3000, 'Y2');
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return { graph, room, x0, x1, y0, y1 };
}

function faceCtx(graph, room, extra = {}) {
  return {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: CH,
    materialMap: null, gridCLs: collectGridCLs(graph), ...extra,
  };
}

// ---- 不良修正: 通り芯の丸ナンバーが描画されない場合がある ----
test('【不良修正】buildFaceFigure: 面端（壁中心線上）の通り芯も丸ナンバー・寸法が描かれる', () => {
  const { graph, room } = makeGridRoom();
  const faces = buildRoomFaces(room, graph);
  const faceA = faces.find(f => f.label === 'A');
  // 前提: face.lo/hiは直交壁の仕上げ面へ詰められており、通り芯(0/4000)はその外側にある
  // ——旧実装のface.lo..hi基準では両端の通り芯が常に除外され、丸が1つも描かれなかった。
  assert.ok(faceA.lo > 0 && faceA.hi < 4000, '前提: face.lo/hiは通り芯より内側のはず');

  const prims = buildFaceFigure(faceA, faceCtx(graph, room));
  const circles = prims.filter(p => p.type === 'circle');
  assert.equal(circles.length, 2, '両端の通り芯2本ぶんの丸が描かれるはず');
  const labels = prims.filter(p => p.type === 'text').map(p => p.text);
  assert.ok(labels.includes('X1') && labels.includes('X2'), '通り芯ラベルX1/X2が描かれるはず');
  // ユーザー明示指示2026-08「寸法2段書きは不要」: 寸法行は1本だけ（旧ROW2は廃止し、通り芯は
  // 鎖の分割点として統合）。この面は両端が通り芯そのものなので鎖は1区間=4000になる。
  const dims = prims.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.equal(dims.length, 1, `水平寸法は1本だけのはず（実際:${dims.length}本）`);
  assert.equal(dims[0].label, 4000);
  assert.ok(dims[0].at < circles[0].cy, '寸法行は通り芯丸の段より上のはず');
});

test('【不良修正】gridWorldRange相当: 面の範囲外の通り芯は従来どおり描かれない', () => {
  const { graph, room } = makeGridRoom();
  // 面の外（x=9000）の通り芯を追加しても拾われないこと（範囲を広げすぎていない確認）。
  graph.addCenterLine(CenterLineType.VERTICAL, 9000,
    { labeled: true, discipline: Discipline.STRUCT, label: 'X9' });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const labels = buildFaceFigure(faceA, faceCtx(graph, room))
    .filter(p => p.type === 'text').map(p => p.text);
  assert.ok(!labels.includes('X9'), '面の範囲外の通り芯は描かれてはいけない');
});

// ---- 追加仕様: 基礎・基礎梁は描かない ----
test('【追加仕様】structuralContribution: 基礎梁(role:foundation)は寄与から除外される', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  graph.addBeam(StructuralMaterialType.RC, 'RC-300x300', y0, false, x0, x1,
    { role: 'foundation', levelOffset: 0 });
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y0, false, x0, x1,
    { role: 'primary', levelOffset: 0 });
  const solids = structuralContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(solids.length, 1, '基礎梁は除外され、通常梁1本だけが残るはず');
  assert.equal(solids[0].role, 'primary');
});

test('【追加仕様】structuralColumnContribution: 杭(role:foundation)は寄与から除外される', () => {
  const { graph, x0, y0 } = makeGridRoom();
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', x0, y0, { role: 'foundation' });
  const solids = structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(solids.length, 0, '杭は柱型として描かれてはいけない');
});

// ---- 追加仕様: 柱型（その面の壁に接続した柱の、見付け幅の両端縦線・中線） ----
// 追加仕様2026-08「柱を仕上げ材で覆い展開図に反映」により、柱の見付け幅は「下地材＋壁仕上げ材」
// ぶん左右に広がる（既定の壁: 下地90＋仕上げ12.5＝片側102.5mm）。
const COVER_MM = 90 + 12.5;

test('【追加仕様】solidPrimitivesForFace: A面の壁上に立つ柱は仕上げで覆った見付け幅の両端縦線（中線）で描かれる', () => {
  const { graph, room, x1, y0 } = makeGridRoom();
  // A面（y=0の壁）の途中、x=2000に300角のRC柱。
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  void x1;
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const prims = solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH });
  // ユーザー指示2026-08「展開図の柱型は中線」。
  const verticals = prims.filter(p => p.type === 'line' && p.x1 === p.x2 && p.weight === 'medium');
  assert.equal(verticals.length, 2, '柱型の両端縦線2本が中線で描かれるはず');
  assert.equal(prims.filter(p => p.weight === 'thick').length, 0, '柱型に太線を使ってはいけない');
  const xs = verticals.map(p => p.x1).sort((a, b) => a - b);
  assert.equal(Math.round(xs[1] - xs[0]), 300 + 2 * COVER_MM,
    '見付け幅は断面幅300mm＋左右の仕上げ包み（下地90＋仕上げ12.5）のはず');
  for (const v of verticals) {
    assert.equal(Math.min(v.y1, v.y2), -CH, '柱型は天井まで届くはず');
    assert.equal(Math.max(v.y1, v.y2), 0, '柱型は床から立つはず');
  }
});

test('【B3-3・加算停止】solidPrimitivesForFace: memberCutsByBand（帯を持つ呼び出し）では帯が持つ柱を描かない。dropped の柱は droppedMemberPrimitivesForFace が描く', () => {
  const { graph, room, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const base = { graph, ceilingHeight: CH };
  const verts = ps => ps.filter(p => p.type === 'line' && p.x1 === p.x2 && p.weight === 'medium');
  assert.equal(verts(solidPrimitivesForFace(faceA, base)).length, 2, '省略は従来どおり柱を描く');
  assert.equal(verts(solidPrimitivesForFace(faceA, { ...base, memberCutsByBand: true })).length, 0, '帯が持つ柱は加算で描かない');
  const key = memberKey(structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }])[0]);
  assert.equal(verts(droppedMemberPrimitivesForFace(faceA, base, new Set([key]))).length, 2, 'dropped の柱は加算で描く');
  assert.equal(verts(droppedMemberPrimitivesForFace(faceA, base, new Set(['別のキー']))).length, 0, '別のキーの柱は描かない');
});

test('【追加仕様】structuralColumnContribution: 鉄骨角形鋼管柱はダイヤフラム出も含めて覆われる', () => {
  const { graph, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // □-200×200×9.0（板厚9<28 → ダイヤフラム出e=25。構造モードの平面描画・断面図と同一実装）。
  graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-SQ200x200x9.0', xm, y0, {});
  const solids = structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(solids.length, 1);
  assert.equal(Math.round(solids[0].xHi - solids[0].xLo), 200 + 2 * 25 + 2 * COVER_MM,
    '見付け幅は断面200＋ダイヤフラム出25×2＋仕上げ包み102.5×2のはず');
  assert.equal(solids[0].covers.xLo, COVER_MM, '見付け方向の包み厚が面ごとに記録されるはず');
  assert.equal(solids[0].covers.xHi, COVER_MM);
});

// ---- 実機フィードバック2026-08「平面で柱芯を動かすと展開に表れない」 ----
// 切断線＝面の壁芯CL。柱芯オフセット（ラーメン系では常態）で柱の外面が壁芯を越えると、
// 断面基準のstraddle判定では柱型が丸ごと消えていた（覆い厚は計算済みなのに描画側で捨てられる）。
test('【実機修正】solidPrimitivesForFace: 柱芯が室内側へずれ壁芯をまたがなくなっても、壁と干渉していれば柱型を描く', () => {
  const { graph, room, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // A面の壁（材厚 y=0..57.5）に掛かるが、柱の外面(y=1)は壁芯(y=0)を越えている位置。
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, { eccentricity: { x: 0, y: 151 } });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const verticals = solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH })
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.weight === 'medium');
  assert.equal(verticals.length, 2, '壁と干渉する柱は壁芯をまたがなくても柱型として描かれるはず');
  const xs = verticals.map(p => p.x1).sort((a, b) => a - b);
  assert.equal(Math.round(xs[1] - xs[0]), 300 + 2 * COVER_MM, '見付け幅は覆い込み後のはず');
});

// 実機 moku1-3（在来木造）2026-10-07「外壁の中にある柱が描画される」: 外壁は backingDepth を明示しない
// 対称壁で materialRange が軸〜外面の片側 [0,72.5] だけのため、通り芯中心の120角柱がどの壁にも
// 「収まらず」出隅・入隅で柱型が出ていた。下地帯 [-60,60] を含めた材で判定すれば壁の中＝描かない。
test('【実機修正2026-10】structuralColumnContribution: 外壁の下地帯に収まる通り芯上の柱は柱型にしない', () => {
  const exterior = {
    isVertical: false, materialRange: { lo: 0, hi: 72.5 }, backingRange: { lo: -60, hi: 60 },
    coord1: -72.5, coord2: 14632.5, wallFinish: 12.5, axisCL: { effectiveValue: 0 },
  };
  const corner = { role: 'standard', sectionDefId: 'WOOD-120x120', x: 0, y: 0, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [exterior], columns: [corner] }, floorZMm: 0, role: 'self' },
  ]);
  assert.equal(solids.length, 0, '外壁の材に収まる120角柱は寄与しないはず');
});

// 「壁の中か」はその柱が立つ階の壁だけで判定する（平面 columnWrapSolids の hidden と同じ入力）。
// 全層の壁で判定すると、1階に壁の無い大部屋に立つ独立柱が真上の2階間仕切り壁に「収まって」消える。
test('【失敗系】structuralColumnContribution: 上階の壁は下階の柱を隠さない（判定は柱の階の壁だけ）', () => {
  const upperWall = {
    isVertical: false, materialRange: { lo: -60, hi: 72.5 }, backingRange: { lo: -60, hi: 60 },
    coord1: -4000, coord2: 4000, wallFinish: 12.5, axisCL: { effectiveValue: 0 },
  };
  const column = { role: 'standard', sectionDefId: 'WOOD-120x120', x: 0, y: 0, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [], columns: [column] }, floorZMm: 0, role: 'self' },
    { graph: { walls: [upperWall], columns: [] }, floorZMm: 2800, role: 'above' },
  ]);
  assert.equal(solids.length, 1, '1階に壁が無い独立柱は2階の壁があっても柱型として残るはず');
  assert.equal(solids[0].baseZ, 0);
});

// 実機ログ（2階・□-200×200×9.0）の再現: 仕上げ薄壁は材厚が壁芯から45mm室内側にあるため、
// 「柱の断面が壁芯をまたぐか」では壁を貫いて室内へ出ている柱まで落ちていた。
// 面の壁芯 -7000 / 干渉壁の材厚 [-6955,-6942.5] / 柱の外面 -6975 という実データの関係を固定する。
test('【実機修正】structuralColumnPrimitivesForCut: 材厚が壁芯から離れた薄壁でも、その壁に干渉する柱は面に出る', () => {
  const wall = {
    isVertical: false, materialRange: { lo: -6955, hi: -6942.5 }, coord1: -7942, coord2: -3057,
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -7000 },
  };
  const column = { role: 'primary', sectionDefId: 'STEEL-SQ200x200x9.0', x: -7850, y: -6850, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  assert.equal(solids.length, 1);
  assert.ok(solids[0].yLo < -6955 && solids[0].yHi > -6942.5, '前提: 柱は壁の材厚を貫いて室内へ出ている');
  assert.ok(solids[0].yLo > -7000, '前提: 柱の外面は壁芯(-7000)まで届いていない');

  const cut = {
    seqNo: 'a', line: { isVertical: false, axisValue: -7000, lo: -7942, hi: -3057 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  const prims = structuralColumnPrimitivesForCut(solids, cut);
  assert.equal(prims.length, 2, '干渉している壁の面には柱型が出るはず');
  const xs = prims.map(p => p.x1).sort((a, b) => a - b);
  // この構成では見付け方向（x）に向き合う壁がフェイクに存在しないため包みは付かない
  // ——包み厚は「その面に向き合う壁の層構成」から来る（columnWrap.js の規約1）。
  assert.equal(Math.round(xs[1] - xs[0]), 250, '見付けは断面200＋ダイヤフラム出25×2');
});

test('【B3-3】structuralColumnPrimitivesForCut: opts.dropped を渡すと帯が持たない柱（dropped のキー）だけを従来の規則で描く。省略は全部', () => {
  const wall = {
    isVertical: false, materialRange: { lo: -6955, hi: -6942.5 }, coord1: -7942, coord2: -3057,
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -7000 },
  };
  const column = { role: 'primary', sectionDefId: 'STEEL-SQ200x200x9.0', x: -7850, y: -6850, rotation: 0 };
  const solids = structuralColumnContribution([{ graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' }]);
  const cut = {
    seqNo: 'a', line: { isVertical: false, axisValue: -7000, lo: -7942, hi: -3057 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  assert.equal(structuralColumnPrimitivesForCut(solids, cut).length, 2, '省略は従来どおり全部');
  assert.equal(structuralColumnPrimitivesForCut(solids, cut, { dropped: new Set() }).length, 0, '帯が持つ柱（dropped でない）は加算で描かない');
  assert.equal(structuralColumnPrimitivesForCut(solids, cut, { dropped: new Set([memberKey(solids[0])]) }).length, 2, 'dropped の柱は従来の規則で描く');
  assert.notEqual(memberKey(solids[0]), memberKey({ ...solids[0], xLo: solids[0].xLo + 1 }), '柱のキーは矩形・足元で区別する');
});

// 実機ログ（2階・柱が壁から42.5mm離れて立つ構成）の再現: 柱が壁と重なっていなくても、
// 隙間が150mm以下なら壁の仕上げ面までトリムして接続し、その面に柱型が出る。
test('【実機修正】structuralColumnPrimitivesForCut: 壁から42.5mm離れた柱もトリムで接続し面に出る', () => {
  const wall = {
    isVertical: false, materialRange: { lo: -6955, hi: -6942.5 }, coord1: -7942, coord2: -3057,
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -7000 },
  };
  const column = { role: 'primary', sectionDefId: 'STEEL-SQ200x200x9.0', x: -7775, y: -6775, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  assert.equal(solids.length, 1);
  assert.equal(solids[0].covers.yLo, 42.5, '壁の仕上げ面(-6942.5)まで42.5mm伸ばすはず');
  assert.equal(solids[0].trimmed.yLo, true);
  assert.equal(solids[0].yLo, -6942.5, '包みの面が壁の仕上げ面と揃うはず');

  const cut = {
    seqNo: 'a', line: { isVertical: false, axisValue: -7000, lo: -7942, hi: -3057 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  const prims = structuralColumnPrimitivesForCut(solids, cut);
  assert.equal(prims.length, 2, 'トリムで接続した壁の面には柱型が出るはず');
  for (const p of prims) assert.equal(p.weight, 'medium', '柱型は中線のはず');
});

// 実機指摘2026-08「展開図「4」B：「4」の中から柱型は見えないが、エッジ線が出ている」。
// 壁を共有する2部屋のうち、柱は片側にしか出っ張らない。軸CLの照合だけでは壁の向こう側の
// 部屋の面にも柱型が出てしまう。
test('【実機修正】structuralColumnPrimitivesForCut: 壁の向こう側に立つ柱はその部屋の面に出さない', () => {
  const wall = {
    isVertical: true, materialRange: { lo: -3400, hi: -3387.5 }, coord1: -1000, coord2: 1000,
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -3400 },
  };
  const column = { role: 'primary', sectionDefId: 'RC-300x300', x: -3190, y: 0, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  assert.equal(solids.length, 1);
  assert.ok(solids[0].wallAxes.some(a => a.isVertical && a.axisValue === -3400),
    '前提: 柱はこの壁とトリムで接続している');

  const base = {
    seqNo: 'x', line: { isVertical: true, axisValue: -3400, lo: -1000, hi: 1000 },
    dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  // 室内が +X 側の部屋（柱はこちら側に出っ張る）→ 描く。
  assert.equal(structuralColumnPrimitivesForCut(solids, { ...base, viewSign: 1 }).length, 2,
    '柱が出っ張っている側の部屋の面には柱型が出るはず');
  // 室内が -X 側の部屋（壁の向こう側）→ 描かない。
  assert.deepEqual(structuralColumnPrimitivesForCut(solids, { ...base, viewSign: -1 }), [],
    '壁の向こう側の部屋からは柱型は見えないはず');
});

test('【失敗系・実機修正】structuralColumnPrimitivesForCut: 干渉していない別軸の面には出ない', () => {
  const wall = {
    isVertical: false, materialRange: { lo: -6955, hi: -6942.5 }, coord1: -7942, coord2: -3057,
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -7000 },
  };
  const column = { role: 'primary', sectionDefId: 'STEEL-SQ200x200x9.0', x: -7850, y: -6850, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  // 同じ向きだが軸が違う面（別の壁芯）。
  const cut = {
    seqNo: 'b', line: { isVertical: false, axisValue: 0, lo: -7942, hi: -3057 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  assert.deepEqual(structuralColumnPrimitivesForCut(solids, cut), [],
    '干渉していない壁の面へ柱型を出してはいけない');
});

test('【追加仕様】solidPrimitivesForFace: 壁から92.5mm離れた柱も150以下なのでトリムで接続し面に出る', () => {
  const { graph, room, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // 柱の外面(y=150)は壁の材厚上端(57.5)から92.5mm離れている＝重なっていないがトリム範囲内。
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, { eccentricity: { x: 0, y: 300 } });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const verticals = solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH })
    .filter(p => p.type === 'line' && p.x1 === p.x2);
  assert.equal(verticals.length, 2, '150mm以内で向き合う壁にはトリムで接続するはず');
});

test('【失敗系・追加仕様】solidPrimitivesForFace: 150を超えて離れた柱は面に出さない（見えがかりはdefer）', () => {
  const { graph, room, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // 柱の外面(y=250)は壁の材厚上端(57.5)から192.5mm離れている＝トリム閾値150超。
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, { eccentricity: { x: 0, y: 400 } });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.deepEqual(solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH }), [],
    '壁から離れて立つ柱の見えがかりは対象外（defer）のはず');
});

test('【追加仕様】structuralColumnContribution: 部屋の中央に立つ独立柱も原則覆う（ただし壁とは接続しない）', () => {
  const { graph } = makeGridRoom();
  // 部屋の中央（どの壁からも150mmを大きく超えて離れている位置）に立つ柱。
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, ym, {});
  const solids = structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }]);
  assert.equal(solids.length, 1);
  assert.equal(solids[0].xHi - solids[0].xLo, 300 + 2 * COVER_MM,
    'ユーザー指示2026-08「柱は原則、仕上げ材で覆う」——独立柱も部屋の層構成で覆われるはず');
  assert.deepEqual(solids[0].wallAxes, [], 'どの壁とも接続しない＝展開図の面には出ない');
});

test('【追加仕様】solidPrimitivesForFace: 直交する面（B面）の壁上の柱はその面には描かれない', () => {
  const { graph, room, y0 } = makeGridRoom();
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});
  const faceB = buildRoomFaces(room, graph).find(f => f.label === 'B');
  const prims = solidPrimitivesForFace(faceB, { graph, ceilingHeight: CH });
  assert.equal(prims.length, 0, 'B面（x=4000の壁）にはA面の柱は掛からないはず');
});

// ---- 追加仕様: 梁型（上階の梁が天井から降りてくる分だけ見える） ----
test('【追加仕様】solidPrimitivesForFace: 上階梁は天井より下へ出る分だけ梁型（細線）になる', () => {
  const { graph, room, x0, x1, y0 } = makeGridRoom();
  const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
  const ux0 = upper.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upper.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const uy0 = upper.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  void x0; void x1; void y0;
  // 天端=2FL(2900)・成600 → 下端2300。CH2400より100mm下がる＝梁型として見える。
  upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', uy0, false, ux0, ux1, { role: 'primary', levelOffset: 0 });

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const prims = solidPrimitivesForFace(faceA, {
    graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900,
  });
  const soffit = prims.filter(p => p.type === 'line' && p.y1 === p.y2 && p.y1 === -2300);
  assert.equal(soffit.length, 1, '梁下端（-2300）の水平線が1本描かれるはず');
  assert.equal(soffit[0].weight, 'thin', '平行な梁の見えがかりは細線（DETAIL）のはず');
  // 面の描画範囲[0, run]へクランプされている（隣の面へはみ出さない）。
  assert.equal(Math.min(soffit[0].x1, soffit[0].x2), 0);
  assert.equal(Math.max(soffit[0].x1, soffit[0].x2), faceA.run);
});

test('【追加仕様】solidPrimitivesForFace: 天井より上で収まる上階梁は描かれない（梁型にならない）', () => {
  const { graph, room } = makeGridRoom();
  const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
  const ux0 = upper.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upper.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const uy0 = upper.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  // 成300 → 下端2600 > CH2400。天井の向こうで見えない。
  upper.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', uy0, false, ux0, ux1,
    { role: 'primary', levelOffset: 0, beamDepth: 300 });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.equal(solidPrimitivesForFace(faceA, {
    graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900,
  }).length, 0, '天井より上に収まる梁は描かれないはず');
});

test('【追加仕様】solidPrimitivesForFace: 自階の床梁（天端=自FL）は床より下のため描かれない', () => {
  const { graph, room, x0, x1, y0 } = makeGridRoom();
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y0, false, x0, x1,
    { role: 'primary', levelOffset: 0 });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.equal(solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH }).length, 0,
    '床下の梁は展開図に描かれないはず（注記帯へ被らない）');
});

// 部屋帯の梁は階段帯と同じ「室内側へ下がった仮想断面（pcut）・壁を見る向き」で判定する（faceBeamCut）。
// 壁が無く、面の軸上の柱（300 角）が仮想断面を 175 下げる部屋（柱の出が梁の半幅 100 を超える）。
function makeNoWallRoom({ column = false, beamAxis = 0, beamSpan = [0, 4000] } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const addGrid = (type, value, label) => graph.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT, label });
  const gx0 = addGrid(CenterLineType.VERTICAL, 0, 'X1'), gx1 = addGrid(CenterLineType.VERTICAL, 4000, 'X2');
  const gy0 = addGrid(CenterLineType.HORIZONTAL, 0, 'Y1'), gy1 = addGrid(CenterLineType.HORIZONTAL, 3000, 'Y2');
  const room = graph.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'いま');
  if (column) {
    const cx = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
    graph.addColumn(StructuralMaterialType.STEEL, 'STEEL-SQ300x300x9.0', cx, gy0, {});
  }
  const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
  const uy = upper.addCenterLine(CenterLineType.HORIZONTAL, beamAxis, { labeled: false, discipline: Discipline.ARCH });
  const ux0 = upper.addCenterLine(CenterLineType.VERTICAL, beamSpan[0], { labeled: false, discipline: Discipline.ARCH });
  const ux1 = upper.addCenterLine(CenterLineType.VERTICAL, beamSpan[1], { labeled: false, discipline: Discipline.ARCH });
  upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', uy, false, ux0, ux1, { role: 'primary', levelOffset: 0 });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  return { graph, room, upper, faceA };
}
const solidsOf = ({ graph, room, upper, faceA }, withRoom = true) => solidPrimitivesForFace(faceA, {
  graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900, ...(withRoom ? { room } : {}),
});

// 配線（B1 型）: 面の平面上の梁は、仮想断面が梁の幅の帯の外へ下がっても細線（parallel）のまま。柱包みに隠れる区間は描かない
test('【配線・B1型】solidPrimitivesForFace: 面の平面上の梁は仮想断面が帯の外へ下がっても細線のまま（空中の中線に変わらない）。柱包みの区間は描かない', () => {
  const m = makeNoWallRoom({ column: true });
  const offset = cutPlaneOffsetMm(m.faceA, faceSectionCut(m.faceA, { graph: m.graph, ceilingHeight: CH, upperGraph: m.upper, floorHeightMm: 2900 }).layers);
  assert.ok(offset > 100, `前提: 仮想断面が梁の半幅（100）より室内側へ下がる（実際 ${offset}）`);
  const prims = solidsOf(m);
  const horizontals = prims.filter(p => p.type === 'line' && p.y1 === p.y2);
  assert.ok(horizontals.length > 0, '梁の天地が描かれる');
  assert.ok(horizontals.every(p => p.weight === 'thin'), '梁は細線（平行の見えがかり）');
  assert.equal(prims.filter(p => p.weight === 'medium' && p.y1 === p.y2).length, 0, '空中の中線は出ない');
  // 柱（x 1825〜2175 の包み）の区間は梁の天地を描かない
  assert.ok(horizontals.every(p => Math.max(p.x1, p.x2) <= 1825 + 1 || Math.min(p.x1, p.x2) >= 2175 - 1), '柱包みの中を通る天地は無い');
  assert.equal(solidsOf(makeNoWallRoom({ column: false })).filter(p => p.y1 === p.y2).length, 2, '対照: 柱が無ければ天地 2 本が通しで続く');
});

// 配線（失敗系）: 仮想断面より手前（室内側）の梁は切り取られて描かない。壁の向こう（部屋の外）の梁も描かない
test('【失敗系・配線】solidPrimitivesForFace: 仮想断面より手前の室内の梁・部屋の外の梁は見えがかりに描かない', () => {
  const inRoom = makeNoWallRoom({ beamAxis: 1500 }); // 面 A（y=0）に平行・室内の y=1500
  assert.equal(solidsOf(inRoom).length, 0, '仮想断面より手前（室内側）の梁は描かない');
  const behind = makeNoWallRoom({ beamAxis: -2000 }); // 面 A の向こう側（部屋の外）の y=-2000
  assert.equal(solidsOf(behind).length, 0, '部屋の外の梁は描かない（帯の部屋の広がりの外）');
  assert.equal(solidsOf(behind, false).filter(p => p.weight === 'medium' && p.y1 === p.y2).length, 2,
    '対照: 部屋を渡さなければ（広がりの制限なし）壁側の梁の天地の中線が出る');
});

// 配線: buildFaceFigure（ctx.solids 指定）が部屋を solidPrimitivesForFace へ渡す＝部屋の外の梁を描かない
test('【配線】buildFaceFigure: ctx.solids 指定時、部屋の広がりの外（面の向こう側）の梁は描かない', () => {
  const m = makeNoWallRoom({ beamAxis: -2000 });
  const prims = buildFaceFigure(m.faceA, faceCtx(m.graph, m.room, { solids: { upperGraph: m.upper, floorHeightMm: 2900 } }));
  assert.equal(prims.filter(p => p.type === 'line' && p.weight === 'medium' && p.y1 === p.y2 && p.y1 === -2300).length, 0,
    '壁側の部屋の外の梁の下端（-2300）の中線は出ない');
});

// 配線（C 型）: 仮想断面と壁芯の間で止まる直交梁の断面
test('【配線・C型】solidPrimitivesForFace: 壁芯の手前（仮想断面と壁芯の間）で止まる直交梁も断面が出る。仮想断面に届かなければ出ない', () => {
  const thickCount = (yEnd) => {
    const { graph, room } = makeGridRoom();
    const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
    const ux = upper.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
    const ua = upper.addCenterLine(CenterLineType.HORIZONTAL, -3000, { labeled: false, discipline: Discipline.ARCH });
    const ub = upper.addCenterLine(CenterLineType.HORIZONTAL, yEnd, { labeled: false, discipline: Discipline.ARCH });
    upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', ux, true, ua, ub, { role: 'primary', levelOffset: 0 });
    const faceC = buildRoomFaces(room, graph).find(f => f.axisCL.effectiveValue === 3000); // y=3000 の壁（室内側は -y）
    return solidPrimitivesForFace(faceC, { graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900, room })
      .filter(p => p.weight === 'thick').length;
  };
  assert.ok(thickCount(3000) > 0, '対照: 壁芯まで来る梁は断面が出る');
  assert.ok(thickCount(2990) > 0, '壁芯の手前 10mm（仮想断面は壁芯から 58 室内側）で止まる梁も断面が出る（旧: 壁芯上の切断で取りこぼした）');
  assert.equal(thickCount(2900), 0, '仮想断面（y=2942）に届かない梁は断面が出ない');
});

// 配線: 面に直交する上階梁の断面（crosses）は、梁が外から来て面の壁芯で終われば出ず、室内へ続けば出る
test('【配線】solidPrimitivesForFace: 直交する上階梁は外から来て面の壁芯で終われば断面 0、室内へ続けば断面あり', () => {
  const thickCount = (yLo, yHi) => {
    const { graph, room } = makeGridRoom();
    const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
    const ux = upper.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
    const ua = upper.addCenterLine(CenterLineType.HORIZONTAL, yLo, { labeled: false, discipline: Discipline.ARCH });
    const ub = upper.addCenterLine(CenterLineType.HORIZONTAL, yHi, { labeled: false, discipline: Discipline.ARCH });
    upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', ux, true, ua, ub, { role: 'primary', levelOffset: 0 });
    const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
    return solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900 })
      .filter(p => p.weight === 'thick').length;
  };
  assert.equal(thickCount(-3000, 0), 0, '外から来て面 A の壁芯（y=0）で終わる梁は壁の中で終わり断面は見えない');
  assert.ok(thickCount(-3000, 3000) > 0, '対照: 室内へ続く梁は面 A で断面（太線）が出る');
  assert.ok(thickCount(0, 3000) > 0, '対照: 壁芯から室内へ向かう梁も断面が出る');
});

// Major-3: 部屋帯は梁の天端・成を帯 0..CH へ切り詰めてから描くが、直交壁の層は元の天端・成で判定する（上階の下がり梁と上階の壁）
test('【配線・Major-3】solidPrimitivesForFace: 上階の下がり梁（成が階高−CH を超える）が A2 型（平行壁が直交壁の帯の中で尽きる）なら断面を描く', () => {
  const build = (withPerp) => {
    // 自階に壁を置かない部屋（直交壁の帯が自階の層から来て判定が効かなくならないように）
    const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    const addGrid = (type, value, label) => graph.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT, label });
    const gx0 = addGrid(CenterLineType.VERTICAL, 0, 'X1'), gx1 = addGrid(CenterLineType.VERTICAL, 4000, 'X2');
    const gy0 = addGrid(CenterLineType.HORIZONTAL, 0, 'Y1'), gy1 = addGrid(CenterLineType.HORIZONTAL, 3000, 'Y2');
    const room = graph.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'いま');
    assert.equal(graph.walls.length, 0, '前提: 自階に壁が無い');
    const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
    const ux = upper.addCenterLine(CenterLineType.VERTICAL, 2100, { labeled: false, discipline: Discipline.ARCH });
    const uxw = upper.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
    const ua = upper.addCenterLine(CenterLineType.HORIZONTAL, -3000, { labeled: false, discipline: Discipline.ARCH });
    const ub = upper.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
    upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', ux, true, ua, ub, { role: 'primary', levelOffset: 0 }); // 天端 2900・成 600（下端 2300 < CH）
    const uy0 = upper.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
    const uyEnd = upper.addCenterLine(CenterLineType.HORIZONTAL, 60, { labeled: false, discipline: Discipline.ARCH });
    // 梁（x=2100・幅200 → 帯 2000..2200）と平行な壁（x=2000 に厚さ200 → 材 2000..2200。y -3000..60）。梁の帯を完全に隠す
    upper.addWall(uxw, 200, true, ua, 0, uyEnd, 0, {});
    if (withPerp) {
      const ux0 = upper.addCenterLine(CenterLineType.VERTICAL, 1800, { labeled: false, discipline: Discipline.ARCH });
      const ux1 = upper.addCenterLine(CenterLineType.VERTICAL, 2400, { labeled: false, discipline: Discipline.ARCH });
      upper.addWall(uy0, 120, false, ux0, 0, ux1, 0, {}); // 直交する壁（y=0・材 0..120。上階の層だけにある。平行壁はこの帯の中で尽きる）
    }
    const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
    return solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH, upperGraph: upper, floorHeightMm: 2900 })
      .filter(p => p.weight === 'thick').length;
  };
  assert.ok(build(true) > 0, '直交壁の帯を除くので、平行壁が帯の中で尽きる A2 型の断面は描かれる');
  assert.equal(build(false), 0, '対照: 直交壁が無ければ切断位置は平行壁の内部＝埋まっている（描かない）');
});

// ---- 失敗系 ----
test('【失敗系】faceSectionCut: 軸位置・dirSign・CHが解決できない面はnull（呼び出し側は無描画）', () => {
  const base = { axisCL: { id: 'a' }, isVertical: false, lo: 0, hi: 4000, run: 4000, dirSign: 1 };
  assert.equal(faceSectionCut(base, { graph: {}, ceilingHeight: CH }), null, 'effectiveValue無しはnull');
  assert.equal(faceSectionCut({ ...base, axisCL: { id: 'a', effectiveValue: 0 }, dirSign: 0 },
    { graph: {}, ceilingHeight: CH }), null, 'dirSign不正はnull');
  assert.equal(faceSectionCut({ ...base, axisCL: { id: 'a', effectiveValue: 0 } },
    { graph: {}, ceilingHeight: 0 }), null, 'CH<=0はnull');
  assert.deepEqual(solidPrimitivesForFace(base, { graph: {}, ceilingHeight: CH }), [],
    '解決できない面では例外を投げず空配列を返すはず');
});

test('【失敗系】solidPrimitivesForFace: beams/columnsを持たないgraphでも例外を投げない', () => {
  const { graph, room } = makeGridRoom();
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  assert.deepEqual(solidPrimitivesForFace(faceA, { graph: {}, ceilingHeight: CH }), []);
  assert.deepEqual(solidPrimitivesForFace(faceA, {
    graph, ceilingHeight: CH, upperGraph: null, floorHeightMm: null,
  }), []);
});

// ---- 実機指摘2026-08「2階床の構造材梁断面は、壁の中なら描画しない」 ----
test('【実機指摘】structuralContribution: 壁の材厚に収まる梁は寄与から落とす（壁に隠れて見えない）', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  // y=0上に厚さ200mmの壁（axisOffset=200 → materialRange {lo:0, hi:200}）。
  graph.addWall(y0, 200, false, x0, 0, x1, 0, {});
  const beam = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y0, false, x0, x1,
    { role: 'primary', levelOffset: 0, eccentricity: 100 }); // 材芯y=100 → 幅帯[47.5,152.5]
  assert.ok(beam.sectionWidth < 200, "前提: 梁幅が壁厚200より細いこと");
  assert.equal(structuralContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 0,
    '壁の材厚に完全に収まる梁は寄与に含めない');
});

test('【失敗系・実機指摘】structuralContribution: 壁からはみ出す梁は落とさない（室内へ現れるため）', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  graph.addWall(y0, 60, false, x0, 0, x1, 0, {}); // 厚さ60mm
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y0, false, x0, x1,
    { role: 'primary', levelOffset: 0, eccentricity: 30 }); // 幅105 > 壁厚60
  assert.equal(structuralContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 1,
    '壁より太い梁は一部が見えるため寄与に残す');
});

test('【失敗系・実機指摘】structuralContribution: 壁とスパンがずれる梁は落とさない（端が見える）', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  const xMid = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(y0, 200, false, x0, 0, xMid, 0, {}); // 壁は面の半分までしか無い（許容(壁厚200)を大きく超える）
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', y0, false, x0, x1,
    { role: 'primary', levelOffset: 0, eccentricity: 100 });
  assert.equal(structuralContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 1,
    '壁が梁のスパンを覆っていなければ端が見えるため残す');
});

test('【失敗系・実機指摘】structuralContribution: 向きの違う壁は梁を隠さない', () => {
  const { graph, x0, y0, y1 } = makeGridRoom();
  graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x105', x0, true, y0, y1,
    { role: 'primary', levelOffset: 0 });
  assert.equal(structuralContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 1,
    '直交する壁は梁を丸ごとは隠せない');
});

// ---- 実機指摘2026-08「「5」C2：X2上にエッジ線が消えていない」 ----
// 通り芯の交点には自動補完で柱が立つため、外壁の中に納まる管柱まで柱型として描くと、
// 連続した壁面の途中に実在しない縦線2本が出る。梁と同じ「壁の中なら描画しない」を柱にも適用する。
test('【実機指摘】structuralColumnContribution: 壁の材厚に収まる柱は柱型として描かない', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  graph.addWall(y0, 200, false, x0, 0, x1, 0, {}); // 厚さ200mmの壁
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  // 105角の管柱を壁の中（材芯y=100）へ。
  graph.addColumn(StructuralMaterialType.WOOD, 'WOOD-105x105', xm, y0, { eccentricity: { x: 0, y: 100 } });
  assert.equal(structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 0,
    '壁の材厚に収まる柱は寄与に含めない');
});

test('【失敗系・実機指摘】structuralColumnContribution: 壁より太い柱は柱型として残す', () => {
  const { graph, x0, x1, y0 } = makeGridRoom();
  graph.addWall(y0, 120, false, x0, 0, x1, 0, {}); // 厚さ120mm
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, { eccentricity: { x: 0, y: 60 } });
  assert.equal(structuralColumnContribution([{ graph, floorZMm: 0, role: 'self' }]).length, 1,
    '壁より太い柱は室内へ出るため柱型として描く');
});

test('【失敗系・追加仕様】structuralColumnContribution: 寸法の判らない手動壁は柱を覆わない（固定値で代用しない）', () => {
  // wallFinish/backingRange を持たない壁（手動壁）だけが干渉する構成。実グラフの部屋は必ず
  // 生成壁（wallFinish=12.5）を持つため、ここは層をフェイクで直接与える。
  const wall = { isVertical: false, materialRange: { lo: 0, hi: 120 }, backingRange: null,
    wallFinish: null, coord1: 0, coord2: 4000 };
  const column = { role: 'primary', sectionDefId: 'RC-300x300', x: 2000, y: 60, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [wall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  assert.equal(solids.length, 1, '壁より太い柱は柱型として残るはず');
  assert.equal(solids[0].xHi - solids[0].xLo, 300, '覆い厚が判らない壁では素の断面幅のままのはず');
});

// ================================================================
// ユーザー実機指摘2026-09「「5」D1: 1階天井見えがかりの下に Y1-X2 の柱型がない」
// onNearSide は「そこに壁が在る」ことを前提にした除外（上の「4」B）。その前提が崩れる区間——
// 面の通りに、柱のrun範囲と重なる壁が1枚も無い区間——では far側の柱も実際に見える。
// ================================================================

// 実機「5」D1と同じ構図を最小で組む（面の通りx=-3400・柱は向こう側＝+X）。
//   - 柱の接続（wallAxes）を作るのは**上階の壁**（実機では2階の吹抜け西側の壁 x=-3000。
//     1階の同じ通りには柱のrun範囲を跨ぐ壁が無い）。上階の壁は帯の天井より上に立つので、
//     下階の面から見た遮蔽物にはならない。
//   - 自階の壁（selfWallSpan）だけを変えて、「柱のrun範囲を覆うか」で挙動を見る。
function farSideCase({ selfWallSpan, viewSign = -1 }) {
  const wallAt = (span) => ({
    isVertical: true, materialRange: { lo: -3400, hi: -3387.5 },
    coord1: span[0], coord2: span[1],
    backingRange: null, wallFinish: 12.5, axisCL: { effectiveValue: -3400 },
  });
  const connectWall = wallAt([-1000, 1000]); // 柱と接続する（上階の）壁
  const column = { role: 'primary', sectionDefId: 'RC-300x300', x: -3190, y: 0, rotation: 0 };
  const solids = structuralColumnContribution([
    { graph: { walls: [connectWall], columns: [column] }, floorZMm: 0, role: 'self' },
  ]);
  const cut = {
    seqNo: 'x', line: { isVertical: true, axisValue: -3400, lo: -1000, hi: 1000 },
    viewSign, dirSign: 1,
    layers: [
      { graph: { walls: selfWallSpan ? [wallAt(selfWallSpan)] : [] }, floorZMm: 0, role: 'self' },
      { graph: { walls: [connectWall] }, floorZMm: 3000, role: 'above' },
    ],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  return { solids, cut, column };
}

test('【実機修正2026-09】structuralColumnPrimitivesForCut: 面の通りに壁が無い区間では、向こう側の柱も柱型として描く', () => {
  // 壁は面の通りに在るが、柱のrun範囲（y -252.5..252.5）から外れた y 600..1000 だけ。
  const { solids, cut } = farSideCase({ selfWallSpan: [600, 1000] });
  const prims = structuralColumnPrimitivesForCut(solids, cut);
  assert.equal(prims.length, 2, '素通しで見える柱は見付け幅の両端2本で描かれるはず');
  assert.ok(prims.every(p => p.weight === 'medium'), '線種は従来どおり中線（SILHOUETTE）のはず');
  const xs = prims.map(p => p.x1).sort((a, b) => a - b);
  assert.equal(Math.round(xs[1] - xs[0]), Math.round(solids[0].yHi - solids[0].yLo),
    '見付け幅は柱の包み外形どおりのはず');
});

test('【最重要回帰・「4」B型】structuralColumnPrimitivesForCut: 柱のrun範囲を覆う壁があれば向こう側の柱は描かない', () => {
  // 壁が柱のrun範囲（y -252.5..252.5）を丸ごと覆う＝「4」Bそのもの。
  const { solids, cut } = farSideCase({ selfWallSpan: [-1000, 1000] });
  assert.deepEqual(structuralColumnPrimitivesForCut(solids, cut), [],
    '壁の向こう側の柱は見えない（「4」Bの承認済み挙動）');
});

test('【失敗系】structuralColumnPrimitivesForCut: 壁が柱のrun範囲を半分だけ覆う場合も描かない（見付け寸法を偽らない）', () => {
  // y 0..1000 の壁は柱のrun範囲(-252.5..252.5)の上半分だけを覆う。
  const { solids, cut } = farSideCase({ selfWallSpan: [0, 1000] });
  assert.deepEqual(structuralColumnPrimitivesForCut(solids, cut), [],
    '片側が壁に隠れた柱を両端2本で描くと見付け寸法が嘘になるため、一部でも重なれば描かない');
});

test('【失敗系】structuralColumnPrimitivesForCut: 向こう側でも奥行きが見えがかりの上限以上なら描かない', () => {
  const { cut } = farSideCase({ selfWallSpan: [600, 1000] });
  // 面の通り(-3400)に接続しているが、切断面から800以上奥にある柱（実機ではRCの厚壁の向こう等）。
  const far = [{
    xLo: -2500, xHi: -2200, yLo: -150, yHi: 150, baseZ: 0,
    wallAxes: [{ isVertical: true, axisValue: -3400 }],
  }];
  assert.deepEqual(structuralColumnPrimitivesForCut(far, cut), [],
    '奥行き800以上は別の空間のものとして描かない');
});

test('【失敗系】structuralColumnPrimitivesForCut: 入口条件（接続壁・またぎ）に掛からない独立柱は向こう側では描かない', () => {
  const { cut } = farSideCase({ selfWallSpan: [600, 1000] });
  const lone = [{ xLo: -3300, xHi: -3000, yLo: -150, yHi: 150, baseZ: 0, wallAxes: [] }];
  assert.deepEqual(structuralColumnPrimitivesForCut(lone, cut), [],
    '独立柱の見えがかりは従来どおり対象外（defer）');
});

test('【回帰】structuralColumnPrimitivesForCut: 手前側（near）の柱は壁の有無に関わらず従来どおり描く', () => {
  // viewSign=+1＝室内が+X側＝柱が出っ張っている側。柱のrun範囲を覆う壁があっても描く。
  const covered = farSideCase({ selfWallSpan: [-1000, 1000], viewSign: 1 });
  assert.equal(structuralColumnPrimitivesForCut(covered.solids, covered.cut).length, 2,
    '手前側の柱型は従来どおり2本');
  const bare = farSideCase({ selfWallSpan: [600, 1000], viewSign: 1 });
  assert.equal(structuralColumnPrimitivesForCut(bare.solids, bare.cut).length, 2,
    '壁の有無で手前側の挙動は変わらない');
});

test('【符号固定】faceSectionCut の viewSign は室内側を正に採る（sectionCutPlane.faceViewSignとは逆）', () => {
  const face = {
    isVertical: true, inward: 1, dirSign: 1, lo: 0, hi: 3000,
    axisCL: { effectiveValue: 0 },
  };
  assert.equal(faceSectionCut(face, { graph: { walls: [], columns: [] }, ceilingHeight: CH }).viewSign, 1,
    'inward=+1（室内が+方向）ならviewSign=+1。反転させると「4」BのonNearSideが壊れる');
  assert.equal(faceSectionCut({ ...face, inward: -1 }, { graph: { walls: [], columns: [] }, ceilingHeight: CH }).viewSign, -1);
});

test('【回帰】cutPlaneOffsetMm: 面の向こう側の柱は仮想断面線の下げ量を動かさない', () => {
  const { graph, room, y0 } = makeGridRoom();
  void y0;
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const layers = [{ graph, floorZMm: 0, role: 'self' }];
  const baseMm = cutPlaneOffsetMm(faceA, layers, { columnSolids: [] });
  // A面（y=0・inward=+1＝室内は+y側）の向こう側（y<0）に出っ張る柱。
  const farCol = [{
    xLo: 1000, xHi: 1300, yLo: -400, yHi: -100, baseZ: 0,
    wallAxes: [{ isVertical: false, axisValue: 0 }],
  }];
  assert.equal(cutPlaneOffsetMm(faceA, layers, { columnSolids: farCol }), baseMm,
    '室外側へ出る柱はinwardProjectionが0へ丸めるため下げ量は変わらないはず');
});

// ---- 配線（原因1）: 多層帯（buildRoomBandWithVoidAbove）へも加算レイヤを渡す ----
// ユーザー実機指摘2026-09の主因。ElevationModeState.jsが多層帯にだけctx.solidsを渡しておらず、
// 上部吹抜けのある部屋の展開図には柱型・梁型が一切出ていなかった。
function makeVoidAboveCase() {
  const { graph, room, x0, x1, y0 } = makeGridRoom();
  const upper = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const uAdd = (type, value) => upper.addCenterLine(type, value, { labeled: true, discipline: Discipline.STRUCT });
  const ux0 = uAdd(CenterLineType.VERTICAL, 0), ux1 = uAdd(CenterLineType.VERTICAL, 4000);
  const uy0 = uAdd(CenterLineType.HORIZONTAL, 0), uy1 = uAdd(CenterLineType.HORIZONTAL, 3000);
  const voidRoom = upper.addRoom(new Set([`${ux0.id}:${uy0.id}:${ux1.id}:${uy1.id}`]), '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);
  generateRoomWallsFromOutline(upper, voidRoom);
  // A面（y=0）の壁の上に立つ柱（手前側＝室内に出っ張る）。
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});
  void x0; void x1;
  return { graph, room, upper, voidRoom };
}
const primKey = p => `${p.type}|${p.x1}|${p.y1}|${p.x2}|${p.y2}|${p.weight}|${p.dash ?? ''}|${p.text ?? ''}`;

test('【実機修正2026-09】buildRoomBandWithVoidAbove: solids指定時だけ柱型が増え、未指定時の出力は1本も変わらない', () => {
  const { graph, room, upper, voidRoom } = makeVoidAboveCase();
  const opts = { floorHeightAboveMm: 3000 };
  const without = buildRoomBandWithVoidAbove(room, graph, voidRoom, upper, opts);
  const with_ = buildRoomBandWithVoidAbove(room, graph, voidRoom, upper,
    { ...opts, solids: { upperGraph: upper, floorHeightMm: 3000 } });
  const before = without.primitives.map(primKey);
  const after = with_.primitives.map(primKey);
  assert.deepEqual(before.filter(k => !after.includes(k)), [],
    'solidsを渡しても既存のプリミティブは1本も消えない・変わらないはず');
  const added = after.filter(k => !before.includes(k));
  // U1b B3-3: 柱型は帯（memberFace の column）が描く。柱の上端は梁と同じ天井の取り方（部屋の CH では切らない）で、帯の上端に接するので天の線は付かない
  assert.equal(added.length, 2, `柱型の両端縦線2本だけが増えるはず（実際:${JSON.stringify(added)}）`);
  assert.ok(added.every(k => k.includes('|medium|')), '柱型は中線（SILHOUETTE）のはず');
});

test('【失敗系・S4】beamBlockerRectsForFace: 解決できない面（軸位置なし）・梁の無い面は空配列（例外を投げない）', () => {
  assert.deepEqual(beamBlockerRectsForFace({ axisCL: null }, { graph: new PlanGraph(), ceilingHeight: 2400 }), []);
  const face = { axisCL: { effectiveValue: 0 }, lo: 0, hi: 3000, run: 3000, dirSign: 1, isVertical: false, inward: 1 };
  assert.deepEqual(beamBlockerRectsForFace(face, { graph: new PlanGraph(), ceilingHeight: 2400 }), []);
});

// ---- U1b B3-1: 梁の断面は帯（断面エンジンの memberCut）が描く ----
// A 面（y=0）を貫く上階の梁（x=2000・y 0..3000・天 2500・成 600 → z 1900..2500。CH2400 で切られて 1900..2400）。
function makeBeamBandCase() {
  const { graph, room } = makeGridRoom();
  const upper = new PlanGraph(new Plane('p2', 2900, '2階', 2, 1));
  const A = (type, value) => upper.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
  upper.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', A(CenterLineType.VERTICAL, 2000), true,
    A(CenterLineType.HORIZONTAL, 0), A(CenterLineType.HORIZONTAL, 3000), { role: 'primary', levelOffset: -400 });
  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  return { graph, room, upper, faceA, solids: { upperGraph: upper, floorHeightMm: 2900 } };
}
const thickLines = ps => ps.filter(p => p.type === 'line' && p.weight === 'thick' && -Math.min(p.y1, p.y2) > 1800 && -Math.max(p.y1, p.y2) < 2500);

test('【B3-1・配線】部屋帯: 梁の断面は帯が描き、従来の加算（solidPrimitivesForFace）と同じ輪郭になる。図側の加算（memberCutsByBand）は断面を描かない', () => {
  const { graph, room, faceA, solids } = makeBeamBandCase();
  const additive = solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH, room, ...solids });
  // 梁の天（CH で切られた 2400）の水平線は天井断面線（同じ太線）と重なり、帯の finalizeBand の dedupe で畳まれるので比べない
  const notCeilingLine = p => !(p.y1 === p.y2 && p.y1 === -CH);
  const old = thickLines(additive).filter(notCeilingLine);
  assert.ok(old.length >= 4, `前提: 従来の加算が断面の輪郭を描く（${old.length} 本）`);
  assert.equal(thickLines(solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH, room, ...solids, memberCutsByBand: true })).length, 0,
    'memberCutsByBand 指定の加算は断面を描かない（帯が描く）');
  const band = buildRoomBand(room, graph, { solids });
  const inBand = thickLines(band.primitives).filter(notCeilingLine);
  // 帯の線は面の xCursor ぶん平行移動している。先頭の線の差から平行移動量を決め、従来の輪郭の全部が同じ形で帯にあることを確かめる
  const dx = inBand.find(p => p.y1 === old[0].y1 && p.y2 === old[0].y2)?.x1 - old[0].x1;
  assert.ok(Number.isFinite(dx), '前提: 帯に同じ高さの線がある');
  const key = (p, d = 0) => [p.x1 + d, p.y1, p.x2 + d, p.y2, p.weight, p.dash ?? ''].join('|');
  const inBandKeys = inBand.map(p => key(p));
  for (const p of old) assert.equal(inBandKeys.filter(k => k === key(p, dx)).length, 1, `従来の輪郭の線が帯に 1 本だけある（二重に描かない）: ${key(p)}`);
});

test('【失敗系・B3-1】部屋帯: solids を渡さない帯は梁を描かない（memberLayers 空＝従来どおり）。自階の梁でも出ない', () => {
  const { graph, room } = makeGridRoom();
  const A = (type, value) => graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
  graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-H600x200', A(CenterLineType.VERTICAL, 2000), true,
    A(CenterLineType.HORIZONTAL, 0), A(CenterLineType.HORIZONTAL, 3000), { role: 'primary', levelOffset: 2300 }); // 自階の梁 z 1700..2300
  const withBeam = buildRoomBand(room, graph);
  const plain = makeGridRoom();
  const without = buildRoomBand(plain.room, plain.graph);
  assert.deepEqual(withBeam.primitives.map(primKey), without.primitives.map(primKey), 'solids 無しの帯は梁の有無で変わらない');
});

test('【B3-1】droppedMemberPrimitivesForFace: dropped のキーの梁の断面だけを従来の規則で描く。空・別キーなら空配列', () => {
  const { graph, faceA, room, solids } = makeBeamBandCase();
  const opts = { graph, ceilingHeight: CH, room, ...solids };
  const cut = faceSectionCut(faceA, opts);
  const [beam] = structuralContribution(cut.layers);
  assert.equal(droppedMemberPrimitivesForFace(faceA, opts, new Set()).length, 0, '空集合は何も描かない');
  assert.equal(droppedMemberPrimitivesForFace(faceA, opts, new Set(['v|0|0|0|0|0|0'])).length, 0, '別の梁のキーは描かない');
  const prims = droppedMemberPrimitivesForFace(faceA, opts, new Set([memberKey(beam)]));
  assert.deepEqual(prims.map(primKey).sort(), thickLines(solidPrimitivesForFace(faceA, opts)).map(primKey).sort(),
    'dropped の梁の断面は従来の加算の断面と同じ');
  assert.equal(droppedMemberPrimitivesForFace({ axisCL: null }, opts, new Set([memberKey(beam)])).length, 0, '解決できない面は空');
});

test('【B3-1】memberLayersOf: 自階＋判っていれば上階（梁は立つ階の graph に帰属）。上階が無ければ自階だけ', () => {
  const { graph, upper } = makeBeamBandCase();
  assert.deepEqual(memberLayersOf(graph, { upperGraph: upper, floorHeightMm: 2900 }).map(l => [l.role, l.floorZMm]), [['self', 0], ['above', 2900]]);
  assert.deepEqual(memberLayersOf(graph, { upperGraph: null }).map(l => l.role), ['self']);
  assert.deepEqual(memberLayersOf(graph, undefined).map(l => l.role), ['self']);
});
