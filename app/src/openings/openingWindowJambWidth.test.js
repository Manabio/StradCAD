// 窓の平面記号（詳細 LOD）の方立の見付＝25（建具は 30）の回帰テスト（S8f-0。ユーザー裁定 2026-11-04「窓枠見付は 25」）。
// 展開・一般 LOD・姿図・組込みの部分詳細図は対象外。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpeningPlanSymbol, jambWidthFor, hingeInsetFor, latchInsetFor } from './openingPlanSymbol.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism } from './openingCatalog.js';
import { OpeningCategory } from '../core.js';
import { FRAME_JAMB_WIDTH_MM, WINDOW_FRAME_JAMB_WIDTH_MM } from '../core/constants.js';

function makeOpening(overrides = {}) {
  return {
    coord1: 0, coord2: 1000, centerCoord: 500, isVertical: false,
    width: 1000, frameDepth: 0, lineWeight: 0.35, hingeSide: -1, swingSide: 1,
    ...overrides,
  };
}

function detailPrims(opening, mechanism) {
  return buildOpeningPlanSymbol(opening, {
    entry: { mechanism }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0, exteriorDirOf: () => 1,
  });
}

// role=frame のうち x 座標が coord1 側・coord2 側の端から内側へ入った最大量（＝方立の見付）を返す
function jambDepthsOf(prims, coord1, coord2) {
  const xs = prims.filter(p => p.role === 'frame' && p.type === 'polyline').flatMap(p => p.points.filter((_, i) => i % 2 === 0));
  const left = Math.max(...xs.filter(x => x < (coord1 + coord2) / 2)) - coord1;
  const right = coord2 - Math.min(...xs.filter(x => x > (coord1 + coord2) / 2));
  return { left, right };
}

test('定数: 窓 25・建具 30', () => {
  assert.equal(WINDOW_FRAME_JAMB_WIDTH_MM, 25);
  assert.equal(FRAME_JAMB_WIDTH_MM, 30);
});

test('窓の詳細 LOD: sashOpen（FIXED）の方立は 25・内法矩形も 25 から', () => {
  const prims = detailPrims(makeOpening({ category: OpeningCategory.WINDOW }), OpeningMechanism.FIXED);
  assert.deepEqual(jambDepthsOf(prims, 0, 1000), { left: 25, right: 25 });
  const rect = prims.find(p => p.type === 'rect');
  assert.equal(rect.x, 25);
  assert.equal(rect.w, 950);
});

test('窓の詳細 LOD: sash（PIVOT）の方立の見付は 25 の内法を使う', () => {
  const win = detailPrims(makeOpening({ category: OpeningCategory.WINDOW }), OpeningMechanism.PIVOT);
  const door = detailPrims(makeOpening({ category: OpeningCategory.DOOR }), OpeningMechanism.PIVOT);
  const xsOf = prims => prims.flatMap(p => (p.type === 'rect' ? [p.x, p.x + p.w] : p.type === 'polyline' ? p.points.filter((_, i) => i % 2 === 0) : []));
  assert.ok(xsOf(win).includes(25) && xsOf(win).includes(975));
  assert.ok(!xsOf(win).includes(30));
  assert.ok(xsOf(door).includes(30) && xsOf(door).includes(970));
});

test('窓の詳細 LOD: 開き系（SWING・SWING_IN・SWING_DOUBLE）の方立は 25、同機構の建具は 30', () => {
  for (const mech of [OpeningMechanism.SWING, OpeningMechanism.SWING_IN, OpeningMechanism.SWING_DOUBLE]) {
    const win = detailPrims(makeOpening({ category: OpeningCategory.WINDOW }), mech);
    const door = detailPrims(makeOpening({ category: OpeningCategory.DOOR }), mech);
    assert.deepEqual(jambDepthsOf(win, 0, 1000), { left: 25, right: 25 }, `窓 ${mech}`);
    assert.deepEqual(jambDepthsOf(door, 0, 1000), { left: 30, right: 30 }, `建具 ${mech}`);
  }
});

// 方立（swingFramePrimitives）は自分で jambWidthFor を呼ぶが、扉・円弧の内法は呼び出し側の jambW（planSymbolPlan の innerSpan）で
// 決まる。呼び出し側だけ 30 に戻す変異を検出するため、扉・円弧の along の範囲を直接見る（QA 指摘）。
test('窓の詳細 LOD: SWING_IN／SWING_DOUBLE の円弧は内法（吊元 coord1+25・半径＝内法幅）で描く、建具は 30', () => {
  // 円弧の中心＝吊元（内法の端）・半径＝扉の長さ（内法幅。両開きは半分）。
  const arcsOf = prims => prims.filter(p => p.type === 'arc' && p.role === 'arc')
    .map(p => ({ cx: Math.round(p.cx * 1e6) / 1e6, r: Math.round(p.r * 1e6) / 1e6 }))
    .sort((a, b) => a.cx - b.cx);
  const cases = [
    { mech: OpeningMechanism.SWING_IN, win: [{ cx: 25, r: 950 }], door: [{ cx: 30, r: 940 }] },
    { mech: OpeningMechanism.SWING_DOUBLE, win: [{ cx: 25, r: 475 }, { cx: 975, r: 475 }], door: [{ cx: 30, r: 470 }, { cx: 970, r: 470 }] },
  ];
  for (const { mech, win, door } of cases) {
    assert.deepEqual(arcsOf(detailPrims(makeOpening({ category: OpeningCategory.WINDOW }), mech)), win, `窓 ${mech}`);
    assert.deepEqual(arcsOf(detailPrims(makeOpening({ category: OpeningCategory.DOOR }), mech)), door, `建具 ${mech}`);
  }
});

test('幅 40 の窓は開口幅の半分（20）で頭打ち、幅 40 の建具も 20', () => {
  assert.equal(jambWidthFor(makeOpening({ width: 40, category: OpeningCategory.WINDOW })), 20);
  assert.equal(jambWidthFor(makeOpening({ width: 40, category: OpeningCategory.DOOR })), 20);
  assert.equal(jambWidthFor(makeOpening({ width: 1000, category: OpeningCategory.WINDOW })), 25);
  assert.equal(jambWidthFor(makeOpening({ width: 1000, category: OpeningCategory.DOOR })), 30);
});

test('jambWidthFor: category が undefined／null の opening は建具扱いで 30', () => {
  assert.equal(jambWidthFor(makeOpening()), 30);
  assert.equal(jambWidthFor(makeOpening({ category: null })), 30);
  assert.equal(jambWidthFor(makeOpening({ category: undefined })), 30);
});

test('SWING の専用 inset: 窓（外開き窓）は 20／15、建具・category なしは従来の 25／20', () => {
  const win = makeOpening({ category: OpeningCategory.WINDOW });
  assert.equal(hingeInsetFor(win), 20);
  assert.equal(latchInsetFor(win), 15);
  for (const o of [makeOpening({ category: OpeningCategory.DOOR }), makeOpening(), makeOpening({ category: null })]) {
    assert.equal(hingeInsetFor(o), 25);
    assert.equal(latchInsetFor(o), 20);
  }
});

test('SWING の閉じた扉の端: 窓は coord1+20 から coord2-15、片開き戸（建具）は従来の 25／20', () => {
  const leafX = prims => {
    const xs = prims.filter(p => p.role === 'leaf').flatMap(p => (p.type === 'polyline' ? p.points.filter((_, i) => i % 2 === 0) : p.type === 'line' ? [p.x1, p.x2] : p.type === 'rect' ? [p.x, p.x + p.w] : []));
    return { min: Math.min(...xs), max: Math.max(...xs) };
  };
  const win = detailPrims(makeOpening({ category: OpeningCategory.WINDOW }), OpeningMechanism.SWING);
  const door = detailPrims(makeOpening({ category: OpeningCategory.DOOR }), OpeningMechanism.SWING);
  const lw = leafX(win);
  const ld = leafX(door);
  assert.ok(Number.isFinite(lw.min) && Number.isFinite(ld.min), '閉じた扉の輪郭が出ている');
  assert.equal(lw.min, 20);
  assert.equal(lw.max, 1000 - 15);
  assert.equal(ld.min, 25);
  assert.equal(ld.max, 1000 - 20);
});

test('SLIDE_DOUBLE 窓（方立なし）は固定の期待値のまま不変', () => {
  const prims = buildOpeningPlanSymbol(makeOpening({ category: OpeningCategory.WINDOW }), {
    entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0, exteriorDirOf: () => 1,
  });
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":-72,"w":1000,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":0,"y":-68,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":0,"y1":-35,"x2":560,"y2":-35,"role":"symbol","weightMm":0.35}',
    '{"type":"rect","x":440,"y":2,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":440,"y1":35,"x2":1000,"y2":35,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":500,"y1":-68,"x2":500,"y2":68,"role":"symbol","weightMm":0.35,"dash":[6,4]}',
  ]);
});
