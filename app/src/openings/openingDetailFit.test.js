// 三方枠への部分詳細図の反映（S3）の結合テスト: 読み出し口（openingCatalog.js）のメモ、平面の方立（frameOnlyPrimitives）、
// 展開の上枠（openingSection.js）、失敗時に従来の profile へ戻ること。図・記号は openingDetailTestFixtures.js
// （user overlay に立てる。テストごとに一意な記号キーで、fit のメモがテスト間で漏れても影響しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { LodLevel } from '../viewport.js';
import { DetailSlot } from '../core/constants.js';
import {
  OpeningMechanism, detailFigureEntry, detailFigureRefsFor, detailFiguresFor, fitDetailLocalMemo, detailFitKey,
} from './openingCatalog.js';
import { buildOpeningPlanSymbol } from './openingPlanSymbol.js';
import { openingSectionPrimitives } from './openingSection.js';
import { resolveDetailFrame, resolveDetailFigure } from './openingDetailFit.js';
import {
  jambFigure, headFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol,
} from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const JAMB = DetailSlot.JAMB;
const HEAD = DetailSlot.HEAD;
const DIMS = { wallThickness: 120, projection: 12, faceWidth: 20 };

// ---- 読み出し口とメモ ----

test('読み出し口: 記号の参照キーと実在する図を返す。割当て無しは null、参照先が無いと refs だけ残る', () => {
  const none = uniqueSymbolKey();
  installFrameSymbol(none, {});
  assert.equal(detailFigureRefsFor(none), null);
  assert.equal(detailFiguresFor(none), null);
  assert.equal(detailFigureRefsFor('NOT-A-SYMBOL'), null);
  assert.equal(detailFigureEntry(''), null);
  assert.equal(detailFigureEntry(undefined), null);

  const sym = uniqueSymbolKey();
  const jamb = jambFigure(`df-${sym}-j`);
  installFrameSymbol(sym, { [JAMB]: jamb });
  assert.deepEqual(detailFigureRefsFor(sym), { [JAMB]: jamb.key });
  assert.equal(detailFiguresFor(sym)[JAMB].key, jamb.key);
  assert.equal(detailFigureEntry(jamb.key).label, 'テスト方立');
});

test('【失敗系】読み出し口: 参照先の図がカタログに無い記号は refs だけを返し、fit は NO_FIGURE（例外にしない）', () => {
  const dangling = uniqueSymbolKey();
  installFrameSymbol(dangling, { [JAMB]: jambFigure('df-dangling') }, { installFigures: false });
  assert.deepEqual(detailFigureRefsFor(dangling), { [JAMB]: 'df-dangling' });
  assert.equal(detailFiguresFor(dangling), null);
  const nf = fitDetailLocalMemo({ figureKey: 'df-dangling', slot: JAMB, ...DIMS });
  assert.equal(nf.error.code, 'noFigure');
  assert.equal(nf.error.message, 'df-dangling の方立（縦枠）の詳細図がカタログに見つかりません（DXF・PDF 由来の図は保存ファイルに入らないため、別の端末では見つかりません）');
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-none', slot: HEAD, ...DIMS }).error.code, 'noFigure');
});

test('【失敗系】平面・展開: 参照先の図が無い記号は従来の profile で描く', () => {
  const dangling = uniqueSymbolKey();
  installFrameSymbol(dangling, { [JAMB]: jambFigure('df-dangling-3') }, { installFigures: false });
  assert.deepEqual(planPrims({ fixtureType: dangling }).map(p => p.points), [BENT_JAMB1, BENT_JAMB2]);
  assert.equal(sectionPrims({ fixtureType: dangling }).filter(p => p.type === 'polyline').length, 1);
  assert.equal(sectionPrims({ fixtureType: dangling }).find(p => p.type === 'polyline').points.length, 6, '従来の bent（6点）');
});

test('メモ: 同じ鍵（図のキー・slot・壁厚・出幅・見付）の fit は同じ結果オブジェクトを返し、鍵が変われば別の結果になる', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-memo') });
  const a = fitDetailLocalMemo({ figureKey: 'df-memo', slot: JAMB, ...DIMS });
  assert.ok(!a.error, JSON.stringify(a.error));
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-memo', slot: JAMB, ...DIMS }), a, '同じ鍵は fit し直さない');
  for (const [name, change] of [['壁厚', { wallThickness: 105 }], ['出幅', { projection: 20 }], ['見付', { faceWidth: 30 }]]) {
    assert.notEqual(fitDetailLocalMemo({ figureKey: 'df-memo', slot: JAMB, ...DIMS, ...change }), a, `${name}が違えば別の結果`);
  }
  assert.notEqual(fitDetailLocalMemo({ figureKey: 'df-memo', slot: HEAD, ...DIMS }), a, 'slot が違えば別の結果');
});

test('detailFitKey: 数値は 1e-6 mm で丸める（105.00000000001 と 105 は同じ鍵）。図のキー・slot・各寸法が違えば別の鍵', () => {
  const base = { figureKey: 'df-k', slot: JAMB, wallThickness: 105, projection: 12, faceWidth: 20 };
  assert.equal(detailFitKey({ ...base, wallThickness: 105.00000000001 }), detailFitKey(base));
  assert.equal(detailFitKey({ ...base, faceWidth: 20 + 1e-9 }), detailFitKey(base));
  assert.equal(detailFitKey(base), 'df-k|jamb|105|12|20');
  for (const change of [{ figureKey: 'df-j' }, { slot: HEAD }, { wallThickness: 105.001 }, { projection: 12.001 }, { faceWidth: 20.001 }]) {
    assert.notEqual(detailFitKey({ ...base, ...change }), detailFitKey(base), JSON.stringify(change));
  }
});

test('メモ: 同じ図なら記号経由でも detailRefs 経由でも同じ fit 結果を共有する（鍵は図のキー）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-share') });
  const geometry = { coord1: 0, coord2: 1000, faceMin: -60, wallThickness: 120, faceWidth: 20, projection: 12 };
  const viaSymbol = resolveDetailFrame({ symbolKey: sym, slot: JAMB, ...geometry });
  const direct = fitDetailLocalMemo({ figureKey: 'df-share', slot: JAMB, ...DIMS });
  assert.ok(viaSymbol.sides && !direct.error);
  // 本体の WF は記号に割当て無し。detailRefs で同じ図を指す（記号キーが違っても同じメモ）。
  const viaRefs = resolveDetailFrame({ symbolKey: 'WF', detailRefs: { [JAMB]: 'df-share' }, slot: JAMB, ...geometry });
  assert.deepEqual(viaRefs.profiles, viaSymbol.profiles);
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-share', slot: JAMB, ...DIMS }), direct, 'メモは1つ');
});

test('メモ: 失敗（error）の結果もメモされる', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: materialBoundFigure('df-bad') });
  const a = fitDetailLocalMemo({ figureKey: 'df-bad', slot: JAMB, ...DIMS });
  assert.equal(a.error.code, 'unresolvedMaterial');
  assert.equal(fitDetailLocalMemo({ figureKey: 'df-bad', slot: JAMB, ...DIMS }), a);
});

test('メモ: overlay の世代が変わる（図を差し替える）と作り直し、新しい図の fit になる', () => {
  const sym = uniqueSymbolKey();
  const first = jambFigure('df-regen');
  installFrameSymbol(sym, { [JAMB]: first });
  const a = fitDetailLocalMemo({ figureKey: 'df-regen', slot: JAMB, ...DIMS });
  assert.equal(a.strokes[0].points[4].t, 120);
  // 同じキーの図を、end の基準にオフセット +10 を付けたものへ差し替える（世代が進む）
  clearOverlays();
  installFrameSymbol(sym, {
    [JAMB]: jambFigure('df-regen', { datums: [first.datums[0], first.datums[1], { ...first.datums[2], offsetMm: 10 }] }),
  });
  const b = fitDetailLocalMemo({ figureKey: 'df-regen', slot: JAMB, ...DIMS });
  assert.notEqual(b, a, '世代が変わったら作り直す');
  assert.equal(b.strokes[0].points[4].t, 130, '差し替えた図で fit されている');
});

test('resolveDetailFigure: detailRefs.jamb===null は記号の jamb を候補にしない（intended も drawn も null）。キー無し・undefined は従来どおり記号へ進む', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: jambFigure('df-n-j') });
  const none = resolveDetailFigure({ symbolKey: sym, detailRefs: { jamb: null }, slot: JAMB });
  assert.equal(none, null);
  assert.equal(resolveDetailFigure({ symbolKey: sym, detailRefs: {}, slot: JAMB })?.drawn?.key, 'df-n-j');
  assert.equal(resolveDetailFigure({ symbolKey: sym, detailRefs: { jamb: undefined }, slot: JAMB })?.drawn?.key, 'df-n-j');
});

test('resolveDetailFigure: detailRefs.head===null・記号 head あり → head は候補にせず jamb へ流用（R9）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: jambFigure('df-n2-j'), head: headFigure('df-n2-h') });
  const r = resolveDetailFigure({ symbolKey: sym, detailRefs: { head: null }, slot: HEAD });
  assert.deepEqual([r.intended.slot, r.intended.key, r.drawn.key], [JAMB, 'df-n2-j', 'df-n2-j']);
});

test('resolveDetailFigure: jamb===null と head===null を両方明示すれば head の要求も null（記号の jamb へ流れない）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: jambFigure('df-n3-j') });
  assert.equal(resolveDetailFigure({ symbolKey: sym, detailRefs: { jamb: null, head: null }, slot: HEAD }), null);
});

test('resolveDetailFigure: jamb はそのまま、head は head の図があればそれ・無ければ jamb（R9）・何も無ければ null', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-r-j'), [HEAD]: headFigure('df-r-h') });
  const keyOf = r => [r.intended.slot, r.intended.key, r.drawn?.slot, r.drawn?.key];
  assert.deepEqual(keyOf(resolveDetailFigure({ symbolKey: sym, slot: JAMB })), [JAMB, 'df-r-j', JAMB, 'df-r-j']);
  assert.deepEqual(keyOf(resolveDetailFigure({ symbolKey: sym, slot: HEAD })), [HEAD, 'df-r-h', HEAD, 'df-r-h'], 'head 優先');
  const jambOnly = uniqueSymbolKey();
  installFrameSymbol(jambOnly, { [JAMB]: jambFigure('df-r-j2') });
  assert.deepEqual(keyOf(resolveDetailFigure({ symbolKey: jambOnly, slot: HEAD })), [JAMB, 'df-r-j2', JAMB, 'df-r-j2'], 'head 無しは jamb を流用');
  const headOnly = uniqueSymbolKey();
  installFrameSymbol(headOnly, { [HEAD]: headFigure('df-r-h2') });
  assert.equal(resolveDetailFigure({ symbolKey: headOnly, slot: JAMB }), null, '平面の方立に head の図は使わない');
  assert.equal(resolveDetailFigure({ symbolKey: 'WF', slot: HEAD }), null, '割当て無し');
});

test('resolveDetailFigure: detailRefs が記号の detailFigures に勝つ。head は detailRefs.head ＞ 記号.head ＞ detailRefs.jamb ＞ 記号.jamb', () => {
  const other = uniqueSymbolKey();
  installFrameSymbol(other, { [JAMB]: jambFigure('df-s-j'), [HEAD]: headFigure('df-s-h') },
    { extraFigures: [jambFigure('df-o-j', { label: '別の方立' }), headFigure('df-o-h', { label: '別の上枠' })] });
  const dk =(slot, detailRefs) => resolveDetailFigure({ symbolKey: other, detailRefs, slot }).drawn.key;
  assert.equal(dk(JAMB, { [JAMB]: 'df-o-j' }), 'df-o-j', 'detailRefs.jamb ＞ 記号.jamb');
  assert.equal(dk(HEAD, { [HEAD]: 'df-o-h', [JAMB]: 'df-o-j' }), 'df-o-h', 'detailRefs.head が最優先');
  assert.equal(dk(HEAD, { [JAMB]: 'df-o-j' }), 'df-s-h', '記号.head ＞ detailRefs.jamb');
  assert.equal(dk(HEAD, null), 'df-s-h');
});

// ---- 平面の方立 ----

const makeOpening = (over = {}) => ({
  coord1: 0, coord2: 1000, centerCoord: 500, isVertical: false, width: 1000, frameDepth: 0, lineWeight: 0.35,
  hingeSide: -1, swingSide: 1, ...over,
});
const planCtx = () => ({
  entry: { mechanism: OpeningMechanism.FRAME_ONLY }, lodLevel: LodLevel.DETAIL, axisValue: 0, faceLo: -60, faceHi: 60,
  exteriorDirOf: () => 1,
});
const planPrims = over => buildOpeningPlanSymbol(makeOpening(over), planCtx());

// 割当て無しの bent（SF と同じ）。詳細図が無い／失敗したときの従来の描き。
const BENT_JAMB1 = [0, -60, 0, -72, 20, -72, 20, 72, 0, 72, 0, 60];
const BENT_JAMB2 = [1000, -60, 1000, -72, 980, -72, 980, 72, 1000, 72, 1000, 60];

test('平面: jamb の詳細図が割り当てられた記号の方立は、図を壁厚・出幅・見付へ合わせた点列（coord1 側）で描かれる', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan') });
  const prims = planPrims({ fixtureType: sym });
  assert.equal(prims.length, 2, '図のストローク1本×両端');
  assert.deepEqual(prims[0].points, [0, -60, 0, -72, 20, -72, 20, -60, 20, 60, 20, 72, 0, 72, 0, 60]);
  assert.equal(prims[0].closed, false);
  assert.equal(prims[0].role, 'frame');
  assert.notDeepEqual(prims[0].points, BENT_JAMB1, '従来の bent とは違う（詳細図由来）');
});

// 向き（鏡像の符号）の厳密な点列は openingDetailFrame.test.js の「coord2 側の鏡像」が唯一の検査。ここは配線だけ
// （2本目が開口の反対端に置かれ、perp の並びは1本目と同じ）を符号に依らない形で見る。
test('平面: coord2 側の方立は開口の反対端（along が中央より大きい側）に置かれ、perp の並びは coord1 側と同じ', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan-mirror') });
  const prims = planPrims({ fixtureType: sym });
  const alongOf = p => p.points.filter((_, i) => i % 2 === 0);
  const perpOf = p => p.points.filter((_, i) => i % 2 === 1);
  assert.equal(prims[1].points.length, prims[0].points.length);
  assert.ok(alongOf(prims[0]).every(a => a < 500), 'coord1 側は中央より小さい側');
  assert.ok(alongOf(prims[1]).every(a => a > 500), 'coord2 側は中央より大きい側');
  assert.deepEqual(perpOf(prims[1]), perpOf(prims[0]));
  // 全点の厳密値（従来の bent の BENT_JAMB2 とも違う＝詳細図由来であること、鏡像の向きも固定する）
  assert.deepEqual(prims[1].points, [1000, -60, 1000, -72, 980, -72, 980, -60, 980, 60, 980, 72, 1000, 72, 1000, 60]);
  assert.notDeepEqual(prims[1].points, BENT_JAMB2);
});

test('平面: 見付・出幅の編集値と開口幅の頭打ちが詳細図にも掛かる（見付 80・開口幅 100 → 半幅 50）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan-clamp') });
  const prims = planPrims({ fixtureType: sym, coord1: 0, coord2: 100, width: 100, frameFaceWidth: 80, frameProjection: 30 });
  const along = prims[0].points.filter((_, i) => i % 2 === 0);
  assert.equal(Math.max(...along), 50, '見付は開口半幅 50 で頭打ち');
  const perp = prims[0].points.filter((_, i) => i % 2 === 1);
  assert.equal(Math.min(...perp), -90, '出幅 30 の編集値が追随（壁の面 −60 − 30）');
  // 全点の厳密値: 見付 50（頭打ち後）・出幅 30。壁の面 −60〜60 は固定、stretch（面間）は 120 のまま
  assert.deepEqual(prims[0].points, [0, -60, 0, -90, 50, -90, 50, -60, 50, 60, 50, 90, 0, 90, 0, 60]);
  assert.deepEqual(prims[1].points, [100, -60, 100, -90, 50, -90, 50, -60, 50, 60, 50, 90, 100, 90, 100, 60]);
});

test('平面: 割当て無しの記号・未知の記号は従来の描きと同じ（bent／solid）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {});
  const prims = planPrims({ fixtureType: sym });
  assert.deepEqual(prims.map(p => p.points), [BENT_JAMB1, BENT_JAMB2]);
  const unknown = planPrims({ fixtureType: 'ZZ-NO-SUCH' });
  assert.equal(unknown[0].closed, true, '未知の記号は solid（閉じた矩形）');
});

test('【失敗系】平面: 詳細図が合わせられない（材束縛）・参照先が無い記号は従来の profile で描く（例外にしない）', () => {
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [JAMB]: materialBoundFigure('df-plan-bad') });
  assert.deepEqual(planPrims({ fixtureType: bad }).map(p => p.points), [BENT_JAMB1, BENT_JAMB2]);
  // 見付 0 以下になる極小の開口（頭打ち後 0）も fit が error → 従来へ
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan-zero') });
  const zero = planPrims({ fixtureType: sym, coord1: 0, coord2: 0, width: 0 });
  assert.equal(zero.length, 2);
  assert.equal(zero[0].points.length, 12, '従来の bent（6点）');
});

const JAMB_DETAIL_1 = [0, -60, 0, -72, 20, -72, 20, -60, 20, 60, 20, 72, 0, 72, 0, 60];
// 記号の図とは別の図（最後の U を省いた7頂点）。detailRefs 用。
const altJambFigure = key => {
  const j = jambFigure(key);
  return { ...j, strokes: [{ ...j.strokes[0], moves: j.strokes[0].moves.slice(0, 6) }] };
};
const ALT_JAMB_1 = [0, -60, 0, -72, 20, -72, 20, -60, 20, 60, 20, 72, 0, 72];

test('平面: 建具個別の detailRefs は記号の detailFigures に勝つ（detailRefs の図の形で描く）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan-sym') }, { extraFigures: [altJambFigure('df-plan-ref')] });
  assert.deepEqual(planPrims({ fixtureType: sym })[0].points, JAMB_DETAIL_1, '前提: refs 無しは記号の図');
  assert.deepEqual(planPrims({ fixtureType: sym, detailRefs: { [JAMB]: 'df-plan-ref' } })[0].points, ALT_JAMB_1);
});

test('平面: detailRefs だけで（記号に割当て無しでも）詳細図で描く。参照先が無い detailRefs は記号の図へ落ちる', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, {}, { extraFigures: [altJambFigure('df-plan-ref2')] });
  assert.deepEqual(planPrims({ fixtureType: sym, detailRefs: { [JAMB]: 'df-plan-ref2' } })[0].points, ALT_JAMB_1);
  const withSym = uniqueSymbolKey();
  installFrameSymbol(withSym, { [JAMB]: jambFigure('df-plan-sym3') });
  assert.deepEqual(planPrims({ fixtureType: withSym, detailRefs: { [JAMB]: 'df-gone' } })[0].points, JAMB_DETAIL_1);
});

test('平面: frameProfile を明示していても詳細図があれば詳細図で描く（保守パネルの下書きプレビュー）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-plan-preview') });
  const prims = planPrims({ fixtureType: sym, frameProfile: 'solid' });
  assert.equal(prims[0].closed, false);
  assert.deepEqual(prims[0].points, JAMB_DETAIL_1);
  const refOnly = planPrims({ fixtureType: 'WF', frameProfile: 'bent', detailRefs: { [JAMB]: 'df-plan-preview' } });
  assert.deepEqual(refOnly[0].points, JAMB_DETAIL_1, '記号が未登録／割当て無しでも detailRefs で描く');
});

test('平面: detailRefs も記号の割当ても無い・fit できないときは frameProfile（明示）／記号の profile の既定で描く', () => {
  assert.deepEqual(planPrims({ fixtureType: 'WF', frameProfile: 'solid' })[0].points, [0, -72, 20, -72, 20, 72, 0, 72]);
  assert.deepEqual(planPrims({ fixtureType: 'WF', frameProfile: 'bent' })[0].points, BENT_JAMB1);
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [JAMB]: materialBoundFigure('df-plan-bad2') });
  const fallback = planPrims({ fixtureType: bad, frameProfile: 'solid' });
  assert.equal(fallback[0].closed, true, 'fit 失敗は明示した frameProfile（solid）へ戻る');
  assert.deepEqual(fallback[0].points, [0, -72, 20, -72, 20, 72, 0, 72]);
  assert.deepEqual(planPrims({ fixtureType: 'WF' })[0].points, [0, -72, 20, -72, 20, 72, 0, 72], '記号の profile（WF=solid）');
});

test('平面: head だけが割り当てられた記号の方立は従来のまま（平面は jamb の図だけを使う）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [HEAD]: headFigure('df-plan-head-only') });
  assert.deepEqual(planPrims({ fixtureType: sym }).map(p => p.points), [BENT_JAMB1, BENT_JAMB2]);
});

// ---- 展開の上枠 ----

const CUT = 'thick', SIL = 'medium';
const frameOnlyOpening = (over = {}) => ({
  id: 'f1', category: OpeningCategory.FITTING, subType: 'threeSidedFrame', fixtureType: 'WF',
  width: 800, height: 2000, sillHeight: null, frameFaceWidth: null, frameProjection: null, ...over,
});
const sectionPrims = (over, opts = { wallThicknessMm: 115 }) => openingSectionPrimitives(frameOnlyOpening(over), 0, 1, CUT, SIL, opts);

// jamb の形（開）を壁厚115・見付20・出幅12 で上枠の寸法に合わせたもの: 帯の x は perp、y は along（上端から下へ）。
const HEAD_FROM_JAMB = [[12, -2000], [0, -2000], [0, -1980], [12, -1980], [127, -1980], [139, -1980], [139, -2000], [127, -2000]];
// head の図（閉）。閉じ辺を補うので始点を末尾に足す。
const HEAD_FROM_HEAD = [[12, -2000], [0, -2000], [0, -1980], [12, -1980], [127, -1980], [139, -1980], [139, -2000], [12, -2000]];

test('展開: head の図が割り当てられた記号の上枠は head の図（閉）で描かれる（jamb より優先）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-j'), [HEAD]: headFigure('df-sec-h') });
  const prims = sectionPrims({ fixtureType: sym });
  assert.equal(prims.length, 3, '上枠1・竪枠の縦線2（既存の構成を変えない）');
  const poly = prims.find(p => p.type === 'polyline');
  assert.deepEqual(poly.points, HEAD_FROM_HEAD);
  assert.equal(poly.weight, CUT, '上枠は断面なので太線');
  assert.equal(prims.filter(p => p.type === 'line').length, 2);
});

test('展開: head の図が無ければ jamb の図を上枠に流用する（R9）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-j-only') });
  const poly = sectionPrims({ fixtureType: sym }).find(p => p.type === 'polyline');
  assert.deepEqual(poly.points, HEAD_FROM_JAMB);
});

test('展開: 上枠は平面の点列を流用せず、断面の寸法（壁厚115＝帯の全幅139・上端から下へ見付）で fit し直す', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-refit') });
  const plan = planPrims({ fixtureType: sym });        // 平面は壁の面 −60〜60（壁厚120）
  const sec = sectionPrims({ fixtureType: sym }).find(p => p.type === 'polyline');
  const planPerp = plan[0].points.filter((_, i) => i % 2 === 1);
  const secX = sec.points.map(p => p[0]);
  assert.deepEqual(planPerp.slice(3, 5), [-60, 60], '前提: 平面の壁の面は −60/60（壁厚120）');
  assert.deepEqual(secX,[12, 0, 0, 12, 127, 139, 139, 127], '断面は壁厚115（面 12〜127）に合わせ直している');
  assert.notDeepEqual(secX, planPerp, '平面の点列（壁厚120）とは一致しない');
});

test('展開: 壁厚が変わると上枠の stretch 区間だけが伸び、固定寸法（見付・出幅）は変わらない', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-wall') });
  const poly = sectionPrims({ fixtureType: sym }, { wallThicknessMm: 140 }).find(p => p.type === 'polyline');
  assert.deepEqual(poly.points.map(p => p[0]), [12, 0, 0, 12, 152, 164, 164, 152], '面 12〜152（壁厚140）・全幅164');
  assert.deepEqual(poly.points.map(p => p[1]), HEAD_FROM_JAMB.map(p => p[1]), '見付方向（縦）は不変');
});

test('展開: 帯が左へ伸びる（dir=-1）と、上枠の x は x0 から反転して並ぶ', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-dir') });
  const poly = openingSectionPrimitives(frameOnlyOpening({ fixtureType: sym }), 4000, -1, CUT, SIL, { wallThicknessMm: 115 })
    .find(p => p.type === 'polyline');
  assert.deepEqual(poly.points.map(p => p[0]), HEAD_FROM_JAMB.map(p => 4000 - p[0]));
});

test('【失敗系】展開: 上枠の詳細図が合わせられない・割当て無しの記号は従来の上枠（bent の開いたコの字）で描く', () => {
  const BENT_HEAD = [[12, -2000], [0, -2000], [0, -1980], [139, -1980], [139, -2000], [127, -2000]];
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [HEAD]: materialBoundFigure('df-sec-bad') });
  assert.deepEqual(sectionPrims({ fixtureType: bad }).find(p => p.type === 'polyline').points, BENT_HEAD);
  const none = uniqueSymbolKey();
  installFrameSymbol(none, {});
  assert.deepEqual(sectionPrims({ fixtureType: none }).find(p => p.type === 'polyline').points, BENT_HEAD);
});

test('展開: frameProfile を明示していても詳細図があれば詳細図で描き、無ければ明示した profile で描く', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-preview') });
  const poly = sectionPrims({ fixtureType: sym, frameProfile: 'solid' }).find(p => p.type === 'polyline');
  assert.deepEqual(poly.points, HEAD_FROM_JAMB);
  const none = sectionPrims({ fixtureType: 'WF', frameProfile: 'solid' });
  assert.equal(none.filter(p => p.type === 'rect').length, 1);
  assert.equal(none.filter(p => p.type === 'polyline').length, 0);
});

test('展開: 建具個別の detailRefs は記号の割当てに勝つ（head の要求: detailRefs.head ＞ 記号.head ＞ detailRefs.jamb）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-s-j') }, { extraFigures: [headFigure('df-sec-r-h')] });
  assert.deepEqual(sectionPrims({ fixtureType: sym }).find(p => p.type === 'polyline').points, HEAD_FROM_JAMB, '前提: refs 無しは記号の jamb');
  const viaRefs = sectionPrims({ fixtureType: sym, detailRefs: { [HEAD]: 'df-sec-r-h' } }).find(p => p.type === 'polyline');
  assert.deepEqual(viaRefs.points, HEAD_FROM_HEAD);
});

test('resolveDetailFigure: 記号に head が無いとき head の要求は detailRefs.jamb ＞ 記号.jamb', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-s3-s') }, { extraFigures: [altJambFigure('df-s3-r')] });
  const r = resolveDetailFigure({ symbolKey: sym, detailRefs: { [JAMB]: 'df-s3-r' }, slot: HEAD });
  assert.deepEqual([r.intended.slot, r.intended.key, r.drawn.slot, r.drawn.key], [JAMB, 'df-s3-r', JAMB, 'df-s3-r']);
  assert.equal(resolveDetailFigure({ symbolKey: sym, slot: HEAD }).drawn.key, 'df-s3-s', '前提: detailRefs 無しは記号の jamb');
});

test('展開: 記号に head が無く detailRefs.jamb があれば、上枠は detailRefs.jamb の図で描く（記号の jamb より優先）', () => {
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-s3-s2') }, { extraFigures: [altJambFigure('df-s3-r2')] });
  const poly = sectionPrims({ fixtureType: sym, detailRefs: { [JAMB]: 'df-s3-r2' } }).find(p => p.type === 'polyline');
  assert.deepEqual(poly.points, HEAD_FROM_JAMB.slice(0, 7), '最後の U を省いた別図（7点）');
});

test('【失敗系】展開: head の参照が切れていて jamb の図が実在すれば、描画は jamb の図を流用する（R9）', () => {
  const sym = uniqueSymbolKey();
  // 記号は jamb・head の両方を参照するが、head の図 df-sec-dh だけカタログに無い（jamb の図は実在）
  installFrameSymbol(sym, { [JAMB]: jambFigure('df-sec-dj'), [HEAD]: headFigure('df-sec-dh') }, { installFigures: false, extraFigures: [jambFigure('df-sec-dj')] });
  const poly = sectionPrims({ fixtureType: sym }).find(p => p.type === 'polyline');
  assert.deepEqual(poly.points, HEAD_FROM_JAMB);
});

// ---- 入口 ----

test('resolveDetailFrame: 割当て無しは null（従来どおり）、fit 失敗は error、成功は sides と profiles（平らな列）を返す', () => {
  const geometry = { coord1: 0, coord2: 1000, faceMin: -60, wallThickness: 120, faceWidth: 20, projection: 12 };
  const none = uniqueSymbolKey();
  installFrameSymbol(none, {});
  assert.equal(resolveDetailFrame({ symbolKey: none, slot: JAMB, ...geometry }), null);
  const bad = uniqueSymbolKey();
  installFrameSymbol(bad, { [JAMB]: materialBoundFigure('df-res-bad') });
  assert.equal(resolveDetailFrame({ symbolKey: bad, slot: JAMB, ...geometry }).error.code, 'unresolvedMaterial');
  const ok = uniqueSymbolKey();
  installFrameSymbol(ok, { [JAMB]: jambFigure('df-res-ok') });
  const r = resolveDetailFrame({ symbolKey: ok, slot: JAMB, ...geometry });
  assert.equal(r.sides.length, 2);
  assert.deepEqual(r.profiles, [...r.sides[0], ...r.sides[1]]);
});
