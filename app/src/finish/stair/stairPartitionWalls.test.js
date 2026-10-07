// 在来木造・折返し階段の隔て壁（平面。S2）の生成・識別・構造/腰壁からの除外・本番経路の確認。
// フィクスチャは stairPartition.test.js の EQUAL_UP（座標の矩形から CL とセルキーを作る。y 下向き正）と、
// finishBoundary.test.js makeStairUnder2aFixture（SWITCHBACK＋2a部屋）の構成を流用する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StairType, RoomKind, RoomFeature } from '@core';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { stairPartitionLines, isStairPartitionWall, PARTITION_BACKING_MM, PARTITION_FINISH_MM } from './stairPartition.js';
import { selfWallSegments, wallBackingCenters, autoFillWallBeamAxes } from '../../structural/wallBeamAxes.js';
import { autoFillWoodColumns } from '../../structural/woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { isEligibleWallSpan } from '../kneeDropWall.js';
import { WALL_KEY_VERSION } from '../wallFreshnessKey.js';
import { runFinishExitBoundary } from '../finishBoundary.js';
import { loadMaterialMap } from '../wallRegeneration.js';
import { cellsBeyondBreak } from './stairGeometry.js';
import { undoManager } from '../../undoManager.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
// 踊り場 y0〜1000（全幅）、左レーンA・右レーンB が y1000〜4000（軸 x=1000・区間 y1000〜4000）
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

// rects の各 [x1,y1,x2,y2] を1セルとして Stair を作る。cl.* で中心線の属性（discipline・extent 等）を上書きできる
function makeStair(rects, stairProps = {}, { project = new Project('proj', 'test'), clProps = () => ({}) } = {}) {
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH, ...clProps(type, v) })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
  return { project, graph, stair, V, H };
}
const gen = (graph, o = {}) => generateStairPartitionWalls(graph, { structure: WOOD, ...o });
const clCount = (graph) => graph.centerLines.length;
const range = (r) => (r ? { lo: r.lo, hi: r.hi } : null);

test('在来・SWITCHBACK・等長: オーナー壁＋薄壁の2枚。軸x=1000・区間1000〜4000・材/下地の範囲が仕様どおり・どの Room の generatedWallIds にも入らない', () => {
  const { graph } = makeStair(EQUAL_UP);
  const room = graph.addRoom(new Set(graph.stairs[0].cells), '階段');
  const walls = gen(graph);
  assert.equal(walls.length, 2);
  const [owner, thin] = walls;
  assert.equal(PARTITION_BACKING_MM / 2 + PARTITION_FINISH_MM, 57.5);
  for (const w of walls) {
    assert.equal(w.isRoomWall, true);
    assert.equal(w.isExteriorWall, false);
    assert.equal(w.isVertical, true);
    assert.equal(w.axisCL.value, 1000);
    assert.deepEqual([Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)], [1000, 4000]);
    assert.equal(w.wallFinish, 12.5);
    assert.equal(w.backingOffset, 0);
  }
  assert.equal(owner.axisOffset, 57.5);
  assert.equal(owner.backingDepth, 90);
  assert.equal(owner.finishSide, 1);
  assert.deepEqual(range(owner.materialRange), { lo: 955, hi: 1057.5 });
  assert.deepEqual(range(owner.backingRange), { lo: 955, hi: 1045 });
  assert.equal(thin.axisOffset, -57.5);
  assert.equal(thin.backingDepth, 0);
  assert.equal(thin.finishSide, -1);
  assert.deepEqual(range(thin.materialRange), { lo: 942.5, hi: 955 });
  assert.equal(thin.backingRange, null);
  assert.equal(room.generatedWallIds.size, 0, '生成元の部屋の generatedWallIds に入れない');
  assert.ok(graph.rooms.every(r => r.generatedWallIds.size === 0));
});

test('【失敗系】在来木造以外（S造・RC・2x4・null）は0枚', () => {
  const { graph } = makeStair(EQUAL_UP);
  for (const structure of ['S造', 'RC造(ラーメン)', '木造（2"×4"）', null]) {
    assert.equal(gen(graph, { structure }).length, 0, String(structure));
  }
  assert.equal(graph.walls.length, 0);
});

test('【失敗系】SWITCHBACK 以外（STRAIGHT・WINDING）は0枚', () => {
  for (const type of [StairType.STRAIGHT, StairType.WINDING]) {
    const { graph } = makeStair(EQUAL_UP, { type });
    assert.equal(gen(graph).length, 0, type);
  }
});

test('【失敗系】ペア部屋が屋外（EXTERIOR）の階段は0枚（屋外階段は壁なし）。対照: 屋内なら2枚', () => {
  const { graph, stair } = makeStair(EQUAL_UP);
  const pair = graph.addRoom(new Set(stair.cells), '階段');
  pair.setFeature(RoomFeature.STAIR);
  stair.roomId = pair.id;
  assert.equal(gen(graph).length, 2, '対照（屋内）');
  graph.walls.forEach(w => graph.removeShape(w.id));
  pair.setKind(RoomKind.EXTERIOR);
  assert.equal(gen(graph).length, 0);
  assert.deepEqual(stairPartitionLines(graph), [], '識別側も屋外階段は線に含めない');
});

test('2a が受け持つ区間は差し引く: 片側（y1000〜2500）が2a区間なら y2500〜4000 だけに生成。全区間を覆えば0枚。別の軸の2a区間は影響しない', () => {
  const { graph } = makeStair(EQUAL_UP);
  const spans = (ws) => ws.map(w => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)]);
  // 差し引いて残った区間の端（y=2500）に水平CLが無い → 黙って生成しない（設計: CL は作らない）。
  const part = gen(graph, { underEdges: [{ isVertical: true, value: 1000, lo: 1000, hi: 2500 }] });
  assert.equal(part.length, 0);
  assert.deepEqual(spans(part), []);
  graph.walls.forEach(w => graph.removeShape(w.id));
  assert.equal(gen(graph, { underEdges: [{ isVertical: true, value: 1000, lo: 0, hi: 5000 }] }).length, 0, '全区間を覆えば0枚');
  assert.equal(gen(graph, { underEdges: [{ isVertical: true, value: 1000.4, lo: 0, hi: 5000 }] }).length, 0, '軸の許容0.5mm以内は同じ軸');
  assert.equal(gen(graph, { underEdges: [{ isVertical: true, value: 1500, lo: 0, hi: 5000 }] }).length, 2, '別の軸');
  assert.equal(gen(graph, { underEdges: [{ isVertical: false, value: 1000, lo: 0, hi: 5000 }] }).length, 2, '向きが違う');
});

test('2a の差し引き: 残り区間の端に CL があれば残りだけに2枚（端CL y=2500 を足した場合）', () => {
  const { graph, H } = makeStair(EQUAL_UP);
  H(2500);
  const ws = gen(graph, { underEdges: [{ isVertical: true, value: 1000, lo: 1000, hi: 2500 }] });
  assert.deepEqual(ws.map(w => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)]), [[2500, 4000], [2500, 4000]]);
  // 差し引きで短くなった区間の壁も隔て壁と識別される（識別は「線の [lo,hi] に収まる」判定なので部分区間でも真）
  const lines = stairPartitionLines(graph);
  assert.ok(ws.every(w => isStairPartitionWall(w, lines)), '差し引き後の短い区間の壁も隔て壁と識別される');
});

test('【失敗系】軸CLが補助線・梁芯だけ／端CLが無い／軸CLが区間を覆わない → 0枚で CL の本数は増えない', () => {
  // 軸 x=1000 が梁芯（FUSE）・補助線（ARCH ＋ lineType）だけ → 分割線ではない
  const noAxis = (clProps) => makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? clProps : {}) });
  for (const [label, p] of [['梁芯', { discipline: Discipline.FUSE }], ['補助線', { discipline: Discipline.ARCH, lineType: 'dashed' }]]) {
    const { graph } = noAxis(p);
    const axis = graph.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 1000);
    const before = clCount(graph);
    // 前提（検出力）: 通常の分割線なら2枚出るフィクスチャで、この CL だけが違う
    const isDivider = gen(graph).length > 0;
    assert.equal(isDivider, false, `${label}は軸にならない（lineType=${axis.lineType} discipline=${axis.discipline}）`);
    assert.equal(clCount(graph), before, 'CL を作らない');
  }
  // 端CL（y=4000）が梁芯
  const noEnd = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.HORIZONTAL && v === 4000 ? { discipline: Discipline.FUSE } : {}) });
  const before = clCount(noEnd.graph);
  assert.equal(gen(noEnd.graph).length, 0);
  assert.equal(clCount(noEnd.graph), before);
  // 軸CLの区間が y1000〜4000 を覆わない（extent が y2000 まで）
  const short = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? { extentLo: 0, extentHi: 2000 } : {}) });
  assert.equal(gen(short.graph).length, 0, '区間を覆わない軸CLでは生成しない（はね出しで延ばさない）');
  // 対照: 同じ構成で extent が覆っていれば2枚
  const full = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? { extentLo: 0, extentHi: 5000 } : {}) });
  assert.equal(gen(full.graph).length, 2);
});

test('識別 stairPartitionLines/isStairPartitionWall: 隔て壁2枚は真。普通の部屋壁・手動壁（isRoomWall:false）・外壁・2aのレーン壁相当（軸から離れた帯）は偽', () => {
  const { graph, V, H } = makeStair(EQUAL_UP);
  const [owner, thin] = gen(graph);
  const lines = stairPartitionLines(graph);
  assert.deepEqual(lines, [{ isVertical: true, axisValue: 1000, lo: 1000, hi: 4000 }]);
  assert.equal(isStairPartitionWall(owner, lines), true);
  assert.equal(isStairPartitionWall(thin, lines), true);
  const x1 = V(1000), y1 = H(1000), y4 = H(4000);
  const mkWall = (offset, props) => graph.addWall(x1, offset, true, y1, 0, y4, 0, props);
  const room = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  assert.equal(isStairPartitionWall(mkWall(57.5, { ...room, isRoomWall: false }), lines), false, '手動壁');
  assert.equal(isStairPartitionWall(mkWall(57.5, { ...room, isExteriorWall: true }), lines), false, '外壁');
  // 2a のレーン壁: 帯 50〜165（主壁）・50〜62.5（薄壁）
  assert.equal(isStairPartitionWall(mkWall(165, { isRoomWall: true, wallFinish: 12.5, backingOffset: 107.5, backingDepth: 115, finishSide: 1 }), lines), false, '2a主壁');
  assert.equal(isStairPartitionWall(mkWall(50, { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 0, finishSide: -1 }), lines), false, '2a薄壁（帯 50〜62.5）');
  // 普通の部屋壁（対称壁。軸から120離れた別軸）
  const x0 = V(0);
  assert.equal(isStairPartitionWall(graph.addWall(x0, 60, true, y1, 0, y4, 0, { isRoomWall: true, wallFinish: 12.5 }), lines), false, '別の軸の壁');
  assert.equal(isStairPartitionWall(owner, []), false, '線が無ければ偽');
  // 同軸 ±57.5 でも区間が線の [1000,4000] からはみ出す壁は偽（柱包みではね出した延長上の部屋壁。収まり判定）
  const yTop = H(3942.5), y6 = H(6000);
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, yTop, 0, y6, 0, room), lines), false, '区間が線からはみ出す');
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, y1, -57.5, y4, 0, room), lines), false, '始端がはみ出す');
  // スパンが重ならない同軸の壁は偽（y 4000〜5000）
  const y5 = H(5000);
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, y4, 0, y5, 0, room), lines), false, 'スパンが線と重ならない');
});

// 構造・腰壁の除外用: 外周の4壁（下地オーナー）を足した建物。隔て壁の端 y=4000 が T 字取り合いになる。
function addOuterWalls(graph, V, H) {
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, own);
  graph.addWall(V(2000), -57.5, true, H(0), 0, H(4000), 0, { ...own, finishSide: -1 });
  graph.addWall(H(0), 57.5, false, V(0), 0, V(2000), 0, own);
  graph.addWall(H(4000), -57.5, false, V(0), 0, V(2000), 0, { ...own, finishSide: -1 });
}
const colSig = (graph) => graph.columns.map(c => `${c.verticalCL.effectiveValue}:${c.horizontalCL.effectiveValue}`).sort();

test('構造の除外: selfWallSegments・wallBackingCenters に隔て壁は含まれず他の壁は含まれる。柱は隔て壁の有無で同じ数・同じ位置', () => {
  const withPart = makeStair(EQUAL_UP);
  addOuterWalls(withPart.graph, withPart.V, withPart.H);
  const base = makeStair(EQUAL_UP);
  addOuterWalls(base.graph, base.V, base.H);
  const walls = gen(withPart.graph);
  assert.equal(walls.length, 2);

  const segs = selfWallSegments(withPart.graph);
  assert.equal(segs.length, 4, '外周4壁だけ（隔て壁のオーナー壁は含まれない）');
  assert.equal(segs.some(s => s.isVertical && Math.abs(s.coord - 1000) < 1), false);
  const centers = wallBackingCenters(withPart.graph);
  assert.equal(centers.length, 4);
  assert.equal(centers.some(c => c.axisCLId === walls[0].axisCL.id), false);
  // 検出力: 識別を外した素の素材（隔て壁のオーナー壁は下地オーナー＝backingRange 非null）が存在する
  assert.notEqual(walls[0].backingRange, null);

  for (const t of [withPart, base]) {
    autoFillWallBeamAxes(t.graph, selfWallSegments(t.graph));
    autoFillWoodColumns(t.graph, t.project, null);
  }
  assert.ok(base.graph.columns.length > 0, '前提: 柱が立つ構成');
  assert.deepEqual(colSig(withPart.graph), colSig(base.graph));
});

test('腰壁・垂れ壁: isEligibleWallSpan は隔て壁で false、普通の内壁で true、外壁・2a壁は従来どおり false', () => {
  const { graph, V, H } = makeStair(EQUAL_UP);
  const [owner, thin] = gen(graph);
  assert.equal(isEligibleWallSpan(owner, graph), false);
  assert.equal(isEligibleWallSpan(thin, graph), false);
  const plain = graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, { isRoomWall: true, wallFinish: 12.5 });
  assert.equal(isEligibleWallSpan(plain, graph), true, '普通の内壁');
  const ext = graph.addWall(V(2000), 57.5, true, H(0), 0, H(4000), 0, { isRoomWall: true, isExteriorWall: true });
  assert.equal(isEligibleWallSpan(ext, graph), false, '外壁');
});

test('鮮度キーの版は v5 以上（隔て壁の生成で壁集合が変わるため既存キーを不一致にする）', () => {
  assert.match(WALL_KEY_VERSION, /^v\d+$/);
  assert.ok(Number(WALL_KEY_VERSION.slice(1)) >= 5, WALL_KEY_VERSION);
});

// ---- 本番経路（runFinishExitBoundary: 全削除→2a→隔て壁→隣室壁→外壁） ----
// finishBoundary.test.js makeStairUnder2aFixture と同じ構成（SWITCHBACK・L字部屋＋階段下の2a部屋）。2a 部屋は
// 階段下の領域がレーン間中心線 x=1000 の全区間を受け持つため、隔て壁は2a区間の差し引きで0枚になる。
async function makeFixture2a() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const mk = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = mk(CenterLineType.VERTICAL, 0), xm = mk(CenterLineType.VERTICAL, 1000), x1 = mk(CenterLineType.VERTICAL, 2000);
  const y0 = mk(CenterLineType.HORIZONTAL, 0), ym = mk(CenterLineType.HORIZONTAL, 1500), y1 = mk(CenterLineType.HORIZONTAL, 4500);
  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([landingKey, outboundKey]), '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landingKey, outboundKey, returnKey]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const under = graph.addRoom(new Set(cellsBeyondBreak(stair, graph, stair.riser ?? null)), '階段下');
  const materialMap = await loadMaterialMap();
  // fmode.stairUnderRooms は本番経路では使われない（finishBoundary は resolveStairContext で2aを自分で解決する）。
  // ここで2aを無効にしているわけではない。 2a は階段下の部屋(under)の存在から解決される。
  const fmode = { materialMap, stairUnderRooms: () => [{ stair, room: under, splitCLIds: new Set() }] };
  return { project, graph, under, fmode, xm };
}
const shapeSet = (graph) => graph.walls
  .map(w => [w.isVertical ? 'V' : 'H', w.axisCL.effectiveValue, w.axisOffset, Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2), w.backingDepth, w.finishSide].join('|')).sort();

test('本番経路【2aが全区間を受け持つ】隔て壁は0枚。ルール6の2aレーン壁（x=1000上の2枚）はそのまま', async () => {
  const { project, graph, under, fmode, xm } = await makeFixture2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const onAxis = graph.walls.filter(w => w.axisCL.id === xm.id);
  assert.equal(onAxis.length, 2, 'x=1000上は2aのレーン壁2枚だけ');
  assert.ok(onAxis.every(w => under.generatedWallIds.has(w.id)), 'どちらも2a部屋の壁');
  const lines = stairPartitionLines(graph);
  assert.ok(onAxis.every(w => !isStairPartitionWall(w, lines)), '2aの壁は隔て壁として識別されない');
});

// 2a の無い SWITCHBACK（EQUAL_UP と同形。周囲に壁はない）。本番経路の冪等・undo/redo・規則1
async function makeFixtureNo2a() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const mk = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [-3000, 0, 1000, 2000, 5000].map(v => mk(CenterLineType.VERTICAL, v));
  const ys = [-3000, 0, 1000, 4000, 6000].map(v => mk(CenterLineType.HORIZONTAL, v));
  const key = (c, r) => `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`;
  // 踊り場（y0〜1000 の2セル）＋レーン（y1000〜4000 の2セル）= 階段のセル
  const cells = new Set([key(1, 1), key(2, 1), key(1, 2), key(2, 2)]);
  const pair = graph.addRoom(new Set(cells), '階段');
  pair.setFeature(RoomFeature.STAIR);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: pair.id, sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const materialMap = await loadMaterialMap();
  // fmode.stairUnderRooms は本番経路では使われない（finishBoundary は resolveStairContext で2aを自分で解決する）。
  // ここで2aを無効にしているわけではない。
  return { project, graph, stair, fmode: { materialMap, stairUnderRooms: () => [] } };
}
const partitionWalls = (graph) => { const l = stairPartitionLines(graph); return graph.walls.filter(w => isStairPartitionWall(w, l)); };

test('本番経路【冪等】2回脱出しても隔て壁を含む壁の形状集合が同じ（隔て壁は2枚）', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const first = shapeSet(graph);
  assert.equal(partitionWalls(graph).length, 2, '前提: 隔て壁2枚');
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  assert.deepEqual(shapeSet(graph), first);
  assert.equal(partitionWalls(graph).length, 2);
});

test('本番経路【undo/redo】脱出の undo で隔て壁が消え、redo で同じ値に戻る', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const after = shapeSet(graph);
  assert.equal(partitionWalls(graph).length, 2, '前提');
  // 在来木造の脱出は壁のメインエントリの後に構造再計算のエントリを積む（finishBoundary.test.js と同じ。2回必要）
  undoManager.undo();
  undoManager.undo();
  assert.equal(partitionWalls(graph).length, 0, 'undo で消える');
  assert.equal(graph.walls.length, 0);
  undoManager.redo();
  undoManager.redo();
  assert.deepEqual(shapeSet(graph), after, 'redo で同じ値');
});

test('【失敗系】本番経路: 主構造がS造なら脱出しても隔て壁は出ない（鮮度キーは書かれる）', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  graph.structureOverride = 'S造';
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  assert.equal(partitionWalls(graph).length, 0);
  assert.equal(graph.walls.some(w => Math.abs(w.axisCL.effectiveValue - 1000) < 1 && w.isVertical && Math.abs(Math.abs(w.axisOffset) - 57.5) < 0.01 && w.backingDepth === 90), false);
});
