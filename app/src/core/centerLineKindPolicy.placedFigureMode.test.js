// 図面モード（姿図配置モード）が centerLineKindPolicy.js の公開関数を本当に通ることの検証。
// 本番の定義表（constants.js の PLACED_FIGURE_MODES）には試験用の id でない本番の行があるので、このファイルだけ、読み込む瞬間のソースを
// 試験用の 2 行へまるごと差し替える（node:module の registerHooks の同期 load フック。前例 scripts/probe/structPerfHooks.mjs）。
// node --test はファイルごとに別プロセスなので、差し替えは他のテストへ漏れない。
// フックは testSetup.mjs の registerHooks({ resolve }) と別に積む（load だけを持つので共存する）。
// src の import はフック登録後の動的 import にする（静的 import は先に評価され、差し替えが間に合わない）。
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 本番の表（いまは plumbing の 1 行）をまるごと試験用の 2 行へ置き換える（行数・中身に依らず当たる形）。
const TARGET = /export const PLACED_FIGURE_MODES = Object\.freeze\(\[[\s\S]*?\n\]\);/;
const ROWS = `export const PLACED_FIGURE_MODES = Object.freeze([
  { mode: 'plumbingTest', label: '給排水（試験）', subjects: [DetailSubject.SANITARY] },
  { mode: 'hvacTest', label: '空調（試験）', subjects: [DetailSubject.HVAC, DetailSubject.ELECTRICAL] },
]);`;
let hookHits = 0;
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.endsWith('/src/core/constants.js') || r.source == null) return r;
    const src = r.source.toString();
    if (!TARGET.test(src)) return r;
    hookHits++;
    return { ...r, source: src.replace(TARGET, () => ROWS) };
  },
});

const { CenterLineType, Discipline, DetailSubject } = await import('./constants.js');
const policy = await import('./centerLineKindPolicy.js');
const { PLACED_FIGURE_MODE_REGISTRY, PLACED_FIGURE_MODE_IDS } = await import('./placedFigureModes.js');
const { makeSinglePlaneProject } = await import('../graphTestFixtures.js');
const { CL_KINDS, APP_MODES, kindsVisibleIn, kindsRenderedIn, hitTestKinds, kindsVisibleWith, moveSnapTargetKinds,
  isRenderTarget, isHitTestTarget, isAddDialogSnapOnlyRef, usesBeamAxisMoveSnap, manualColumnAnchorLines } = policy;

const TEST_IDS = ['plumbingTest', 'hvacTest'];
const CORE_MODES = ['floorplan', 'finish', 'ceiling', 'opening', 'structure', 'site', 'elevation', 'facade'];

function addCLOfKind(graph, project, value, kind) {
  switch (kind) {
    case 'struct': return project.structGraph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: true, discipline: Discipline.STRUCT });
    case 'center': return graph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.ARCH });
    case 'aux':    return graph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, lineType: 'dashed' });
    case 'beam':   return graph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.FUSE });
    default:       return graph.addCenterLine(CenterLineType.VERTICAL, value, { labeled: false, discipline: Discipline.CEILING });
  }
}

test('前提: 定義表の差し替えフックが 1 回当たり、試験用の 2 行が本番の導出に載っている（空振り防止）', () => {
  assert.equal(hookHits, 1);
  assert.deepEqual([...PLACED_FIGURE_MODE_IDS], TEST_IDS);
});

test('図面モード（試験 id）: APP_MODES・可視・描画・ヒットの公開関数が妥当な値を返す', () => {
  for (const id of TEST_IDS) {
    assert.equal(APP_MODES.includes(id), true, id);
    assert.equal(kindsVisibleIn(id).length, 0, `${id}: 操作対象なし`);
    assert.deepEqual([...kindsRenderedIn(id)], ['struct', 'center', 'aux'], `${id}: 表示だけ 3 種`);
    assert.equal(hitTestKinds(id).length, 0, `${id}: ヒット対象なし`);
  }
  assert.deepEqual([...APP_MODES], [...CORE_MODES, ...TEST_IDS]);
});

test('図面モード（試験 id）: 実 CL 5 種別で isRenderTarget は struct・center・aux だけ true、isHitTestTarget は全部 false', () => {
  const { project, graph } = makeSinglePlaneProject();
  CL_KINDS.forEach((kind, i) => {
    const cl = addCLOfKind(graph, project, (i + 1) * 1000, kind);
    for (const id of TEST_IDS) {
      assert.equal(isRenderTarget(cl, id), ['struct', 'center', 'aux'].includes(kind), `render ${kind}×${id}`);
      assert.equal(isHitTestTarget(cl, id), false, `hit ${kind}×${id}`);
      assert.equal(isAddDialogSnapOnlyRef(cl, id), false, `snapOnly ${kind}×${id}`);
      assert.equal(usesBeamAxisMoveSnap(cl, id), false, `beamMove ${kind}×${id}`);
    }
  });
});

test('【S7 で呼び出し側を確かめる印】manualColumnAnchorLines は図面モードを「未対応のappMode」で投げる（現状の挙動を固定）', () => {
  const { graph } = makeSinglePlaneProject();
  for (const id of TEST_IDS) {
    assert.throws(() => manualColumnAnchorLines(graph, id, { beamAxesAllowed: true }), /未対応のappMode/, id);
  }
});

test('既存 8 モードの kindsVisibleIn・kindsRenderedIn・hitTestKinds と 5 種別の kindsVisibleWith・moveSnapTargetKinds は、表が空のときと同じ', () => {
  // 期待値は centerLineKindPolicy.test.js の VISIBLE_KINDS_LITERAL・HIT_TEST_KINDS_LITERAL・天伏の描画と同じ値（非 export のため複写）。
  const visible = { floorplan: ['struct', 'center', 'aux'], finish: ['struct', 'center', 'aux'], ceiling: ['ceiling'],
    opening: ['struct', 'center', 'aux'], structure: ['struct', 'beam'], site: [], elevation: [], facade: [] };
  const hit = { ...visible, structure: ['beam'] };
  const rendered = { ...visible, ceiling: ['struct', 'center', 'aux', 'ceiling'] };
  for (const m of CORE_MODES) {
    assert.deepEqual([...kindsVisibleIn(m)], visible[m], `visible ${m}`);
    assert.deepEqual([...kindsRenderedIn(m)], rendered[m], `rendered ${m}`);
    assert.deepEqual([...hitTestKinds(m)], hit[m], `hit ${m}`);
  }
  const withKind = { struct: ['struct', 'center', 'aux', 'beam'], center: ['struct', 'center', 'aux'], aux: ['struct', 'center', 'aux'],
    beam: ['struct', 'beam'], ceiling: ['ceiling'] };
  const moveSnap = { struct: ['struct', 'center', 'aux'], center: ['struct', 'center', 'aux'], aux: ['struct', 'center', 'aux'],
    beam: ['struct', 'beam'], ceiling: ['ceiling'] };
  for (const k of CL_KINDS) {
    assert.deepEqual([...kindsVisibleWith(k)], withKind[k], `kindsVisibleWith ${k}`);
    assert.deepEqual([...moveSnapTargetKinds(k)], moveSnap[k], `moveSnapTargetKinds ${k}`);
  }
});

test('registry（試験 id）: isMode・labelOf・ceilingSubjectsOf', () => {
  assert.equal(PLACED_FIGURE_MODE_REGISTRY.isMode('plumbingTest'), true);
  assert.equal(PLACED_FIGURE_MODE_REGISTRY.isMode('floorplan'), false);
  assert.equal(PLACED_FIGURE_MODE_REGISTRY.labelOf('hvacTest'), '空調（試験）');
  assert.equal(PLACED_FIGURE_MODE_REGISTRY.labelOf('floorplan'), null);
  assert.equal(PLACED_FIGURE_MODE_REGISTRY.ceilingSubjectsOf('plumbingTest').length, 0);
  assert.deepEqual([...PLACED_FIGURE_MODE_REGISTRY.ceilingSubjectsOf('hvacTest')], [DetailSubject.HVAC, DetailSubject.ELECTRICAL]);
});
