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
  structuralContribution, structuralColumnContribution,
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

// ---- 追加仕様: 柱型（切断線をまたぐ柱の見付け幅の両端縦線・CUT） ----
test('【追加仕様】solidPrimitivesForFace: A面の壁上に立つ柱は見付け幅の両端縦線（太線）で描かれる', () => {
  const { graph, room, x1, y0 } = makeGridRoom();
  // A面（y=0の壁）の途中、x=2000に300角のRC柱。
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  void x1;
  graph.addColumn(StructuralMaterialType.RC, 'RC-300x300', xm, y0, {});

  const faceA = buildRoomFaces(room, graph).find(f => f.label === 'A');
  const prims = solidPrimitivesForFace(faceA, { graph, ceilingHeight: CH });
  const verticals = prims.filter(p => p.type === 'line' && p.x1 === p.x2 && p.weight === 'thick');
  assert.equal(verticals.length, 2, '柱型の両端縦線2本が描かれるはず');
  const xs = verticals.map(p => p.x1).sort((a, b) => a - b);
  assert.equal(Math.round(xs[1] - xs[0]), 300, '見付け幅は断面幅300mmのはず');
  for (const v of verticals) {
    assert.equal(Math.min(v.y1, v.y2), -CH, '柱型は天井まで届くはず');
    assert.equal(Math.max(v.y1, v.y2), 0, '柱型は床から立つはず');
  }
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
