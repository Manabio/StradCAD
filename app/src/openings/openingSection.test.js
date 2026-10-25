// openingSection.js（建具ごとの断面の描き方）の単体テスト。
// 寸法の根拠はユーザー明示指示2026-09「木製片開き戸の断面は、指定高さに枠と扉断面（厚30、
// 下はFL10、枠戸当たりまでの四角（中線））」「枠の見付けは30、戸当たりは10だったので、
// 指定高さ−20が扉上端」「上枠は、竪枠と同じ断面」「平面に指定があるので参照のこと」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import {
  openingSectionPrimitives, openingSectionWidthMm, openingOpenPerpDir,
  isFrameOnlySection, openingSectionOverhangMm, openingSectionWallRange,
} from './openingSection.js';
import {
  FRAME_JAMB_WIDTH_MM, FRAME_KAKARI_WIDTH_MM, DOOR_LEAF_THICKNESS_MM, FRAME_OVERHANG_MM,
} from './openingPlanSymbolGeometry.js';

const CUT = 'thick', SIL = 'medium';
const swingDoor = (over = {}) => ({
  id: 'o1', category: OpeningCategory.FITTING, subType: 'singleSwing',
  width: 800, height: 2000, sillHeight: null, ...over,
});

test('openingSection: 寸法は平面記号の定数をそのまま使う（二重管理を作らない）', () => {
  assert.equal(FRAME_JAMB_WIDTH_MM, 30, '枠の見付は平面の方立全幅と同じ30');
  assert.equal(FRAME_KAKARI_WIDTH_MM, 10, '戸当たりは平面のかかり代と同じ10');
  assert.equal(DOOR_LEAF_THICKNESS_MM, 30, '扉厚は平面の扉厚と同じ30');
  assert.equal(FRAME_OVERHANG_MM, 12, '枠は壁面から室内外へ12ずつ出る');
  assert.equal(openingSectionWidthMm(swingDoor(), { wallThicknessMm: 115 }), 139,
    '枠の見込は壁の層厚+24（12ずつ室内外へ）');
});

test('openingSection: 片開き戸は上枠＋扉＋扉のない側の枠の縦線（縦断面なので竪枠は掛からない）', () => {
  const prims = openingSectionPrimitives(swingDoor(), 0, 1, CUT, SIL,
    { wallThicknessMm: 115, openPerpDir: 1, worldPerDirSign: 1 });
  assert.equal(prims.length, 3, '上枠1・扉1・枠の縦線1の3本のはず');
  const edge = prims.find(p => p.type === 'line');
  assert.deepEqual([edge.x1, edge.x2], [0, 0],
    '枠の縦線は扉のない側（この構成では手前=0）に立つはず');
  assert.equal(edge.weight, SIL, 'detailWeight未指定なら中線へフォールバック（後方互換）');
  const withDetail = openingSectionPrimitives(swingDoor(), 0, 1, CUT, SIL,
    { wallThicknessMm: 115, openPerpDir: 1, worldPerDirSign: 1, detailWeight: 'thin' })
    .find(p => p.type === 'line');
  assert.equal(withDetail.weight, 'thin', '枠の見えがかりは細線（detailWeight指定時）');
  assert.equal(edge.y1, -1970, '上端は上枠の下端');
  assert.equal(edge.y2, 0, '下端は床（開口の下端）');

  const head = prims.find(p => p.weight === CUT);
  assert.deepEqual([head.x, head.w, head.y, head.h], [0, 139, -2000, 30],
    '上枠は竪枠と同じ見付30・見込は壁厚+24の全幅・指定高さの直下');
  const leaf = prims.find(p => p.weight === SIL);
  assert.equal(leaf.w, 30, '扉は厚30');
  assert.equal(leaf.y, -1980, '扉の上端は指定高さ-20（＝見付30-戸当たり10）');
  assert.equal(leaf.y + leaf.h, -10, '扉の下端はFL+10');
  assert.deepEqual([leaf.x, leaf.x + leaf.w], [139 - 12 - 30, 139 - 12],
    '扉は開く側の壁面（帯の端から12内側）に寄り、壁の中へ厚30ぶん');
});

test('openingSection: 扉が寄る側は開き勝手（openPerpDir）と帯の向きの組み合わせで決まる', () => {
  const leafX = (openPerpDir, worldPerDirSign) => openingSectionPrimitives(
    swingDoor(), 0, 1, CUT, SIL, { wallThicknessMm: 115, openPerpDir, worldPerDirSign },
  ).find(p => p.weight === SIL).x;
  assert.equal(leafX(1, 1), 97, '開く側が世界座標の大きい側＝帯の奥');
  assert.equal(leafX(-1, 1), 12, '開き勝手を反転すると手前の壁面へ');
  assert.equal(leafX(1, -1), 12, '帯の向きが世界と逆なら同じ開き勝手でも手前へ');
  assert.equal(leafX(-1, -1), 97, '両方反転すれば元へ戻る');
});

test('openingSection: openPerpDirを省略すると建具自身の開き勝手から決まる', () => {
  const door = swingDoor({ isVertical: true, hingeSide: -1, swingSide: 1 });
  assert.notEqual(openingOpenPerpDir(door), 0, '前提: 片開き戸は開き勝手を持つ');
  const withAuto = openingSectionPrimitives(door, 0, 1, CUT, SIL, { wallThicknessMm: 115, worldPerDirSign: 1 });
  const withExplicit = openingSectionPrimitives(door, 0, 1, CUT, SIL,
    { wallThicknessMm: 115, worldPerDirSign: 1, openPerpDir: openingOpenPerpDir(door) });
  assert.deepEqual(withAuto, withExplicit, '省略時は建具の開き勝手を引くはず');
});

test('openingSection: dir=-1（面の右端から左へ伸ばす）でも帯は面の内側へ139ぶん', () => {
  const prims = openingSectionPrimitives(swingDoor(), 4000, -1, CUT, SIL,
    { wallThicknessMm: 115, openPerpDir: 1, worldPerDirSign: -1 });
  const rects = prims.filter(p => p.type === 'rect');
  assert.ok(rects.every(p => p.x >= 4000 - 139 && p.x + p.w <= 4000), '帯は面の内側へ139ぶん');
  const edge = prims.find(p => p.type === 'line');
  assert.ok(edge.x1 >= 4000 - 139 && edge.x1 <= 4000, '枠の縦線も帯の中');
});

test('【失敗系】openingSection: 描き方の指定が無い建具は従来の[枠40][扉40][枠40]のまま', () => {
  const prims = openingSectionPrimitives(swingDoor({ subType: 'slidingDouble' }), 0, 1, CUT, SIL);
  assert.equal(prims.length, 3, '従来どおり3rect');
  assert.equal(openingSectionWidthMm(swingDoor({ subType: 'slidingDouble' })), 120, '帯幅は120のまま');
  assert.ok(prims.every(p => p.h === 2000), '3本とも開口の全高（扉のFL逃げ・戸当たりは無し）');
});

test('openingSection: 窓（腰高あり）の片開き戸相当でも、扉の下端は開口の下端+10になる', () => {
  const win = swingDoor({ category: OpeningCategory.WINDOW, sillHeight: 800, height: 1000 });
  const leaf = openingSectionPrimitives(win, 0, 1, CUT, SIL, { wallThicknessMm: 115 })
    .find(p => p.weight === SIL);
  assert.equal(leaf.y + leaf.h, -810, '下端は開口の下端(腰高800)の+10＝z810');
  assert.equal(leaf.y, -1780, '上端は開口上端1800の-20');
});

test('openingSection: 片開き戸の縦線もプリミティブ生成ヘルパー経由（キー順 type,x1,y1,x2,y2,weight）', () => {
  const edge = openingSectionPrimitives(swingDoor(), 0, 1, CUT, SIL, { wallThicknessMm: 115 })
    .find(p => p.type === 'line');
  assert.deepEqual(Object.keys(edge), ['type', 'x1', 'y1', 'x2', 'y2', 'weight']);
});

// ---- 三方枠（機構 FRAME_ONLY。WF=solid／SF・SSF=bent）----
const frameOnly = (over = {}) => ({
  id: 'f1', category: OpeningCategory.FITTING, subType: 'threeSidedFrame', fixtureType: 'WF',
  width: 800, height: 2000, sillHeight: null, frameFaceWidth: null, frameProjection: null, ...over,
});

test('openingSection: 三方枠（木製WF）は上枠だけ（見付20・見込は壁厚+24）＋竪枠の見えがかり縦線2本。扉の矩形は無い', () => {
  assert.equal(isFrameOnlySection(frameOnly()), true);
  const prims = openingSectionPrimitives(frameOnly(), 0, 1, CUT, SIL, { wallThicknessMm: 115, detailWeight: 'thin' });
  assert.equal(prims.length, 3, '上枠1・竪枠の縦線2');
  const rects = prims.filter(p => p.type === 'rect');
  assert.equal(rects.length, 1, '扉・下枠の矩形は描かない（上枠の1枚だけ）');
  assert.deepEqual([rects[0].x, rects[0].w, rects[0].y, rects[0].h], [0, 139, -2000, 20],
    '上枠は見込=壁厚115+2×出幅12・見付20・上端は指定高さ');
  assert.equal(rects[0].weight, CUT, '上枠は断面なので太線');
  const lines = prims.filter(p => p.type === 'line');
  assert.deepEqual(lines.map(p => [p.x1, p.x2]), [[0, 0], [139, 139]], '縦線は帯の両端（枠の外縁）');
  assert.ok(lines.every(p => p.y1 === -1980 && p.y2 === 0 && p.weight === 'thin'),
    '縦線は上枠の下端から床まで・見えがかりなので細線');
});

test('openingSection: 三方枠（鋼板SF/SSF）の上枠は壁面へ戻る返しを持つ開いたコの字', () => {
  for (const fixtureType of ['SF', 'SSF']) {
    const prims = openingSectionPrimitives(frameOnly({ fixtureType }), 0, 1, CUT, SIL, { wallThicknessMm: 115 });
    assert.equal(prims.filter(p => p.type === 'rect').length, 0, `${fixtureType}: 閉じた矩形ではない`);
    const poly = prims.find(p => p.type === 'polyline');
    assert.deepEqual(poly.points,
      [[12, -2000], [0, -2000], [0, -1980], [139, -1980], [139, -2000], [127, -2000]],
      `${fixtureType}: 面(12)→外縁(0)→見付の下→反対の外縁(139)→面(127)。外縁の返しは出幅12`);
    assert.equal(poly.weight, CUT);
  }
});

test('openingSection: 三方枠の見込み・始点は出幅の編集値に追随する（見付も編集値）', () => {
  const o = frameOnly({ frameFaceWidth: 40, frameProjection: 30 });
  assert.equal(openingSectionWidthMm(o, { wallThicknessMm: 115 }), 175, '見込み=115+2×30');
  assert.equal(openingSectionOverhangMm(o), 30, '帯の始点を壁面から外へ出す量は出幅');
  const head = openingSectionPrimitives(o, 0, 1, CUT, SIL, { wallThicknessMm: 115 }).find(p => p.type === 'rect');
  assert.deepEqual([head.x, head.w, head.h], [0, 175, 40]);
  // 帯の向きが逆（dir=-1。x0 から左へ伸びる）でも帯は x0 の内側へ175
  const left = openingSectionPrimitives(o, 4000, -1, CUT, SIL, { wallThicknessMm: 115 }).find(p => p.type === 'rect');
  assert.deepEqual([left.x, left.w], [4000 - 175, 175]);
});

test('【失敗系】openingSection: 三方枠で壁厚が引けない→115、出幅が0・負・未設定→既定12、見付は開口幅の半分で頭打ち', () => {
  assert.equal(openingSectionWidthMm(frameOnly(), {}), 115 + 24, '壁厚なしは既定115');
  for (const frameProjection of [0, -5, null]) {
    const o = frameOnly({ frameProjection });
    assert.equal(openingSectionOverhangMm(o), 12, `出幅 ${frameProjection} は既定12`);
    assert.equal(openingSectionWidthMm(o, { wallThicknessMm: 115 }), 139);
  }
  const narrow = frameOnly({ width: 100, frameFaceWidth: 80 });
  const head = openingSectionPrimitives(narrow, 0, 1, CUT, SIL, { wallThicknessMm: 115 }).find(p => p.type === 'rect');
  assert.equal(head.h, 50, '見付80は開口幅100の半分=50で頭打ち（平面の方立と同じ）');
});

test('【失敗系】openingSection: 未知の建具記号の三方枠は solid（閉じた矩形）で描く', () => {
  const prims = openingSectionPrimitives(frameOnly({ fixtureType: 'ZZ' }), 0, 1, CUT, SIL, { wallThicknessMm: 115 });
  assert.equal(prims.filter(p => p.type === 'rect').length, 1);
  assert.equal(prims.filter(p => p.type === 'polyline').length, 0);
});

test('openingSection: 三方枠以外は出幅12固定・壁の範囲は材の合併のまま／壁が引けない三方枠の範囲は null', () => {
  assert.equal(isFrameOnlySection(swingDoor()), false);
  assert.equal(isFrameOnlySection(swingDoor({ subType: 'slidingDouble' })), false);
  assert.equal(openingSectionOverhangMm(swingDoor()), FRAME_OVERHANG_MM);
  assert.equal(openingSectionOverhangMm(swingDoor({ frameProjection: 30 })), FRAME_OVERHANG_MM,
    '三方枠でなければ出幅の値は見ない');
  assert.equal(openingSectionWallRange(frameOnly(), null), null, 'graph が無ければ null');
  assert.equal(openingSectionWallRange(frameOnly(), { walls: [] }), null, '軸 CL の無い建具は null');
});
