// 建具エディタの部分詳細図の上書き欄（openings/openingDetailRefsEdit.js）と、その永続・undo・枝番・参照切れの結合テスト（S6a）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable, runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import {
  DetailSlot, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD, SWING_LEAF_SUBTYPE, DETAIL_BUILTIN_DOOR_JAMB_KEY, DETAIL_BUILTIN_DOOR_HEAD_KEY,
  DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY, DETAIL_BUILTIN_WINDOW_JAMB_KEY,
  DETAIL_BUILTIN_WINDOW_HEAD_KEY, DETAIL_BUILTIN_WINDOW_SILL_KEY,
} from '../core/constants.js';
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
  openingDetailRefSelects, detailRefsAfterSelect, detailDimensionsToCopy, OPENING_DETAIL_REF_SLOTS, frameDetailSlotsFor,
} from './openingDetailRefsEdit.js';
import { OpeningMechanism } from './openingCatalog.js';
import {
  jambFigure, headFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol, elevationFigure, subTypeEntry, installElevationFigures,
} from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const { JAMB, HEAD, SILL } = DetailSlot;

function makeFrameGraph(props = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clEnd = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const opening = graph.addOpening(axisCL, 1, false, clStart, 1000, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: 'WF', ...props }, 'op0');
  return { graph, opening, project: { openingNumberIndex: observable.map() } };
}

test('select: 枠 slot 全部を出すと方立・上枠・下枠・姿図・姿図（向こう側）の 5 つ。先頭は「記号の設定を使う」（姿図は建具種別）、図は slot に合うものだけ、現在値は value に出る', () => {
  const list = [
    { key: 'df-j', label: '方立A', category: 'paired', view: 'plan', subject: 'jamb' },
    { key: 'df-h', label: '上枠A', category: 'paired', view: 'section', subject: 'head' },
    { key: 'df-s', label: '下枠A', category: 'paired', view: 'section', subject: 'sill' },
    { key: 'df-f', label: '姿図A', category: 'figure', view: 'elevation', subject: 'opening' },
  ];
  const sels = openingDetailRefSelects({ detailRefs: { [JAMB]: 'df-j' } }, list);
  assert.deepEqual(sels.map(s => s.slot), [...OPENING_DETAIL_REF_SLOTS]);
  assert.deepEqual(OPENING_DETAIL_REF_SLOTS, [JAMB, HEAD, SILL, DetailSlot.FIGURE, DetailSlot.FIGURE_BACK]);
  assert.deepEqual(sels.map(s => s.label), ['部分詳細図（方立）', '部分詳細図（上枠）', '部分詳細図（下枠）', '部分詳細図（姿図）', '部分詳細図（姿図・向こう側）']);
  assert.deepEqual(sels[0].options.map(o => o.value), ['', 'df-j']);
  assert.deepEqual(sels[1].options.map(o => o.value), ['', 'df-h']);
  assert.deepEqual(sels[2].options.map(o => o.value), ['', 'df-s'], '下枠は section/sill の図だけ（上枠の図は出ない）');
  assert.deepEqual(sels[3].options.map(o => o.value), ['', 'df-f'], '姿図は figure/elevation/opening の図だけ');
  assert.equal(sels[0].options[0].label, '記号の設定を使う');
  assert.equal(sels[3].options[0].label, '建具種別の設定を使う');
  assert.deepEqual(sels[4].options.map(o => o.value), ['', 'df-f'], '向こう側の姿図も姿図と同じ候補');
  assert.equal(sels[4].options[0].label, '建具種別の設定を使う');
  assert.equal(sels[0].value, 'df-j');
  assert.equal(sels[1].value, '');
});

test('select: frameSlots が空なら姿図の select だけ。省略なら 4 本・[JAMB, HEAD] なら 3 本・[JAMB] なら方立と姿図の 2 本。SILL は frameSlots に無ければ出ない', () => {
  const sels = openingDetailRefSelects({ detailRefs: { [DetailSlot.FIGURE]: 'df-f' } }, [], { frameSlots: [] });
  assert.deepEqual(sels.map(s => s.slot), [DetailSlot.FIGURE, DetailSlot.FIGURE_BACK]);
  assert.equal(sels[0].value, 'df-f');
  assert.match(sels[0].options.at(-1).label, /見つかりません/, '参照切れは黙って未上書きに見せない');
  const both = [DetailSlot.JAMB, DetailSlot.HEAD, DetailSlot.FIGURE, DetailSlot.FIGURE_BACK];
  assert.deepEqual(openingDetailRefSelects({ detailRefs: null }, [], { frameSlots: [JAMB, HEAD] }).map(s => s.slot), both);
  assert.deepEqual(openingDetailRefSelects({ detailRefs: null }, []).map(s => s.slot), [JAMB, HEAD, SILL, DetailSlot.FIGURE, DetailSlot.FIGURE_BACK], '省略時は枠 slot 全部');
  assert.equal(openingDetailRefSelects({ detailRefs: null }, [], { frameSlots: [JAMB, HEAD] }).some(s => s.slot === SILL), false, '下枠は建具に漏れない');
  assert.deepEqual(openingDetailRefSelects({ detailRefs: null }, [], { frameSlots: [JAMB] }).map(s => s.slot), [JAMB, DetailSlot.FIGURE, DetailSlot.FIGURE_BACK]);
});

test('frameDetailSlotsFor（S8f-3c）: 三方枠・片開き戸＝方立と上枠／窓＝方立・上枠・下枠（引き違い窓は方立なし・掃き出し窓は下枠なし）／他・機構未指定／実装外の窓＝空', () => {
  const win = (subType, sillHeight = 800) => ({ category: OpeningCategory.WINDOW, subType, sillHeight });
  assert.deepEqual(frameDetailSlotsFor({ subType: 'threeSidedFrame' }, true, OpeningMechanism.FRAME_ONLY), [JAMB, HEAD]);
  assert.deepEqual(frameDetailSlotsFor({ category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE }, false, OpeningMechanism.SWING), [JAMB, HEAD], '片開き戸に下枠は出ない');
  assert.deepEqual(frameDetailSlotsFor(win('fixed'), false, OpeningMechanism.FIXED), [JAMB, HEAD, SILL]);
  assert.deepEqual(frameDetailSlotsFor(win('casement'), false, OpeningMechanism.SWING), [JAMB, HEAD, SILL]);
  assert.deepEqual(frameDetailSlotsFor(win('doubleSliding'), false, OpeningMechanism.SLIDE_DOUBLE), [HEAD, SILL], '引き違い窓は方立なし');
  assert.deepEqual(frameDetailSlotsFor(win('fixed', 0), false, OpeningMechanism.FIXED), [JAMB, HEAD], '掃き出し窓（窓台 0）は下枠を描かないので出さない');
  assert.deepEqual(frameDetailSlotsFor(win('doubleSliding', 0), false, OpeningMechanism.SLIDE_DOUBLE), [HEAD]);
  assert.deepEqual(frameDetailSlotsFor({ category: OpeningCategory.FITTING, subType: 'sliding' }, false, OpeningMechanism.SLIDE_SINGLE), [], '引き戸');
  assert.deepEqual(frameDetailSlotsFor(win('fixed'), false, undefined), [], '機構未指定（種別の参照切れ）の窓は描画に方立が出ないので対象外');
  assert.deepEqual(frameDetailSlotsFor(win('fixed'), false, 'noSuchMechanism'), [], '実装外の機構の窓も対象外');
  assert.deepEqual(frameDetailSlotsFor({ category: OpeningCategory.FITTING, subType: 'x' }, false, undefined), [], '窓でも片開き戸でもない建具は機構によらず空');
  assert.deepEqual(frameDetailSlotsFor(null, false, undefined), []);
  const slotsOf = (o, mech) => openingDetailRefSelects(o, [], { frameSlots: frameDetailSlotsFor(o, false, mech) }).map(s => s.slot);
  const { FIGURE: FIG, FIGURE_BACK: FIG_BACK } = DetailSlot;
  assert.deepEqual(slotsOf({ ...win('fixed'), detailRefs: null }, OpeningMechanism.FIXED), [JAMB, HEAD, SILL, FIG, FIG_BACK], '窓は 5 本');
  assert.deepEqual(slotsOf({ ...win('doubleSliding'), detailRefs: null }, OpeningMechanism.SLIDE_DOUBLE), [HEAD, SILL, FIG, FIG_BACK], '引き違い窓は 4 本');
  assert.deepEqual(slotsOf({ ...win('fixed', 0), detailRefs: null }, OpeningMechanism.FIXED), [JAMB, HEAD, FIG, FIG_BACK], '掃き出し窓は 4 本');
  assert.deepEqual(slotsOf({ category: OpeningCategory.FITTING, subType: 'sliding', detailRefs: null }, OpeningMechanism.SLIDE_SINGLE), [FIG, FIG_BACK], '建具は姿図だけ（下枠が漏れない）');
  assert.deepEqual(slotsOf({ category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE, detailRefs: null }, OpeningMechanism.SWING), [JAMB, HEAD, FIG, FIG_BACK], '片開き戸に下枠は出ない');
});

test('detailRefsAfterSelect（S8f-3c）: 窓は組込みの下枠・上枠キーを選んでも上書きにならない。別キーは残り、掃き出し窓の下枠・窓でない建具は畳まない', () => {
  const win = { category: OpeningCategory.WINDOW, subType: 'fixed', sillHeight: 800, detailRefs: null };
  assert.equal(detailRefsAfterSelect(win, SILL, DETAIL_BUILTIN_WINDOW_SILL_KEY, OpeningMechanism.FIXED), null);
  assert.equal(detailRefsAfterSelect(win, HEAD, DETAIL_BUILTIN_WINDOW_HEAD_KEY, OpeningMechanism.FIXED), null);
  assert.deepEqual(detailRefsAfterSelect(win, SILL, DETAIL_BUILTIN_WINDOW_HEAD_KEY, OpeningMechanism.FIXED),
    { [SILL]: DETAIL_BUILTIN_WINDOW_HEAD_KEY }, '別 slot の既定キーは下枠の既定ではない');
  assert.deepEqual(detailRefsAfterSelect(win, SILL, 'df-other', OpeningMechanism.FIXED), { [SILL]: 'df-other' });
  const floorWin = { ...win, sillHeight: 0 };
  assert.deepEqual(detailRefsAfterSelect(floorWin, SILL, DETAIL_BUILTIN_WINDOW_SILL_KEY, OpeningMechanism.FIXED),
    { [SILL]: DETAIL_BUILTIN_WINDOW_SILL_KEY }, '掃き出し窓は下枠の既定が無いので畳まない');
  const door = { category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE, detailRefs: null };
  assert.deepEqual(detailRefsAfterSelect(door, SILL, DETAIL_BUILTIN_WINDOW_SILL_KEY, OpeningMechanism.SWING),
    { [SILL]: DETAIL_BUILTIN_WINDOW_SILL_KEY }, '片開き戸に下枠の既定は無い');
});

test('detailRefsAfterSelect（S8f-2）: 窓は組込みの方立キーを選んでも上書きにならない。形違いの別キーは残り、記号の割当てがあればそれが基準', () => {
  const fixed = { category: OpeningCategory.WINDOW, subType: 'fixed', detailRefs: null };
  assert.equal(detailRefsAfterSelect(fixed, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, OpeningMechanism.FIXED), null);
  assert.deepEqual(detailRefsAfterSelect(fixed, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY, OpeningMechanism.FIXED),
    { [JAMB]: DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY }, '形違いの組込みは既定ではない');
  assert.deepEqual(detailRefsAfterSelect(fixed, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, undefined),
    { [JAMB]: DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY }, '機構未指定なら既定が無く、sash 以外のキーでも畳まない');
  assert.deepEqual(detailRefsAfterSelect(fixed, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_KEY, undefined),
    { [JAMB]: DETAIL_BUILTIN_WINDOW_JAMB_KEY }, '機構未指定なら sash のキーでも畳まない');
  const casement = { category: OpeningCategory.WINDOW, subType: 'casement', detailRefs: null };
  assert.equal(detailRefsAfterSelect(casement, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY, OpeningMechanism.SWING), null);
  // 記号に割当てがあるとき基準は記号の割当て（組込みの既定ではない）
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-win-sym-j') });
  const withSym = { ...fixed, fixtureType: sym };
  assert.equal(detailRefsAfterSelect(withSym, JAMB, 'df-win-sym-j', OpeningMechanism.FIXED), null, '記号の割当てと同じキーは畳む');
  assert.deepEqual(detailRefsAfterSelect(withSym, JAMB, DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY, OpeningMechanism.FIXED),
    { [JAMB]: DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY }, '記号に割当てがあれば組込みの既定キーも上書き');
  clearOverlays();
});

test('detailRefsAfterSelect（S8e-3）: 片開き戸は記号の割当て無しなら組込みの既定キーへ畳む。他の図は残す・片開き戸以外は畳まない', () => {
  const swing = { subType: SWING_LEAF_SUBTYPE, detailRefs: null };
  assert.equal(detailRefsAfterSelect(swing, JAMB, DETAIL_BUILTIN_DOOR_JAMB_KEY, OpeningMechanism.SWING), null);
  assert.equal(detailRefsAfterSelect(swing, HEAD, DETAIL_BUILTIN_DOOR_HEAD_KEY), null, '片開き戸は機構を渡さなくても従来どおり');
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
  assert.deepEqual(none.map(s => s.value), ['', '', '', '', '']);
});

test('T2-2 detailRefsAfterSelect(figureBack): 向こう側の姿図を選ぶと detailRefs.figureBack が付き、建具種別の割当てと同じキー・空で外れる。姿図（figure）は不変', () => {
  installElevationFigures([elevationFigure('df-f1'), elevationFigure('df-b1', { dashX: 150 })], [subTypeEntry('user1', 'df-f1', {
    [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-f1', [DetailSlot.FIGURE_BACK]: 'df-b1' },
  })]);
  const BACK = DetailSlot.FIGURE_BACK;
  const o = { category: 'fitting', subType: 'user1', detailRefs: { [DetailSlot.FIGURE]: 'df-f2' } };
  assert.deepEqual(detailRefsAfterSelect(o, BACK, 'df-b2'), { [DetailSlot.FIGURE]: 'df-f2', [BACK]: 'df-b2' }, 'figure の上書きは不変');
  assert.deepEqual(detailRefsAfterSelect(o, BACK, 'df-f1'), { [DetailSlot.FIGURE]: 'df-f2', [BACK]: 'df-f1' }, 'figureBack の基準は figureBack の割当て（df-b1）。figure のキーとは畳まない');
  assert.deepEqual(detailRefsAfterSelect(o, BACK, 'df-b1'), { [DetailSlot.FIGURE]: 'df-f2' }, '建具種別の figureBack と同じキーは畳む');
  const withBack = { ...o, detailRefs: { [DetailSlot.FIGURE]: 'df-f2', [BACK]: 'df-b2' } };
  assert.deepEqual(detailRefsAfterSelect(withBack, BACK, ''), { [DetailSlot.FIGURE]: 'df-f2' }, '建具種別の設定へ戻すと figureBack だけ消える');
  assert.equal(detailRefsAfterSelect({ detailRefs: { [BACK]: 'df-b2' } }, BACK, ''), null, '最後の 1 件を外すと null');
  const sel = openingDetailRefSelects(withBack, undefined).find(s => s.slot === BACK);
  assert.equal(sel.value, 'df-b2');
  assert.equal(sel.options[0].label, '建具種別の設定を使う');
  clearOverlays();
});

test('【失敗系】T2-2 select(figureBack): 無いキーを持つ建具は「見つかりません」の行を足し、図が別の slot 用（枠）の図なら選択肢に出ない', () => {
  const sels = openingDetailRefSelects({ detailRefs: { [DetailSlot.FIGURE_BACK]: 'df-gone' } }, [
    { key: 'df-j', label: '方立A', category: 'paired', view: 'plan', subject: 'jamb' },
  ]);
  const back = sels.find(s => s.slot === DetailSlot.FIGURE_BACK);
  assert.equal(back.value, 'df-gone');
  assert.match(back.options.at(-1).label, /見つかりません/);
  assert.ok(!back.options.some(o => o.value === 'df-j'), '方立の図は姿図の候補に出ない');
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
