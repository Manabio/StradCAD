// core/project.js のカタログ通知フィールド（2026-09-22 再QA指摘Major-D）。
// catalogError（メッセージ通知専用）と catalogOverlayUntrusted（保存ガード専用boolean）を
// 分離した経緯の検証。catalogErrorSeq は「同一文言でも都度発火できる」ことの土台
// （App.jsxのreactionはこのseqを観測する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from './project.js';

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
