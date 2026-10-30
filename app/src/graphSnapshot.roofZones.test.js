// 屋根区画（PlanGraph.roofZones）の保存・復元のテスト。FBS（GS.ROOF_ZONES=56）・graphSnapshot・線id振り直し。
// 区画が無い文書のバイト列を変えない（vector を書かない）ことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import {
  Plane, PlanGraph, CenterLineType, Discipline, RoofSpec, RoofZone, ROOF_ZONE_KEYS, ROOF_SPEC_KEYS,
} from './core.js';
import { NON_DEFAULT_ROOF_SPEC } from './finish/roofTestFixtures.js';
import {
  serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot, serializeGraphWithFreshLineIds,
} from './graphSnapshot.js';
import { remapLineIdsInSnapshot } from './lineIdRemap.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

/** 実在の線を指すセルキーを2つ持つ階。 */
function makeLayout() {
  const graph = makeGraph();
  const x = [0, 1000, 2000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const y = [0, 1000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const key = i => `${x[i].id}:${y[0].id}:${x[i + 1].id}:${y[1].id}`;
  return { graph, a: key(0), b: key(1) };
}

/** ルートテーブルの vtable 長（バイト）。末尾の未使用フィールドは vtable で切り詰められる。 */
function rootVtableLength(bytes) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vt = root - bb.readInt32(root);
  return bb.readInt16(vt);
}
const ROOF_ZONES_FIELD_INDEX = 56; // schema/graphFbs.js GS.ROOF_ZONES

test('FBS 往復: 非既定の spec を持つ2区画が id・cells・spec ごと往復する', () => {
  const { graph, a, b } = makeLayout();
  const spec2 = RoofSpec.fromData({ ...NON_DEFAULT_ROOF_SPEC, slope: 5, note: '区画2' });
  graph.setRoofZones([
    new RoofZone({ id: 'z1', cells: [b, a], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) }),
    new RoofZone({ id: 'z2', cells: ['zz:zz:zz:zz'], spec: spec2 }),
  ]);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.roofZones.length, 2);
  assert.ok(Object.isFrozen(restored.roofZones));
  assert.deepEqual(restored.roofZones.map(z => z.toData()), graph.roofZones.map(z => z.toData()));
  assert.ok(restored.roofZones[0].spec instanceof RoofSpec);
  assert.deepEqual(restored.roofZones[0].cells, [a, b].sort());
});

test('FBS 往復: 既定の spec の区画も保存される（主屋根と違い既定でも書く）', () => {
  const { graph, a } = makeLayout();
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: [a] })]);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.roofZones.length, 1);
  assert.deepEqual(restored.roofZones[0].spec.toData(), new RoofSpec().toData());
});

test('plain 経路: decodeFloorSnapshot のキー集合は ROOF_ZONE_KEYS／spec は ROOF_SPEC_KEYS。JSON 往復でも復元できる', () => {
  const { graph, a } = makeLayout();
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: [a], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) })]);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  assert.deepEqual(Object.keys(snap.roofZones[0]).sort(), [...ROOF_ZONE_KEYS].sort());
  assert.deepEqual(Object.keys(snap.roofZones[0].spec).sort(), [...ROOF_SPEC_KEYS].sort());
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(restored.roofZones.map(z => z.toData()), graph.roofZones.map(z => z.toData()));
});

test('区画が無い文書のバイト列は不変: キー無し／空配列の snapshot は同じバイト列で、ルートの vtable に ROOF_ZONES の枠が無い', () => {
  const { graph } = makeLayout();
  const bytes = serializeGraph(graph);
  const snap = decodeFloorSnapshot(bytes);
  assert.deepEqual(snap.roofZones, []);
  const noKey = { ...snap };
  delete noKey.roofZones;
  assert.deepEqual([...encodeFloorSnapshot(noKey)], [...bytes], 'roofZones キー無しでも同じバイト列');
  assert.ok(rootVtableLength(bytes) <= 4 + 2 * ROOF_ZONES_FIELD_INDEX, '区画なしは末尾フィールドが vtable で切り詰められる');

  graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a:b:c:d'] })]);
  const withZone = serializeGraph(graph);
  assert.ok(withZone.length > bytes.length);
  assert.equal(rootVtableLength(withZone), 4 + 2 * (ROOF_ZONES_FIELD_INDEX + 1), '区画ありは vtable に ROOF_ZONES の枠が出る');
});

test('区画を足して消すと、バイト列は元と一致する（1バイトも変わらない）', () => {
  const { graph } = makeLayout();
  const base = serializeGraph(graph);
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: ['a:b:c:d'] })]);
  graph.setRoofZones([]);
  assert.deepEqual([...serializeGraph(graph)], [...base]);
});

test('【失敗系】旧データ（roofZones キーが無い snapshot）は区画なしに復元され、直前の区画は消える（clear で初期化）', () => {
  const { graph, a } = makeLayout();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  delete snap.roofZones;
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: [a] })]);
  restoreGraph(graph, snap);
  assert.deepEqual(graph.roofZones, []);
  assert.ok(Object.isFrozen(graph.roofZones));
});

test('【失敗系】壊れた区画（id 無し・空 cells・重複 id・セル重複）は復元で正規化される', () => {
  const { graph } = makeLayout();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const spec = new RoofSpec().toData();
  snap.roofZones = [
    { id: '', cells: ['a'], spec }, { id: 'e', cells: [], spec },
    { id: 'z1', cells: ['a', 'b'], spec }, { id: 'z1', cells: ['c'], spec }, { id: 'z2', cells: ['b'], spec },
  ];
  const restored = makeGraph();
  restoreGraph(restored, snap);
  assert.deepEqual(restored.roofZones.map(z => [z.id, [...z.cells]]), [['z1', ['a', 'b']]]);
});

test('【失敗系】FBS: spec を書かない区画（spec:null の plain）は readRoofSpec が null を返す分岐を通り、既定の RoofSpec の区画 1 件で復元される', () => {
  const { graph, a } = makeLayout();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const bytes = encodeFloorSnapshot({ ...snap, roofZones: [{ id: 'z', cells: [a], spec: null }] });
  const copy = makeGraph();
  restoreGraph(copy, bytes);
  assert.equal(copy.roofZones.length, 1);
  assert.equal(copy.roofZones[0].id, 'z');
  assert.deepEqual(copy.roofZones[0].spec.toData(), new RoofSpec().toData());
});

test('remapLineIdsInSnapshot: roofZones[].cells の線idも振り直しに追従する', () => {
  const { graph, a, b } = makeLayout();
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: [a, b] })]);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const idMap = new Map();
  for (const id of new Set([...a.split(':'), ...b.split(':')])) idMap.set(id, `new-${id}`);
  const out = remapLineIdsInSnapshot(snap, idMap);
  const mapKey = k => k.split(':').map(id => idMap.get(id)).join(':');
  assert.deepEqual([...out.roofZones[0].cells].sort(), [a, b].map(mapKey).sort(), '置換後の並びは問わない（復元側で昇順化）');
  assert.deepEqual(snap.roofZones[0].cells, [a, b].sort(), '入力は破壊しない');
});

test('階の複製・検討案のコピー（serializeGraphWithFreshLineIds）で区画が残り、セルは振り直した線idを指す', () => {
  const { graph, a, b } = makeLayout();
  graph.setRoofZones([new RoofZone({ id: 'z1', cells: [a, b], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) })]);
  const copy = makeGraph();
  restoreGraph(copy, serializeGraphWithFreshLineIds(graph));
  assert.equal(copy.roofZones.length, 1);
  assert.deepEqual(copy.roofZones[0].spec.toData(), NON_DEFAULT_ROOF_SPEC);
  assert.equal(copy.roofZones[0].cells.length, 2);
  for (const cell of copy.roofZones[0].cells) {
    for (const id of cell.split(':')) {
      assert.ok(copy.shapeMap.has(id), `セルが指す線id ${id} が複製先に存在する`);
      assert.ok(![...graph.shapeMap.keys()].includes(id), '元の階の線idは使い回さない');
    }
  }
});
