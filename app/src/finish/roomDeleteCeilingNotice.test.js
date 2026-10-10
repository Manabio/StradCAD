// 部屋削除確認の天伏情報の注意（S9）。純関数と RoomDeleteConfirm の配線（.jsx は単体 import できないため 1行まるごと一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CeilingZone } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { roomsLosingCeilingZones } from './roomDeleteCeilingNotice.js';

const zone = (g) => new CeilingZone({ id: 'z', cells: [g.cell(0, 0)], heightMm: 2800 });

test('区画あり／なし／子にだけあり／存在しない id', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '子', undefined, new Set([parent.id]));
  assert.equal(roomsLosingCeilingZones(g.graph, [parent.id, child.id]), false, '区画なし');
  child.setCeilingZones([zone(g)]);
  assert.equal(roomsLosingCeilingZones(g.graph, [parent.id]), false, '親には無い');
  assert.equal(roomsLosingCeilingZones(g.graph, [parent.id, child.id]), true, '子にだけある');
  parent.setCeilingZones([zone(g)]);
  assert.equal(roomsLosingCeilingZones(g.graph, [parent.id]), true, '本人にある');
});

test('【失敗系】空配列・存在しない id・graph/roomIds なし・ceilingZones 未定義でも落ちず false', () => {
  const g = makeGrid([0, 1000], [0, 1000]);
  g.interior([[0, 0]]);
  assert.equal(roomsLosingCeilingZones(g.graph, []), false);
  assert.equal(roomsLosingCeilingZones(g.graph, ['nope']), false);
  assert.equal(roomsLosingCeilingZones(null, ['a']), false);
  assert.equal(roomsLosingCeilingZones(g.graph, null), false);
  assert.equal(roomsLosingCeilingZones({ roomMap: new Map([['a', {}]]) }, ['a']), false, 'ceilingZones 未定義');
});

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'RoomDeleteConfirm.jsx'), 'utf8');

test('【配線】RoomDeleteConfirm: 本人＋道連れの子孫を roomsLosingCeilingZones に渡し、真のとき1行の注意を足す', () => {
  assert.match(src, /^\s*const lostCeiling = mode\.roomDeleteLosesCeilingZones\(deleteConfirm\.roomId\);\s*$/m, 'lostCeiling の算出行が見つからない');
  assert.match(src, /^\s*\{lostCeiling && <><br \/>指定された天伏情報も削除されます。よろしいですか？<\/>\}\s*$/m, '注意の1行が見つからない');
  assert.doesNotMatch(src, /mode\._/, 'jsx から mode の非公開メソッドを直接呼ばない');
  const modeSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../modes/FinishModeState.js'), 'utf8');
  assert.match(modeSrc, /^\s*return roomsLosingCeilingZones\(this\.graph, \[roomId, \.\.\.this\._cascadedRoomIds\(roomId\)\]\);\s*$/m, 'FinishModeState.roomDeleteLosesCeilingZones の本体が見つからない');
});

test('【配線】注意は削除不可（blockReason）の分岐より後＝確認ダイアログだけに出る', () => {
  const ls = src.split(/\r?\n/).map(l => l.trim());
  const block = ls.indexOf('if (blockReason) {');
  const lost = ls.findIndex(l => l.startsWith('const lostCeiling ='));
  assert.ok(block >= 0 && lost > block);
});
