// syncRoofPlane（最上階の直上に屋根専用平面を同期する）の単体テスト。
// 途中階の上階追加と階移動の振り直し一本化 ステップ5（§5-8）: 最上階idが同じまま
// elevation・startFloor・storiesだけ振り直しで動いたとき、屋根平面がそれに追従することを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../core.js';
import { syncRoofPlane, followRoofPlaneToTop } from './roofPlane.js';

test('syncRoofPlane: 最上階idが同じまま高さ・階番号・階数が変わったら屋根平面が追従する', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);

  const roof1 = syncRoofPlane(project);
  assert.equal(roof1.elevation, 3001);
  assert.equal(roof1.startFloor, 2);
  assert.equal(roof1.stories, 1);

  // p2が振り直しで高さ・階番号・階数だけ動く（idは変わらない）
  const p2 = project.planeMap.get('p2');
  p2.elevation  = 6000;
  p2.startFloor = 3;
  p2.stories    = 2;

  const roof2 = syncRoofPlane(project);
  assert.equal(roof2.id, roof1.id, '最上階idが同じなら屋根平面を作り直さない');
  assert.equal(roof2.elevation, 6001, '屋根平面の高さは最上階+1に追従する必要がある');
  assert.equal(roof2.startFloor, 3);
  assert.equal(roof2.stories, 2);
});

test('syncRoofPlane: 最上階idが変わったら屋根平面を作り直す（既存挙動の対照）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);

  const roof1 = syncRoofPlane(project);

  // 新しい最上階を追加する（p2より上）
  project.addPlane(6000, '3階', 'p3', 3, 1);
  const roof2 = syncRoofPlane(project);

  assert.notEqual(roof2.id, roof1.id, '最上階idが変わったら屋根平面を作り直す必要がある');
  assert.equal(roof2.roofForPlaneId, 'p3');
  assert.equal(roof2.elevation, 6001);
});

test('【失敗系】syncRoofPlane: 採用階が無いとき null を返す', () => {
  const project = new Project('proj', 'test');
  assert.equal(syncRoofPlane(project), null);
});

// ---- followRoofPlaneToTop（QA指摘2026-10-01再裁定: idが同じときの書き換えだけに限定する） ----

test('followRoofPlaneToTop: 最上階idが同じまま高さ・階番号・階数が変わったら書き換えてtrueを返す', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  const roof = syncRoofPlane(project);

  const p2 = project.planeMap.get('p2');
  p2.elevation  = 6000;
  p2.startFloor = 3;
  p2.stories    = 2;

  const changed = followRoofPlaneToTop(project);

  assert.equal(changed, true);
  assert.equal(project.roofPlane.id, roof.id, 'idは保たれる必要がある');
  assert.equal(project.roofPlane.elevation, 6001);
  assert.equal(project.roofPlane.startFloor, 3);
  assert.equal(project.roofPlane.stories, 2);
});

test('【失敗系】followRoofPlaneToTop: 最上階idが違うときは作り直さず何もしないでfalseを返す', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  const roof = syncRoofPlane(project);
  const planeCountBefore = project.planeMap.size;

  // 最上階がp3に入れ替わる（p2の上に新しい最上階ができる想定。roofForPlaneIdはp2のまま）
  project.addPlane(6000, '3階', 'p3', 3, 1);

  const changed = followRoofPlaneToTop(project);

  assert.equal(changed, false, 'idが違えば書き換えてはいけない');
  assert.equal(project.planeMap.size, planeCountBefore + 1, '作り直し（削除→新設）をしてはいけない');
  assert.equal(project.roofPlane.id, roof.id, '既存の屋根平面をそのまま残す必要がある');
  assert.equal(project.roofPlane.roofForPlaneId, 'p2', '古いroofForPlaneIdのまま変えてはいけない');
});

test('【失敗系】followRoofPlaneToTop: 屋根平面が無ければfalseを返す', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  assert.equal(followRoofPlaneToTop(project), false);
});

test('【失敗系】followRoofPlaneToTop: 採用階が無ければfalseを返す', () => {
  const project = new Project('proj', 'test');
  assert.equal(followRoofPlaneToTop(project), false);
});
