// elevationStairSection.js（折返し階段の断面プロファイル。項目12）のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType } from '@core';
import {
  stairRunProfile, buildSwitchbackSectionPrimitives, resolveSwitchbackParams,
  treadLadderLines, stringerPrimitives, stringerBandGeometry, STEEL_STRINGER_DEPTH_MM,
} from './elevationStairSection.js';
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

// ---- stairRunProfile: n段のジグザグ線（蹴上→踏面の繰り返し） ----
test('stairRunProfile: n段ぶんの蹴上とn-1枚の踏面を繰り返し、終点はstartYからn*riser上がった位置になる', () => {
  const n = 3, riser = 200, runLength = 900; // tread = 900/(3-1) = 450/段
  const { points, endX, endY } = stairRunProfile(n, riser, runLength, 0, 0, 1);

  // 最終段の踏面は次区間（踊り場・上階床）の床が兼ねるため出さない＝1(起点)+n(蹴上)+(n-1)(踏面)。
  assert.equal(points.length, 1 + n + (n - 1), '起点1つ+蹴上n点+踏面(n-1)点のはず');
  assert.equal(endY, -n * riser, `終点yは-n*riser(${-n * riser})のはず（実際:${endY}）`);
  assert.ok(Math.abs(endX - runLength) < 1e-6, `終点xはrunLength(${runLength})のはず（実際:${endX}）`);
});

// ---- ユーザー実機検算2026-08（「6」D）: 「3500左CLの上が1段目踏面、右へ2500いったところが
// 踊り場高さ、かつ11段目」＝ 区間長2500・11段 → 踏面は 2500/(11-1) = 250 ----
test('【実機検算】stairRunProfile: 区間長2500・11段なら踏面250・1段目踏面が起点・11段目で踊り場高さ', () => {
  const n = 11, riser = 200, runLength = 2500;
  const { points, endX, endY } = stairRunProfile(n, riser, runLength, 0, 0, 1);

  // 段鼻（蹴上を上がり切った点）は奇数index。1段目の踏面が起点(x=0)から始まる。
  const nosings = points.filter((_, i) => i % 2 === 1);
  assert.equal(nosings.length, n, `段鼻はn(${n})点のはず（実際:${nosings.length}）`);
  assert.equal(nosings[0][0], 0, '1段目踏面は起点（3500左CL）の上のはず');
  assert.equal(nosings[1][0] - nosings[0][0], 250, '踏面ピッチは250のはず');
  assert.equal(endX, 2500, '11段目（踊り場）は起点から右へ2500のはず');
  assert.equal(endY, -n * riser, '11段目で踊り場高さに達するはず');
});

test('stairRunProfile: dir=-1では水平方向が左に進む', () => {
  const { endX } = stairRunProfile(2, 200, 600, 1000, 0, -1);
  assert.ok(endX < 1000, `dir=-1なら終点xは起点(1000)より小さいはず（実際:${endX}）`);
});

// ---- 失敗系: n<1相当（0や負）はMath.max(1,...)で1段扱いになり例外を投げない ----
test('【失敗系】stairRunProfile: n=0以下でも例外を投げず1段として扱う', () => {
  const { points, endY, endX } = stairRunProfile(0, 200, 600, 0, 0, 1);
  // 1段（＝蹴上1本）だけの退化区間は踏面を持たない（唯一の踏面＝次区間の床が兼ねる）。
  assert.equal(points.length, 2); // 1(起点)+1(蹴上)
  assert.equal(endY, -200);
  assert.equal(endX, 0, '踏面が無いため水平には進まない（退化区間）');
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
  // stairRunProfile(2,200,600,0,0,1) 相当のジグザグ: 踏面ピッチ=600/(2-1)=600なので
  // 段鼻(奇数index)は(0,-200),(600,-400)
  const profile = stairRunProfile(2, 200, 600, 0, 0, 1).points;
  const prims = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM);
  assert.equal(prims.length, 1);
  assert.equal(prims[0].type, 'polyline');
  assert.equal(prims[0].weight, weightForRole(ElevationLineRole.DETAIL));
  assert.equal(prims[0].points[0][0], 0);
  assert.equal(prims[0].points[0][1], -200);
  assert.equal(prims[0].points[1][0], 600);
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

// ---- 実機フィードバック第3弾B: オフセット後多角形をz=baseZ/z=baseZ+steps×riserの水平面でクリップ ----
// stairRunProfile(2,200,600,0,0,1)の段鼻は(0,-200)・(300,-400)（上と同じフィクスチャ）。
// 法線オフセット(depthMm=300)は段鼻を結ぶ線の下方向(y増加側)へ押し出すため、flight自身が
// z=0(y=0)始まりの場合、オフセット後の1つの頂点がy>0（FLより下）へ突き出す。
// zBounds={yLo:-400,yHi:0}（2段×riser200=400の全上りぶん・baseZ=0）でクリップすると、
// y>0の突き出しが消える。
test('【実機フィードバック第3弾B】stringerPrimitives: zBounds指定時はオフセット後の突き出しがFL(yHi)を超えないようクリップされる', () => {
  const profile = stairRunProfile(2, 200, 600, 0, 0, 1).points;
  const unclipped = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM);
  const unclippedMaxY = Math.max(...unclipped[0].points.map(p => p[1]));
  assert.ok(unclippedMaxY > 1e-6, 'zBounds無しの前提: FL(y=0)を超えて突き出すはず');

  const clipped = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM, { yLo: -400, yHi: 0 });
  assert.equal(clipped.length, 1);
  const ys = clipped[0].points.map(p => p[1]);
  assert.ok(Math.max(...ys) <= 1e-6, 'クリップ後はyHi(0)を超えないはず');
  assert.ok(Math.min(...ys) >= -400 - 1e-6, 'クリップ後はyLo(-400)を下回らないはず');
  const first = clipped[0].points[0], last = clipped[0].points[clipped[0].points.length - 1];
  assert.ok(Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9,
    'クリップ後も閉じた多角形（始点===終点）のはず');
});

test('【失敗系・実機フィードバック第3弾B】stringerPrimitives: zBounds未指定は従来どおりクリップしない（挙動不変）', () => {
  const profile = stairRunProfile(2, 200, 600, 0, 0, 1).points;
  const prims = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM);
  assert.equal(prims.length, 1);
  const maxY = Math.max(...prims[0].points.map(p => p[1]));
  assert.ok(maxY > 1e-6, 'zBounds省略時はFL(y=0)を超えて突き出したままのはず（既存挙動）');
});

test('【失敗系・実機フィードバック第3弾B】stringerPrimitives: zBoundsが多角形と全く重ならなければ空配列（例外を投げない）', () => {
  const profile = stairRunProfile(2, 200, 600, 0, 0, 1).points;
  const prims = stringerPrimitives(profile, STEEL_STRINGER_DEPTH_MM, { yLo: 1000, yHi: 2000 });
  assert.deepEqual(prims, []);
});

// ---- ユーザー実機指摘2026-08（「6」D）: 「階段の蹴上、踏面に加え、蹴込を20で描画」 ----
// 蹴込は Stair.nosing（core/stair.js に `nosing = 30, // 蹴込(mm)`）をそのまま使う。
// 蹴上を蹴込ぶん奥へ引っ込め、段鼻の出を1本の水平セグメントとして点列へ挟む。
test('【実機指摘】stairRunProfile: 蹴込>0なら蹴上が斜めの断面になり、最終段（踊り場への上り）も同じ', () => {
  const n = 3, riser = 200, runLength = 500, k = 20; // 踏面 = 500/2 = 250
  const { points, noses, endX, endY } = stairRunProfile(n, riser, runLength, 0, 0, 1, k);

  // 蹴上は斜線1本なので点数は蹴込0のときと同じ＝起点1 + 蹴上n + 踏面(n-1)。
  assert.equal(points.length, 1 + n + (n - 1));
  assert.equal(noses.length, n, '段鼻はn点');
  assert.deepEqual(noses, points.filter((_, i) => i % 2 === 1),
    '蹴上が斜線1本なので段鼻は従来どおり奇数indexに戻る');
  // 起点（上り口の床）は蹴上の足元＝段鼻から蹴込ぶん奥。
  assert.deepEqual(points[0], [k, 0]);
  // 1段目の蹴上は (k,0)→(0,-riser) の斜線（水平にkだけ戻りながら上がる）。
  assert.deepEqual(points[1], [0, -riser]);
  // 踏面は段鼻から次の蹴上の足元まで＝踏面ピッチ+蹴込。
  assert.deepEqual(points[2], [250 + k, -riser]);
  // 最終段（踊り場への上り）も同じく斜め: 足元(250+k,-2*riser) → 段鼻(250? ) の形になる。
  const lastNose = noses[noses.length - 1];
  const beforeLast = points[points.length - 2];
  assert.ok(beforeLast[0] !== lastNose[0] && beforeLast[1] !== lastNose[1],
    '最終段の蹴上も水平・垂直ではなく斜めのはず');
  assert.equal(lastNose[1], -n * riser, '最終段の段鼻は踊り場高さ');
  assert.equal(endX, runLength);
  assert.equal(endY, -n * riser);
});

test('【失敗系・実機指摘】stairRunProfile: 蹴込0（既定）なら点列も段鼻も従来どおり', () => {
  const a = stairRunProfile(4, 200, 900, 0, 0, 1);        // 蹴込省略
  const b = stairRunProfile(4, 200, 900, 0, 0, 1, 0);     // 明示的に0
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.noses, a.points.filter((_, i) => i % 2 === 1),
    '蹴込0なら段鼻は従来どおり奇数indexの点と一致するはず');
});

test('【失敗系・実機指摘】stairRunProfile: 蹴込が踏面を超えても輪郭が自己交差しない（踏面でクランプ）', () => {
  const { noses, points } = stairRunProfile(3, 200, 500, 0, 0, 1, 9999);
  // 蹴込は踏面(250)でクランプされ、蹴上の足元は段鼻から高々踏面ぶんしか奥へ行かない。
  assert.equal(points[0][0] - noses[0][0], 250);
});

// ---- ユーザー実機指摘2026-08: 「鉄骨階段ささらの上端は、踏面先端で巾木同寸」 ----
// 上端線を段鼻の勾配線から巾木高さぶん上へ上げることで、踊り場桁枠side辺の上端
// （landing.z + baseboardHeightMm。sectionStair.jsのlandingFramePrimitives）と踊り場の縁で
// ちょうど一致する＝「直進部の斜めささらと踊り場ささらが取り合う」の上端側が成立する。
test('【実機指摘】stringerPrimitives: 上端線は段鼻から巾木高さぶん上（踊り場桁枠の上端と揃う）', () => {
  const { points, noses } = stairRunProfile(3, 200, 500, 0, 0, 1, 20);
  const baseboardMm = 60;
  const withBb = stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM, undefined, { noses, baseboardMm });
  const without = stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM, undefined, { noses });
  assert.equal(withBb.length, 1);
  // yは上向き負。巾木ぶん上＝yが小さくなる。
  assert.equal(withBb[0].points[0][1], without[0].points[0][1] - baseboardMm);
  assert.equal(withBb[0].points[1][1], without[0].points[1][1] - baseboardMm);
  // 最終段の段鼻の高さ＝踊り場高さ(-3*200)。その上端は「踊り場高さ+巾木」に一致する。
  assert.equal(withBb[0].points[1][1], -(3 * 200) - baseboardMm,
    '上端の終点は「踊り場床＋巾木高さ」＝踊り場桁枠side辺の上端と同じ高さのはず');
});

test('【失敗系・実機指摘】stringerPrimitives: nosesを渡さなければ従来どおり奇数indexで段鼻を拾う', () => {
  const { points } = stairRunProfile(3, 200, 900, 0, 0, 1); // 蹴込なし＝偶奇が成立する形
  const explicitNoses = stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM, undefined,
    { noses: points.filter((_, i) => i % 2 === 1) });
  const heuristic = stringerPrimitives(points, STEEL_STRINGER_DEPTH_MM);
  assert.deepEqual(heuristic, explicitNoses);
});

// ---- ユーザー実機指摘2026-08: 「直進部の斜めささらと踊り場ささら（上下共）はトリム結合して取り合う」 ----
// 上端は段鼻+巾木で踊り場桁枠の上端と元々一致する。下端は「斜め＝法線オフセット」対
// 「桁枠＝鉛直せい」で交差角が付くため、交点でミトレする。
test('【実機指摘】stringerBandGeometry: mitreEndで下端の角が「上端+桁成」の水平線上へ移る', () => {
  const { noses } = stairRunProfile(4, 200, 750, 0, 0, 1, 20); // 踏面250
  const D = 300, bb = 60;
  const plain = stringerBandGeometry(noses, STEEL_STRINGER_DEPTH_MM, { baseboardMm: bb });
  const mitred = stringerBandGeometry(noses, STEEL_STRINGER_DEPTH_MM, {
    baseboardMm: bb, mitreDepthMm: D, mitreEnd: true,
  });
  // 上端は変わらない（＝踊り場桁枠side辺の上端と一致したまま）。
  assert.deepEqual(mitred.top, plain.top);
  // 下端の終点は「上端の終点y + 桁成」ちょうど＝踊り場桁枠の下端の高さ。
  assert.ok(Math.abs(mitred.bottom[1][1] - (mitred.top[1][1] + D)) < 1e-9,
    `ミトレ後の下端終点yは上端終点+桁成(${D})のはず（実際:${mitred.bottom[1][1] - mitred.top[1][1]}）`);
  // 法線オフセットのままではその高さに来ない（＝トリムが実際に効いている）。
  assert.ok(Math.abs(plain.bottom[1][1] - (plain.top[1][1] + D)) > 1,
    '法線オフセットのままでは桁枠の下端高さと一致しない（ミトレが必要な状況であること）');
  // 始端側は触らない。
  assert.deepEqual(mitred.bottom[0], plain.bottom[0]);
});

test('【失敗系・実機指摘】stringerBandGeometry: mitreDepthMm未指定なら従来どおり法線オフセットのまま', () => {
  const { noses } = stairRunProfile(4, 200, 750, 0, 0, 1, 20);
  const a = stringerBandGeometry(noses, STEEL_STRINGER_DEPTH_MM, { baseboardMm: 60 });
  const b = stringerBandGeometry(noses, STEEL_STRINGER_DEPTH_MM, { baseboardMm: 60, mitreEnd: true });
  assert.deepEqual(a, b, 'mitreDepthMmが無ければmitreEndだけでは何も起きない');
});

test('【失敗系・実機指摘】stringerBandGeometry: 段鼻が1点以下ならnull（描画側は空配列）', () => {
  assert.equal(stringerBandGeometry([[0, 0]], 300, {}), null);
  assert.equal(stringerBandGeometry(null, 300, {}), null);
});
