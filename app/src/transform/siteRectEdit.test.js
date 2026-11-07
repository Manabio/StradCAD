// siteEdit.test.js と同じ方針: 実 core/site.js の Site と実 undoManager を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { undoManager } from '../undoManager.js';
import {
  commitFirstRect, commitAttachedRect,
  TOAST_RECT_EDGE_INNER, TOAST_RECT_ATTACH_BAD, TOAST_RECT_SIZE_BAD, TOAST_RECT_BASE_MISSING,
} from './siteRectEdit.js';

test('commitFirstRect: 長方形を追加し、undo で消え redo で同 id・同寸法で戻る', () => {
  const site = new Site();
  const res = commitFirstRect(site, { x: 100, y: 200 }, 3000, 2000);

  assert.equal(res.ok, true);
  assert.equal(res.toast, null);
  const r = site.rectMap.get(res.rectId);
  assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, { x: 100, y: 200, w: 3000, h: 2000 });

  undoManager.undo();
  assert.equal(site.rects.length, 0);

  undoManager.redo();
  const r2 = site.rectMap.get(res.rectId);
  assert.ok(r2, '同じ id で戻る');
  assert.deepEqual({ x: r2.x, y: r2.y, w: r2.w, h: r2.h }, { x: 100, y: 200, w: 3000, h: 2000 });
});

test('【失敗系】commitFirstRect: 寸法が 0 以下・非有限なら ok:false で undo を積まない', () => {
  const site = new Site();
  const before = undoManager.peekUndo();
  for (const [w, h] of [[0, 100], [100, -1], [NaN, 100], [100, Infinity]]) {
    const res = commitFirstRect(site, { x: 0, y: 0 }, w, h);
    assert.equal(res.ok, false);
    assert.equal(res.toast, TOAST_RECT_SIZE_BAD);
    assert.equal(res.rectId, null);
  }
  assert.equal(site.rects.length, 0);
  assert.equal(undoManager.peekUndo(), before, 'undo は積まれない');
});

test('commitAttachedRect: 北辺・基点a に付加でき、undo/redo が同 id で往復する', () => {
  const site = new Site();
  const first = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const res = commitAttachedRect(site, first.rectId, 'n', 'a', 400, 300);

  assert.equal(res.ok, true);
  assert.equal(res.toast, null);
  const r = site.rectMap.get(res.rectId);
  assert.deepEqual({ x: r.x, y: r.y, w: r.w, h: r.h }, { x: 0, y: -300, w: 400, h: 300 });
  assert.equal(site.rects.length, 2);

  undoManager.undo();
  assert.equal(site.rects.length, 1);
  assert.ok(site.rectMap.has(first.rectId), '最初の長方形は残る');

  undoManager.redo();
  const r2 = site.rectMap.get(res.rectId);
  assert.ok(r2, '同じ id で戻る');
  assert.deepEqual({ x: r2.x, y: r2.y, w: r2.w, h: r2.h }, { x: 0, y: -300, w: 400, h: 300 });
});

test('【失敗系】commitAttachedRect: 内側の辺（共有辺）は拒否し、長方形も undo も増えない', () => {
  const site = new Site();
  const first = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const second = commitAttachedRect(site, first.rectId, 'e', 'a', 600, 500);
  assert.equal(second.ok, true);
  const before = undoManager.peekUndo();

  const res = commitAttachedRect(site, first.rectId, 'e', 'a', 300, 300);

  assert.equal(res.ok, false);
  assert.equal(res.toast, TOAST_RECT_EDGE_INNER);
  assert.equal(site.rects.length, 2);
  assert.equal(undoManager.peekUndo(), before, 'undo は積まれない');
});

test('【失敗系】commitAttachedRect: 辺長・奥行が不正なら幾何エラーの toast で undo を積まない', () => {
  const site = new Site();
  const first = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const before = undoManager.peekUndo();

  const res = commitAttachedRect(site, first.rectId, 'n', 'a', 0, 300);

  assert.equal(res.ok, false);
  assert.equal(res.toast, TOAST_RECT_ATTACH_BAD);
  assert.equal(site.rects.length, 1);
  assert.equal(undoManager.peekUndo(), before);
});

test('【失敗系】commitAttachedRect: 存在しない基の長方形は ok:false', () => {
  const site = new Site();
  const before = undoManager.peekUndo();
  const res = commitAttachedRect(site, 'nope', 'n', 'a', 100, 100);
  assert.equal(res.ok, false);
  assert.equal(res.toast, TOAST_RECT_BASE_MISSING);
  assert.equal(undoManager.peekUndo(), before);
});
