// 開放スパンのアキ（バツ・「ア キ」）を buildRoomBand 経由（帯レベル）で固定する回帰テスト
// （展開図一般化 Phase 5・design `.claude/elevation-redesign.md` §5.5 R5「3点を専用の回帰
// テストとして先に固定する」のゲート）。elevationOpenSpan.test.js の
// makeWallThenOpenRoom と同じ最小フィクスチャ（実壁区間+同室内・壁なしの開放継続）を使い、
// 部分指定の子部屋（部屋自身の一部だけ床高さが違う区間）のFL/CHを振って
// `.claude/elevation-model.md`「アキのz範囲」の3点表＋「上端＝低い方の天井」を再現する。
//
// Phase 5 でこの値の情報源は cut.openSpans（face.spans からの外部注入）から
// 断面エンジンの探査（band.farFloorZ/farCeilZ 経由の splitOpenByFarFace）へ差し替わるが、
// 出力プリミティブ（このテストの期待値）は不変であるはずというのがPhase 5のゲート。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildRoomBand } from './elevationBand.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// D1（elevationOpenSpan.test.jsの makeWallThenOpenRoom と同一構成の最小再現）: 2行×2列。
// 上段(y:0-1000)はx=2000で自室(左)と他室(右)が接する＝実壁。下段(y:1000-2000)は
// x=2000の両側とも自室（他室ではなく部分指定の子）＝壁なしの開放継続。x=2000に立つ縦の面の
// 下段区間が開放スパン（kind==='open'）になり、子部屋のFL/CHがfarFloorDeltaMm/farCeilAbsMmになる。
function makeWallThenOpenRoom(graph, childFL, childCH) {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const otherKey = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`; // 上段右＝他室
  const mainTopKey    = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`; // 上段左＝自室
  const mainBotLeftKey  = `${x0.id}:${y1.id}:${x1.id}:${y2.id}`; // 下段左＝自室
  const mainBotRightKey = `${x1.id}:${y1.id}:${x2.id}:${y2.id}`; // 下段右＝自室（部分指定の子）

  const other = graph.addRoom(new Set([otherKey]), '他室');
  generateRoomWallsFromOutline(graph, other);
  const room = graph.addRoom(new Set([mainTopKey, mainBotLeftKey, mainBotRightKey]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const child = graph.addRoom(new Set([mainBotRightKey]), '部分指定', undefined, new Set([room.id]));
  child.setFloorLevel(childFL);
  if (childCH != null) child.setOverride('ceilingHeight', String(childCH));
  return { room, other };
}

// x=2000の縦の面（下段の開放区間。x座標<5000）に出る「ア キ」テキストとバツ(X)2本を拾う。
function gapMarksOf(band) {
  const prims = band.primitives ?? band;
  const text = prims.find(p => p.type === 'text' && p.text === 'ア キ' && p.x < 5000);
  const xLines = prims.filter(p => p.type === 'line' && p.x1 < 5000 && p.x1 !== p.x2 && p.y1 !== p.y2);
  return { text, xLines };
}

test('【裁定2026-09・3点固定1/3・帯レベル】buildRoomBand: 遠側床が近側探査の下端より低い（far<z0）開放区間は遠側床まで下がる', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, -100, null);
  const band = buildRoomBand(room, graph);
  const { text, xLines } = gapMarksOf(band);
  assert.equal(xLines.length, 2, 'バツ2本のはず');
  const ys = [...new Set(xLines.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-2400, 100], '下端は遠側床(z=-100 → y=100)まで下がるはず（探査z0=0より低い側へ拡張）');
  assert.equal(text.y, -1150, '「ア キ」中心はクランプ後の範囲((-100+2400)/2 → y=-1150)のはず');
});

test('【裁定2026-09-11・アキ下端統一・帯レベル】buildRoomBand: 遠側床が近側探査と同値でも区間内部なら常にそこで止める', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, 0, null);
  const band = buildRoomBand(room, graph);
  const { text, xLines } = gapMarksOf(band);
  const ys = [...new Set(xLines.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-2400, 0], '下端は遠側床(z=0)のまま');
  assert.equal(text.y, -1200);
});

test('【裁定2026-09・3点固定3/3・帯レベル】buildRoomBand: 遠側床が近側探査より高い（区間内部）ときはそこまで持ち上げる', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, 300, null);
  const band = buildRoomBand(room, graph);
  const { text, xLines } = gapMarksOf(band);
  const ys = [...new Set(xLines.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-2400, -300], '下端は遠側床(z=300 → y=-300)まで持ち上がるはず（遠側スラブで塞がれている）');
  assert.equal(text.y, -1350, 'クランプ後の中心((300+2400)/2 → y=-1350)のはず');
});

test('【実機修正2026-09・高低差・帯レベル】buildRoomBand: 遠側天井が近側より低ければアキの上端はそこで止まる', () => {
  const graph = makeGraph();
  const { room } = makeWallThenOpenRoom(graph, 0, 1800);
  const band = buildRoomBand(room, graph);
  const { text, xLines } = gapMarksOf(band);
  const ys = [...new Set(xLines.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(ys, [-1800, 0], '上端は遠側天井(1800)まで下がるはず——近側(2400)へ伸ばしてはいけない');
  assert.equal(text.y, -900, 'クランプ後の中心((0+1800)/2 → y=-900)のはず');
});

// ================================================================
// QA是正2026-09（検算・実機「11'」A2）: 床と天井で深度の異なる実体が同じopen区間に掛かる構成。
// 帯の部屋「11'」（FL+100）→ 開放スパンの先の子室「11」（FL0・CH2500。近い＝上限内）
// → さらにその先、実壁を挟んだ別室「10」（CH2400。遠い＝上限外）。
// `farFaceAnnotation`がfloorFace/ceilFaceの深度を共有していると、「10」の天井（上限外）が
// 「11」の床（上限内）の深度に隠れて上限判定をすり抜け、誤って採用されてしまう
// （13.stq/11.stqの実データで発覚。修正はsectionHits.js/sectionEngine.js/sectionEmit.js）。
// ================================================================
function makeDepthMismatchFixture() {
  const graph = makeGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  const x3 = graph.addCenterLine(CenterLineType.VERTICAL, 4100, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });

  const otherKey = `${x1.id}:${y0.id}:${x2.id}:${y1.id}`; // 上段右＝他室（nearestMmの根拠となる実壁）
  const mainTopKey    = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const mainBotLeftKey  = `${x0.id}:${y1.id}:${x1.id}:${y2.id}`;
  const mainBotRightKey = `${x1.id}:${y1.id}:${x2.id}:${y2.id}`; // 下段右＝子室「11」（部分指定）
  const room10Key = `${x2.id}:${y1.id}:${x3.id}:${y2.id}`;       // さらに東＝室「10」（実壁の先）

  const other = graph.addRoom(new Set([otherKey]), '他室');
  generateRoomWallsFromOutline(graph, other);
  // 帯の部屋そのもの＝「11'」（FL+100）。
  const room = graph.addRoom(new Set([mainTopKey, mainBotLeftKey, mainBotRightKey]), "11'");
  generateRoomWallsFromOutline(graph, room);
  // 部分指定の子室「11」（FL0＝親より100低い。CH2500を明示）。
  const child = graph.addRoom(new Set([mainBotRightKey]), '11', undefined, new Set([room.id]));
  child.setFloorLevel(0);
  child.setOverride('ceilingHeight', '2500');
  // 「11」のさらに東、実壁を挟んだ別室「10」（CH2400）。
  const room10 = graph.addRoom(new Set([room10Key]), '10');
  room10.setOverride('ceilingHeight', '2400');
  generateRoomWallsFromOutline(graph, room10);
  room.setFloorLevel(100);
  return { graph, room, child, room10 };
}

test('【QA是正・検算・帯レベル】buildRoomBand: 全高壁の向こうの遠い天井（上限外）は採用せず、近い床（上限内）だけがアキに反映される', () => {
  const { graph, room } = makeDepthMismatchFixture();
  const band = buildRoomBand(room, graph);
  const { text, xLines } = gapMarksOf(band);
  const ys = [...new Set(xLines.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  // 床(子室「11」FL0=帯FL+100から見て-100)は上限内で反映されy=0（=1FLの破線）まで下がる。
  // 天井は「10」（実壁の先・上限外）を採らず、帯自身の天井(2400)のままy=-2500に留まる
  // （「11」自身のCH2500が上限内で見つかっても、帯FL+100を差し引いた2400は帯自身の天井と同値
  // ＝sectionLevelZsのdedupeで水平線は出ない。バツの範囲自体は帯自身の天井のまま）。
  assert.deepEqual(ys, [-2500, 0],
    '下端は遠側床(z=-100→y=0)まで伸びるが、上端は上限外の「10」を採らず帯自身の天井(z=2400→y=-2500)のまま');
  assert.equal(text.y, -1250, '中心は((0)+(-2500))/2 → y=-1250（帯自身の天井までの中心）のはず');
});
