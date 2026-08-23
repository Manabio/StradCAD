// elevationStairSection.js（折返し階段の断面プロファイル。項目12）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import {
  stairRunProfile, buildSwitchbackSectionPrimitives, resolveSwitchbackParams,
  treadLadderLines, stringerPrimitives, STEEL_STRINGER_DEPTH_MM,
} from './elevationStairSection.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

// ---- stairRunProfile: n段のジグザグ線（蹴上→踏面の繰り返し） ----
test('stairRunProfile: n段ぶんの蹴上・踏面を繰り返し、終点はstartYからn*riser上がった位置になる', () => {
  const n = 3, riser = 200, runLength = 900; // tread = 300/段
  const { points, endX, endY } = stairRunProfile(n, riser, runLength, 0, 0, 1);

  assert.equal(points.length, 1 + 2 * n, '起点1つ+段数ぶんの(蹴上,踏面)2点＝1+2n点のはず');
  assert.equal(endY, -n * riser, `終点yは-n*riser(${-n * riser})のはず（実際:${endY}）`);
  assert.ok(Math.abs(endX - runLength) < 1e-6, `終点xはrunLength(${runLength})のはず（実際:${endX}）`);
});

test('stairRunProfile: dir=-1では水平方向が左に進む', () => {
  const { endX } = stairRunProfile(2, 200, 600, 1000, 0, -1);
  assert.ok(endX < 1000, `dir=-1なら終点xは起点(1000)より小さいはず（実際:${endX}）`);
});

// ---- 失敗系: n<1相当（0や負）はMath.max(1,...)で1段扱いになり例外を投げない ----
test('【失敗系】stairRunProfile: n=0以下でも例外を投げず1段として扱う', () => {
  const { points, endY } = stairRunProfile(0, 200, 600, 0, 0, 1);
  assert.equal(points.length, 3); // 1(起点)+2(1段)
  assert.equal(endY, -200);
});

function baseCtx(overrides = {}) {
  return {
    type: StairType.SWITCHBACK, totalSteps: 14, tread: 250, riser: null, sections: null,
    cells: new Set(), // 空 → measureStairSpansはnull（合成フォールバック経路）
    ...overrides,
  };
}
function makeGraph() { return {}; } // measureStairSpansはcells.size===0で即nullを返すため未使用

// ---- 折返し階段: sections指定時はその段数どおりに往路・復路のriserを積む ----
test('buildSwitchbackSectionPrimitives: sections=[n1,landing,n2]の往路n1・復路n2ぶんriserを積む', () => {
  const stair = baseCtx({ sections: [6, 1, 6], totalSteps: 12, riser: 200 });
  const floorHeight = 2400; // 12段×200
  const prims = buildSwitchbackSectionPrimitives(stair, makeGraph(), floorHeight);

  const polylines = prims.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 2, '往路・復路の2本のジグザグ線が出るはず');
  const run1EndY = polylines[0].points[polylines[0].points.length - 1][1];
  assert.equal(run1EndY, -6 * 200, '往路の終点yは-n1*riserのはず');
  const run2EndY = polylines[1].points[polylines[1].points.length - 1][1];
  assert.equal(run2EndY, -12 * 200, '復路の終点yは-(n1+n2)*riser（=floorHeight）のはず');
  assert.ok(Math.abs(run2EndY - (-floorHeight)) < 1e-6, '往路+復路の合計riserがfloorHeightに一致するはず');
});

// ---- 踊り場の床線（区間を画す面）はCUT、段のジグザグはSILHOUETTE ----
test('buildSwitchbackSectionPrimitives: 踊り場の床線はCUT、段のジグザグはSILHOUETTE', () => {
  const stair = baseCtx({ sections: [4, 1, 4], totalSteps: 8, riser: 200 });
  const prims = buildSwitchbackSectionPrimitives(stair, makeGraph(), 1600);

  const cutWeight = weightForRole(ElevationLineRole.CUT);
  const silhouetteWeight = weightForRole(ElevationLineRole.SILHOUETTE);
  const landingLine = prims.find(p => p.type === 'line');
  assert.ok(landingLine, '踊り場の床線(line)が出るはず');
  assert.equal(landingLine.weight, cutWeight);
  for (const p of prims.filter(x => x.type === 'polyline')) {
    assert.equal(p.weight, silhouetteWeight, '段のジグザグはSILHOUETTEのはず');
  }
});

// ---- sections未指定時は totalSteps を均等2分する（対称な折返しという仮定） ----
test('buildSwitchbackSectionPrimitives: sections未指定はtotalStepsを均等2分して往復に割り振る', () => {
  const stair = baseCtx({ sections: null, totalSteps: 12, riser: 200 });
  const prims = buildSwitchbackSectionPrimitives(stair, makeGraph(), 2400);
  const polylines = prims.filter(p => p.type === 'polyline');
  const run1EndY = polylines[0].points[polylines[0].points.length - 1][1];
  const run2EndY = polylines[1].points[polylines[1].points.length - 1][1];
  assert.equal(run1EndY, -6 * 200, 'sections未指定はtotalSteps(12)を6/6に均等2分するはず');
  assert.equal(run2EndY, -12 * 200);
});

// ---- 失敗系: SWITCHBACK以外のタイプは空配列（対応スコープ外） ----
test('【失敗系】buildSwitchbackSectionPrimitives: SWITCHBACK以外のタイプは空配列を返す', () => {
  const stair = baseCtx({ type: StairType.STRAIGHT });
  assert.deepEqual(buildSwitchbackSectionPrimitives(stair, makeGraph(), 2400), []);
});

// ---- 失敗系: floorHeightがnull（上階未確定）なら空配列 ----
test('【失敗系】buildSwitchbackSectionPrimitives: floorHeightがnullなら空配列', () => {
  const stair = baseCtx();
  assert.deepEqual(buildSwitchbackSectionPrimitives(stair, makeGraph(), null), []);
});

// ---- 失敗系: stairが無い(null)なら空配列 ----
test('【失敗系】buildSwitchbackSectionPrimitives: stairがnullなら空配列', () => {
  assert.deepEqual(buildSwitchbackSectionPrimitives(null, makeGraph(), 2400), []);
});

// ---- QA F2: stair.riser未指定時のriser正規フォールバック（floorHeight/totalSteps。
// stair-model.md:19の正典式）が実際に使われる ----
test('【QA F2】buildSwitchbackSectionPrimitives: stair.riser未指定はriser=floorHeight/totalStepsで各段を積む', () => {
  const stair = baseCtx({ sections: [6, 1, 6], totalSteps: 12, riser: null });
  const floorHeight = 2800;
  const expectedRiser = floorHeight / 12; // 233.333...
  const prims = buildSwitchbackSectionPrimitives(stair, makeGraph(), floorHeight);

  const polylines = prims.filter(p => p.type === 'polyline');
  assert.equal(polylines.length, 2);
  const run2Points = polylines[1].points;
  const run2EndY = run2Points[run2Points.length - 1][1];
  assert.ok(Math.abs(run2EndY - (-floorHeight)) < 1e-9,
    `復路の終点yは-floorHeight(${-floorHeight})に一致するはず（実際:${run2EndY}）`);

  // 各段の蹴上(y方向の変化量)がfloorHeight/totalSteps(=233.33...)ちょうどであることを、
  // 往路・復路それぞれの点列(蹴上→踏面を繰り返す)の垂直区間から確認する。
  for (const pl of polylines) {
    for (let i = 0; i + 1 < pl.points.length; i += 2) {
      const [, y1] = pl.points[i];
      const [, y2] = pl.points[i + 1];
      assert.ok(Math.abs((y1 - y2) - expectedRiser) < 1e-9,
        `各段の蹴上はfloorHeight/totalSteps(${expectedRiser})ちょうどのはず（実際:${y1 - y2}）`);
    }
  }
});

// ---- WP-S1: resolveSwitchbackParams（buildSwitchbackSectionPrimitivesの計算を抽出した単一ソース） ----
test('resolveSwitchbackParams: sections指定時はn1/n2/riserをそのまま返す', () => {
  const stair = baseCtx({ sections: [6, 1, 6], totalSteps: 12, riser: 200 });
  const params = resolveSwitchbackParams(stair, makeGraph(), 2400);
  assert.equal(params.n1, 6);
  assert.equal(params.n2, 6);
  assert.equal(params.riser, 200);
  assert.equal(params.totalSteps, 12);
});

// ---- 失敗系: resolveSwitchbackParamsもbuildSwitchbackSectionPrimitivesと同じ条件でnull ----
test('【失敗系】resolveSwitchbackParams: SWITCHBACK以外・floorHeight未確定・stair未指定はnull', () => {
  assert.equal(resolveSwitchbackParams(baseCtx({ type: StairType.STRAIGHT }), makeGraph(), 2400), null);
  assert.equal(resolveSwitchbackParams(baseCtx(), makeGraph(), null), null);
  assert.equal(resolveSwitchbackParams(null, makeGraph(), 2400), null);
});

// ---- WP-S1: treadLadderLines（見返り展開の梯子状踏面線） ----
test('treadLadderLines: steps段ぶんの水平細線をriser刻みで返す', () => {
  const lines = treadLadderLines({ loX: 0, hiX: 1000, riserMm: 200, steps: 3, baseAbsMm: 0, dashed: false });
  assert.equal(lines.length, 3, 'steps=3段ぶん出るはず');
  assert.equal(lines[0].weight, weightForRole(ElevationLineRole.DETAIL), '細線(DETAIL)のはず');
  assert.deepEqual(lines.map(l => l.y1), [-200, -400, -600], 'yはriser刻みのはず');
  for (const l of lines) {
    assert.equal(l.x1, 0); assert.equal(l.x2, 1000);
    assert.equal(l.y1, l.y2, '水平線のはず');
    assert.equal(l.dash, undefined, 'dashed=falseはdash未指定のはず');
  }
});

test('treadLadderLines: baseAbsMmぶん基準高さがずれる', () => {
  const lines = treadLadderLines({ loX: 0, hiX: 500, riserMm: 200, steps: 2, baseAbsMm: 1000, dashed: false });
  assert.deepEqual(lines.map(l => l.y1), [-1200, -1400]);
});

test('treadLadderLines: dashed=trueはline型でdash:"dashed"を持つ（polylineはdash非対応のため）', () => {
  const lines = treadLadderLines({ loX: 0, hiX: 500, riserMm: 200, steps: 1, baseAbsMm: 0, dashed: true });
  assert.equal(lines[0].type, 'line');
  assert.equal(lines[0].dash, 'dashed');
});

// ---- 失敗系: steps=0は空配列（例外を投げない） ----
test('【失敗系】treadLadderLines: steps=0は空配列', () => {
  assert.deepEqual(treadLadderLines({ loX: 0, hiX: 500, riserMm: 200, steps: 0, baseAbsMm: 0 }), []);
});

// ---- WP-S1: stringerPrimitives（鉄骨ささら。段鼻を結ぶ直線を法線方向へdepthMmオフセット） ----
// 期待値更新（ユーザー指示「ささらの見えかがりは細線、断面は太線」対応。出典:
// http://kentiku-kouzou.jp/struc-sasara.html「段部はササラの横につく（横付け）のが一般的」）:
// このpolylineは側面視（レーンを縦断する切断）の見えがかり輪郭であり、太線(CUT)ではなく
// 細線(DETAIL)が正しい——太線は正面視の断面（sectionStair.jsのflightStringerFrontPrimitives）
// 側に割り当てた。旧テストはCUTを期待していたが意味論を保ったまま更新する。
test('stringerPrimitives: 段鼻点列（奇数index）を結ぶ直線からdepthMmオフセットした閉じたpolyline(DETAIL・見えがかりの細線)を返す', () => {
  // stairRunProfile(2,200,600,0,0,1) 相当のジグザグ: 段鼻(奇数index)は(0,-200),(300,-400)
  const profile = stairRunProfile(2, 200, 600, 0, 0, 1).points;
  const prims = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM);
  assert.equal(prims.length, 1);
  assert.equal(prims[0].type, 'polyline');
  assert.equal(prims[0].weight, weightForRole(ElevationLineRole.DETAIL));
  assert.equal(prims[0].points[0][0], 0);
  assert.equal(prims[0].points[0][1], -200);
  assert.equal(prims[0].points[1][0], 300);
  assert.equal(prims[0].points[1][1], -400);
  // オフセット辺（法線方向にdepthMmぶん）: 段鼻を結ぶ直線からの垂直距離がdepthMmになるはず
  const [x1, y1] = prims[0].points[0];
  const [x2, y2] = prims[0].points[3]; // 1本目のオフセット側の点
  const dist = Math.hypot(x2 - x1, y2 - y1);
  assert.ok(Math.abs(dist - STEEL_STRINGER_DEPTH_MM) < 1e-9, `オフセット距離はdepthMm(${STEEL_STRINGER_DEPTH_MM})のはず（実際:${dist}）`);
});

// ---- 失敗系: 段鼻点が1点以下（区間が短すぎる）なら空配列 ----
test('【失敗系】stringerPrimitives: 段鼻点が2点未満なら空配列', () => {
  assert.deepEqual(stringerPrimitives([[0, 0]], 200), []);
  assert.deepEqual(stringerPrimitives([], 200), []);
});
