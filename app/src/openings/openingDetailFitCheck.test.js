// openings/openingDetailFitCheck.js（三方枠の詳細図が寸法に合わせられないものの集計。建具モード・展開モードの init が使う）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND } from '../error.js';
import { DetailSlot } from '../core/constants.js';
import { placeOpeningWithDefaults } from './openingEdit.js';
import { openingSectionWallRange } from './openingSection.js';
import { collectDetailFitFailures } from './openingDetailFitCheck.js';
import { jambFigure, headFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol } from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const JAMB = DetailSlot.JAMB;
const HEAD = DetailSlot.HEAD;

// 4000×3000 の部屋の壁を持つグラフ。三方枠を n 個、壁の別の位置へ置いて symbolKey の記号にする。
function graphWithFrames(symbolKey, count = 1, props = []) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 4000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  generateRoomWallsFromOutline(graph, graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK'));
  const project = { openingNumberIndex: new Map() };
  const wall = [...graph.walls].find(w => !w.isVertical);
  const openings = [];
  for (let i = 0; i < count; i += 1) {
    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 800 + i * 1200, y: 0 }, OpeningCategory.FITTING);
    assert.ok(opening && !error, `前提: 開口を配置できるはず（${error}）`);
    runInAction(() => { Object.assign(opening, { subType: 'threeSidedFrame', fixtureType: symbolKey, width: 800, ...(props[i] ?? {}) }); });
    openings.push(opening);
  }
  return { graph, openings };
}

test('集計: 材束縛の図（常に fit 不可）を割り当てた三方枠は1件の失敗になり、文言・寸法（壁厚・出幅・見付）を持つ', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-1') });
  const { graph, openings } = graphWithFrames(sym);
  const range = openingSectionWallRange(openings[0], graph);
  assert.ok(range, '前提: ホスト壁の面が引ける');
  const failures = collectDetailFitFailures(graph);
  // jamb だけの割当て: 平面（見付20）と展開の上枠（jamb 流用・見付20）は同じ寸法なので1件
  assert.equal(failures.length, 1);
  const [f] = failures;
  assert.equal(f.symbolKey, sym);
  assert.equal(f.slot, JAMB);
  assert.equal(f.label, '材束縛の方立');
  assert.equal(f.wallThickness, range.hi - range.lo);
  assert.deepEqual([f.projection, f.faceWidth], [12, 20]);
  assert.ok(f.reason.includes('101000000001'), f.reason);
  assert.equal(f.message, ERR_DETAIL_FIT_FAILED(f.label, sym, f.reason, JAMB));
  assert.ok(f.message.startsWith(`詳細図 材束縛の方立 を ${sym} の方立（縦枠）に合わせられません: `), f.message);
});

test('集計: 同じ（図のキー・slot・壁厚・出幅・見付）の組は1件にまとまり、出幅を変えた建具は別の組になる', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-2') });
  const { graph } = graphWithFrames(sym, 3, [{}, {}, { frameProjection: 30 }]);
  const failures = collectDetailFitFailures(graph);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map(f => f.projection).sort((a, b) => a - b), [12, 30]);
  assert.equal(new Set(failures.map(f => f.key)).size, 2);
});

test('集計: seen を共有すると階をまたいでも同じ組は1回だけ（2回目は空）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-3') });
  const a = graphWithFrames(sym).graph;
  const b = graphWithFrames(sym).graph;
  const seen = new Set();
  assert.equal(collectDetailFitFailures(a, seen).length, 1);
  assert.equal(collectDetailFitFailures(b, seen).length, 0, '同じ寸法の別階は重複しない');
  assert.equal(collectDetailFitFailures(b).length, 1, 'seen を渡さなければ独立に数える');
});

test('集計: head の図だけが失敗するとき slot は head（展開の上枠）、jamb が通れば平面側の失敗は出ない', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-4j'), [HEAD]: { ...materialBoundFigure('df-chk-4h'), view: 'section', subject: 'head' } });
  const failures = collectDetailFitFailures(graphWithFrames(sym).graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].slot, HEAD);
  assert.ok(failures[0].message.includes(`${sym} の上枠に合わせられません`), '文言に枠の名前（上枠）が入る');
});

test('集計: slots を [HEAD] に絞ると展開が実際に使う図だけ試す（jamb が材束縛でも head が正常なら失敗なし）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-6j'), [HEAD]: headFigure('df-chk-6h') });
  const { graph } = graphWithFrames(sym);
  assert.equal(collectDetailFitFailures(graph).length, 1, '既定は両方試す＝平面の方立が失敗');
  assert.deepEqual(collectDetailFitFailures(graph, new Set(), { slots: [HEAD] }), [], '展開は head の図を使うので失敗なし');
  const jambOnly = uniqueSymbolKey();
  installFrameSymbol(jambOnly, { [JAMB]: materialBoundFigure('df-chk-6j2') });
  const failures = collectDetailFitFailures(graphWithFrames(jambOnly).graph, new Set(), { slots: [HEAD] });
  assert.equal(failures.length, 1, 'head が無ければ jamb の流用を試す＝失敗');
  assert.equal(failures[0].slot, HEAD);
});

test('集計: head の参照が切れていて jamb の図が実在すれば、行は head の「見つかりません」1件（描画は jamb を流用）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-7j'), [HEAD]: headFigure('df-chk-7h') },
    { installFigures: false, extraFigures: [jambFigure('df-chk-7j')] });
  const failures = collectDetailFitFailures(graphWithFrames(sym).graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, 'df-chk-7h');
  assert.equal(failures[0].slot, HEAD);
  assert.equal(failures[0].reason, ERR_DETAIL_FIGURE_NOT_FOUND(sym, HEAD));
  assert.match(failures[0].reason, /上枠の詳細図がカタログに見つかりません（DXF・PDF 由来の図は保存ファイルに入らないため、別の端末では見つかりません）$/);
});

test('集計: 参照切れの記号を出幅違いの 2 建具に付けても not-found 行は 1 件（鍵に寸法を含めない）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-9') }, { installFigures: false });
  const { graph } = graphWithFrames(sym, 2, [{}, { frameProjection: 30, frameFaceWidth: 30 }]);
  const failures = collectDetailFitFailures(graph);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].key.startsWith('notFound|'), failures[0].key);
});

test('集計: detailRefs の参照が切れていれば文言は建具個別の指定を指す（記号の図は実在しても記号のせいにしない）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-10') });
  const { graph } = graphWithFrames(sym, 1, [{ detailRefs: { [JAMB]: 'df-chk-gone2' } }]);
  const failures = collectDetailFitFailures(graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, 'df-chk-gone2');
  assert.equal(failures[0].reason, '建具個別の指定 の方立（縦枠）の詳細図がカタログに見つかりません（DXF・PDF 由来の図は保存ファイルに入らないため、別の端末では見つかりません）');
  assert.ok(!failures[0].reason.includes(sym));
});

test('集計: 建具個別の detailRefs が記号の割当てより優先して試される（記号は正常・detailRefs の図が材束縛 → 失敗）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-8j') }, { extraFigures: [materialBoundFigure('df-chk-8bad')] });
  assert.deepEqual(collectDetailFitFailures(graphWithFrames(sym).graph), []);
  const { graph } = graphWithFrames(sym, 1, [{ detailRefs: { [JAMB]: 'df-chk-8bad' } }]);
  const failures = collectDetailFitFailures(graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, '材束縛の方立');
});

test('集計: 見付の頭打ちが平面（開口幅の半分）と展開（開口高さの半分）で違うと、別の組として試す', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-5') });
  // 見付 600・幅 800・高さ 600: 平面は min(600, 幅/2=400)=400、展開は min(min(600, 400), 高さ/2=300)=300。
  const { graph } = graphWithFrames(sym, 1, [{ frameFaceWidth: 600, height: 600 }]);
  const failures = collectDetailFitFailures(graph);
  assert.deepEqual(failures.map(f => f.faceWidth).sort((a, b) => a - b), [300, 400]);
});

test('【失敗系】集計: 参照先の図がカタログに無い記号は「見つかりません」として失敗に数える（参照キーが label）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-chk-gone') }, { installFigures: false });
  const failures = collectDetailFitFailures(graphWithFrames(sym).graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, 'df-chk-gone');
  assert.equal(failures[0].reason, ERR_DETAIL_FIGURE_NOT_FOUND(sym, JAMB));
});

test('集計: fit できる図・割当て無しの記号・三方枠でない建具・graph が無い場合は空', () => {
  const ok = uniqueSymbolKey();
  installFrameSymbol(ok, { [JAMB]: jambFigure('df-chk-ok'), [HEAD]: headFigure('df-chk-ok-h') });
  assert.deepEqual(collectDetailFitFailures(graphWithFrames(ok).graph), []);
  const none = uniqueSymbolKey();
  installFrameSymbol(none, {});
  assert.deepEqual(collectDetailFitFailures(graphWithFrames(none).graph), []);
  assert.deepEqual(collectDetailFitFailures(null), []);
  assert.deepEqual(collectDetailFitFailures({ openings: [] }), []);
  // 三方枠でない建具（片開き戸）に同じ記号が付いていても対象外
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [JAMB]: materialBoundFigure('df-chk-notframe') });
  const { graph, openings } = graphWithFrames(bad);
  runInAction(() => { openings[0].subType = 'singleSwing'; });
  assert.deepEqual(collectDetailFitFailures(graph), []);
});
