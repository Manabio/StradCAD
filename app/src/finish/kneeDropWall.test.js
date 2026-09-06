// effectiveCeilingHeight / validateKneeDropWall の回帰テスト（QA F5）。
// roomMetrics.roomCeilingHeight への差し替え（finish/roomMetrics.js）で挙動が変わった
// （旧: 非数値CHはNaN/文字列のままMath.minに渡り不定挙動 → 新: graph.defaultCeilingHeightへ
// フォールバック）ため、新セマンティクスをテストで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { effectiveCeilingHeight, validateKneeDropWall, ERR_CEILING_HEIGHT_UNRESOLVED, kneeDropRecordsOnAxis, resolveKneeDropOverlays, kneeDropRecordForWallSpan, kneeDropRecordsAtPointOnWall, planWallHeight, wallsMeetAtPlanCut, PLAN_CUT_HEIGHT, resolveCapJoins } from './kneeDropWall.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function addCL(graph, type, value) {
  return graph.addCenterLine(type, value, { labeled: false, discipline: Discipline.ARCH });
}

// 上室(0,0)-(4000,2000)・下室(0,2000)-(4000,5000)がy=2000のCLを共有する2部屋を作る。
function makeSharedEdgeRooms(graph) {
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);

  const upperKey = `${x0.id}:${y0.id}:${x1.id}:${yMid.id}`;
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const upperRoom = graph.addRoom(new Set([upperKey]), '上室');
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, upperRoom);
  generateRoomWallsFromOutline(graph, lowerRoom);

  const key = edgeKey(yMid.id, x0.id, x1.id);
  return { upperRoom, lowerRoom, key };
}

// ---- (a) 両側数値: 低い方を返す ----
test('effectiveCeilingHeight: 両側とも数値のceilingHeightなら低い方を返す', () => {
  const graph = makeGraph();
  const { upperRoom, lowerRoom, key } = makeSharedEdgeRooms(graph);
  upperRoom.setOverride('ceilingHeight', '2400');
  lowerRoom.setOverride('ceilingHeight', '2600');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2400);
});

// ---- (b) 片側レンジ表記: defaultCeilingHeightへフォールバックしてから低い方を取る ----
test('effectiveCeilingHeight: 片側がレンジ表記「2300〜3500」ならdefaultCeilingHeightへフォールバックする', () => {
  const graph = makeGraph();
  graph.setDefaultCeilingHeight(2400);
  const { upperRoom, lowerRoom, key } = makeSharedEdgeRooms(graph);
  upperRoom.setOverride('ceilingHeight', '2300〜3500'); // 数値化できない → fallback 2400
  lowerRoom.setOverride('ceilingHeight', '2600');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2400);
});

// ---- (c) 失敗系: edgeGeometry解決不能（部屋なし）→ null → ERR_CEILING_HEIGHT_UNRESOLVED ----
test('【失敗系】effectiveCeilingHeight: edgeGeometryが解決できない（存在しないCL参照）ならnull', () => {
  const graph = makeGraph();
  const badKey = edgeKey('no-such-cl', 'no-such-start', 'no-such-end');
  const cellToRoom = buildCellToRoom(graph);

  assert.equal(edgeGeometry(badKey, graph, cellToRoom), null, '前提: 解決不能なedgeはnullを返す');
  assert.equal(effectiveCeilingHeight(graph, badKey, cellToRoom), null);
});

test('【失敗系】validateKneeDropWall: ceilingHeight=nullはERR_CEILING_HEIGHT_UNRESOLVEDを返す', () => {
  const result = validateKneeDropWall(600, 400, null);
  assert.deepEqual(result, { valid: false, error: ERR_CEILING_HEIGHT_UNRESOLVED });
});

// ---- 失敗系: 部屋が片側にしか無い（もう片側は無名屋外）場合も、有る側だけで解決する ----
test('【失敗系】effectiveCeilingHeight: 片側が無名屋外（部屋なし）でも、部屋がある側だけで解決する', () => {
  const graph = makeGraph();
  // 下室だけを作る（上側は無指定＝無名屋外）
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const yMid = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  const y2 = addCL(graph, CenterLineType.HORIZONTAL, 5000);
  const lowerKey = `${x0.id}:${yMid.id}:${x1.id}:${y2.id}`;
  const lowerRoom = graph.addRoom(new Set([lowerKey]), '下室');
  generateRoomWallsFromOutline(graph, lowerRoom);
  lowerRoom.setOverride('ceilingHeight', '2600');

  const key = edgeKey(yMid.id, x0.id, x1.id);
  const cellToRoom = buildCellToRoom(graph);
  assert.equal(effectiveCeilingHeight(graph, key, cellToRoom), 2600);
});

// ==== kneeDropRecordsOnAxis（key解読の共通化・軸は通りで照合） ====

test('kneeDropRecordsOnAxis: 同じ通り（向き＋座標）でスパンが重なるレコードを{key,rec,lo,hi}で返す', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  const rec = { knee: { topHeight: 900 } };
  graph.setKneeDropWall(key, rec);

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  const found = kneeDropRecordsOnAxis(graph, axisCL, 0, 4000);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, key);
  assert.deepEqual(found[0].rec, rec);
  assert.equal(found[0].lo, 0);
  assert.equal(found[0].hi, 4000);
});

// ---- 失敗系: axisCLIdが一致してもスパンが重ならなければ含めない ----
test('【失敗系】kneeDropRecordsOnAxis: スパンが重ならなければ含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  // レコードのスパンは[0,4000]。問い合わせスパン[5000,6000]は重ならない。
  assert.equal(kneeDropRecordsOnAxis(graph, axisCL, 5000, 6000).length, 0);
});

// ---- 失敗系: 別の通り（座標違い・向き違い）は含めない ----
test('【失敗系】kneeDropRecordsOnAxis: 座標の違う通りのCLでは含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  const other = addCL(graph, CenterLineType.HORIZONTAL, 3000); // 記録は y=2000
  assert.equal(kneeDropRecordsOnAxis(graph, other, 0, 4000).length, 0);
});

test('【失敗系】kneeDropRecordsOnAxis: 座標が同じでも向きが違うCLでは含めない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  const vertical = addCL(graph, CenterLineType.VERTICAL, 2000); // 記録は HORIZONTAL の y=2000
  assert.equal(kneeDropRecordsOnAxis(graph, vertical, 0, 4000).length, 0);
});

// ---- 実機2026-08「21」: 同じ通りにCLが2本ある図面でも取りこぼさない ----
test('【実機指摘】kneeDropRecordsOnAxis: 同じ通りの別CL（同座標・同向き）でも該当する', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  // 記録は y=2000 のCL。面や壁が持つのが「同じ y=2000 の別CL」でも同じ通りなので該当する。
  const twin = addCL(graph, CenterLineType.HORIZONTAL, 2000);
  assert.notEqual(twin.id, key.split(':')[0], '別のCLであること（前提の確認）');
  assert.equal(kneeDropRecordsOnAxis(graph, twin, 0, 4000).length, 1,
    'id違いでも同じ通りなら該当するはず（id一致だと指定が無いことになる）');
});

// ==== 隅の取り合いぶんのはみ出しを「区間の壁」と誤認しない（実機2026-08「21」2階 X2×Y2+3500）====
//
// 角では壁端が相手壁の仕上げ面まで伸びる（コーナーマップ／closeConvexCorners）ため、隣の区間の
// 壁が 57.5mm（=wallBase/2+wallFinish）だけ区間へ食い込む。これを構成壁として拾うと、その壁が
// 全長にわたって腰壁天板の輪郭で描き替えられてしまう（隣室側に天板線が増え、通常の壁帯が消える）。

// 区間[0,4000]の左隣から 57.5mm だけ食い込む下地オーナー壁を1本足す。
function addCornerOverhangWall(graph, yMid, x0) {
  const xLeft = addCL(graph, CenterLineType.VERTICAL, -4000);
  return graph.addWall(yMid, 57.5, false, xLeft, 0, x0, 57.5, {
    isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1,
  });
}

test('【失敗系】resolveKneeDropOverlays: 隅の取り合いぶん(57.5mm)だけ食い込む隣区間の壁は対象にしない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } }); // 平面切断高さ以下＝天板輪郭を出す
  const [axisCLId, startCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId), x0 = graph.shapeMap.get(startCLId);
  const overhang = addCornerOverhangWall(graph, yMid, x0);

  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.has(overhang.id), false, '隣区間の壁は腰壁天板で描き替えない');
  const spanWalls = [...graph.walls].filter(w => !w.isVertical && w.axisCL === yMid && w !== overhang);
  assert.ok(spanWalls.length > 0 && spanWalls.every(w => overlays.has(w.id)), '区間本来の壁は対象のまま');
});

test('【失敗系】kneeDropRecordForWallSpan: 隅の取り合いぶんの重なりしかない壁スパンは拾わない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });

  const axisCL = graph.shapeMap.get(key.split(':')[0]);
  // レコードのスパンは[0,4000]。左隣の壁スパン[-4000,57.5]は 57.5mm しか重ならない。
  assert.equal(kneeDropRecordForWallSpan(graph, axisCL, -4000, 57.5), null);
  // 区間を実際に走る壁スパン（[0,4000]）はこれまでどおり拾う。
  assert.equal(kneeDropRecordForWallSpan(graph, axisCL, 0, 4000)?.key, key);
  // 素の重なり判定（面単位の列挙用）は従来どおり拾う——両者を混同しない。
  assert.equal(kneeDropRecordsOnAxis(graph, axisCL, 1999.5, 2000.5).length, 1);
});

// ==== 実機2026-09「22」2階 A1×X2: 断面エンジンの点クエリも「構成壁」だけを拾う ====
test('kneeDropRecordsAtPointOnWall: 隅の取り合いぶん(57.5mm)だけ食い込む隣区間の壁は、その食い込み内の点でも拾わない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  const [axisCLId, startCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId), x0 = graph.shapeMap.get(startCLId);
  const overhang = addCornerOverhangWall(graph, yMid, x0); // スパン[-4000,57.5]
  assert.deepEqual(kneeDropRecordsAtPointOnWall(graph, overhang, 30, 0.5), [],
    '食い込み部（x=30）の点でも隣区間のレコードは拾わないはず');
  // 区間本来の壁は同じ点で従来どおり拾う
  const own = [...graph.walls].find(w => !w.isVertical && w.axisCL === yMid && w !== overhang);
  assert.equal(kneeDropRecordsAtPointOnWall(graph, own, 30, 0.5).length, 1);
});

test('kneeDropRecordsAtPointOnWall: 区間に丸ごと収まる150mm未満の短い壁は構成壁として拾う（閾値で落とさない）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  const [axisCLId, startCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId), x0 = graph.shapeMap.get(startCLId);
  const short = graph.addWall(yMid, 57.5, false, x0, 100, x0, 200, { isRoomWall: true }); // スパン[100,200]
  assert.equal(kneeDropRecordsAtPointOnWall(graph, short, 150, 0.5).length, 1);
});

test('【失敗系】kneeDropRecordsAtPointOnWall: 点が区間外なら構成壁でも拾わない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  const [axisCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId);
  const own = [...graph.walls].find(w => !w.isVertical && w.axisCL === yMid);
  assert.deepEqual(kneeDropRecordsAtPointOnWall(graph, own, 4500, 0.5), []);
});

// ==== 平面での壁の高さ（「取り合いは高い方が優先」の唯一の供給源。ユーザー確定2026-09）====
test('planWallHeight: 天板輪郭で描かれる腰壁はその天端高さ、それ以外の壁はInfinity', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 900 } });
  const overlays = resolveKneeDropOverlays(graph);

  const knee = [...graph.walls].find(w => overlays.has(w.id));
  const tall = [...graph.walls].find(w => !overlays.has(w.id));
  assert.equal(planWallHeight(overlays, knee.id), 900, '腰壁の高さは天端高さ');
  assert.equal(planWallHeight(overlays, tall.id), Infinity, '切断面に切られる壁は常に高い側');
  assert.equal(wallsMeetAtPlanCut(overlays, knee.id, tall.id), false, '高さが違えば取り合わない');
  assert.equal(wallsMeetAtPlanCut(overlays, tall.id, tall.id), true);
});

test('【失敗系】planWallHeight: 切断高さ超の腰壁・垂れ壁・オーバーレイ無しはすべてInfinity', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: PLAN_CUT_HEIGHT + 1 } }); // 切断面に切られる
  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.size, 0, '切断高さを超える腰壁は天板輪郭で描かない＝オーバーレイ無し');

  const anyWall = [...graph.walls][0];
  assert.equal(planWallHeight(overlays, anyWall.id), Infinity);
  assert.equal(planWallHeight(null, anyWall.id), Infinity, 'オーバーレイ未解決（略図LOD）は全壁同じ高さ');
  assert.equal(planWallHeight(new Map([['w', { mode: 'drop', capLo: 0, capHi: 0 }]]), 'w'), Infinity,
    '垂れ壁は対象外（確定した規則は腰壁のみ）');
  assert.equal(wallsMeetAtPlanCut(null, 'a', 'b'), true);
});

// 実機2026-09の回帰: 区間の端の交差部にできる短い駒は**半分だけ**が区間内に入る。これを腰壁と
// 見なすと、区間の外側で続く全高の壁の取り合い（T字・十字）が壊れる（実機で4本が失われた）。
// 構成壁の判定は変えない——駒は全高のまま扱い、描画の可否は取り合い側（覆われた角）で決める。
test('【実機回帰2026-09】resolveKneeDropOverlays: 区間端に半分だけ掛かる駒は腰壁にしない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  const [axisCLId, , endCLId] = key.split(':');
  const yMid = graph.shapeMap.get(axisCLId), x1 = graph.shapeMap.get(endCLId);
  // 区間の端(x=4000)の交差部にできる駒: [3942.5, 4057.5]（半分だけ区間内）。
  const filler = graph.addWall(yMid, -57.5, false, x1, -57.5, x1, 57.5, {
    isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: -1,
  });
  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.has(filler.id), false, '駒は全高の壁のまま（腰壁扱いにしない）');
  assert.equal(planWallHeight(overlays, filler.id), Infinity);
});

// ==== 天板どうしの角の取り合い（実機2026-09「22」2階 X3×Y1+3500: 端部が重なって描かれた）====
// 規則: 外側どうし・内側どうしでトリム（相手の帯の遠位面／近位面まで長辺を伸縮）し、
// 端部の線（長さ＝天板幅＝壁厚+24）は描かない。

// 1室の直交する2辺（y=0の辺・x=0の辺）に同じ高さの腰壁を指定する。
function makeCornerKneeGraph(topHeights = [900, 900]) {
  const graph = makeGraph();
  const x0 = addCL(graph, CenterLineType.VERTICAL, 0);
  const x1 = addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0 = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y1 = addCL(graph, CenterLineType.HORIZONTAL, 5000);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '室');
  generateRoomWallsFromOutline(graph, room);
  graph.setKneeDropWall(edgeKey(y0.id, x0.id, x1.id), { knee: { topHeight: topHeights[0] } });
  graph.setKneeDropWall(edgeKey(x0.id, y0.id, y1.id), { knee: { topHeight: topHeights[1] } });
  const wallOn = (vertical, axisValue) => [...graph.walls]
    .find(w => w.isVertical === vertical && w.axisCL.effectiveValue === axisValue);
  return { graph, hWall: wallOn(false, 0), vWall: wallOn(true, 0) };
}

test('【実機2026-09】resolveKneeDropOverlays: 角で出会う同高の天板は外側どうし・内側どうしでトリムする', () => {
  const { graph, hWall, vWall } = makeCornerKneeGraph();
  const overlays = resolveKneeDropOverlays(graph);
  // 天板の帯は材（[0,57.5]）の外へ12mm出る＝[-12, 69.5]。角は(x,y)=(57.5,57.5)側が内側。
  assert.deepEqual(overlays.get(hWall.id).capJoins,
    { lo: { capLoAt: -12, capHiAt: 69.5 } },
    '外側の長辺(y=-12)は相手の帯の遠位面(x=-12)まで伸び、内側の長辺(y=69.5)は近位面(x=69.5)で止まる');
  assert.deepEqual(overlays.get(vWall.id).capJoins,
    { lo: { capLoAt: -12, capHiAt: 69.5 } }, '縦壁側も同じ2点（外側の角・内側の角）で取り合う');
  // 角でない側の端（hi端）には取り合いが立たない＝端部の線は従来どおり描かれる。
  assert.equal(overlays.get(hWall.id).capJoins.hi, undefined);
});

test('【失敗系】resolveKneeDropOverlays: 高さが違う腰壁どうしの角は取り合わない（高い方が優先の担当）', () => {
  const { graph, hWall, vWall } = makeCornerKneeGraph([900, 1000]);
  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.get(hWall.id).capJoins, undefined);
  assert.equal(overlays.get(vWall.id).capJoins, undefined);
});

// 向き（4通りの角）に依らないこと・偏芯した帯でも相手の帯の面で止まることを、ビュー直渡しで固定する。
const view = (id, isVertical, lo, hi, capLo, capHi) =>
  ({ id, isVertical, lo, hi, capLo, capHi, capKey: 'knee:900' });

test('resolveCapJoins: 角の向きが変わっても外側＝相手の帯の遠位面・内側＝近位面で止まる', () => {
  // 横壁は-x方向へ伸びhi端(x=57.5)が角。縦壁は+y方向へ伸びlo端(y=57.5)が角＝右上が外側。
  const h = view('h', false, -3000, 57.5, -12, 69.5);
  const v = view('v', true, 57.5, 3000, -12, 69.5);
  const joins = resolveCapJoins([h, v]);
  assert.deepEqual(joins.get('h'), { hi: { capLoAt: 69.5, capHiAt: -12 } },
    '縦壁の本体は+y側＝横壁のcapHi(y=69.5)が内側。外側(y=-12)は遠位面x=69.5まで伸びる');
  assert.deepEqual(joins.get('v'), { lo: { capLoAt: 69.5, capHiAt: -12 } },
    '横壁の本体は-x側＝縦壁のcapLo(x=-12)が内側。外側(x=69.5)は遠位面y=-12まで伸びる');
});

test('resolveCapJoins: 偏芯して帯が軸CLに対し非対称でも相手の帯の面で止まる', () => {
  // 縦壁の帯を[-12, 200]（+x側へ偏芯）に置く。横壁の止め先はこの帯の両面になる。
  const h = view('h', false, 200, 3000, -12, 69.5);
  const v = view('v', true, 69.5, 3000, -12, 200);
  const joins = resolveCapJoins([h, v]);
  assert.deepEqual(joins.get('h'), { lo: { capLoAt: -12, capHiAt: 200 } });
  assert.deepEqual(joins.get('v'), { lo: { capLoAt: -12, capHiAt: 69.5 } });
});

test('【失敗系】resolveCapJoins: 素通りするT字・十字は角ではないので取り合わない', () => {
  // 縦壁が横壁の帯を貫いて両側へ伸びる（どちらの端も横壁の帯に無い）＝T字。
  const h = view('h', false, 0, 3000, -12, 69.5);
  const v = view('v', true, -3000, 3000, 1000, 1100);
  assert.equal(resolveCapJoins([h, v]).size, 0);
});

test('【失敗系】resolveCapJoins: 平行な天板どうし・線種が違う天板どうしは取り合わない', () => {
  const h1 = view('h1', false, 0, 3000, -12, 69.5);
  const h2 = view('h2', false, 3000, 6000, -12, 69.5);
  assert.equal(resolveCapJoins([h1, h2]).size, 0, '平行（同じ向き）は角を作らない');
  const v = { ...view('v', true, 57.5, 3000, -12, 69.5), capKey: 'drop:' };
  assert.equal(resolveCapJoins([view('h', false, 57.5, 3000, -12, 69.5), v]).size, 0,
    '実線（腰壁）と破線（垂れ壁）はトリムしない');
});
