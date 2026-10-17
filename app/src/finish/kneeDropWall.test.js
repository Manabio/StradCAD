// effectiveCeilingHeight / validateKneeDropWall の回帰テスト（QA F5）。
// roomMetrics.roomCeilingHeight への差し替え（finish/roomMetrics.js）で挙動が変わった
// （旧: 非数値CHはNaN/文字列のままMath.minに渡り不定挙動 → 新: graph.defaultCeilingHeightへ
// フォールバック）ため、新セマンティクスをテストで固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from './wallGeneration.js';
import { edgeGeometry, buildCellToRoom } from './edgeClassify.js';
import { shouldDrawCapOutline, effectiveCeilingHeight, validateKneeDropWall, ERR_CEILING_HEIGHT_UNRESOLVED, kneeDropRecordsOnAxis, resolveKneeDropOverlays, kneeDropUpOptions, kneeDropRecordForWallSpan, kneeDropRecordsAtPointOnWall, planWallHeight, PLAN_CUT_HEIGHT, resolveWallSpanKey } from './kneeDropWall.js';

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
});

// ---- 階の切断高（S1）: 判定は定数ではなく graph.plane.planCutHeightMm を読む ----
test('resolveKneeDropOverlays: 切断高を下げると、既定では貫かない高さの腰壁も切断面に切られる（階の値を読む）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 1500 } }); // 既定 1500 以下＝天板輪郭
  assert.ok(resolveKneeDropOverlays(graph).size > 0, '既定の切断高では天板輪郭');
  graph.plane.planCutHeightMm = 1200;
  assert.equal(resolveKneeDropOverlays(graph).size, 0, '切断高 1200 では 1500 の腰壁は切断面に切られる');
  graph.plane.planCutHeightMm = 1600;
  assert.ok(resolveKneeDropOverlays(graph).size > 0, '切断高を上げると再び天板輪郭');
});

test('resolveKneeDropOverlays: 垂れ壁の「切断面を貫かない」判定も階の切断高で動く', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { drop: { bottomHeight: 1400 } }); // 天井高(既定)−1400 が下端
  graph.plane.planCutHeightMm = 100;   // 下端が切断面より上＝貫かない→破線
  const high = resolveKneeDropOverlays(graph).size;
  graph.plane.planCutHeightMm = 99999; // 下端が切断面以下＝貫く→通常描画
  const low = resolveKneeDropOverlays(graph).size;
  assert.ok(high > 0 && low === 0, `high=${high} low=${low}`);
});

test('【失敗系】resolveKneeDropOverlays: 切断高が不正（0・NaN）の階は既定 1500 として判定する', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 1500 } });
  for (const bad of [0, NaN, -1, null]) {
    graph.plane.planCutHeightMm = bad;
    assert.ok(resolveKneeDropOverlays(graph).size > 0, `不正値 ${bad} は既定扱い`);
  }
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

// 角の取り合いそのもの（外側どうし・内側どうし、端部の線を描かない）は renderer/planWallRegion.js が
// 天板を高さクラスごとの領域として解く帰結になった。規則は planWallRegion.test.js の「天板の角」4件と
// renderer/wallDrawPlan.test.js の実グラフ経由の角テストが固定する。ここは供給値（帯・線種・高さ）だけ。
test('【実機2026-09】resolveKneeDropOverlays: 角で出会う同高の天板は同じ帯・線種・高さを供給する', () => {
  const { graph, hWall, vWall } = makeCornerKneeGraph();
  const overlays = resolveKneeDropOverlays(graph);
  // 天板の帯は材（[0,57.5]）の外へ12mm出る＝[-12, 69.5]。
  assert.deepEqual(overlays.get(hWall.id), { mode: 'knee', capLo: -12, capHi: 69.5, topHeight: 900 });
  assert.deepEqual(overlays.get(vWall.id), { mode: 'knee', capLo: -12, capHi: 69.5, topHeight: 900 });
});

test('【失敗系】resolveKneeDropOverlays: 高さが違う腰壁どうしは別の高さクラス（planWallHeight が違う）', () => {
  const { graph, hWall, vWall } = makeCornerKneeGraph([900, 1000]);
  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(planWallHeight(overlays, hWall.id), 900);
  assert.equal(planWallHeight(overlays, vWall.id), 1000);
});

// ==== 実機2026-09「10」2階 X3: 通り芯上で分断された別の壁まで腰壁になる ====
// セル（部屋側の領域片）は壁が途切れても1枚のままなので、セル境界をそのまま区間にすると
// 同じ通りの別の壁まで区間の構成壁になった。区間は押した壁の連続範囲で内側へ詰める。
function makeSplitWallsOnAxis(graph) {
  const xAxis  = addCL(graph, CenterLineType.VERTICAL, 0);
  addCL(graph, CenterLineType.VERTICAL, 4000);       // セルの反対側の境界
  const y0     = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const y7000  = addCL(graph, CenterLineType.HORIZONTAL, 7000);
  // 壁端のCL。破線ARCH CLは領域を分割しない（gridCells.isDividerCL）ので
  // x>0 側は [0,7000] の1セルのまま＝実機と同じ「セルの方が壁より長い」状況になる。
  const dashed = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v,
    { labeled: false, discipline: Discipline.ARCH, lineType: 'dashed' });
  const y3500 = dashed(3500);
  const y5500 = dashed(5500);

  const props = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  const near = graph.addWall(xAxis, 57.5, true, y0,    57.5, y3500, -57.5, props); // [57.5, 3442.5]
  const far  = graph.addWall(xAxis, 57.5, true, y5500, 57.5, y7000, -57.5, props); // [5557.5, 6942.5]
  return { xAxis, y0, y3500, near, far };
}

test('【実機2026-09「10」】resolveWallSpanKey: 区間は押した壁の連続範囲までで、分断された同じ通りの壁を含まない', () => {
  const graph = makeGraph();
  const { xAxis, y0, y3500, near, far } = makeSplitWallsOnAxis(graph);

  const key = resolveWallSpanKey(near, { x: near.axisValue, y: 1000 }, graph);
  assert.equal(key, edgeKey(xAxis.id, y0.id, y3500.id), 'セル境界(0〜7000)ではなく壁の連続範囲(0〜3500)');

  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  const overlays = resolveKneeDropOverlays(graph);
  assert.equal(overlays.has(near.id), true, '押した壁は腰壁になる');
  assert.equal(overlays.has(far.id), false, '分断された別の壁は腰壁にしない');
});

test('【失敗系】resolveWallSpanKey: セルの方が壁の連続範囲より狭ければセル境界のまま（区間指定の粒度は変えない）', () => {
  const graph = makeGraph();
  const xAxis = addCL(graph, CenterLineType.VERTICAL, 0);
  addCL(graph, CenterLineType.VERTICAL, 4000);
  const y0    = addCL(graph, CenterLineType.HORIZONTAL, 0);
  const yMid  = addCL(graph, CenterLineType.HORIZONTAL, 3500); // 分割CL＝セルを2枚に割る
  const y7000 = addCL(graph, CenterLineType.HORIZONTAL, 7000);
  const wall  = graph.addWall(xAxis, 57.5, true, y0, 57.5, y7000, -57.5,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 });

  assert.equal(resolveWallSpanKey(wall, { x: wall.axisValue, y: 1000 }, graph), edgeKey(xAxis.id, y0.id, yMid.id));
  assert.equal(resolveWallSpanKey(wall, { x: wall.axisValue, y: 5000 }, graph), edgeKey(xAxis.id, yMid.id, y7000.id));
});

test('shouldDrawCapOutline: 見上げ(up)では切断高より低い腰壁の輪郭を描かず、垂れ壁・切断高以上の腰壁・見下げは描く', () => {
  const knee = { mode: 'knee', topHeight: 800 };
  assert.equal(shouldDrawCapOutline(knee, 'up', 1500), false, '腰壁800は見上げで見えない');
  assert.equal(shouldDrawCapOutline({ mode: 'drop' }, 'up', 1500), true, '垂れ壁は見上げで描く');
  assert.equal(shouldDrawCapOutline({ mode: 'knee', topHeight: 1500 }, 'up', 1500), true, '切断高以上は従来どおり');
  assert.equal(shouldDrawCapOutline(knee, 'down', 1500), true, '見下げは全部描く');
  assert.equal(shouldDrawCapOutline(knee, undefined, 1500), true, '向き欠落は見下げ扱い');
});

test('【失敗系】shouldDrawCapOutline: オーバーレイが無ければ描かない', () => {
  assert.equal(shouldDrawCapOutline(null, 'up', 1500), false);
  assert.equal(shouldDrawCapOutline(undefined, 'down', 1500), false);
});

test('shouldDrawCapOutline: 腰壁＋垂れ壁の同時指定は、見下げ（平面。opts なし）の解決では腰壁の overlay に統合される（見上げは kneeDropUpOptions で垂れ壁。下のテスト）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: { bottomHeight: 600 } });
  const overlays = resolveKneeDropOverlays(graph);
  assert.ok(overlays.size > 0, 'overlay はある');
  for (const o of overlays.values()) {
    assert.equal(o.mode, 'knee', '腰壁の overlay に統合される');
    assert.equal(shouldDrawCapOutline(o, 'up', 1500), false, '平面の解決のまま見上げに使うと垂れ壁も描かれない（見上げは kneeDropUpOptions で解く）');
  }
});

// ==== 見上げ（天伏）の腰壁・垂れ壁（裁定 2026-10-18: 切断高は平面と変える・同じ区間の腰壁＋垂れ壁は垂れ壁）====
const constCut = mm => () => mm;
const onlyOverlay = overlays => { assert.equal(new Set(overlays.values()).size, 1, 'overlay は 1 区間分'); return [...overlays.values()][0]; };

test('見上げ: 腰壁は平面の切断高(1500)ではなく天伏の切断高で判定する（腰壁1300。天伏1100→切られる壁＝overlay なし、天伏2000→腰壁の overlay で描かない）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 1300 } });
  assert.equal(onlyOverlay(resolveKneeDropOverlays(graph)).mode, 'knee', '平面（1500）では腰壁の overlay');
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(1100))).size, 0, '天伏 1100 では 1300 の腰壁は切断面に切られる＝通常の壁');
  const up = onlyOverlay(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(2000))));
  assert.equal(up.mode, 'knee');
  assert.equal(up.cutMm, 2000, '区間の切断高を overlay に持つ');
  assert.equal(shouldDrawCapOutline(up, 'up', 1500), false, '天端 1300 < 区間の切断高 2000 は見えない（階の値 1500 より区間の値を優先）');
  const same = onlyOverlay(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(1300))));
  assert.equal(shouldDrawCapOutline(same, 'up', 99999), true, '天端＝切断高は描く');
});

test('見上げ: 腰壁＋垂れ壁の同時指定は垂れ壁として扱う（破線の overlay・描く）。見下げは従来どおり腰壁に統合', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: { bottomHeight: 600 } });
  assert.equal(onlyOverlay(resolveKneeDropOverlays(graph)).mode, 'knee', '平面は腰壁');
  const up = onlyOverlay(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(1500))));
  assert.equal(up.mode, 'drop');
  assert.equal(up.topHeight, undefined);
  assert.equal(shouldDrawCapOutline(up, 'up', 1500), true);
  // 垂れ壁の下端（天井高−600）が天伏の切断高以下なら、切断面が垂れ壁を貫く＝通常の壁（腰壁には戻らない）
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(99999))).size, 0);
});

test('見上げ: 区間の両側の切断高の最小を使う（壁の片側が低い部屋なら低い方。腰壁1300・片側 1000/反対側 2000 → 1000 で切られる）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph); // 壁は y=2000 の水平壁。上室は y<2000
  graph.setKneeDropWall(key, { knee: { topHeight: 1300 } });
  const seen = [];
  const cutZAt = (x, y) => { seen.push([x, y]); return y < 2000 ? 1000 : 2000; };
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(cutZAt)).size, 0);
  assert.ok(seen.some(([, y]) => y < 2000) && seen.some(([, y]) => y > 2000), '壁の両側で問い合わせる');
  assert.ok(seen.every(([x]) => x > 0 && x < 4000), '区間に沿った点');
  const flipped = (x, y) => (y < 2000 ? 2000 : 1000);
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(flipped)).size, 0, '逆でも最小');
});

test('opts なし・空 opts は従来の解決と同一（cutMm を持たない）。cutHeightOf だけ渡すと平面の腰壁・垂れ壁の優先順位は変わらない', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: { bottomHeight: 600 } });
  const base = resolveKneeDropOverlays(graph);
  assert.deepEqual([...resolveKneeDropOverlays(graph, {})], [...base]);
  assert.ok([...base.values()].every(o => !('cutMm' in o)));
  const onlyCut = onlyOverlay(resolveKneeDropOverlays(graph, { cutHeightOf: () => 1500 }));
  assert.equal(onlyCut.mode, 'knee', 'preferDrop なしは腰壁に統合');
});

test('【失敗系】見上げ: 切断高が数値にならない（NaN）と腰壁・垂れ壁とも overlay を作らない（通常の壁のまま）。孤児の区間は無視', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 } });
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(NaN))).size, 0);
  graph.setKneeDropWall(key, { drop: { bottomHeight: 600 } });
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(NaN))).size, 0);
  const empty = makeGraph();
  assert.equal(resolveKneeDropOverlays(empty, kneeDropUpOptions(constCut(1500))).size, 0);
});

test('見上げ: 腰壁＋垂れ壁の同時指定で、天伏の切断高が腰壁の天端より低い（腰壁が切断される）ときは overlay を作らない（通常の壁＝切断線。垂れ壁の破線も出さない）', () => {
  const graph = makeGraph();
  const { key } = makeSharedEdgeRooms(graph);
  graph.setKneeDropWall(key, { knee: { topHeight: 800 }, drop: { bottomHeight: 600 } });
  assert.equal(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(700))).size, 0);
  assert.equal(onlyOverlay(resolveKneeDropOverlays(graph, kneeDropUpOptions(constCut(800)))).mode, 'drop', '天端＝切断高は切断されない');
});
