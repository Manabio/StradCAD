// 2.5D立体の加算レイヤ（構造柱の柱型・上階梁の梁型）と、通り芯丸ナンバーの範囲修正の回帰テスト。
// 実Plane/PlanGraph+実finish/wallGeneration.jsを使う（elevationFaces.test.js/elevationBand.test.jsと
// 同じ方針）——face.lo/hi（仕上げ面へ詰めた端）と壁中心線のズレ・構造材のCL基準スパンはどちらも
// フェイクfaceでは再現できないため。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomFaces } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';
import { collectGridCLs } from './elevationPrimitives.js';
import { solidPrimitivesForFace, faceSectionCut } from './elevationSolids.js';
import {
  structuralContribution, structuralColumnContribution, structuralColumnPrimitivesForCut,
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
