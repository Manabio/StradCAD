// 外付け引き戸（SLIDE_SINGLE）の平面記号（S4。openingPlanSymbol.js outsetSlidePrimitives）。
// fixture は原点からずらす（符号の変異を検出するため）: 横壁・軸 y=3000（面 2940〜3060）・建具 x 1000〜2550（W=1550・DW=800・穴 750・枠の外面まで J=30 広げた cut は 750+60）。
// 向きの期待値は slideOutset.js の layout の読みを手で解いた表（hingeSide -1＝戸尻が x 小の側＝cut が大きい側）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildOpeningPlanSymbol, planSymbolWeightMm } from './openingPlanSymbol.js';
import { OpeningMechanism } from './openingCatalog.js';
import { LodLevel } from '../viewport.js';

const ENTRY = { mechanism: OpeningMechanism.SLIDE_SINGLE };
const DASH = [10, 6];

function makeOpening(overrides = {}) {
  return {
    coord1: 1000, coord2: 2550, centerCoord: 1775, isVertical: false,
    width: 1550, frameDepth: 0, lineWeight: 0.5, hingeSide: -1, swingSide: 1,
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    entry: ENTRY, lodLevel: LodLevel.STANDARD, axisValue: 3000, faceLo: 2940, faceHi: 3060,
    exteriorDirOf: () => 1,
    ...overrides,
  };
}

const spanX = p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)];

// ---- 一般 LOD ----

// [hingeSide, swingSide, cut, pull, 扉の y（面−20＝走る面が faceHi なら 3040・faceLo なら 2960）, 閉じた扉の x 区間]
const GENERAL_CASES = [
  // 枠＝穴 cut は縦枠の外面まで J(30) 広がる（S3c）。閉じた扉・破線は W 内（戸先端 latchAlong 起点）で不変。
  [-1, 1, [1770, 2580], [1000, 1800], 3040, [1750, 2550]],
  [-1, -1, [1770, 2580], [1000, 1800], 2960, [1750, 2550]],
  [1, -1, [970, 1780], [1750, 2550], 3040, [1000, 1800]],
  [1, 1, [970, 1780], [1750, 2550], 2960, [1000, 1800]],
];

for (const [hingeSide, swingSide, cut, pull, doorY, closed] of GENERAL_CASES) {
  test(`一般 LOD: hingeSide ${hingeSide}・swingSide ${swingSide} → 枠＝穴 ${cut}・閉じた扉 ${closed} y=${doorY}・破線＝引き代 ${pull}`, () => {
    const opening = makeOpening({ hingeSide, swingSide });
    const prims = buildOpeningPlanSymbol(opening, makeCtx());
    assert.equal(prims.length, 3);
    const [frame, door, open] = prims;
    assert.equal(frame.type, 'rect');
    assert.equal(frame.role, 'frame');
    assert.deepEqual([frame.x, frame.x + frame.w], cut);
    assert.deepEqual([frame.y, frame.y + frame.h], [2980, 3020]); // band 軸±20
    assert.equal(door.role, 'symbol');
    assert.equal(door.dash, undefined);
    assert.equal(door.y1, doorY);
    assert.equal(door.y2, doorY);
    assert.deepEqual(spanX(door), closed);
    assert.equal(closed[1] - closed[0], 800); // DW
    assert.equal(open.role, 'symbol');
    assert.deepEqual(open.dash, DASH);
    assert.equal(open.y1, doorY);
    assert.equal(open.y2, doorY);
    assert.deepEqual(spanX(open), pull);
    assert.equal(frame.weightMm, planSymbolWeightMm('frame', opening, false));
    assert.equal(door.weightMm, 0.5);
    assert.equal(open.weightMm, 0.5);
  });
}

test('一般 LOD: 戸先端 latchAlong（tailSide 反対の W の端）＝閉じた扉の端。枠 cut の端は戸先枠の見付 J だけ外側', () => {
  for (const hingeSide of [-1, 1]) {
    const prims = buildOpeningPlanSymbol(makeOpening({ hingeSide }), makeCtx());
    const [frame, door] = prims;
    const cut = [frame.x, frame.x + frame.w];
    const closed = spanX(door);
    // hingeSide -1: 戸先端＝W の大きい側（2550）/ 1: 小さい側（1000）。cut の端は 30 外側。
    assert.equal(hingeSide < 0 ? closed[1] : closed[0], hingeSide < 0 ? 2550 : 1000);
    assert.equal(hingeSide < 0 ? cut[1] - closed[1] : closed[0] - cut[0], 30);
  }
});

test('一般 LOD: hingeSide だけ反転（flippedHingeSides の両方反転と同じ向き）→ 扉の y 不変・cut と pull が入れ替わる', () => {
  const a = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1, swingSide: 1 }), makeCtx());
  const b = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1, swingSide: -1 }), makeCtx());
  assert.equal(a[1].y1, b[1].y1); // 走る面は不変
  assert.deepEqual([a[0].x, a[0].x + a[0].w], [1770, 2580]);
  assert.deepEqual([b[0].x, b[0].x + b[0].w], [970, 1780]);
  assert.deepEqual(spanX(a[2]), [1000, 1800]);
  assert.deepEqual(spanX(b[2]), [1750, 2550]);
});

test('一般 LOD: swingSide だけ反転 → cut・pull 不変・扉の y が面の反対側へ入れ替わる', () => {
  const a = buildOpeningPlanSymbol(makeOpening({ swingSide: 1 }), makeCtx());
  const b = buildOpeningPlanSymbol(makeOpening({ swingSide: -1 }), makeCtx());
  assert.deepEqual(a[0], b[0]);
  assert.deepEqual(spanX(a[2]), spanX(b[2]));
  assert.equal(a[1].y1, 3040);
  assert.equal(b[1].y1, 2960);
});

test('一般 LOD: 縦壁（isVertical）も along／perp が入れ替わるだけ（x＝面−20）', () => {
  // 縦壁・hingeSide -1・swingSide -1 → runPerpDir +1（slideOutset の読み）＝走る面は faceHi
  const opening = makeOpening({ isVertical: true, hingeSide: -1, swingSide: -1 });
  const prims = buildOpeningPlanSymbol(opening, makeCtx());
  const [frame, door, open] = prims;
  assert.deepEqual([frame.y, frame.y + frame.h], [1770, 2580]);
  assert.deepEqual([frame.x, frame.x + frame.w], [2980, 3020]);
  assert.equal(door.x1, 3040);
  assert.equal(door.x2, 3040);
  assert.deepEqual([Math.min(door.y1, door.y2), Math.max(door.y1, door.y2)], [1750, 2550]);
  assert.equal(open.x1, 3040);
  assert.deepEqual([Math.min(open.y1, open.y2), Math.max(open.y1, open.y2)], [1000, 1800]);
});

// ---- 詳細 LOD（一式なしのフォールバック） ----

test('詳細 LOD: 方立のコの字が cut の両端・内法の枠矩形・扉は実寸矩形 [面−35, 面−5]・開けた扉は同矩形の破線', () => {
  const prims = buildOpeningPlanSymbol(makeOpening(), makeCtx({ lodLevel: LodLevel.DETAIL }));
  assert.equal(prims.length, 5);
  const [jambA, jambB, inner, door, open] = prims;
  // 方立: cut [1770,2580] の両端（見付 30）＝[A+750, A+780] と [A, A+30]（A=2550。S3c）・帯 面±12
  assert.deepEqual(jambA.points, [1800, 2928, 1770, 2928, 1770, 3072, 1800, 3072]);
  assert.deepEqual(jambB.points, [2550, 2928, 2580, 2928, 2580, 3072, 2550, 3072]);
  assert.equal(jambA.role, 'frame');
  assert.equal(jambA.closed, undefined);
  // 枠の矩形は内法＝穴の長さ DW−50（方立と二重に描かない）
  assert.deepEqual([inner.x, inner.x + inner.w], [1800, 2550]);
  assert.deepEqual([inner.y, inner.y + inner.h], [2928, 3072]);
  // 扉: 走る面 faceHi=3060 の内側 [3025, 3055]（面−35〜面−5）
  assert.equal(door.role, 'symbol');
  assert.equal(door.dash, undefined);
  assert.deepEqual([door.x, door.x + door.w], [1750, 2550]);
  assert.deepEqual([door.y, door.y + door.h], [3025, 3055]);
  assert.deepEqual([open.x, open.x + open.w], [1000, 1800]);
  assert.deepEqual([open.y, open.y + open.h], [3025, 3055]);
  assert.deepEqual(open.dash, DASH);
});

test('詳細 LOD: swingSide 反転で扉の矩形が faceLo 側 [面+5, 面+35] へ・方立と枠矩形は不変', () => {
  const a = buildOpeningPlanSymbol(makeOpening({ swingSide: 1 }), makeCtx({ lodLevel: LodLevel.DETAIL }));
  const b = buildOpeningPlanSymbol(makeOpening({ swingSide: -1 }), makeCtx({ lodLevel: LodLevel.DETAIL }));
  assert.deepEqual(a.slice(0, 3), b.slice(0, 3));
  assert.deepEqual([b[3].y, b[3].y + b[3].h], [2945, 2975]);
  assert.deepEqual([b[4].y, b[4].y + b[4].h], [2945, 2975]);
});

test('詳細 LOD: W が小さい（W=140 → 穴の長さ 45）でも S3c の cut は方立 2 本分を含むので内法の枠矩形は穴の長さ 45 で描かれ、座標は有限', () => {
  const opening = makeOpening({ coord1: 1000, coord2: 1140, width: 140 });
  const prims = buildOpeningPlanSymbol(opening, makeCtx({ lodLevel: LodLevel.DETAIL }));
  const inner = prims.filter(p => p.role === 'frame' && p.type === 'rect');
  assert.equal(inner.length, 1);
  assert.equal(inner[0].w, 45);
  for (const p of prims) {
    for (const k of ['x', 'y', 'w', 'h']) if (k in p) assert.ok(Number.isFinite(p[k]), `${k}: ${p[k]}`);
  }
});

test('詳細 LOD: hingeSide 1・swingSide -1 → 方立 970〜1000／1750〜1780・内法枠 1000〜1750・扉 x 1000〜1800 y 3025〜3055・破線 x 1750〜2550', () => {
  const prims = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1, swingSide: -1 }), makeCtx({ lodLevel: LodLevel.DETAIL }));
  const [jambA, jambB, inner, door, open] = prims;
  assert.deepEqual(jambA.points, [1000, 2928, 970, 2928, 970, 3072, 1000, 3072]);
  assert.deepEqual(jambB.points, [1750, 2928, 1780, 2928, 1780, 3072, 1750, 3072]);
  assert.deepEqual([inner.x, inner.x + inner.w], [1000, 1750]);
  assert.deepEqual([door.x, door.x + door.w], [1000, 1800]);
  assert.deepEqual([door.y, door.y + door.h], [3025, 3055]);
  assert.equal(door.dash, undefined);
  assert.deepEqual([open.x, open.x + open.w], [1750, 2550]);
  assert.deepEqual(open.dash, DASH);
});

test('詳細 LOD: 縦壁・hingeSide -1・swingSide -1 → 扉矩形 x 3025〜3055・y 1750〜2550', () => {
  const prims = buildOpeningPlanSymbol(makeOpening({ isVertical: true, hingeSide: -1, swingSide: -1 }), makeCtx({ lodLevel: LodLevel.DETAIL }));
  const door = prims[3];
  assert.deepEqual([door.x, door.x + door.w], [3025, 3055]);
  assert.deepEqual([door.y, door.y + door.h], [1750, 2550]);
  assert.equal(door.dash, undefined);
});

// ---- 失敗側・縮退 ----

test('縮退: 壁厚 ≤ 50（faceLo 2987.5・faceHi 3012.5＝25）は欠き込みを省く S3b と揃え、枠＋帯中央の線のみ（一般・詳細とも）', () => {
  const faces = { faceLo: 2987.5, faceHi: 3012.5 };
  const g = buildOpeningPlanSymbol(makeOpening(), makeCtx(faces));
  assert.equal(g.length, 2);
  assert.equal(g[1].y1, 3000);
  assert.deepEqual(spanX(g[1]), [1770, 2580]);
  assert.equal(g.some(p => p.dash), false);
  const d = buildOpeningPlanSymbol(makeOpening(), makeCtx({ ...faces, lodLevel: LodLevel.DETAIL }));
  assert.deepEqual(d.map(p => p.type), ['polyline', 'polyline', 'rect', 'line']);
  assert.equal(d.some(p => p.dash), false);
  // 壁厚ちょうど 50 も省く（slideRecessBand は ≤ d で null）。50.5 は描く
  assert.equal(buildOpeningPlanSymbol(makeOpening(), makeCtx({ faceLo: 2975, faceHi: 3025 })).length, 2);
  assert.equal(buildOpeningPlanSymbol(makeOpening(), makeCtx({ faceLo: 2974.75, faceHi: 3025 })).length, 3);
});

// 従来の記号（slideSinglePrimitives）の期待値。外壁ホスト・W≤50 の引き戸はこれ（開口全幅＝coord1〜coord2）。
function legacySlidePrims(coord1, coord2) {
  return [
    { type: 'rect', x: coord1, y: 2980, w: coord2 - coord1, h: 40, role: 'frame', weightMm: planSymbolWeightMm('frame', makeOpening(), false), dash: undefined },
    { type: 'line', x1: coord1, y1: 2990, x2: coord2, y2: 2990, role: 'symbol', weightMm: 0.5, dash: undefined },
  ];
}

test('縮退: 外壁ホスト（R12）は従来の slideSinglePrimitives と一致（開口全幅の枠＋全長の線・破線なし）', () => {
  const prims = buildOpeningPlanSymbol(makeOpening(), makeCtx({ host: { isExteriorWall: true } }));
  assert.deepEqual(prims, legacySlidePrims(1000, 2550));
});

test('縮退: W≤50（W=50・幅 0）は従来描き（layout null）', () => {
  for (const coord2 of [1050, 1000]) {
    const prims = buildOpeningPlanSymbol(makeOpening({ coord2, width: coord2 - 1000 }), makeCtx());
    assert.deepEqual(prims, legacySlidePrims(1000, coord2), `coord2=${coord2}`);
  }
});

test('縮退: 外壁でない host（isExteriorWall false）・host 無しは外付けの記号', () => {
  const a = buildOpeningPlanSymbol(makeOpening(), makeCtx({ host: { isExteriorWall: false } }));
  const b = buildOpeningPlanSymbol(makeOpening(), makeCtx());
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});

test('縮退: swingSide 0（走る面が決まらない）→ 穴の枠＋帯中央の扉線（cut 長）・破線なし', () => {
  const prims = buildOpeningPlanSymbol(makeOpening({ swingSide: 0 }), makeCtx());
  assert.equal(prims.length, 2);
  assert.deepEqual([prims[0].x, prims[0].x + prims[0].w], [1770, 2580]);
  assert.equal(prims[1].y1, 3000);
  assert.deepEqual(spanX(prims[1]), [1770, 2580]);
  assert.equal(prims.some(p => p.dash), false);
});

test('縮退: faceLo／faceHi が非有限 → 枠＋帯中央の扉線のみ（NaN を出さない）', () => {
  for (const faces of [{ faceLo: NaN, faceHi: 3060 }, { faceLo: 2940, faceHi: Infinity }, { faceLo: undefined, faceHi: undefined }]) {
    const prims = buildOpeningPlanSymbol(makeOpening(), makeCtx(faces));
    assert.equal(prims.length, 2, JSON.stringify(faces));
    assert.equal(prims[1].y1, 3000);
    for (const p of prims) {
      for (const k of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2']) if (k in p) assert.ok(Number.isFinite(p[k]), `${k}: ${p[k]}`);
    }
  }
});

test('縮退: 詳細 LOD でも swingSide 0 は方立＋内法枠＋中央線のみ（扉の矩形・破線なし）', () => {
  const prims = buildOpeningPlanSymbol(makeOpening({ swingSide: 0 }), makeCtx({ lodLevel: LodLevel.DETAIL }));
  assert.deepEqual(prims.map(p => p.type), ['polyline', 'polyline', 'rect', 'line']);
  assert.equal(prims.some(p => p.dash), false);
});

test('entry null は従来の刻み（tick 2 本）', () => {
  const prims = buildOpeningPlanSymbol(makeOpening(), makeCtx({ entry: null }));
  assert.equal(prims.length, 2);
  assert.ok(prims.every(p => p.type === 'line'));
  assert.deepEqual(prims.map(p => p.x1), [1000, 2550]);
});

test('略図 LOD は従来の刻み（W の両端 x=1000・2550）のまま（U3）', () => {
  const prims = buildOpeningPlanSymbol(makeOpening(), makeCtx({ lodLevel: LodLevel.SCHEMATIC, faceLo: undefined, faceHi: undefined }));
  assert.equal(prims.length, 2);
  assert.deepEqual(prims.map(p => p.x1), [1000, 2550]);
});

// ---- 配線 ----

function codeOnly(file) {
  return fs.readFileSync(path.resolve(import.meta.dirname, file), 'utf8').split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
}

test('配線: OpeningsLayer は buildOpeningPlanSymbol の ctx に host（実ホスト壁）を渡す', () => {
  const src = codeOnly('../renderer/OpeningsLayer.jsx');
  const call = src.slice(src.indexOf('buildOpeningPlanSymbol(opening, {'));
  const ctxBody = call.slice(0, call.indexOf('});'));
  assert.match(ctxBody, /\bhost\b\s*,/, 'ctx に host が無い（外壁ホストの引き戸が外付けで描かれる）');
  assert.match(src, /const host = hostByOpening\.get\(opening\.id\)/);
});

test('配線: 天伏の hidden 建具は記号を組む前に return する（S4 の記号も描かない）', () => {
  const src = codeOnly('../renderer/OpeningsLayer.jsx');
  const hiddenAt = src.indexOf('hiddenIds?.has(opening.id)');
  const buildAt = src.indexOf('buildOpeningPlanSymbol(opening, {');
  assert.match(src, /if \(hiddenIds\?\.has\(opening\.id\)\) return null;/, "hidden 建具の return null が無い");
  assert.ok(hiddenAt >= 0 && buildAt >= 0 && hiddenAt < buildAt);
});

test('配線: outsetSlidePrimitives の呼び出し元は buildSashOpenGroupPrimitives に host を渡す（ソース走査）', () => {
  const src = codeOnly('openingPlanSymbol.js');
  assert.match(src, /outsetSlideLayout\(opening, entry\.mechanism, host\)/);
  assert.match(src, /symbolWeight, frameWeight, host\)/);
});
