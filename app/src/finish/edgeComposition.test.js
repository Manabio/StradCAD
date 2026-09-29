import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialThickness, roomWallDims } from './edgeComposition.js';
import { MATERIALS } from './materials/materialData.js';
import { RC_WALL_BACKING_CODES } from './materials/backingClass.js';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, DEFAULT_SHAFT_WALL_MATERIAL } from '@core';

function findMaterial(code) {
  return MATERIALS.find(m => m.code === code);
}

// ---- QA blocker回帰: RC壁下地3件が厚み0にならないこと ----
// 修正前は BACKING カテゴリを一律 Math.max(x,y) で評価しており、RC壁下地（x:0,y:0,thickness:150/180/200）
// が厚み0になっていた。連鎖: wallBase=0 → backingDepth=0 → backingRange=null →
// isBackingOwnerWall false → collectWallBeamSources 条件(a) が1本も収集しない。
test('materialThickness: RC壁下地3件はそれぞれ thickness(150/180/200) を返す（0にならない）', () => {
  const [t150, t180, t200] = RC_WALL_BACKING_CODES.map(findMaterial);
  assert.equal(materialThickness(t150), 150);
  assert.equal(materialThickness(t180), 180);
  assert.equal(materialThickness(t200), 200);
});

// ---- 既存挙動の回帰固定: 木・鋼下地はx/yの大きい方のまま ----
test('materialThickness: 既存の木・鋼下地（thickness:null）は従来どおり断面の大きい辺を返す（回帰固定）', () => {
  const stud = findMaterial('101400000007'); // □-60×45
  assert.equal(stud.thickness, null, '既存下地材はthickness:nullであることが前提');
  assert.equal(materialThickness(stud), 60);
});

// ---- 昇降路（isShaftFeature）の壁材解決（Q14。共通仕様のshaftWallMaterialから面材だけを解決する） ----
function makeMaterialMap() {
  return new Map(MATERIALS.map(m => [m.code, m]));
}

function makeGraphWithRoom(feature) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), feature ?? '部屋');
  if (feature) room.setFeature(feature);
  return { graph, room };
}

// ---- QA F1/T1: 昇降路（isShaftFeature。現在は昇降機のみ）でwallFinishがshaftWallMaterialの
// 厚で決まることを固定する（昇降路が1種になり、isShaftFeature を `=== 'elevatorEquipment'` へ
// 置換する変異は挙動が完全に一致する等価変異になったため、この変異に対する検出力は不要）。
test('roomWallDims【QA F1/T1】: feature=elevatorEquipment（昇降路）のwallFinishはshaftWallMaterialの厚で決まる（既定PB12.5→12.5、強化PB12.5+12.5→25）', () => {
  const materialMap = makeMaterialMap();
  const { graph, room } = makeGraphWithRoom(RoomFeature.ELEVATOR_EQUIPMENT);

  assert.equal(graph.shaftWallMaterial, DEFAULT_SHAFT_WALL_MATERIAL, '既定値の前提');
  assert.equal(roomWallDims(graph, room, materialMap).wallFinish, 12.5, '既定のshaftWallMaterial（PB12.5）');

  graph.setShaftWallMaterial('301000000020'); // 強化せっこうボード t=12.5+12.5
  assert.equal(roomWallDims(graph, room, materialMap).wallFinish, 25);
});

// ---- QA F5: graph.shaftWallMaterial が null（未設定相当）なら `?? DEFAULT_SHAFT_WALL_MATERIAL` で
// 既定へフォールバックする（`?? DEFAULT_SHAFT_WALL_MATERIAL` を外す変異の検出力） ----
test('roomWallDims【QA F5】: graph.shaftWallMaterialがnullなら既定（PB12.5→wallFinish 12.5）へフォールバックする', () => {
  const materialMap = makeMaterialMap();
  const { graph, room } = makeGraphWithRoom(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.shaftWallMaterial = null; // setter経由でなく直接null化（未設定相当を模す）

  assert.equal(roomWallDims(graph, room, materialMap).wallFinish, 12.5);
});

test('roomWallDims: 通常部屋（feature未設定）はshaftWallMaterialを変えてもwallFinishが不変', () => {
  const materialMap = makeMaterialMap();
  const { graph, room } = makeGraphWithRoom(null);

  const before = roomWallDims(graph, room, materialMap).wallFinish;
  graph.setShaftWallMaterial('301000000020');
  assert.equal(roomWallDims(graph, room, materialMap).wallFinish, before);
});

test('【失敗系】roomWallDims: 昇降路部屋のshaftWallMaterialがmaterialMapに無いコードならnull（既存の解決不可規約）', () => {
  const materialMap = makeMaterialMap();
  const { graph, room } = makeGraphWithRoom(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.setShaftWallMaterial('999999999999'); // materialMapに存在しないコード

  assert.equal(roomWallDims(graph, room, materialMap), null);
});
