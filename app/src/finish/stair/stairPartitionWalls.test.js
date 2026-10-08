// 在来木造・折返し階段の隔て壁（平面。S2）の生成・識別・構造/腰壁からの除外・本番経路の確認。
// フィクスチャは stairPartition.test.js の EQUAL_UP（座標の矩形から CL とセルキーを作る。y 下向き正）と、
// finishBoundary.test.js makeStairUnder2aFixture（SWITCHBACK＋2a部屋）の構成を流用する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, Plane, StructuralMaterialType, CenterLineType, Discipline, StairType, RoomKind, RoomFeature } from '@core';
import { buildSelfFootprintGate } from '../../structural/wallGate.js';
import { generateStairPartitionWalls, wrapStairPartitionFreeEnds } from './stairPartitionWalls.js';
import { stairPartitionLines, isStairPartitionWall, PARTITION_BACKING_MM, PARTITION_FINISH_MM } from './stairPartition.js';
import { selfWallSegments, wallBackingCenters, autoFillWallBeamAxes } from '../../structural/wallBeamAxes.js';
import { autoFillWoodColumns, autoFillWoodWallBeams, conformWoodSections, conformWoodBacking } from '../../structural/woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE, woodColumnWidthMm } from '../../structural/structureRules.js';
import { stairPartitionEnds } from '../../structural/wallFreeEnds.js';
import { autoFillStructuralGrid } from '../../structural/structuralAutoFill.js';
import { isEligibleWallSpan } from '../kneeDropWall.js';
import { WALL_KEY_VERSION, wallFreshnessKey } from '../wallFreshnessKey.js';
import { refreshWallsForGraph } from '../../wallRefresh.js';
import { runFinishExitBoundary } from '../finishBoundary.js';
import { loadMaterialMap, regenerateWalls } from '../wallRegeneration.js';
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

test('在来・WINDING（回り階段）: SWITCHBACK と同じくオーナー壁＋薄壁の2枚。軸x=1000・区間1000〜4000・識別される', () => {
  const { graph } = makeStair(EQUAL_UP, { type: StairType.WINDING, sections: [6, 3, 6] });
  const walls = gen(graph);
  assert.equal(walls.length, 2);
  const [owner, thin] = walls;
  for (const w of walls) {
    assert.equal(w.axisCL.value, 1000);
    assert.deepEqual([Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)], [1000, 4000]);
  }
  assert.deepEqual([owner.axisOffset, owner.backingDepth, owner.finishSide], [57.5, 90, 1]);
  assert.deepEqual([thin.axisOffset, thin.backingDepth, thin.finishSide], [-57.5, 0, -1]);
  const lines = stairPartitionLines(graph);
  assert.deepEqual(lines, [{ isVertical: true, axisValue: 1000, lo: 1000, hi: 4000 }]);
  assert.ok(walls.every(w => isStairPartitionWall(w, lines)));
});

test('【失敗系】U 字系以外（STRAIGHT・STRAIGHT_LANDING・L_TURN・FLARED・OPEN_WELL）は、U 字に見えるセルでも0枚', () => {
  for (const type of [StairType.STRAIGHT, StairType.STRAIGHT_LANDING, StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL]) {
    const { graph } = makeStair(EQUAL_UP, { type });
    assert.equal(gen(graph).length, 0, type);
    assert.equal(graph.walls.length, 0, type);
  }
});

test('【失敗系】鉄骨の階段（SWITCHBACK・WINDING）は在来の建物でも0枚。対照: 木造の階段は2枚', () => {
  for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
    const wood = makeStair(EQUAL_UP, { type });
    assert.equal(gen(wood.graph).length, 2, `対照 ${type}`);
    const steel = makeStair(EQUAL_UP, { type });
    steel.stair.structure = StructuralMaterialType.STEEL;
    assert.equal(gen(steel.graph).length, 0, `鉄骨 ${type}`);
    assert.equal(steel.graph.walls.length, 0, `鉄骨 ${type}`);
  }
});

test('【失敗系】WINDING でも分割線 CL（軸・端）が欠けると0枚で CL を作らない（軸が梁芯・端が補助線）', () => {
  const noAxis = makeStair(EQUAL_UP, { type: StairType.WINDING },
    { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? { discipline: Discipline.FUSE } : {}) });
  const before = clCount(noAxis.graph);
  assert.equal(gen(noAxis.graph).length, 0);
  assert.equal(clCount(noAxis.graph), before);
  const noEnd = makeStair(EQUAL_UP, { type: StairType.WINDING },
    { clProps: (type, v) => (type === CenterLineType.HORIZONTAL && v === 1000 ? { discipline: Discipline.ARCH, lineType: 'dashed' } : {}) });
  assert.equal(gen(noEnd.graph).length, 0);
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
  // 識別は設計上の端（端CL）で見る: 物理端が柱包みで線の外へはね出していても、端CLが線内なら真（隔て壁自身の柱包み）
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, y1, -57.5, y4, 57.5, room), lines), true, '物理端がはね出しても設計上の端が線内なら真');
  // 否定例: 端CL自体が線の外（延長上の部屋壁。物理端が柱包みで線の端まで入り込んでも偽）
  const yOut = H(942.5);
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, yOut, 57.5, y4, 0, room), lines), false, '始端CLが線の外');
  // スパンが重ならない同軸の壁は偽（y 4000〜5000）
  const y5 = H(5000);
  assert.equal(isStairPartitionWall(graph.addWall(x1, 57.5, true, y4, 0, y5, 0, room), lines), false, 'スパンが線と重ならない');
});

// 構造・腰壁の除外用: 外周の4壁（下地オーナー）を足した建物。隔て壁の端 y=4000 が T 字取り合いになる。
// bottom=false で下辺（y=4000。隔て壁の上り口側の端）の壁を省く＝上り口側も自由端になる
function addOuterWalls(graph, V, H, { bottom = true } = {}) {
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, own);
  graph.addWall(V(2000), -57.5, true, H(0), 0, H(4000), 0, { ...own, finishSide: -1 });
  graph.addWall(H(0), 57.5, false, V(0), 0, V(2000), 0, own);
  if (bottom) graph.addWall(H(4000), -57.5, false, V(0), 0, V(2000), 0, { ...own, finishSide: -1 });
}
const colSig = (graph) => graph.columns.map(c => `${c.verticalCL.effectiveValue}:${c.horizontalCL.effectiveValue}`).sort();

test('構造の除外: selfWallSegments・wallBackingCenters に隔て壁は含まれず他の壁は含まれる。柱は基準（隔て壁なし）に両端の柱2本だけ加わる', () => {
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
  // 隔て壁は壁ソースに入らない（梁芯CL・通し梁・階柱寸の柱が湧かない）。足されるのは両端の柱（点源＝stairPartitionEnds）だけ
  assert.deepEqual(colSig(withPart.graph), [...colSig(base.graph), '1000:1000', '1000:4000'].sort());
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

test('鮮度キーの版は v7 以上（回り階段にも隔て壁を立て、鉄骨階段には立てない＝生成する壁が変わったため）', () => {
  assert.ok(Number(WALL_KEY_VERSION.slice(1)) >= 7, WALL_KEY_VERSION);
});

test('読込み時の回帰【v6 の鍵・WINDING・隔て壁なし】refreshWallsForGraph が再生成し、隔て壁2枚が立つ。現行の鍵のままなら何もしない', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a({ type: StairType.WINDING, sections: [6, 3, 6] });
  assert.equal(partitionWalls(graph).length, 0, '前提: 隔て壁なし（v6 時代に保存された状態）');
  conformWoodBacking(graph, project); // refresh が鍵比較の前に行う下地材そろえを先に済ませ、鍵の差を版だけにする
  const current = wallFreshnessKey(graph, project);
  assert.ok(current.startsWith(`${WALL_KEY_VERSION}|`));
  graph.setWallFreshnessKey(current.replace(WALL_KEY_VERSION, 'v6'));
  const regen = await refreshWallsForGraph(graph, project, () => Promise.resolve(fmode.materialMap), { peek: async () => null, pushUndo: false });
  assert.equal(regen, true, 'v6 の鍵は不一致＝再生成する');
  assert.equal(partitionWalls(graph).length, 2);
  // 対照: 再生成後の鍵は現行版で、続けて呼んでも何もしない
  assert.equal(await refreshWallsForGraph(graph, project, () => Promise.resolve(fmode.materialMap), { peek: async () => null, pushUndo: false }), false);
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
async function makeFixtureNo2a({ type = StairType.SWITCHBACK, sections = [6, 1, 6], structure = null } = {}) {
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
    type, cells, roomId: pair.id, sections, riser: null, upDirection: 'up', flip: false,
  });
  if (structure) stair.structure = structure;
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

test('本番経路【WINDING】脱出で隔て壁2枚（オーナー＋薄壁）。鉄骨の WINDING は在来の建物でも出ない', async () => {
  const wood = await makeFixtureNo2a({ type: StairType.WINDING, sections: [6, 3, 6] });
  await runFinishExitBoundary(wood.graph, wood.project, wood.fmode, { goingToStructure: false });
  assert.equal(partitionWalls(wood.graph).length, 2, '木造の WINDING');
  const steel = await makeFixtureNo2a({ type: StairType.WINDING, sections: [6, 3, 6], structure: StructuralMaterialType.STEEL });
  await runFinishExitBoundary(steel.graph, steel.project, steel.fmode, { goingToStructure: false });
  assert.equal(partitionWalls(steel.graph).length, 0, '鉄骨の WINDING');
});

// 注: 在来の脱出は構造再計算のエントリを積み、その redo は壁を含む全体を復元する。そのためこのテストは壁エントリ単独の
// redo の値までは守れない——それは下の『redoFns 単体』のテストが守る。
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

// ---- 両端の構造柱（90角。structural/wallFreeEnds.js stairPartitionEnds ＝ woodAutoFill.js の点源）----
// 構造再計算の1パス相当（壁由来の梁芯CL→柱→断面そろえ）。下辺の壁を省いた建物で両端とも自由端にする。
function buildColumns({ bottom = false, floorWidth = null, withPartition = true } = {}) {
  const t = makeStair(EQUAL_UP);
  if (floorWidth) t.graph.setWoodColumnWidthMm(floorWidth);
  addOuterWalls(t.graph, t.V, t.H, { bottom });
  if (withPartition) gen(t.graph);
  const pass = () => {
    autoFillWallBeamAxes(t.graph, selfWallSegments(t.graph));
    const r = autoFillWoodColumns(t.graph, t.project, null);
    conformWoodSections(t.graph, t.project);
    return r;
  };
  pass();
  const colAt = (x, y) => t.graph.columns.find(c => c.verticalCL.effectiveValue === x && c.horizontalCL.effectiveValue === y);
  return { ...t, pass, colAt };
}

test('両端の柱【自由端×2】(1000,1000)(1000,4000) に90角の構造柱が立つ。auto・standard・由来freeEnd・断面 WOOD-90x90・個別柱寸90', () => {
  const { colAt, graph } = buildColumns();
  const ends = stairPartitionEnds(graph);
  assert.deepEqual(ends.map(e => [e.x, e.y, e.free]), [[1000, 1000, true], [1000, 4000, true]], '点源: 両端とも自由端');
  for (const y of [1000, 4000]) {
    const c = colAt(1000, y);
    assert.ok(c, `(1000,${y}) に柱`);
    assert.equal(c.woodColumnWidthMm, 90);
    assert.equal(woodColumnWidthMm(graph, null), 120, '階の柱寸は120のまま');
    assert.equal(c.sectionDefId, 'WOOD-90x90');
    assert.equal(c.role, 'standard');
    assert.equal(c.dimensionStatus, 'auto');
    assert.equal(c.woodColumnOrigins, 'freeEnd');
  }
});

test('両端の柱【冪等】2回目のパスは生成・撤去が空で、個別柱寸・断面・由来は不変', () => {
  const { pass, colAt } = buildColumns();
  const ids = [colAt(1000, 1000).id, colAt(1000, 4000).id];
  const r = pass();
  assert.deepEqual([r.created.length, r.removed.length], [0, 0]);
  assert.deepEqual([colAt(1000, 1000).id, colAt(1000, 4000).id], ids);
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, 90);
  assert.equal(colAt(1000, 4000).sectionDefId, 'WOOD-90x90');
});

test('両端の柱【手動削除】柱を削除すると除外集合に載り、再計算しても復活しない（反対側は残る）', () => {
  const { pass, colAt, graph } = buildColumns();
  graph.removeColumn(colAt(1000, 1000).id);
  pass();
  assert.equal(colAt(1000, 1000), undefined, '復活しない');
  assert.ok(colAt(1000, 4000), '反対側は残る');
});

test('両端の柱【非自由端】上り口側の端に壁がある（T字）と、その端の柱は階の柱寸（個別柱寸null）。他方は90', () => {
  const { colAt, graph } = buildColumns({ bottom: true });
  assert.deepEqual(stairPartitionEnds(graph).map(e => [e.y, e.free]), [[1000, true], [4000, false]]);
  assert.ok(colAt(1000, 4000), '柱は立つ（点源は非自由端でも出す）');
  assert.equal(colAt(1000, 4000).woodColumnWidthMm, null);
  assert.equal(colAt(1000, 4000).sectionDefId, 'WOOD-120x120');
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, 90);
});

test('両端の柱【階の柱寸が90】柱は立ち、個別柱寸は null（階の値と同値を作らない）', () => {
  const { colAt } = buildColumns({ floorWidth: 90 });
  for (const y of [1000, 4000]) {
    assert.ok(colAt(1000, y));
    assert.equal(colAt(1000, y).woodColumnWidthMm, null);
    assert.equal(colAt(1000, y).sectionDefId, 'WOOD-90x90');
  }
});

test('両端の柱【階の柱寸の変更に追従】120→90 で個別柱寸が null に、90→120 で再び90に戻る（書き戻し）', () => {
  const { pass, colAt, graph } = buildColumns();
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, 90);
  graph.setWoodColumnWidthMm(90);
  pass();
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, null, '階=90 なら個別指定は消える');
  graph.setWoodColumnWidthMm(120);
  pass();
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, 90, '階=120 に戻せば90角へ');
  assert.equal(colAt(1000, 1000).sectionDefId, 'WOOD-90x90');
});

test('【失敗系】両端の柱: S造・STRAIGHT・隔て壁なし（2a が受け持つ等）では隔て壁の柱は立たず CL も増えない', () => {
  const base = buildColumns({ withPartition: false });
  assert.equal(base.colAt(1000, 1000), undefined, '隔て壁が無ければ柱なし');
  assert.deepEqual(stairPartitionEnds(base.graph), []);
  // 隔て壁の有無で CL の本数は同じ（点源は CL を作らない）
  assert.equal(clCount(buildColumns().graph), clCount(base.graph), '柱の点源は CL を新設しない');
  // S造: 壁は生成済みでも主構造がS造なら点源は空
  const s = buildColumns();
  s.graph.structureOverride = 'S造';
  assert.deepEqual(stairPartitionEnds(s.graph), []);
  // STRAIGHT: 隔て壁自体が出ない
  const st = makeStair(EQUAL_UP, { type: StairType.STRAIGHT });
  addOuterWalls(st.graph, st.V, st.H, { bottom: false });
  assert.equal(gen(st.graph).length, 0);
  autoFillWallBeamAxes(st.graph, selfWallSegments(st.graph));
  const before = clCount(st.graph); // 梁芯CLの生成後（柱の点源が増やさないことを見る）
  autoFillWoodColumns(st.graph, st.project, null);
  assert.equal(st.graph.columns.some(c => c.verticalCL.effectiveValue === 1000), false);
  assert.equal(clCount(st.graph), before, 'CL を増やさない');
  // 端CL（y=1000）が壁生成の後で補助線になった＝柱のアンカー解決不能な端: その端に柱を立てず CL も作らない（点源側の continue）
  const na = buildColumns({ withPartition: true });
  const endCL = na.graph.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === 1000);
  endCL.lineType = 'dashed';
  na.graph.removeColumn(na.colAt(1000, 1000).id);
  na.graph.excludedColumnSlots.clear();
  const clBefore = clCount(na.graph);
  na.pass();
  assert.equal(na.colAt(1000, 1000), undefined, 'アンカーが解決できない端には柱を立てない');
  assert.ok(na.colAt(1000, 4000), '解決できる端は立つ（前提・検出力）');
  assert.equal(clCount(na.graph), clBefore, 'CL を作らない');
  // 端CLが梁芯だと隔て壁自体が出ない（生成側の規律）
  const noAnchor = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.HORIZONTAL && v === 1000 ? { discipline: Discipline.FUSE } : {}) });
  addOuterWalls(noAnchor.graph, noAnchor.V, noAnchor.H, { bottom: false });
  assert.equal(gen(noAnchor.graph).length, 0);
});

test('2a の差し引きで切れた端（y=2500）には柱を立てず柱包みもしない。線の端（y=4000）だけが端', () => {
  const t = makeStair(EQUAL_UP);
  t.H(2500);
  addOuterWalls(t.graph, t.V, t.H, { bottom: false });
  const ws = gen(t.graph, { underEdges: [{ isVertical: true, value: 1000, lo: 1000, hi: 2500 }] });
  assert.deepEqual(ws.map(w => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)]), [[2500, 4000], [2500, 4000]]);
  assert.deepEqual(stairPartitionEnds(t.graph).map(e => [e.y, e.free]), [[4000, true]], '線端（4000）だけ。2500 は返さない');
  autoFillWallBeamAxes(t.graph, selfWallSegments(t.graph));
  autoFillWoodColumns(t.graph, t.project, null);
  const at = (y) => t.graph.columns.find(c => c.verticalCL.effectiveValue === 1000 && c.horizontalCL.effectiveValue === y);
  assert.equal(at(2500), undefined, '切れた端には柱なし');
  assert.ok(at(4000), '線端には柱');
  wrapStairPartitionFreeEnds(t.graph);
  const owner = ws[0];
  const sgn = Math.sign(owner.clEnd.effectiveValue - owner.clStart.effectiveValue) || 1;
  const [startSide, endSide] = [owner.startOffset, owner.endOffset].map(o => o * sgn);
  assert.equal(owner.clStart.effectiveValue === 2500 ? startSide : endSide, 0, '2500 側は柱包みしない');
});

// ---- 隔て壁の自由端の柱包み（wrapStairPartitionFreeEnds。本番経路で壁が出そろった後に適用）----
const physSpan = (w) => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];

test('本番経路【柱包み】自由端（踊り場側）だけ物理端が端CL−57.5へはね出し、外壁に突き当たる端（上り口側）は延ばさない。2枚とも隔て壁と識別され、構造の壁区間・腰壁の対象に入らない。柱は自由端だけ90角', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const ends = stairPartitionEnds(graph);
  assert.equal(ends.length, 2);
  assert.deepEqual(ends.map(e => [e.y, e.free]), [[1000, true], [4000, false]], '前提: 踊り場側は自由端・上り口側は外壁（y=4000）に突き当たる');
  const parts = partitionWalls(graph);
  assert.equal(parts.length, 2);
  for (const w of parts) {
    assert.deepEqual(physSpan(w), [1000 - 57.5, 4000], '自由端の側だけ端CL−57.5（設計上の端は y1000〜4000 のまま）');
    assert.deepEqual([Math.min(w.clStart.effectiveValue, w.clEnd.effectiveValue), Math.max(w.clStart.effectiveValue, w.clEnd.effectiveValue)], [1000, 4000]);
    assert.equal(isEligibleWallSpan(w, graph), false, '腰壁・垂れ壁の対象外');
  }
  assert.equal(selfWallSegments(graph).some(s => s.isVertical && Math.abs(s.coord - 1000) < 1), false, '構造の壁区間に入らない');
  const cols = graph.columns.filter(c => c.verticalCL.effectiveValue === 1000).map(c => [c.horizontalCL.effectiveValue, c.woodColumnWidthMm]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(cols, [[1000, 90], [4000, null]], '柱は両端に立つが90角は自由端だけ');
});

test('本番経路【柱包み・undo/redo】脱出の undo で隔て壁が消え、redo ではね出し込みの値に戻る', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  assert.deepEqual(partitionWalls(graph).map(physSpan), [[942.5, 4000], [942.5, 4000]], '前提: はね出している');
  undoManager.undo();
  undoManager.undo();
  assert.equal(partitionWalls(graph).length, 0);
  undoManager.redo();
  undoManager.redo();
  assert.deepEqual(partitionWalls(graph).map(physSpan), [[942.5, 4000], [942.5, 4000]], 'redo ではね出し込みの値');
});

test('wrapStairPartitionFreeEnds【冪等・非自由端】2回呼んでも二重に延びない。壁が建つ（T字の）端は延ばさない', () => {
  const { graph } = buildColumns({ bottom: true });
  const first = wrapStairPartitionFreeEnds(graph);
  assert.deepEqual(first.map(c => c.after), [{ startOffset: -57.5, endOffset: 0 }, { startOffset: -57.5, endOffset: 0 }], '自由端（y1000）だけ');
  assert.deepEqual(wrapStairPartitionFreeEnds(graph), [], '2回目は変化なし');
  const [owner] = graph.walls.filter(w => isStairPartitionWall(w, stairPartitionLines(graph)));
  assert.equal(owner.startOffset, -57.5);
  assert.equal(owner.endOffset, 0);
});

test('regenerateWalls【柱包み・redoFns 単体】undoFns を逆順→redoFns を順に実行すると、隔て壁がはね出し込みの値で戻る（構造再計算の復元に頼らない）', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  const { regenerated, undoFns, redoFns } = await regenerateWalls(graph, { materialMap: fmode.materialMap, project, stairUnderEntries: [], extraStairOpenings: [] });
  assert.equal(regenerated, true);
  const wrapped = partitionWalls(graph).map(physSpan);
  assert.deepEqual(wrapped, [[942.5, 4000], [942.5, 4000]], '前提: はね出している');
  [...undoFns].reverse().forEach(f => f());
  assert.equal(partitionWalls(graph).length, 0, 'undo で消える');
  redoFns.forEach(f => f());
  assert.deepEqual(partitionWalls(graph).map(physSpan), wrapped, 'redo ではね出し込みの値');
});

test('2a の差し引きの端が線端から 150mm 以内（y=3900）でも端扱いにしない（線端との一致は 0.5mm）', () => {
  const t = makeStair(EQUAL_UP);
  t.H(3900);
  addOuterWalls(t.graph, t.V, t.H, { bottom: false });
  const ws = gen(t.graph, { underEdges: [{ isVertical: true, value: 1000, lo: 1000, hi: 3900 }] });
  assert.equal(ws.length, 2, '前提: 残り区間 3900〜4000 に2枚');
  assert.deepEqual(stairPartitionEnds(t.graph).map(e => e.y), [4000], '3900 は返さない');
});

test('両端の柱【手動の個別柱寸を守る】端の柱に「この部材」で105を入れて再計算しても105のまま（断面 WOOD-105x105）。null→90 は書く', () => {
  const { pass, colAt } = buildColumns();
  const c = colAt(1000, 1000);
  c.setField('woodColumnWidthMm', 105);
  pass();
  assert.equal(colAt(1000, 1000).woodColumnWidthMm, 105, '明示値は上書きしない');
  assert.equal(colAt(1000, 1000).sectionDefId, 'WOOD-105x105');
  colAt(1000, 4000).setField('woodColumnWidthMm', null); // 点源が入れた値が消えた状態 → 90 を書き戻す
  pass();
  assert.equal(colAt(1000, 4000).woodColumnWidthMm, 90);
});

// ---- 頭つなぎの起点から隔て壁の端の柱を除く（S3'-fix。ユーザー裁定2026-10-07）----
// 1階に隔て壁＋両端の柱、2階に階段の上を囲む壁（x=0/2000・y=0/4000）。2階の autoFillWoodWallBeams を下階の柱で回す。
function buildTwoFloors(exclude) {
  const t = buildColumns({ bottom: true });
  const g2 = t.project.addPlane(3000, '2階', 'p2').graph;
  g2.structureOverride = WOOD;
  const mk = (type, map, v) => map.get(v) ?? map.set(v, g2.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const vs = new Map(), hs = new Map();
  addOuterWalls(g2, (v) => mk(CenterLineType.VERTICAL, vs, v), (v) => mk(CenterLineType.HORIZONTAL, hs, v));
  mk(CenterLineType.HORIZONTAL, hs, 1000); // 2階にも踊り場前縁の分割線CLがある（頭つなぎのアンカー）
  mk(CenterLineType.VERTICAL, vs, 1000); // レーン間中心線（梁の分割点のアンカー）
  // 2階の床（自階フットプリント。頭つなぎの自階ゲートが見る）
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v), H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  g2.addRoom(new Set([[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), '居室');
  autoFillWallBeamAxes(g2, selfWallSegments(g2));
  const pts = exclude ? stairPartitionEnds(t.graph, t.project).map(e => ({ x: e.x, y: e.y })) : [];
  autoFillWoodWallBeams(g2, t.project, selfWallSegments(g2), null, t.graph.columns, undefined, g2, undefined, pts);
  return { ...t, g2 };
}
const beamsOnH = (g, y) => g.beams.filter(b => !b.isVertical && b.axisCL.effectiveValue === y);

test('頭つなぎ【隔て壁の端の柱を起点から除く】2階の y=1000（踊り場前縁）に頭つなぎができない。除外なし（従来）ではできる。上り口辺（y=4000）の梁は下階柱で分割される', () => {
  const withEx = buildTwoFloors(true);
  const without = buildTwoFloors(false);
  assert.ok(beamsOnH(without.g2, 1000).length > 0, '対照（従来）: 頭つなぎができる');
  assert.equal(beamsOnH(withEx.g2, 1000).length, 0, '除外すると頭つなぎができない');
  const split = beamsOnH(withEx.g2, 4000).map(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((a, c) => a - c));
  assert.ok(split.some(([, b]) => b === 1000) && split.some(([a]) => a === 1000), '上り口辺の梁は x=1000 で分割される（フェーズAは除外しない）');
});

test('【失敗系】頭つなぎの除外: 隔て壁の無い下階では除外点が空・柱に一致しない除外点（AXIS座標が許容外）は何も除かず、従来どおり頭つなぎができる', () => {
  const none = buildColumns({ withPartition: false });
  assert.deepEqual(stairPartitionEnds(none.graph, none.project), [], '隔て壁の無い下階では除外点が空');
  // 柱の位置から外れた除外点（1000,1000 から 10mm ずれ）は柱を除かない
  const t = buildColumns({ bottom: true });
  const g2 = t.project.addPlane(3000, '2階', 'p2').graph;
  g2.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, g2.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v), H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  addOuterWalls(g2, V, H); H(1000); V(1000);
  g2.addRoom(new Set([[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), '居室');
  autoFillWallBeamAxes(g2, selfWallSegments(g2));
  autoFillWoodWallBeams(g2, t.project, selfWallSegments(g2), null, t.graph.columns, undefined, g2, undefined, [{ x: 1010, y: 1010 }]);
  assert.ok(beamsOnH(g2, 1000).length > 0);
});

test('受梁【自階の隔て壁の端の柱の下に梁を作らない】隔て壁の柱だけが立つ階では、その柱の下に受梁ができない（柱脚固定。S3\'-fix）', () => {
  const t = buildColumns({ bottom: true });
  const g = t.graph;
  const room = [[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${t.V(x1).id}:${t.H(y1).id}:${t.V(x2).id}:${t.H(y2).id}`);
  g.addRoom(new Set(room), '居室');
  t.V(1000);
  autoFillWallBeamAxes(g, selfWallSegments(g));
  autoFillWoodWallBeams(g, t.project, selfWallSegments(g), null, []);
  assert.ok(t.colAt(1000, 1000), '前提: 隔て壁の端の柱が立つ');
  assert.equal(g.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 1000), false, '柱の下の受梁ができない');
});

test('頭つなぎ【配線】本番の入口 autoFillStructuralGrid（belowGraph を渡す。structuralRecompute.js と同じ呼び方）でも、2階の踊り場前縁に頭つなぎができない', () => {
  const t = buildColumns({ bottom: true });
  const g2 = t.project.addPlane(3000, '2階', 'p2').graph;
  g2.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, g2.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v), H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  addOuterWalls(g2, V, H); H(1000); V(1000);
  g2.addRoom(new Set([[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`)), '居室');
  autoFillWallBeamAxes(g2, selfWallSegments(g2));
  autoFillStructuralGrid(g2, t.project, WOOD, null, [], selfWallSegments(g2), [], t.graph.columns, [], undefined, undefined, undefined, [], t.graph);
  assert.ok(g2.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 4000), '前提: 梁の生成は走っている');
  assert.equal(g2.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 1000), false, '踊り場前縁の頭つなぎができない');
});

test('頭つなぎ【屋根経路の配線】屋根専用平面で belowGraph＝最上階（隔て壁あり）のとき、屋根の梁（structuralAutoFill.js の wallRuns 経路）でも隔て壁の柱は頭つなぎの起点にならない', () => {
  const t = buildColumns({ bottom: true });
  const top = t.graph;
  top.addRoom(new Set([[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${t.V(x1).id}:${t.H(y1).id}:${t.V(x2).id}:${t.H(y2).id}`)), '居室');
  t.V(1000);
  const roof = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 2, 1, false, null, 0, true, 'p1'));
  roof.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, roof.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  for (const v of [0, 1000, 2000]) mk(CenterLineType.VERTICAL, vs, v);
  for (const v of [0, 1000, 4000]) mk(CenterLineType.HORIZONTAL, hs, v);
  const segs = selfWallSegments(top);
  autoFillStructuralGrid(roof, t.project, WOOD, null, [], segs, [], top.columns, [], buildSelfFootprintGate(top), top, undefined, [], top);
  assert.ok(roof.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 4000), '前提: 屋根の梁（軒桁）の生成が走っている');
  assert.equal(roof.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 1000), false, '踊り場前縁に頭つなぎができない');
});

test('受梁【対照】同じ構成から隔て壁を外し、同位置に通常の柱を置くと y=1000 に受梁ができる（上のテストの除外が効いている証拠）', () => {
  const t = buildColumns({ bottom: true, withPartition: false });
  const g = t.graph;
  g.addRoom(new Set([[0, 0, 2000, 1000], [0, 1000, 2000, 4000]].map(([x1, y1, x2, y2]) => `${t.V(x1).id}:${t.H(y1).id}:${t.V(x2).id}:${t.H(y2).id}`)), '居室');
  t.V(1000);
  g.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', t.V(1000), t.H(1000), {});
  autoFillWallBeamAxes(g, selfWallSegments(g));
  autoFillWoodWallBeams(g, t.project, selfWallSegments(g), null, []);
  assert.equal(g.beams.some(b => !b.isVertical && b.axisCL.effectiveValue === 1000 && b.beamType === '受梁'), true);
});
