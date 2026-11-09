// siteRectEdit.test.js と同じ方針: 実 core/site.js の Site と実 undoManager を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { undoManager } from '../undoManager.js';
import { applySitePlacementWithUndo } from './sitePlacementEdit.js';

const mk = (tx) => ({
  rotationDeg: 90, tx, ty: 20,
  input: { v1: { x: 0, y: 0 }, v2: { x: 1, y: 0 }, centerLineId: 'cl', distance: 500, rotationFlipped: false, sideFlipped: true },
});

test('applySitePlacementWithUndo: 配置を設定し、undo で前の値（null）へ・redo で同じ値へ戻る。再設定の undo は前の配置へ', () => {
  const site = new Site();
  const p1 = mk(100), p2 = mk(200);

  assert.equal(applySitePlacementWithUndo(site, p1), true);
  assert.equal(site.placement, p1);
  assert.equal(applySitePlacementWithUndo(site, p2), true);
  assert.equal(site.placement, p2);

  undoManager.undo();
  assert.equal(site.placement, p1, '前の配置へ');
  undoManager.undo();
  assert.equal(site.placement, null, '配置なしへ');
  undoManager.redo();
  assert.equal(site.placement, p1);
  undoManager.redo();
  assert.equal(site.placement, p2);

  assert.equal(applySitePlacementWithUndo(site, null), true, '解除も undo できる');
  assert.equal(site.placement, null);
  undoManager.undo();
  assert.equal(site.placement, p2);
});

test('【失敗系】applySitePlacementWithUndo: 同じ値（参照同一）は false で undo を積まない', () => {
  const site = new Site();
  const before = undoManager.peekUndo();
  assert.equal(applySitePlacementWithUndo(site, null), false, 'null → null');
  assert.equal(undoManager.peekUndo(), before);
  const p = mk(1);
  applySitePlacementWithUndo(site, p);
  const afterSet = undoManager.peekUndo();
  assert.equal(applySitePlacementWithUndo(site, p), false);
  assert.equal(undoManager.peekUndo(), afterSet, 'undo は積まれない');
});
