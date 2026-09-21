// wallGate.js のテスト（A-1: フットプリント境界での分割。中点判定の粒度依存の解消）。
// 既存の spanInBuilding／intersectionInBuilding は主に structuralAutoFill.test.js・woodAutoFill.test.js
// が手作りのモックゲート経由で間接的にカバーしているため、本ファイルは実 core.js（Plane/PlanGraph/Room）
// を使い、buildSelfFootprintGate が組み立てる「本物のゲート」と footprintBreakCLs／spanPointInBuilding を
// 直接検証する（wallBeamAxes.test.js と同じ「実挙動を再現できないダックタイピングは使わない」方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature } from '../core.js';
import {
  buildSelfFootprintGate, buildExteriorSide, buildStructuralWallGate, footprintBreakCLs, createFootprintCache,
} from './wallGate.js';
import { worldToCell } from '../finish/gridCells.js';

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

// 2部屋（ともにINTERIOR）をY方向に積んだグラフ。X:0..2000固定、Y:-1000..1000(room A)・1000..4000(room B)。
// 境界Y=1000は「divider CLの候補ではあるが、両側とも建物内で帰属が変わらない」ケースを作るために置く
// （footprintBreakCLsが候補全部を返すのではなく実際に帰属が変わる境界だけを選別することの検証に使う）。
function makeTwoRoomGraph() {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), 'A');
  graph.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y1.id}`]), 'B');
  return { graph, x0, x1, y0, yMid, y1 };
}

test('footprintBreakCLs: 建物外→建物内へ帰属が変わる境界のCLだけを返す（両側とも建物内の候補は含めない）', () => {
  const { graph, x0, y0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.ok(gate, '前提: 部屋があるためゲートが構築される');
  // 軸 X=0（垂直）に沿って Y:-5000..2000 の区間。区間内の候補はY=-1000(外→内)・Y=1000(内→内)の2本
  // （Y=4000は区間の端hiより外なので候補に含まれない＝dividerCLsBetweenの開区間仕様）。
  const breaks = footprintBreakCLs(gate, graph, x0, true, -5000, 2000);
  assert.equal(breaks.length, 1, 'Y=1000（両側とも建物内）は帰属が変わらないため含めない');
  assert.equal(breaks[0], y0, 'Y=-1000（外→内の境界）だけを返す');
});

test('footprintBreakCLs: gate=nullは常に空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  // 【QA指摘2026-09-19】entityの配列を deepEqual(..., []) で比較すると、失敗時にnode:assertがCL実体
  // （graph・他CLへの参照を持つMobXグラフ）を丸ごと差分表示しようとしヒープを圧迫する——.lengthで比較する。
  assert.equal(footprintBreakCLs(null, graph, x0, true, -5000, 2000).length, 0);
});

test('【失敗系】footprintBreakCLs: 区間が完全に建物内（room A内部のみ）なら候補CLが無く空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.equal(footprintBreakCLs(gate, graph, x0, true, -1000, 1000).length, 0);
});

test('【失敗系】footprintBreakCLs: 区間が完全に建物外なら候補CLが無く空配列', () => {
  const { graph, x0 } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  assert.equal(footprintBreakCLs(gate, graph, x0, true, -9000, -6000).length, 0);
});

test('spanInBuilding は spanPointInBuilding（区間中点）へ委譲する（判定式の二重化なし）', () => {
  const { graph, x0, y0, yMid } = makeTwoRoomGraph();
  const gate = buildSelfFootprintGate(graph);
  const mid = (y0.value + yMid.value) / 2;
  assert.equal(gate.spanInBuilding(x0, true, y0, yMid), gate.spanPointInBuilding(x0, true, mid));
  assert.equal(gate.spanPointInBuilding(x0, true, mid), true, '前提: room A内部の中点は建物内');
});

// ================================================================
// ステップA: createFootprintCache（1回の再計算内でのフットプリント索引memo）
// ================================================================

// 単一のINTERIOR部屋（矩形0..2000×0..2000）のみのグラフ。
function makeRectRoomGraph() {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  return { graph, x0, x1, y0, y1 };
}

// L字footprint: 3x3グリッド（gridCells.test.js makeGraphと同一構成。中央の縦CLを上段だけに短縮してL字結合
// を作る）に、上段左セル＋中段全幅＋下段全幅をINTERIOR部屋として指定する——上段右セル(1000..2000,0..1000)
// だけが建物外の「ノッチ」になる。
function makeLShapeFootprintGraph() {
  const graph = makeGraph();
  const vs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  const hs = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, {
    labeled: i === 0 || i === 3, discipline: i === 0 || i === 3 ? Discipline.STRUCT : Discipline.ARCH,
  }));
  vs[1].setProps({ _extentLo: 0, _extentHi: 1000 }); // 上段だけを分割する短縮CL（L字結合を作る）
  const keyAt = (x, y) => worldToCell(x, y, graph).key;
  const cells = new Set([
    keyAt(500, 500),   // 上段左（0..1000, 0..1000）
    keyAt(500, 1500),  // 中段（0..2000, 1000..2000。結合済み）
    keyAt(500, 2500),  // 下段（0..2000, 2000..3000。結合済み）
  ]);
  graph.addRoom(cells, 'L');
  return { graph, vs, hs, notch: { x: 1500, y: 500 } };
}

// 屋外部屋(kind:EXTERIOR)のみのグラフ——establishesFootprintの権威にならず、probeも常にfalse。
function makeExteriorOnlyGraph() {
  const { graph, x0, x1, y0, y1 } = makeRectRoomGraph();
  const [room] = graph.rooms;
  room.setKind(RoomKind.EXTERIOR);
  return { graph, x0, x1, y0, y1 };
}

// 階段(feature:STAIR)のみのグラフ——kindはINTERIORのままなのでprobeはtrueを返すが、
// establishesFootprintの権威にはならずsize===0（フットプリント未定義扱い）。
function makeStairOnlyGraph() {
  const { graph, x0, x1, y0, y1 } = makeRectRoomGraph();
  const [room] = graph.rooms;
  room.setFeature(RoomFeature.STAIR);
  return { graph, x0, x1, y0, y1 };
}

// cache有無でprobe結果・sizeが一致することを、グラフ種別ごとにサンプル点で確かめる共通アサーション。
function assertCacheParity(graph, points) {
  const cache = createFootprintCache();
  const withCacheGate = buildSelfFootprintGate(graph, cache);
  const withoutCacheGate = buildSelfFootprintGate(graph);
  // buildSelfFootprintGateはsize===0でnullを返す——両者のnull/非nullが揃うことも確認する。
  assert.equal(withCacheGate === null, withoutCacheGate === null, 'cache有無でsize===0の判定が食い違わない');
  if (!withCacheGate) return;
  for (const [x, y] of points) {
    // spanPointInBuildingはaxisCL.valueまわりの±EPSしか見ないため、probe自体は非公開——
    // buildExteriorSide経由のoutsideSignで間接的にprobeの点判定を比較する（同一のfootprintProbeを使う）。
    const exWith = buildExteriorSide(graph, cache);
    const exWithout = buildExteriorSide(graph);
    assert.equal(
      exWith.outsideSign(x, true, y), exWithout.outsideSign(x, true, y),
      `outsideSign(${x},true,${y}) がcache有無で食い違う`,
    );
  }
}

test('createFootprintCache: cache有無でprobeの結果が同じ（矩形の部屋・L字・屋外部屋・階段のみの階=size0）', () => {
  assertCacheParity(makeRectRoomGraph().graph, [[0, 1000], [2000, 1000], [1000, 0], [1000, 2000]]);
  const { graph: lGraph, notch } = makeLShapeFootprintGraph();
  assertCacheParity(lGraph, [[0, 500], [2000, 1500], [notch.x, notch.y]]);
  assertCacheParity(makeExteriorOnlyGraph().graph, [[0, 1000], [2000, 1000]]);
  assertCacheParity(makeStairOnlyGraph().graph, [[0, 1000], [2000, 1000]]);
});

test('createFootprintCache: 格子外の点はcache有無どちらもfalse（size===0の階と同じ「フットプリント未定義」側ではなく、格子内だが建物外というケース）', () => {
  const { graph } = makeRectRoomGraph();
  const cache = createFootprintCache();
  const exWith = buildExteriorSide(graph, cache);
  const exWithout = buildExteriorSide(graph);
  // 格子外(x=9000)はどちらもoutsideSign=0（両側とも建物外＝符号なし）になるはず。
  assert.equal(exWith.outsideSign(9000, true, 1000), exWithout.outsideSign(9000, true, 1000));
});

// room B（x:2000..4000, y:0..2000）の内部代表点。x1境界(=2000)ちょうどだと±EPSの片側がroom A自体に
// 掛かり「room Bを追加する前から真」になってしまうため、room Bの内部（x=3000）を独立した軸オブジェクト
// （spanPointInBuildingはaxisCL.valueしか読まないため、実CLでなくてよい）で見る。
const ROOM_B_AXIS = { value: 3000 };

test('createFootprintCache: 同じcacheで同じgraphを2回引くと索引は組み直さない（1回目の後に部屋を変えても2回目は同じ結果のまま）', () => {
  const { graph, x0, x1, y0, y1 } = makeRectRoomGraph();
  const cache = createFootprintCache();
  const first = buildSelfFootprintGate(graph, cache);
  assert.equal(first.spanPointInBuilding(x0, true, 1000), true, '前提: room A内部は建物内');
  assert.equal(first.spanPointInBuilding(ROOM_B_AXIS, true, 1000), false, '前提: room B相当の位置はまだ建物外');

  // memo済みの後に部屋を追加——2回目がこれを拾えば「索引を組み直していない」ことにならない。
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');

  const second = buildSelfFootprintGate(graph, cache);
  assert.equal(second.spanPointInBuilding(ROOM_B_AXIS, true, 1000), false,
    '2回目はmemoされた1回目の索引のまま（新設のroom Bを拾わない＝索引を組み直していない）');
});

test('【失敗系】createFootprintCache: 部屋を変えた後、新しいcache（＝次の再計算）では新しい結果になる。cache省略時は常に最新', () => {
  const { graph, x1, y0, y1 } = makeRectRoomGraph();
  const cache1 = createFootprintCache();
  const gate1 = buildSelfFootprintGate(graph, cache1);
  assert.equal(gate1.spanPointInBuilding(ROOM_B_AXIS, true, 1000), false, '前提: room B相当の位置はまだ建物外');

  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');

  // 新しい再計算=新しいcacheインスタンス。古いcache1を使い回さない。
  const cache2 = createFootprintCache();
  const gate2 = buildSelfFootprintGate(graph, cache2);
  assert.equal(gate2.spanPointInBuilding(ROOM_B_AXIS, true, 1000), true, '新しいcacheは古いcache1の値を引き継がず最新を見る');

  // cache省略時は今までどおり呼ぶたびに最新を見る。
  const gateNoCache = buildSelfFootprintGate(graph);
  assert.equal(gateNoCache.spanPointInBuilding(ROOM_B_AXIS, true, 1000), true, 'cache省略時は常に最新のフットプリントを見る');
});

test('createFootprintCache: graphごとに別キー——別graphの索引が混ざらない（自階と下階を同じcacheで引く主経路の前提）', () => {
  // aとbは意図的に部屋の位置を変える（同一形状だと索引を取り違えても結果が偶然一致してしまうため）。
  // a: room 0..2000×0..2000（前出のmakeRectRoomGraph）。b: room 0..2000×5000..7000（yだけ平行移動）。
  const a = makeRectRoomGraph();
  const b = makeGraph();
  const bx0 = b.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const bx1 = b.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT });
  const by0 = b.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const by1 = b.addCenterLine(CenterLineType.HORIZONTAL, 7000, { labeled: true, discipline: Discipline.STRUCT });
  b.addRoom(new Set([`${bx0.id}:${by0.id}:${bx1.id}:${by1.id}`]), 'B');

  const cache = createFootprintCache();
  const gateA = buildSelfFootprintGate(a.graph, cache);
  const gateB = buildSelfFootprintGate(b, cache);
  assert.equal(gateA.spanPointInBuilding(a.x0, true, 1000), true, 'graphAは自分の部屋(y:0..2000)を見る');
  assert.equal(gateB.spanPointInBuilding(bx0, true, 1000), false,
    'graphBの部屋はy:5000..7000——graphAのy:1000は建物外。graphAのmemoが混ざればtrueになってしまう');
  assert.equal(gateB.spanPointInBuilding(bx0, true, 6000), true, 'graphB自身の部屋の内部(y:6000)は建物内');
});

test('createFootprintCache: 点判定のmemoキーはwx・wyの両方——同じwx・異なるwyで異なる結果になる（L字ノッチの境界）', () => {
  const { graph } = makeLShapeFootprintGraph();
  const cache = createFootprintCache();
  const gate = buildSelfFootprintGate(graph, cache);
  // 軸x=1500（ノッチの内側）で、y=500（ノッチ内＝建物外）とy=1500（結合済み中段＝建物内）を順に見る。
  // isVertical=trueなのでprobeのwxはどちらも1500±EPSで同一——wyだけが異なる。
  const axis1500 = { value: 1500 };
  assert.equal(gate.spanPointInBuilding(axis1500, true, 500), false, '前提: ノッチ内(y=500)は建物外');
  assert.equal(gate.spanPointInBuilding(axis1500, true, 1500), true,
    '同じwx(=1500±EPS)でも異なるwy(=1500)なら建物内——memoキーがwyを区別できていないと1つ目の結果(false)を誤って返す');
});

test('buildStructuralWallGate: cache指定時も省略時と同じ判定になる（基準階＋直下階のAND）', async () => {
  const below = makeRectRoomGraph();
  const above = makeRectRoomGraph();
  const project = { planes: [below.graph.plane, above.graph.plane] };
  const cache = createFootprintCache();
  const withCache = await buildStructuralWallGate(above.graph.plane, project, above.graph, cache);
  const withoutCache = await buildStructuralWallGate(above.graph.plane, project, above.graph);
  assert.equal(withCache.spanPointInBuilding(above.x0, true, 1000), true);
  assert.equal(withCache.spanPointInBuilding(above.x0, true, 1000), withoutCache.spanPointInBuilding(above.x0, true, 1000));
});
