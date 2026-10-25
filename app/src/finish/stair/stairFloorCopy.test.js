// finish/stair/stairFloorCopy.js copyStairsToGraph（階追加で当該階の階段を新しい階へ写す純関数）。
// 2グラフを渡すだけ（peek・保存は使わない）。S4（2026-10-21）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  CenterLineType, Discipline, StairType, StructuralMaterialType, RoomFeature, RoomKind, Stair,
} from '../../core.js';
import { refreshCells, roomBounds } from '../gridCells.js';
import { serializeGraph } from '../../graphSnapshot.js';
import { ensureStairRooms } from '../roomReinterpret.js';
import { findUnderStairSplitCLs, ensureUnderStairSplit } from './stairUnderSplit.js';
import { riserOf } from './stairDimensions.js';
import { copyStairsToGraph, COPIED_STAIR_FIELDS } from './stairFloorCopy.js';
import { setupProject, keyAt, LEFT_HALF } from './stairRemovalTestFixtures.js';

// 写し元 p1 にだけ per-floor 中心線 V500 を置く（写し先 p2 には無い＝写すと CL が足される）。通り芯 X:[0,1000,2000] Y:[0,1000]
function setup({ srcCL = true } = {}) {
  const { project, graphs } = setupProject(3);
  const [src, dst] = graphs;
  if (srcCL) src.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  return { project, src, dst, sg: project.structGraph };
}

const bytes = (g) => Buffer.from(serializeGraph(g)).toString('base64');
const bounds = (cells, g) => roomBounds(refreshCells(cells, g), g);

/** src に全項目を既定値以外にした階段（ペア部屋つき）を置く。 */
function addRichStair(src, key = keyAt(src, LEFT_HALF[0]), over = {}) {
  const s = src.addStair({
    type: StairType.SWITCHBACK, structure: StructuralMaterialType.STEEL, cells: new Set([key]),
    sections: [4, 3, 5], tread: 270, riser: 185, nosing: 25, width: 1100,
    upDirection: 'down', flip: true, entrySide: 'left', arrivalSide: 'right',
    entryTurnSteps: 2, arrivalTurnSteps: 1, soffitFinish: 'finished', ...over,
  });
  ensureStairRooms(src);
  return s;
}

test('階段が無い: 写し先は一切変わらない（changed=false）', () => {
  const { src, dst, sg } = setup();
  const before = bytes(dst);
  const r = copyStairsToGraph(dst, src, sg);
  assert.deepEqual(r, { changed: false, copied: [], skipped: [] });
  assert.equal(bytes(dst), before);
});

test('全項目を既定値以外にした階段: id・cells・roomId 以外は同じ値で、sections は別配列', () => {
  const { src, dst, sg } = setup();
  const s = addRichStair(src);
  // 前提: 既定値のままの項目が無い（写し忘れを検出できる入力）
  const dflt = new Stair('d', {});
  for (const f of COPIED_STAIR_FIELDS.filter(f => !['totalSteps', 'sections'].includes(f))) {
    assert.notDeepEqual(s[f], dflt[f], `前提: ${f} が既定値のまま`);
  }
  const r = copyStairsToGraph(dst, src, sg);
  assert.equal(r.copied.length, 1);
  const c = dst.stairMap.get(r.copied[0].stairId);
  for (const f of COPIED_STAIR_FIELDS) assert.deepEqual(c[f], s[f], `${f} が写っていない`);
  assert.notEqual(c.sections, s.sections, 'sections は複製（同じ配列を共有しない）');
  assert.notEqual(c.id, s.id);
  assert.notEqual(c.roomId, s.roomId);
  assert.deepEqual(bounds(c.cells, dst), bounds(s.cells, src), '包絡矩形が一致する');
  assert.equal(dst.stairs.length, 1);
});

test('不変条件: 写す項目の集合は Stair の項目集合から id・cells・roomId を除いたものと一致する', () => {
  const stairKeys = Object.keys(new Stair('s', {})).filter(k => !['id', 'cells', 'roomId'].includes(k)).sort();
  assert.deepEqual([...COPIED_STAIR_FIELDS].sort(), stairKeys,
    'Stair に項目を足したら stairFloorCopy.js の COPIED_STAIR_FIELDS（と stairOptions）にも足す');
});

test('昇り方向・反転・出入口辺・取りつき回転部が全て残る（選択順なしで既定値へ落ちない）', () => {
  for (const upDirection of ['up', 'down', 'left', 'right']) {
    for (const flip of [false, true]) {
      const { src, dst, sg } = setup();
      addRichStair(src, undefined, { upDirection, flip, entrySide: flip ? 'right' : 'left', arrivalSide: flip ? 'left' : 'end' });
      const r = copyStairsToGraph(dst, src, sg);
      const c = dst.stairMap.get(r.copied[0].stairId);
      assert.equal(c.upDirection, upDirection);
      assert.equal(c.flip, flip);
      assert.equal(c.entrySide, flip ? 'right' : 'left');
      assert.equal(c.arrivalSide, flip ? 'left' : 'end');
      assert.equal(c.entryTurnSteps, 2);
      assert.equal(c.arrivalTurnSteps, 1);
    }
  }
});

test('写し元だけにある中心線 x=500 が写し先に足され、cells は写し先の線 id を指す', () => {
  const { src, dst, sg } = setup();
  addRichStair(src);
  assert.equal([...dst.shapeMap.values()].some(c => c.value === 500), false, '前提: 写し先に x=500 が無い');
  const r = copyStairsToGraph(dst, src, sg);
  assert.equal(r.changed, true);
  const added = [...dst.shapeMap.values()].filter(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 500);
  assert.equal(added.length, 1);
  const c = dst.stairMap.get(r.copied[0].stairId);
  for (const k of c.cells) {
    for (const id of k.split(':')) assert.ok(dst.shapeMap.has(id) || sg.shapeMap.has(id), `cells の線 id ${id} が写し先で解決できない`);
  }
  assert.ok([...c.cells].some(k => k.split(':').includes(added[0].id)), '足した x=500 が cells の境界になっている');
  assert.deepEqual(bounds(c.cells, dst), { x1: 0, y1: 0, x2: 500, y2: 1000 });
});

test('ペア部屋: STAIR・kind・名前・内装・仕上げが写り、階段と相互リンクする。写し元は不変', () => {
  const { src, dst, sg } = setup();
  const s = addRichStair(src);
  const pair = src.roomMap.get(s.roomId);
  pair.setName('ホール階段');
  pair.setTemplateKey('LIVING_ROOM');
  pair.customOverrides.set('wallMaterial', 'X');
  pair.finish.setField('floorMaterial', 'フローリング');
  pair.finish.setField('note', '備考');
  const srcBefore = bytes(src);

  const r = copyStairsToGraph(dst, src, sg);
  const room = dst.roomMap.get(r.copied[0].roomId);
  assert.equal(room.feature, RoomFeature.STAIR);
  assert.equal(room.kind, RoomKind.INTERIOR);
  assert.equal(room.name, 'ホール階段');
  assert.equal(room.templateKey, 'LIVING_ROOM');
  assert.equal(room.customOverrides.get('wallMaterial'), 'X');
  assert.equal(room.finish.floorMaterial, 'フローリング');
  assert.equal(room.finish.note, '備考');
  assert.equal(dst.stairMap.get(r.copied[0].stairId).roomId, room.id);
  assert.notEqual(room.id, pair.id);
  assert.equal(bytes(src), srcBefore, '写し元は変わらない');
});

test('ペア部屋の無い旧データの階段: name 空・kind INTERIOR のペア部屋を作る', () => {
  const { src, dst, sg } = setup();
  src.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(src, LEFT_HALF[0])]), upDirection: 'up', tread: 250 });
  assert.equal(src.stairs[0].roomId, null);
  const r = copyStairsToGraph(dst, src, sg);
  const room = dst.roomMap.get(r.copied[0].roomId);
  assert.equal(room.name, '');
  assert.equal(room.kind, RoomKind.INTERIOR);
  assert.equal(room.feature, RoomFeature.STAIR);
});

test('屋外階段: ペア部屋が EXTERIOR になり、外部タブの連動行（part・finish・base・note）が新しい部屋 id で写る。手入力行は写らない', () => {
  const { src, dst, sg } = setup();
  const s = addRichStair(src);
  const pair = src.roomMap.get(s.roomId);
  pair.setKind(RoomKind.EXTERIOR);
  const row = src.addExteriorRow('exteriorRows', '階段', pair.id);
  row.setField('finish', 'タイル'); row.setField('base', '土間'); row.setField('note', '滑り止め');
  src.addExteriorRow('exteriorRows', '手入力', null);

  const r = copyStairsToGraph(dst, src, sg);
  const room = dst.roomMap.get(r.copied[0].roomId);
  assert.equal(room.kind, RoomKind.EXTERIOR);
  assert.equal(dst.exteriorRows.length, 1, '連動行だけ（手入力行は写さない）');
  const c = dst.exteriorRows[0];
  assert.deepEqual([c.part, c.finish, c.base, c.note, c.roomId], ['階段', 'タイル', '土間', '滑り止め', room.id]);
  assert.notEqual(c.id, row.id);
});

test('【失敗系】足元が写し先の昇降路と重なる: overlap で飛ばし、写し先は1バイトも変わらない（CL も増えない）', () => {
  const { src, dst, sg } = setup();
  addRichStair(src);
  const shaft = dst.addRoom(new Set([keyAt(dst, [500, 500])]), 'EV');
  shaft.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const before = bytes(dst);
  const r = copyStairsToGraph(dst, src, sg);
  assert.deepEqual(r, { changed: false, copied: [], skipped: [{ srcStairId: src.stairs[0].id, reason: 'overlap' }] });
  assert.equal(bytes(dst), before, '重なり判定は CL を足す前（飛ばすなら写し先は不変）');
  assert.equal(dst.stairs.length, 0);
});

test('【失敗系】足元が写し先の屋根・別の階段と重なる: overlap', () => {
  for (const kind of ['roof', 'stair']) {
    const { src, dst, sg } = setup();
    addRichStair(src);
    if (kind === 'roof') {
      const roof = dst.addRoom(new Set([keyAt(dst, [500, 500])]), '屋根');
      roof.setKind(RoomKind.EXTERIOR);
      roof.setFeature(RoomFeature.ROOF);
    } else {
      dst.addStair({ type: StairType.STRAIGHT, cells: new Set([keyAt(dst, [500, 500])]) });
    }
    const before = bytes(dst);
    const r = copyStairsToGraph(dst, src, sg);
    assert.equal(r.skipped[0]?.reason, 'overlap', kind);
    assert.equal(bytes(dst), before, kind);
  }
});

test('【失敗系】セルの線 id が写し元に存在しない: untranslatable で飛ばす（例外にしない）', () => {
  const { src, dst, sg } = setup();
  src.addStair({ type: StairType.STRAIGHT, cells: new Set(['nope1:nope2:nope3:nope4']), upDirection: 'up' });
  const r = copyStairsToGraph(dst, src, sg);
  assert.deepEqual(r.skipped, [{ srcStairId: src.stairs[0].id, reason: 'untranslatable' }]);
  assert.equal(r.copied.length, 0);
  assert.equal(dst.stairs.length, 0);
  assert.equal(dst.rooms.length, 0, 'ペア部屋も作らない');
});

test('一部だけ飛ぶ: 置ける階段は写し、置けない階段だけ skipped に積む', () => {
  const { src, dst, sg } = setup();
  const a = addRichStair(src, keyAt(src, [250, 500]));
  const b = addRichStair(src, keyAt(src, [1500, 500]));
  const shaft = dst.addRoom(new Set([keyAt(dst, [1500, 500])]), 'EV');
  shaft.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const r = copyStairsToGraph(dst, src, sg);
  assert.deepEqual(r.copied.map(c => c.srcStairId), [a.id]);
  assert.deepEqual(r.skipped, [{ srcStairId: b.id, reason: 'overlap' }]);
});

test('足元に通常の部屋がある: 足元のセルだけ引き抜かれて階段が置ける（部屋は残る）', () => {
  const { src, dst, sg } = setup();
  addRichStair(src);
  const hall = dst.addRoom(new Set([keyAt(dst, [500, 500])]), 'ホール'); // 通り芯セル [0,1000]x[0,1000]
  const r = copyStairsToGraph(dst, src, sg);
  assert.equal(r.copied.length, 1);
  const pairCells = refreshCells(dst.roomMap.get(r.copied[0].roomId).cells, dst);
  const hallCells = refreshCells(hall.cells, dst);
  assert.ok(hallCells.size > 0, 'ホールは右半分が残る');
  assert.equal([...hallCells].some(k => pairCells.has(k)), false, 'セルの二重所有が無い');
});

test('直進階段: 階段下の分割CLが写し先にも1本できる（写し元と同数）', () => {
  const { src, dst, sg } = setup();
  const s = src.addStair({
    type: StairType.STRAIGHT, cells: new Set([keyAt(src, [250, 500])]), upDirection: 'right', totalSteps: 12, tread: 250,
  });
  ensureStairRooms(src);
  ensureUnderStairSplit(s, src, riserOf(s, 3000));
  const srcSplits = findUnderStairSplitCLs(s, src).length;
  assert.equal(srcSplits, 1, '前提: 写し元に分割CLがある');
  const r = copyStairsToGraph(dst, src, sg, { floorHeight: 3000 });
  const c = dst.stairMap.get(r.copied[0].stairId);
  assert.equal(findUnderStairSplitCLs(c, dst).length, srcSplits);
});

test('写し元は読むだけ: 何を写しても写し元の直列化は前後で一致する', () => {
  const { src, dst, sg } = setup();
  addRichStair(src, keyAt(src, [250, 500]));
  addRichStair(src, keyAt(src, [1500, 500]));
  const before = bytes(src);
  copyStairsToGraph(dst, src, sg, { floorHeight: 3000 });
  assert.equal(bytes(src), before);
});

test('【失敗系】dstGraph・srcGraph が無ければ例外（黙って何もしない扱いにしない）', () => {
  const { src, dst, sg } = setup();
  assert.throws(() => copyStairsToGraph(null, src, sg), /dstGraph/);
  assert.throws(() => copyStairsToGraph(dst, null, sg), /srcGraph/);
});
