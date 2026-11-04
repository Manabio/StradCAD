// 部屋カード「部分詳細」欄の判断（finish/roomDetailRefsEdit.js。部分詳細図 S8a）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '@core';
import { DetailSlot, ROOM_DETAIL_SLOTS, ROOM_PART_SLOTS } from '../core/constants.js';
import { roomDetailRefSelects, roomDetailRefsAfterSelect } from './roomDetailRefsEdit.js';
import { baseboardFigure, wallBackedFigure, stepNoseFigure, ceilingNoseFigure } from './roomDetailTestFixtures.js';
import { ROOM_DETAIL_REF_TEXT } from '../error.js';

const { FLOOR_WALL, WALL_CEILING, FLOOR_STEP, CEILING_STEP } = DetailSlot;
const jambPlan = { key: 'df-jamb', label: '方立', category: 'paired', view: 'plan', subject: 'jamb' };
const FIGURES = [
  { ...baseboardFigure('df-fw1'), label: '巾木A' },
  { ...wallBackedFigure('df-wc1', WALL_CEILING), label: '廻り縁A' },
  { ...stepNoseFigure('df-fs1'), label: '段鼻A' },
  { ...ceilingNoseFigure('df-cs1'), label: '見切りA' },
  jambPlan,
];

test('select は床と壁・壁と天井・床の段差・天井の段差の 4 つで、先頭は「なし」。選択肢は分類（category・view・subject）一致の図だけ（他の分類の図は出ない）', () => {
  const room = new Room('r1', 'LDK');
  const sels = roomDetailRefSelects(room, FIGURES);
  assert.deepEqual(sels.map(s => s.slot), [...ROOM_DETAIL_SLOTS, ...ROOM_PART_SLOTS]);
  assert.deepEqual(sels.map(s => s.label), ['床と壁', '壁と天井', '床の段差', '天井の段差']);
  assert.deepEqual(sels[0].options, [{ value: '', label: ROOM_DETAIL_REF_TEXT.none }, { value: 'df-fw1', label: '巾木A' }]);
  assert.deepEqual(sels[1].options, [{ value: '', label: 'なし' }, { value: 'df-wc1', label: '廻り縁A' }]);
  assert.deepEqual(sels[2].options, [{ value: '', label: 'なし' }, { value: 'df-fs1', label: '段鼻A' }]);
  assert.deepEqual(sels[3].options, [{ value: '', label: 'なし' }, { value: 'df-cs1', label: '見切りA' }]);
  assert.deepEqual(sels.map(s => s.value), ['', '', '', '']);
});

test('天井の段差（部屋単位）: 選ぶ・「なし」で外す（他の slot は保つ）。床の段差の図は天井の段差に出ない（同じ part/section でも subject が違う）', () => {
  const room = new Room('r1', 'LDK');
  const a = roomDetailRefsAfterSelect(room, CEILING_STEP, 'df-cs1');
  assert.deepEqual(a, { [CEILING_STEP]: 'df-cs1' });
  room.setDetailRefs({ ...a, [FLOOR_STEP]: 'df-fs1' });
  assert.deepEqual(roomDetailRefsAfterSelect(room, CEILING_STEP, ''), { [FLOOR_STEP]: 'df-fs1' });
  const sels = roomDetailRefSelects(room, FIGURES);
  assert.equal(sels[3].value, 'df-cs1');
  assert.ok(!sels[3].options.some(o => o.value === 'df-fs1'));
  assert.ok(!sels[2].options.some(o => o.value === 'df-cs1'));
});

test('床の段差: 選ぶ・「なし」で外す（他の slot は保つ）。part の図は床と壁の選択肢に出ず、床と壁の図は床の段差に出ない', () => {
  const room = new Room('r1', 'LDK');
  const a = roomDetailRefsAfterSelect(room, FLOOR_STEP, 'df-fs1');
  assert.deepEqual(a, { [FLOOR_STEP]: 'df-fs1' });
  room.setDetailRefs({ ...a, [FLOOR_WALL]: 'df-fw1' });
  assert.deepEqual(roomDetailRefsAfterSelect(room, FLOOR_STEP, ''), { [FLOOR_WALL]: 'df-fw1' });
  room.setDetailRefs({ ...a, [FLOOR_WALL]: 'df-fw1' });
  const sels = roomDetailRefSelects(room, FIGURES);
  assert.equal(sels[2].value, 'df-fs1');
  assert.ok(!sels[0].options.some(o => o.value === 'df-fs1'));
  assert.ok(!sels[2].options.some(o => o.value === 'df-fw1'));
  // 【失敗系】分類違いの現在値は末尾に「この枠には使えません」で残る
  room.setDetailRefs({ [FLOOR_STEP]: 'df-fw1' });
  assert.ok(roomDetailRefSelects(room, FIGURES)[2].options.at(-1).label.includes('この枠には使えません'));
});

test('figureList 省略時（三層合成後）は組込み「巾木 出 10」が床と壁の選択肢に出る（壁と天井には出ない）', () => {
  const [fw, wc] = roomDetailRefSelects(new Room('r1', 'LDK'));
  assert.ok(fw.options.some(o => o.value === 'df-builtin-baseboard-10'), JSON.stringify(fw.options));
  assert.ok(!wc.options.some(o => o.value === 'df-builtin-baseboard-10'));
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
