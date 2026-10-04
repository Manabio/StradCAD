// beamJunction.js resolveBeamJunctionSpans の任意引数 { eaveCorners }（下屋の軒の側の梁が出隅で勝ち、けらばの出幅ぶん延びる。
// 伏図の描画だけ）のテスト。引数を渡さない・空なら今までと同じ結果であることは既存の beamJunction.test.js の入力で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBeamJunctionSpans } from './beamJunction.js';

const THROUGH = Object.freeze({ beamJunction: 'throughWins' });

function beam(id, isVertical, axisValue, end1, end2, opts = {}) {
  const { role = 'primary', halfWidth = 60, sectionKey = 'S', base1 = end1, base2 = end2 } = opts;
  return { id, role, isVertical, axisValue, end1, end2, base1, base2, halfWidth, sectionKey };
}

const CORNER_H = { x: 0, y: 0, eaveIsVertical: false, extendMm: 455 }; // 軒の梁は横（y=0 の梁）
const entries = map => JSON.stringify([...map]);

test('軒の側が短くても勝つ: 軒の梁の端はけらばの出幅 455 ぶん外へ（eaveExtend・capped）、けらばの梁は軒の梁の面（半幅 60）で止まる', () => {
  const beams = [beam('H', false, 0, 0, 1000), beam('V', true, 0, 0, 3000)];
  const before = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(before.get('V').ends[0].kind, 'cornerClose', '前提: 今は長い方（V）が勝つ');
  assert.equal(before.get('H').ends[0].kind, 'winnerFace', '前提: 短い H は負け');
  const j = resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [CORNER_H] });
  assert.equal(j.get('H').coord1, -455);
  assert.deepEqual(j.get('H').ends[0], { kind: 'eaveExtend', capped: true });
  assert.equal(j.get('H').coord2, 1000, '反対側の端は base のまま');
  assert.equal(j.get('V').coord1, 60, 'けらばの梁は勝者（軒）の面で止まる');
  assert.deepEqual(j.get('V').ends[0], { kind: 'winnerFace', capped: false });
});

test('軒の側が長いときも同じ（軒が勝つ）。軒の梁が縦（eaveIsVertical:true）の角も向きを入れ替えて同じ', () => {
  const beams = [beam('H', false, 0, 0, 3000), beam('V', true, 0, 0, 1000)];
  const j = resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [CORNER_H] });
  assert.equal(j.get('H').coord1, -455);
  const jv = resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [{ ...CORNER_H, eaveIsVertical: true }] });
  assert.equal(jv.get('V').coord1, -455, '縦の梁が軒');
  assert.deepEqual(jv.get('V').ends[0], { kind: 'eaveExtend', capped: true });
  assert.equal(jv.get('H').coord1, 60, '横の梁（けらば）は縦の梁の面で止まる');
});

test('延長の座標は max(負け側の半幅, extendMm): けらばの出幅が小さければ負け側の半幅（今の角閉じと同じ）', () => {
  const beams = [beam('H', false, 0, 0, 1000, { halfWidth: 60 }), beam('V', true, 0, 0, 3000, { halfWidth: 45 })];
  const at = extendMm => resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [{ ...CORNER_H, extendMm }] }).get('H').coord1;
  assert.equal(at(455), -455);
  assert.equal(at(45), -45, 'extendMm = 負け側（V）の半幅');
  assert.equal(at(30), -45, '出幅が負け側の半幅より小さければ半幅');
  assert.equal(at(100), -100);
});

test('けらば側に梁が無い角でも、軒の梁の端だけは延ばす（今は勝者が決まらず飛ばす交点）', () => {
  const beams = [beam('H', false, 0, 0, 1000)];
  assert.equal(resolveBeamJunctionSpans(THROUGH, beams).size, 0, '前提: 今は何もしない');
  const j = resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [CORNER_H] });
  assert.equal(j.size, 1);
  assert.equal(j.get('H').coord1, -455);
  assert.deepEqual(j.get('H').ends, [{ kind: 'eaveExtend', capped: true }, { kind: 'base', capped: false }]);
});

test('軒の側が通し（両側に続く梁）なら今までどおり。軒の側に梁の端が無い角・角から離れた交点も対象外', () => {
  const through = [beam('H1', false, 0, -1000, 0), beam('H2', false, 0, 0, 1000), beam('V', true, 0, 0, 800, { sectionKey: 'T' })];
  assert.equal(entries(resolveBeamJunctionSpans(THROUGH, through, { eaveCorners: [CORNER_H] })), entries(resolveBeamJunctionSpans(THROUGH, through)),
    '軒の側が通しなら何も変えない');
  const gableOnly = [beam('V', true, 0, 0, 800), beam('W', true, 0, 800, 1600)];
  assert.equal(entries(resolveBeamJunctionSpans(THROUGH, gableOnly, { eaveCorners: [CORNER_H] })), entries(resolveBeamJunctionSpans(THROUGH, gableOnly)));
  const beams = [beam('H', false, 0, 0, 1000), beam('V', true, 0, 0, 3000)];
  for (const corner of [{ ...CORNER_H, x: 5000, y: 5000 }, { ...CORNER_H, x: 0.6 }]) {
    assert.equal(entries(resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [corner] })), entries(resolveBeamJunctionSpans(THROUGH, beams)), JSON.stringify(corner));
  }
});

test('eaveCorners を渡さない・空・undefined・null は今までと完全に同じ結果（既存テストの入力で比較）', () => {
  const inputs = [
    [beam('H1', false, 0, -1000, 0, { halfWidth: 60 }), beam('H2', false, 0, 0, 1000, { halfWidth: 60 }), beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 })],
    [beam('XA', false, 0, 0, 1000, { sectionKey: 'A' }), beam('XB', false, 0, 0, 600, { sectionKey: 'B' }), beam('YV', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 45 })],
    [beam('H', false, 0, 0, 1000), beam('V', true, 0, 0, 3000)],
  ];
  for (const beams of inputs) {
    const plain = entries(resolveBeamJunctionSpans(THROUGH, beams));
    assert.ok(plain.length > 2, '前提: 結果が空でない');
    for (const eaveCorners of [[], undefined, null]) {
      assert.equal(entries(resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners })), plain, String(eaveCorners));
    }
    assert.equal(entries(resolveBeamJunctionSpans(THROUGH, beams, { tol: 0.5 })), plain);
  }
});

test("【失敗系】drawing.beamJunction!=='throughWins'（非在来）は eaveCorners があっても空Map。梁が無くても空", () => {
  const beams = [beam('H', false, 0, 0, 1000), beam('V', true, 0, 0, 3000)];
  assert.equal(resolveBeamJunctionSpans({ beamJunction: 'columnFace' }, beams, { eaveCorners: [CORNER_H] }).size, 0);
  assert.equal(resolveBeamJunctionSpans(undefined, beams, { eaveCorners: [CORNER_H] }).size, 0);
  assert.equal(resolveBeamJunctionSpans(THROUGH, [], { eaveCorners: [CORNER_H] }).size, 0);
  assert.equal(resolveBeamJunctionSpans(THROUGH, null, { eaveCorners: [CORNER_H] }).size, 0);
});

test('primary 以外（床梁・軒桁）は参加しない: 角に軒桁(eaves)だけがあっても eaveExtend は出ない', () => {
  const beams = [beam('E', false, 0, 0, 1000, { role: 'eaves' })];
  assert.equal(resolveBeamJunctionSpans(THROUGH, beams, { eaveCorners: [CORNER_H] }).size, 0);
});
