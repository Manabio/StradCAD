// wallStudLayout.js（平面詳細LODの壁下地材の並べ方。固定ピッチ／在来木造の柱間面割付）の単体テスト。
// 本番経路（buildWallDrawPlan が正しい引数を渡すか）は wallDrawPlan.test.js が実グラフで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  studSegments, fixedPitchStudCenters, betweenColumnsStudCenters, resolveWallStuds, columnIntervalsOnWall,
  studRects, WALL_BACKING_PITCH, WALL_STUD_WIDTH,
} from './wallStudLayout.js';
import { TRADITIONAL_WOOD_BACKING } from '../structural/structureRules.js';

test('studSegments: 物理端に接する区間だけ下地の端（backingSpan）へ置き換え、開口の縁は残し、柱壁の区間を落とす', () => {
  const plan = { segments: [[72.5, 2803], [3553, 7207.5]], spanLo: 72.5, spanHi: 7207.5, backingSpan: [60, 7220] };
  assert.deepEqual(studSegments(plan), [[60, 2803], [3553, 7220]]);
  assert.deepEqual(studSegments(plan, [[1000, 1500]]), [[60, 1000], [1500, 2803], [3553, 7220]]);
  // 置き換えで幅が無くなる区間は出さない
  assert.deepEqual(studSegments({ segments: [[0, 10]], spanLo: 0, spanHi: 10, backingSpan: [12, 20] }), [[12, 20]]);
  assert.deepEqual(studSegments({ segments: [[0, 10]], spanLo: 0, spanHi: 10, backingSpan: [5, 5] }), []);
});

test('fixedPitchStudCenters: 壁の始端を基準に450ピッチ、見かけ幅45が区間に収まる位置だけ（従来の ShapesLayer と同じ）', () => {
  assert.equal(WALL_BACKING_PITCH, 450);
  assert.equal(WALL_STUD_WIDTH, 45);
  // spanLo=60: 60,510,960,… のうち [60,1000] に材（±22.5）が収まる位置 → 60 は左にはみ出すので 510, 960 は 982.5 ≤ 1000 で可
  assert.deepEqual(fixedPitchStudCenters([[60, 1000]], 60), [510, 960]);
  // 開口で分かれた区間もピッチの位相は壁の始端基準のまま
  assert.deepEqual(fixedPitchStudCenters([[60, 1000], [1200, 2000]], 60), [510, 960, 1410, 1860]);
  assert.deepEqual(fixedPitchStudCenters([], 0), []);
});

test('betweenColumnsStudCenters: 区間ごとに柱で面に分け、面の始端＋faceStudPositions（柱面から10mmの端部材＋455割付）', () => {
  const spec = { pitchMm: 455, depthMm: 30, clearanceMm: 10 };
  // 柱 x=0/1820/3640（120角）の壁 [60,3700]: 面 [60,1760]・[1880,3580]（各1700）
  assert.deepEqual(
    betweenColumnsStudCenters([[60, 3700]], [[-60, 60], [1760, 1880], [3580, 3700]], spec),
    [85, 455, 910, 1365, 1735, 1905, 2275, 2730, 3185, 3555]);
  // 開口で分かれた区間（開口の縁は柱ではない）: [2790,2803] は材が入らず 0 本
  assert.deepEqual(
    betweenColumnsStudCenters([[60, 2803], [3553, 3700]], [[-60, 60], [1760, 1880], [2670, 2790], [3580, 3700]], spec),
    [85, 455, 910, 1365, 1735, 1905, 2275, 2645]);
  assert.deepEqual(betweenColumnsStudCenters([], [], spec), []);
});

test('resolveWallStuds: 選択子 betweenColumns＋ルール値で面割付（材厚30）、それ以外は固定ピッチ（見かけ幅45）', () => {
  const plan = { segments: [[60, 3700]], spanLo: 60, spanHi: 3700, backingSpan: [60, 3700] };
  const cols = [[-60, 60], [1760, 1880], [3580, 3700]];
  assert.deepEqual(resolveWallStuds(plan, { layout: 'betweenColumns', backing: TRADITIONAL_WOOD_BACKING, columnIntervals: cols }),
    { centers: [85, 455, 910, 1365, 1735, 1905, 2275, 2730, 3185, 3555], depth: 30, endMembers: [] });
  assert.deepEqual(resolveWallStuds(plan, { layout: 'fixedPitch', columnIntervals: cols }),
    { centers: [510, 960, 1410, 1860, 2310, 2760, 3210, 3660], depth: 45, endMembers: [] });
  // 柱壁に取られた区間は両方式で落ちる
  assert.deepEqual(resolveWallStuds(plan, { layout: 'fixedPitch', studCuts: [[400, 2000]] }).centers, [2310, 2760, 3210, 3660]);
});

test('【失敗系】resolveWallStuds: 下地の端が無い・区間が無い壁は null、betweenColumns でもルール値が無ければ固定ピッチへ', () => {
  assert.equal(resolveWallStuds({ segments: [[0, 100]], spanLo: 0, spanHi: 100, backingSpan: null }, { layout: 'betweenColumns' }), null);
  assert.equal(resolveWallStuds(null, { layout: 'fixedPitch' }), null);
  assert.equal(resolveWallStuds({ segments: [], spanLo: 0, spanHi: 100, backingSpan: [0, 100] }, { layout: 'fixedPitch' }), null);
  const plan = { segments: [[0, 1000]], spanLo: 0, spanHi: 1000, backingSpan: [0, 1000] };
  assert.deepEqual(resolveWallStuds(plan, { layout: 'betweenColumns', backing: null }), { centers: [450, 900], depth: 45, endMembers: [] });
});

test('resolveWallStuds: endMembers（腰壁・垂れ壁の端部材）はそのまま center/depth へ写る。呼び出し側が columnIntervals へも合流させれば柱区間と同様に面を分け、柱面から10mm空けた間柱が立つ', () => {
  const plan = { segments: [[60, 3700]], spanLo: 60, spanHi: 3700, backingSpan: [60, 3700] };
  const endMembers = [{ along: 3640, widthMm: 120 }]; // 柱寸120の端部材が壁の右端寄りに1本（区間[3580,3700]）
  // wallDrawPlan.js と同じ配線: columnIntervals へ端部材区間 [along-widthMm/2, along+widthMm/2] を合流させる。
  const withEndMember = resolveWallStuds(plan, {
    layout: 'betweenColumns', backing: TRADITIONAL_WOOD_BACKING,
    columnIntervals: [[-60, 60], [3580, 3700]], endMembers,
  });
  // endMembersはalong/widthMmの値をそのままcenter/depthへ写すだけ（columnIntervalsの合流有無に関わらない）
  assert.deepEqual(withEndMember.endMembers, [{ center: 3640, depth: 120 }]);
  // 端部材の区間[3580,3700]が柱区間として面[60,3580]を作り、柱面(3580)から10mm空けた端部材(center 3555)が
  // 立つ——端部材の区間を合流させない場合（自由端のまま455等分割付）と比較して差を確認する。
  assert.deepEqual(withEndMember.centers, [85, 455, 910, 1365, 1820, 2275, 2730, 3185, 3555]);
  const withoutEndMemberInterval = resolveWallStuds(plan, {
    layout: 'betweenColumns', backing: TRADITIONAL_WOOD_BACKING, columnIntervals: [[-60, 60]], endMembers,
  });
  assert.deepEqual(withoutEndMemberInterval.centers, [85, 287.5, 742.5, 1197.5, 1652.5, 2107.5, 2562.5, 3017.5, 3472.5]);
  // endMembersの写し自体はcolumnIntervalsの合流有無と無関係（呼び出し側の責務が分離されていることの確認）
  assert.deepEqual(withoutEndMemberInterval.endMembers, [{ center: 3640, depth: 120 }]);
});

test('resolveWallStuds: layout!==\'betweenColumns\' は endMembers を渡しても常に空、backingSpan:null（天板輪郭）の壁は endMembers も出ない', () => {
  const plan = { segments: [[60, 3700]], spanLo: 60, spanHi: 3700, backingSpan: [60, 3700] };
  const fixed = resolveWallStuds(plan, { layout: 'fixedPitch', endMembers: [{ along: 3640, widthMm: 120 }] });
  assert.deepEqual(fixed.endMembers, []);
  const capOutline = resolveWallStuds({ ...plan, backingSpan: null }, {
    layout: 'betweenColumns', backing: TRADITIONAL_WOOD_BACKING, endMembers: [{ along: 3640, widthMm: 120 }],
  });
  assert.equal(capOutline, null);
});

test('columnIntervalsOnWall: 厚み方向が下地帯と重なる柱だけを、壁の長さ方向の区間で返す', () => {
  const rects = [
    { xLo: -60, xHi: 60, yLo: -60, yHi: 60 },          // 壁上
    { xLo: 1760, xHi: 1880, yLo: -60, yHi: 60 },       // 壁上
    { xLo: 900, xHi: 1020, yLo: 500, yHi: 620 },       // 厚み方向が外れる
    { xLo: 3580, xHi: 3700, yLo: 60, yHi: 180 },       // 帯の縁に接するだけ（重なり0）は外す
  ];
  const hWall = { isVertical: false, backingRange: { lo: -60, hi: 60 } };
  assert.deepEqual(columnIntervalsOnWall(hWall, rects), [[-60, 60], [1760, 1880]]);
  const vWall = { isVertical: true, backingRange: { lo: -60, hi: 60 } };
  assert.deepEqual(columnIntervalsOnWall(vWall, rects), [[-60, 60]]);
  assert.deepEqual(columnIntervalsOnWall({ isVertical: false, backingRange: null }, rects), []);
});

// ---- studRects: 間柱・端部材の描画矩形（世界mm座標）。renderer/ShapesLayer.jsx と
// scripts/probe/planSegments.mjs が共有する唯一の幾何供給源（QA指摘2026-09-19）。
test('studRects: 横壁は厚み方向がy、長さ方向がx——間柱はstuds.depth幅、端部材は各要素のdepth（柱寸）幅', () => {
  const backingRange = { lo: -60, hi: 60 }; // 厚み120・中心0
  const studs = { centers: [500], depth: 30, endMembers: [{ center: 1000, depth: 120 }] };
  assert.deepEqual(studRects(false, backingRange, studs), [
    { kind: 'stud', key: 'stud:500', x: 485, y: -60, width: 30, height: 120 },
    { kind: 'endMember', key: 'endMember:1000', x: 940, y: -60, width: 120, height: 120 },
  ]);
});

test('studRects: 縦壁は厚み方向がx、長さ方向がy（横壁とx/y・幅/高さが入れ替わるだけで値は同じ）', () => {
  const backingRange = { lo: -60, hi: 60 };
  const studs = { centers: [500], depth: 30, endMembers: [{ center: 1000, depth: 120 }] };
  assert.deepEqual(studRects(true, backingRange, studs), [
    { kind: 'stud', key: 'stud:500', x: -60, y: 485, width: 120, height: 30 },
    { kind: 'endMember', key: 'endMember:1000', x: -60, y: 940, width: 120, height: 120 },
  ]);
});

test('【失敗系】studRects: centers・endMembersが空なら空配列（間柱の無い壁・端部材の無い壁）', () => {
  assert.deepEqual(studRects(false, { lo: -60, hi: 60 }, { centers: [], depth: 30, endMembers: [] }), []);
});
