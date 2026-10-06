// stairSectionEdit.js（階段パネルの図中編集・タイプ切替が sections へ書く値と型導出）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stair, StairType, StairPortSide } from '@core';
import { applySectionDimEdit, sectionsForType, isTurnStepsDim, portSideChange } from './stairSectionEdit.js';

test('回り階段の回転部（index1）に R=0 を入れると sections[1]=1・タイプは SWITCHBACK に導出', () => {
  const r = applySectionDimEdit({ type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }, 1, 0);
  assert.deepEqual(r.sections, [5, 1, 4]);
  assert.equal(r.type, StairType.SWITCHBACK);
});

test('折返し階段の踊り場（index1）に R=3 を入れると sections[1]=4・タイプは WINDING に導出', () => {
  const r = applySectionDimEdit({ type: StairType.SWITCHBACK, sections: [7, 1, 6], totalSteps: 13 }, 1, 3);
  assert.deepEqual(r.sections, [7, 4, 6]);
  assert.equal(r.type, StairType.WINDING);
});

test('直進部（偶数index）は 踏面数+1、タイプ不変。L字のコーナー（index1）は従来どおり値そのまま', () => {
  const a = applySectionDimEdit({ type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }, 0, 6);
  assert.deepEqual(a.sections, [7, 5, 4]);
  assert.equal(a.type, StairType.WINDING);
  const l = applySectionDimEdit({ type: StairType.FLARED, sections: [5, 3, 5], totalSteps: 12 }, 1, 2);
  assert.deepEqual(l.sections, [5, 2, 5]);
  assert.equal(l.type, StairType.FLARED);
  assert.equal(isTurnStepsDim(StairType.FLARED, 1), false);
});

test('【失敗系】sections 未設定（null）でも既定値から組み立てて編集できる', () => {
  const r = applySectionDimEdit({ type: StairType.SWITCHBACK, sections: null, totalSteps: 12 }, 1, 2);
  assert.equal(r.sections.length, 3);
  assert.equal(r.sections[1], 3);
  assert.equal(r.type, StairType.WINDING);
});

test('sectionsForType: 回り→折返しは回転部を 1（R=0）に、折返し→回りで R=0 のままなら既定の回り段数へ', () => {
  assert.deepEqual(sectionsForType(StairType.SWITCHBACK, { type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }), [5, 1, 4]);
  assert.deepEqual(sectionsForType(StairType.WINDING, { type: StairType.SWITCHBACK, sections: [7, 1, 6], totalSteps: 13 }), [7, 3, 6]);
  // 既に回り段（R>0）を持つ sections はそのまま
  assert.deepEqual(sectionsForType(StairType.WINDING, { type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }), [5, 5, 4]);
});

test('sectionsForType: 区間数が合わないタイプ切替（直進→踊り場付）は既定値で組み直す。既定の無いタイプは null', () => {
  const r = sectionsForType(StairType.STRAIGHT_LANDING, { type: StairType.STRAIGHT, sections: [13], totalSteps: 13 });
  assert.equal(r.length, 3);
  assert.equal(r[1], 1);
  assert.equal(sectionsForType('unknown', { type: StairType.STRAIGHT, sections: [13], totalSteps: 13 }), null);
});

const apply = (stair, fields) => { for (const [k, v] of Object.entries(fields)) stair.setField(k, v); };

test('portSideChange: 側面へ切り替えても totalSteps は変わらない（取りつき蹴上ぶん往路の直進部が減る）。走行端へ戻すと取りつき 0・直進部へ戻る', () => {
  const stair = new Stair('s', { type: StairType.SWITCHBACK, sections: [8, 5, 8] });
  const total = stair.totalSteps;
  apply(stair, portSideChange(stair, 'entry', StairPortSide.RIGHT, 1000));
  assert.equal(stair.entrySide, 'right');
  assert.equal(stair.entryTurnSteps, 4, '木造: 区間 1000mm ÷ 踏面 250');
  assert.deepEqual(stair.sections, [4, 5, 8]);
  assert.equal(stair.totalSteps, total);
  // 到達口は復路（sections[2]）から引く
  apply(stair, portSideChange(stair, 'arrival', StairPortSide.LEFT, 500));
  assert.equal(stair.arrivalTurnSteps, 2);
  assert.deepEqual(stair.sections, [4, 5, 6]);
  assert.equal(stair.totalSteps, total);
  // 走行端へ戻す
  apply(stair, portSideChange(stair, 'entry', StairPortSide.END, 1000));
  assert.equal(stair.entryTurnSteps, 0);
  assert.deepEqual(stair.sections, [8, 5, 6]);
  assert.equal(stair.totalSteps, total);
  apply(stair, portSideChange(stair, 'arrival', StairPortSide.END, 500));
  assert.deepEqual(stair.sections, [8, 5, 8]);
  assert.equal(stair.totalSteps, total);
});

test('【失敗系】portSideChange: 直進部が 2 段未満になる側面は拒否（null）。鉄骨は蹴上 0 なので直進部を食わない。sections が組めない型は null', () => {
  const stair = new Stair('s', { type: StairType.SWITCHBACK, sections: [5, 5, 8] });
  assert.equal(portSideChange(stair, 'entry', StairPortSide.LEFT, 1000), null, '5−4=1 段');
  assert.equal(portSideChange(stair, 'entry', StairPortSide.END, 1000).entryTurnSteps, 0, '走行端へは常に切り替えられる');
  stair.setField('structure', 'STEEL');
  assert.deepEqual(portSideChange(stair, 'entry', StairPortSide.LEFT, 1000), { entrySide: 'left', entryTurnSteps: 0 });
  // 区間数が合わない sections（直進など）の stair で取りつきを足す・戻す切替は組めない
  const bad = { type: StairType.STRAIGHT, structure: 'WOOD', tread: 250, sections: [13], entryTurnSteps: 0 };
  assert.equal(portSideChange(bad, 'entry', StairPortSide.LEFT, 1000), null);
  assert.equal(portSideChange({ ...bad, entryTurnSteps: 3 }, 'entry', StairPortSide.END, 1000), null);
});
