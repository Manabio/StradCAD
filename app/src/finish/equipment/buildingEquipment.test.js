// finish/equipment/buildingEquipment.js（昇降機器具の建物全体読み出し。純関数）の単体テスト。
// 昇降機の仕様追加 ステップ4・S4。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../core.js';
import { floorEquipmentRowLists, buildingEquipmentCatalog, equipmentSpanLabelOf } from './buildingEquipment.js';

function setupProject(floorCount) {
  const project = new Project('proj', 'test');
  const graphs = [];
  for (let i = 0; i < floorCount; i++) {
    const { graph } = project.addPlane(i * 3000, `${i + 1}階`, `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}

test('floorEquipmentRowLists: アクティブ階はgraph.equipmentRows（生きている行）、他階はproject.equipmentIndexから読む', () => {
  const { project, graphs } = setupProject(3);
  const [g1, g2] = graphs;
  g1.addEquipmentRow({ id: 'a', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  project.replaceEquipmentIndex([
    ['p2', [{ id: 'b', category: 'ev', no: 2, usage: 'passenger' }]],
    ['p3', []],
  ]);

  const lists = floorEquipmentRowLists(project, g1);

  assert.equal(lists.length, 3);
  assert.equal(lists[0].plane.id, 'p1');
  assert.equal(lists[0].rows, g1.equipmentRows, 'アクティブ階は生きているequipmentRowsそのもの');
  assert.equal(lists[0].rows[0].id, 'a');
  assert.equal(lists[1].plane.id, 'p2');
  assert.deepEqual(lists[1].rows, [{ id: 'b', category: 'ev', no: 2, usage: 'passenger' }]);
  assert.deepEqual(lists[2].rows, []);
  void g2;
});

test('floorEquipmentRowLists: indexが空（未読込み）の階はrows:[]になる', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  const lists = floorEquipmentRowLists(project, g1);
  assert.deepEqual(lists[1].rows, []);
});

test('buildingEquipmentCatalog: 全採用階の行から重複除去したカタログを作る（重複は先勝ち＝低階が勝つ）', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  g1.addEquipmentRow({ id: 'a', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  project.replaceEquipmentIndex([
    ['p2', [{ id: 'a', category: 'ev', no: 1, usage: 'passenger' }, { id: 'b', category: 'ev', no: 2, usage: 'passenger' }]],
  ]);

  const catalog = buildingEquipmentCatalog(project, g1);

  assert.equal(catalog.length, 2, '同じid(a)は1件にまとまる');
  assert.deepEqual(catalog.map(c => c.id).sort(), ['a', 'b']);
});

test('【m7】buildingEquipmentCatalog: 同じidが複数階にあれば先勝ち（低階が勝つ）——1階no=1・2階no=9なら結果はno=1', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  g1.addEquipmentRow({ id: 'dup', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  project.replaceEquipmentIndex([['p2', [{ id: 'dup', category: 'ev', no: 9, usage: 'freight' }]]]);

  const catalog = buildingEquipmentCatalog(project, g1);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].no, 1, '低階（1階）のno=1が勝つはず');
});

test('buildingEquipmentCatalog: project.planesに無いplaneIdのindexエントリは無視される', () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  project.replaceEquipmentIndex([
    ['no-such-plane', [{ id: 'ghost', category: 'ev', no: 9, usage: 'passenger' }]],
  ]);

  const catalog = buildingEquipmentCatalog(project, g1);

  assert.deepEqual(catalog, [], '存在しないplaneのindexは読まれない');
});

test('equipmentSpanLabelOf: idが存在する全階から設置階〜最上階を作る（1階〜3階）', () => {
  const { project, graphs } = setupProject(3);
  const [g1] = graphs;
  g1.addEquipmentRow({ id: 'a', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  project.replaceEquipmentIndex([
    ['p2', [{ id: 'a', category: 'ev', no: 1, usage: 'passenger' }]],
    ['p3', [{ id: 'a', category: 'ev', no: 1, usage: 'passenger' }]],
  ]);

  assert.equal(equipmentSpanLabelOf(project, g1, 'a'), '1階〜3階');
});

test('equipmentSpanLabelOf: 1階だけならその階名だけ', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  g1.addEquipmentRow({ id: 'a', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });

  assert.equal(equipmentSpanLabelOf(project, g1, 'a'), '1階');
});

test('【失敗系】equipmentSpanLabelOf: idを持つ行が1件も無ければnull', () => {
  const { project, graphs } = setupProject(2);
  const [g1] = graphs;
  assert.equal(equipmentSpanLabelOf(project, g1, 'no-such-id'), null);
});

// ---- QA指摘M1（HEADからの退行）: アクティブ階が検討案の平面（project.planesに無い）のとき、
// 採用階のindexを混ぜず自階だけを返す ----

test('【QA回帰・M1】floorEquipmentRowLists: アクティブ階が検討案の平面（project.planesに無い）なら自階だけの1件を返す（採用階のindexを混ぜない）', () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  altGraph.addEquipmentRow({ id: 'x', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  // 採用階(p1)のindexに別のidが積まれていても混ざらないことを確認する
  project.replaceEquipmentIndex([['p1', [{ id: 'other', category: 'ev', no: 5, usage: 'passenger' }]]]);

  const lists = floorEquipmentRowLists(project, altGraph);

  assert.equal(lists.length, 1);
  assert.equal(lists[0].plane.id, 'alt1');
  assert.equal(lists[0].rows, altGraph.equipmentRows);
});

test('【QA回帰・M1】buildingEquipmentCatalog: 検討案の平面で2基設置してもnoが1・2（重複しない）。採用階の器具は混ざらない', () => {
  const { project, graphs } = setupProject(1);
  const [g1] = graphs;
  const { graph: altGraph } = project.addPlane(0, '検討1', 'alt1', 1, 1, true, g1.plane.id, 0);
  altGraph.addEquipmentRow({ id: 'x1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(), roomId: null });
  altGraph.addEquipmentRow({ id: 'x2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set(), roomId: null });
  project.replaceEquipmentIndex([['p1', [{ id: 'other', category: 'ev', no: 9, usage: 'passenger' }]]]);

  const catalog = buildingEquipmentCatalog(project, altGraph);

  assert.deepEqual(catalog.map(c => c.no).sort(), [1, 2], 'noは重複しない');
  assert.ok(!catalog.some(c => c.id === 'other'), '採用階の器具は混ざらない');
});
