// 腰壁・垂れ壁ダイアログの判断（finish/kneeDropRecordEdit.js・finish/roomDetailRefsEdit.js の一般化。部分詳細図 S8b-1）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSlot, KNEE_DROP_DETAIL_SLOTS, KneeDropFrontSide } from '../core/constants.js';
import { detailRefSelectsFor, detailRefsAfterSelectFor } from './roomDetailRefsEdit.js';
import { kneeDropDetailSelects, kneeDropFrontSideOptions, buildKneeDropRecord } from './kneeDropRecordEdit.js';
import { partFigure, baseboardFigure, move, fixedLen } from './roomDetailTestFixtures.js';
import { PenDir } from '../core/constants.js';
import { Plane, PlanGraph } from '../core.js';

const { KNEE_TOP, DROP_BOTTOM } = DetailSlot;
const cap = (key, label) => ({ ...partFigure(key, KNEE_TOP, [move(PenDir.DOWN, fixedLen(20)), move(PenDir.LEFT, fixedLen(10))]), label });
const FIGURES = [cap('df-cap', '天板A'), baseboardFigure('df-bb')];

test('detailRefSelectsFor: slot の並びの select。先頭は「なし」。選択肢は part/section/wall の図だけ（巾木など他の分類は出ない）', () => {
  const sels = detailRefSelectsFor(KNEE_DROP_DETAIL_SLOTS, null, FIGURES, { labelOf: s => `<${s}>` });
  assert.deepEqual(sels.map(s => [s.slot, s.label, s.value]), [[KNEE_TOP, '<kneeTop>', ''], [DROP_BOTTOM, '<dropBottom>', '']]);
  assert.deepEqual(sels[0].options, [{ value: '', label: 'なし' }, { value: 'df-cap', label: '天板A（df-cap）' }]);
  assert.deepEqual(sels[1].options, sels[0].options, 'kneeTop と dropBottom は同じ分類（part/section/wall）');
  // 既定のラベル（error.js の slot ラベル）
  assert.deepEqual(detailRefSelectsFor(KNEE_DROP_DETAIL_SLOTS, null, FIGURES).map(s => s.label), ['腰壁の天端', '垂れ壁の下端']);
});

test('figureList 省略時（三層合成後）は組込み「天板 厚 20×（12＋壁厚＋12）」が天端・下端の選択肢に出る（床と壁の選択肢には出ない）', () => {
  const [top, bottom] = kneeDropDetailSelects({ kneeVal: 800, dropVal: 400 });
  assert.ok(top.options.some(o => o.value === 'df-builtin-kneecap-20'), JSON.stringify(top.options));
  assert.ok(bottom.options.some(o => o.value === 'df-builtin-kneecap-20'));
  const [fw] = detailRefSelectsFor([DetailSlot.FLOOR_WALL], null);
  assert.ok(!fw.options.some(o => o.value === 'df-builtin-kneecap-20'));
});

test('detailRefsAfterSelectFor: 選ぶ・外す。slots に無い slot は変えない。元は変えない。最後の 1 件を外すと null', () => {
  const a = detailRefsAfterSelectFor(KNEE_DROP_DETAIL_SLOTS, null, KNEE_TOP, 'df-cap');
  assert.deepEqual(a, { [KNEE_TOP]: 'df-cap' });
  assert.deepEqual(detailRefsAfterSelectFor(KNEE_DROP_DETAIL_SLOTS, a, DROP_BOTTOM, 'df-cap'), { [KNEE_TOP]: 'df-cap', [DROP_BOTTOM]: 'df-cap' });
  assert.equal(detailRefsAfterSelectFor(KNEE_DROP_DETAIL_SLOTS, a, KNEE_TOP, ''), null);
  assert.equal(detailRefsAfterSelectFor(KNEE_DROP_DETAIL_SLOTS, a, DetailSlot.FLOOR_WALL, 'df-x'), a, '【失敗系】対象外の slot は現状のまま');
  assert.deepEqual(a, { [KNEE_TOP]: 'df-cap' }, '元は変えない');
});

test('kneeDropDetailSelects: 腰壁の値があれば「天端の部分詳細」・垂れ壁の値があれば「下端の部分詳細」。値が無い側は出さない', () => {
  assert.deepEqual(kneeDropDetailSelects({ kneeVal: 800, dropVal: null }, FIGURES).map(s => [s.slot, s.label]), [[KNEE_TOP, '天端の部分詳細']]);
  assert.deepEqual(kneeDropDetailSelects({ kneeVal: null, dropVal: 400 }, FIGURES).map(s => [s.slot, s.label]), [[DROP_BOTTOM, '下端の部分詳細']]);
  assert.deepEqual(kneeDropDetailSelects({ kneeVal: 800, dropVal: 400 }, FIGURES).map(s => s.slot), [KNEE_TOP, DROP_BOTTOM]);
  assert.deepEqual(kneeDropDetailSelects({ kneeVal: null, dropVal: null }, FIGURES), [], '【失敗系】値が無ければ select は出ない');
  const withRef = kneeDropDetailSelects({ kneeVal: 800, dropVal: null, detailRefs: { [KNEE_TOP]: 'df-gone' } }, FIGURES);
  assert.equal(withRef[0].value, 'df-gone');
  assert.ok(withRef[0].options.at(-1).label.includes('見つかりません'), '参照切れの現在値は末尾に残る');
});

test('kneeDropFrontSideOptions: 区間の両側の部屋名つきの 2 択。無名・部屋なし・解決不能は（部屋なし）', () => {
  assert.deepEqual(kneeDropFrontSideOptions({ roomNeg: { name: 'LDK' }, roomPos: { name: '和室' } }), [
    { value: KneeDropFrontSide.ROOM_NEG, label: 'LDK' }, { value: KneeDropFrontSide.ROOM_POS, label: '和室' },
  ]);
  assert.deepEqual(kneeDropFrontSideOptions({ roomNeg: { name: '' }, roomPos: null }).map(o => o.label), ['（部屋なし）', '（部屋なし）']);
  assert.deepEqual(kneeDropFrontSideOptions(null).map(o => o.label), ['（部屋なし）', '（部屋なし）']);
});

test('buildKneeDropRecord: 既存の detailRefs・frontSide を引き継ぐ（高さだけ編集しても割当てが消えない）。undo の before/after に使える形', () => {
  const existing = { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-cap' }, frontSide: KneeDropFrontSide.ROOM_POS };
  const rec = buildKneeDropRecord({ kneeVal: 900, dropVal: null, detailRefs: existing.detailRefs, frontSide: existing.frontSide });
  assert.deepEqual(rec, { knee: { topHeight: 900 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-cap' }, frontSide: KneeDropFrontSide.ROOM_POS });
  // App.jsx handleKneeDropWallConfirm と同じ経路: graph.setKneeDropWall → 取り出した記録を before にして戻せる
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.setKneeDropWall('k', existing);
  const before = graph.kneeDropWalls.get('k');
  graph.setKneeDropWall('k', rec);
  graph.setKneeDropWall('k', before);
  assert.deepEqual(graph.kneeDropWalls.get('k'), existing);
});

test('buildKneeDropRecord: 外した側の割当て（腰壁を外した kneeTop・垂れ壁を外した dropBottom）は落ちる。既定の表の側・割当て無しはキーを持たない', () => {
  const refs = { [KNEE_TOP]: 'df-cap', [DROP_BOTTOM]: 'df-cap' };
  assert.deepEqual(buildKneeDropRecord({ kneeVal: null, dropVal: 400, detailRefs: refs, frontSide: KneeDropFrontSide.ROOM_NEG }),
    { knee: null, drop: { bottomHeight: 400 }, detailRefs: { [DROP_BOTTOM]: 'df-cap' } });
  assert.deepEqual(buildKneeDropRecord({ kneeVal: 800, dropVal: null, detailRefs: null }), { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual(buildKneeDropRecord({ kneeVal: 800, dropVal: null, detailRefs: null, frontSide: 'zzz' }), { knee: { topHeight: 800 }, drop: null }, '未知の表の側は既定＝キー無し');
});

test('【失敗系】buildKneeDropRecord: 腰壁も垂れ壁も無ければ null（解除。割当ても消える）', () => {
  assert.equal(buildKneeDropRecord({ kneeVal: null, dropVal: null, detailRefs: { [KNEE_TOP]: 'df-cap' }, frontSide: KneeDropFrontSide.ROOM_POS }), null);
});
