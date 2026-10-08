import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFloorMenuItems } from './floorChipModel.js';
import { Project } from '../core/project.js';

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
