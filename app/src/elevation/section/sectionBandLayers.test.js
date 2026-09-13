// sectionBandLayers.js の単体テスト（Phase 7 §5.12「Phase 7 設計」）。
// buildBandLayersが組む層スタックの4規則と、打ち切り系の失敗系を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBandLayers } from './sectionBandLayers.js';

const CH = 2400;
const FLOOR_HEIGHT = 2900;

function makeGraph(floorDatum = 0) {
  return { floorDatum, effectiveFloorLevel: room => (room?.floorLevel ?? 0) };
}

// ---- 規則1: selfが先頭 ----
test('buildBandLayers: specを省略するとselfのみ（floorZMm:0）', () => {
  const g = makeGraph();
  assert.deepEqual(buildBandLayers(g), [{ graph: g, floorZMm: 0, role: 'self' }]);
});

test('buildBandLayers: selfFloorZMmを指定するとselfのfloorZMmがそれになる（上階を自階として立てる場合）', () => {
  const g = makeGraph();
  assert.deepEqual(buildBandLayers(g, { selfFloorZMm: FLOOR_HEIGHT }),
    [{ graph: g, floorZMm: FLOOR_HEIGHT, role: 'self' }]);
});

// ---- 規則2: above ----
test('buildBandLayers: aboveを順に積む（floorZMmは直前+floorHeightMmの累積）', () => {
  const self = makeGraph(), a1 = makeGraph(), a2 = makeGraph();
  const layers = buildBandLayers(self, { above: [
    { graph: a1, floorHeightMm: FLOOR_HEIGHT },
    { graph: a2, floorHeightMm: FLOOR_HEIGHT },
  ] });
  assert.deepEqual(layers, [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: a1, floorZMm: FLOOR_HEIGHT, role: 'above' },
    { graph: a2, floorZMm: FLOOR_HEIGHT * 2, role: 'above' },
  ]);
});

test('【失敗系】buildBandLayers: aboveの途中でgraphがfalsyならそこで打ち切り（以降は積まない）', () => {
  const self = makeGraph(), a1 = makeGraph(), a3 = makeGraph();
  const layers = buildBandLayers(self, { above: [
    { graph: a1, floorHeightMm: FLOOR_HEIGHT },
    { graph: null, floorHeightMm: FLOOR_HEIGHT },
    { graph: a3, floorHeightMm: FLOOR_HEIGHT },
  ] });
  assert.deepEqual(layers, [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: a1, floorZMm: FLOOR_HEIGHT, role: 'above' },
  ]);
});

test('【失敗系】buildBandLayers: aboveのfloorHeightMmが非有限（NaN/undefined）ならそこで打ち切り', () => {
  const self = makeGraph(), a1 = makeGraph(), a2 = makeGraph();
  const layers = buildBandLayers(self, { above: [
    { graph: a1, floorHeightMm: FLOOR_HEIGHT },
    { graph: a2, floorHeightMm: NaN },
  ] });
  assert.deepEqual(layers, [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: a1, floorZMm: FLOOR_HEIGHT, role: 'above' },
  ]);

  const withUndefined = buildBandLayers(self, { above: [{ graph: a1, floorHeightMm: undefined }] });
  assert.deepEqual(withUndefined, [{ graph: self, floorZMm: 0, role: 'self' }]);
});

// ---- 規則3: below（dropMmとceilZMm） ----
test('buildBandLayers: belowを順に下ろす（anchorRoom無しはflDiff=0、floorZMmは直前-dropMm）', () => {
  const self = makeGraph(), b1 = makeGraph();
  const layers = buildBandLayers(self, { below: [{ graph: b1, floorHeightMm: FLOOR_HEIGHT }] });
  assert.deepEqual(layers, [
    { graph: self, floorZMm: 0, role: 'self' },
    { graph: b1, floorZMm: -FLOOR_HEIGHT, role: 'below' },
  ]);
});

test('buildBandLayers: anchorRoomがあるとflDiffぶんdropMmが変わり、ceilZMmが載る', () => {
  const self = makeGraph();
  const b1 = makeGraph(-500); // floorDatum=-500
  // effectiveFloorLevel=-300 → flDiff = -300-(-500) = 200。roomCeilingHeightが
  // room.getFinishInfo()を呼ぶため、CH未指定（フォールバック）の最小フェイクを渡す。
  const anchorRoom = { floorLevel: -300, getFinishInfo: () => ({ ceilingHeight: null }) };
  const layers = buildBandLayers(self, {
    below: [{ graph: b1, floorHeightMm: FLOOR_HEIGHT, anchorRoom }],
  });
  const dropMm = FLOOR_HEIGHT + 200; // flDiff=200
  const floorZMm = -dropMm;
  const expectedCeilZMm = floorZMm + CH; // roomCeilingHeight既定（DEFAULT_ROOM_CEILING_HEIGHT）
  assert.equal(layers.length, 2);
  assert.equal(layers[1].floorZMm, floorZMm);
  assert.equal(layers[1].ceilZMm, expectedCeilZMm);
});

test('buildBandLayers: anchorRoom無しはceilZMmキー自体を持たない', () => {
  const self = makeGraph(), b1 = makeGraph();
  const layers = buildBandLayers(self, { below: [{ graph: b1, floorHeightMm: FLOOR_HEIGHT }] });
  assert.equal('ceilZMm' in layers[1], false);
});

test('【失敗系】buildBandLayers: dropMm<=0（flDiffがfloorHeightMmを打ち消す）ならそこで打ち切り', () => {
  const self = makeGraph();
  const b1 = makeGraph(0);
  // effectiveFloorLevel(anchorRoom) - floorDatum = -FLOOR_HEIGHT ちょうど → dropMm=0
  const anchorRoom = { floorLevel: -FLOOR_HEIGHT };
  const layers = buildBandLayers(self, {
    below: [{ graph: b1, floorHeightMm: FLOOR_HEIGHT, anchorRoom }],
  });
  assert.deepEqual(layers, [{ graph: self, floorZMm: 0, role: 'self' }]);
});

test('【失敗系】buildBandLayers: belowの途中でgraphがfalsy/floorHeightMmが非有限ならそこで打ち切り', () => {
  const self = makeGraph(), b1 = makeGraph();
  assert.deepEqual(
    buildBandLayers(self, { below: [{ graph: b1, floorHeightMm: FLOOR_HEIGHT }, { graph: null, floorHeightMm: FLOOR_HEIGHT }] }),
    [{ graph: self, floorZMm: 0, role: 'self' }, { graph: b1, floorZMm: -FLOOR_HEIGHT, role: 'below' }],
  );
  assert.deepEqual(
    buildBandLayers(self, { below: [{ graph: b1, floorHeightMm: NaN }] }),
    [{ graph: self, floorZMm: 0, role: 'self' }],
  );
});

// ---- 規則4: 返り順はself→|Δz|昇順 ----
test('buildBandLayers: above/belowを両方渡すと絶対距離の昇順でマージされる', () => {
  const self = makeGraph(), a1 = makeGraph(), b1 = makeGraph();
  const layers = buildBandLayers(self, {
    above: [{ graph: a1, floorHeightMm: 1000 }],
    below: [{ graph: b1, floorHeightMm: 3000 }],
  });
  assert.deepEqual(layers.map(l => l.role), ['self', 'above', 'below'],
    '|1000|<|3000| なのでaboveが先');
});

test('buildBandLayers: above単独／below単独では現行の[self,...above]/[self,...below]の並びと一致する', () => {
  const self = makeGraph(), a1 = makeGraph(), a2 = makeGraph();
  const aboveOnly = buildBandLayers(self, { above: [
    { graph: a1, floorHeightMm: 1000 }, { graph: a2, floorHeightMm: 1000 },
  ] });
  assert.deepEqual(aboveOnly.map(l => l.role), ['self', 'above', 'above']);

  const b1 = makeGraph(), b2 = makeGraph();
  const belowOnly = buildBandLayers(self, { below: [
    { graph: b1, floorHeightMm: 1000 }, { graph: b2, floorHeightMm: 1000 },
  ] });
  assert.deepEqual(belowOnly.map(l => l.role), ['self', 'below', 'below']);
});

// layerDirectlyAboveSelfはsectionLayerStack.js（層の「問い」の家）へ移設した
// （QA指摘F1。sectionLayerStack.test.jsのテストを参照）。本ファイルは組み立て
// （buildBandLayers）だけを扱う。

// ---- 失敗系: selfGraphがfalsy（QA指摘・項目5-3） ----
// 旧実装（各帯ビルダーが直接組んでいたリテラル`{graph, floorZMm:0, role:'self'}`）はgraph引数の
// 有効性を検証せずそのまま埋めていたため、本関数もその挙動を踏襲する（検証しない・そのまま通す）。
test('【失敗系】buildBandLayers: selfGraphがfalsy（null/undefined）でも検証せずそのまま通す（旧リテラルと同じ契約）', () => {
  assert.deepEqual(buildBandLayers(null), [{ graph: null, floorZMm: 0, role: 'self' }]);
  assert.deepEqual(buildBandLayers(undefined), [{ graph: undefined, floorZMm: 0, role: 'self' }]);
});
