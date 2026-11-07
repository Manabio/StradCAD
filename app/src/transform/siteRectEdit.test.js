// siteEdit.test.js と同じ方針: 実 core/site.js の Site と実 undoManager を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { undoManager } from '../undoManager.js';
import {
  commitFirstRect, commitAttachedRect, toggleRectRoadSide, TOAST_RECT_ROAD_INNER,
  TOAST_RECT_EDGE_INNER, TOAST_RECT_ATTACH_BAD, TOAST_RECT_SIZE_BAD, TOAST_RECT_BASE_MISSING,
} from './siteRectEdit.js';
import { buildOutlineRows } from '../site/siteRectInput.js';

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

test('toggleRectRoadSide: 外周の辺を道路指定→解除でき、undo/redo で往復する', () => {
  const site = new Site();
  const { rectId } = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const r = site.rectMap.get(rectId);

  assert.deepEqual(toggleRectRoadSide(site, rectId, 'n'), { ok: true, toast: null });
  assert.equal(r.roadSides.has('n'), true);

  undoManager.undo();
  assert.equal(r.roadSides.has('n'), false);
  undoManager.redo();
  assert.equal(r.roadSides.has('n'), true);

  toggleRectRoadSide(site, rectId, 'n');
  assert.equal(r.roadSides.has('n'), false, '再トグルで解除');
});

test('toggleRectRoadSide: 束ねた片（同位置の北辺を持つ重なる a・b）で b.n が道路のとき a.n をタップすると b.n が外れ、undo で戻る', () => {
  const site = new Site();
  const a = site.addRect(0, 0, 1000, 600);
  const b = site.addRect(0, 0, 1000, 600);
  b.roadSides.add('n');

  assert.deepEqual(toggleRectRoadSide(site, a.id, 'n'), { ok: true, toast: null });
  assert.equal(b.roadSides.has('n'), false);
  assert.equal(a.roadSides.has('n'), false);

  undoManager.undo();
  assert.equal(b.roadSides.has('n'), true);
  assert.equal(a.roadSides.has('n'), false);
});

test('commitAttachedRect: a.n が道路のとき a.n の中央に付加しても a.n の道路指定は残り、外周表の該当 2 行はどちらも「道路」', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  toggleRectRoadSide(site, a.rectId, 'n');
  // 北辺の中央（x=400..600）に長方形を置き（基点は端のみのため直接追加）、その上へ付加して格下げ判定を走らせる
  const m = site.addRect(400, -300, 200, 300);
  const res = commitAttachedRect(site, m.id, 'n', 'a', 200, 100);
  assert.equal(res.ok, true);
  const r = site.rectMap.get(a.rectId);
  assert.equal(r.roadSides.has('n'), true, '外周に残る辺の道路指定は残る');
  const north = buildOutlineRows(site.rects).filter(row => row.label.startsWith('1-北'));
  assert.equal(north.length, 2, 'a.n は中央の長方形で 2 片に分かれる');
  assert.ok(north.every(row => row.kindLabel === '道路'));
});

test('【失敗系】toggleRectRoadSide: 内側の辺・存在しない長方形は拒否し undo を積まない', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const d = site.addRect(100, 100, 10, 10); // a に内包され全辺が内側
  const before = undoManager.peekUndo();

  const res = toggleRectRoadSide(site, d.id, 'n');
  assert.equal(res.ok, false);
  assert.equal(res.toast, TOAST_RECT_ROAD_INNER);
  assert.equal(d.roadSides.size, 0);
  assert.equal(undoManager.peekUndo(), before, 'undo は積まれない');

  assert.equal(toggleRectRoadSide(site, 'nope', 'n').ok, false);
  assert.equal(undoManager.peekUndo(), before);
  assert.ok(a.ok);
});

test('commitAttachedRect: 道路指定した辺が内側になったら無指定へ格下げし、undo で指定が戻る', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  toggleRectRoadSide(site, a.rectId, 'n');
  const r = site.rectMap.get(a.rectId);
  assert.equal(r.roadSides.has('n'), true);

  // 北辺全体を覆う長方形を付ける → a.n は完全に内側
  const res = commitAttachedRect(site, a.rectId, 'n', 'a', 1000, 300);
  assert.equal(res.ok, true);
  assert.equal(r.roadSides.has('n'), false, '内側になった辺は無指定へ');

  undoManager.undo();
  assert.equal(site.rects.length, 1);
  assert.equal(r.roadSides.has('n'), true, 'undo で道路指定が戻る');

  undoManager.redo();
  assert.equal(r.roadSides.has('n'), false);
});

test('commitAttachedRect: 外周のまま残る辺の道路指定は保持される', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  toggleRectRoadSide(site, a.rectId, 's');
  commitAttachedRect(site, a.rectId, 'n', 'a', 1000, 300);
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('s'), true);
});

test('【失敗系】commitAttachedRect: 失敗時は道路指定を変えず undo も積まない', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  toggleRectRoadSide(site, a.rectId, 'n');
  const before = undoManager.peekUndo();
  const res = commitAttachedRect(site, a.rectId, 'n', 'a', 0, 300);
  assert.equal(res.ok, false);
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('n'), true);
  assert.equal(undoManager.peekUndo(), before);
});
