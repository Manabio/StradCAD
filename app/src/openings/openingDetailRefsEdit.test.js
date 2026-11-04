// 建具エディタの部分詳細図の上書き欄（openings/openingDetailRefsEdit.js）と、その永続・undo・枝番・参照切れの結合テスト（S6a）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable, runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { DetailSlot, SWING_LEAF_SUBTYPE, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY } from '../core/constants.js';
import { withDetailRef } from '../core/detailRefs.js';
import { undoManager } from '../undoManager.js';
import { clearOverlays, setOverlay, composeCatalog } from '../catalog/catalogRegistry.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { collectUsedKeysByKind, expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively } from '../catalog/usedEntries.js';
import { resolveDetailFrame } from './openingDetailFit.js';
import { withOpeningUndo, removeOpeningWithUndo } from './openingEdit.js';
import { openingSubSignature, openingSignature } from './openingNumbering.js';
import { collectDetailFitFailures } from './openingDetailFitCheck.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import {
  openingDetailRefSelects, detailRefsAfterSelect, detailDimensionsToCopy, OPENING_DETAIL_REF_SLOTS, frameDetailSlotsApply,
} from './openingDetailRefsEdit.js';
import {
  jambFigure, headFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol, elevationFigure, subTypeEntry, installElevationFigures,
} from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const { JAMB, HEAD } = DetailSlot;

function makeFrameGraph(props = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clEnd = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const opening = graph.addOpening(axisCL, 1, false, clStart, 1000, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: 'WF', ...props }, 'op0');
  return { graph, opening, project: { openingNumberIndex: observable.map() } };
}

test('select: 三方枠は方立・上枠・姿図の 3 つ。先頭は「記号の設定を使う」（姿図は建具種別）、図は slot に合うものだけ、現在値は value に出る', () => {
  const list = [
    { key: 'df-j', label: '方立A', category: 'paired', view: 'plan', subject: 'jamb' },
    { key: 'df-h', label: '上枠A', category: 'paired', view: 'section', subject: 'head' },
    { key: 'df-f', label: '姿図A', category: 'figure', view: 'elevation', subject: 'opening' },
  ];
  const sels = openingDetailRefSelects({ detailRefs: { [JAMB]: 'df-j' } }, list);
  assert.deepEqual(sels.map(s => s.slot), [...OPENING_DETAIL_REF_SLOTS]);
  assert.deepEqual(OPENING_DETAIL_REF_SLOTS, [JAMB, HEAD, DetailSlot.FIGURE]);
  assert.deepEqual(sels.map(s => s.label), ['部分詳細図（方立）', '部分詳細図（上枠）', '部分詳細図（姿図）']);
  assert.deepEqual(sels[0].options.map(o => o.value), ['', 'df-j']);
  assert.deepEqual(sels[1].options.map(o => o.value), ['', 'df-h']);
  assert.deepEqual(sels[2].options.map(o => o.value), ['', 'df-f'], '姿図は figure/elevation/opening の図だけ');
  assert.equal(sels[0].options[0].label, '記号の設定を使う');
  assert.equal(sels[2].options[0].label, '建具種別の設定を使う');
  assert.equal(sels[0].value, 'df-j');
  assert.equal(sels[1].value, '');
});

test('select: 三方枠・片開き戸以外（frameSlots:false）は姿図の select だけ。frameSlots:true なら方立・上枠・姿図の 3 本', () => {
  const sels = openingDetailRefSelects({ detailRefs: { [DetailSlot.FIGURE]: 'df-f' } }, [], { frameSlots: false });
  assert.deepEqual(sels.map(s => s.slot), [DetailSlot.FIGURE]);
  assert.equal(sels[0].value, 'df-f');
  assert.match(sels[0].options.at(-1).label, /見つかりません/, '参照切れは黙って未上書きに見せない');
  const withFrame = openingDetailRefSelects({ detailRefs: null }, [], { frameSlots: true });
  assert.deepEqual(withFrame.map(s => s.slot), [DetailSlot.JAMB, DetailSlot.HEAD, DetailSlot.FIGURE]);
});

test('frameDetailSlotsApply: 三方枠か片開き戸（singleSwing）で真・sliding と null で偽', () => {
  assert.equal(frameDetailSlotsApply({ subType: SWING_LEAF_SUBTYPE }, false), true);
  assert.equal(frameDetailSlotsApply({ subType: 'sliding' }, true), true);
  assert.equal(frameDetailSlotsApply({ subType: 'sliding' }, false), false);
  assert.equal(frameDetailSlotsApply(null, false), false);
  const slotsOf = o => openingDetailRefSelects(o, [], { frameSlots: frameDetailSlotsApply(o, false) }).map(s => s.slot);
  assert.deepEqual(slotsOf({ subType: SWING_LEAF_SUBTYPE, detailRefs: null }), [DetailSlot.JAMB, DetailSlot.HEAD, DetailSlot.FIGURE]);
  assert.deepEqual(slotsOf({ subType: 'sliding', detailRefs: null }), [DetailSlot.FIGURE]);
});

test('detailRefsAfterSelect（S8e-3）: 片開き戸は記号の割当て無しなら組込みの既定キーへ畳む。他の図は残す・片開き戸以外は畳まない', () => {
  const swing = { subType: SWING_LEAF_SUBTYPE, detailRefs: null };
  assert.equal(detailRefsAfterSelect(swing, JAMB, DETAIL_BUILTIN_DOOR_JAMB_KEY), null);
  assert.equal(detailRefsAfterSelect(swing, HEAD, DETAIL_BUILTIN_DOOR_HEAD_KEY), null);
  assert.deepEqual(detailRefsAfterSelect(swing, JAMB, 'df-other'), { [JAMB]: 'df-other' });
  assert.deepEqual(detailRefsAfterSelect(swing, JAMB, DETAIL_BUILTIN_DOOR_HEAD_KEY), { [JAMB]: DETAIL_BUILTIN_DOOR_HEAD_KEY }, '別 slot の既定キーは畳まない');
  const other = { subType: 'sliding', detailRefs: null };
  assert.deepEqual(detailRefsAfterSelect(other, JAMB, DETAIL_BUILTIN_DOOR_JAMB_KEY), { [JAMB]: DETAIL_BUILTIN_DOOR_JAMB_KEY });
});

test('【失敗系】select: 無いキーを持つ建具は「見つかりません」の行を足し、黙って未上書きに見せない。上書き無しは value が空', () => {
  const sels = openingDetailRefSelects({ detailRefs: { [JAMB]: 'df-gone' } }, []);
  assert.equal(sels[0].value, 'df-gone');
  assert.equal(sels[0].options.at(-1).value, 'df-gone');
  assert.match(sels[0].options.at(-1).label, /見つかりません/);
  const none = openingDetailRefSelects({ detailRefs: null }, []);
  assert.deepEqual(none.map(s => s.value), ['', '', '']);
});

test('detailRefsAfterSelect: 選ぶ・差し替える・空で外す。最後の 1 件を外すと null。元は変えない', () => {
  const o = { detailRefs: null };
  const a = detailRefsAfterSelect(o, JAMB, 'df-1');
  assert.deepEqual(a, { [JAMB]: 'df-1' });
  assert.equal(o.detailRefs, null);
  assert.deepEqual(detailRefsAfterSelect({ detailRefs: a }, HEAD, 'df-2'), { [HEAD]: 'df-2', [JAMB]: 'df-1' });
  assert.equal(detailRefsAfterSelect({ detailRefs: a }, JAMB, ''), null);
});

test('S6b detailRefsAfterSelect(figure): 建具種別の割当てと同じキーを選ぶと上書きとして持たず外す（キーが一致するときだけ）。方立・上枠の上書きとは独立', () => {
  installElevationFigures([elevationFigure('df-f1'), elevationFigure('df-f2', { dashX: 150 })], [subTypeEntry('user1', 'df-f1')]);
  const o = { category: 'fitting', subType: 'user1', detailRefs: null };
  assert.equal(detailRefsAfterSelect(o, DetailSlot.FIGURE, 'df-f1'), null, '建具種別の図と同じキーは畳む');
  assert.deepEqual(detailRefsAfterSelect(o, DetailSlot.FIGURE, 'df-f2'), { [DetailSlot.FIGURE]: 'df-f2' });
  const withJamb = { ...o, detailRefs: { [JAMB]: 'df-j' } };
  assert.deepEqual(detailRefsAfterSelect(withJamb, DetailSlot.FIGURE, 'df-f2'), { [JAMB]: 'df-j', [DetailSlot.FIGURE]: 'df-f2' });
  assert.deepEqual(detailRefsAfterSelect(withJamb, DetailSlot.FIGURE, 'df-f1'), { [JAMB]: 'df-j' }, '畳んでも他 slot の上書きは残す');
  const plain = { category: 'fitting', subType: 'singleSwing', detailRefs: null };
  assert.deepEqual(detailRefsAfterSelect(plain, DetailSlot.FIGURE, 'df-f1'), { [DetailSlot.FIGURE]: 'df-f1' }, '建具種別に割当てが無ければ畳まない');
  assert.equal(detailRefsAfterSelect({ detailRefs: { [DetailSlot.FIGURE]: 'df-f2' } }, DetailSlot.FIGURE, ''), null, '空で外す');
  clearOverlays();
});

test('R16 detailDimensionsToCopy: 解決後の方立の図の param 束縛（見付 20・出幅 12）を建具の項目名で返す。建具の上書きが記号に勝つ', () => {
  const sym = uniqueSymbolKey();
  const other = jambFigure('df-r16-o', { label: '別の方立' });
  other.strokes[0].moves = other.strokes[0].moves.map(m => (m.len.param === 'frameFaceWidth' ? { ...m, len: { ...m.len, mm: 35 } } : m));
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-r16-s') }, { extraFigures: [other] });
  const { opening } = makeFrameGraph({ fixtureType: sym });
  assert.deepEqual(detailDimensionsToCopy(opening), { frameFaceWidth: 20, frameProjection: 12 });
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-r16-o'); });
  assert.deepEqual(detailDimensionsToCopy(opening), { frameFaceWidth: 35, frameProjection: 12 }, '建具の上書きが記号に勝つ');
});

test('【失敗系】R16 detailDimensionsToCopy: 図が未割当て・参照切れ・param 束縛が無い図は null（ボタン無効）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const { opening } = makeFrameGraph({ fixtureType: sym });
  assert.equal(detailDimensionsToCopy(opening), null, '未割当て');
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-nowhere'); });
  assert.equal(detailDimensionsToCopy(opening), null, '参照切れ');
  const fixedOnly = jambFigure('df-r16-fixed');
  fixedOnly.strokes[0].moves = fixedOnly.strokes[0].moves.map(m => (m.len.mode === 'param' ? { ...m, len: { mm: m.len.mm, mode: 'fixed' } } : m));
  installFrameSymbol(sym, { [JAMB]: fixedOnly });
  runInAction(() => { opening.detailRefs = null; });
  assert.equal(detailDimensionsToCopy(opening), null, 'param 束縛が無い図');
});

test('undo: 建具の編集で detailRefs を変え、undo で戻り redo でやり直せる。見付・出幅の書き込みも同じ 1 手', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-undo') });
  const { graph, opening, project } = makeFrameGraph({ fixtureType: sym });
  withOpeningUndo(graph, project, opening, () => runInAction(() => {
    opening.detailRefs = detailRefsAfterSelect(opening, HEAD, 'df-undo-h');
    opening.frameFaceWidth = 33;
  }));
  assert.deepEqual(opening.detailRefs, { [HEAD]: 'df-undo-h' });
  undoManager.undo();
  assert.equal(opening.detailRefs, null);
  assert.equal(opening.frameFaceWidth, null);
  undoManager.redo();
  assert.deepEqual(opening.detailRefs, { [HEAD]: 'df-undo-h' });
  assert.equal(opening.frameFaceWidth, 33);
});

test('undo: 変化が無い選択（未上書きのまま空を選ぶ）は undo エントリを積まない', () => {
  const { graph, opening, project } = makeFrameGraph();
  const before = undoManager.peekUndo();
  withOpeningUndo(graph, project, opening, () => runInAction(() => {
    opening.detailRefs = detailRefsAfterSelect(opening, JAMB, '');
  }));
  assert.equal(undoManager.peekUndo(), before);
});

test('保存往復: detailRefs を持つ建具は serialize→restore で保たれる', () => {
  const { graph, opening } = makeFrameGraph();
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-swap'); });
  const restored = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(restored, serializeGraph(graph));
  assert.deepEqual(restored.openings[0].detailRefs, { [JAMB]: 'df-swap' });
});

test('R15: detailRefs を変えても openingSubSignature・openingSignature（枝番・タグ）は動かない', () => {
  const { opening } = makeFrameGraph();
  const sub = openingSubSignature(opening);
  const full = openingSignature(opening);
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-r15'); });
  assert.equal(openingSubSignature(opening), sub);
  assert.equal(openingSignature(opening), full);
});

test('【失敗系】参照切れ: 無いキーを detailRefs に持つ文書を開くと、保存往復後の集計で not-found が 1 件出て、詳細図の反映は null（＝既定 profile で描く）を返し例外にならない', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const { graph, opening } = makeFrameGraph({ fixtureType: sym });
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-gone'); });
  const reopened = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  restoreGraph(reopened, serializeGraph(graph));
  const failures = collectDetailFitFailures(reopened, new Set(), { slots: [JAMB] });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].label, 'df-gone');
  assert.match(failures[0].message, /建具個別の指定/);
  const frame = resolveDetailFrame({
    symbolKey: sym, detailRefs: reopened.openings[0].detailRefs, slot: JAMB,
    coord1: 0, coord2: 100, faceMin: 0, wallThickness: 120, faceWidth: 20, projection: 12,
  });
  assert.equal(frame, null, '参照先が無ければ詳細図は使わず、従来の描き方（frameOnlyJambProfiles の既定）へ戻る');
});

test('畳み: 選んだキーが記号の同じ slot のキーと一致するときだけ上書きを外す（記号 jamb=df-1 で df-1 を選ぶと null、df-2 を選ぶと {jamb:df-2}）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-1') }, { extraFigures: [jambFigure('df-2', { label: '別の方立' })] });
  const { opening } = makeFrameGraph({ fixtureType: sym });
  assert.equal(detailRefsAfterSelect(opening, JAMB, 'df-1'), null);
  assert.deepEqual(detailRefsAfterSelect(opening, JAMB, 'df-2'), { [JAMB]: 'df-2' });
  // 別 slot のキーとは畳まない（head に df-1 を選んでも記号の head は無いので上書きとして残る）
  assert.deepEqual(detailRefsAfterSelect(opening, HEAD, 'df-1'), { [HEAD]: 'df-1' });
  // 既に上書きがあるとき、記号と同じキーを選ぶとその slot だけ外れる
  runInAction(() => { opening.detailRefs = withDetailRef(withDetailRef(null, JAMB, 'df-2'), HEAD, 'df-h'); });
  assert.deepEqual(detailRefsAfterSelect(opening, JAMB, 'df-1'), { [HEAD]: 'df-h' });
});

test('undo（削除経由）: 建具を削除→undo で detailRefs が戻り、redo→undo でも戻る', () => {
  const { graph, opening, project } = makeFrameGraph();
  runInAction(() => { opening.detailRefs = withDetailRef(null, JAMB, 'df-x'); });
  removeOpeningWithUndo(graph, project, opening);
  assert.equal(graph.openings.length, 0);
  undoManager.undo();
  assert.deepEqual(graph.openings[0].detailRefs, { [JAMB]: 'df-x' });
  undoManager.redo();
  assert.equal(graph.openings.length, 0);
  undoManager.undo();
  assert.deepEqual(graph.openings[0].detailRefs, { [JAMB]: 'df-x' });
});

test('同梱: 記号からは参照されず opening.detailRefs だけが指す図とその材が、文書の同梱（detailFigure・material）に入る', () => {
  const MAT = '101000000001';
  setOverlay(CatalogKind.MATERIAL, { user: [{ code: MAT, name: '試験材', spec: '', x: 0, y: 0, thickness: 12.5, note: '', category: 'panel' }] });
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [materialBoundFigure('df-only-opening'), jambFigure('df-unused', { label: '未使用の方立' })] });
  const used = collectUsedKeysByKind([{ openings: [{ id: 'o1', fixtureType: 'WF', detailRefs: { [JAMB]: 'df-only-opening' } }] }],
    [CatalogKind.MATERIAL, CatalogKind.FIXTURE_SYMBOL, CatalogKind.DETAIL_FIGURE]);
  const resolved = new Map([CatalogKind.MATERIAL, CatalogKind.FIXTURE_SYMBOL, CatalogKind.DETAIL_FIGURE]
    .map(k => [k, composeCatalog(k, [])]));
  const expanded = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(used, resolved), resolved);
  assert.deepEqual([...expanded.get(CatalogKind.DETAIL_FIGURE)], ['df-only-opening']);
  assert.ok(expanded.get(CatalogKind.MATERIAL).has(MAT), '図が束縛する材も同梱される');
  assert.ok(!expanded.get(CatalogKind.DETAIL_FIGURE).has('df-unused'), '未使用の図は入らない');
});

test('headFigure が上枠の選択肢に出る（slot の分類に合う）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {}, { extraFigures: [headFigure('df-hd')] });
  const sels = openingDetailRefSelects({ detailRefs: null });
  assert.ok(sels[1].options.some(o => o.value === 'df-hd'));
  assert.ok(!sels[0].options.some(o => o.value === 'df-hd'));
});
