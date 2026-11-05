// 姿図の配置（PlanGraph.placedFigures）の保存・復元のテスト。FBS（GS.PLACED_FIGURES=57）・graphSnapshot。
// 配置が無い文書のバイト列を変えない（vector を書かない）ことを固定する。graphSnapshot.roofZones.test.js と同型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import { Plane, PlanGraph, PlacedFigure, PLACED_FIGURE_KEYS } from './core.js';
import { serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot } from './graphSnapshot.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

/** ルートテーブルの vtable 長（バイト）。末尾の未使用フィールドは vtable で切り詰められる。 */
function rootVtableLength(bytes) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vt = root - bb.readInt32(root);
  return bb.readInt16(vt);
}
const PLACED_FIGURES_FIELD_INDEX = 57; // schema/graphFbs.js GS.PLACED_FIGURES

const A = { id: 'pf-a', figureKey: 'df-a', x: 300, y: 100, rotationDeg: 90, mirror: false, zMm: 0, note: '' };
const B = { id: 'pf-b', figureKey: 'df-b', x: 1820, y: -455, rotationDeg: 270, mirror: true, zMm: 850, note: '洗面台' };

test('FBS 往復: (300,100) 回転 90 と (1820,-455) 回転 270 鏡像 note 付き zMm 850 の2件が全項目ごと往復する', () => {
  const graph = makeGraph();
  graph.setPlacedFigures([new PlacedFigure(A), new PlacedFigure(B)]);
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  assert.equal(restored.placedFigures.length, 2);
  assert.ok(Object.isFrozen(restored.placedFigures));
  assert.ok(restored.placedFigures.every(p => p instanceof PlacedFigure));
  assert.deepEqual(restored.placedFigures.map(p => p.toData()), [A, B]);
});

test('plain 経路: decodeFloorSnapshot のキー集合は PLACED_FIGURE_KEYS。JSON 往復でも復元できる', () => {
  const graph = makeGraph();
  graph.setPlacedFigures([new PlacedFigure(B)]);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  assert.deepEqual(Object.keys(snap.placedFigures[0]).sort(), [...PLACED_FIGURE_KEYS].sort());
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(restored.placedFigures.map(p => p.toData()), [B]);
});

test('配置が無い文書のバイト列は不変: キー無し／空配列の snapshot は同じバイト列で、ルートの vtable に PLACED_FIGURES の枠が無い', () => {
  const graph = makeGraph();
  const bytes = serializeGraph(graph);
  const snap = decodeFloorSnapshot(bytes);
  assert.deepEqual(snap.placedFigures, []);
  const noKey = { ...snap };
  delete noKey.placedFigures;
  assert.deepEqual([...encodeFloorSnapshot(noKey)], [...bytes], 'placedFigures キー無しでも同じバイト列');
  assert.ok(rootVtableLength(bytes) <= 4 + 2 * PLACED_FIGURES_FIELD_INDEX, '配置なしは末尾フィールドが vtable で切り詰められる');

  graph.setPlacedFigures([new PlacedFigure(A)]);
  const withPf = serializeGraph(graph);
  assert.ok(withPf.length > bytes.length);
  assert.equal(rootVtableLength(withPf), 4 + 2 * (PLACED_FIGURES_FIELD_INDEX + 1), '配置ありは vtable に PLACED_FIGURES の枠が出る');
});

test('配置を足して消すと、バイト列は元と一致する（1バイトも変わらない）', () => {
  const graph = makeGraph();
  const base = serializeGraph(graph);
  graph.setPlacedFigures([new PlacedFigure(A)]);
  graph.setPlacedFigures([]);
  assert.deepEqual([...serializeGraph(graph)], [...base]);
});

test('【失敗系】旧データ（placedFigures キーが無い snapshot）は配置なしに復元され、直前の配置は消える（clear で初期化）', () => {
  const graph = makeGraph();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  delete snap.placedFigures;
  graph.setPlacedFigures([new PlacedFigure(A)]);
  restoreGraph(graph, snap);
  assert.deepEqual(graph.placedFigures, []);
  assert.ok(Object.isFrozen(graph.placedFigures));
});

test('【失敗系】壊れた配置（回転 45・NaN 座標・id 無し・figureKey 無し・重複 id）は復元で捨てられ、重複は先勝ち', () => {
  const graph = makeGraph();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  snap.placedFigures = [
    { ...A, id: 'bad-rot', rotationDeg: 45 },
    { ...A, id: 'bad-x', x: NaN },
    { ...A, id: '' },
    { ...A, id: 'bad-key', figureKey: '' },
    { ...A, id: 'dup', x: 1 },
    { ...B, id: 'dup', x: 2 },
    { ...B, id: 'ok', rotationDeg: -90 },
  ];
  const restored = makeGraph();
  restoreGraph(restored, snap);
  assert.deepEqual(restored.placedFigures.map(p => [p.id, p.x, p.rotationDeg]), [['dup', 1, 90], ['ok', 1820, 270]]);
});

test('【失敗系】FBS 経由でも不正値は復元側で正規化される（バイト列に回転 45・NaN を書いても配置は捨てられる）', () => {
  const graph = makeGraph();
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const bytes = encodeFloorSnapshot({
    ...snap,
    placedFigures: [{ ...A, id: 'r45', rotationDeg: 45 }, { ...A, id: 'nan', y: NaN }, { ...B, id: 'ok' }],
  });
  const restored = makeGraph();
  restoreGraph(restored, bytes);
  assert.deepEqual(restored.placedFigures.map(p => p.toData()), [{ ...B, id: 'ok' }]);
});
