// 左右で違う枠（C6）。片開き戸の方立を、建具一式の jambHinge（吊元側）・jambLatch（戸先側）で左右別々に解決する。
// 解決 resolveDetailFigure の side・合成 resolveSwingDoorFrame（placeDetailSide を側ごとに 1 回）・通知 collectDetailFitFailures・配線を検証する。
// 期待値は「その側の図だけを両側に使った従来経路（jamb だけの一式・fittingKey 無し）の出力の同じ側」で組む（同じ式の写しにしない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { setOverlay } from '../catalog/catalogRegistry.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import {
  DetailSlot, DetailCategory, DetailView, DetailSubject, DetailLenMode, FittingPartRole, SWING_LEAF_SUBTYPE,
} from '../core/constants.js';
import { OpeningMechanism, fitDetailLocalMemo } from './openingCatalog.js';
import { resolveDetailFigure, resolveSwingDoorFrame, DetailFrameSide } from './openingDetailFit.js';
import { placeDetailSide, placeDetailSides } from './openingDetailFrame.js';
import { collectDetailFitFailures } from './openingDetailFitCheck.js';
import { placeOpeningWithDefaults } from './openingEdit.js';
import { buildOpeningPlanSymbol } from './openingPlanSymbol.js';
import { LodLevel } from '../viewport.js';
import { jambFigure, headFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol } from './openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const { JAMB, HEAD } = DetailSlot;
const { JAMB: R_JAMB, JAMB_HINGE, JAMB_LATCH } = FittingPartRole;
const DF = CatalogKind.DETAIL_FIGURE;

// カタログの重複禁止を避けるため、図は呼ぶたびに最初の手の長さを僅かに変えて別物にする（param 手の mm は fit に効かない）。
let serial = 0;
const unique = fig => {
  serial += 1;
  const s = structuredClone(fig);
  const m = s.strokes[0].moves[0];
  m.len = { ...m.len, mm: m.len.mm + serial * 0.001 };
  return s;
};
/** 見付 fw の代わりに固定 fixed mm を使う方立（形が jambFigure と違う。fit の見付に依らず x が fixed）。 */
function jambWithFixed(key, fixed) {
  const j = jambFigure(key);
  const moves = j.strokes[0].moves.map((m, i) => (i === 1 || i === 5 ? { ...m, len: { mm: fixed, mode: DetailLenMode.FIXED } } : m));
  return unique({ ...j, strokes: [{ ...j.strokes[0], moves }] });
}
const bodyOf = fig => ({ category: fig.category, view: fig.view, subject: fig.subject, strokes: fig.strokes, datums: fig.datums, anchors: fig.anchors });
const partOf = (role, fig) => ({ id: `p-${role}`, role, figure: bodyOf(fig) });
const fittingSet = (key, parts) => ({
  key, version: 1, label: `一式${key}`, category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING,
  strokes: [], datums: [], anchors: [], provenance: null, note: null, parts,
});

// 形の違う 3 種（見付 20 の既定ではなく固定 33・47・61 の方立）。
const FIX = { hinge: 33, latch: 47, both: 61 };

// 見本用に、各形を両側に使う jamb だけの一式 ref33・ref47・ref61 も一緒に立てる（setOverlay は上書きなので 1 回で立てる）。
function install(sets) {
  const sym = uniqueSymbolKey();
  const refs = Object.values(FIX).map(f => fittingSet(`ref${f}`, [partOf(R_JAMB, jambWithFixed(`r${f}`, f))]));
  installFrameSymbol(sym, {}, { extraFigures: [...sets, ...refs] });
  return sym;
}

const DIMS = { coord1: 200, coord2: 1000, faceMin: 0, faceMax: 120, wallThickness: 120, tSign: 1, faceWidth: 20, projection: 12 };
const SWING = { mechanism: OpeningMechanism.SWING, entry: { mechanism: OpeningMechanism.SWING } };
const resolve = (sym, extra) => resolveSwingDoorFrame({ symbolKey: sym, slot: JAMB, ...DIMS, ...extra });
// jamb だけの一式（図の形の見本）と、その一式を両側に使った従来経路の出力。
function reference(sym, fixed, hingeSide) {
  return resolve(sym, { fittingKey: `ref${fixed}`, hingeSide }); // mechanism なし＝両側共通
}
function defaultOnly() {
  return resolve(uniqueSymbolKey(), {});
}

// ---- resolveDetailFigure の side ----

test('resolveDetailFigure: 一式の段だけ side で jambHinge/jambLatch を jamb より先に探す。side 無しは jamb だけ', () => {
  install([fittingSet('s1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge)), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch)), partOf(R_JAMB, jambWithFixed('b', FIX.both))])]);
  const r = side => resolveDetailFigure({ slot: JAMB, fittingKey: 's1', side });
  assert.equal(r(DetailFrameSide.HINGE).drawn.key, 's1#jambHinge');
  assert.equal(r(DetailFrameSide.LATCH).drawn.key, 's1#jambLatch');
  assert.equal(r(null).drawn.key, 's1#jamb');
  assert.equal(r(undefined).drawn.key, 's1#jamb');
  assert.deepEqual([r('hinge').drawn.source, r('latch').drawn.source], ['fitting', 'fitting']);
});

test('resolveDetailFigure: 該当の側の部品が無ければ jamb・jamb も無ければ記号。JAMB 以外の slot は side を無視する', () => {
  install([fittingSet('s2', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge)), partOf(HEAD, unique(headFigure('hd')))])]);
  assert.equal(resolveDetailFigure({ slot: JAMB, fittingKey: 's2', side: 'latch' }), null, 'jambLatch も jamb も無い＝候補なし');
  assert.equal(resolveDetailFigure({ slot: JAMB, fittingKey: 's2', side: 'hinge' }).drawn.key, 's2#jambHinge');
  assert.equal(resolveDetailFigure({ slot: HEAD, fittingKey: 's2', side: 'hinge' }).drawn.key, 's2#head', 'HEAD は side を見ない');
  assert.equal(resolveDetailFigure({ slot: HEAD, fittingKey: 's2', side: null }).drawn.key, 's2#head');
});

// ---- resolveSwingDoorFrame（左右別々）----

for (const hingeSide of [-1, 1]) {
  const hIdx = hingeSide < 0 ? 0 : 1;
  const lIdx = 1 - hIdx;

  test(`一式が jambHinge だけ（hingeSide ${hingeSide}）: 吊元端だけその図・戸先端は既定（吊元端＝hingeSide −1 が coord1 側）`, () => {
    const sym = install([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge))])]);
    const got = resolve(sym, { fittingKey: 'set1', hingeSide, ...SWING });
    const ref = reference(sym, FIX.hinge, hingeSide);
    const dflt = defaultOnly();
    assert.deepEqual(got.sides[hIdx], ref.sides[hIdx], '吊元端は jambHinge の図');
    assert.deepEqual(got.sides[lIdx], dflt.sides[lIdx], '戸先端は既定');
    assert.notDeepEqual(ref.sides[hIdx], dflt.sides[hIdx], '前提: 図と既定は違う形');
    assert.equal(got.source, 'explicit');
    assert.deepEqual(got.profiles, got.sides.flat());
  });

  test(`一式が jamb＋jambLatch（hingeSide ${hingeSide}）: 戸先端は jambLatch・吊元端は jamb`, () => {
    const sym = install([fittingSet('set1', [partOf(R_JAMB, jambWithFixed('b', FIX.both)), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])]);
    const got = resolve(sym, { fittingKey: 'set1', hingeSide, ...SWING });
    assert.deepEqual(got.sides[lIdx], reference(sym, FIX.latch, hingeSide).sides[lIdx]);
    assert.deepEqual(got.sides[hIdx], reference(sym, FIX.both, hingeSide).sides[hIdx]);
    assert.notDeepEqual(got.sides[0], got.sides[1].map(st => st), '左右で違う');
  });
}

test('両開き・窓などで hingeSideMatters が偽なら jamb だけ（jambHinge・jambLatch は使わない）。mechanism を渡さなければ従来', () => {
  const sym = install([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge)), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch)), partOf(R_JAMB, jambWithFixed('b', FIX.both))])]);
  const base = { fittingKey: 'set1', hingeSide: -1 };
  const bothRef = reference(sym, FIX.both, -1);
  const double = resolve(sym, { ...base, mechanism: OpeningMechanism.SWING_DOUBLE, entry: { mechanism: OpeningMechanism.SWING_DOUBLE } });
  assert.deepEqual(double, bothRef, '両開きは jamb を両側');
  assert.deepEqual(resolve(sym, base), bothRef, 'mechanism・entry を渡さない＝従来');
  assert.deepEqual(resolve(sym, { ...base, hingeSide: null, ...SWING }), bothRef, 'hingeSide が無ければ側を決められない＝従来');
  // 渡す/渡さないで差が出る対（一式を置いた状態）
  assert.notDeepEqual(resolve(sym, { ...base, ...SWING }), bothRef);
});

test('一式が無い・fittingKey 無しは側を渡しても従来と deepEqual（左右同じ）', () => {
  const sym = install([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge))])]);
  const plain = resolve(sym, {});
  assert.deepEqual(resolve(sym, { hingeSide: -1, ...SWING }), plain, 'fittingKey 無し');
  assert.deepEqual(resolve(sym, { fittingKey: 'gone', hingeSide: -1, ...SWING }), plain, '存在しない一式');
});

test('同じ図に解決される場合は両側同時の経路（jamb だけの一式は従来と deepEqual）', () => {
  const sym = install([fittingSet('set1', [partOf(R_JAMB, jambWithFixed('b', FIX.both))])]);
  for (const hingeSide of [-1, 1]) {
    assert.deepEqual(resolve(sym, { fittingKey: 'set1', hingeSide, ...SWING }), reference(sym, FIX.both, hingeSide));
  }
});

test('【失敗系】片側だけ fit 不能: その側だけ既定へ戻り、もう片側の図は保たれる。既定も無ければ error', () => {
  const sym = install([fittingSet('set1', [partOf(JAMB_HINGE, unique(materialBoundFigure('mb'))), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])]);
  for (const hingeSide of [-1, 1]) {
    const hIdx = hingeSide < 0 ? 0 : 1;
    const got = resolve(sym, { fittingKey: 'set1', hingeSide, ...SWING });
    assert.equal(got.error, undefined);
    assert.deepEqual(got.sides[hIdx], defaultOnly().sides[hIdx], '失敗した吊元端は既定');
    assert.deepEqual(got.sides[1 - hIdx], reference(sym, FIX.latch, hingeSide).sides[1 - hIdx], '戸先端は jambLatch のまま');
  }
  const noDefault = resolve(sym, { fittingKey: 'set1', hingeSide: -1, defaultKey: null, ...SWING });
  assert.ok(noDefault.error, '既定が無ければ従来どおり error（呼び出し側は従来の描きへ）');
  assert.equal(noDefault.sides, undefined);
});

// ---- placeDetailSide ----

test('placeDetailSide を 2 回（coord1 側 sx +1・coord2 側 sx −1）呼ぶと placeDetailSides と deepEqual（tSign ±1・既定省略）', () => {
  const sym = install([fittingSet('set1', [partOf(R_JAMB, jambWithFixed('b', FIX.both))])]);
  void sym;
  const fitted = fitDetailLocalMemo({ figureKey: 'set1#jamb', slot: JAMB, wallThickness: 120, projection: 12, faceWidth: 20 });
  assert.equal(fitted.error, undefined);
  for (const tSign of [1, -1, undefined]) {
    const p = { faceMin: 10, faceMax: 130, tSign };
    const pair = placeDetailSides(fitted, { coord1: 200, coord2: 1000, ...p });
    assert.deepEqual(pair[0], placeDetailSide(fitted, { along: 200, sx: 1, ...p }));
    assert.deepEqual(pair[1], placeDetailSide(fitted, { along: 1000, sx: -1, ...p }));
    assert.ok(pair[0].length > 0 && pair[0][0].points.length > 2);
  }
  const a = placeDetailSide(fitted, { along: 200, sx: 1, faceMin: 10, faceMax: 130 });
  const b = placeDetailSide(fitted, { along: 200, sx: -1, faceMin: 10, faceMax: 130 });
  assert.notDeepEqual(a, b, '前提: sx で向きが変わる');
});

// ---- 通知 ----

function graphWithSwing(detailRefs, hingeSide) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, y0, y1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 4000), cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  generateRoomWallsFromOutline(graph, graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK'));
  const wall = [...graph.walls].find(w => !w.isVertical);
  const { opening, error } = placeOpeningWithDefaults(graph, { openingNumberIndex: new Map() }, wall, { x: 800, y: 0 }, OpeningCategory.FITTING);
  assert.ok(opening && !error, `前提: 開口を置ける（${error}）`);
  runInAction(() => { Object.assign(opening, { subType: SWING_LEAF_SUBTYPE, width: 800, hingeSide, detailRefs }); });
  return graph;
}

test('通知: 吊元側の部品（jambHinge）が fit 不能なら行が出る（キー表示は役割ラベル・主語「建具一式」）。方立の slot', () => {
  setOverlay(DF, { user: [fittingSet('kset', [partOf(JAMB_HINGE, unique(materialBoundFigure('mb'))), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])] });
  const rows = collectDetailFitFailures(graphWithSwing({ fitting: 'kset' }, -1)).filter(f => f.slot === JAMB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbolKey, '建具一式');
  assert.equal(rows[0].label, 'kset（方立（吊元側））');
  assert.match(rows[0].message, /方立（吊元側）/);
});

test('【失敗系】通知: 戸先側の部品だけ fit 不能でも行が出る。両方 fit できる・jamb だけの一式は 0 行', () => {
  setOverlay(DF, { user: [fittingSet('kbad', [partOf(R_JAMB, jambWithFixed('b', FIX.both)), partOf(JAMB_LATCH, unique(materialBoundFigure('mb')))])] });
  const bad = collectDetailFitFailures(graphWithSwing({ fitting: 'kbad' }, 1)).filter(f => f.slot === JAMB);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, 'kbad（方立（戸先側））');
  clearOverlays();
  setOverlay(DF, { user: [fittingSet('kok', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge)), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])] });
  assert.deepEqual(collectDetailFitFailures(graphWithSwing({ fitting: 'kok' }, 1)).filter(f => f.slot === JAMB), []);
  clearOverlays();
  setOverlay(DF, { user: [fittingSet('kj', [partOf(R_JAMB, jambWithFixed('b', FIX.both))])] });
  assert.deepEqual(collectDetailFitFailures(graphWithSwing({ fitting: 'kj' }, 1)).filter(f => f.slot === JAMB), []);
});

// ---- 平面の記号を通した C6（側ごとの R4）----

const GONE = { jamb: 'df-gone' };
function planFrames(op, detailRefs, { faceA = 1000.3, w = 102.3 } = {}) {
  const o = {
    category: OpeningCategory.FITTING, subType: SWING_LEAF_SUBTYPE, coord1: 200.3, coord2: 1000.3, centerCoord: 600.3,
    isVertical: false, width: 800, frameDepth: 0, lineWeight: 0.35, hingeSide: -1, swingSide: 1, ...op, detailRefs,
  };
  return buildOpeningPlanSymbol(o, {
    entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, axisValue: faceA,
    faceLo: faceA, faceHi: faceA + w, exteriorDirOf: () => 1,
  }).filter(p => p.role === 'frame');
}
const installSets = sets => setOverlay(DF, {
  user: [...sets, ...Object.values(FIX).map(f => fittingSet(`ref${f}`, [partOf(R_JAMB, jambWithFixed(`r${f}`, f))]))],
});

for (const hingeSide of [-1, 1]) {
  const hIdx = hingeSide < 0 ? 0 : 1;
  const lIdx = 1 - hIdx;

  test(`【失敗系】R4（hingeSide ${hingeSide}）: jambHinge だけの一式で半外付け（frameDepth 50）→ 戸先側は従来の描きの同じ側・吊元側は図`, () => {
    installSets([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge))])]);
    const op = { frameDepth: 50, hingeSide };
    const got = planFrames(op, { fitting: 'set1' });
    const legacy = planFrames(op, GONE);
    const hingeRef = planFrames(op, { fitting: `ref${FIX.hinge}` });
    assert.equal(got.length, 2);
    assert.deepEqual(got[lIdx], legacy[lIdx], '戸先側（既定の図）は R4 不成立で従来');
    assert.deepEqual(got[hIdx], hingeRef[hIdx], '吊元側は図（明示は R4 を見ない）');
    assert.notDeepEqual(got[hIdx], legacy[hIdx], '前提: 図と従来は違う');
  });

  test(`【失敗系】R4（hingeSide ${hingeSide}）: 開口幅 50（見付 25）で jambHinge だけ → 戸先側は従来（見付 25）と一致`, () => {
    installSets([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge))])]);
    const op = { width: 50, coord2: 250.3, hingeSide };
    const got = planFrames(op, { fitting: 'set1' });
    const legacy = planFrames(op, GONE);
    assert.deepEqual(got[lIdx], legacy[lIdx]);
    assert.notDeepEqual(got[hIdx], legacy[hIdx]);
  });

  test(`【失敗系】片側 fit 不能かつ R4 不成立（hingeSide ${hingeSide}）: その側は従来の同じ側・もう片側は図`, () => {
    installSets([fittingSet('set1', [partOf(JAMB_HINGE, unique(materialBoundFigure('mb'))), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])]);
    const op = { frameDepth: 50, hingeSide };
    const got = planFrames(op, { fitting: 'set1' });
    assert.deepEqual(got[hIdx], planFrames(op, GONE)[hIdx], '吊元側: fit 不能→既定→R4 不成立→従来');
    assert.deepEqual(got[lIdx], planFrames(op, { fitting: `ref${FIX.latch}` })[lIdx], '戸先側は jambLatch の図');
  });

  for (const swingSide of [1, -1]) {
    for (const isVertical of [false, true]) {
      test(`平面の記号: 吊元側・戸先側が jamb だけの一式の同じ側と一致（hingeSide ${hingeSide}・swingSide ${swingSide}・${isVertical ? '縦' : '横'}壁）`, () => {
        installSets([fittingSet('set1', [partOf(JAMB_HINGE, jambWithFixed('h', FIX.hinge)), partOf(JAMB_LATCH, jambWithFixed('l', FIX.latch))])]);
        const op = { hingeSide, swingSide, isVertical };
        const got = planFrames(op, { fitting: 'set1' });
        assert.deepEqual(got[hIdx], planFrames(op, { fitting: `ref${FIX.hinge}` })[hIdx]);
        assert.deepEqual(got[lIdx], planFrames(op, { fitting: `ref${FIX.latch}` })[lIdx]);
        assert.notDeepEqual(got[hIdx], planFrames(op, { fitting: `ref${FIX.latch}` })[hIdx], '前提: 吊元側と戸先側の図は違う');
      });
    }
  }
}

// ---- 配線（ソース走査。行頭・行末のコメントは除外）----

const SRC = path.resolve(import.meta.dirname, '..');
const stripComments = text => text.split(/\r?\n/)
  .map(line => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, ''))).join('\n');
function callBodies(code, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/function\s+$/.test(code.slice(0, m.index))) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      if ('([{'.includes(code[i])) depth += 1;
      else if (')]}'.includes(code[i])) depth -= 1;
    }
    out.push(code.slice(m.index, i));
  }
  return out;
}

test('【配線】片開き戸の方立の呼び出し（openingPlanSymbol.js の swingDetailFramePrimitives）だけが mechanism・entry・hingeSide を渡す。窓・断面は渡さない', () => {
  const read = f => stripComments(fs.readFileSync(path.join(SRC, 'openings', f), 'utf8'));
  const plan = callBodies(read('openingPlanSymbol.js'), 'resolveSwingDoorFrame');
  assert.equal(plan.length, 2, '平面の呼び出し（片開き戸の方立・窓の方立）');
  const sided = plan.filter(b => /\bhingeSide\s*:\s*opening\.hingeSide\b/.test(b) && /\bmechanism\s*:/.test(b) && /\bentry\b/.test(b));
  assert.equal(sided.length, 1, '片開き戸の方立だけ');
  assert.match(sided[0], /slot:\s*DetailSlot\.JAMB/);
  assert.ok(!/\bhingeSide\b/.test(plan.find(b => b !== sided[0])), '窓の方立は側を渡さない（Q-C6）');
  for (const b of callBodies(read('openingSection.js'), 'resolveSwingDoorFrame')) assert.ok(!/\bhingeSide\b/.test(b), '断面の上枠・下枠は側を渡さない');
  // 通知側も同じ条件で側ごとに解決する
  const check = read('openingDetailFitCheck.js');
  assert.ok(callBodies(check, 'resolveDetailFigure').some(b => /\bside\b/.test(b)), '通知は side を渡して解決する');
});
