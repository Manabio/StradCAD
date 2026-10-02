// core/project.js のカタログ通知フィールド（2026-09-22 再QA指摘Major-D）。
// catalogError（メッセージ通知専用）と catalogOverlayUntrusted（保存ガード専用boolean）を
// 分離した経緯の検証。catalogErrorSeq は「同一文言でも都度発火できる」ことの土台
// （App.jsxのreactionはこのseqを観測する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, isTopFloorPlane } from './project.js';

test('Project: catalogError/catalogErrorSeq/catalogOverlayUntrustedの初期値', () => {
  const project = new Project('p1', 'test');
  assert.equal(project.catalogError, null);
  assert.equal(project.catalogErrorSeq, 0);
  assert.equal(project.catalogOverlayUntrusted, false);
});

test('setCatalogError: 呼ぶたびにcatalogErrorSeqが増える（同一文言でも増える＝都度発火の土台）', () => {
  const project = new Project('p1', 'test');
  project.setCatalogError('同じメッセージ');
  const seq1 = project.catalogErrorSeq;
  assert.equal(project.catalogError, '同じメッセージ');
  assert.ok(seq1 > 0);

  project.setCatalogError('同じメッセージ'); // 全く同じ文字列を再度設定
  assert.equal(project.catalogError, '同じメッセージ');
  assert.ok(project.catalogErrorSeq > seq1, 'catalogErrorSeqが増えていない（同一文言の再通知ができない）');
});

test('setCatalogOverlayUntrusted: catalogErrorとは独立に真偽を持つ（兼用しない）', () => {
  const project = new Project('p1', 'test');
  project.setCatalogOverlayUntrusted(true);
  assert.equal(project.catalogOverlayUntrusted, true);
  assert.equal(project.catalogError, null, 'catalogOverlayUntrustedを立ててもcatalogErrorは変わらない（兼用しない）');

  project.setCatalogError('通知だけの文言');
  assert.equal(project.catalogOverlayUntrusted, true, 'setCatalogErrorはcatalogOverlayUntrustedを変えない（兼用しない）');
});

// ---- 指示UI（ステップ6-3）の行一覧: catalogResolveRows/setCatalogResolveRows/clearCatalogResolveRows ----
test('Project: catalogResolveRowsの初期値は空配列', () => {
  const project = new Project('p1', 'test');
  assert.deepEqual(project.catalogResolveRows, []);
});

// ---- B3: isTopFloorPlane（主屋根を使う階＝最上階とその検討案の判定） ----
function projectWithFloors(count) {
  const project = new Project('p1', 'test');
  const planes = [];
  for (let i = 0; i < count; i++) {
    planes.push(project.addPlane(i * 3000, `${i + 1}階`, `f${i + 1}`, i + 1).plane);
  }
  return { project, planes };
}

test('isTopFloorPlane: 末尾の採用フロアだけが最上階。中間階・最下階は偽', () => {
  const { project, planes } = projectWithFloors(3);
  assert.equal(isTopFloorPlane(project, planes[2]), true);
  assert.equal(isTopFloorPlane(project, planes[1]), false);
  assert.equal(isTopFloorPlane(project, planes[0]), false);
});

test('isTopFloorPlane: 最上階の検討案は真、中間階の検討案は偽（参照元が最上階かで決まる）', () => {
  const { project, planes } = projectWithFloors(3);
  const altTop = project.addPlane(6000, '3階検討', 'alt-top', 3, 1, true, planes[2].id, 1).plane;
  const altMid = project.addPlane(3000, '2階検討', 'alt-mid', 2, 1, true, planes[1].id, 1).plane;
  assert.equal(isTopFloorPlane(project, altTop), true);
  assert.equal(isTopFloorPlane(project, altMid), false);
});

test('isTopFloorPlane: 屋根専用平面は偽（最上階の判定の対象外）', () => {
  const { project, planes } = projectWithFloors(2);
  const roof = project.addPlane(6000, 'R階', 'roof', 3, 1, false, null, 0, true, planes[1].id).plane;
  assert.equal(isTopFloorPlane(project, roof), false);
  assert.equal(isTopFloorPlane(project, planes[1]), true, '屋根専用平面があっても最上階は採用フロアの末尾');
});

test('isTopFloorPlane: 階が1つだけならその階が最上階', () => {
  const { project, planes } = projectWithFloors(1);
  assert.equal(isTopFloorPlane(project, planes[0]), true);
});

test('【失敗系】isTopFloorPlane: 階が無い・plane/project が無いときは偽（例外にしない）', () => {
  const empty = new Project('p0', 'empty');
  assert.equal(isTopFloorPlane(empty, { id: 'x' }), false, '階が無い');
  const { project, planes } = projectWithFloors(2);
  assert.equal(isTopFloorPlane(project, null), false);
  assert.equal(isTopFloorPlane(project, undefined), false);
  assert.equal(isTopFloorPlane(null, planes[1]), false);
});

test('setCatalogResolveRows: 渡した配列で全置換する（===同一性を保つ。observable.refのため中身はプロキシ化されない）', () => {
  const project = new Project('p1', 'test');
  const rows = [{ id: 'r1', scenario: 'propose' }];
  project.setCatalogResolveRows(rows);
  assert.equal(project.catalogResolveRows, rows, '渡した配列そのもの（===同一）が入る');
  assert.equal(project.catalogResolveRows[0], rows[0], '行オブジェクトの===同一性も保たれる');
});

test('clearCatalogResolveRows: 空配列に戻す', () => {
  const project = new Project('p1', 'test');
  project.setCatalogResolveRows([{ id: 'r1', scenario: 'propose' }]);
  project.clearCatalogResolveRows();
  assert.deepEqual(project.catalogResolveRows, []);
});
