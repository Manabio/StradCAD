// 基準点を指す: 候補方式の純関数（verticesWithin・候補の状態・印の位置・ヒント文）。呼び出し側と同じ形（previewVertexPoints(previewPrimitivesOf(form))）で通す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFromDxf, previewPrimitivesOf, rebaseOrigin, DETAIL_HELPER_TEXT, basePointHintText } from './detailHelperForm.js';
import {
  previewVertexPoints, nearestPointWithin, verticesWithin, baseCandidateOnTap, activeBaseCandidate,
  nextBaseCandidate, baseCandidateSummary, baseCandidateMarkerStyle,
} from './detailHelperPick.js';
import { makeTransform } from '../structural/sectionFigure/sectionGeometry.js';
import { dxfLine as line, loadDxfBody as loadBody, pickDxfComponents as pick, fixedId as ids } from './detailHelperDxfTestFixtures.js';

// 0.707 mm 離れた 2 頂点（2 本の線の端点）と、3 本が 1 点で出会う分岐（その点が複数のストロークの頂点として重なる）
async function closeForm() {
  const body = [...line(3000, -705, 3235, -705), ...line(3235.5, -704.5, 3500, -704.5),
    ...line(0, 0, 100, 0), ...line(100, 0, 100, 50), ...line(100, 0, 150, 0)];
  const dxf = pick(await loadBody(body), 0, 1, 2);
  return draftFromDxf({ dxf, idFactory: ids }).form;
}
const vertsOf = form => previewVertexPoints(previewPrimitivesOf(form));

async function setup() {
  const points = vertsOf(await closeForm());
  // 距離約 0.707 の 2 頂点を探す（プレビューの座標。DXF の y とは符号が逆）
  let pair = null;
  for (const a of points) for (const b of points) if (a !== b && Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - Math.SQRT1_2) < 1e-6 && !pair) pair = [a, b];
  assert.ok(pair, '0.707 mm 離れた 2 頂点がある');
  return { points, a: pair[0], b: pair[1] };
}

test('2 頂点の近くのタップ: 候補 2 件・先頭が近い方。次の候補で他方→もう一度で先頭。要約は {0,2}→{1,2}', async () => {
  const { points, a, b } = await setup();
  const mm = { x: a.x + (b.x - a.x) * 0.3, y: a.y + (b.y - a.y) * 0.3 }; // a 寄り
  const r = baseCandidateOnTap(null, { points, mm, radiusMm: 2 });
  assert.equal(r.miss, false);
  assert.equal(r.state.list.length, 2);
  assert.equal(r.state.owner, points);
  assert.equal(activeBaseCandidate(r.state, points), a);
  assert.deepEqual(baseCandidateSummary(r.state, points), { index: 0, count: 2 });
  const s1 = nextBaseCandidate(r.state, points);
  assert.notEqual(s1, r.state, '新しい状態');
  assert.equal(r.state.index, 0, '元の状態は不変');
  assert.equal(activeBaseCandidate(s1, points), b);
  assert.deepEqual(baseCandidateSummary(s1, points), { index: 1, count: 2 });
  const s2 = nextBaseCandidate(s1, points);
  assert.equal(activeBaseCandidate(s2, points), a);
  assert.deepEqual(baseCandidateSummary(s2, points), { index: 0, count: 2 });
  // b 寄りのタップなら先頭は b
  const mmB = { x: a.x + (b.x - a.x) * 0.7, y: a.y + (b.y - a.y) * 0.7 };
  assert.equal(activeBaseCandidate(baseCandidateOnTap(null, { points, mm: mmB, radiusMm: 2 }).state, points), b);
  // 再タップは先頭から（次の候補へ送った状態 s1〔index 1〕を引き継がない）
  const again = baseCandidateOnTap(s1, { points, mm, radiusMm: 2 });
  assert.equal(again.miss, false);
  assert.equal(again.state.index, 0);
  assert.equal(activeBaseCandidate(again.state, points), a);
});

test('候補の点を rebaseOrigin へ渡すと、回した後のプレビューでその頂点が (0,0) に来る', async () => {
  const form = await closeForm();
  const points = vertsOf(form);
  const { a } = await setup();
  const state = baseCandidateOnTap(null, { points, mm: a, radiusMm: 2 }).state;
  for (const s of [state, nextBaseCandidate(state, points)]) {
    const p = activeBaseCandidate(s, points);
    const after = vertsOf(rebaseOrigin(form, { s: p.x, t: p.y }));
    assert.equal(after.length, points.length);
    const i = points.indexOf(p);
    assert.ok(i >= 0);
    assert.equal(after[i].x, 0);
    assert.equal(after[i].y, 0);
  }
});

test('重複点（分岐で複数のストロークが共有する頂点）は 1 件にまとまる', async () => {
  const points = vertsOf(await closeForm());
  const rectCorner = points.filter(p => points.filter(q => q.x === p.x && q.y === p.y).length > 1);
  assert.ok(rectCorner.length >= 2, '座標が完全に同じ頂点が入力にある');
  const c = rectCorner[0];
  const list = verticesWithin(points, c, 0.5);
  assert.equal(list.length, 1);
  assert.equal(list[0], c, '先に出た方を残す');
  assert.equal(verticesWithin([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 + 1e-9 }], { x: 1, y: 1 }, 1).length, 2, '誤差程度の違いはまとめない');
});

test('verticesWithin: 近い順・境界ちょうどは含む・わずかに外は含まない・同距離は入力の順', () => {
  const far = { x: 10, y: 0 }; const mid = { x: 3, y: 0 }; const nr = { x: 1, y: 0 };
  assert.deepEqual(verticesWithin([far, mid, nr], { x: 0, y: 0 }, 10), [nr, mid, far]);
  assert.deepEqual(verticesWithin([far, mid, nr], { x: 0, y: 0 }, 3), [nr, mid], '境界 3 を含み 10 は外');
  assert.deepEqual(verticesWithin([{ x: 3.0000001, y: 0 }], { x: 0, y: 0 }, 3), []);
  const l = { x: -1, y: 0 }; const r = { x: 1, y: 0 };
  assert.equal(verticesWithin([l, r], { x: 0, y: 0 }, 1)[0], l);
  assert.equal(verticesWithin([r, l], { x: 0, y: 0 }, 1)[0], r);
  // 半径は円・並びは直線距離（縦横の差の和ではない）: (3,4) は半径 5 ちょうど。(3,3)＝4.24 は (5,0)＝5 より近い
  const diag = { x: 3, y: 4 };
  assert.deepEqual(verticesWithin([diag], { x: 0, y: 0 }, 5), [diag]);
  const d33 = { x: 3, y: 3 }; const d50 = { x: 5, y: 0 };
  assert.deepEqual(verticesWithin([d50, d33], { x: 0, y: 0 }, 5), [d33, d50]);
});

test('verticesWithin: 入力を書き換えず、返す要素は入力の点そのもの', () => {
  const pts = [{ x: 5, y: 0 }, { x: 1, y: 0 }, { x: 3, y: 0 }];
  const copy = [...pts];
  const out = verticesWithin(pts, { x: 0, y: 0 }, 10);
  assert.equal(pts.length, 3);
  pts.forEach((p, i) => assert.equal(p, copy[i], `入力の ${i} 番目`));
  assert.equal(out[0], pts[1]);
  assert.equal(out[1], pts[2]);
  assert.equal(out[2], pts[0]);
});

test('【失敗系】verticesWithin: 非有限の mm・半径、points が無い・空・範囲外は []。NaN 座標・null の要素は飛ばす', () => {
  const pts = [{ x: 0, y: 0 }];
  assert.deepEqual(verticesWithin(pts, { x: NaN, y: 0 }, 1), []);
  assert.deepEqual(verticesWithin(pts, { x: 0, y: Infinity }, 1), []);
  assert.deepEqual(verticesWithin(pts, { x: 0, y: 0 }, NaN), []);
  assert.deepEqual(verticesWithin(pts, null, 1), []);
  assert.deepEqual(verticesWithin(null, { x: 0, y: 0 }, 1), []);
  assert.deepEqual(verticesWithin(undefined, { x: 0, y: 0 }, 1), []);
  assert.deepEqual(verticesWithin([], { x: 0, y: 0 }, 1), []);
  assert.deepEqual(verticesWithin([{ x: 100, y: 0 }], { x: 0, y: 0 }, 1), []);
  const ok = { x: 0.5, y: 0 };
  assert.deepEqual(verticesWithin([{ x: NaN, y: 0 }, null, { x: 0, y: Infinity }, undefined, { y: 0 }, ok], { x: 0, y: 0 }, 1), [ok]);
});

test('【失敗系】候補なしで遠いタップは { state: null, miss: true }。候補ありで遠いタップは同じ state の参照・miss true', async () => {
  const { points, a } = await setup();
  assert.deepEqual(baseCandidateOnTap(null, { points, mm: { x: 1e6, y: 1e6 }, radiusMm: 2 }), { state: null, miss: true });
  const st = baseCandidateOnTap(null, { points, mm: a, radiusMm: 2 }).state;
  const r = baseCandidateOnTap(st, { points, mm: { x: 1e6, y: 1e6 }, radiusMm: 2 });
  assert.equal(r.state, st);
  assert.equal(r.miss, true);
});

test('【失敗系】owner が違う配列（中身が同じでも）・壊れた状態は無効: active・summary は null、next は同じ参照', async () => {
  const { points, a } = await setup();
  const st = baseCandidateOnTap(null, { points, mm: a, radiusMm: 2 }).state;
  const other = [...points];
  assert.equal(activeBaseCandidate(st, other), null);
  assert.equal(baseCandidateSummary(st, other), null);
  assert.equal(nextBaseCandidate(st, other), st);
  assert.equal(activeBaseCandidate(null, points), null);
  assert.equal(baseCandidateSummary(null, points), null);
  assert.equal(nextBaseCandidate(null, points), null);
  const one = baseCandidateOnTap(null, { points: [{ x: 0, y: 0 }], mm: { x: 0, y: 0 }, radiusMm: 1 });
  assert.equal(nextBaseCandidate(one.state, one.state.owner), one.state, '1 件は送らない');
  const broken = [
    { owner: points, list: [], index: 0 }, { owner: points, list: [a], index: 1 }, { owner: points, list: [a], index: -1 },
    { owner: points, list: [a, a], index: 0.5 }, { owner: points, list: [a], index: undefined }, { owner: points, list: 'a', index: 0 },
  ];
  for (const bad of broken) {
    assert.equal(activeBaseCandidate(bad, points), null);
    assert.equal(baseCandidateSummary(bad, points), null);
    assert.equal(nextBaseCandidate(bad, points), bad);
  }
});

test('baseCandidateMarkerStyle: 本物の変換で left／top が tx／ty の手計算どおり。null・非有限の点は null', () => {
  const T = makeTransform({ minX: -100, minY: -50, width: 1000, height: 500 }, 1 / 2); // tx(0)=82・ty(0)=57（pickOverlayStyle のテストと同じ）
  const st = baseCandidateMarkerStyle({ x: 100, y: 40 }, T);
  assert.equal(st.left, 82 + 50);
  assert.equal(st.top, 57 + 20);
  assert.deepEqual(Object.keys(st), ['left', 'top']);
  for (const bad of [null, undefined, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { y: 0 }]) assert.equal(baseCandidateMarkerStyle(bad, T), null);
});

test('basePointHintText: miss が先・次に summary・どちらも無ければ既定。引数なし・null でも投げない', () => {
  const summary = { index: 1, count: 3 };
  assert.equal(basePointHintText({ miss: true, summary: null }), DETAIL_HELPER_TEXT.basePointMiss);
  assert.equal(basePointHintText({ miss: false, summary }), DETAIL_HELPER_TEXT.basePointCandidate(2, 3));
  assert.equal(basePointHintText({ miss: false, summary: null }), DETAIL_HELPER_TEXT.basePointHint);
  assert.equal(basePointHintText({ miss: true, summary }), DETAIL_HELPER_TEXT.basePointMiss, 'miss が先');
  assert.equal(basePointHintText(), DETAIL_HELPER_TEXT.basePointHint);
  assert.equal(basePointHintText(null), DETAIL_HELPER_TEXT.basePointHint);
});

test('承認済みの文面', () => {
  assert.equal(DETAIL_HELPER_TEXT.basePointNext, '次の候補');
  assert.equal(DETAIL_HELPER_TEXT.basePointConfirm, '確定');
  assert.equal(DETAIL_HELPER_TEXT.basePointCandidate(1, 2), '候補 1 ／ 2・［確定］で基準点にします（別の頂点をタップで選び直し）');
});

test('委譲の同等性: nearestPointWithin は verticesWithin(…)[0] ?? null と同じ参照を返す（正常・同距離・境界・NaN・null 要素・空・重複）', async () => {
  const { points } = await setup();
  const sets = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2, y: 0 }],
    [{ x: -1, y: 0 }, { x: 1, y: 0 }],
    [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
    [{ x: NaN, y: 0 }, { x: 0, y: 0 }, { x: Infinity, y: 0 }],
    [null, { x: 1, y: 0 }],
    [],
    points,
  ];
  const mms = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 }, { x: NaN, y: 0 }, { x: 3235, y: 705 }];
  for (const [si, s] of sets.entries()) for (const mm of mms) for (const rad of [0, 1, 4, 5, Infinity, NaN]) {
    assert.equal(nearestPointWithin(s, mm, rad), verticesWithin(s, mm, rad)[0] ?? null, `set ${si} mm ${mm.x},${mm.y} r ${rad}`);
  }
  assert.equal(nearestPointWithin(null, { x: 0, y: 0 }, 1), null);
});
