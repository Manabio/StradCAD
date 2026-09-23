// openingPlanSymbol.js（建具モード 平面記号の純関数化）の回帰テスト。
// ステップ11a（器＋線幅役割＋SCHEMATIC）＋11b-1（蝶番系その1: SWING・SWING_IN・PROJECT_V・DREH_KIPP）
// ＋11b-2（蝶番系その2: SWING_DOUBLE・SWING_CHILD・FREE・FREE_DOUBLE・FIRE_DOOR・FIRE_FOLD）。
//
// 【ピン留め】(a)/(a')/(a'') は probe（scripts/probe/openingPlanSymbolProbe.mjs）で実データ3文書×
// （通常＋sweep）の6本が旧 renderer/OpeningsLayer.jsx の出力と完全一致することを確認した後の
// buildOpeningPlanSymbol自身の出力を primitives.map(p => JSON.stringify(p)) で固定したもの
// （memberFigures.test.js と同じ形。意図的な出力変更なら期待値を採り直すこと）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpeningPlanSymbol, planSymbolWeightMm } from './openingPlanSymbol.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism } from './openingCatalog.js';
import { LINE_WEIGHT_MM, OpeningCategory } from '../core.js';

function makeOpening(overrides = {}) {
  return {
    coord1: 0, coord2: 1000, centerCoord: 500, isVertical: false,
    width: 1000, frameDepth: 0, lineWeight: 0.35, hingeSide: -1, swingSide: 1,
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    entry: null, lodLevel: LodLevel.STANDARD, axisValue: 500, exteriorDirOf: () => 1,
    ...overrides,
  };
}

// ================================================================
// (a) ピン留め: 代表ケースのスナップショット
// ================================================================

test('ピン留め: SCHEMATIC・entry=swing → tick 2本のみ', () => {
  const opening = makeOpening({ coord1: 0, coord2: 1000, width: 1000 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.SCHEMATIC, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":470,"x2":0,"y2":530,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1000,"y1":470,"x2":1000,"y2":530,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SCHEMATIC・entry=slideDouble → tick 2本＋leaf線2本', () => {
  const opening = makeOpening({ coord1: 0, coord2: 2000, centerCoord: 1000, width: 2000 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.SCHEMATIC, axisValue: 800 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":770,"x2":0,"y2":830,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":2000,"y1":770,"x2":2000,"y2":830,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":0,"y1":790,"x2":1120,"y2":790,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":880,"y1":810,"x2":2000,"y2":810,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SCHEMATIC・entry無し（縦壁）→ tick 2本のみ', () => {
  const opening = makeOpening({ coord1: 200, coord2: 1800, centerCoord: 1000, isVertical: true, width: 1600 });
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.SCHEMATIC, axisValue: 200 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":170,"y1":200,"x2":230,"y2":200,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":170,"y1":1800,"x2":230,"y2":1800,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: STANDARD・entry無し → tick 2本のみ', () => {
  const opening = makeOpening({ coord1: 0, coord2: 1000 });
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.STANDARD, axisValue: 1000 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":970,"x2":0,"y2":1030,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1000,"y1":970,"x2":1000,"y2":1030,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: STANDARD・未実装機構 → tick 2本のみ', () => {
  const opening = makeOpening({ coord1: 0, coord2: 1000 });
  const ctx = makeCtx({ entry: { mechanism: 'notImplementedYet' }, lodLevel: LodLevel.STANDARD, axisValue: 1500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":1470,"x2":0,"y2":1530,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1000,"y1":1470,"x2":1000,"y2":1530,"role":"symbol","weightMm":0.35}',
  ]);
});

// ================================================================
// (a') ピン留め: 蝶番系その1（ステップ11b-1。SWING・SWING_IN・PROJECT_V・DREH_KIPP）。
// probe（openingPlanSymbolProbe.mjs。実データ3文書×通常＋sweepの6本）で旧
// renderer/OpeningsLayer.jsx の出力と完全一致することを確認した後の出力を固定。
// ================================================================

test('ピン留め: SWING・STANDARD → leaf線1本＋弧1本（枠なし・inset無し）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":6.123233995736766e-14,"y2":1500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: SWING・DETAIL → 方立2本(frame)＋閉じた扉(rect)＋leaf線＋弧（専用inset付き）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":25,"y":30,"w":955,"h":30,"role":"leaf","weightMm":0.25}',
    '{"type":"line","x1":25,"y1":60,"x2":25.000000000000057,"y2":1015,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":25,"cy":60,"r":955,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
  ]);
});

test("ピン留め: SWING_IN・STANDARD → leaf線1本＋弧1本（枠なし。SWINGと同じ形。frame='none'）", () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_IN }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":6.123233995736766e-14,"y2":1500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: SWING_IN・DETAIL → 方立2本(frame)＋内法へ寄せたleaf線＋弧（inset無し。notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_IN }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":60,"x2":30.000000000000057,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":940,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: PROJECT_V・DETAIL・吊元/開き勝手が逆符号 → 弧の向きも反転（notched経路）', () => {
  const opening = makeOpening({ hingeSide: 1, swingSide: -1 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.PROJECT_V }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":970,"y1":60,"x2":970.0000000000001,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":970,"cy":60,"r":940,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: DREH_KIPP・STANDARD・吊元/開き勝手が逆符号 → 吊元がcoord2側になる', () => {
  const opening = makeOpening({ hingeSide: 1, swingSide: -1 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.DREH_KIPP }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":1000,"y1":500,"x2":1000.0000000000001,"y2":1500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":1000,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

// ================================================================
// (a'') ピン留め: 蝶番系その2（ステップ11b-2。SWING_DOUBLE・SWING_CHILD・FREE・FREE_DOUBLE・
// FIRE_DOOR・FIRE_FOLD）。probe（openingPlanSymbolProbe.mjs。実データ3文書×通常＋sweepの6本）で
// 旧renderer/OpeningsLayer.jsxの出力と完全一致することを確認した後の出力を固定。
// ================================================================

test('ピン留め: SWING_DOUBLE・STANDARD → 左右leaf線2本＋弧2本（枠なし。中央で出会う）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_DOUBLE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":3.061616997868383e-14,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"line","x1":1000,"y1":500,"x2":1000,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: SWING_DOUBLE・DETAIL → 方立2本(frame)＋内法へ寄せたleaf線2本＋弧2本（notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":60,"x2":30.00000000000003,"y2":530,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":470,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"line","x1":970,"y1":60,"x2":970,"y2":530,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":970,"cy":60,"r":470,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: SWING_CHILD・STANDARD・childRatio省略 → 既定0.3で親700/子300に分割', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_CHILD }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":4.2862637970157365e-14,"y2":1200,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":700,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"line","x1":1000,"y1":500,"x2":1000,"y2":800,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":300,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: SWING_CHILD・DETAIL・childRatio明示0.3 → 内法へ寄せたうえで同じ比で分割（notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING_CHILD, childRatio: 0.3 }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":60,"x2":30.00000000000004,"y2":718,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":658,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"line","x1":970,"y1":60,"x2":970,"y2":342,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":970,"cy":60,"r":282,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: FREE・STANDARD → 閉じ位置leaf線1本＋弧2本（両側。枠なし）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FREE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":1000,"y2":500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: FREE・DETAIL → 方立2本(frame)＋内法へ寄せた閉じ位置leaf線＋弧2本（notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FREE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":60,"x2":970,"y2":60,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":940,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"arc","cx":30,"cy":60,"r":940,"startDeg":0,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: FREE_DOUBLE・STANDARD → 両leaf各1本＋弧2本ずつ（swingSideは反転せず両leaf共通）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FREE_DOUBLE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":500,"y2":500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
    '{"type":"line","x1":1000,"y1":500,"x2":500,"y2":500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":90,"role":"arc","weightMm":0.13}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

test('ピン留め: FIRE_DOOR・STANDARD・fireLeaves/fireAngle省略 → 既定(1枚・90°)でhingeSide側1leaf＋破線弧', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":6.123233995736766e-14,"y2":1500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

test('ピン留め: FIRE_DOOR・STANDARD・fireLeaves:2 → 両枠端から対称に2leaf＋破線弧2本', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR, fireLeaves: 2 }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":3.061616997868383e-14,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
    '{"type":"line","x1":1000,"y1":500,"x2":1000,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":-90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

// QA指摘（11b-2再報告分）: fireAngle:180は既存の宣言テストではfireLeaves:1/2いずれもfireAngle
// 省略（既定90°）でしかピン留めしておらず、fireAngle自体をDOOR_OPEN_ANGLE_DEG(90)に固定する
// 変異（entry.fireAngleを読み飛ばす）を検出できなかった。|sweepDeg|=180・dash固定を明示的に固定する。
test('ピン留め: FIRE_DOOR・STANDARD・fireAngle:180・fireLeaves:1 → 弧|sweepDeg|=180・破線', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR, fireAngle: 180, fireLeaves: 1 }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":-1000,"y2":500.0000000000001,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":180,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

test('ピン留め: FIRE_DOOR・STANDARD・fireAngle:180・fireLeaves:2 → 2leafの弧が±180で逆符号（破線）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR, fireAngle: 180, fireLeaves: 2 }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":500,"x2":-500,"y2":500.00000000000006,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":180,"role":"arc","weightMm":0.13,"dash":[10,6]}',
    '{"type":"line","x1":1000,"y1":500,"x2":1500,"y2":500,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":-180,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
  const arcSigns = prims.filter(p => p.role === 'arc').map(p => Math.sign(p.sweepDeg));
  assert.deepEqual(arcSigns, [1, -1], '2leafの弧sweepDegが±180の逆符号でない');
});

test('ピン留め: FIRE_DOOR・DETAIL → 方立2本(frame)＋内法へ寄せたleaf線＋破線弧（notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":60,"x2":30.000000000000057,"y2":1000,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":940,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

test('ピン留め: FIRE_FOLD・STANDARD・fireAngle省略 → 既定90°でhingeSide側1袖（ジグザグpolyline）＋破線弧', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_FOLD }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,500,-59.99999999999999,562.5,60.00000000000001,625,-59.999999999999986,687.5,1.5308084989341916e-14,750],"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":1000,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

test('ピン留め: FIRE_FOLD・STANDARD・fireAngle:180 → 両袖（ジグザグpolyline2本）＋破線弧2本（中央で出会う）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_FOLD, fireAngle: 180 }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,500,-31.250000000000007,440,-62.49999999999999,560,-93.75000000000001,440,-125,500],"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":0,"cy":500,"r":500,"startDeg":0,"sweepDeg":180,"role":"arc","weightMm":0.13,"dash":[10,6]}',
    '{"type":"polyline","points":[1000,500,1031.25,560,1062.5,440,1093.75,560,1125,500],"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":1000,"cy":500,"r":500,"startDeg":180,"sweepDeg":-180,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

test('ピン留め: FIRE_FOLD・DETAIL → 方立2本(frame)＋内法へ寄せたジグザグpolyline＋破線弧（notched経路）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_FOLD }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,-72,30,-72,30,30,20,30,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,-72,970,-72,970,30,980,30,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[30,60,-29.999999999999996,118.75,90,177.5,-29.99999999999999,236.25,30.000000000000014,295],"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":30,"cy":60,"r":940,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13,"dash":[10,6]}',
  ]);
});

// ================================================================
// (a''') ピン留め: 引戸系＋上げ下げ窓（ステップ11c。SLIDE_DOUBLE・SLIDE_SINGLE・SLIDE_LAYOUT・
// HUNG）とsashOpen枠。probe（openingPlanSymbolProbe.mjs。実データ3文書×通常＋sweepの6本。
// sweepはsingleSliding/splitSliding/flankSliding/doubleSliding3/doubleSliding4を含む全builtin
// subType）で旧renderer/OpeningsLayer.jsxの出力と完全一致することを確認した後の出力を固定。
// ================================================================

test('ピン留め: SLIDE_DOUBLE・STANDARD → 枠矩形(frame)＋leaf線2本(symbol)', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":1000,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":490,"x2":560,"y2":490,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":440,"y1":510,"x2":1000,"y2":510,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_DOUBLE・DETAIL・category=door → 枠矩形(frame)＋2トラック矩形(symbol)＋気密材破線（ガラス線なし）', () => {
  const opening = makeOpening({ category: OpeningCategory.FITTING });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":-72,"w":1000,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":0,"y":-68,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"rect","x":440,"y":2,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":500,"y1":-68,"x2":500,"y2":68,"role":"symbol","weightMm":0.35,"dash":[6,4]}',
  ]);
});

test('ピン留め: SLIDE_DOUBLE・DETAIL・category=window → 上と同じ＋各サッシ中央にガラス線(symbol)2本', () => {
  const opening = makeOpening({ category: OpeningCategory.WINDOW });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":-72,"w":1000,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":0,"y":-68,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":0,"y1":-35,"x2":560,"y2":-35,"role":"symbol","weightMm":0.35}',
    '{"type":"rect","x":440,"y":2,"w":560,"h":66,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":440,"y1":35,"x2":1000,"y2":35,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":500,"y1":-68,"x2":500,"y2":68,"role":"symbol","weightMm":0.35,"dash":[6,4]}',
  ]);
});

test('ピン留め: SLIDE_SINGLE・STANDARD → 枠矩形(frame)＋全長leaf線1本(symbol)（frame=none。開口全幅のまま）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_SINGLE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":1000,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":490,"x2":1000,"y2":490,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_SINGLE・DETAIL → sashOpen枠（コの字2本）＋内法へ寄せた枠矩形＋leaf線（frame=sashOpen）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_SINGLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[30,-72,0,-72,0,72,30,72],"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[970,-72,1000,-72,1000,72,970,72],"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":30,"y":-72,"w":940,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":-36,"x2":970,"y2":-36,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: HUNG・STANDARD → 枠矩形(frame)＋両トラックに全長線1本ずつ(symbol)', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.HUNG }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":1000,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":490,"x2":1000,"y2":490,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":0,"y1":510,"x2":1000,"y2":510,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: HUNG・DETAIL → sashOpen枠（コの字2本）＋内法へ寄せた枠矩形＋両トラック線2本', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.HUNG }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[30,-72,0,-72,0,72,30,72],"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[970,-72,1000,-72,1000,72,970,72],"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":30,"y":-72,"w":940,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":-36,"x2":970,"y2":-36,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":36,"x2":970,"y2":36,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_LAYOUT・singleSliding（片引き窓。tracks:2・panels:[pos,fix]）・STANDARD', () => {
  const opening = makeOpening();
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":1000,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":510,"x2":560,"y2":510,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":440,"y1":490,"x2":1000,"y2":490,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_LAYOUT・singleSliding・DETAIL → sashOpen枠＋内法へ寄せたパネルleaf線', () => {
  const opening = makeOpening();
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[30,-72,0,-72,0,72,30,72],"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[970,-72,1000,-72,1000,72,970,72],"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":30,"y":-72,"w":940,"h":144,"role":"frame","weightMm":0.35}',
    '{"type":"line","x1":30,"y1":36,"x2":556.4,"y2":36,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":443.6,"y1":-36,"x2":970,"y2":-36,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_LAYOUT・splitSliding（引き分け窓。tracks:2・panels:[fix,neg,pos,fix]）・STANDARD → leaf線4本', () => {
  const opening = makeOpening({ width: 2600, coord2: 2600 });
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ fix: true }, { arrow: 'neg' }, { arrow: 'pos' }, { fix: true }] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":2600,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":490,"x2":806,"y2":490,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":494,"y1":510,"x2":1456,"y2":510,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1144,"y1":510,"x2":2106,"y2":510,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1794,"y1":490,"x2":2600,"y2":490,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_LAYOUT・flankSliding（両袖片引き窓。tracks:2・panels:[pos,fix,neg]）・STANDARD → leaf線3本', () => {
  const opening = makeOpening({ width: 2550, coord2: 2550 });
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }, { arrow: 'neg' }] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":2550,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":510,"x2":1003,"y2":510,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":697,"y1":490,"x2":1853,"y2":490,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1547,"y1":510,"x2":2550,"y2":510,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: SLIDE_LAYOUT・doubleSliding3（3枚建て引違い窓。tracks:3・panels:[neg,both,pos]）・STANDARD → trackOfがindex%3', () => {
  const opening = makeOpening({ width: 2550, coord2: 2550 });
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 3, panels: [{ arrow: 'neg' }, { arrow: 'both' }, { arrow: 'pos' }] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"rect","x":0,"y":480,"w":2550,"h":40,"role":"frame","weightMm":0.25}',
    '{"type":"line","x1":0,"y1":486.6666666666667,"x2":1003,"y2":486.6666666666667,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":697,"y1":500,"x2":1853,"y2":500,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1547,"y1":513.3333333333334,"x2":2550,"y2":513.3333333333334,"role":"symbol","weightMm":0.35}',
  ]);
});

// ================================================================
// (b) 不変条件
// ================================================================

test('不変条件: SCHEMATICではFRAME_ONLYもtick（機構を問わず簡略表示）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FRAME_ONLY }, lodLevel: LodLevel.SCHEMATIC });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.length, 2);
  assert.ok(prims.every(p => p.type === 'line'));
});

test("不変条件: tickはrole='symbol'固定（weightMmはopening.lineWeightをそのまま転写）", () => {
  const opening = makeOpening({ lineWeight: 0.5 });
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.STANDARD });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  for (const p of prims) {
    assert.equal(p.role, 'symbol');
    assert.equal(p.weightMm, 0.5);
  }
});

test('planSymbolWeightMm: role別の太さ（symbol/frame/leaf/arc）', () => {
  const opening = makeOpening({ lineWeight: 0.5 });
  assert.equal(planSymbolWeightMm('symbol', opening, false), 0.5);
  assert.equal(planSymbolWeightMm('leaf', opening, false), LINE_WEIGHT_MM.medium);
  assert.equal(planSymbolWeightMm('arc', opening, false), LINE_WEIGHT_MM.thin);
  assert.equal(planSymbolWeightMm('frame', opening, false), LINE_WEIGHT_MM.medium); // wallFinishLineWeight(false)
  assert.equal(planSymbolWeightMm('frame', opening, true), LINE_WEIGHT_MM.thick);   // wallFinishLineWeight(true)
});

test('planSymbolWeightMm: 未知のroleはTypeError', () => {
  const opening = makeOpening();
  assert.throws(() => planSymbolWeightMm('bogus', opening, false), TypeError);
});

// ---- 蝶番系その1（SWING_GROUP_MECHANISMS）専用の不変条件 ----

test('不変条件: 蝶番系その1は扉線がrole=leaf(medium)・動作弧がrole=arc(thin)固定（4機構×STANDARD/DETAILで揺れない）', () => {
  const mechanisms = [OpeningMechanism.SWING, OpeningMechanism.SWING_IN, OpeningMechanism.PROJECT_V, OpeningMechanism.DREH_KIPP];
  for (const mechanism of mechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const opening = makeOpening();
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const prims = buildOpeningPlanSymbol(opening, ctx);
      const leaf = prims.filter(p => p.role === 'leaf');
      const arc = prims.filter(p => p.role === 'arc');
      assert.ok(leaf.length >= 1, `${mechanism}/${lodLevel}: leafが無い`);
      assert.ok(arc.length === 1, `${mechanism}/${lodLevel}: arcが1本でない`);
      assert.ok(leaf.every(p => p.weightMm === LINE_WEIGHT_MM.medium));
      assert.ok(arc.every(p => p.weightMm === LINE_WEIGHT_MM.thin));
    }
  }
});

test('不変条件: 蝶番系その1のDETAILの方立(frame)はwallFinishLineWeight(true)固定', () => {
  const mechanisms = [OpeningMechanism.SWING, OpeningMechanism.SWING_IN, OpeningMechanism.PROJECT_V, OpeningMechanism.DREH_KIPP];
  for (const mechanism of mechanisms) {
    const opening = makeOpening();
    const ctx = makeCtx({ entry: { mechanism }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    const frame = prims.filter(p => p.role === 'frame');
    assert.equal(frame.length, 2, `${mechanism}: 方立が2本でない`);
    assert.ok(frame.every(p => p.type === 'polyline' && p.closed === true));
    assert.ok(frame.every(p => p.weightMm === LINE_WEIGHT_MM.thick)); // wallFinishLineWeight(true)

    // QA指摘（11c再報告分）: 既定lineWeight(0.35)==thick(0.35)で枠↔leaf/arcの取り違えが数値上
    // 一致してしまうため、opening.lineWeightをthickと異なる値(0.5)にしても方立のweightMmが
    // thickのまま変わらないこと（opening.lineWeightに連動していないこと）を追加で固定する。
    const distinctWeightOpening = makeOpening({ lineWeight: 0.5 });
    const distinctCtx = makeCtx({ entry: { mechanism }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const distinctFrame = buildOpeningPlanSymbol(distinctWeightOpening, distinctCtx).filter(p => p.role === 'frame');
    assert.ok(distinctFrame.every(p => p.weightMm === LINE_WEIGHT_MM.thick), `${mechanism}: opening.lineWeight=0.5でも方立(frame)はthick固定のはず`);
  }
});

test('不変条件: SWING・STANDARDは方立(frame)を持たない（詳細LODのみ枠を描く）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.STANDARD });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.filter(p => p.role === 'frame').length, 0);
});

// QA指摘（11b-1再報告分・Minor-1）: hingeSideとswingSideを同時に反転すると
// swingOpenPerpDir=(isVertical?1:-1)*swingSide*hingeSideの積が不変（符号が2回反転して打ち消し合う）
// ため、旧テストの(hingeSide,swingSide)=(-1,1)と(1,-1)はopenPerpDirが同値のまま——rect.xの差は
// 吊元（hingeAlong。leafの長さ方向の起点）がcoord1側/coord2側へ移るだけの効果で、leafOutward
// （壁厚方向＝水平壁ではrect.y）の反転を検出していなかった（closedLeaf.outwardを1に固定する変異・
// swingFramePrimitivesのoutwardを1に固定する変異のどちらも全体実行4428件緑のまま＝probeだけが
// 捕まえた）。hingeSideを固定しswingSideだけ反転させ、perp成分（水平壁なのでy）を比較することで
// leafOutward自体の反転を検出する。
test('不変条件: SWING・DETAILの閉じた扉(rect)はleafOutward側——吊元を固定し開き勝手だけ反転するとrect.y（perp成分）が反転する', () => {
  const base = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const rectY = (swingSide) => {
    const prims = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1, swingSide }), base);
    return prims.find(p => p.type === 'rect').y;
  };
  const outward = rectY(1);  // openPerpDir=+1（faceHi側）
  const inward = rectY(-1);  // openPerpDir=-1（faceLo側）
  assert.notEqual(outward, inward, 'swingSide反転でleafOutward（rect.y）が変わらない');
  assert.ok(outward > 0 && inward < 0, `outward/inwardがfaceHi/faceLo側に分かれていない: outward=${outward} inward=${inward}`);
});

test('ピン留め: SWING・DETAIL・openPerpDir=-1（hingeSide:-1,swingSide:-1）→ 閉じた扉rectと方立の欠き込みがfaceLo側', () => {
  const opening = makeOpening({ hingeSide: -1, swingSide: -1 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,72,30,72,30,-30,20,-30,20,-72,0,-72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,72,970,72,970,-30,980,-30,980,-72,1000,-72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":25,"y":-60,"w":955,"h":30,"role":"leaf","weightMm":0.25}',
    '{"type":"line","x1":25,"y1":-60,"x2":25.000000000000057,"y2":-1015,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":25,"cy":-60,"r":955,"startDeg":0,"sweepDeg":-90,"role":"arc","weightMm":0.13}',
  ]);
});

// ---- 蝶番系その2（HINGE_GROUP2_MECHANISMS）専用の不変条件 ----

test('不変条件: 蝶番系その2は扉線がrole=leaf(medium)・動作弧がrole=arc(thin)固定（6機構×STANDARD/DETAILで揺れない）', () => {
  const mechanisms = [
    OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FREE,
    OpeningMechanism.FREE_DOUBLE, OpeningMechanism.FIRE_DOOR, OpeningMechanism.FIRE_FOLD,
  ];
  for (const mechanism of mechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const opening = makeOpening();
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const prims = buildOpeningPlanSymbol(opening, ctx);
      const leaf = prims.filter(p => p.role === 'leaf');
      const arc = prims.filter(p => p.role === 'arc');
      assert.ok(leaf.length >= 1, `${mechanism}/${lodLevel}: leafが無い`);
      assert.ok(arc.length >= 1, `${mechanism}/${lodLevel}: arcが無い`);
      assert.ok(leaf.every(p => p.weightMm === LINE_WEIGHT_MM.medium), `${mechanism}/${lodLevel}`);
      assert.ok(arc.every(p => p.weightMm === LINE_WEIGHT_MM.thin), `${mechanism}/${lodLevel}`);
    }
  }
});

test('不変条件: 蝶番系その2のDETAILの方立(frame)はwallFinishLineWeight(true)固定（SWINGのような専用inset扱いを持たない）', () => {
  const mechanisms = [
    OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FREE,
    OpeningMechanism.FREE_DOUBLE, OpeningMechanism.FIRE_DOOR, OpeningMechanism.FIRE_FOLD,
  ];
  for (const mechanism of mechanisms) {
    const opening = makeOpening();
    const ctx = makeCtx({ entry: { mechanism }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    const frame = prims.filter(p => p.role === 'frame');
    assert.equal(frame.length, 2, `${mechanism}: 方立が2本でない`);
    assert.ok(frame.every(p => p.type === 'polyline' && p.closed === true));
    assert.ok(frame.every(p => p.weightMm === LINE_WEIGHT_MM.thick));

    // QA指摘（11c再報告分）: 上の蝶番系その1と同じ理由で、opening.lineWeightをthickと異なる
    // 値(0.5)にしても方立(frame)がthick固定のままであることを追加で固定する。
    const distinctWeightOpening = makeOpening({ lineWeight: 0.5 });
    const distinctCtx = makeCtx({ entry: { mechanism }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const distinctFrame = buildOpeningPlanSymbol(distinctWeightOpening, distinctCtx).filter(p => p.role === 'frame');
    assert.ok(distinctFrame.every(p => p.weightMm === LINE_WEIGHT_MM.thick), `${mechanism}: opening.lineWeight=0.5でも方立(frame)はthick固定のはず`);
  }
});

test('不変条件: FREE・FREE_DOUBLEは1leafあたり弧2本（swingSide側とその逆側）を持つ（他の蝶番系は1leafあたり弧1本）', () => {
  const opening = makeOpening();
  const freePrims = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FREE }, lodLevel: LodLevel.STANDARD }));
  assert.equal(freePrims.filter(p => p.role === 'leaf').length, 1);
  assert.equal(freePrims.filter(p => p.role === 'arc').length, 2);

  const freeDoublePrims = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FREE_DOUBLE }, lodLevel: LodLevel.STANDARD }));
  assert.equal(freeDoublePrims.filter(p => p.role === 'leaf').length, 2);
  assert.equal(freeDoublePrims.filter(p => p.role === 'arc').length, 4);

  const swingDoublePrims = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.SWING_DOUBLE }, lodLevel: LodLevel.STANDARD }));
  assert.equal(swingDoublePrims.filter(p => p.role === 'leaf').length, 2);
  assert.equal(swingDoublePrims.filter(p => p.role === 'arc').length, 2); // 1leafあたり1本
});

test('不変条件: FIRE_DOOR/FIRE_FOLDの動作弧はdash=[10,6]（FIRE_ARC_DASH_MM）固定——他の蝶番系その2は弧にdashを持たない', () => {
  const opening = makeOpening();
  const fireMechanisms = [OpeningMechanism.FIRE_DOOR, OpeningMechanism.FIRE_FOLD];
  for (const mechanism of fireMechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const prims = buildOpeningPlanSymbol(opening, ctx);
      const arc = prims.filter(p => p.role === 'arc');
      assert.ok(arc.length >= 1, `${mechanism}/${lodLevel}: arcが無い`);
      assert.ok(arc.every(p => Array.isArray(p.dash) && p.dash[0] === 10 && p.dash[1] === 6), `${mechanism}/${lodLevel}: 破線弧でない`);
    }
  }
  const nonFireMechanisms = [OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FREE, OpeningMechanism.FREE_DOUBLE];
  for (const mechanism of nonFireMechanisms) {
    const ctx = makeCtx({ entry: { mechanism }, lodLevel: LodLevel.STANDARD });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    const arc = prims.filter(p => p.role === 'arc');
    assert.ok(arc.every(p => p.dash === undefined), `${mechanism}: 弧にdashを持たないはずが持っている`);
  }
});

// QA指摘（11b-1）「hingeSideとswingSideを同時反転すると符号の積が不変で検出できない」教訓の再発防止:
// SWING_DOUBLE/FIRE_DOOR(fireLeaves:2)/FIRE_FOLD(fireAngle:180)の2枚leafは*LeafSpecs
// （openingPlanSymbolGeometry.js）がcoord2側leafのsenseだけを反転して渡す（同じ物理側=perp側へ
// 開かせるため）。coord1側(closedAngle=0)とcoord2側(closedAngle=180)は基準角が180°違うため、
// sweepDeg自体の符号は常に逆（[+1,-1]または[-1,+1]）——これがsenseの符号反転が正しく効いている
// 証拠（*LeafSpecsのsense反転を外すと両leafが同じ基準角からのsweepDeg符号になり[+1,+1]/[-1,-1]へ
// 崩れる。leafSpecGroupPrimitives内 s.sense→-s.sense変異はscratchpad probe実測で検出済み。
// x1/x2やsweepDegが反転する）。swingSideを反転すると2本とも連動して符号が入れ替わることも併せて
// 固定する。
test('不変条件: 2枚leaf構成（SWING_DOUBLE等）はcoord1/coord2側leafの弧sweepDegが常に逆符号で、swingSide反転で両方入れ替わる', () => {
  const openArcSweepSigns = (mechanism, swingSide, extra = {}) => {
    const opening = makeOpening({ swingSide });
    const ctx = makeCtx({ entry: { mechanism, ...extra }, lodLevel: LodLevel.STANDARD });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    return prims.filter(p => p.role === 'arc').map(p => Math.sign(p.sweepDeg));
  };
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.SWING_DOUBLE, 1), [1, -1]);
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.SWING_DOUBLE, -1), [-1, 1]);
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.FIRE_DOOR, 1, { fireLeaves: 2 }), [1, -1]);
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.FIRE_DOOR, -1, { fireLeaves: 2 }), [-1, 1]);
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.FIRE_FOLD, 1, { fireAngle: 180 }), [1, -1]);
  assert.deepEqual(openArcSweepSigns(OpeningMechanism.FIRE_FOLD, -1, { fireAngle: 180 }), [-1, 1]);
});

// ---- 引戸系＋上げ下げ窓（ステップ11c）専用の不変条件 ----

// sashOpen枠（SASH_OPEN_GROUP_MECHANISMSのDETAIL）はコの字（内側=開口側の縦線を持たない3辺）
// ——蝶番系のjambOutlinePoints（6点・closed:true）とは異なり4点・closed無し（旧sashFrameOpenSymbol
// は<Line>にclosed・fill="transparent"のどちらも持たない）。
test('不変条件: SASH_OPEN_GROUP_MECHANISMS（SLIDE_SINGLE・SLIDE_LAYOUT・HUNG）のDETAIL方立(frame)はコの字4点・closed無し（内側縦線を持たない）', () => {
  const mechanisms = [
    { mechanism: OpeningMechanism.SLIDE_SINGLE },
    { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } },
    { mechanism: OpeningMechanism.HUNG },
  ];
  for (const entry of mechanisms) {
    const opening = makeOpening();
    const ctx = makeCtx({ entry, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    const frame = prims.filter(p => p.type === 'polyline' && p.role === 'frame');
    assert.equal(frame.length, 2, `${entry.mechanism}: sashOpen方立が2本でない`);
    assert.ok(frame.every(p => p.points.length === 8), `${entry.mechanism}: sashOpen方立が4点(コの字)でない`);
    assert.ok(frame.every(p => !p.closed), `${entry.mechanism}: sashOpen方立が閉じている（内側縦線を持ってしまう）`);
    assert.ok(frame.every(p => p.weightMm === LINE_WEIGHT_MM.thick), `${entry.mechanism}: wallFinishLineWeight(true)固定でない`);
  }
});

// QA指摘（11c再報告分）: makeOpeningの既定lineWeight(0.35)がDETAILの枠太さ(thick=0.35)と
// 同値のため、role='frame'であるべきプリミティブにsymbolWeight（またはその逆）を渡す変異が
// 数値としては一致してしまい検出できない（sashFrameOpenPrimitives・slideDoubleDetailPrimitives
// のframeWeight→symbolWeight取り違えが94件全緑のまま生存）。opening.lineWeightをthickと異なる
// 値（0.5=ultraThick）にして、role→weightMmの対応をrole別に直接固定する。
test('不変条件: DETAILのSLIDE_DOUBLE・SLIDE_SINGLE・SLIDE_LAYOUT(singleSliding)・HUNGは、opening.lineWeightがthickと異なる値でもrole=frameは常にthick・role=symbolは常にopening.lineWeightのまま（枠↔記号の取り違え検出）', () => {
  const singleSliding = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } };
  const entries = [
    { mechanism: OpeningMechanism.SLIDE_DOUBLE }, { mechanism: OpeningMechanism.SLIDE_SINGLE },
    singleSliding, { mechanism: OpeningMechanism.HUNG },
  ];
  for (const entry of entries) {
    const opening = makeOpening({ lineWeight: 0.5, category: OpeningCategory.WINDOW });
    const ctx = makeCtx({ entry, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    assert.ok(prims.length > 0, `${entry.mechanism}: プリミティブが空`);
    for (const p of prims) {
      if (p.role === 'frame') {
        assert.equal(p.weightMm, LINE_WEIGHT_MM.thick, `${entry.mechanism}: role=frameのweightMmがthickでない（symbolWeightと取り違えている疑い）`);
      } else if (p.role === 'symbol') {
        assert.equal(p.weightMm, 0.5, `${entry.mechanism}: role=symbolのweightMmがopening.lineWeightでない（frameWeightと取り違えている疑い）`);
      } else {
        assert.fail(`${entry.mechanism}: 想定外のrole: ${p.role}`);
      }
    }
    assert.ok(prims.some(p => p.role === 'frame'), `${entry.mechanism}: role=frameが1件も無い`);
    assert.ok(prims.some(p => p.role === 'symbol'), `${entry.mechanism}: role=symbolが1件も無い`);
  }
});

// SLIDE_DOUBLEの2本のleaf線（symbol）は開口中央付近でoverlap=max(width*0.12,60)ぶん重なる
// （旧slideDoubleLeafLines。widthを変えても符号・重なり量が崩れないことを固定する）。
test('不変条件: SLIDE_DOUBLEのSTANDARDのleaf線2本はcenterCoord付近でoverlap=max(width*0.12,60)ぶん重なる', () => {
  for (const width of [400, 1000, 3000]) {
    const opening = makeOpening({ coord1: 0, coord2: width, centerCoord: width / 2, width });
    const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.STANDARD, axisValue: 500 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    const [leaf1, leaf2] = prims.filter(p => p.type === 'line');
    const overlap = Math.max(width * 0.12, 60);
    assert.equal(leaf1.x2, width / 2 + overlap / 2, `width=${width}: leaf1の右端がcenterCoord+overlap/2でない`);
    assert.equal(leaf2.x1, width / 2 - overlap / 2, `width=${width}: leaf2の左端がcenterCoord-overlap/2でない`);
    assert.ok(leaf1.x2 > leaf2.x1, `width=${width}: leaf1とleaf2が重ならない`);
  }
});

// SLIDE_DOUBLEのDETAILのガラス線（symbol・dash無し）はcategory===WINDOWのときだけ描く
// （旧slideDoubleDetailSymbol category===OpeningCategory.WINDOW分岐）。気密材線（symbol・dash付き）
// はcategoryを問わず常に1本。
test('不変条件: SLIDE_DOUBLEのDETAILはcategory=windowのときだけガラス線(dash無しline)2本が増える', () => {
  const makeCtxFor = () => makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const doorPrims = buildOpeningPlanSymbol(makeOpening({ category: OpeningCategory.FITTING }), makeCtxFor());
  const windowPrims = buildOpeningPlanSymbol(makeOpening({ category: OpeningCategory.WINDOW }), makeCtxFor());
  const linesWithoutDash = (prims) => prims.filter(p => p.type === 'line' && p.dash === undefined);
  const linesWithDash = (prims) => prims.filter(p => p.type === 'line' && p.dash !== undefined);
  assert.equal(linesWithoutDash(doorPrims).length, 0, 'door: ガラス線が描かれてしまっている');
  assert.equal(linesWithoutDash(windowPrims).length, 2, 'window: ガラス線が2本でない');
  assert.equal(linesWithDash(doorPrims).length, 1, 'door: 気密材線(dash付き)が1本でない');
  assert.equal(linesWithDash(windowPrims).length, 1, 'window: 気密材線(dash付き)が1本でない');
  assert.ok(linesWithDash(doorPrims).every(p => p.dash[0] === 6 && p.dash[1] === 4), 'WEATHERSTRIP_DASH固定でない');
});

// SLIDE_LAYOUT（tracks:2・hasFix:false。doubleSliding4相当）はhasFixが無いためtrackOfが
// index%2で交互に振り分けられる（旧trackOf純関数の分岐。tracks:2・hasFix:trueの経路は
// 上のsingleSliding/splitSliding/flankSlidingピン留めで既に固定済み）。
test('不変条件: SLIDE_LAYOUT・tracks:2・panels全てarrow（hasFix:false）はtrackOfがindex%2で交互に振り分けられる', () => {
  const opening = makeOpening({ width: 3370, coord2: 3370 });
  const entry = {
    mechanism: OpeningMechanism.SLIDE_LAYOUT,
    slideLayout: { tracks: 2, panels: [{ arrow: 'neg' }, { arrow: 'neg' }, { arrow: 'pos' }, { arrow: 'pos' }] },
  };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.STANDARD, axisValue: 500 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  const leafPerps = prims.filter(p => p.type === 'line').map(p => p.y1);
  // index%2: 0,2番目がtrack0(axisValue-10)・1,3番目がtrack1(axisValue+10)（trackPerp・
  // tracks:2・hasFix:falseの式）。
  assert.deepEqual(leafPerps, [490, 510, 490, 510]);
});

// ================================================================
// (c) 失敗系
// ================================================================

test('失敗系: SWING・STANDARD・面線(faceLo/faceHi)がundefinedでも回転中心はaxisValue・NaN無し', () => {
  const opening = makeOpening();
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.STANDARD,
    axisValue: 777, faceLo: undefined, faceHi: undefined,
  });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  const leaf = prims.find(p => p.role === 'leaf');
  assert.equal(leaf.y1, 777); // pivotPerp===axisValue（!detailはhasFacesを見ない）
  for (const p of prims) {
    for (const k of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r']) {
      if (k in p) assert.ok(Number.isFinite(p[k]), `${k}が有限でない: ${p[k]}`);
    }
  }
});

test('失敗系: SWING・DETAIL・width<60（開口が狭い）でもNaNが混入しない', () => {
  const opening = makeOpening({ coord1: 0, coord2: 40, centerCoord: 20, width: 40 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  for (const p of prims) {
    for (const k of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'x', 'y', 'w', 'h']) {
      if (k in p) assert.ok(Number.isFinite(p[k]), `${k}が有限でない: ${p[k]}`);
    }
  }
});

// F2同型の保険（openingPlanSymbolGeometry.js swingClosedLeafSpanのコメント参照）: 半外付けで
// bandが狭い側（frameDepth<扉厚30mm）に寄ると、素のnotchFarRaw（pivotPerp-outward*扉厚）が
// band外へはみ出す——swingFramePrimitivesはこれをband内へクランプする（notchFarのクランプを
// 外す変異で検出。実データでは踏みにくい経路のため単体テストで固定する）。
test('失敗系: SWING・DETAIL・半外付けの狭い見込みでnotchFarが帯内へクランプされる（欠き込みが帯からはみ出さない）', () => {
  const opening = makeOpening({ frameDepth: 20 });
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.DETAIL,
    axisValue: 0, faceLo: -60, faceHi: 60, exteriorDirOf: () => 1,
  });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"polyline","points":[0,52,30,52,30,52,20,52,20,72,0,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"polyline","points":[1000,52,970,52,970,52,980,52,980,72,1000,72],"closed":true,"role":"frame","weightMm":0.35}',
    '{"type":"rect","x":25,"y":30,"w":955,"h":30,"role":"leaf","weightMm":0.25}',
    '{"type":"line","x1":25,"y1":60,"x2":25.000000000000057,"y2":1015,"role":"leaf","weightMm":0.25}',
    '{"type":"arc","cx":25,"cy":60,"r":955,"startDeg":0,"sweepDeg":90,"role":"arc","weightMm":0.13}',
  ]);
  // 方立の全ての座標（perp成分）がband=[52,72]の内側に収まる（notchFarがband外へはみ出さない）。
  for (const p of prims.filter(pp => pp.type === 'polyline')) {
    for (let i = 1; i < p.points.length; i += 2) {
      assert.ok(p.points[i] >= 52 - 1e-9 && p.points[i] <= 72 + 1e-9, `perp座標がband外: ${p.points[i]}`);
    }
  }
});

test('失敗系: 蝶番系その1はhingeSide/swingSideが0やundefinedでも例外を投げない（旧挙動に合わせる）', () => {
  const mechanisms = [OpeningMechanism.SWING, OpeningMechanism.SWING_IN, OpeningMechanism.PROJECT_V, OpeningMechanism.DREH_KIPP];
  for (const mechanism of mechanisms) {
    for (const [hingeSide, swingSide] of [[undefined, undefined], [0, 0]]) {
      for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
        const opening = makeOpening({ hingeSide, swingSide });
        const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
        assert.doesNotThrow(() => buildOpeningPlanSymbol(opening, ctx), `${mechanism}/${lodLevel}/${hingeSide}/${swingSide}`);
      }
    }
  }
});

test('失敗系: entry無し→tick（形状のみ確認。数値はピン留めテスト参照）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.length, 2);
  assert.ok(prims.every(p => p.role === 'symbol'));
});

test('失敗系: 未実装機構→tick（実装済みでない任意のmechanism文字列でも落ちない）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: 'someFutureMechanism' }, lodLevel: LodLevel.STANDARD });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.length, 2);
});

test('失敗系: ctx欠落→TypeError', () => {
  const opening = makeOpening();
  assert.throws(() => buildOpeningPlanSymbol(opening, undefined), TypeError);
});

test('失敗系: axisValueが非有限→TypeError', () => {
  const opening = makeOpening();
  assert.throws(() => buildOpeningPlanSymbol(opening, makeCtx({ axisValue: NaN })), TypeError);
  assert.throws(() => buildOpeningPlanSymbol(opening, makeCtx({ axisValue: undefined })), TypeError);
});

test('失敗系: exteriorDirOfが関数でない→TypeError', () => {
  const opening = makeOpening();
  assert.throws(() => buildOpeningPlanSymbol(opening, makeCtx({ exteriorDirOf: 1 })), TypeError);
});

test('失敗系: lodLevelが未知→TypeError', () => {
  const opening = makeOpening();
  assert.throws(() => buildOpeningPlanSymbol(opening, makeCtx({ lodLevel: 'ultraDetail' })), TypeError);
});

test('失敗系: SCHEMATICではexteriorDirOfを1回も呼ばない（見込帯を組まないため）', () => {
  const opening = makeOpening({ frameDepth: 50 });
  let calls = 0;
  const ctx = makeCtx({ lodLevel: LodLevel.SCHEMATIC, exteriorDirOf: () => { calls += 1; return 1; } });
  buildOpeningPlanSymbol(opening, ctx);
  assert.equal(calls, 0);
});

test('失敗系: DETAIL・未実装機構・frameDepth>0ではexteriorDirOfをちょうど1回だけ呼ぶ（メモ化）', () => {
  const opening = makeOpening({ frameDepth: 50 });
  let calls = 0;
  const ctx = makeCtx({
    entry: { mechanism: 'someFutureMechanism' },
    lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0,
    exteriorDirOf: () => { calls += 1; return 1; },
  });
  buildOpeningPlanSymbol(opening, ctx);
  assert.equal(calls, 1);
});

// QA指摘（11a再報告分）: exteriorDirOfを呼ぶのは「DETAILかつframeDepth>0」の両方が揃うときだけ
// ——どちらか一方が欠けると呼ばない・実装済み機構でnullを返す経路も呼ばないことを個別に固定する
// （「DETAILなら常に呼ぶ」「frameDepth>0なら常に呼ぶ」という部分的な変異が生存しないようにする）。
test('失敗系: STANDARD・entry無し・frameDepth=50ではexteriorDirOfを呼ばない（DETAILでないため）', () => {
  const opening = makeOpening({ frameDepth: 50 });
  let calls = 0;
  const ctx = makeCtx({
    entry: null, lodLevel: LodLevel.STANDARD,
    exteriorDirOf: () => { calls += 1; return 1; },
  });
  buildOpeningPlanSymbol(opening, ctx);
  assert.equal(calls, 0);
});

test('失敗系: DETAIL・entry無し・frameDepth=0ではexteriorDirOfを呼ばない（見込み未指定のため壁厚いっぱいへ縮退）', () => {
  const opening = makeOpening({ frameDepth: 0 });
  let calls = 0;
  const ctx = makeCtx({
    entry: null, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0,
    exteriorDirOf: () => { calls += 1; return 1; },
  });
  buildOpeningPlanSymbol(opening, ctx);
  assert.equal(calls, 0);
});

// SWING（本ステップ11b-1で移行済み）ではなく、まだ未移行のFIXED（windowLine群。11dで移行予定）
// で暫定契約を確認する（移行済み以外は引き続きnull＋band計算ゼロ＝exteriorDirOf未呼び出し。
// 11cでSLIDE_DOUBLEを移行したため、このテストの主語をFIXEDへ差し替えた）。
test('失敗系: DETAIL・実装済み機構(FIXED・未移行)・frameDepth=50はnullを返し、exteriorDirOfも呼ばない（暫定契約の副作用ゼロ）', () => {
  const opening = makeOpening({ frameDepth: 50 });
  let calls = 0;
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.FIXED }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0,
    exteriorDirOf: () => { calls += 1; return 1; },
  });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims, null);
  assert.equal(calls, 0);
});

// ピン留め: DETAIL・entry無し・frameDepth=50・exteriorDir=±1 → 帯（見込み）が室外側へ寄るため
// tickのaxisValue（band.center）がexteriorDirの符号で反転する（J4: 見込帯の唯一の分岐点が
// buildOpeningPlanSymbol側に正しく移っていることをexteriorDirOfの戻り値経由で確認する）。
test('ピン留め: DETAIL・entry無し・frameDepth=50・exteriorDir=+1 → 帯は室外側(faceHi側)へ寄りtickも追従', () => {
  const opening = makeOpening({ frameDepth: 50 });
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0, exteriorDirOf: () => 1 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":17,"x2":0,"y2":77,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1000,"y1":17,"x2":1000,"y2":77,"role":"symbol","weightMm":0.35}',
  ]);
});

test('ピン留め: DETAIL・entry無し・frameDepth=50・exteriorDir=-1 → 帯は室外側(faceLo側)へ寄りtickも追従', () => {
  const opening = makeOpening({ frameDepth: 50 });
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0, exteriorDirOf: () => -1 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.deepEqual(prims.map(p => JSON.stringify(p)), [
    '{"type":"line","x1":0,"y1":-77,"x2":0,"y2":-17,"role":"symbol","weightMm":0.35}',
    '{"type":"line","x1":1000,"y1":-77,"x2":1000,"y2":-17,"role":"symbol","weightMm":0.35}',
  ]);
});

test('失敗系: 面線(faceLo/faceHi)がundefinedでもNaNが混入しない（STANDARD・entry無し）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: null, lodLevel: LodLevel.STANDARD, faceLo: undefined, faceHi: undefined });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  for (const p of prims) {
    assert.ok(Number.isFinite(p.x1) && Number.isFinite(p.y1) && Number.isFinite(p.x2) && Number.isFinite(p.y2));
  }
});

test('失敗系: width<60（開口が狭い）でもNaNが混入しない', () => {
  const opening = makeOpening({ coord1: 0, coord2: 40, centerCoord: 20, width: 40 });
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.SCHEMATIC });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.length, 4);
  for (const p of prims) {
    assert.ok(Number.isFinite(p.x1) && Number.isFinite(p.y1) && Number.isFinite(p.x2) && Number.isFinite(p.y2));
  }
});

// ---- 蝶番系その2（HINGE_GROUP2_MECHANISMS）専用の失敗系 ----

test('失敗系: SWING_CHILD・childRatio省略 → 既定0.3（entry.childRatioが無くても親700/子300、ピン留めテスト参照の比と一致）', () => {
  const opening = makeOpening();
  const withoutRatio = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.SWING_CHILD }, lodLevel: LodLevel.STANDARD }));
  const withRatio = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.SWING_CHILD, childRatio: 0.3 }, lodLevel: LodLevel.STANDARD }));
  assert.deepEqual(withoutRatio.map(p => JSON.stringify(p)), withRatio.map(p => JSON.stringify(p)));
});

test('失敗系: FIRE_DOOR・fireLeaves/fireAngle省略 → 既定(1枚・90°)。fireLeaves明示1・fireAngle明示90と一致', () => {
  const opening = makeOpening();
  const omitted = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR }, lodLevel: LodLevel.STANDARD }));
  const explicit = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR, fireLeaves: 1, fireAngle: 90 }, lodLevel: LodLevel.STANDARD }));
  assert.deepEqual(omitted.map(p => JSON.stringify(p)), explicit.map(p => JSON.stringify(p)));
});

test('失敗系: FIRE_FOLD・fireAngle省略 → 既定90°。明示90と一致', () => {
  const opening = makeOpening();
  const omitted = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_FOLD }, lodLevel: LodLevel.STANDARD }));
  const explicit = buildOpeningPlanSymbol(opening, makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_FOLD, fireAngle: 90 }, lodLevel: LodLevel.STANDARD }));
  assert.deepEqual(omitted.map(p => JSON.stringify(p)), explicit.map(p => JSON.stringify(p)));
});

test('失敗系: FIRE_DOOR・fireLeaves:2はopening.hingeSideが±どちらでも出力が同じ（hingeSideMatters=falseの機構はhingeSideを問わない）', () => {
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIRE_DOOR, fireLeaves: 2 }, lodLevel: LodLevel.STANDARD });
  const neg = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1 }), ctx);
  const pos = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1 }), ctx);
  assert.deepEqual(neg.map(p => JSON.stringify(p)), pos.map(p => JSON.stringify(p)));
});

// QA指摘（11b-2再報告分）: hingeSideMatters（openingCatalog.js）がtrueを返す機構は、swingSideを
// 固定してhingeSideだけ変えると吊元（hingeAlong）がcoord1↔coord2へ動くはず。単に「出力全体が
// 変わるか」だけの検証は弱い——FREEはclosedAngleFor(hingeSide)がhingeAlongと無関係に閉じ角度・
// 動作方向も反転させるため、「hingeAlongをcoord1固定にする変異」を入れても弧の向き等が変わって
// 出力全体としては差分が出てしまい検出できなかった（実測: notDeepEqualだけの版は全緑のまま）。
// 吊元の位置そのもの（先頭プリミティブの長さ方向座標＝水平壁ではx。line=x1／polyline=points[0]）
// がcoord1(0)/coord2(1000)へ正しく切り替わることを直接固定する。
function hingeAlongOf(prim) {
  return prim.type === 'polyline' ? prim.points[0] : prim.x1;
}
test('不変条件: hingeSideMatters=trueの機構（SWING_CHILD/FREE/FIRE_DOOR fireLeaves:1/FIRE_FOLD fireAngle:90）はswingSide固定でhingeSideを-1→+1に変えると吊元がcoord1→coord2へ動く', () => {
  const cases = [
    { mechanism: OpeningMechanism.SWING_CHILD, extra: {} },
    { mechanism: OpeningMechanism.FREE, extra: {} },
    { mechanism: OpeningMechanism.FIRE_DOOR, extra: { fireLeaves: 1 } },
    { mechanism: OpeningMechanism.FIRE_FOLD, extra: { fireAngle: 90 } },
  ];
  for (const { mechanism, extra } of cases) {
    const ctx = makeCtx({ entry: { mechanism, ...extra }, lodLevel: LodLevel.STANDARD });
    const neg = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1 }), ctx);
    const pos = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1 }), ctx);
    assert.equal(hingeAlongOf(neg[0]), 0, `${mechanism}: hingeSide:-1の吊元がcoord1(0)でない`);
    assert.equal(hingeAlongOf(pos[0]), 1000, `${mechanism}: hingeSide:+1の吊元がcoord2(1000)でない`);
  }
});

// hingeSideMatters=falseの機構（対向leafが両方あるため片方のhingeSideは意味を持たない）は、
// FIRE_DOOR・fireLeaves:2（上のテスト）に加えて残り3機構（SWING_DOUBLE・FREE_DOUBLE・
// FIRE_FOLD fireAngle:180）でも同じ不変条件を固定する。
test('不変条件: hingeSideMatters=falseの機構（SWING_DOUBLE/FREE_DOUBLE/FIRE_FOLD fireAngle:180）はhingeSide±で出力が同一', () => {
  const cases = [
    { mechanism: OpeningMechanism.SWING_DOUBLE, extra: {} },
    { mechanism: OpeningMechanism.FREE_DOUBLE, extra: {} },
    { mechanism: OpeningMechanism.FIRE_FOLD, extra: { fireAngle: 180 } },
  ];
  for (const { mechanism, extra } of cases) {
    const ctx = makeCtx({ entry: { mechanism, ...extra }, lodLevel: LodLevel.STANDARD });
    const neg = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1 }), ctx);
    const pos = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1 }), ctx);
    assert.deepEqual(neg.map(p => JSON.stringify(p)), pos.map(p => JSON.stringify(p)), `${mechanism}: hingeSideを問わないはずが出力が変わる`);
  }
});

test('失敗系: 蝶番系その2はhingeSide/swingSideが0やundefinedでも例外を投げない（旧挙動に合わせる）', () => {
  const mechanisms = [
    OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FREE,
    OpeningMechanism.FREE_DOUBLE, OpeningMechanism.FIRE_DOOR, OpeningMechanism.FIRE_FOLD,
  ];
  for (const mechanism of mechanisms) {
    for (const [hingeSide, swingSide] of [[undefined, undefined], [0, 0]]) {
      for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
        const opening = makeOpening({ hingeSide, swingSide });
        const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
        assert.doesNotThrow(() => buildOpeningPlanSymbol(opening, ctx), `${mechanism}/${lodLevel}/${hingeSide}/${swingSide}`);
      }
    }
  }
});

test('失敗系: 蝶番系その2はwidth<60（開口が狭い）でもNaNが混入しない（SWING_CHILD・FIRE_FOLDで確認）', () => {
  const narrowOpening = makeOpening({ coord1: 0, coord2: 40, centerCoord: 20, width: 40 });
  for (const mechanism of [OpeningMechanism.SWING_CHILD, OpeningMechanism.FIRE_FOLD]) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const prims = buildOpeningPlanSymbol(narrowOpening, ctx);
      for (const p of prims) {
        for (const k of ['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r']) {
          if (k in p) assert.ok(Number.isFinite(p[k]), `${mechanism}/${lodLevel}: ${k}が有限でない: ${p[k]}`);
        }
        if (p.type === 'polyline') {
          for (const v of p.points) assert.ok(Number.isFinite(v), `${mechanism}/${lodLevel}: polyline座標が有限でない: ${v}`);
        }
      }
    }
  }
});

// ---- 引戸系＋上げ下げ窓（ステップ11c）専用の失敗系 ----

test('失敗系: SLIDE_LAYOUT・entry.slideLayout未設定（panels 0枚）→ 枠矩形(frame)だけ（STANDARD/DETAILとも）', () => {
  for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
    const opening = makeOpening();
    const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_LAYOUT }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
    const prims = buildOpeningPlanSymbol(opening, ctx);
    // DETAILはsashOpen枠（コの字2本）＋枠矩形1本＝計3件、STANDARDは枠矩形1本のみ。
    // いずれもrole='symbol'（パネルleaf線）は0件——resolveSlideLayoutPanels(entry)が空配列を
    // 返す（entry.slideLayout自体が無い）ため。
    const symbolPrims = prims.filter(p => p.role === 'symbol');
    assert.equal(symbolPrims.length, 0, `${lodLevel}: パネル0枚のはずがsymbolプリミティブがある`);
    assert.ok(prims.every(p => p.role === 'frame'), `${lodLevel}: 枠(frame)以外が混入している`);
  }
});

test('失敗系: SLIDE_LAYOUT・panels:[]（entry.slideLayout.tracksはあるがpanels空配列）でも枠矩形だけ・例外なし', () => {
  const opening = makeOpening();
  const entry = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [] } };
  const ctx = makeCtx({ entry, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0 });
  const prims = buildOpeningPlanSymbol(opening, ctx);
  assert.equal(prims.filter(p => p.role === 'symbol').length, 0);
  assert.ok(prims.every(p => p.role === 'frame'));
});

test('失敗系: SLIDE_DOUBLE・SLIDE_SINGLE・SLIDE_LAYOUT・HUNGはwidth<60（開口が狭い）でもNaNが混入しない（STANDARD/DETAILとも）', () => {
  const narrowOpening = makeOpening({ coord1: 0, coord2: 40, centerCoord: 20, width: 40 });
  const singleSliding = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } };
  const entries = [
    { mechanism: OpeningMechanism.SLIDE_DOUBLE }, { mechanism: OpeningMechanism.SLIDE_SINGLE },
    singleSliding, { mechanism: OpeningMechanism.HUNG },
  ];
  for (const entry of entries) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const ctx = makeCtx({ entry, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const prims = buildOpeningPlanSymbol(narrowOpening, ctx);
      for (const p of prims) {
        for (const k of ['x1', 'y1', 'x2', 'y2', 'x', 'y', 'w', 'h']) {
          if (k in p) assert.ok(Number.isFinite(p[k]), `${entry.mechanism}/${lodLevel}: ${k}が有限でない: ${p[k]}`);
        }
      }
    }
  }
});

test('失敗系: SASH_OPEN_GROUP_MECHANISMSはhingeSide/swingSideを問わず出力が同じ（非蝶番系のため無関係）', () => {
  const singleSliding = { mechanism: OpeningMechanism.SLIDE_LAYOUT, slideLayout: { tracks: 2, panels: [{ arrow: 'pos' }, { fix: true }] } };
  const entries = [{ mechanism: OpeningMechanism.SLIDE_SINGLE }, singleSliding, { mechanism: OpeningMechanism.HUNG }];
  for (const entry of entries) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const ctx = makeCtx({ entry, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      const base = buildOpeningPlanSymbol(makeOpening({ hingeSide: -1, swingSide: 1 }), ctx);
      const flipped = buildOpeningPlanSymbol(makeOpening({ hingeSide: 1, swingSide: -1 }), ctx);
      assert.deepEqual(base.map(p => JSON.stringify(p)), flipped.map(p => JSON.stringify(p)), `${entry.mechanism}/${lodLevel}`);
    }
  }
});

// ================================================================
// (d) STANDARD/DETAILの実装済み機構はnull（一時契約。SWING_GROUP_MECHANISMS
// （SWING・SWING_IN・PROJECT_V・DREH_KIPP。11b-1で移行済み）・HINGE_GROUP2_MECHANISMS
// （SWING_DOUBLE・SWING_CHILD・FREE・FREE_DOUBLE・FIRE_DOOR・FIRE_FOLD。11b-2で移行済み）・
// SLIDE_DOUBLE・SASH_OPEN_GROUP_MECHANISMS（SLIDE_SINGLE・SLIDE_LAYOUT・HUNG。11cで移行済み）を
// 除く残りの機構が対象。11d以降で機構ごとに置き換える）
// ================================================================

test('暫定契約: STANDARD・実装済み機構(FIXED・未移行。windowLine群。11dで移行予定)はnull', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.FIXED }, lodLevel: LodLevel.STANDARD });
  assert.equal(buildOpeningPlanSymbol(opening, ctx), null);
});

test('暫定契約: SWING_GROUP_MECHANISMSはSTANDARD/DETAILともnullにならない（11b-1で移行済み）', () => {
  const mechanisms = [OpeningMechanism.SWING, OpeningMechanism.SWING_IN, OpeningMechanism.PROJECT_V, OpeningMechanism.DREH_KIPP];
  for (const mechanism of mechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const opening = makeOpening();
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null, `${mechanism}/${lodLevel}`);
    }
  }
});

test('暫定契約: HINGE_GROUP2_MECHANISMSはSTANDARD/DETAILともnullにならない（11b-2で移行済み）', () => {
  const mechanisms = [
    OpeningMechanism.SWING_DOUBLE, OpeningMechanism.SWING_CHILD, OpeningMechanism.FREE,
    OpeningMechanism.FREE_DOUBLE, OpeningMechanism.FIRE_DOOR, OpeningMechanism.FIRE_FOLD,
  ];
  for (const mechanism of mechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const opening = makeOpening();
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null, `${mechanism}/${lodLevel}`);
    }
  }
});

test('暫定契約: DETAIL・実装済み機構(FIXED・未移行)はnull', () => {
  const opening = makeOpening();
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.FIXED }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60,
  });
  assert.equal(buildOpeningPlanSymbol(opening, ctx), null);
});

test('暫定契約: SLIDE_DOUBLEはSTANDARD/DETAILともnullにならない（11cで移行済み）', () => {
  for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
    const opening = makeOpening();
    const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
    assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null, `${lodLevel}`);
  }
});

test('暫定契約: SASH_OPEN_GROUP_MECHANISMS（SLIDE_SINGLE・SLIDE_LAYOUT・HUNG）はSTANDARD/DETAILともnullにならない（11cで移行済み）', () => {
  const mechanisms = [OpeningMechanism.SLIDE_SINGLE, OpeningMechanism.SLIDE_LAYOUT, OpeningMechanism.HUNG];
  for (const mechanism of mechanisms) {
    for (const lodLevel of [LodLevel.STANDARD, LodLevel.DETAIL]) {
      const opening = makeOpening();
      const ctx = makeCtx({ entry: { mechanism }, lodLevel, faceLo: -60, faceHi: 60, axisValue: 0 });
      assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null, `${mechanism}/${lodLevel}`);
    }
  }
});

test('暫定契約: SCHEMATICは実装済み機構(SWING)でもnullにならない（tickを返す）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.SCHEMATIC });
  assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null);
});
