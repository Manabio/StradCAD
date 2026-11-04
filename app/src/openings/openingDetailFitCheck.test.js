// openings/openingDetailFitCheck.js（三方枠の詳細図が寸法に合わせられないものの集計。建具モード・展開モードの init が使う）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { clearOverlays, setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND } from '../error.js';
import {
  DetailSlot, PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis, DetailDash,
  DETAIL_FIGURE_VERSION,
} from '../core/constants.js';
import { placeOpeningWithDefaults } from './openingEdit.js';
import { openingSectionWallRange, wallMaterialRangeForOpening } from './openingSection.js';
import { findHostWall, wallFaceRange } from './openingGeometry.js';
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
  // 三方枠でも片開き戸でもない建具（引き戸）に同じ記号が付いていても対象外
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [JAMB]: materialBoundFigure('df-chk-notframe') });
  const { graph, openings } = graphWithFrames(bad);
  runInAction(() => { openings[0].subType = 'sliding'; });
  assert.deepEqual(collectDetailFitFailures(graph), []);
});

// ---- 片開き戸（S8e-2）: 方立（平面）・上枠（展開の断面）の明示の割当てだけが対象 ----

test('片開き戸: 割当て無し（暗黙の既定）は通知の対象外', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const { graph } = graphWithFrames(sym, 1, [{ subType: 'singleSwing' }]);
  assert.deepEqual(collectDetailFitFailures(graph), []);
});

test('片開き戸: 明示の方立の図が fit できない → 平面の方立は面間の壁厚・上枠（方立の流用）は材の範囲の壁厚で、各 slot の行が出る', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-sw1') });
  const { graph, openings } = graphWithFrames(sym, 1, [{ subType: 'singleSwing' }]);
  const host = findHostWall(openings[0], graph);
  const [flo, fhi] = wallFaceRange(host, graph);
  const mr = wallMaterialRangeForOpening(openings[0], graph);
  const failures = collectDetailFitFailures(graph);
  assert.deepEqual(failures.map(f => f.slot).sort(), [HEAD, JAMB]);
  const byslot = Object.fromEntries(failures.map(f => [f.slot, f]));
  assert.deepEqual([byslot[JAMB].wallThickness, byslot[JAMB].faceWidth, byslot[JAMB].projection], [fhi - flo, 30, 12], '平面＝面間・見付は開口半幅で頭打ち（800 なので 30）');
  assert.deepEqual([byslot[HEAD].wallThickness, byslot[HEAD].faceWidth, byslot[HEAD].projection], [mr.hi - mr.lo, 30, 12], '断面＝材の範囲');
  assert.ok(byslot[HEAD].message.includes('上枠に合わせられません'));
});

test('片開き戸: 展開モードの slots=[HEAD] は上枠の行だけ・開口幅 50 の方立の見付は 25 に頭打ち', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-sw2') });
  const { graph } = graphWithFrames(sym, 1, [{ subType: 'singleSwing', width: 50 }]);
  assert.deepEqual(collectDetailFitFailures(graph, new Set(), { slots: [HEAD] }).map(f => f.slot), [HEAD]);
  assert.equal(collectDetailFitFailures(graph).find(f => f.slot === JAMB).faceWidth, 25);
});

// 壁・建具を手組みした最小の graph（graphList は graph.walls を読む）
const stubSwingGraph = (walls, over = {}) => {
  const axisCL = { id: 'cl1' };
  const opening = {
    id: 'o1', category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: 'AD', axisCL, isVertical: false,
    centerCoord: 500, width: 800, coord1: 100, coord2: 900, ...over,
  };
  return { openings: [opening], walls: walls.map(([lo, hi]) => ({ isVertical: false, axisCL, coord1: 0, coord2: 1000, materialRange: { lo, hi } })) };
};
// 壁厚が 80 以上でないと fit できない上枠（固定 80＋伸縮）。同じ通りに 60 厚の壁が 2 枚＝合併 120 では合うが 1 枚の 60 では合わない
const needs80Head = key => ({
  key, version: DETAIL_FIGURE_VERSION, label: '壁厚80以上の上枠',
  category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.HEAD,
  strokes: [{
    id: 'a', closed: true, line: { weightRole: 'medium', dashRole: DetailDash.SOLID },
    moves: [
      { dir: PenDir.RIGHT, len: { mm: 30, mode: DetailLenMode.FIXED } },
      { dir: PenDir.DOWN, len: { mm: 5, mode: DetailLenMode.FIXED } },
      { dir: PenDir.DOWN, len: { mm: 80, mode: DetailLenMode.FIXED } },
      { dir: PenDir.DOWN, len: { mm: 50, mode: DetailLenMode.STRETCH } },
      { dir: PenDir.LEFT, len: { mm: 30, mode: DetailLenMode.FIXED } },
    ],
  }],
  datums: [
    { id: 'ds0', role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 },
    { id: 'dt1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 },
  ],
  anchors: [
    { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
    { datumId: 'dt0', strokeId: 'a', vertexIndex: 2 },
    { datumId: 'dt1', strokeId: 'a', vertexIndex: 4 },
  ],
  provenance: null, note: null,
});

test('【失敗系】片開き戸: 上枠が合併の壁厚（60+60＝120）には合い、帯の壁 1 枚（60）には合わない → 上枠の行が 1 件（壁厚 60）', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [needs80Head('df-chk-sw-n80')] });
  const graph = stubSwingGraph([[0, 60], [60, 120]], { detailRefs: { [HEAD]: 'df-chk-sw-n80' } });
  const failures = collectDetailFitFailures(graph, new Set(), { slots: [HEAD] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].slot, HEAD);
  assert.equal(failures[0].wallThickness, 60);
  // 壁 1 枚が 100 厚なら合併も 100 で全部合う
  assert.deepEqual(collectDetailFitFailures(stubSwingGraph([[0, 100]], { detailRefs: { [HEAD]: 'df-chk-sw-n80' } }), new Set(), { slots: [HEAD] }), []);
});

test('【失敗系】片開き戸: 明示の割当てがあっても壁が引けない（壁なし・通りに壁なし・axisCL なし）なら空で例外も出ない', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [needs80Head('df-chk-sw-n80b')] });
  const refs = { detailRefs: { [HEAD]: 'df-chk-sw-n80b', [JAMB]: 'df-chk-sw-n80b' } };
  assert.deepEqual(collectDetailFitFailures(stubSwingGraph([], refs)), []);
  const other = stubSwingGraph([[0, 60]], refs);
  other.walls[0].axisCL = { id: 'other' };
  assert.deepEqual(collectDetailFitFailures(other), []);
  assert.deepEqual(collectDetailFitFailures(stubSwingGraph([[0, 60]], { ...refs, axisCL: null })), []);
});

// ---- 窓（S8f-2）: 方立（平面）の明示の割当てだけが対象。見付は jambWidthFor（窓 25） ----

test('窓: 明示の方立の図が壁厚に合わない → JAMB の行 1 件（見付 25・面間の壁厚・出 12）。FIX 窓（sashOpen）と外開き窓（notched）の両方', () => {
  for (const subType of ['fixed', 'casement']) {
    const sym = uniqueSymbolKey();
    installFrameSymbol(sym, { [JAMB]: materialBoundFigure(`df-chk-win-${subType}`) });
    const { graph, openings } = graphWithFrames(sym, 1, [{ category: OpeningCategory.WINDOW, subType }]);
    const [flo, fhi] = wallFaceRange(findHostWall(openings[0], graph), graph);
    const failures = collectDetailFitFailures(graph);
    assert.equal(failures.length, 1, subType);
    assert.equal(failures[0].slot, JAMB);
    assert.deepEqual([failures[0].wallThickness, failures[0].faceWidth, failures[0].projection], [fhi - flo, 25, 12], subType);
  }
});

test('窓: 割当て無し（暗黙の既定）は通知の対象外', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const { graph } = graphWithFrames(sym, 1, [{ category: OpeningCategory.WINDOW, subType: 'fixed' }]);
  assert.deepEqual(collectDetailFitFailures(graph), []);
});

test('【失敗系】窓: 引き違い窓（SLIDE_DOUBLE）は明示の割当てがあっても通知しない（対象外）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-win-sd') });
  const { graph } = graphWithFrames(sym, 1, [{ category: OpeningCategory.WINDOW, subType: 'doubleSliding' }]);
  assert.deepEqual(collectDetailFitFailures(graph), []);
});

test('【失敗系】窓: 種別の参照切れ（findCatalogEntry が null）は明示の方立があっても通知しない', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-win-gone') });
  const { graph } = graphWithFrames(sym, 1, [{ category: OpeningCategory.WINDOW, subType: 'no-such' }]);
  assert.deepEqual(collectDetailFitFailures(graph), []);
});

test('窓: 上枠は試さない（slots=[HEAD, FIGURE] で窓の行なし・全 slot でも JAMB だけ）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-chk-win-h') });
  const { graph } = graphWithFrames(sym, 1, [{ category: OpeningCategory.WINDOW, subType: 'fixed' }]);
  assert.deepEqual(collectDetailFitFailures(graph, new Set(), { slots: [HEAD, DetailSlot.FIGURE] }), []);
  assert.deepEqual(collectDetailFitFailures(graph).map(f => f.slot), [JAMB]);
});

test('【失敗系】窓: 明示の割当てがあっても壁が引けない（壁なし・axisCL なし）なら空で例外も出ない', () => {
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [needs80Head('df-chk-win-n80')] });
  const over = { category: OpeningCategory.WINDOW, subType: 'fixed', detailRefs: { [JAMB]: 'df-chk-win-n80' } };
  assert.deepEqual(collectDetailFitFailures(stubSwingGraph([], over)), []);
  assert.deepEqual(collectDetailFitFailures(stubSwingGraph([[0, 60]], { ...over, axisCL: null })), []);
});

test('片開き戸: 建具個別の detailRefs が参照切れ → 既定へ戻らず「見つかりません」の行（描画は従来）。fit できる図なら空', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const { graph } = graphWithFrames(sym, 1, [{ subType: 'singleSwing', detailRefs: { [HEAD]: 'df-chk-sw-gone' } }]);
  const failures = collectDetailFitFailures(graph);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].slot, HEAD);
  assert.equal(failures[0].label, 'df-chk-sw-gone');
  const ok = uniqueSymbolKey();
  installFrameSymbol(ok, { [JAMB]: jambFigure('df-chk-sw-ok'), [HEAD]: headFigure('df-chk-sw-ok-h') });
  assert.deepEqual(collectDetailFitFailures(graphWithFrames(ok, 1, [{ subType: 'singleSwing' }]).graph), []);
});
