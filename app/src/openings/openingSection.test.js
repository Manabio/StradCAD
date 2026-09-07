// openingSection.js（建具ごとの断面の描き方）の単体テスト。
// 寸法の根拠はユーザー明示指示2026-09「木製片開き戸の断面は、指定高さに枠と扉断面（厚30、
// 下はFL10、枠戸当たりまでの四角（中線））」「枠の見付けは30、戸当たりは10だったので、
// 指定高さ−20が扉上端」「上枠は、竪枠と同じ断面」「平面に指定があるので参照のこと」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '@core';
import { openingSectionPrimitives, openingSectionWidthMm, openingOpenPerpDir } from './openingSection.js';
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
