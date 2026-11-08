// siteEdit.test.js と同じ方針: 実 core/site.js の Site と実 undoManager を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { undoManager } from '../undoManager.js';
import {
  commitFirstRect, commitAttachedRect, toggleRectRoadSide, TOAST_RECT_ROAD_INNER,
  TOAST_RECT_EDGE_INNER, TOAST_RECT_ATTACH_BAD, TOAST_RECT_SIZE_BAD, TOAST_RECT_BASE_MISSING,
  deleteRect, commitEditFirstRect, commitEditAttachedRect, TOAST_RECT_EDIT_LOCKED, TOAST_RECT_DELETE_LOCKED,
} from './siteRectEdit.js';
import { buildOutlineRows, buildRectTableRows } from '../site/siteRectInput.js';
import { isEdgeAttachable } from '../site/siteRectGeometry.js';

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

// ---- 削除・寸法修正 ----

const geom = (r) => ({ x: r.x, y: r.y, w: r.w, h: r.h });

test('deleteRect: 端の長方形を消し、undo で同 id・roadSides ごと戻り redo で再び消える', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500);
  toggleRectRoadSide(site, b.rectId, 'n'); // B の北辺（外周）を道路に
  const res = deleteRect(site, b.rectId);
  assert.deepEqual(res, { ok: true, toast: null });
  assert.equal(site.rectMap.has(b.rectId), false);

  undoManager.undo();
  const back = site.rectMap.get(b.rectId);
  assert.ok(back, '同 id で戻る');
  assert.deepEqual(geom(back), { x: 1000, y: 0, w: 500, h: 600 });
  assert.deepEqual([...back.roadSides], ['n'], 'roadSides も復元');

  undoManager.redo();
  assert.equal(site.rectMap.has(b.rectId), false);
});

test('deleteRect: 中間（A,B,C の B）を消して undo すると id 順・番号・外周ラベルが削除前と一致する', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500);
  const c = commitAttachedRect(site, a.rectId, 'w', 'a', 600, 400);
  // B を端にするため C は A の西側。B・C とも端なので B は削除可
  const ids = site.rects.map(r => r.id);
  assert.deepEqual(ids, [a.rectId, b.rectId, c.rectId]);
  const tableBefore = buildRectTableRows(site.rects);
  const outlineBefore = buildOutlineRows(site.rects);
  const keep = site.rectMap.get(c.rectId);
  assert.equal(deleteRect(site, b.rectId).ok, true);
  undoManager.undo();
  assert.deepEqual(site.rects.map(r => r.id), ids);
  assert.equal(site.rectMap.get(c.rectId), keep, '他の SiteRect は同じインスタンス');
  assert.deepEqual(buildRectTableRows(site.rects), tableBefore);
  assert.deepEqual(buildOutlineRows(site.rects), outlineBefore);
});

test('【失敗系】deleteRect: 残りが分かれる削除（鎖の中間）・存在しない id は TOAST_RECT_DELETE_LOCKED で undo を積まない', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500);
  commitAttachedRect(site, b.rectId, 'e', 'a', 600, 400);
  const before = undoManager.peekUndo();
  for (const id of [b.rectId, 'none']) {
    const res = deleteRect(site, id);
    assert.deepEqual(res, { ok: false, toast: TOAST_RECT_DELETE_LOCKED });
  }
  assert.equal(site.rects.length, 3);
  assert.equal(undoManager.peekUndo(), before, 'undo は積まれない');
});

test('commitEditFirstRect: 同じインスタンスの w,h を書き換え（x,y・id・roadSides 保持）、undo/redo で往復する', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 100, y: 200 }, 1000, 600);
  toggleRectRoadSide(site, a.rectId, 'n');
  const inst = site.rectMap.get(a.rectId);
  const res = commitEditFirstRect(site, a.rectId, 2000, 800);
  assert.deepEqual(res, { ok: true, toast: null });
  assert.equal(site.rectMap.get(a.rectId), inst, '同一インスタンス');
  assert.deepEqual(geom(inst), { x: 100, y: 200, w: 2000, h: 800 });
  assert.deepEqual([...inst.roadSides], ['n']);

  undoManager.undo();
  assert.deepEqual(geom(inst), { x: 100, y: 200, w: 1000, h: 600 });
  undoManager.redo();
  assert.deepEqual(geom(inst), { x: 100, y: 200, w: 2000, h: 800 });
});

test('【失敗系】commitEditFirstRect: 無効寸法は TOAST_RECT_SIZE_BAD、隣接ありは TOAST_RECT_EDIT_LOCKED、いずれも不変・undo なし', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const before = undoManager.peekUndo();
  for (const [w, h] of [[0, 100], [100, -1], [NaN, 100]]) {
    assert.deepEqual(commitEditFirstRect(site, a.rectId, w, h), { ok: false, toast: TOAST_RECT_SIZE_BAD });
  }
  assert.deepEqual(geom(site.rectMap.get(a.rectId)), { x: 0, y: 0, w: 1000, h: 600 });
  commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500);
  const before2 = undoManager.peekUndo();
  assert.deepEqual(commitEditFirstRect(site, a.rectId, 500, 500), { ok: false, toast: TOAST_RECT_EDIT_LOCKED });
  assert.equal(undoManager.peekUndo(), before2);
  assert.notEqual(before, before2);
});

test('commitEditAttachedRect: 同じインスタンスを書き換え（id 同一）、基点・辺長・奥行どおりの幾何。undo/redo で往復', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 300, 500);
  const inst = site.rectMap.get(b.rectId);
  const res = commitEditAttachedRect(site, b.rectId, a.rectId, 'e', 'b', 400, 700);
  assert.deepEqual(res, { ok: true, toast: null });
  assert.equal(site.rectMap.get(b.rectId), inst);
  // 東辺の基点 b（下端 y=600）から上へ 400、外側（東）へ 700
  assert.deepEqual(geom(inst), { x: 1000, y: 200, w: 700, h: 400 });

  undoManager.undo();
  assert.deepEqual(geom(inst), { x: 1000, y: 0, w: 500, h: 300 });
  undoManager.redo();
  assert.deepEqual(geom(inst), { x: 1000, y: 200, w: 700, h: 400 });
});

test('commitEditAttachedRect: 基の辺を全部覆っている対象も修正できる（基の辺の外周判定は対象を除いた rects で行う）', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500); // A の東辺を全部覆う
  assert.equal(isEdgeAttachable(site.rects, a.rectId, 'e'), false, '全体では A の東辺は内側に見える');
  const res = commitEditAttachedRect(site, b.rectId, a.rectId, 'e', 'a', 600, 800);
  assert.deepEqual(res, { ok: true, toast: null });
  assert.deepEqual(geom(site.rectMap.get(b.rectId)), { x: 1000, y: 0, w: 800, h: 600 });
});

test('commitEditAttachedRect: 修正で内側になった辺の道路指定は無指定へ格下げされ、undo で戻る', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 300, 500); // 東辺の上 300 に付く
  toggleRectRoadSide(site, a.rectId, 'e'); // A の東辺（外周片は y 300..600 のみ）を道路に
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('e'), true);
  // B を東辺の全長（600）へ伸ばすと A の東辺は完全に内側
  const res = commitEditAttachedRect(site, b.rectId, a.rectId, 'e', 'a', 600, 500);
  assert.equal(res.ok, true);
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('e'), false, '格下げ');
  undoManager.undo();
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('e'), true, 'undo で道路指定も戻る');
  assert.deepEqual(geom(site.rectMap.get(b.rectId)), { x: 1000, y: 0, w: 500, h: 300 });
  undoManager.redo();
  assert.equal(site.rectMap.get(a.rectId).roadSides.has('e'), false);
});

test('【失敗系】commitEditAttachedRect: 隣接 2・無効寸法・基が無い・基と同一は拒否し、不変・undo なし', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 600, 500);
  const c = commitAttachedRect(site, b.rectId, 'e', 'a', 600, 400);
  const before = undoManager.peekUndo();
  assert.deepEqual(commitEditAttachedRect(site, b.rectId, a.rectId, 'e', 'a', 600, 300),
    { ok: false, toast: TOAST_RECT_EDIT_LOCKED }, 'B は隣接 2');
  assert.deepEqual(commitEditAttachedRect(site, c.rectId, b.rectId, 'e', 'a', 0, 300),
    { ok: false, toast: TOAST_RECT_ATTACH_BAD });
  assert.deepEqual(commitEditAttachedRect(site, c.rectId, 'none', 'e', 'a', 100, 300),
    { ok: false, toast: TOAST_RECT_BASE_MISSING });
  assert.deepEqual(commitEditAttachedRect(site, c.rectId, c.rectId, 'e', 'a', 100, 300),
    { ok: false, toast: TOAST_RECT_BASE_MISSING });
  assert.deepEqual(geom(site.rectMap.get(c.rectId)), { x: 1500, y: 0, w: 400, h: 600 });
  assert.equal(undoManager.peekUndo(), before);
});

test('長方形を付けてから削除すると、外周表は付ける前（A だけ）と一致する（外周片は導出で一本へ戻る）', () => {
  const site = new Site();
  const a = commitFirstRect(site, { x: 0, y: 0 }, 1000, 600);
  const onlyA = buildOutlineRows(site.rects);
  const b = commitAttachedRect(site, a.rectId, 'e', 'a', 300, 500);
  assert.notDeepEqual(buildOutlineRows(site.rects), onlyA, '付けると外周片が分かれる');
  assert.equal(deleteRect(site, b.rectId).ok, true);
  assert.deepEqual(buildOutlineRows(site.rects), onlyA);
});
