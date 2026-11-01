// 取り合い断面の室内側の包絡線（detail/detailEnvelope.js。部分詳細図 S8a）の単体テスト。
// 局所座標: s＝壁の仕上げ面から室内側が正・t＝下向き正。FL・天井面は t=0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSlot, DetailDash, DetailEdgeMark } from '../core/constants.js';
import { computeEnvelope, EnvelopeWeight } from './detailPlacement.js';

const { FLOOR_WALL, WALL_CEILING } = DetailSlot;
const solid = { weightRole: 'medium', dashRole: DetailDash.SOLID };
const dashed = { weightRole: 'thin', dashRole: DetailDash.DASHED };
const stroke = (pts, extra = {}) => ({ id: 'x', points: pts.map(([s, t]) => ({ s, t })), closed: true, line: solid, ...extra });
// 巾木（床の上に立つ矩形。壁の仕上げ面 s=0 から depth 出て、高さ height）
const baseboard = (depth, height) => stroke([[0, -height], [depth, -height], [depth, 0], [0, 0]]);

test('矩形の巾木: 段差は巾木の天端の 1 本、輪郭は階段、形状差は出幅', () => {
  const r = computeEnvelope([baseboard(12, 60)], FLOOR_WALL);
  assert.deepEqual(r.steps, [{ t: -60, weight: EnvelopeWeight.AUTO }]);
  assert.deepEqual(r.outline, [[0, -60], [12, -60], [12, 0]]);
  assert.equal(r.maxDeviationMm, 12);
});

test('壁の中の下地（s が負）は包絡線に出ない: 下地だけなら段差なし・形状差 0、巾木と一緒でも巾木の 1 本のまま', () => {
  const backing = stroke([[-50, -300], [-10, -300], [-10, 0], [-50, 0]]);
  const alone = computeEnvelope([backing], FLOOR_WALL);
  assert.deepEqual(alone.steps, []);
  assert.equal(alone.maxDeviationMm, 0);
  const both = computeEnvelope([backing, baseboard(12, 60)], FLOOR_WALL);
  assert.deepEqual(both.steps, [{ t: -60, weight: EnvelopeWeight.AUTO }]);
  assert.equal(both.maxDeviationMm, 12);
});

test('面取り（斜めの辺）の稜線は段差でなく折れとして 2 本: 稜線の両端の高さ', () => {
  // p0(0,-60) → p1(12,-50) が面取り。s は連続（段差なし）で向きだけが変わる
  const chamfered = stroke([[0, -60], [12, -50], [12, 0], [0, 0]]);
  const r = computeEnvelope([chamfered], FLOOR_WALL);
  assert.deepEqual(r.steps, [{ t: -60, weight: EnvelopeWeight.AUTO }, { t: -50, weight: EnvelopeWeight.AUTO }]);
  assert.equal(r.maxDeviationMm, 12);
  assert.deepEqual(r.outline, [[0, -60], [12, -50], [12, 0]]);
});

test('破線のストロークは包絡線に入れない', () => {
  const r = computeEnvelope([baseboard(12, 60)].map(s => ({ ...s, line: dashed })), FLOOR_WALL);
  assert.deepEqual(r.steps, []);
  assert.equal(r.maxDeviationMm, 0);
});

test('1 mm 以下の段差は無視（閾値ちょうどは無視・超えたら段差）', () => {
  assert.deepEqual(computeEnvelope([baseboard(1, 60)], FLOOR_WALL).steps, [], '1 mm は段差でない');
  assert.deepEqual(computeEnvelope([baseboard(1.5, 60)], FLOOR_WALL).steps, [{ t: -60, weight: EnvelopeWeight.AUTO }]);
});

test('印（air）の辺は air の線になり、同じ高さの自動の段差を置き換える。印のない他の段差は auto のまま', () => {
  // 腰壁の天板: s 0〜60・t −900〜−870 の矩形。手 0（頂点 0→1＝天端の辺）に印
  const top = stroke([[0, -900], [60, -900], [60, -870], [0, -870]], { edgeMarks: [DetailEdgeMark.AIR, null, null] });
  const r = computeEnvelope([top], FLOOR_WALL);
  assert.deepEqual(r.steps, [{ t: -900, weight: EnvelopeWeight.AIR }, { t: -870, weight: EnvelopeWeight.AUTO }]);
  // 印が無ければ同じ高さは両方 auto
  const plain = computeEnvelope([{ ...top, edgeMarks: undefined }], FLOOR_WALL);
  assert.deepEqual(plain.steps, [{ t: -900, weight: EnvelopeWeight.AUTO }, { t: -870, weight: EnvelopeWeight.AUTO }]);
});

test('印の辺が自動の段差のない高さにあっても air の線が 1 本出る（重複しない）', () => {
  // 壁面に沿う縦の細い板（s 0〜0.5・段差 1 mm 以下）の上端に印
  const thin = stroke([[0, -400], [0.5, -400], [0.5, 0], [0, 0]], { edgeMarks: [DetailEdgeMark.AIR, null, null] });
  const r = computeEnvelope([thin], FLOOR_WALL);
  assert.deepEqual(r.steps, [{ t: -400, weight: EnvelopeWeight.AIR }]);
});

test('2 段の出（巾木と幅木上の見切り）: 輪郭は階段折れ線で、形状差は最大の出', () => {
  const lower = baseboard(12, 60);
  const upper = stroke([[0, -100], [30, -100], [30, -60], [0, -60]]);
  const r = computeEnvelope([lower, upper], FLOOR_WALL);
  assert.deepEqual(r.steps, [{ t: -100, weight: EnvelopeWeight.AUTO }, { t: -60, weight: EnvelopeWeight.AUTO }]);
  assert.deepEqual(r.outline, [[0, -100], [30, -100], [30, -60], [12, -60], [12, 0]]);
  assert.equal(r.maxDeviationMm, 30);
});

test('FL より下（t>0）は定義域の外: 床仕上げだけの図は空、FL の線（t≈0）は段差に積まない', () => {
  const floor = stroke([[0, 0], [30, 0], [30, 20], [0, 20]]);
  const r = computeEnvelope([floor], FLOOR_WALL);
  assert.deepEqual(r, { steps: [], outline: [], maxDeviationMm: 0 });
  assert.ok(!computeEnvelope([baseboard(12, 60)], FLOOR_WALL).steps.some(s => Math.abs(s.t) < 1e-3));
});

test('壁と天井（t>0 が下）: 廻り縁の下端が段差、輪郭は天井面から下へ', () => {
  const crown = stroke([[0, 0], [40, 0], [40, 50], [0, 50]]);
  const r = computeEnvelope([crown], WALL_CEILING);
  assert.deepEqual(r.steps, [{ t: 50, weight: EnvelopeWeight.AUTO }]);
  assert.deepEqual(r.outline, [[40, 0], [40, 50], [0, 50]]);
  assert.equal(r.maxDeviationMm, 40);
  // 天井の上（t<0）は定義域外
  assert.deepEqual(computeEnvelope([baseboard(12, 60)], WALL_CEILING), { steps: [], outline: [], maxDeviationMm: 0 });
});

test('区間の中で交差する 2 辺: 交点（t=-50）で区切って V 字の輪郭になる', () => {
  const open = pts => stroke(pts, { closed: false });
  const r = computeEnvelope([open([[0, -100], [20, 0]]), open([[20, -100], [0, 0]])], FLOOR_WALL);
  assert.deepEqual(r.outline, [[0, -100], [20, -100], [10, -50], [20, 0]]);
  assert.deepEqual(r.steps, [{ t: -100, weight: EnvelopeWeight.AUTO }, { t: -50, weight: EnvelopeWeight.AUTO }]);
  assert.equal(r.maxDeviationMm, 20);
});

test('s=0 を跨ぐ斜辺: 跨ぐ点（t=-50）から上は壁の中で見えず、そこから 0→10 で出てくる', () => {
  const r = computeEnvelope([stroke([[-10, -100], [10, 0]], { closed: false })], FLOOR_WALL);
  assert.deepEqual(r.outline, [[0, -100], [0, -50], [10, 0]]);
  assert.deepEqual(r.steps, [{ t: -50, weight: EnvelopeWeight.AUTO }]);
  assert.equal(r.maxDeviationMm, 10);
});

test('【失敗系】未知の slot・空入力・非有限の点・点の足りないストロークは例外にせず空を返す', () => {
  const empty = { steps: [], outline: [], maxDeviationMm: 0 };
  assert.deepEqual(computeEnvelope([baseboard(12, 60)], 'wall'), empty);
  assert.deepEqual(computeEnvelope([], FLOOR_WALL), empty);
  assert.deepEqual(computeEnvelope(null, FLOOR_WALL), empty);
  assert.deepEqual(computeEnvelope([stroke([[0, -60]])], FLOOR_WALL), empty);
  assert.deepEqual(computeEnvelope([stroke([[0, -60], [NaN, -60], [12, 0]], { closed: false })], FLOOR_WALL).steps, []);
});
