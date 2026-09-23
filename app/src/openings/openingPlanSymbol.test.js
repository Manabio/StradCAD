// openingPlanSymbol.js（建具モード 平面記号の純関数化）の回帰テスト。
// ステップ11a（器＋線幅役割＋SCHEMATIC）＋11b-1（蝶番系その1: SWING・SWING_IN・PROJECT_V・DREH_KIPP）。
//
// 【ピン留め】(a) は probe（scripts/probe/openingPlanSymbolProbe.mjs）で実データ3文書×
// （通常＋sweep）の6本が旧 renderer/OpeningsLayer.jsx の出力と完全一致することを確認した後の
// buildOpeningPlanSymbol自身の出力を primitives.map(p => JSON.stringify(p)) で固定したもの
// （memberFigures.test.js と同じ形。意図的な出力変更なら期待値を採り直すこと）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpeningPlanSymbol, planSymbolWeightMm } from './openingPlanSymbol.js';
import { LodLevel } from '../viewport.js';
import { OpeningMechanism } from './openingCatalog.js';
import { LINE_WEIGHT_MM } from '../core.js';

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

// SWING（本ステップ11b-1で移行済み）ではなく、まだ未移行のSLIDE_DOUBLEで暫定契約を確認する
// （SWING_GROUP_MECHANISMS以外は引き続きnull＋band計算ゼロ＝exteriorDirOf未呼び出し）。
test('失敗系: DETAIL・実装済み機構(SLIDE_DOUBLE・未移行)・frameDepth=50はnullを返し、exteriorDirOfも呼ばない（暫定契約の副作用ゼロ）', () => {
  const opening = makeOpening({ frameDepth: 50 });
  let calls = 0;
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60, axisValue: 0,
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

// ================================================================
// (d) STANDARD/DETAILの実装済み機構はnull（一時契約。SWING_GROUP_MECHANISMS
// （SWING・SWING_IN・PROJECT_V・DREH_KIPP。11b-1で移行済み）を除く残りの機構が対象。
// 11c以降で機構ごとに置き換える）
// ================================================================

test('暫定契約: STANDARD・実装済み機構(SLIDE_SINGLE・未移行)はnull', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SLIDE_SINGLE }, lodLevel: LodLevel.STANDARD });
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

test('暫定契約: DETAIL・実装済み機構(SLIDE_DOUBLE)はnull', () => {
  const opening = makeOpening();
  const ctx = makeCtx({
    entry: { mechanism: OpeningMechanism.SLIDE_DOUBLE }, lodLevel: LodLevel.DETAIL, faceLo: -60, faceHi: 60,
  });
  assert.equal(buildOpeningPlanSymbol(opening, ctx), null);
});

test('暫定契約: SCHEMATICは実装済み機構(SWING)でもnullにならない（tickを返す）', () => {
  const opening = makeOpening();
  const ctx = makeCtx({ entry: { mechanism: OpeningMechanism.SWING }, lodLevel: LodLevel.SCHEMATIC });
  assert.notEqual(buildOpeningPlanSymbol(opening, ctx), null);
});
