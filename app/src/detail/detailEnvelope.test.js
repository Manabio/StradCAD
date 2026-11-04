// 取り合い断面の室内側の包絡線（detail/detailEnvelope.js。部分詳細図 S8a）の単体テスト。
// 局所座標: s＝壁の仕上げ面から室内側が正・t＝下向き正。FL・天井面は t=0。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSlot, DetailDash, DetailEdgeMark } from '../core/constants.js';
import { computeEnvelope, computeUnderside, EnvelopeWeight } from './detailPlacement.js';

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

// ---- computeUnderside（天井の段差を下から見た包絡線。8b-4c）。s＝立ち上がり面から高い側が正・t＝下向き正。低い側の天井面 t=0・高い側の天井面 t=−300 ----
const H = -300;
const lineS = r => r.lines.map(l => l.s);
const noseOutline = [[0, 0], [120, 0], [120, -40], [90, -40], [90, -70], [0, -70], [0, H]]; // ceilingNoseFigure（出 120・厚 40・見切り 30×30）

test('computeUnderside: 面一の見切り（下面が低い側の天井面 t=0 と同じ）は出の端 1 本だけ。s=0 は連続なので CL の線は要らない', () => {
  const r = computeUnderside([stroke(noseOutline)], { tMinMm: H });
  assert.deepEqual(r.lines, [{ s: 120, weight: EnvelopeWeight.AUTO }]);
  assert.equal(r.reachMm, 120);
});

test('computeUnderside: 引っ込んだ下面（材が t≤−30 だけ）は s=0 の跳びと外端の 2 本。CL の線は残る', () => {
  const recessed = stroke([[0, -80], [100, -80], [100, -30], [0, -30]]);
  const r = computeUnderside([recessed], { tMinMm: H });
  assert.deepEqual(lineS(r), [0, 100]);
  assert.equal(r.reachMm, 100);
});

test('computeUnderside: 面取り（斜めの辺）は s=0 の跳び（CL は残る）と稜線の折れと外端', () => {
  const chamfered = stroke([[0, -10], [10, 0], [100, 0], [100, -40], [0, -40]]);
  assert.deepEqual(lineS(computeUnderside([chamfered], { tMinMm: H })), [0, 10, 100]);
});

test('computeUnderside: 下面の目地の溝は両端の 2 本（高さ方向の E(t) では消える溝を落とさない）', () => {
  const grooved = stroke([[0, 0], [50, 0], [50, -10], [60, -10], [60, 0], [120, 0], [120, -40], [0, -40]]);
  assert.deepEqual(lineS(computeUnderside([grooved], { tMinMm: H })), [50, 60, 120]);
});

test('computeUnderside: 斜めの辺と水平の辺の交点（最も低い材が入れ替わる s）にも折れの線が出る', () => {
  const rising = stroke([[0, 0], [100, -60]], { closed: false });
  const flat = stroke([[0, -30], [100, -30]], { closed: false });
  assert.deepEqual(lineS(computeUnderside([rising, flat], { tMinMm: H })), [0, 50, 100]);
});

test('computeUnderside: 吊り下がる桟（垂直の辺だけが下へ出る一点）も左右の比較に入る', () => {
  const soffit = stroke([[0, -30], [100, -30]], { closed: false });
  const rib = stroke([[60, -30], [60, -10]], { closed: false });
  assert.deepEqual(lineS(computeUnderside([soffit], { tMinMm: H })), [0, 100], '桟なし: 引っ込んだ下面の 2 本');
  assert.deepEqual(lineS(computeUnderside([soffit, rib], { tMinMm: H })), [0, 60, 100]);
});

test('computeUnderside: s=0 を跨ぐ斜辺は s≥0 の部分だけを材として見る（跨ぐ点 t=−10 で切る）', () => {
  const r = computeUnderside([stroke([[-50, -20], [50, 0]], { closed: false })], { tMinMm: H });
  assert.deepEqual(lineS(r), [0, 50]);
  assert.equal(r.reachMm, 50);
});

test('computeUnderside: 跳びの閾値 — ちょうど DETAIL_ENVELOPE_STEP_MIN_MM（1）は s=0 に線を出さず、1.5 は出す', () => {
  const flat = d => stroke([[0, -d], [100, -d]], { closed: false });
  assert.deepEqual(lineS(computeUnderside([flat(1)], { tMinMm: H })), [100]);
  assert.deepEqual(lineS(computeUnderside([flat(1.5)], { tMinMm: H })), [0, 100]);
});

test('computeUnderside: 折れの閾値 — 1° 未満は s=0 に線を出さず、1° 超は出す', () => {
  const tilt = deg => stroke([[0, 0], [100, -100 * Math.tan(deg * Math.PI / 180)]], { closed: false });
  assert.deepEqual(lineS(computeUnderside([tilt(0.99)], { tMinMm: H })), [100]);
  assert.deepEqual(lineS(computeUnderside([tilt(1.01)], { tMinMm: H })), [0, 100]);
});

test('【失敗系】computeUnderside: 破線のストロークは無視する（破線だけなら EMPTY・実線と一緒でも結果は変わらない）', () => {
  const recessed = stroke([[0, -80], [100, -80], [100, -30], [0, -30]]);
  const dashedBox = stroke([[0, -10], [500, -10], [500, 0], [0, 0]], { line: dashed });
  const empty = { lines: [], reachMm: 0 };
  assert.deepEqual(computeUnderside([dashedBox], { tMinMm: H }), empty);
  assert.deepEqual(computeUnderside([recessed, dashedBox], { tMinMm: H }), computeUnderside([recessed], { tMinMm: H }));
});

test('【失敗系】computeUnderside: 空・null・点だけ・非有限は EMPTY（s=0 の線を捏造しない）。s<0・低い側の天井より下（t>0）・高い側の天井より上は定義域の外', () => {
  const empty = { lines: [], reachMm: 0 };
  assert.deepEqual(computeUnderside([], { tMinMm: H }), empty);
  assert.deepEqual(computeUnderside(null, { tMinMm: H }), empty);
  assert.deepEqual(computeUnderside([stroke([[0, -60]])], { tMinMm: H }), empty);
  assert.deepEqual(computeUnderside([stroke([[0, -60], [NaN, -60], [12, 0]], { closed: false })], { tMinMm: H }), empty);
  assert.deepEqual(computeUnderside([stroke([[-100, -80], [-10, -80], [-10, -30], [-100, -30]])], { tMinMm: H }), empty, 's<0');
  assert.deepEqual(computeUnderside([stroke([[0, 10], [100, 10], [100, 50], [0, 50]])], { tMinMm: H }), empty, 't>0');
  assert.deepEqual(computeUnderside([stroke([[0, -400], [100, -400], [100, -350], [0, -350]])], { tMinMm: H }), empty, 't<−段差高');
  // s<0 の下地が一緒でも結果は変わらない
  const recessed = stroke([[0, -80], [100, -80], [100, -30], [0, -30]]);
  const backing = stroke([[-100, -80], [-10, -80], [-10, -30], [-100, -30]]);
  assert.deepEqual(computeUnderside([recessed, backing], { tMinMm: H }), computeUnderside([recessed], { tMinMm: H }));
});

test('【失敗系】computeUnderside: tMinMm が負の有限値でなければ EMPTY（0・正・NaN・Infinity・未指定）', () => {
  const empty = { lines: [], reachMm: 0 };
  for (const bad of [0, 300, NaN, Infinity, undefined, -Infinity]) {
    assert.deepEqual(computeUnderside([stroke(noseOutline)], { tMinMm: bad }), empty, String(bad));
  }
  assert.deepEqual(computeUnderside([stroke(noseOutline)]), empty);
});
