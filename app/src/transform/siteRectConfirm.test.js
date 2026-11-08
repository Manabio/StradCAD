import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SiteModeState } from '../modes/SiteModeState.js';
import { evalNumpadExpr } from '../ui/numpadUtils.js';
import { confirmSiteRect } from './siteRectConfirm.js';
import { TOAST_RECT_EDGE_INNER, TOAST_RECT_EDIT_LOCKED } from './siteRectEdit.js';

const evalExpr = (s) => evalNumpadExpr(s, { positiveOnly: true });
const vp = { worldToScreen: (x, y) => ({ x: x * 0.1, y: y * 0.1 }) };

function typeInto(sm, ...vals) {
  const cells = sm.rectInputState.kind === 'first' ? ['w', 'h'] : ['along', 'depth'];
  vals.forEach((v, i) => { sm.setRectFocusedCell(cells[i]); sm.setRectInputValue(v); });
}

test('confirmSiteRect: first は寸法から最初の長方形を作り、入力を消す', () => {
  const site = new Site();
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startFirstRect(100, 200);
  typeInto(sm, '4000', '3000');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, null);
  assert.equal(site.rects.length, 1);
  assert.deepEqual({ x: site.rects[0].x, y: site.rects[0].y, w: site.rects[0].w, h: site.rects[0].h },
    { x: 100, y: 200, w: 4000, h: 3000 });
  assert.equal(sm.rectInputState, null);
});

test('confirmSiteRect: attach は共有辺・基点・辺長・奥行から長方形を付ける', () => {
  const site = new Site();
  const base = site.addRect(0, 0, 4000, 3000);
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.selectRectEdge(base.id, 'e', vp);
  typeInto(sm, '1000', '500');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, null);
  assert.equal(site.rects.length, 2);
  assert.equal(sm.rectInputState, null);
  assert.equal(sm.selectedRectEdge, null);
});

test('【失敗系】confirmSiteRect: 片方だけ・不正式なら何も作らず toast なし・入力は残る', () => {
  const site = new Site();
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startFirstRect(0, 0);
  typeInto(sm, '4000');
  assert.deepEqual(confirmSiteRect(site, sm, evalExpr), { toast: null });
  typeInto(sm, '4000', '3+');
  assert.deepEqual(confirmSiteRect(site, sm, evalExpr), { toast: null });
  assert.equal(site.rects.length, 0);
  assert.ok(sm.rectInputState, '入力は残る');
});

test('【失敗系】confirmSiteRect: 入力なし・共有辺なしは何もしない', () => {
  const site = new Site();
  const sm = new SiteModeState(site);
  assert.deepEqual(confirmSiteRect(site, sm, evalExpr), { toast: null });
  sm.rectInputState = { kind: 'attach', focusedCell: 'along', alongValue: '1', depthValue: '1' };
  assert.deepEqual(confirmSiteRect(site, sm, evalExpr), { toast: null });
  assert.equal(site.rects.length, 0);
});

test('【失敗系】confirmSiteRect: 内側の辺への付加は toast を返し、長方形を作らず入力も残る', () => {
  const site = new Site();
  const a = site.addRect(0, 0, 1000, 1000);
  site.addRect(1000, 0, 1000, 1000);
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.selectRectEdge(a.id, 'e', vp); // 右隣と全面共有＝完全に内側
  typeInto(sm, '500', '500');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, TOAST_RECT_EDGE_INNER);
  assert.equal(site.rects.length, 2);
  assert.ok(sm.rectInputState);
});

test('confirmSiteRect: editRectId 付き first は新規追加でなく同じ長方形の寸法を書き換え、入力を消す', () => {
  const site = new Site();
  const a = site.addRect(100, 200, 1000, 600);
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startRectEdit(a.id, vp);
  typeInto(sm, '2500', '1500');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, null);
  assert.equal(site.rects.length, 1, '新規追加しない');
  assert.deepEqual({ x: a.x, y: a.y, w: a.w, h: a.h }, { x: 100, y: 200, w: 2500, h: 1500 });
  assert.equal(sm.rectInputState, null);
});

test('confirmSiteRect: editRectId 付き attach は同じ長方形を基点・辺長・奥行どおりに書き換える', () => {
  const site = new Site();
  const base = site.addRect(0, 0, 4000, 3000);
  const b = site.addRect(4000, 0, 1000, 500); // 東辺の上端（基点 a）から 500 の長さ
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startRectEdit(b.id, vp);
  assert.deepEqual(sm.selectedRectEdge, { rectId: base.id, side: 'e' });
  typeInto(sm, '1200', '800');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, null);
  assert.equal(site.rects.length, 2);
  assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h }, { x: 4000, y: 0, w: 800, h: 1200 });
  assert.equal(sm.rectInputState, null);
});

test('【失敗系】confirmSiteRect: editRectId 付きで修正不可になっていれば toast を返し、入力は残る', () => {
  const site = new Site();
  const a = site.addRect(0, 0, 1000, 1000);
  site.addRect(1000, 0, 1000, 1000);
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startRectEdit(a.id, vp); // 隣接 1（B）で修正開始
  site.addRect(-1000, 0, 1000, 1000); // その後 A に別の長方形が付いて隣接 2 になった
  typeInto(sm, '1000', '500');
  const { toast } = confirmSiteRect(site, sm, evalExpr);
  assert.equal(toast, TOAST_RECT_EDIT_LOCKED);
  assert.deepEqual({ w: a.w, h: a.h }, { w: 1000, h: 1000 });
  assert.ok(sm.rectInputState);
});
