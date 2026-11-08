import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Site, SiteLineKind } from '../core.js';
import { SiteModeState } from './SiteModeState.js';

const vp = { worldToScreen: (x, y) => ({ x: x * 0.1, y: y * 0.1 }) };

function makeState() {
  const site = new Site();
  const rect = site.addRect(0, 0, 1000, 600);
  return { site, rect, sm: new SiteModeState(site) };
}

test('startFirstRect: first 入力状態を origin 付きで作る', () => {
  const { sm } = makeState();
  sm.startFirstRect(120, 340);
  assert.deepEqual(sm.rectInputState, {
    kind: 'first', origin: { x: 120, y: 340 }, focusedCell: 'w', wValue: '', hValue: '',
  });
});

test('selectRectEdge: 共有辺を選び基点を左上原点に近い端点で初期化、attach 入力状態を作る', () => {
  const { rect, sm } = makeState();
  sm.selectRectEdge(rect.id, 'n', vp);
  assert.deepEqual(sm.selectedRectEdge, { rectId: rect.id, side: 'n' });
  assert.equal(sm.rectAnchor, 'a');
  assert.deepEqual(sm.rectInputState, { kind: 'attach', focusedCell: 'along', alongValue: '', depthValue: '' });
});

test('startRectEdit: 隣接 0 は first 形式（x,y 固定・現寸を入れ editRectId 付き）で選択辺なし', () => {
  const { rect, sm } = makeState();
  sm.startRectEdit(rect.id, vp);
  assert.equal(sm.selectedRectEdge, null);
  assert.deepEqual(sm.rectInputState, {
    kind: 'first', origin: { x: 0, y: 0 }, focusedCell: 'w', wValue: '1000', hValue: '600', editRectId: rect.id,
  });
});

test('startRectEdit: 隣接 1 は基の辺・基点を復元した attach 形式（片端一致なら基点はその端）', () => {
  const { site, rect, sm } = makeState();
  // rect(0,0,1000,600) の東辺に下端（基点 b）から付く 400x400
  const t = site.addRect(1000, 200, 400, 400);
  sm.startRectEdit(t.id, vp);
  assert.deepEqual(sm.selectedRectEdge, { rectId: rect.id, side: 'e' });
  assert.equal(sm.rectAnchor, 'b');
  assert.deepEqual(sm.rectInputState, {
    kind: 'attach', focusedCell: 'along', alongValue: '400', depthValue: '400', editRectId: t.id,
  });
});

test('startRectEdit: 両端一致なら基点は pickRectEdgeAnchor の規則で初期化', () => {
  const { site, rect, sm } = makeState();
  const t = site.addRect(1000, 0, 400, 600);
  sm.startRectEdit(t.id, vp);
  assert.deepEqual(sm.selectedRectEdge, { rectId: rect.id, side: 'e' });
  assert.equal(sm.rectAnchor, 'a', '画面左上に近い端点');
});

test('【失敗系】startRectEdit: 修正不可（隣接 2・基点不一致・存在しない）は何もしない', () => {
  const { site, sm } = makeState(); // A(0,0,1000,600)
  const b = site.addRect(1000, 0, 500, 600);
  site.addRect(1500, 0, 500, 600);
  sm.startRectEdit(b.id, vp); // 隣接 2
  assert.equal(sm.rectInputState, null);
  const s2 = makeState(); // 基の東辺の中ほどに付く＝どちらの端とも不一致
  const odd = s2.site.addRect(1000, 100, 300, 200);
  s2.sm.startRectEdit(odd.id, vp);
  assert.equal(s2.sm.rectInputState, null);
  assert.equal(s2.sm.selectedRectEdge, null);
  sm.startRectEdit('none', vp);
  assert.equal(sm.rectInputState, null);
  assert.equal(sm.selectedRectEdge, null);
});

test('setRectInputValue / setRectFocusedCell は editRectId を保つ', () => {
  const { rect, sm } = makeState();
  sm.startRectEdit(rect.id, vp);
  sm.setRectInputValue('1500');
  sm.setRectFocusedCell('h');
  sm.setRectInputValue('700');
  assert.equal(sm.rectInputState.editRectId, rect.id);
  assert.equal(sm.rectInputState.wValue, '1500');
  assert.equal(sm.rectInputState.hValue, '700');
});

test('修正中の長方形（editRectId）が消えたら（undo 等）長方形側の入力を残さない', () => {
  const { site, rect, sm } = makeState();
  sm.startRectEdit(rect.id, vp);
  assert.ok(sm.rectInputState);
  site.removeRect(rect.id);
  assert.equal(sm.rectInputState, null);
  assert.equal(sm.selectedRectEdge, null);
});

test('startRectEdit 後に selectRectEdge すると editRectId が消え新規付加になる', () => {
  const { site, rect, sm } = makeState();
  const b = site.addRect(1000, 0, 400, 600);
  sm.startRectEdit(b.id, vp);
  assert.equal(sm.rectInputState.editRectId, b.id);
  sm.selectRectEdge(rect.id, 's', vp);
  assert.deepEqual(sm.rectInputState, { kind: 'attach', focusedCell: 'along', alongValue: '', depthValue: '' });
  assert.equal('editRectId' in sm.rectInputState, false);
});

test('toggleRectAnchor: a と b を切り替える（辺未選択なら何もしない）', () => {
  const { rect, sm } = makeState();
  sm.toggleRectAnchor();
  assert.equal(sm.rectAnchor, 'a', '未選択では変わらない');
  sm.selectRectEdge(rect.id, 'n', vp);
  sm.toggleRectAnchor();
  assert.equal(sm.rectAnchor, 'b');
  sm.toggleRectAnchor();
  assert.equal(sm.rectAnchor, 'a');
});

test('setRectFocusedCell / setRectInputValue: フォーカス中のセルの値だけが更新される', () => {
  const { rect, sm } = makeState();
  sm.selectRectEdge(rect.id, 'n', vp);
  sm.setRectInputValue('400');
  sm.setRectFocusedCell('depth');
  sm.setRectInputValue('300');
  assert.equal(sm.rectInputState.alongValue, '400');
  assert.equal(sm.rectInputState.depthValue, '300');

  sm.startFirstRect(0, 0);
  sm.setRectInputValue('3000');
  sm.setRectFocusedCell('h');
  sm.setRectInputValue('2000');
  assert.equal(sm.rectInputState.wValue, '3000');
  assert.equal(sm.rectInputState.hValue, '2000');
});

test('【失敗系】selectRectEdge: 存在しない長方形は状態を変えない／入力なしの setRectInputValue は無害', () => {
  const { sm } = makeState();
  sm.selectRectEdge('nope', 'n', vp);
  assert.equal(sm.selectedRectEdge, null);
  assert.equal(sm.rectInputState, null);
  assert.doesNotThrow(() => { sm.setRectInputValue('1'); sm.setRectFocusedCell('w'); });
  assert.equal(sm.rectInputState, null);
});

test('setSubMode / clearSelection / dispose / clearRectInput は長方形の選択・入力も消す', () => {
  const { rect, sm } = makeState();
  const prime = () => { sm.selectRectEdge(rect.id, 'n', vp); sm.toggleRectAnchor(); };
  const assertCleared = () => {
    assert.equal(sm.selectedRectEdge, null);
    assert.equal(sm.rectInputState, null);
    assert.equal(sm.rectAnchor, 'a');
  };
  prime(); sm.setSubMode('sansha'); assertCleared();
  prime(); sm.clearSelection();     assertCleared();
  prime(); sm.dispose();            assertCleared();
  prime(); sm.clearRectInput();     assertCleared();
});

test('selectLine: 長方形タブで startFirstRect 後に三斜の線を選ぶと sansha へ切替わり長方形側の状態が残らない', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(5000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.SURVEY);
  const sm = new SiteModeState(site);
  sm.setSubMode('rect');
  sm.startFirstRect(10, 20);
  assert.ok(sm.rectInputState);
  sm.selectLine(line.id);
  assert.equal(sm.subMode, 'sansha');
  assert.equal(sm.rectInputState, null);
  assert.equal(sm.selectedRectEdge, null);
});

test('選択中の長方形が消えたら（undo 等）選択と入力を解除する。dispose 後は反応しない', () => {
  const { site, rect, sm } = makeState();
  sm.selectRectEdge(rect.id, 'n', vp);
  site.removeRect(rect.id);
  assert.equal(sm.selectedRectEdge, null);
  assert.equal(sm.rectInputState, null);

  const b = makeState();
  b.sm.dispose();
  b.sm.selectedRectEdge = { rectId: b.rect.id, side: 'n' };
  b.site.removeRect(b.rect.id);
  assert.notEqual(b.sm.selectedRectEdge, null, 'dispose で reaction が解除されている');
});

test('三斜側の入力状態は長方形の操作で変わらない', () => {
  const { rect, sm } = makeState();
  sm.inputState = { focusedCell: 'len', lenValue: '5' };
  sm.selectRectEdge(rect.id, 'n', vp);
  sm.startFirstRect(0, 0);
  assert.deepEqual(sm.inputState, { focusedCell: 'len', lenValue: '5' });
});

test('cycleEdgeKind: SURVEY→ROAD→SURVEY と回り、BOUNDARY（旧データ）からは ROAD になる', () => {
  const sm = new SiteModeState(new Site());
  sm.inputState = { focusedCell: 'red', redKind: SiteLineKind.SURVEY, blueKind: SiteLineKind.BOUNDARY };
  sm.cycleEdgeKind('red');
  assert.equal(sm.inputState.redKind, SiteLineKind.ROAD);
  sm.cycleEdgeKind('red');
  assert.equal(sm.inputState.redKind, SiteLineKind.SURVEY);
  sm.cycleEdgeKind('blue');
  assert.equal(sm.inputState.blueKind, SiteLineKind.ROAD);
});

test('【失敗系】cycleEdgeKind: 入力状態が無ければ何もしない', () => {
  const sm = new SiteModeState(new Site());
  sm.cycleEdgeKind('red');
  assert.equal(sm.inputState, null);
});

test('selectLine: 赤辺・青辺の初期線種は底辺が道路でも常に無指定（SURVEY）', () => {
  const site = new Site();
  const sp = site.addPoint(0, 0);
  const ep = site.addPoint(1000, 0);
  const line = site.addLine(sp, ep, SiteLineKind.ROAD);
  const sm = new SiteModeState(site);
  sm.selectLine(line.id);
  assert.equal(sm.inputState.redKind, SiteLineKind.SURVEY);
  assert.equal(sm.inputState.blueKind, SiteLineKind.SURVEY);
});
