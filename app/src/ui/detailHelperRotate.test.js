// 下書きを基準点まわりに時計回りへ 90° 回す純関数（H2）: canRotateDraft・rotateDraft90・rotateDraftPoint90。
// 全頂点が回転式 s' = a − (t − b)・t' = b + (s − a)（(a, b)＝基準点）で動くことを、プレビューと fit（fitLocal＋placedFigureTargets）の両方で突き合わせる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toggleDxfComponent, draftFromDxf, previewPrimitivesOf, newDraft, applyPen, penUp, setClosed, setAnchor, setDatumField,
  setClassification, addDatum, removeDatum, rebaseOrigin, entryFromForm, formFromEntry, validation, tryFit,
  canRotateDraft, rotateDraft90, rotateDraftPoint90,
} from './detailHelperForm.js';
import { dxfPoly as poly, dxfRect as rect, fixedId as ids, loadDxfBody as loadBody } from './detailHelperDxfTestFixtures.js';
import { fitLocal } from '../detail/detailPlacement.js';
import { placedFigureTargets } from '../finish/placedFigure/placedFigureTargets.js';
import { placedFigureDrawPlan } from '../renderer/placedFigureDrawPlan.js';
import { PlacedFigure } from '../core/placedFigure.js';
import {
  SvgFigurePrimitiveType, DetailCategory, DetailView, DetailSubject, DetailAxis, DetailDatumKind, PenDir,
} from '../core/constants.js';

const pickAll = dxf => dxf.scene.components.reduce((d, c) => toggleDxfComponent(d, c.index), dxf);

// 斜めの手を 3 本（ss・st の組が違う）含む 1 本の輪郭と、離れた矩形（ストローク 2 本以上・非対称）
const DIAGONAL = [
  ...poly([[0, 0], [100, 0], [160, 40], [160, 120], [100, 150], [0, 120], [-30, 60]]),
  ...rect(300, 100, 60, 40),
];
const dxfDraft = async atDrawingOrigin => {
  const dxf = pickAll(await loadBody(DIAGONAL));
  const r = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin });
  assert.equal(r.error, undefined);
  return r.form;
};

// 手描きの下書き（newDraft から applyPen）。ストローク 2 本・閉じ 1 本・原点の頂点は 0 でない。
const R = PenDir.RIGHT, D = PenDir.DOWN, L = PenDir.LEFT, U = PenDir.UP;
function handDraft() {
  let f = newDraft({ idFactory: ids });
  const press = (dir, len) => { const r = applyPen(f, dir, len); assert.equal(r.error, undefined); f = r.form; };
  press(R, '100'); press(D, '50'); press(R, '30'); press(D, '20'); press(L, '130');
  f = setClosed(f, 's1', true);
  f = penUp(f);
  press(D, '40'); press(R, '25'); press(U, '10');
  return f;
}
const datumOf = (form, axis) => form.datums.find(d => d.kind === DetailDatumKind.ORIGIN && d.axis === axis);
const withOffsets = (form, a, b) => setDatumField(setDatumField(form, datumOf(form, 's').id, 'offset', String(a)), datumOf(form, 't').id, 'offset', String(b));
const handAnchored = () => {
  let f = handDraft();
  f = setAnchor(f, 's1', datumOf(f, 's').id, 2);
  f = setAnchor(f, 's2', datumOf(f, 't').id, 1);
  return f;
};
const classify = form => {
  let f = setClassification(form, 'category', DetailCategory.FIGURE);
  f = setClassification(f, 'view', DetailView.PLAN);
  return setClassification(f, 'subject', DetailSubject.SANITARY);
};

const previewPts = form => previewPrimitivesOf(form)
  .filter(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.strokeId).map(p => p.points);
const fitPts = form => {
  const entry = entryFromForm(form);
  const t = placedFigureTargets(entry);
  assert.equal(t.error, undefined);
  const r = fitLocal(entry, t.targets);
  assert.equal(r.error, undefined);
  return r.strokes.map(st => st.points.map(p => [p.s, p.t]));
};
const centerOf = form => [Number(datumOf(form, 's').offset), Number(datumOf(form, 't').offset)];
const cw = (pts, a, b) => pts.map(st => st.map(([s, t]) => [a - (t - b), b + (s - a)]));
const maxDiff = (x, y) => {
  const fx = x.flat(2);
  const fy = y.flat(2);
  assert.equal(fx.length, fy.length);
  return fx.reduce((m, v, i) => Math.max(m, Math.abs(v - fy[i])), 0);
};
const hasNegZero = value => {
  if (typeof value === 'number') return Object.is(value, -0);
  if (value && typeof value === 'object') return Object.values(value).some(hasNegZero);
  return false;
};

// プレビューと fit の両方で、全頂点が基準点まわりの時計回り 90° になる。rotateDraftPoint90 も同じ位置へ写す。
function checkRotation(form0, label) {
  const f = classify(form0);
  assert.equal(canRotateDraft(f), true, label);
  const rot = rotateDraft90(f);
  assert.equal(rot === f, false, label);
  const [a, b] = centerOf(f);
  let vertices = 0;
  for (const [name, pts] of [['プレビュー', previewPts], ['fit', fitPts]]) {
    const before = pts(f);
    const after = pts(rot);
    vertices += before.flat().length;
    assert.ok(before.flat().length >= 8, `${label} ${name}: 頂点が少なすぎる`);
    const d = maxDiff(cw(before, a, b), after);
    assert.ok(d < 1e-9, `${label} ${name}: 回転式との差 ${d}`);
    const viaPoint = before.map(st => st.map(([s, t]) => { const q = rotateDraftPoint90(f, { s, t }); return [q.s, q.t]; }));
    assert.ok(maxDiff(viaPoint, after) < 1e-9, `${label} ${name}: rotateDraftPoint90`);
    assert.ok(maxDiff(before, after) > 1, `${label} ${name}: 回っていない`);
  }
  const fixed = rotateDraftPoint90(f, { s: a, t: b });
  assert.equal(fixed.s, a, `${label} 基準点 s`);
  assert.equal(fixed.t, b, `${label} 基準点 t`);
  assert.equal(validation(rot).ok, true, label);
  assert.ok(vertices > 0);
  return rot;
}

test('回転: DXF の下書き（図面の原点基準 on／off・斜めの手つき）は、プレビューと fit の両方で基準点まわりに回る', async () => {
  const on = checkRotation(await dxfDraft(true), 'DXF on');
  const off = checkRotation(await dxfDraft(false), 'DXF off');
  for (const f of [on, off]) {
    assert.ok(f.strokes.flatMap(s => s.moves).filter(m => m.dir === PenDir.VECTOR).length >= 3, '斜めの手を含む前提');
  }
});

test('回転: 基準点が原点でない（offset 10・−5）図でも、プレビューと fit の両方が (10, −5) まわりに回る', async () => {
  checkRotation(withOffsets(await dxfDraft(true), 10, -5), 'DXF on B=(10,-5)');
  checkRotation(withOffsets(await dxfDraft(false), 10, -5), 'DXF off B=(10,-5)');
  checkRotation(withOffsets(handAnchored(), 10, -5), '手描き B=(10,-5)');
  checkRotation(withOffsets(handAnchored(), -40, 25), '手描き B=(-40,25)');
  // 対: 中心を (0,0) にした回転とは別の位置になる（B が効いている）
  const f = classify(withOffsets(handAnchored(), 10, -5));
  const q = rotateDraftPoint90(f, { s: 30, t: 7 });
  assert.deepEqual([q.s, q.t], [10 - (7 + 5), -5 + (30 - 10)]);
  assert.notDeepEqual([q.s, q.t], [-7, 30]);
});

test('回転: 手描きの下書き（原点の頂点が 0 でない・offsetMm なし／rebase で offsetMm あり）と、エントリを往復した下書き', () => {
  checkRotation(handAnchored(), '手描き');
  checkRotation(rebaseOrigin(handAnchored(), { s: 7, t: 3 }), '手描き＋rebase');
  const roundTrip = f => formFromEntry(entryFromForm(f));
  checkRotation(roundTrip(withOffsets(handAnchored(), 10, -5)), '手描き 往復');
  checkRotation(roundTrip(rebaseOrigin(withOffsets(handAnchored(), 10, -5), { s: 7, t: 3 })), '手描き rebase 往復');
});

test('回転: エントリを往復した DXF の下書き（offsetMm・斜め持ち）も回る。往復後の回転も往復前の回転と同じ点になる', async () => {
  const form = await dxfDraft(true);
  const trip = formFromEntry(entryFromForm(form));
  const rot = checkRotation(trip, 'DXF 往復');
  const direct = rotateDraft90(classify(form));
  assert.ok(maxDiff(previewPts(rot), previewPts(direct)) < 1e-9);
  assert.ok(maxDiff(fitPts(rot), fitPts(direct)) < 1e-9);
});

test('手の写し: U/D/L/R は R→D・D→L・L→U・U→R。長さ・mode・印・ほかの項目はそのまま', () => {
  let f = newDraft({ idFactory: ids });
  for (const dir of [R, D, L, U]) f = applyPen(f, dir, '10').form;
  f = { ...f, strokes: f.strokes.map(s => ({ ...s, moves: s.moves.map((m, i) => ({ ...m, edge: i === 1 ? 'air' : undefined, note: `n${i}` })) })) };
  const rot = rotateDraft90(f);
  assert.equal(rot.strokes[0].moves.map(m => m.dir).join(''), [D, L, U, R].join(''));
  rot.strokes[0].moves.forEach((m, i) => {
    const o = f.strokes[0].moves[i];
    assert.equal(JSON.stringify({ ...m, dir: 0 }), JSON.stringify({ ...o, dir: 0 }), `手 ${i}`);
  });
});

test("手の写し: 斜め（V）は dx と dy を入れ替え、ss' = −st・st' = ss（省略は +1）。edge などほかのキーは保持", async () => {
  const f = await dxfDraft(true);
  const rot = rotateDraft90(f);
  let seen = 0;
  const combos = new Set();
  f.strokes.forEach((s, si) => s.moves.forEach((m, mi) => {
    if (m.dir !== PenDir.VECTOR) return;
    const o = m.raw;
    const n = rot.strokes[si].moves[mi];
    assert.equal(n.dir, PenDir.VECTOR);
    assert.equal(JSON.stringify(n.raw.dx), JSON.stringify(o.dy));
    assert.equal(JSON.stringify(n.raw.dy), JSON.stringify(o.dx));
    assert.equal(n.raw.ss, -o.st);
    assert.equal(n.raw.st, o.ss);
    assert.notEqual(JSON.stringify(o.dx), JSON.stringify(o.dy), 'dx≠dy の前提（入れ替えの検出）');
    combos.add(`${o.ss}${o.st}`);
    seen++;
  }));
  assert.ok(seen >= 3);
  assert.ok(combos.size >= 2, 'ss・st の組が複数');
  // 省略（キー無し）と ほかのキー: ss 省略＝+1・st 省略＝+1 として写し、edge は残る
  const base = f.strokes[0].moves.findIndex(m => m.dir === PenDir.VECTOR);
  const bare = { ...f, strokes: f.strokes.map((s, i) => (i !== 0 ? s : { ...s, moves: s.moves.map((m, j) => {
    if (j !== base) return m;
    const rest = { ...m.raw, edge: 'air' };
    delete rest.ss;
    delete rest.st;
    return { ...m, raw: rest };
  }) })) };
  const n = rotateDraft90(bare).strokes[0].moves[base].raw;
  assert.equal(n.ss, -1);
  assert.equal(n.st, 1);
  assert.equal(n.edge, 'air');
  // 省略した斜めを含む図も、実際の座標では回転式どおり
  const c = classify(bare);
  assert.ok(maxDiff(cw(previewPts(c), 0, 0), previewPts(rotateDraft90(c))) < 1e-9);
  assert.ok(maxDiff(cw(fitPts(c), 0, 0), fitPts(rotateDraft90(c))) < 1e-9);
});

test('Anchor の付け替え: s の基準→t の基準（offsetMm そのまま）・t の基準→s の基準（offsetMm の符号反転）。基準・並び・頂点は不変', () => {
  const f = rebaseOrigin(handAnchored(), { s: 30, t: -12 }); // s の Anchor＝−30・t の Anchor＝+12
  const ds = datumOf(f, 's').id;
  const dt = datumOf(f, 't').id;
  const rot = rotateDraft90(f);
  assert.equal(JSON.stringify(rot.datums), JSON.stringify(f.datums), '基準は不変');
  assert.equal(rot.anchors.length, f.anchors.length);
  f.anchors.forEach((a, i) => {
    const n = rot.anchors[i];
    assert.equal(n.strokeId, a.strokeId);
    assert.equal(n.vertexIndex, a.vertexIndex);
    if (a.datumId === ds) {
      assert.equal(n.datumId, dt);
      assert.equal(n.offsetMm, a.offsetMm);
    } else {
      assert.equal(a.datumId, dt);
      assert.equal(n.datumId, ds);
      assert.equal(n.offsetMm, -a.offsetMm);
    }
  });
  assert.equal(f.anchors.some(a => a.offsetMm === -30) && f.anchors.some(a => a.offsetMm === 12), true);
  // offsetMm の無い Anchor は結果が 0 のとき（t→s）キーを付けず、s→t もキーを足さない
  const plain = handAnchored();
  assert.equal(plain.anchors.some(a => Object.hasOwn(a, 'offsetMm')), false);
  assert.equal(rotateDraft90(plain).anchors.some(a => Object.hasOwn(a, 'offsetMm')), false);
  // 数でない offsetMm（検証が弾く値）は符号反転で数に化けさせない——回した後もその値のまま・検証の結果も同じ
  let checked = 0;
  for (const bad of ['5', null]) {
    const broken = { ...f, anchors: f.anchors.map(a => (a.datumId === dt ? { ...a, offsetMm: bad } : a)) };
    const turned = rotateDraft90(broken);
    const moved = turned.anchors.filter((a, i) => broken.anchors[i].datumId === dt);
    assert.ok(moved.length >= 1);
    assert.equal(moved.every(a => a.datumId === ds && a.offsetMm === bad), true, `offsetMm=${String(bad)} はそのまま`);
    const codes = form => validation(form).errors.map(e => e.code).sort().join(',');
    assert.equal(codes(turned), codes(broken), `offsetMm=${String(bad)}: 検証の結果は回す前と同じ`);
    assert.notEqual(codes(broken), '');
    checked += 1;
  }
  assert.equal(checked, 2);
});

test('4 回で元の JSON に戻る（offsetMm 持ちの DXF の下書き・持たない手描き・rebase 済み）。2 回で 180°・3 回で反時計回り 90°', async () => {
  const four = f => rotateDraft90(rotateDraft90(rotateDraft90(rotateDraft90(f))));
  const dxfOn = await dxfDraft(true);
  const dxfOff = await dxfDraft(false);
  assert.ok(dxfOn.anchors.every(a => Number.isFinite(a.offsetMm)));
  for (const [label, f] of [['DXF on', dxfOn], ['DXF off', dxfOff], ['手描き', handAnchored()], ['手描き B', withOffsets(handAnchored(), 10, -5)],
    ['rebase', rebaseOrigin(handAnchored(), { s: 7, t: 3 })], ['rebase 0', rebaseOrigin(handDraft(), { s: 0, t: 0 })]]) {
    assert.equal(JSON.stringify(four(f)), JSON.stringify(f), label);
    assert.equal(JSON.stringify(rotateDraft90(rotateDraft90(f))) === JSON.stringify(f), false, `${label}: 2 回は元と違う`);
  }
  const f = classify(withOffsets(await dxfDraft(false), 10, -5));
  const [a, b] = centerOf(f);
  const base = previewPts(f);
  const twice = rotateDraft90(rotateDraft90(f));
  const thrice = rotateDraft90(twice);
  assert.ok(maxDiff(base.map(st => st.map(([s, t]) => [2 * a - s, 2 * b - t])), previewPts(twice)) < 1e-9, '180°');
  assert.ok(maxDiff(base.map(st => st.map(([s, t]) => [a + (t - b), b - (s - a)])), previewPts(thrice)) < 1e-9, '反時計回り 90°');
  assert.ok(maxDiff(base.map(st => st.map(([s, t]) => [2 * a - s, 2 * b - t])), fitPts(twice)) < 1e-9, 'fit 180°');
});

test('−0 を作らない（offsetMm が 0 の Anchor を t→s へ回しても +0・4 回まわしても）', () => {
  const zero = rebaseOrigin(handDraft(), { s: 0, t: 0 });
  assert.ok(zero.anchors.length >= 4);
  assert.ok(zero.anchors.every(a => Object.is(a.offsetMm, 0)));
  let f = zero;
  for (let i = 0; i < 4; i++) {
    f = rotateDraft90(f);
    assert.equal(hasNegZero(f.anchors), false, `${i + 1} 回目`);
  }
  const q = rotateDraftPoint90(zero, { s: 0, t: 0 });
  assert.equal(Object.is(q.s, 0) && Object.is(q.t, 0), true);
});

test('回した後の検証: 通る図は通り、通らない図は（同じエラーの種類で）通らないまま', () => {
  const good = classify(handAnchored());
  assert.equal(validation(good).ok, true);
  assert.equal(validation(rotateDraft90(good)).ok, true);
  // 通らない図: s2 から t の原点の Anchor を外す（NO_ORIGIN_ANCHOR）・長さ 0・閉じた図が始点に戻る
  const dt = datumOf(good, 't').id;
  const noAnchor = { ...good, anchors: good.anchors.filter(a => !(a.strokeId === 's2' && a.datumId === dt)) };
  const zeroLen = { ...good, strokes: good.strokes.map((s, i) => (i === 1 ? { ...s, moves: s.moves.map(m => ({ ...m, len: '0' })) } : s)) };
  let checked = 0;
  for (const bad of [noAnchor, zeroLen]) {
    const before = validation(bad);
    assert.equal(before.ok, false);
    const rot = rotateDraft90(bad);
    assert.equal(rot === bad, false, '回せる（条件は満たす）');
    const after = validation(rot);
    assert.equal(after.ok, false);
    assert.equal(JSON.stringify(after.errors.map(e => e.code).sort()), JSON.stringify(before.errors.map(e => e.code).sort()));
    checked++;
  }
  assert.equal(checked, 2);
});

test('［基準点を指す］との順序: 頂点 V を基準点にしてから回す＝回してから同じ頂点 V を基準点にする（プレビューの点が一致）', async () => {
  for (const [label, form] of [['DXF', await dxfDraft(true)], ['手描き', handAnchored()]]) {
    const f = classify(form);
    const before = previewPts(f);
    const rotated = rotateDraft90(f);
    const after = previewPts(rotated);
    let compared = 0;
    for (const [si, st] of before.entries()) {
      for (const vi of [0, 2, st.length - 1]) {
        const v = st[vi];
        const rebaseThenRotate = rotateDraft90(rebaseOrigin(f, { s: v[0], t: v[1] }));
        const w = after[si][vi];
        const rotateThenRebase = rebaseOrigin(rotated, { s: w[0], t: w[1] });
        const d = maxDiff(previewPts(rebaseThenRotate), previewPts(rotateThenRebase));
        assert.ok(d < 1e-9, `${label} stroke${si} P${vi}: ${d}`);
        assert.ok(maxDiff(fitPts(rebaseThenRotate), fitPts(rotateThenRebase)) < 1e-9, `${label} fit stroke${si} P${vi}`);
        compared++;
      }
    }
    assert.ok(compared >= 6, label);
  }
});

test('便器の平面を模した合成図: 1 回まわして配置 0° で描くと、先端が +y（下）・付属の図が −x 側に来る', async () => {
  // 壁側が s=0・先端が +s（s=700）。付属の小さな図は +t 側（t 210〜340）の壁際（s 20〜100）にだけある。DXF の y は上向き正（t=−y）
  const dxf = pickAll(await loadBody([...rect(0, -200, 700, 400), ...rect(20, -340, 80, 130)]));
  const { form } = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: true });
  const f = classify(form);
  const draw = figure => {
    const entry = entryFromForm(figure);
    const plan = placedFigureDrawPlan([new PlacedFigure({ id: 'p1', figureKey: entry.key, x: 300, y: 100 })], key => (key === entry.key ? entry : null));
    assert.equal(plan.lines.length, 2);
    const boxes = plan.lines.map(l => {
      const xs = l.points.filter((_, i) => i % 2 === 0);
      const ys = l.points.filter((_, i) => i % 2 === 1);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
    const body = boxes[0].maxX - boxes[0].minX + (boxes[0].maxY - boxes[0].minY) > boxes[1].maxX - boxes[1].minX + (boxes[1].maxY - boxes[1].minY) ? boxes[0] : boxes[1];
    const attach = body === boxes[0] ? boxes[1] : boxes[0];
    return { body, attach };
  };
  // 回す前（対照）: 先端は +x・付属は本体より下（+y）
  const b0 = draw(f);
  assert.deepEqual([b0.body.minX, b0.body.maxX, b0.body.minY, b0.body.maxY], [300, 1000, -100, 300]);
  assert.equal(b0.attach.minY > b0.body.maxY, true);
  const r = draw(rotateDraft90(f));
  assert.deepEqual([r.body.minX, r.body.maxX, r.body.minY, r.body.maxY], [100, 500, 100, 800], '先端（s=700）が y=800（下）');
  assert.equal(r.attach.maxX < r.body.minX, true, '付属の図は本体の −x 側');
  assert.deepEqual([r.attach.minX, r.attach.maxX], [300 - 340, 300 - 210]);
  assert.equal(r.attach.minY >= r.body.minY && r.attach.maxY <= r.body.minY + 100, true, '壁際（上端 y=100 の近く）にある');
});

test('tryFit（パネルが通す試し込み）でも回っている', () => {
  const f = classify(withOffsets(handAnchored(), 10, -5));
  const rot = rotateDraft90(f);
  const pts = x => { const r = tryFit(x, {}); assert.equal(r.error, undefined); return r.strokes.map(s => s.points.map(p => [p.s, p.t])); };
  assert.ok(maxDiff(cw(pts(f), 10, -5), pts(rot)) < 1e-9);
});

test('入力を破壊しない: 回す前の form の JSON は回した後も同じ（回せる図・回せない図の両方）', async () => {
  const forms = [await dxfDraft(true), await dxfDraft(false), handAnchored(), withOffsets(handAnchored(), 10, -5), newDraft({ idFactory: ids })];
  let n = 0;
  for (const f of forms) {
    const snapshot = JSON.stringify(f);
    rotateDraft90(f);
    rotateDraft90(rotateDraft90(f));
    rotateDraftPoint90(f, { s: 1, t: 2 });
    canRotateDraft(f);
    assert.equal(JSON.stringify(f), snapshot);
    n++;
  }
  assert.equal(n, 5);
  assert.equal(canRotateDraft(forms[0]), true);
  assert.equal(rotateDraft90(forms[0]) === forms[0], false);
});

test('【失敗系】回せない図: canRotateDraft は false・rotateDraft90 は同じ参照・rotateDraftPoint90 は点をそのまま（同じ参照）', () => {
  const good = handAnchored();
  const ds = datumOf(good, 's').id;
  const vector = { dir: PenDir.VECTOR, raw: { dir: PenDir.VECTOR, dx: { mm: 1, mode: 'fixed' }, dy: { mm: 2, mode: 'fixed' } } };
  const cases = {
    'end の基準あり': addDatum(good, { axis: DetailAxis.T, kind: DetailDatumKind.END }),
    's の原点が無い': removeDatum(good, ds),
    's の原点が 2 つ': addDatum(good, { axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN }),
    't の原点が 2 つ': addDatum(good, { axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN }),
    'ストローク 0 本': newDraft({ idFactory: ids }),
    '未知の向き': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { dir: 'X', mode: 'fixed', len: '1' }] } : s)) },
    '向き無しの手': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, {}] } : s)) },
    '手が null': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, null] } : s)) },
    '斜めの raw が無い': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { dir: PenDir.VECTOR }] } : s)) },
    // 壊れた斜め（検証が弾く値）は回さない——回すと壊れた図が通る図に変わる・−0 ができる・4 回で元に戻らない
    '斜めの raw が配列': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { dir: PenDir.VECTOR, raw: [] }] } : s)) },
    '斜めの st が文字列': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { ...vector, raw: { ...vector.raw, st: '1' } }] } : s)) },
    '斜めの st が 0': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { ...vector, raw: { ...vector.raw, st: 0 } }] } : s)) },
    '斜めの ss が null': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { ...vector, raw: { ...vector.raw, ss: null } }] } : s)) },
    // s と t の原点が同じ id（付け替えの対応が作れない）
    's/t の原点が同じ id': { ...good, datums: good.datums.map(d => (d.id === datumOf(good, 't').id ? { ...d, id: ds } : d)) },
    'moves が配列でない': { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: null } : s)) },
    'anchors が配列でない': { ...good, anchors: null },
    'datums が配列でない': { ...good, datums: {} },
    'strokes が配列でない': { ...good, strokes: 'x' },
    'null': null,
    'undefined': undefined,
    '空のオブジェクト': {},
  };
  // 対照: 斜めの raw があれば回せる
  const withVector = { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, vector] } : s)) };
  assert.equal(canRotateDraft(withVector), true);
  const p = { s: 3, t: 4 };
  let n = 0;
  for (const [label, f] of Object.entries(cases)) {
    assert.equal(canRotateDraft(f), false, label);
    assert.equal(rotateDraft90(f) === f, true, `${label}: 同じ参照`);
    assert.equal(rotateDraftPoint90(f, p) === p, true, `${label}: 点はそのまま`);
    n++;
  }
  assert.ok(n >= 20);
  // 対照: 符号が ±1 の斜めは回せる
  for (const [ss, st] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const signed = { ...good, strokes: good.strokes.map((s, i) => (i === 0 ? { ...s, moves: [...s.moves, { ...vector, raw: { ...vector.raw, ss, st } }] } : s)) };
    assert.equal(canRotateDraft(signed), true, `ss=${ss} st=${st}`);
  }
  // 分類は条件に入れない（分類が未決の下書きも回せる）
  assert.equal(canRotateDraft(good), true);
  assert.equal(canRotateDraft(classify(good)), true);
});

test('【失敗系】rotateDraftPoint90: 有限でない点・点が無い・形が違う点は、回せる図でも渡した点をそのまま返す', () => {
  const f = handAnchored();
  let n = 0;
  for (const bad of [{ s: NaN, t: 0 }, { s: 0, t: Infinity }, { s: 1 }, { s: '1', t: 2 }, null, undefined]) {
    assert.equal(rotateDraftPoint90(f, bad) === bad, true, JSON.stringify(bad));
    n++;
  }
  assert.equal(n, 6);
  // offset 欄が数でない（入力途中）なら 0 として回す（プレビューと同じ）
  const blank = setDatumField(f, datumOf(f, 's').id, 'offset', '');
  const q = rotateDraftPoint90(blank, { s: 5, t: 2 });
  assert.deepEqual([q.s, q.t], [-2, 5]);
});
