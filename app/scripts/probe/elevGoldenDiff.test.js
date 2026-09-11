// elevGoldenDiff.mjs（展開図プリミティブの多重集合比較・合併）の単体テスト。
// 追加／削除／変更／分割合併の4系統＋不正入力の失敗経路を確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geomKeyOf, styleKeyOf, fullKeyOf,
  diffPrimitiveLists, mergeCollinearLines, decomposePolylines, diffRoomPrimitives,
} from './elevGoldenDiff.mjs';

const line = (x1, y1, x2, y2, weight = 'thick', extra = {}) => ({ type: 'line', x1, y1, x2, y2, weight, ...extra });

test('geomKeyOf/styleKeyOf: weightだけ違う同じ位置の線は、geomKeyが同じでstyleKeyが違う', () => {
  const a = line(0, 0, 100, 0, 'thick');
  const b = line(0, 0, 100, 0, 'medium');
  assert.equal(geomKeyOf(a), geomKeyOf(b));
  assert.notEqual(styleKeyOf(a), styleKeyOf(b));
  assert.notEqual(fullKeyOf(a), fullKeyOf(b));
});

test('geomKeyOf: openingId等のidはtag鍵に含めない', () => {
  const a = { type: 'tag', cx: 10, cy: 20, rPx: 5, top: 'A', bottom: '1', openingId: 'aaa' };
  const b = { type: 'tag', cx: 10, cy: 20, rPx: 5, top: 'A', bottom: '1', openingId: 'bbb' };
  assert.equal(fullKeyOf(a), fullKeyOf(b));
});

// ---- QA指摘: 白名簿の欠落で見た目が違うのに「一致」になっていた属性 ----
test('geomKeyOf: rectのstroke・rx・fillが鍵に含まれる（欠けると別のrectと区別できない）', () => {
  const base = { type: 'rect', x: 0, y: 0, w: 10, h: 10 };
  const withStyle = { ...base, stroke: '#94a3b8', rx: 7.5, fill: '#fff' };
  assert.notEqual(geomKeyOf(base), geomKeyOf(withStyle));
});

test('geomKeyOf: line・text・tagのstroke/fillが鍵に含まれる', () => {
  const l1 = line(0, 0, 100, 0);
  const l2 = { ...l1, stroke: '#f00' };
  assert.notEqual(geomKeyOf(l1), geomKeyOf(l2));

  const t1 = { type: 'text', x: 0, y: 0, text: 'A' };
  const t2 = { ...t1, fill: '#f00' };
  assert.notEqual(geomKeyOf(t1), geomKeyOf(t2));

  const g1 = { type: 'tag', cx: 0, cy: 0, rPx: 5, top: 'A', bottom: '1' };
  const g2 = { ...g1, stroke: '#f00' };
  assert.notEqual(geomKeyOf(g1), geomKeyOf(g2));
});

test('geomKeyOf: polylineのclosed/fillが鍵に含まれる', () => {
  const p1 = { type: 'polyline', points: [[0, 0], [10, 0]], weight: 'thick' };
  const p2 = { ...p1, closed: true };
  const p3 = { ...p1, fill: '#fff' };
  assert.notEqual(geomKeyOf(p1), geomKeyOf(p2));
  assert.notEqual(geomKeyOf(p1), geomKeyOf(p3));
});

test('【失敗系】geomKeyOf: 未知フィールドを持つ2つのプリミティブは、それだけで鍵が変わる（黙って落とさない）', () => {
  const a = { type: 'circle', cx: 0, cy: 0, rPx: 5 };
  const b = { ...a, someBrandNewField: 'x' };
  assert.notEqual(geomKeyOf(a), geomKeyOf(b), '白名簿方式だと未知フィールドが無視され一致してしまう不具合の再発防止');
});

test('diffPrimitiveLists【完全一致】: 同一配列ならadded/removed/changedすべて空', () => {
  const golden = [line(0, 0, 100, 0), { type: 'rect', x: 0, y: 0, w: 10, h: 10 }];
  const { added, removed, changed } = diffPrimitiveLists(golden, [...golden]);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(changed, []);
});

test('diffPrimitiveLists【追加】: 新側にだけある線はaddedに入る', () => {
  const golden = [line(0, 0, 100, 0)];
  const next = [line(0, 0, 100, 0), line(200, 0, 300, 0)];
  const { added, removed, changed } = diffPrimitiveLists(golden, next);
  assert.equal(added.length, 1);
  assert.equal(added[0].x1, 200);
  assert.deepEqual(removed, []);
  assert.deepEqual(changed, []);
});

test('diffPrimitiveLists【削除】: 旧側にだけある線はremovedに入る', () => {
  const golden = [line(0, 0, 100, 0), line(200, 0, 300, 0)];
  const next = [line(0, 0, 100, 0)];
  const { added, removed, changed } = diffPrimitiveLists(golden, next);
  assert.deepEqual(added, []);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].x1, 200);
  assert.deepEqual(changed, []);
});

test('diffPrimitiveLists【変更】: 同一位置でweightだけ違う線はchangedに入る（add/removeには入らない）', () => {
  const golden = [line(0, 0, 100, 0, 'thick')];
  const next = [line(0, 0, 100, 0, 'medium')];
  const { added, removed, changed } = diffPrimitiveLists(golden, next);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].before.weight, 'thick');
  assert.equal(changed[0].after.weight, 'medium');
});

test('diffPrimitiveLists【変更】: dashだけ違う線もchangedに入る', () => {
  const golden = [line(0, 0, 100, 0, 'thin')];
  const next = [line(0, 0, 100, 0, 'thin', { dash: 'dashed' })];
  const { added, removed, changed } = diffPrimitiveLists(golden, next);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(changed.length, 1);
});

test('diffPrimitiveLists【変更】: dashAnchorだけ違う一点鎖線もchangedに入る', () => {
  const golden = [line(0, -2550, 0, 600, 'thin', { dash: 'center', dashAnchor: 600 })];
  const next = [line(0, -2550, 0, 600, 'thin', { dash: 'center', dashAnchor: 900 })];
  const { added, removed, changed } = diffPrimitiveLists(golden, next);
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(changed.length, 1);
});

test('mergeCollinearLines: 層境界で2分割された縦線を1本へ合併する', () => {
  // elevationSectionGolden.test.js の更新履歴（端の縦線がy=0で2分割されるケース）を再現。
  const split = [line(100, -2400, 100, 0, 'medium'), line(100, 0, 100, 2900, 'medium')];
  const merged = mergeCollinearLines(split);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].y1, -2400);
  assert.equal(merged[0].y2, 2900);
});

test('mergeCollinearLines: 斜めの線は合併対象外でそのまま残る', () => {
  const diag = [line(0, 0, 100, 100), line(100, 100, 200, 0)];
  const merged = mergeCollinearLines(diag);
  assert.equal(merged.length, 2);
});

// ---- decomposePolylines（519365c: 階段帯の断面線がline群→polyline化した対策）----
test('decomposePolylines: 開いたpolylineは隣接点対のlineへ分解し、weight/dashを継承する', () => {
  const p = { type: 'polyline', points: [[0, 0], [10, 0], [10, 10]], weight: 'thick', dash: 'dashed' };
  const lines = decomposePolylines([p]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.type === 'line' && l.weight === 'thick' && l.dash === 'dashed'));
  assert.deepEqual([lines[0].x1, lines[0].y1, lines[0].x2, lines[0].y2], [0, 0, 10, 0]);
  assert.deepEqual([lines[1].x1, lines[1].y1, lines[1].x2, lines[1].y2], [10, 0, 10, 10]);
});

test('decomposePolylines: 開いたpolylineのstroke等の描画属性を分解後のlineへ引き継ぐ', () => {
  const p = { type: 'polyline', points: [[0, 0], [10, 0]], weight: 'thin', stroke: '#94a3b8' };
  const [l] = decomposePolylines([p]);
  assert.equal(l.stroke, '#94a3b8', 'weight/dash以外の描画属性（stroke等）も分解後のlineへ引き継ぐべき');
});

test('diffRoomPrimitives【二重計上防止】: merge:trueで開いたpolylineのstroke違いは一致扱いにならない', () => {
  const golden = [{ type: 'polyline', points: [[0, 0], [10, 0]], weight: 'thin', stroke: '#94a3b8' }];
  const next = [{ type: 'polyline', points: [[0, 0], [10, 0]], weight: 'thin' }];
  const { added, removed } = diffRoomPrimitives(golden, next, { merge: true });
  assert.equal(added.length, 1, 'strokeの無いnew側の線が追加として検出されるはず');
  assert.equal(removed.length, 1, 'strokeを持つgolden側の線が削除として検出されるはず');
});

test('decomposePolylines: closed:trueのpolylineは分解しない', () => {
  const p = { type: 'polyline', points: [[0, 0], [10, 0], [10, 10]], closed: true, weight: 'thick' };
  const out = decomposePolylines([p]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'polyline');
});

test('decomposePolylines: fill指定のあるpolylineは分解しない', () => {
  const p = { type: 'polyline', points: [[0, 0], [10, 0], [10, 10]], fill: '#fff', weight: 'thick' };
  const out = decomposePolylines([p]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'polyline');
});

test('【失敗系】decomposePolylines: 配列以外を渡すと例外', () => {
  assert.throws(() => decomposePolylines(null), TypeError);
});

test('diffRoomPrimitives【分割合併】: merge:trueなら分割差分は添削（add/remove）に出ず、splitMergedに件数が残る', () => {
  const golden = [line(100, -2400, 100, 2900, 'medium')];
  const next = [line(100, -2400, 100, 0, 'medium'), line(100, 0, 100, 2900, 'medium')];
  const naive = diffRoomPrimitives(golden, next, { merge: false });
  assert.equal(naive.removed.length, 1, '合併なしでは元の1本がremoved扱いになる');
  assert.equal(naive.added.length, 2, '合併なしでは分割後の2本がadded扱いになる');

  const merged = diffRoomPrimitives(golden, next, { merge: true });
  assert.deepEqual(merged.added, [], 'merge:trueでは分割は追加として残らない');
  assert.deepEqual(merged.removed, [], 'merge:trueでは分割は削除として残らない');
  assert.ok(merged.splitMerged, 'splitMergedに分割合併の件数が記録される');
  assert.equal(merged.splitMerged.beforeRemoved, 1);
  assert.equal(merged.splitMerged.beforeAdded, 2);
  assert.equal(merged.splitMerged.afterAdded, 0);
  assert.equal(merged.splitMerged.afterRemoved, 0);
});

// ---- QA指摘2026-09その1: mergedDiffの二重計上（非line分がnaiveとmergedDiffの両方に乗る）----
test('diffRoomPrimitives【二重計上防止】: merge:trueでtextの追加は1件のまま（naiveとmergedDiffで二重計上しない）', () => {
  const golden = [];
  const next = [{ type: 'text', x: 0, y: 0, text: 'A' }];
  const { added } = diffRoomPrimitives(golden, next, { merge: true });
  assert.equal(added.length, 1);
});

test('diffRoomPrimitives【二重計上防止】: merge:trueでrectの削除は1件のまま', () => {
  const golden = [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }];
  const next = [];
  const { removed } = diffRoomPrimitives(golden, next, { merge: true });
  assert.equal(removed.length, 1);
});

test('diffRoomPrimitives【二重計上防止】: merge:trueで閉じたpolylineの線種違いは1件のまま', () => {
  const golden = [{ type: 'polyline', points: [[0, 0], [10, 0]], closed: true, weight: 'thick' }];
  const next = [{ type: 'polyline', points: [[0, 0], [10, 0]], closed: true, weight: 'medium' }];
  const { changed } = diffRoomPrimitives(golden, next, { merge: true });
  assert.equal(changed.length, 1);
});

test('diffRoomPrimitives【開いたpolylineの線種違い】: merge:trueで1件のまま（decompose後にnaive側と二重計上しない）', () => {
  const golden = [{ type: 'polyline', points: [[0, 0], [10, 0]], weight: 'thick' }];
  const next = [{ type: 'polyline', points: [[0, 0], [10, 0]], weight: 'medium' }];
  const { added, removed, changed } = diffRoomPrimitives(golden, next, { merge: true });
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.equal(changed.length, 1);
});

// ---- 519365c: line群→polyline(折れ線輪郭)化の等価性 ----
test('diffRoomPrimitives【line⇔polyline等価】: 同一輪郭のline群とpolylineはmerge:trueで完全一致に落ちる', () => {
  const golden = [line(0, 0, 10, 0, 'thick'), line(10, 0, 10, 10, 'thick')];
  const next = [{ type: 'polyline', points: [[0, 0], [10, 0], [10, 10]], weight: 'thick' }];
  const { added, removed, changed } = diffRoomPrimitives(golden, next, { merge: true });
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(changed, []);
});

// ---- 失敗系 ----
test('【失敗系】geomKeyOf: プリミティブがnull/typeなしなら例外', () => {
  assert.throws(() => geomKeyOf(null), TypeError);
  assert.throws(() => geomKeyOf({ x1: 0 }), TypeError);
});

test('【失敗系】diffPrimitiveLists: 配列以外を渡すと例外', () => {
  assert.throws(() => diffPrimitiveLists(null, []), TypeError);
  assert.throws(() => diffPrimitiveLists([], 'not-array'), TypeError);
});

test('【失敗系】mergeCollinearLines: 配列以外を渡すと例外', () => {
  assert.throws(() => mergeCollinearLines({}), TypeError);
});
