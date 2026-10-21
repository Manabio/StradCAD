import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorMenuItems, floorDeleteButtonState } from './floorChipModel.js';
import { Project } from '../core/project.js';

function threeFloors() {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  return project;
}

test('buildFloorMenuItems: 採用階（最下・中間・最上）には delete が無い', () => {
  const project = threeFloors();
  for (const id of ['p1', 'p2', 'p3']) {
    const items = buildFloorMenuItems(project, project.planeMap.get(id));
    assert.ok(!items.some(i => i.id === 'delete'), `${id} に delete が残っている`);
  }
});

test('buildFloorMenuItems: 検討案には delete-alt が1つだけある（失敗系: 検討案に delete は出ない）', () => {
  const project = threeFloors();
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  const items = buildFloorMenuItems(project, project.planeMap.get('alt1'));
  assert.equal(items.filter(i => i.id === 'delete-alt').length, 1);
  assert.ok(!items.some(i => i.id === 'delete'));
});

test('floorDeleteButtonState: 採用の中間階・最上階は [+][-] とも出す', () => {
  const project = threeFloors();
  for (const id of ['p2', 'p3']) {
    const s = floorDeleteButtonState(project, project.planeMap.get(id));
    assert.equal(s.showAdd, true, id);
    assert.equal(s.showDelete, true, id);
  }
});

test('floorDeleteButtonState: 最下階は [-] を出さない（[+] は出す）', () => {
  const project = threeFloors();
  const s = floorDeleteButtonState(project, project.planeMap.get('p1'));
  assert.equal(s.showAdd, true);
  assert.equal(s.showDelete, false);
  assert.equal(s.message, null);
});

test('floorDeleteButtonState: 唯一の階は [-] を出さない', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0, '1階', 'p1', 1, 1);
  const s = floorDeleteButtonState(project, project.planeMap.get('p1'));
  assert.equal(s.showAdd, true);
  assert.equal(s.showDelete, false);
});

test('floorDeleteButtonState: 検討案の表示中は [+][-] とも出さない（中間階の検討案でも）', () => {
  const project = threeFloors();
  project.addPlane(3000, '検討B', 'alt2', 2, 1, true, 'p2', 0);
  const s = floorDeleteButtonState(project, project.planeMap.get('alt2'));
  assert.equal(s.showAdd, false);
  assert.equal(s.showDelete, false);
  assert.equal(s.message, null);
});

test('floorDeleteButtonState: 屋根専用平面の表示中は [-] を出さない', () => {
  const project = threeFloors();
  project.addPlane(9000, '小屋伏', 'roof', 4, 1, false, null, 0, true, 'p3');
  const roof = project.planeMap.get('roof');
  assert.equal(roof.isRoofPlane, true);
  assert.equal(floorDeleteButtonState(project, roof).showDelete, false);
});

test('floorDeleteButtonState: 確認文言は検討案の有無で切り替わる', () => {
  const project = threeFloors();
  const p2 = project.planeMap.get('p2');
  assert.equal(floorDeleteButtonState(project, p2).message, 'この階を削除してもよろしいですか？');
  project.addPlane(3000, '検討B', 'alt2', 2, 1, true, 'p2', 0);
  assert.equal(floorDeleteButtonState(project, p2).message,
    'この階を削除してもよろしいですか？検討案も一緒に削除されます。');
  // 別の階の検討案は影響しない
  const p3 = project.planeMap.get('p3');
  assert.equal(floorDeleteButtonState(project, p3).message, 'この階を削除してもよろしいですか？');
});

test('buildFloorMenuItems: 採用階（最下・中間・最上）と検討案のすべてに「切断高」(cut-height) がある', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  for (const id of ['p1', 'p2', 'p3', 'alt1']) {
    const items = buildFloorMenuItems(project, project.planeMap.get(id));
    const cut = items.find(i => i.id === 'cut-height');
    assert.ok(cut, `${id} に cut-height が無い`);
    assert.equal(cut.label, '切断高');
  }
});

test('buildFloorMenuItems: 「天伏切断高」(ceiling-cut-height) が「切断高」の直後にある（採用階・検討案とも）', () => {
  const project = new Project('proj', 'test');
  project.addPlane(0,    '1階', 'p1', 1, 1);
  project.addPlane(3000, '2階', 'p2', 2, 1);
  project.addPlane(6000, '3階', 'p3', 3, 1);
  project.addPlane(0, '検討A', 'alt1', 1, 1, true, 'p1', 0);
  for (const id of ['p1', 'p2', 'p3', 'alt1']) {
    const items = buildFloorMenuItems(project, project.planeMap.get(id));
    const at = items.findIndex(i => i.id === 'cut-height');
    assert.equal(items[at + 1]?.id, 'ceiling-cut-height', `${id}: 切断高の隣`);
    assert.equal(items[at + 1].label, '天伏切断高');
    assert.equal(items.filter(i => i.id === 'ceiling-cut-height').length, 1);
  }
});
