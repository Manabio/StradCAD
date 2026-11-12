// structural/bandOutline.js（同面で一体の帯の和集合の外形線）の単体テスト。
// 数・文字列・数の配列だけを比べる（assert にオブジェクトを渡さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionBandOutline, segmentsMinusGaps, foundationBandInputs } from './bandOutline.js';

const H = (id, axisValue, lo, hi, half = 75) => ({ id, isVertical: false, axisValue, lo, hi, half });
const V = (id, axisValue, lo, hi, half = 75) => ({ id, isVertical: true, axisValue, lo, hi, half });

const flat = (segs) => segs.map(s => [s.x1, s.y1, s.x2, s.y2]);
const length = (segs) => segs.reduce((a, s) => a + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
const totalLength = (map) => [...map.values()].reduce((a, segs) => a + length(segs), 0);
const countSegs = (map) => [...map.values()].reduce((a, segs) => a + segs.length, 0);

const FIXTURES = {
  '十字・幅同じ': [H('h1', 0, -500, 0), H('h2', 0, 0, 500), V('v1', 0, -500, 0), V('v2', 0, 0, 500)],
  '十字・幅違い': [H('h1', 0, -500, 0, 75), H('h2', 0, 0, 500, 75), V('v1', 0, -500, 0, 100), V('v2', 0, 0, 500, 100)],
  'T・端3本': [H('h1', 0, -500, 0), H('h2', 0, 0, 500), V('v1', 0, 0, 500)],
  'T・通し1本の途中': [H('h1', 0, -500, 500), V('v1', 0, 0, 500)],
  L: [H('h1', 0, 0, 1000), V('v1', 0, 0, 1000)],
  '一直線の突合せ': [H('h1', 0, -500, 0), H('h2', 0, 0, 500)],
  '自由端': [H('h1', 0, 0, 1000)],
  '離れた2本': [H('h1', 0, 0, 1000), H('h2', 1000, 0, 1000)],
  '同じ線の重複': [H('h1', 0, 0, 600), H('h2', 0, 400, 1000)],
  '通しと通しの十字':[H('h1', 0, -500, 500), V('v1', 0, -500, 500)],
  // 角が両方の hi 端にある L（横帯 x∈[-1000,0]・縦帯 y∈[-1000,0] が (0,0) で出会う）と、lo/hi の混ざった L
  'L・横hi×縦hi': [H('h1', 0, -1000, 0), V('v1', 0, -1000, 0)],
  'L・横lo×縦hi': [H('h1', 0, 0, 1000), V('v1', 0, -1000, 0)],
  'L・横hi×縦lo': [H('h1', 0, -1000, 0), V('v1', 0, 0, 1000)],
  // T の幹の向き 4 方向（端3本＝通し横を 2 本に割って幹を足す）。lo 端で当たる向き・hi 端で当たる向きの両方
  'T・端3本・幹が上': [H('h1', 0, -500, 0), H('h2', 0, 0, 500), V('v1', 0, -500, 0)],
  'T・端3本・幹が右': [V('v1', 0, -500, 0), V('v2', 0, 0, 500), H('h1', 0, 0, 500)],
  'T・端3本・幹が左': [V('v1', 0, -500, 0), V('v2', 0, 0, 500), H('h1', 0, -500, 0)],
  // T（通し 1 本の途中に幹の端）の幹の向き 4 方向
  'T・通し横・幹が上': [H('h1', 0, -500, 500), V('v1', 0, -500, 0)],
  'T・通し縦・幹が右': [V('v1', 0, -500, 500), H('h1', 0, 0, 500)],
  'T・通し縦・幹が左': [V('v1', 0, -500, 500), H('h1', 0, -500, 0)],
  // 十字（通し 1 本＋反対向きの端 2 本。端は lo 側・hi 側の両方）
  '十字・通し横＋縦の端2本': [H('h1', 0, -500, 500), V('v1', 0, -500, 0), V('v2', 0, 0, 500)],
  '十字・通し縦＋横の端2本': [V('v1', 0, -500, 500), H('h1', 0, -500, 0), H('h2', 0, 0, 500)],
};

// 各 fixture の「和集合はこの矩形群」の手書き（延長規則の式を使わず、素の矩形で列挙する。座標はすべて格子 25mm 上）。
// 帯の半幅 75（十字・幅違いだけ縦 100）。出会う端は相手の half だけ外へ延びる（L の外角が閉じる）ので、その結果の矩形をここへ手で書く。
const bar = (x0, x1, y0, y1) => ({ x0, x1, y0, y1 });
const PLUS = [bar(-500, 500, -75, 75), bar(-75, 75, -500, 500)];
const COVER = {
  '十字・幅同じ': PLUS,
  '十字・幅違い': [bar(-500, 500, -75, 75), bar(-100, 100, -500, 500)],
  'T・端3本': [bar(-500, 500, -75, 75), bar(-75, 75, -75, 500)],
  'T・通し1本の途中': [bar(-500, 500, -75, 75), bar(-75, 75, -75, 500)],
  L: [bar(-75, 1000, -75, 75), bar(-75, 75, -75, 1000)],
  '一直線の突合せ': [bar(-500, 500, -75, 75)],
  '自由端': [bar(0, 1000, -75, 75)],
  '離れた2本': [bar(0, 1000, -75, 75), bar(0, 1000, 925, 1075)],
  '同じ線の重複': [bar(0, 1000, -75, 75)],
  '通しと通しの十字': PLUS,
  'L・横hi×縦hi': [bar(-1000, 75, -75, 75), bar(-75, 75, -1000, 75)],
  'L・横lo×縦hi': [bar(-75, 1000, -75, 75), bar(-75, 75, -1000, 75)],
  'L・横hi×縦lo': [bar(-1000, 75, -75, 75), bar(-75, 75, -75, 1000)],
  'T・端3本・幹が上': [bar(-500, 500, -75, 75), bar(-75, 75, -500, 75)],
  'T・端3本・幹が右': [bar(-75, 75, -500, 500), bar(-75, 500, -75, 75)],
  'T・端3本・幹が左': [bar(-75, 75, -500, 500), bar(-500, 75, -75, 75)],
  'T・通し横・幹が上': [bar(-500, 500, -75, 75), bar(-75, 75, -500, 75)],
  'T・通し縦・幹が右': [bar(-75, 75, -500, 500), bar(-75, 500, -75, 75)],
  'T・通し縦・幹が左': [bar(-75, 75, -500, 500), bar(-500, 75, -75, 75)],
  '十字・通し横＋縦の端2本': PLUS,
  '十字・通し縦＋横の端2本': PLUS,
};

// 各 fixture の外形の全周長（手計算）。式＝根拠。
const PERIMETER = {
  '十字・幅同じ': 4 * (2 * (500 - 75) + 150), // 4 腕 ×（腕の側線 2 本＝交差部の面 75 から先端 500 まで＋先端の小口 150）
  '十字・幅違い': 150 * 2 + 200 * 2 + 400 * 4 + 425 * 4, // 横腕の小口 150×2・縦腕の小口 200×2・横の側線（100→500）400×4・縦の側線（75→500）425×4
  'T・端3本': 1000 + 300 + 850 + 850 + 150, // 通しの上辺 1000＋通しの小口 150×2＋下辺（500-75）×2＋幹の側線（500-75）×2＋幹の小口 150
  'T・通し1本の途中': 1000 + 300 + 850 + 850 + 150, // 同じ T の形（幹は芯 0 から 500 まで＋出会う端の延長 75）
  L: 2 * (1075 + 1075), // 外角が閉じる L の外形＝腕の外寸 1075（1000＋延長 75）の正方形の周長に等しい
  '一直線の突合せ': 1000 * 2 + 150 * 2, // 1 本の帯 1000×150 の周長（境の小口は消える）
  '自由端': 1000 * 2 + 150 * 2, // 1 本の帯 1000×150
  '離れた2本': (1000 * 2 + 150 * 2) * 2, // 互いに無関係な 2 本
  '同じ線の重複': 1000 * 2 + 150 * 2, // 合わせて 1 本の帯 1000×150
  '通しと通しの十字': 4 * (2 * (500 - 75) + 150), // 十字（4 腕）と同じ
  'L・横hi×縦hi': 2 * (1075 + 1075), // 腕の外寸 1075（1000＋延長 75）の L
  'L・横lo×縦hi': 2 * (1075 + 1075),
  'L・横hi×縦lo': 2 * (1075 + 1075),
  'T・端3本・幹が上': 1000 + 300 + 850 + 850 + 150, // T と同じ周長（向きが違うだけ）
  'T・端3本・幹が右': 1000 + 300 + 850 + 850 + 150,
  'T・端3本・幹が左': 1000 + 300 + 850 + 850 + 150,
  'T・通し横・幹が上': 1000 + 300 + 850 + 850 + 150,
  'T・通し縦・幹が右': 1000 + 300 + 850 + 850 + 150,
  'T・通し縦・幹が左': 1000 + 300 + 850 + 850 + 150,
  '十字・通し横＋縦の端2本': 4 * (2 * (500 - 75) + 150), // 十字（4 腕）と同じ
  '十字・通し縦＋横の端2本': 4 * (2 * (500 - 75) + 150),
};

// 格子（G mm）上の単位辺で外形を比べる。cover（手書きの矩形群）の和集合の境界の単位辺の集合と、出力の線分が覆う単位辺の多重集合を作る。
const G = 25;
function expectedBoundaryUnits(cover) {
  const inside = (i, j) => cover.some(r => (i + 0.5) * G > r.x0 && (i + 0.5) * G < r.x1 && (j + 0.5) * G > r.y0 && (j + 0.5) * G < r.y1);
  const xs = cover.flatMap(r => [r.x0, r.x1]), ys = cover.flatMap(r => [r.y0, r.y1]);
  const i0 = Math.floor(Math.min(...xs) / G) - 1, i1 = Math.ceil(Math.max(...xs) / G) + 1;
  const j0 = Math.floor(Math.min(...ys) / G) - 1, j1 = Math.ceil(Math.max(...ys) / G) + 1;
  const keys = new Set();
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (!inside(i, j)) continue;
      if (!inside(i - 1, j)) keys.add(`v:${i * G}:${j}`);
      if (!inside(i + 1, j)) keys.add(`v:${(i + 1) * G}:${j}`);
      if (!inside(i, j - 1)) keys.add(`h:${j * G}:${i}`);
      if (!inside(i, j + 1)) keys.add(`h:${(j + 1) * G}:${i}`);
    }
  }
  return keys;
}
function actualUnitCounts(out) {
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const segs of out.values()) {
    for (const s of segs) {
      for (const v of [s.x1, s.y1, s.x2, s.y2]) assert.equal(Number.isInteger(v / G), true, `座標 ${v} が格子上にない`);
      if (s.x1 === s.x2) {
        for (let y = Math.min(s.y1, s.y2); y < Math.max(s.y1, s.y2); y += G) add(`v:${s.x1}:${y / G}`);
      } else {
        for (let x = Math.min(s.x1, s.x2); x < Math.max(s.x1, s.x2); x += G) add(`h:${s.y1}:${x / G}`);
      }
    }
  }
  return counts;
}
// 向き（'v'＝x=coord の縦線・'h'＝y=coord の横線）と座標が同じ線分の、覆う範囲 [最小, 最大]・長さの合計。
function lineSpan(out, orient, coord) {
  let min = Infinity, max = -Infinity, len = 0;
  for (const segs of out.values()) {
    for (const s of segs) {
      const on = orient === 'v' ? (s.x1 === coord && s.x2 === coord) : (s.y1 === coord && s.y2 === coord);
      if (!on) continue;
      const a = orient === 'v' ? Math.min(s.y1, s.y2) : Math.min(s.x1, s.x2);
      const c = orient === 'v' ? Math.max(s.y1, s.y2) : Math.max(s.x1, s.x2);
      min = Math.min(min, a); max = Math.max(max, c); len += c - a;
    }
  }
  return [min, max, len];
}

test('十字（端4本が芯で出会う・幅同じ）: 外形は十字の周長 4000 だけ。中央の線は無い', () => {
  const out = unionBandOutline(FIXTURES['十字・幅同じ']);
  assert.equal(totalLength(out), 4000);
  // 中央 150×150 の中（|x|<75 かつ |y|<75）の線は無い
  for (const segs of out.values()) {
    for (const s of segs) {
      const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
      assert.equal(Math.abs(mx) < 75 && Math.abs(my) < 75, false);
    }
  }
});

test('十字（幅違い: 横75・縦100）: 外形が閉じる（周長 = 手計算）', () => {
  const out = unionBandOutline(FIXTURES['十字・幅違い']);
  // 横の腕: 先端 150 が 2 本、縦の腕: 先端 200 が 2 本。辺は各腕の先から交差部まで。
  // 横の腕の辺（y=±75）は x=±100 から ±500 まで 400×4 本、縦の腕の辺（x=±100）は y=±75 から ±500 まで 425×4 本。
  assert.equal(totalLength(out), 150 * 2 + 200 * 2 + 400 * 4 + 425 * 4);
});

test('L: 外角が閉じ、内角は 1 点で出会う（周長 4300）', () => {
  const out = unionBandOutline(FIXTURES.L);
  assert.equal(totalLength(out), 4300);
  // 外角: 横帯の上辺が x=-75 まで延びて、縦帯の左辺（x=-75）と y=-75 で出会う
  const h = flat(out.get('h1'));
  assert.ok(h.some(s => s[0] === -75 && s[1] === -75 && s[2] === 1000 && s[3] === -75), '横帯の上辺が x=-75 から');
  // 内角: 横帯の下辺が x=75 から、縦帯の右辺が y=75 から
  assert.ok(h.some(s => s[0] === 75 && s[1] === 75 && s[2] === 1000 && s[3] === 75), '横帯の下辺は x=75 から');
  const v = flat(out.get('v1'));
  assert.ok(v.some(s => s[0] === 75 && s[1] === 75 && s[2] === 75 && s[3] === 1000), '縦帯の右辺は y=75 から');
});

test('T（端3本）: 幹の小口と側線・交点の中の線が消え、幹の側線は相手の面で止まる', () => {
  const out = unionBandOutline(FIXTURES['T・端3本']);
  // 水平材は 0 を挟んで 1000 のまま。T の外形: 上辺は無傷 1000+(幹なし) ・下辺は幹の左右に分かれる。
  // 周長 = 上辺 1000 + 水平の左右小口 150×2 + 下辺 (500-75)×2 + 幹の側線 (500-75)×2 + 幹の小口 150
  assert.equal(totalLength(out), 1000 + 300 + 850 + 850 + 150);
});

test('T（通し1本の途中に幹の端）: 通しの辺は幹の幅だけ切れる', () => {
  const out = unionBandOutline(FIXTURES['T・通し1本の途中']);
  const h = flat(out.get('h1'));
  const bottom = h.filter(s => s[1] === 75 && s[3] === 75);
  assert.equal(bottom.length, 2, '下辺は幹の左右の 2 本');
  assert.deepEqual(bottom.map(s => [s[0], s[2]]), [[-500, -75], [75, 500]]);
  assert.equal(length(out.get('v1')), 425 * 2 + 150, '幹: 側線 2 本＋小口');
});

test('一直線の突合せ: 境の小口が消え、上下の辺だけが残る（幅違いなら段が残る）', () => {
  const out = unionBandOutline(FIXTURES['一直線の突合せ']);
  assert.equal(totalLength(out), 1000 * 2 + 150 * 2, '周長は 1 本の帯と同じ');
  const step = unionBandOutline([H('h1', 0, -500, 0, 75), H('h2', 0, 0, 500, 100)]);
  // 幅違い: 外形に段が出る＝ 75 の帯の小口が 100 の帯の面から 25 ぶんだけ残る
  assert.equal(totalLength(step), 500 * 2 + 150 + 500 * 2 + 200 + 25 * 2);
});

test('自由端: どの帯にも当たらない端は小口が残る（周長 2300）', () => {
  const out = unionBandOutline(FIXTURES['自由端']);
  assert.equal(totalLength(out), 2300);
  assert.equal(countSegs(out), 4);
});

test('離れた2本は互いに無関係（それぞれの周長 2300）', () => {
  const out = unionBandOutline(FIXTURES['離れた2本']);
  assert.equal(length(out.get('h1')), 2300);
  assert.equal(length(out.get('h2')), 2300);
});

test('同じ線の重複は入力の先の帯だけに残り、2 回描かない', () => {
  const out = unionBandOutline(FIXTURES['同じ線の重複']);
  assert.equal(totalLength(out), 2300, '合わせた 1 本の帯と同じ周長');
  assert.equal(length(out.get('h1')), 600 * 2 + 150, '先の帯: 上下 600＋左の小口');
  assert.equal(length(out.get('h2')), 400 * 2 + 150, '後の帯: 重なりを除く上下 400＋右の小口');
});

test('別の帯に完全に含まれる後の帯は空配列（全帯の id を持つ）', () => {
  const out = unionBandOutline([H('a', 0, 0, 1000), H('b', 0, 100, 200)]);
  assert.equal(out.size, 2);
  assert.equal(out.get('b').length, 0);
  assert.equal(length(out.get('a')), 2300);
});

test('入力を書き換えない・同じ入力は同じ出力（決定的）', () => {
  const bands = FIXTURES['十字・幅違い'];
  const before = JSON.stringify(bands);
  const a = unionBandOutline(bands);
  const b = unionBandOutline(bands);
  assert.equal(JSON.stringify(bands), before);
  assert.equal(JSON.stringify([...a]), JSON.stringify([...b]));
  assert.equal([...a.keys()].join(','), bands.map(x => x.id).join(','), '出力は入力順');
});

test('全周長: 全 fixture で外形の全周長が手計算（PERIMETER）と一致する（足りない線・余分な線を検出）', () => {
  for (const name of Object.keys(FIXTURES)) {
    assert.equal(name in PERIMETER, true, `${name}: PERIMETER が無い`);
    assert.equal(totalLength(unionBandOutline(FIXTURES[name])), PERIMETER[name], name);
  }
});

test('不変条件: 全 fixture で、出力の線分が覆う格子の単位辺は、手書きの被覆（COVER）の和集合の境界の単位辺と一致する（欠けも余りも重複も無い）', () => {
  for (const name of Object.keys(FIXTURES)) {
    assert.equal(name in COVER, true, `${name}: COVER が無い`);
    const expected = expectedBoundaryUnits(COVER[name]);
    const counts = actualUnitCounts(unionBandOutline(FIXTURES[name]));
    const missing = [...expected].filter(k => !counts.has(k));
    const extra = [...counts.keys()].filter(k => !expected.has(k));
    const twice = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    assert.equal(missing.length, 0, `${name}: 欠け ${missing.length} 辺（例 ${missing.slice(0, 3).join(' ')}）`);
    assert.equal(extra.length, 0, `${name}: 余り ${extra.length} 辺（例 ${extra.slice(0, 3).join(' ')}）`);
    assert.equal(twice.length, 0, `${name}: 2 回描く辺 ${twice.length}（例 ${twice.slice(0, 3).join(' ')}）`);
    assert.equal(expected.size > 0, true, `${name}: 期待の被覆が空でない`);
  }
});

test('通しと通しの十字: 帯ごとの長さ（各 2000＝側線 425×4＋小口 150×2）・線分数（各 6）', () => {
  const out = unionBandOutline(FIXTURES['通しと通しの十字']);
  assert.equal(length(out.get('h1')), 425 * 4 + 150 * 2); // 上下の辺は縦帯の幅 150 で 2 本ずつに切れ、先端の小口 2 本
  assert.equal(length(out.get('v1')), 425 * 4 + 150 * 2);
  assert.equal(out.get('h1').length, 6);
  assert.equal(out.get('v1').length, 6);
  assert.equal(totalLength(out), 4000);
});

test('L（角が両方の hi 端）: 外角が閉じる。x=75 の縦線は y=75 まで・y=75 の横線は x=75 まで届く（周長 4300）', () => {
  const out = unionBandOutline(FIXTURES['L・横hi×縦hi']);
  assert.equal(totalLength(out), 4300);
  // 外角（75,75）: 縦帯の右辺 x=75 が y=-1000..75、横帯の下辺 y=75 が x=-1000..75（横帯の右端 x=75 と縦帯の下端 y=75 が出会う延長）
  assert.deepEqual(lineSpan(out, 'v', 75), [-1000, 75, 1075]);
  assert.deepEqual(lineSpan(out, 'h', 75), [-1000, 75, 1075]);
  // 内角は 1 点で出会う: 上辺 y=-75 は x=-75 から（縦帯の左辺 x=-75 は y=-75 まで）
  assert.deepEqual(lineSpan(out, 'h', -75), [-1000, -75, 925]);
  assert.deepEqual(lineSpan(out, 'v', -75), [-1000, -75, 925]);
});

test('L（lo/hi の混在）: 外角の線の座標を固定する', () => {
  // 横 lo×縦 hi: 外角は (-75,75)。x=-75 が y=-1000..75、y=75 が x=-75..1000
  const a = unionBandOutline(FIXTURES['L・横lo×縦hi']);
  assert.equal(totalLength(a), 4300);
  assert.deepEqual(lineSpan(a, 'v', -75), [-1000, 75, 1075]);
  assert.deepEqual(lineSpan(a, 'h', 75), [-75, 1000, 1075]);
  // 横 hi×縦 lo: 外角は (75,-75)。x=75 が y=-75..1000、y=-75 が x=-1000..75
  const b = unionBandOutline(FIXTURES['L・横hi×縦lo']);
  assert.equal(totalLength(b), 4300);
  assert.deepEqual(lineSpan(b, 'v', 75), [-75, 1000, 1075]);
  assert.deepEqual(lineSpan(b, 'h', -75), [-1000, 75, 1075]);
});

test('T・十字の向き違い: 幹の端が lo 側・hi 側のどちらで当たっても、幹の側線は通しの面で止まり、幹の端は延びて外角を閉じる', () => {
  // 幹が上（hi 端で当たる）: 通しの上辺 y=-75 は幹の幅 150 で切れ、幹の側線 x=±75 は y=-500..-75 と交点まで
  const up = unionBandOutline(FIXTURES['T・通し横・幹が上']);
  assert.deepEqual(lineSpan(up, 'v', 75), [-500, -75, 425]);
  assert.deepEqual(lineSpan(up, 'h', -75), [-500, 500, 850]);
  // 幹が左（hi 端で当たる）: 通し（縦）の左辺 x=-75 は幹の幅 150 で切れる
  const left = unionBandOutline(FIXTURES['T・通し縦・幹が左']);
  assert.deepEqual(lineSpan(left, 'h', 75), [-500, -75, 425]);
  assert.deepEqual(lineSpan(left, 'v', -75), [-500, 500, 850]);
  // 十字（通し横＋縦の端 2 本）: 通し横の上下の辺は縦の端（lo・hi 両側）の幅で 2 本ずつに切れる
  const plus = unionBandOutline(FIXTURES['十字・通し横＋縦の端2本']);
  assert.deepEqual(lineSpan(plus, 'h', -75), [-500, 500, 850]);
  assert.deepEqual(lineSpan(plus, 'h', 75), [-500, 500, 850]);
  assert.deepEqual(lineSpan(plus, 'v', 75), [-500, 500, 850]);
});

test('失敗系: bands が配列でない／座標・half が有限でない／lo>=hi／half<=0／id の重複は throw', () => {
  assert.throws(() => unionBandOutline(null), /bands は配列/);
  assert.throws(() => unionBandOutline({}), /bands は配列/);
  assert.throws(() => unionBandOutline([H('a', NaN, 0, 10)]), /有限/);
  assert.throws(() => unionBandOutline([H('a', 0, 0, Infinity)]), /有限/);
  assert.throws(() => unionBandOutline([H('a', 0, 0, 10, NaN)]), /有限/);
  assert.throws(() => unionBandOutline([{ id: 'a', isVertical: false, axisValue: 0, lo: 0, hi: 10 }]), /有限/);
  assert.throws(() => unionBandOutline([H('a', 0, 10, 10)]), /lo < hi/);
  assert.throws(() => unionBandOutline([H('a', 0, 20, 10)]), /lo < hi/);
  assert.throws(() => unionBandOutline([H('a', 0, 0, 10, 0)]), /half > 0/);
  assert.throws(() => unionBandOutline([H('a', 0, 0, 10, -5)]), /half > 0/);
  assert.throws(() => unionBandOutline([H('a', 0, 0, 10), V('a', 5, 0, 10)]), /重複/);
});

test('空配列は空 Map', () => {
  assert.equal(unionBandOutline([]).size, 0);
});

// ---------------------------------------------------------------
// segmentsMinusGaps（区間から切れ目を引く。壁の開口・土台の交点で共用）
// ---------------------------------------------------------------
const J = (v) => JSON.stringify(v);

test('segmentsMinusGaps: gap が空→[[lo,hi]]・lo==hi→[]・lo>hi→[]', () => {
  assert.equal(J(segmentsMinusGaps(0, 1000, [])), J([[0, 1000]]));
  assert.equal(J(segmentsMinusGaps(500, 500, [])), J([]));
  assert.equal(J(segmentsMinusGaps(500, 500, [[400, 600]])), J([]));
  assert.equal(J(segmentsMinusGaps(500, 500, [[800, 900]])), J([]), 'lo==hi の外に gap があっても長さ 0 の区間を返さない');
  assert.equal(J(segmentsMinusGaps(1000, 0, [[100, 200]])), J([]));
});

test('segmentsMinusGaps: 区間内の gap・端に接する gap・全体を覆う gap', () => {
  assert.equal(J(segmentsMinusGaps(0, 1000, [[200, 300]])), J([[0, 200], [300, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[0, 100]])), J([[100, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[900, 1000]])), J([[0, 900]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[0, 1000]])), J([]));
});

test('segmentsMinusGaps: 未ソートの gap・複数の gap・重なる gap・内包する gap・隣接する gap', () => {
  assert.equal(J(segmentsMinusGaps(0, 1000, [[400, 600], [100, 200]])), J([[0, 100], [200, 400], [600, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[100, 300], [200, 500]])), J([[0, 100], [500, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[100, 500], [200, 300]])), J([[0, 100], [500, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[100, 200], [200, 300]])), J([[0, 100], [300, 1000]]));
});

test('segmentsMinusGaps: lo の外へはみ出す gap・hi を越える gap（区間の中だけが切れる）', () => {
  assert.equal(J(segmentsMinusGaps(0, 1000, [[-100, 200]])), J([[200, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[800, 1500]])), J([[0, 800]]));
});

test('segmentsMinusGaps: hi の外にある gap は区間の終端 hi で止める（クランプ。HEAD は壁端を越えて返した）', () => {
  assert.equal(J(segmentsMinusGaps(0, 1000, [[1200, 1400]])), J([[0, 1000]]));
  assert.equal(J(segmentsMinusGaps(0, 1000, [[100, 200], [1200, 1400]])), J([[0, 100], [200, 1000]]));
  // 区間の終端まで gap で埋まった後ろに、外の gap があっても長さ 0 の区間を足さない
  assert.equal(J(segmentsMinusGaps(0, 1000, [[0, 1000], [1200, 1400]])), J([]));
});

// HEAD の耐力壁 wallSegments の区間計算（gaps はクランプ済み・ソート済みで渡る）の写し。HEAD との差が出る入力を調べるためだけに置く。
function headSegmentsMinusGaps(lo, hi, gaps) {
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const segments = [];
  let cur = lo;
  for (const [gapLo, gapHi] of sorted) {
    if (gapLo > cur) segments.push([cur, gapLo]);
    cur = Math.max(cur, gapHi);
  }
  if (hi > cur) segments.push([cur, hi]);
  return segments;
}

test('segmentsMinusGaps と HEAD の写し: 差が出るのは「gap の始点が hi より先にある」ときだけ（全 gap の始点 <= hi なら 1 つ・2 つの全組合せで一致）', () => {
  const vals = [-100, 0, 100, 500, 1000, 1100];
  const pairs = vals.flatMap(a => vals.map(b => [a, b])); // 逆順（gapHi<gapLo）も含む
  const lists = [[], ...pairs.map(p => [p]), ...pairs.flatMap(p => pairs.map(q => [p, q]))];
  let same = 0, differ = 0;
  for (const gaps of lists) {
    const a = J(segmentsMinusGaps(0, 1000, gaps));
    const b = J(headSegmentsMinusGaps(0, 1000, gaps));
    if (gaps.every(g => g[0] <= 1000)) {
      assert.equal(a, b, `gaps=${J(gaps)}`);
      same++;
    } else {
      differ++;
    }
  }
  assert.equal(same > 500 && differ > 100, true, `網羅の確認（一致 ${same}・始点が hi より先 ${differ}）`);
  // 差が出る形（名前つき）: 壁 0..1000・開口 1200..1400（壁の外）
  assert.equal(J(headSegmentsMinusGaps(0, 1000, [[1200, 1400]])), J([[0, 1200]]), 'HEAD は壁端を越えて 1200 まで返した');
  assert.equal(J(segmentsMinusGaps(0, 1000, [[1200, 1400]])), J([[0, 1000]]), '今回は壁端 1000 で止まる');
});

test('【失敗系】segmentsMinusGaps: gaps が配列でない／lo・hi が有限でないは throw（呼び出し元の gaps ?? [] の形では throw しない）', () => {
  assert.throws(() => segmentsMinusGaps(0, 1000, null), /gaps は配列/);
  assert.throws(() => segmentsMinusGaps(0, 1000, undefined), /gaps は配列/);
  assert.throws(() => segmentsMinusGaps(0, 1000, 'x'), /gaps は配列/);
  assert.throws(() => segmentsMinusGaps(NaN, 1000, []), /有限/);
  assert.throws(() => segmentsMinusGaps(0, Infinity, []), /有限/);
  assert.throws(() => segmentsMinusGaps(undefined, 1000, []), /有限/);
  const gaps = undefined;
  assert.equal(J(segmentsMinusGaps(0, 1000, gaps ?? [])), J([[0, 1000]]));
});

test('segmentsMinusGaps: gaps を書き換えない', () => {
  const gaps = [[400, 600], [100, 200]];
  const before = J(gaps);
  segmentsMinusGaps(0, 1000, gaps);
  assert.equal(J(gaps), before);
});

// ---------------------------------------------------------------
// foundationBandInputs（基礎梁の帯の入力）
// ---------------------------------------------------------------
test('foundationBandInputs: coord1>coord2 でも lo<hi・half＝幅/2・id/isVertical/axisValue を写す', () => {
  const spans = [
    { beam: { id: 'a', isVertical: false, axisValue: 100 }, coord1: 800, coord2: 200 },
    { beam: { id: 'b', isVertical: true, axisValue: -50 }, coord1: -300, coord2: 400 },
  ];
  const widths = { a: 150, b: 200 };
  const out = foundationBandInputs(spans, b => widths[b.id]);
  assert.equal(out.length, 2);
  assert.equal(J(out[0]), J({ id: 'a', isVertical: false, axisValue: 100, lo: 200, hi: 800, half: 75 }));
  assert.equal(J(out[1]), J({ id: 'b', isVertical: true, axisValue: -50, lo: -300, hi: 400, half: 100 }));
  // unionBandOutline がそのまま受け取れる（検証を通る）
  assert.equal(unionBandOutline(out).size, 2);
});

test('foundationBandInputs: 幅が null の梁（単線LOD）は除く・順序は入力順・入力を書き換えない', () => {
  const spans = [
    { beam: { id: 'a', isVertical: false, axisValue: 0 }, coord1: 0, coord2: 100 },
    { beam: { id: 'b', isVertical: false, axisValue: 10 }, coord1: 0, coord2: 100 },
    { beam: { id: 'c', isVertical: true, axisValue: 20 }, coord1: 0, coord2: 100 },
  ];
  const before = J(spans);
  const out = foundationBandInputs(spans, b => (b.id === 'b' ? null : 30));
  assert.equal(out.map(x => x.id).join(','), 'a,c');
  assert.equal(out.every(x => x.half === 15), true);
  assert.equal(J(spans), before);
  assert.equal(foundationBandInputs(spans, () => null).length, 0);
  assert.equal(foundationBandInputs([], () => 30).length, 0);
});

test('【失敗系】foundationBandInputs: spans が配列でない／widthOf が関数でないは throw', () => {
  assert.throws(() => foundationBandInputs(null, () => 30), /spans は配列/);
  assert.throws(() => foundationBandInputs({}, () => 30), /spans は配列/);
  assert.throws(() => foundationBandInputs([], null), /widthOf は関数/);
  assert.throws(() => foundationBandInputs([], 30), /widthOf は関数/);
});
