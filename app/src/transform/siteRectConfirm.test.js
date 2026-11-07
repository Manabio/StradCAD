import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site } from '../core.js';
import { SiteModeState } from '../modes/SiteModeState.js';
import { evalNumpadExpr } from '../ui/numpadUtils.js';
import { confirmSiteRect } from './siteRectConfirm.js';
import { TOAST_RECT_EDGE_INNER } from './siteRectEdit.js';

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
