// probeColumn の**多層（3層以上）一般化**と、平面によらず成り立つべき不変条件のテスト。
//
// 課題「修正を繰り返すが、行った修正が他の図面に対しても有効であるのか判定できない」への回答。
// 個別の図面の期待値（sectionProbe.test.js / elevationSectionGolden.test.js）とは別に、
// **どの平面・どの層構成でも成り立つ性質**をここで固定する:
//   INV1 bandsは zRange を隙間なく重なりなく覆う（z0<z1・昇順・端はzRangeちょうど）
//   INV2 cut.layers の並び順を変えても結果は完全に一致する（役割名・配列順に依存しない）
//   INV3 同じ入力を2回プローブすれば同じ結果になる（キャッシュ経由の副作用が無い）
// 旧実装は INV2 を満たしていなかった（`find(role!=='self' && floorZMm<=z)`が配列順で最初の
// 一致を返す・`find(role==='above')`が3層目を無視する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext, probeColumn } from './sectionProbe.js';
import { buildCutContent, withProbeExtension } from './sectionContent.js';
import { baseLayerOf, orderLayerStack } from './sectionLayerStack.js';
import { GAP_EPS_MM as GAP_EPS, UPPER_PLANE_OVERHANG_LIMIT_MM,
  ElevationLineRole, weightForRole } from '../elevationStyle.js';

const CH = 2400;         // DEFAULT_ROOM_CEILING_HEIGHT（core/constants.js）
const FLOOR_HEIGHT = 2900; // 階高

function makeGraph(id, level, name) {
  return new PlanGraph(new Plane(id, level, name, 1, 1));
}

function addRect(graph, x0v, y0v, x1v, y1v, name, { walls = false, feature = null } = {}) {
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, x0v), x1 = cl(CenterLineType.VERTICAL, x1v);
  const y0 = cl(CenterLineType.HORIZONTAL, y0v), y1 = cl(CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  if (feature) room.setFeature(feature);
  if (walls) generateRoomWallsFromOutline(graph, room);
  return room;
}

// 上り口(y=0)に立ってy増加方向（奥の壁y=3000）を見る、3層構成の切断。
function stackedCut(layers, hiZ) {
  return {
    seqNo: '1',
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1,
    dirSign: 1,
    layers,
    zRange: { loZ: 0, hiZ },
    baseFloorZ: 0,
  };
}

// 3層（自階＋上階＋上々階）の層リテラル。上2層のfeatureを差し替えて構成を作り分ける。
function threeLayers({ aboveFeature, above2Feature, selfWalls = true, upperWalls = false }) {
  const self = makeGraph('p1', 0, '1階');
  addRect(self, 0, 0, 4000, 3000, '階段室', { walls: selfWalls });
  const above = makeGraph('p2', FLOOR_HEIGHT, '2階');
  addRect(above, 0, 0, 4000, 3000, aboveFeature ? '吹抜け' : '洋室', { walls: upperWalls, feature: aboveFeature });
  const above2 = makeGraph('p3', FLOOR_HEIGHT * 2, '3階');
  addRect(above2, 0, 0, 4000, 3000, above2Feature ? '吹抜け' : '洋室', { walls: upperWalls, feature: above2Feature });
  return [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: above, floorZMm: FLOOR_HEIGHT, role: 'above' },
    { graph: above2, floorZMm: FLOOR_HEIGHT * 2, role: 'above2' },
  ];
}

const TOP_Z = FLOOR_HEIGHT * 2 + CH; // 3層ぶんの上端 = 8200

// ---- 見えがかり壁のz上限: 吹抜けが続く限り登る ----
test('【多層】probeColumn: 上2層とも吹抜けなら見えがかり壁は最上層の天井まで続く（旧実装は上階1段で止まっていた）', () => {
  const layers = threeLayers({ aboveFeature: RoomFeature.VOID, above2Feature: RoomFeature.VOID });
  const cut = stackedCut(layers, TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext(layers));

  const wallTop = Math.max(...bands.filter(b => b.kind === 'wall').map(b => b.z1));
  assert.equal(wallTop, TOP_Z, `吹抜けが2層続くなら最上層の天井(${TOP_Z})まで続くはず（実際:${wallTop}）`);
  assert.ok(!bands.some(b => b.kind === 'wall' && Math.abs(b.z1 - (FLOOR_HEIGHT + CH)) < GAP_EPS),
    '2階天井高さちょうどで終わる壁帯（旧実装が残していた誤った水平キャップ線の元）が無いこと');
});

// ユーザー明示指示2026-08の点4「天井から上階FLまでの間にある面も『壁』扱い」: 壁は天井では
// 終わらず上階の床まで立つ。したがってキャップ位置は「実床のある層のFL」であって天井ではない。
test('【多層】probeColumn: 吹抜けは通り抜け、実床のある層のFLで見えがかり壁がキャップされる', () => {
  const layers = threeLayers({ aboveFeature: RoomFeature.VOID, above2Feature: null });
  const cut = stackedCut(layers, TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext(layers));

  const wallTop = Math.max(...bands.filter(b => b.kind === 'wall').map(b => b.z1));
  assert.equal(wallTop, FLOOR_HEIGHT + CH,
    `2階は吹抜けなので通り抜けるが、その天井(${FLOOR_HEIGHT + CH})より上は3階の床に隠れる（実際:${wallTop}）`);
});

test('【多層・明示指示2026-08で更新】probeColumn: 直上に実床があれば自階の天井で切れる', () => {
  const layers = threeLayers({ aboveFeature: null, above2Feature: RoomFeature.VOID });
  const cut = stackedCut(layers, TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext(layers));

  const wallTop = Math.max(...bands.filter(b => b.kind === 'wall').map(b => b.z1));
  // 上階に実床があれば、その手前の**自層の天井**で見えがかりは終わる（ユーザー実機指摘2026-08
  // 「「5」D1: 1F天井見えがかり（細線）が…1FL天井断面に衝突するまで」）。天井裏にも壁の実体は
  // あるが、見えがかりは**見えるもの**だけで、天井に隠れて見えない。点4「天井裏も壁」は
  // 上が吹抜けで壁が実際に見え続ける場合の規則としてそのまま残る（下のVOIDのテスト）。
  assert.equal(wallTop, CH, `自階の天井(${CH})まで（実際:${wallTop}）`);
  assert.ok(bands.some(b => b.kind === 'slab' && Math.abs(b.z0 - CH) < GAP_EPS),
    '天井〜上階FLは天井懐(slab・非描画)になる');
});

// ---- slab/open の所有層: 「その高さを所有する層」で決める ----
test('【多層】probeColumn: 2階が吹抜け・3階が実Roomなら、2階の高さはopen・3階の高さはslabになる', () => {
  // 壁を作らない構成にして、壁候補に隠れないslab/open帯そのものを見る。
  const layers = threeLayers({
    aboveFeature: RoomFeature.VOID, above2Feature: null, selfWalls: false,
  });
  const cut = stackedCut(layers, TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext(layers));

  const kindAt = z => bands.find(b => z > b.z0 - GAP_EPS && z < b.z1 + GAP_EPS)?.kind;
  assert.equal(kindAt(CH + 100), 'slab', '自階天井と2FLの間は天井懐＝slab（非描画）');
  assert.equal(kindAt(FLOOR_HEIGHT + 100), 'open', '2階は吹抜け＝open（アキX判定の対象）');
  assert.equal(kindAt(FLOOR_HEIGHT * 2 + 100), 'slab',
    '3階には実Roomがあるのでslab。旧実装は配列順で最初に見つかる2階(VOID)を掴みopenにしていた');
});

test('【多層】probeColumn: 上2層とも吹抜けなら自階天井より上は（懐を除き）すべてopen', () => {
  const layers = threeLayers({
    aboveFeature: RoomFeature.VOID, above2Feature: RoomFeature.STAIR_VOID, selfWalls: false,
  });
  const cut = stackedCut(layers, TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext(layers));

  const aboveCeil = bands.filter(b => b.z0 >= FLOOR_HEIGHT - GAP_EPS);
  assert.ok(aboveCeil.length > 0, '2FL以上の帯があるはず');
  assert.ok(aboveCeil.every(b => b.kind === 'open'),
    `2FL以上はすべてopenのはず（実際:${JSON.stringify(aboveCeil.map(b => b.kind))}）`);
});

// ---- 不変条件（どの層構成・どの図面でも成り立つべき性質） ----
const INVARIANT_CASES = [
  ['3層・吹抜け2層', { aboveFeature: RoomFeature.VOID, above2Feature: RoomFeature.VOID }],
  ['3層・上々階のみ実Room', { aboveFeature: RoomFeature.VOID, above2Feature: null }],
  ['3層・上階のみ実Room', { aboveFeature: null, above2Feature: RoomFeature.VOID }],
  ['3層・全層実Room', { aboveFeature: null, above2Feature: null }],
  ['3層・壁なし', { aboveFeature: RoomFeature.VOID, above2Feature: null, selfWalls: false }],
  ['3層・上階にも壁', { aboveFeature: RoomFeature.VOID, above2Feature: null, upperWalls: true }],
];

// band識別用の正規化（wall/roomはオブジェクト参照のため名前・軸位置へ落とす）。
function normalize(bands) {
  return bands.map(b => ({
    kind: b.kind, z0: b.z0, z1: b.z1, layerRole: b.layerRole ?? null, distMm: b.distMm ?? null,
    wallAxis: b.wall ? b.wall.axisCL.effectiveValue : null,
    ownerRoom: b.ownerRoom ? b.ownerRoom.name : null,
  }));
}

for (const [label, spec] of INVARIANT_CASES) {
  test(`【不変条件INV1】probeColumn(${label}): bandsはzRangeを隙間なく重なりなく覆う`, () => {
    const layers = threeLayers(spec);
    const cut = stackedCut(layers, TOP_Z);
    for (const worldMid of [500, 2000, 3500]) {
      const bands = probeColumn(cut, worldMid, makeProbeContext(layers));
      assert.ok(bands.length > 0, `x=${worldMid}: 帯が1本も無いのは不正`);
      assert.equal(bands[0].z0, 0, `x=${worldMid}: 先頭はzRange.loZから始まるはず`);
      assert.equal(bands[bands.length - 1].z1, TOP_Z, `x=${worldMid}: 末尾はzRange.hiZで終わるはず`);
      for (let i = 0; i < bands.length; i++) {
        assert.ok(bands[i].z1 - bands[i].z0 > GAP_EPS, `x=${worldMid}: 退化した帯(${JSON.stringify(bands[i])})`);
        if (i > 0) {
          assert.ok(Math.abs(bands[i - 1].z1 - bands[i].z0) < GAP_EPS,
            `x=${worldMid}: 帯${i - 1}と${i}の間に隙間/重なり（${bands[i - 1].z1} vs ${bands[i].z0}）`);
        }
      }
    }
  });

  test(`【不変条件INV2】probeColumn(${label}): cut.layersの並び順を変えても結果は完全に一致する`, () => {
    const layers = threeLayers(spec);
    const expected = normalize(probeColumn(stackedCut(layers, TOP_Z), 2000, makeProbeContext(layers)));
    // 3層の全順列（6通り）で同一結果になること。役割名も配列順も答えに影響してはいけない。
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const perm of perms) {
      const shuffled = perm.map(i => layers[i]);
      const actual = normalize(probeColumn(stackedCut(shuffled, TOP_Z), 2000, makeProbeContext(shuffled)));
      assert.deepEqual(actual, expected, `並び[${perm}]で結果が変わった（層の並び順に依存している）`);
    }
  });

  test(`【不変条件INV3】probeColumn(${label}): 同じ入力を2回プローブすれば同じ結果になる`, () => {
    const layers = threeLayers(spec);
    const cut = stackedCut(layers, TOP_Z);
    const probeCtx = makeProbeContext(layers); // キャッシュを共有したまま2回呼ぶ
    assert.deepEqual(
      normalize(probeColumn(cut, 2000, probeCtx)),
      normalize(probeColumn(cut, 2000, probeCtx)),
      'プローブコンテキストのキャッシュが結果を汚染している',
    );
  });
}

// ---- 失敗系 ----
test('【失敗系】probeColumn: 層が0件でも例外を投げず、zRange全域の単一open帯を返す', () => {
  const cut = stackedCut([], TOP_Z);
  const bands = probeColumn(cut, 2000, makeProbeContext([]));
  assert.deepEqual(bands, [{ kind: 'open', z0: 0, z1: TOP_Z }]);
});

// ---- 層ごとの探査窓: 面の端は層ごとに違う（ユーザー実機指摘2026-09「「6」D2: 2階Y2から3500には
// 「21」の壁エッジが左側に見える」。自階の面は自階の壁で終わるが、同じ通りの上階の壁はその先へ続く） ----

// 自階＋上階の2層。上階の部屋だけ北へoverhangMmぶん長く、同じ通り（x=0）の上階の壁が
// 自階の面の端よりoverhangMmだけ外へ続く（実データ「6」D2と同じ形）。
function twoLayersWithUpperOverhang(overhangMm) {
  const self = makeGraph('p1', 0, '1階');
  addRect(self, 0, 0, 3000, 3000, '階段室', { walls: true });
  const above = makeGraph('p2', FLOOR_HEIGHT, '2階');
  addRect(above, 0, 0, 3000, 3000 + overhangMm, '洋室', { walls: true });
  return [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: above, floorZMm: FLOOR_HEIGHT, role: 'above' },
  ];
}

// x=0の壁を室内(x=750の切断線)から見る面。**ローカルx=0は世界のhi側**（dirSign=-1。実データの
// D2と同じ向き）なので、上階のはみ出しはローカルの負側（x=-overhang）に現れる。
function facingCut(layers) {
  const selfGraph = layers.find(l => l.role === 'self').graph;
  const wall = [...selfGraph.walls].find(w => w.isVertical && Math.abs(w.axisCL.effectiveValue) < 1);
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  const face = {
    isVertical: true, inward: 1, axisCL: { effectiveValue: 0 }, lo, hi, run: hi - lo, dirSign: -1,
    hasWallAtLocal0: true, hasWallAtLocalRun: true,
  };
  return {
    seqNo: 'D', face, line: { isVertical: true, axisValue: 750, lo, hi },
    viewSign: -1, dirSign: -1, layers, zRange: { loZ: 0, hiZ: FLOOR_HEIGHT + CH }, baseFloorZ: 0,
  };
}

const UPPER_CEIL_Z = FLOOR_HEIGHT + CH;
const xsOf = p => (p.type === 'polyline' ? p.points.map(q => q[0]) : [p.x1, p.x2]);

test('【探査窓】buildCutContent: 上階の壁が面の端より外へ続く区間に、上階の壁エッジ（中線）が1本だけ出る', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers);
  const { cut: pcut, content } = buildCutContent(cut, makeProbeContext(layers),
    { upperPlaneOverhang: true });

  const win = pcut.layerRunWindows.get(layers[1]);
  assert.equal(win.hi - cut.line.hi, 160, '上階の窓は面の端より160外まで（層ごとの探査窓）');
  assert.equal(pcut.layerRunWindows.get(layers[0]).hi, cut.line.hi, '自階の窓は面の端のまま');

  const edges = content.filter(p => p.type === 'line' && p.x1 === p.x2 && p.x1 < -GAP_EPS);
  assert.equal(edges.length, 1, `はり出し区間の縦線は1本のはず（実際:${JSON.stringify(edges)}）`);
  const [edge] = edges;
  assert.equal(edge.x1, -160, '壁エッジは上階の壁が終わる位置（ローカル-160）');
  assert.equal(Math.max(edge.y1, edge.y2), -FLOOR_HEIGHT, '下端は上階のFL');
  assert.equal(Math.min(edge.y1, edge.y2), -UPPER_CEIL_Z, '上端は上階の天井');
  assert.equal(edge.weight, weightForRole(ElevationLineRole.SILHOUETTE), '見えがかりの直近＝中線');

  // はり出し区間に出てよいのはこの縦線だけ——水平線（上階FL・天井は図側が描く）・アキのバツ・
  // 自階の壁断面が入り込んでいないこと。
  const others = content.filter(p => p !== edge && Math.min(...xsOf(p)) < -GAP_EPS);
  assert.deepEqual(others, [], `はり出し区間に余分な線がある（${JSON.stringify(others)}）`);
});

test('【探査窓】はり出し区間の列には、平面が届いていない層は現れない（壁候補だけでなく床天井の分類も）', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers);
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  const bands = probeColumn(pcut, cut.line.hi + 80, makeProbeContext(layers));

  // 自階の平面が無い位置なので、層スタックに残るのは上階だけ。
  // 自階を層スタックに残すと、そこは所有Room不明の空間＝アキ(open)になり、面の外にアキのバツが出る。
  assert.ok(bands.every(b => b.kind !== 'open'),
    `はり出し区間にアキは無いはず（実際:${JSON.stringify(bands.map(b => b.kind))}）`);
  assert.ok(bands.every(b => b.layerRole == null || b.layerRole === 'above'),
    '自階の帯が混ざらないこと');
});

// T5（QA指摘2026-09）: 旧実装はここを「上階FLより下＝上階の床構造(slab)」としていた
// （baseLayerOfが上階を返すため、自階向けの分類規則がそのまま当たっていた）。実データ「6」Cでは
// はり出し列の地面〜2FLが丸ごとslabになり、そのslabが面の中の走りと同じzでペアになって
// 2FL中線が面の中へ侵入していた。そこは面の外＝未探査であって、床構造ではない。
test('【探査窓】窓で自階が落ちた列では、その列に実在する層の床（floorZMm）より下に帯が無い', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers);
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  const bands = probeColumn(pcut, cut.line.hi + 80, makeProbeContext(layers));

  const below = bands.filter(b => b.z0 < FLOOR_HEIGHT - GAP_EPS);
  assert.deepEqual(below, [],
    `上階FL(${FLOOR_HEIGHT})より下は未探査＝帯を作らないはず（実際:${JSON.stringify(below)}）`);
  assert.equal(bands[0].z0, FLOOR_HEIGHT, '帯はその列に実在する層の床から始まる');

  // 自階が残っている（＝窓の内側の）列は従来どおりzRangeの下端から覆う。
  const inside = probeColumn(pcut, (cut.line.lo + cut.line.hi) / 2, makeProbeContext(layers));
  assert.equal(inside[0].z0, 0, '面の中の列は従来どおりzRange.loZから');
});

// 指摘6（QA指摘2026-09。主張をQA再指摘2026-09で書き換え）: `sectionContent.js`の
// `layerRunWindowsOf`は自階を`layer.role==='self'`で引くが、`sectionLayerStack.js`は
// 「role名で層を引かない／floorZMmで一意」を規約にしている。
// 旧テストはこの2つを「role==='self'の層は必ずfloorZMm最小」で結び付けていたが、**それは
// 下向きスタック（吹抜け帯: self=0・below=-2900）で成り立たない**——下階を積む帯では自階が
// floorZMm最小ではない（`baseLayerOf`が使う一般規則も「最小」ではなく「**|floorZMm|最小**＝
// z原点＝帯のFLに最も近い層」で、`sectionTypes.js`の契約そのもの）。
// 正しい主張はこう: `layerRunWindowsOf`の自階判定は**出自**（呼び出し側が自分の階として渡した
// 層はどれか）で行うので、順序で決まるbase層と一致しなくても正しい。固定するのは
// 「どの向きのスタックでも自階の窓は面の端そのまま（＝自階の探査範囲・出力は不変）」。
test('【探査窓】layerRunWindowsOfの自階判定はrole（出自）で行う——上向き・下向きどちらのスタックでも自階の窓は面の端のまま', () => {
  // 下向き2層（吹抜け帯）の層リテラルはgateの節の`twoLayersWithLowerOverhang`（下記）を再利用する。
  const cases = [
    ['上向き2層', twoLayersWithUpperOverhang(160)],
    ['上向き3層', threeLayers({ aboveFeature: null, above2Feature: null })],
    ['下向き2層（吹抜け帯）', twoLayersWithLowerOverhang(160)],
  ];
  for (const [label, layers] of cases) {
    const self = layers.find(l => l.role === 'self');
    assert.ok(self, `${label}: self層があること`);
    const cut = facingCut(layers);
    const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
    assert.deepEqual(pcut.layerRunWindows.get(self), { lo: cut.line.lo, hi: cut.line.hi },
      `${label}: 自階の窓は面の端そのまま（自階の探査範囲は広げない＝出力不変）`);
    // base層（`|floorZMm|`最小というrole名を見ない一般規則）は**順序**の答え。下向きスタックでは
    // 「floorZMm最小」ではないことを併せて固定する（旧テストの前提が誤りだった点）。
    const base = baseLayerOf(orderLayerStack(layers.map(layer => ({
      layer, room: null, floorZ: layer.floorZMm, ceilZ: layer.floorZMm + CH,
    }))));
    const nearestZ = Math.min(...layers.map(l => Math.abs(l.floorZMm)));
    assert.equal(Math.abs(base.layer.floorZMm), nearestZ,
      `${label}: baseLayerOfはz原点に最も近い層を指す（floorZMm最小ではない）`);
  }
});

test('【失敗系】下向きスタックでは「role==="self"の層はfloorZMm最小」が成り立たない（旧テストの誤った前提）', () => {
  const layers = twoLayersWithLowerOverhang(160);
  const self = layers.find(l => l.role === 'self');
  assert.notEqual(self.floorZMm, Math.min(...layers.map(l => l.floorZMm)),
    '自階(0)より下に下階(-2900)が積まれる＝自階はfloorZMm最小ではない');
  // それでもbaseLayerOf（|floorZMm|最小）は自階を指す——2つの機構は食い違っていない。
  const base = baseLayerOf(orderLayerStack(layers.map(layer => ({
    layer, room: null, floorZ: layer.floorZMm, ceilZ: layer.floorZMm + CH,
  }))));
  assert.equal(base.layer, self, 'baseLayerOfはz原点に最も近い層＝自階を指す');
});

test('【失敗系・探査窓】上階の壁が面の端ちょうどで終わるなら、探査窓は広がらず出力は延長なしと完全一致', () => {
  const layers = twoLayersWithUpperOverhang(0);
  const cut = facingCut(layers);
  const probeCtx = makeProbeContext(layers);
  const withWindows = buildCutContent(cut, probeCtx, { upperPlaneOverhang: true });
  const without = buildCutContent(cut, probeCtx, {});
  assert.equal(withWindows.cut.layerRunWindows.get(layers[1]).hi, cut.line.hi, '窓は広がらない');
  assert.deepEqual(withWindows.content, without.content);
});

test('【失敗系・探査窓】はみ出しが上限を超える面では何も足さない（全か無か）', () => {
  const over = UPPER_PLANE_OVERHANG_LIMIT_MM + 100;
  const layers = twoLayersWithUpperOverhang(over);
  const cut = facingCut(layers);
  const probeCtx = makeProbeContext(layers);
  const withWindows = buildCutContent(cut, probeCtx, { upperPlaneOverhang: true });
  const without = buildCutContent(cut, probeCtx, {});
  assert.equal(withWindows.cut.layerRunWindows.get(layers[1]).hi, cut.line.hi,
    `${over}mmは上限${UPPER_PLANE_OVERHANG_LIMIT_MM}mm超なので窓を広げない`);
  assert.deepEqual(withWindows.content, without.content, '途中で切らず、はり出しを一切描かない');
});

// T6（QA指摘2026-09）: オプトインの既定off（opts省略）が「現行と完全同一」であることを、
// 出力ではなくcutの形そのもので固定する——layerRunWindowsもunionExtend*も載らないこと。
test('【失敗系・探査窓】withProbeExtension(opts省略)は探査窓もunionExtendも載せない＝現行と完全同一', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers);
  const plain = withProbeExtension(cut, 150, null);
  assert.equal(plain.layerRunWindows, undefined, '層ごとの探査窓は載らない');
  assert.equal(plain.line.unionExtendLoMm, undefined, 'unionExtendLoMmは載らない');
  assert.equal(plain.line.unionExtendHiMm, undefined, 'unionExtendHiMmは載らない');
  // 明示offも同じ（opts自体の有無で挙動が変わらない）。
  assert.deepEqual(withProbeExtension(cut, 150, null, { upperPlaneOverhang: false }), plain);
  // 壁のある両端の面では体裁の延長も付かない＝bandRoomBounds以外は入力そのまま。
  assert.deepEqual(plain, { ...cut, bandRoomBounds: null });

  // 壁のない端部（体裁の探査延長が付く）でも、載るのはprobeExtendだけ。
  const openEnd = { ...cut, face: { ...cut.face, hasWallAtLocal0: false } };
  const ext = withProbeExtension(openEnd, 150, null);
  assert.equal(ext.layerRunWindows, undefined, '層ごとの探査窓は載らない');
  assert.equal(ext.line.unionExtendHiMm, undefined, 'unionExtendHiMmは載らない');
  assert.equal(ext.line.probeExtendHiMm, 150, '体裁の探査延長は従来どおり付く');
});

test('【失敗系・探査窓】壁のない端部（はり出しは体裁の延長）の側には層ごとの窓を広げない', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const base = facingCut(layers);
  // ローカルx=0側（世界のhi側＝上階がはみ出している側）に壁が無い面にする。
  const cut = { ...base, face: { ...base.face, hasWallAtLocal0: false } };
  const pcut = withProbeExtension(cut, 150, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi + 150,
    '壁のない端では体裁の探査延長(150)だけ＝平面照合のはり出しは足さない');
});

// ---- gate: その層の空間がその端で見えている端だけ広げる（ユーザー裁定2026-09。吹抜け帯への拡張）----
// 上部吹抜けを持つ部屋帯は`ceilProfile`を渡す＝端区間の天井断面高さが分かる。吹抜けが面の端に
// 達していない端（＝天井がその層の床より下）で上階の平面だけ外へ伸ばすと、閉じる線の無い突起に
// なるため広げない。`ceilProfile`を渡さない帯（階段帯）は素通り＝従来どおり。
// facingCutはdirSign=-1なので、上階のはみ出しは**ローカルx=0側**（世界のhi側）に現れる。

test('【探査窓gate】端区間の天井断面がその層の床より上（＝吹抜けが端に達している）なら窓が広がる', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const base = facingCut(layers);
  const cut = { ...base, ceilProfile: [{ loX: 0, hiX: base.face.run, ceilZ: UPPER_CEIL_Z }] };
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi + 160,
    `端の天井${UPPER_CEIL_Z}は上階の床${FLOOR_HEIGHT}より上＝gateを通る`);
});

test('【失敗系・探査窓gate】端区間の天井断面がその層の床より下なら窓は広がらない（吹抜けでない端）', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const base = facingCut(layers);
  // 端区間（ローカルx=0側）だけ自階の天井、内側は上階の天井——**端の区間**で判定することの確認。
  const cut = { ...base, ceilProfile: [
    { loX: 0, hiX: 1000, ceilZ: CH },
    { loX: 1000, hiX: base.face.run, ceilZ: UPPER_CEIL_Z },
  ] };
  const probeCtx = makeProbeContext(layers);
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi,
    `端の天井${CH}は上階の床${FLOOR_HEIGHT}より下＝gateで止まる`);
  const withWindows = buildCutContent(cut, probeCtx, { upperPlaneOverhang: true });
  const without = buildCutContent(cut, probeCtx, {});
  assert.deepEqual(withWindows.content, without.content, 'はり出しの線は1本も出ない');
});

test('【失敗系・探査窓gate】ceilProfileを持たない帯（階段帯）はgate素通り＝従来どおり窓が広がる', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers); // ceilProfile未指定
  assert.equal(cut.ceilProfile, undefined, '階段帯のcutはceilProfileを持たない（前提）');
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi + 160,
    'gateの材料が無い帯では従来どおり広げる（階段帯を不変に保つ）');
});

// ---- gateの鏡像: 下階の層（吹抜け帯）は「帯の床断面がその層の天井より下」の端だけ ----
// 材料は`floorZProfile`（`ceilProfile`の床側の双子）と`layer.ceilZMm`。上下の判別はroleではなく
// 自階の層とのfloorZMmの大小（`layerRunWindowsOf`）。

// 自階（2階の吹抜け）＋下階。下階の部屋だけ北へoverhangMmぶん長い＝同じ通りの1階の壁が
// 面の端より外へ続く。
function twoLayersWithLowerOverhang(overhangMm) {
  const self = makeGraph('p2', FLOOR_HEIGHT, '2階');
  addRect(self, 0, 0, 3000, 3000, '吹抜け', { walls: true });
  const below = makeGraph('p1', 0, '1階');
  addRect(below, 0, 0, 3000, 3000 + overhangMm, 'LDK', { walls: true });
  return [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: below, floorZMm: -FLOOR_HEIGHT, role: 'below', ceilZMm: -FLOOR_HEIGHT + CH },
  ];
}

// 下へ伸びる帯のcut（zRangeの下端は下階のFL）。floorZは端区間の床断面高さ。
function descendingCut(layers, floorZ) {
  const base = facingCut(layers);
  return { ...base,
    zRange: { loZ: -FLOOR_HEIGHT, hiZ: CH }, baseFloorZ: -FLOOR_HEIGHT,
    ceilProfile: [{ loX: 0, hiX: base.face.run, ceilZ: CH }],
    floorZProfile: [{ loX: 0, hiX: base.face.run, floorZ }] };
}

test('【探査窓gate】端区間の床断面がその層の天井より下（＝下階の空間が端で見えている）なら窓が広がる', () => {
  const layers = twoLayersWithLowerOverhang(160);
  const cut = descendingCut(layers, -FLOOR_HEIGHT); // その端で下階のFLまで下りている
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi + 160,
    `端の床${-FLOOR_HEIGHT}は下階の天井${-FLOOR_HEIGHT + CH}より下＝gateを通る`);
  assert.equal(pcut.layerRunWindows.get(layers[0]).hi, cut.line.hi, '自階の窓は面の端のまま');
});

test('【失敗系・探査窓gate】端区間の床断面が下階の天井より上（＝下階に下りていない端）なら窓は広がらない', () => {
  const layers = twoLayersWithLowerOverhang(160);
  const cut = descendingCut(layers, 0); // その端は設置階の床のまま（下階に同じ壁が無い区間）
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  assert.equal(pcut.layerRunWindows.get(layers[1]).hi, cut.line.hi,
    `端の床0は下階の天井${-FLOOR_HEIGHT + CH}より上＝gateで止まる`);
});

test('【失敗系・探査窓gate】下階の層に天井z（ceilZMm）が無ければgate素通り（材料が無い層を帯が渡さないのが防波堤）', () => {
  const layers = twoLayersWithLowerOverhang(160);
  const noCeil = [layers[0], { ...layers[1], ceilZMm: undefined }];
  const cut = descendingCut(noCeil, -FLOOR_HEIGHT);
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  // layerBoundaryZが非有限＝gate素通り（`planeOverhangForFace`の契約）。**帯側は材料が無ければ
  // オプトインしない**（elevationVoid.jsのbuildVoidBand）ので、実際にここへ来ることはない。
  assert.equal(pcut.layerRunWindows.get(noCeil[1]).hi, cut.line.hi + 160,
    '式の契約としては素通り（帯側でオプトインを止める、が実装の防波堤）');
});

test('【探査窓】層ごとの窓があっても不変条件INV1（zRangeを隙間なく覆う）・INV3（再現性）を満たす', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const cut = facingCut(layers);
  const probeCtx = makeProbeContext(layers);
  const pcut = withProbeExtension(cut, 0, null, { upperPlaneOverhang: true });
  const midInOverhang = cut.line.hi + 80; // はり出し区間の中（自階の平面は無い）
  for (const worldMid of [cut.line.lo + 100, (cut.line.lo + cut.line.hi) / 2, midInOverhang]) {
    const bands = probeColumn(pcut, worldMid, probeCtx);
    // INV1の下端は「その列で探査できた最下層の床」——はり出し列（自階が窓で落ちた列）では
    // 上階のFLがそれに当たり、その下は面の外＝未探査で帯を作らない（QA指摘2026-09）。
    const bottomZ = worldMid > cut.line.hi + GAP_EPS ? FLOOR_HEIGHT : 0;
    assert.equal(bands[0].z0, bottomZ, `x=${worldMid}: 先頭は探査できた最下層の床から`);
    assert.equal(bands[bands.length - 1].z1, UPPER_CEIL_Z, `x=${worldMid}: 末尾はzRange.hiZまで`);
    for (let i = 1; i < bands.length; i++) {
      assert.ok(Math.abs(bands[i - 1].z1 - bands[i].z0) < GAP_EPS,
        `x=${worldMid}: 帯${i - 1}と${i}の間に隙間/重なり`);
    }
    assert.deepEqual(normalize(probeColumn(pcut, worldMid, probeCtx)), normalize(bands),
      `x=${worldMid}: 2回目の結果が違う（キャッシュ汚染）`);
  }
});

test('【探査窓】INV2: 層の並び順を変えても窓つきの結果は完全に一致する', () => {
  const layers = twoLayersWithUpperOverhang(160);
  const worldMid = facingCut(layers).line.hi + 80;
  const runWith = ls => {
    const pcut = withProbeExtension(facingCut(ls), 0, null, { upperPlaneOverhang: true });
    return normalize(probeColumn(pcut, worldMid, makeProbeContext(ls)));
  };
  assert.deepEqual(runWith([layers[1], layers[0]]), runWith(layers),
    '層の並び順に依存している（roleは出自の情報であって順序ではない）');
});

test('【失敗系】probeColumn: 切断線が部屋の外（所有Roomなし）なら壁もslabも主張しない', () => {
  const layers = threeLayers({ aboveFeature: RoomFeature.VOID, above2Feature: null });
  // x=6000 は室(0..4000)の外。lo/hiを室外へ振った切断で列を取る。
  const cut = { ...stackedCut(layers, TOP_Z), line: { isVertical: false, axisValue: 0, lo: 5000, hi: 7000 } };
  const bands = probeColumn(cut, 6000, makeProbeContext(layers));
  assert.ok(bands.every(b => b.kind === 'open'),
    `室外の列は全てopenのはず（実際:${JSON.stringify(bands.map(b => b.kind))}）`);
});
