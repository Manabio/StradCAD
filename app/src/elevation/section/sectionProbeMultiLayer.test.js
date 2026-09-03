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
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

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

test('【失敗系】probeColumn: 切断線が部屋の外（所有Roomなし）なら壁もslabも主張しない', () => {
  const layers = threeLayers({ aboveFeature: RoomFeature.VOID, above2Feature: null });
  // x=6000 は室(0..4000)の外。lo/hiを室外へ振った切断で列を取る。
  const cut = { ...stackedCut(layers, TOP_Z), line: { isVertical: false, axisValue: 0, lo: 5000, hi: 7000 } };
  const bands = probeColumn(cut, 6000, makeProbeContext(layers));
  assert.ok(bands.every(b => b.kind === 'open'),
    `室外の列は全てopenのはず（実際:${JSON.stringify(bands.map(b => b.kind))}）`);
});
