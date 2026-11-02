// 腰壁・垂れ壁の記録の部分詳細図の割当て（rec.detailRefs の kneeTop・dropBottom）と表の側（rec.frontSide）
// （FBS の KDW.DETAIL_KEYS=5・DETAIL_VALS=6・FRONT_SIDE=7。部分詳細図 S8b-1）の保存・復元のテスト。
// 割当ても表の側の変更も無い記録は 3 フィールドとも書かない（未使用の文書のバイト列は不変）ことを vtable 直読みで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import { Plane, PlanGraph, edgeKey } from './core.js';
import { DetailSlot, KneeDropFrontSide } from './core/constants.js';
import {
  serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot,
} from './graphSnapshot.js';
import { normalizeKneeDropRecord, kneeDropFrontSideOf } from './core/kneeDropRecord.js';

const GS_KNEE_DROP_WALLS = 43; // schema/graphFbs.js GS.KNEE_DROP_WALLS
const KDW_DETAIL_KEYS = 5;
const KDW_DETAIL_VALS = 6;
const KDW_FRONT_SIDE = 7;
const { KNEE_TOP, DROP_BOTTOM } = DetailSlot;

const KEY_A = 'ax:s0:e0';
const KEY_B = 'ax:s1:e1';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

function makeGraphWithRecords() {
  const graph = makeGraph();
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null });
  graph.setKneeDropWall(KEY_B, { knee: { topHeight: 700 }, drop: { bottomHeight: 400 } });
  return graph;
}

/** i 番目の記録の FBS テーブルに fieldNo の枠が書かれているか（vtable の有無）。 */
function recordHasField(bytes, idx, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vecOff = root + bb.__offset(root, 4 + GS_KNEE_DROP_WALLS * 2);
  const table = bb.__indirect(bb.__vector(vecOff) + idx * 4);
  return bb.__offset(table, 4 + fieldNo * 2) !== 0;
}

function roundTrip(graph) {
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  return restored;
}

test('正規化: kneeTop は腰壁が無ければ・dropBottom は垂れ壁が無ければ落ちる。他の slot は捨て、空ならキーを持たない。既定の表の側もキーを持たない', () => {
  const a = normalizeKneeDropRecord({ knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k', [DROP_BOTTOM]: 'df-d', floorWall: 'df-x' } });
  assert.deepEqual(a.detailRefs, { [KNEE_TOP]: 'df-k' }, '垂れ壁の無い記録の dropBottom・対象外の slot は落ちる');
  const b = normalizeKneeDropRecord({ knee: null, drop: { bottomHeight: 400 }, detailRefs: { [KNEE_TOP]: 'df-k' } });
  assert.equal(Object.hasOwn(b, 'detailRefs'), false, '腰壁を外せば kneeTop が落ち、空なら detailRefs のキー自体を持たない');
  const c = normalizeKneeDropRecord({ knee: { topHeight: 800 }, drop: null, frontSide: KneeDropFrontSide.ROOM_NEG });
  assert.equal(Object.hasOwn(c, 'frontSide'), false, '既定（roomNeg）ならキーを持たない');
  const d = normalizeKneeDropRecord({ knee: { topHeight: 800 }, drop: null, frontSide: KneeDropFrontSide.ROOM_POS });
  assert.equal(d.frontSide, KneeDropFrontSide.ROOM_POS);
  assert.equal(kneeDropFrontSideOf({ frontSide: 'zzz' }), KneeDropFrontSide.ROOM_NEG, '【失敗系】未知の値は既定');
  assert.equal(kneeDropFrontSideOf(null), KneeDropFrontSide.ROOM_NEG);
  const e = normalizeKneeDropRecord({ knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: '' } });
  assert.equal(Object.hasOwn(e, 'detailRefs'), false, '【失敗系】空文字だけの割当ては捨てる');
  const src = { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' } };
  normalizeKneeDropRecord(src);
  assert.deepEqual(src.detailRefs, { [KNEE_TOP]: 'df-k' }, '元は変えない');
});

test('setKneeDropWall は記録を正規化して保存する（既存形 {knee, drop} は無変更）', () => {
  const graph = makeGraph();
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual(graph.kneeDropWalls.get(KEY_A), { knee: { topHeight: 800 }, drop: null }, '既存形は余計なキーを足さない');
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' }, frontSide: KneeDropFrontSide.ROOM_POS });
  const rec = graph.kneeDropWalls.get(KEY_A);
  assert.deepEqual(rec.detailRefs, { [KNEE_TOP]: 'df-k' });
  assert.equal(rec.frontSide, KneeDropFrontSide.ROOM_POS);
  // 保存用の snapshot の detailRefs は凍結した正規形（graph.kneeDropWalls は deep observable なので記録自体の凍結は見ない）
  assert.ok(Object.isFrozen(decodeFloorSnapshot(serializeGraph(graph)).kneeDropWalls[0].detailRefs));
});

test('FBS 往復: kneeTop・dropBottom の割当てと表の側が往復する。キーは slot 名の昇順で決定的', () => {
  const graph = makeGraphWithRecords();
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' } });
  graph.setKneeDropWall(KEY_B, {
    knee: { topHeight: 700 }, drop: { bottomHeight: 400 },
    detailRefs: { [KNEE_TOP]: 'df-k', [DROP_BOTTOM]: 'df-d' }, frontSide: KneeDropFrontSide.ROOM_POS,
  });
  const restored = roundTrip(graph);
  const a = restored.kneeDropWalls.get(KEY_A);
  const b = restored.kneeDropWalls.get(KEY_B);
  assert.deepEqual(a, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' } });
  assert.equal(Object.hasOwn(a, 'frontSide'), false, '既定の表の側は戻っても既定（キー無し）');
  assert.deepEqual(b.detailRefs, { [KNEE_TOP]: 'df-k', [DROP_BOTTOM]: 'df-d' });
  assert.deepEqual(Object.keys(b.detailRefs), [DROP_BOTTOM, KNEE_TOP], '昇順（dropBottom < kneeTop）');
  assert.equal(b.frontSide, KneeDropFrontSide.ROOM_POS);
});

test('割当ても表の側の変更も無い記録のバイト列は不変: 3 フィールドが vtable に無く、キー無しの snapshot の encode と一致し、足して外せば元と一致する', () => {
  const graph = makeGraphWithRecords();
  const base = serializeGraph(graph);
  for (const i of [0, 1]) {
    for (const f of [KDW_DETAIL_KEYS, KDW_DETAIL_VALS, KDW_FRONT_SIDE]) {
      assert.equal(recordHasField(base, i, f), false, `記録${i}: フィールド${f}を書かない`);
    }
  }
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.kneeDropWalls[0].detailRefs, null);
  for (const r of snap.kneeDropWalls) { delete r.detailRefs; delete r.frontSide; }
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base], '旧形式（キー無し）と同じバイト列');

  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' } });
  const withRefs = serializeGraph(graph);
  assert.ok(withRefs.length > base.length);
  assert.equal(recordHasField(withRefs, 0, KDW_DETAIL_KEYS), true, '前提: 値があれば書く（フィールド番号が合っている）');
  assert.equal(recordHasField(withRefs, 0, KDW_DETAIL_VALS), true);
  assert.equal(recordHasField(withRefs, 0, KDW_FRONT_SIDE), false, '表の側が既定なら書かない');
  assert.equal(recordHasField(withRefs, 1, KDW_DETAIL_KEYS), false, '割当ての無い隣の記録は書かない');
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null, frontSide: KneeDropFrontSide.ROOM_POS });
  assert.equal(recordHasField(serializeGraph(graph), 0, KDW_FRONT_SIDE), true, '既定でない表の側は書く');
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual([...serializeGraph(graph)], [...base], '外せばバイト列は元と一致');
});

test('plain 経路: buildSnapshot の detailRefs・frontSide は JSON 往復でも復元できる。キー無しの旧データは null・既定', () => {
  const graph = makeGraphWithRecords();
  graph.setKneeDropWall(KEY_B, {
    knee: { topHeight: 700 }, drop: { bottomHeight: 400 }, detailRefs: { [DROP_BOTTOM]: 'df-d' }, frontSide: KneeDropFrontSide.ROOM_POS,
  });
  const snap = JSON.parse(JSON.stringify(decodeFloorSnapshot(serializeGraph(graph))));
  const restored = makeGraph();
  restoreGraph(restored, snap);
  assert.deepEqual(restored.kneeDropWalls.get(KEY_B).detailRefs, { [DROP_BOTTOM]: 'df-d' });
  assert.equal(restored.kneeDropWalls.get(KEY_B).frontSide, KneeDropFrontSide.ROOM_POS);

  const legacy = JSON.parse(JSON.stringify(snap));
  for (const r of legacy.kneeDropWalls) { delete r.detailRefs; delete r.frontSide; }
  const restoredLegacy = makeGraph();
  restoreGraph(restoredLegacy, legacy);
  assert.deepEqual(restoredLegacy.kneeDropWalls.get(KEY_B), { knee: { topHeight: 700 }, drop: { bottomHeight: 400 } }, 'キー無しは割当て無し・既定');
});

test('【失敗系】壊れた入力: 値が空の対・文字列でない値・形が違う値は捨て、残りだけが読める。例外にしない', () => {
  const graph = makeGraphWithRecords();
  graph.setKneeDropWall(KEY_B, { knee: { topHeight: 700 }, drop: { bottomHeight: 400 }, detailRefs: { [KNEE_TOP]: 'df-k', [DROP_BOTTOM]: 'df-d' } });
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const idx = snap.kneeDropWalls.findIndex(r => r.key === KEY_B);
  snap.kneeDropWalls[idx].detailRefs = { [KNEE_TOP]: '', [DROP_BOTTOM]: 'df-d', sill: 7 };
  assert.deepEqual(decodeFloorSnapshot(encodeFloorSnapshot(snap)).kneeDropWalls[idx].detailRefs, { [DROP_BOTTOM]: 'df-d' });
  snap.kneeDropWalls[idx].detailRefs = 'df-d';
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).kneeDropWalls[idx].detailRefs, null);
  snap.kneeDropWalls[idx].frontSide = 'zzz';
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).kneeDropWalls[idx].frontSide, KneeDropFrontSide.ROOM_NEG, '未知の表の側は既定');
});

test('腰壁・垂れ壁の undo 用 before/after（記録丸ごと）: setKneeDropWall に戻した記録の detailRefs・frontSide が保たれる', () => {
  const graph = makeGraph();
  const before = { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' }, frontSide: KneeDropFrontSide.ROOM_POS };
  graph.setKneeDropWall(KEY_A, before);
  const beforeRec = graph.kneeDropWalls.get(KEY_A);
  graph.setKneeDropWall(KEY_A, { knee: { topHeight: 900 }, drop: null }); // ダイアログの確定で割当てを外した
  graph.setKneeDropWall(KEY_A, beforeRec); // undo（App.jsx handleKneeDropWallConfirm）
  assert.deepEqual(graph.kneeDropWalls.get(KEY_A), before);
});

test('edgeKey で作った実キーの記録も往復する（key 文字列は壊れない）', () => {
  const graph = makeGraph();
  const key = edgeKey('ax1', 'c1', 'c2');
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: null, detailRefs: { [KNEE_TOP]: 'df-k' } });
  assert.deepEqual(roundTrip(graph).kneeDropWalls.get(key).detailRefs, { [KNEE_TOP]: 'df-k' });
});
