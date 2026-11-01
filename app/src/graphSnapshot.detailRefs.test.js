// 建具 1 件の部分詳細図の上書き（Opening.detailRefs。FBS の OP.DETAIL_KEYS=28・DETAIL_VALS=29）の保存・復元のテスト。
// 上書きの無い建具は 2 フィールドとも書かない（未使用の文書のバイト列は不変）ことを vtable 直読みで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from 'flatbuffers';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from './core.js';
import { DetailSlot } from './core/constants.js';
import {
  serializeGraph, restoreGraph, decodeFloorSnapshot, encodeFloorSnapshot,
} from './graphSnapshot.js';

const GS_OPENINGS = 18; // schema/graphFbs.js GS.OPENINGS
const OP_DETAIL_KEYS = 28; // schema/graphFbs.js OP.DETAIL_KEYS
const OP_DETAIL_VALS = 29; // schema/graphFbs.js OP.DETAIL_VALS
const { JAMB, HEAD } = DetailSlot;

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
}

/** 水平壁 1 本と三方枠 2 件（id 固定）を持つ階。props[i] が i 番目の建具の追加 props。 */
function makeGraphWithFrames(props = [{}, {}]) {
  const graph = makeGraph();
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clEnd = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  const openings = props.map((p, i) => graph.addOpening(
    axisCL, 1, false, clStart, 800 + i * 1500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: 'WF', ...p }, `op${i}`,
  ));
  return { graph, openings };
}

/** i 番目の建具の FBS テーブルに fieldNo の枠が書かれているか（vtable の有無）。 */
function openingHasField(bytes, openingIdx, fieldNo) {
  const bb = new ByteBuffer(bytes);
  const root = bb.readInt32(bb.position()) + bb.position();
  const vecOff = root + bb.__offset(root, 4 + GS_OPENINGS * 2);
  const table = bb.__indirect(bb.__vector(vecOff) + openingIdx * 4);
  return bb.__offset(table, 4 + fieldNo * 2) !== 0;
}

function roundTrip(graph) {
  const restored = makeGraph();
  restoreGraph(restored, serializeGraph(graph));
  return restored;
}
const byId = (graph, id) => graph.openings.find(o => o.id === id);

test('FBS 往復: jamb だけ／jamb と head／全 slot の detailRefs が往復する。キーは昇順で決定的', () => {
  const all = {
    [DetailSlot.JAMB]: 'df-j', [DetailSlot.HEAD]: 'df-h', [DetailSlot.SILL]: 'df-s',
    [DetailSlot.SASH_SECTION]: 'df-ss', [DetailSlot.NAGESHI]: 'df-n', [DetailSlot.SHIKII]: 'df-k',
  };
  const { graph } = makeGraphWithFrames([{ detailRefs: { [JAMB]: 'df-j' } }, { detailRefs: { [JAMB]: 'df-j', [HEAD]: 'df-h' } }]);
  const restored = roundTrip(graph);
  assert.deepEqual(byId(restored, 'op0').detailRefs, { [JAMB]: 'df-j' });
  assert.deepEqual(byId(restored, 'op1').detailRefs, { [HEAD]: 'df-h', [JAMB]: 'df-j' });
  assert.deepEqual(Object.keys(byId(restored, 'op1').detailRefs), [HEAD, JAMB]);

  const { graph: g2 } = makeGraphWithFrames([{ detailRefs: all }]);
  assert.deepEqual({ ...byId(roundTrip(g2), 'op0').detailRefs }, all, 'sill・sashSection・nageshi・shikii もデータとして通る');
  // 挿入順が違っても書き出される並びは同じ（CL の id は乱数なのでバイト列全体ではなく建具の detailRefs の並びで見る）
  const { graph: g3 } = makeGraphWithFrames([{ detailRefs: { [HEAD]: 'df-h', [JAMB]: 'df-j' } }, {}]);
  const { graph: g4, openings: [o4] } = makeGraphWithFrames([{}, {}]);
  o4.detailRefs = { [JAMB]: 'df-j', [HEAD]: 'df-h' }; // 正規化を通らない直接代入（挿入順が jamb→head）
  const snap3 = decodeFloorSnapshot(serializeGraph(g3)).openings[0].detailRefs;
  const snap4 = decodeFloorSnapshot(serializeGraph(g4)).openings[0].detailRefs;
  assert.equal(JSON.stringify(snap3), JSON.stringify(snap4));
});

test('FBS 往復: 上書きの無い建具は detailRefs が null。空の写像・空文字だけの値も null に正規化されて書かれない', () => {
  const { graph, openings } = makeGraphWithFrames([{}, {}]);
  assert.equal(openings[0].detailRefs, null, '既定は null');
  openings[1].detailRefs = {}; // 正規化を通らない直接代入でも、書き出しは空として扱う
  const bytes = serializeGraph(graph);
  const restored = roundTrip(graph);
  assert.equal(byId(restored, 'op0').detailRefs, null);
  assert.equal(byId(restored, 'op1').detailRefs, null);
  assert.equal(openingHasField(bytes, 1, OP_DETAIL_KEYS), false, '空の写像は書かない');
  const { graph: g2, openings: [o] } = makeGraphWithFrames([{ detailRefs: { [JAMB]: '', [HEAD]: '' } }]);
  assert.equal(o.detailRefs, null, 'コンストラクタで正規化');
  assert.equal(byId(roundTrip(g2), 'op0').detailRefs, null);
});

test('上書きの無い文書のバイト列は不変: 2 フィールドが vtable に無く、キー無しの snapshot の encode と一致し、足して外せば元と一致する', () => {
  const { graph, openings } = makeGraphWithFrames([{}, {}]);
  const base = serializeGraph(graph);
  for (const i of [0, 1]) {
    assert.equal(openingHasField(base, i, OP_DETAIL_KEYS), false, `建具${i}: keys を書かない`);
    assert.equal(openingHasField(base, i, OP_DETAIL_VALS), false, `建具${i}: vals を書かない`);
  }
  const snap = decodeFloorSnapshot(base);
  assert.equal(snap.openings[0].detailRefs, null);
  for (const o of snap.openings) delete o.detailRefs;
  assert.deepEqual([...encodeFloorSnapshot(snap)], [...base], '旧形式（キー無し）と同じバイト列');

  openings[0].detailRefs = { [JAMB]: 'df-1' };
  const withRefs = serializeGraph(graph);
  assert.ok(withRefs.length > base.length);
  assert.equal(openingHasField(withRefs, 0, OP_DETAIL_KEYS), true, '前提: 値があれば書く（フィールド番号が合っている）');
  assert.equal(openingHasField(withRefs, 0, OP_DETAIL_VALS), true);
  assert.equal(openingHasField(withRefs, 1, OP_DETAIL_KEYS), false, '上書きの無い隣の建具は書かない');
  openings[0].detailRefs = null;
  assert.deepEqual([...serializeGraph(graph)], [...base], '外せばバイト列は元と一致');
});

test('plain 経路: decodeFloorSnapshot の detailRefs は JSON 往復でも復元できる。キー無しの旧データ（plain）は null', () => {
  const { graph } = makeGraphWithFrames([{ detailRefs: { [JAMB]: 'df-j', [HEAD]: 'df-h' } }, {}]);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  const restored = makeGraph();
  restoreGraph(restored, JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(byId(restored, 'op0').detailRefs, { [HEAD]: 'df-h', [JAMB]: 'df-j' });
  assert.equal(byId(restored, 'op1').detailRefs, null);

  const legacy = JSON.parse(JSON.stringify(snap));
  for (const o of legacy.openings) delete o.detailRefs;
  const restoredLegacy = makeGraph();
  restoreGraph(restoredLegacy, legacy);
  assert.equal(byId(restoredLegacy, 'op0').detailRefs, null, 'キー無しは null');
});

test('【失敗系】壊れた入力: 値が空の対・値が足りない対・文字列でない値は捨て、残りだけが読める。例外にしない', () => {
  const { graph } = makeGraphWithFrames([{ detailRefs: { [JAMB]: 'df-j', [HEAD]: 'df-h' } }, {}]);
  const snap = decodeFloorSnapshot(serializeGraph(graph));
  snap.openings[0].detailRefs = { [JAMB]: '', [HEAD]: 'df-h', sill: 7 };
  const back = decodeFloorSnapshot(encodeFloorSnapshot(snap));
  assert.deepEqual(back.openings[0].detailRefs, { [HEAD]: 'df-h' });
  snap.openings[0].detailRefs = { [JAMB]: null };
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).openings[0].detailRefs, null);
  snap.openings[0].detailRefs = 'df-j'; // 形が違う値
  assert.equal(decodeFloorSnapshot(encodeFloorSnapshot(snap)).openings[0].detailRefs, null);
});

test('graphSnapshot の採取・復元: detailRefs は他の項目と一緒に保たれ、復元した建具の他の項目は変わらない', () => {
  const { graph } = makeGraphWithFrames([{ detailRefs: { [JAMB]: 'df-j' }, frameFaceWidth: 25, frameProjection: 15, note: 'メモ' }, {}]);
  const restored = roundTrip(graph);
  const o = byId(restored, 'op0');
  assert.deepEqual(o.detailRefs, { [JAMB]: 'df-j' });
  assert.equal(o.frameFaceWidth, 25);
  assert.equal(o.frameProjection, 15);
  assert.equal(o.note, 'メモ');
  assert.ok(Object.isFrozen(o.detailRefs), '復元後も凍結した正規形');
});
