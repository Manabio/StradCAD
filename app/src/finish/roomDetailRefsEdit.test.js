// 部屋カード「部分詳細」欄の判断（finish/roomDetailRefsEdit.js。部分詳細図 S8a）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '@core';
import { DetailSlot, ROOM_DETAIL_SLOTS } from '../core/constants.js';
import { roomDetailRefSelects, roomDetailRefsAfterSelect } from './roomDetailRefsEdit.js';
import { baseboardFigure, wallBackedFigure } from './roomDetailTestFixtures.js';
import { ROOM_DETAIL_REF_TEXT } from '../error.js';

const { FLOOR_WALL, WALL_CEILING } = DetailSlot;
const jambPlan = { key: 'df-jamb', label: '方立', category: 'paired', view: 'plan', subject: 'jamb' };
const FIGURES = [
  { ...baseboardFigure('df-fw1'), label: '巾木A' },
  { ...wallBackedFigure('df-wc1', WALL_CEILING), label: '廻り縁A' },
  jambPlan,
];

test('select は床と壁・壁と天井の 2 つで、先頭は「なし」。選択肢は junction・section・subject 一致の図だけ（他の分類の図は出ない）', () => {
  const room = new Room('r1', 'LDK');
  const sels = roomDetailRefSelects(room, FIGURES);
  assert.deepEqual(sels.map(s => s.slot), ROOM_DETAIL_SLOTS);
  assert.deepEqual(sels.map(s => s.label), ['床と壁', '壁と天井']);
  assert.deepEqual(sels[0].options, [{ value: '', label: ROOM_DETAIL_REF_TEXT.none }, { value: 'df-fw1', label: '巾木A（df-fw1）' }]);
  assert.deepEqual(sels[1].options, [{ value: '', label: 'なし' }, { value: 'df-wc1', label: '廻り縁A（df-wc1）' }]);
  assert.deepEqual(sels.map(s => s.value), ['', '']);
});

test('現在値は detailRefs のキー。参照切れ・分類違いの現在値は選択肢の末尾に「見つかりません」「この枠には使えません」として残る', () => {
  const room = new Room('r1', 'LDK');
  room.setDetailRefs({ [FLOOR_WALL]: 'df-gone', [WALL_CEILING]: 'df-fw1' });
  const [fw, wc] = roomDetailRefSelects(room, FIGURES);
  assert.equal(fw.value, 'df-gone');
  assert.equal(fw.options.at(-1).value, 'df-gone');
  assert.ok(fw.options.at(-1).label.includes('見つかりません'));
  assert.equal(wc.value, 'df-fw1');
  assert.ok(wc.options.at(-1).label.includes('この枠には使えません'));
});

test('roomDetailRefsAfterSelect: 選ぶ・差し替える・「なし」で外す。最後の 1 件を外すと null。元は変えない。slot 以外は触らない', () => {
  const room = new Room('r1', 'LDK');
  const a = roomDetailRefsAfterSelect(room, FLOOR_WALL, 'df-fw1');
  assert.deepEqual(a, { [FLOOR_WALL]: 'df-fw1' });
  assert.equal(room.detailRefs, null, '元の部屋は変えない');
  room.setDetailRefs(a);
  const b = roomDetailRefsAfterSelect(room, WALL_CEILING, 'df-wc1');
  assert.deepEqual(b, { [FLOOR_WALL]: 'df-fw1', [WALL_CEILING]: 'df-wc1' });
  assert.deepEqual(roomDetailRefsAfterSelect(room, FLOOR_WALL, 'df-fw2'), { [FLOOR_WALL]: 'df-fw2' });
  assert.equal(roomDetailRefsAfterSelect(room, FLOOR_WALL, ''), null);
  // 【失敗系】対象外の slot（建具の slot・wall など）は変えずに現状を返す
  assert.equal(roomDetailRefsAfterSelect(room, DetailSlot.JAMB, 'df-x'), room.detailRefs);
  assert.equal(roomDetailRefsAfterSelect(room, 'wall', 'df-x'), room.detailRefs);
  assert.equal(roomDetailRefsAfterSelect(new Room('r2', ''), 'wall', 'df-x'), null);
});
