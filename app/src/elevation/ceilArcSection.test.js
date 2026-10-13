// ceilArcSection.js（円弧・ドームの天井断面: 3 点円・円弧プリミティブ・エンジンへ渡す弦の列）の単体テスト。期待値はリテラル（手計算）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceilArcCircleOf, ceilArcZAt, ceilArcPrimitive, ceilArcChords, sliceCeilSeg } from './ceilArcSection.js';

const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg} 実際:${a} 期待:${b}`);
// 幅 4000・両端 2400・頭頂 2800（床 0）→ R=(2000²+400²)/(2×400)=5200・中心 (2000, −2400)
const SEG = { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 2000, chMm: 2800 } };

test('【3 点円】幅 4000・ライズ 400 は R=5200・中心 (2000, −2400)・端と頭頂は元の値', () => {
  const c = ceilArcCircleOf(SEG);
  near(c.r, 5200, 'r'); near(c.cx, 2000, 'cx'); near(c.cz, -2400, 'cz');
  assert.equal(ceilArcZAt(c, 0), 2400); assert.equal(ceilArcZAt(c, 4000), 2400);
  near(ceilArcZAt(c, 2000), 2800, '頭頂');
  near(ceilArcZAt(c, 1000), -2400 + Math.sqrt(5200 ** 2 - 1000 ** 2), '途中は円の式');
  assert.equal(ceilArcZAt(c, -50), 2400, '区間の外は端の値で水平');
  assert.equal(ceilArcZAt(c, 4100), 2400);
});

test('【床段差込み・非対称】floorDeltaMm は絶対高さに足す／両端が違う片でも 3 点を通る', () => {
  const c = ceilArcCircleOf({ loX: 0, hiX: 4000, floorDeltaMm: 100, chMm: 2400, chHiMm: 2500, ceilArc: { alongX: 1500, chMm: 2900 } });
  near(ceilArcZAt(c, 1500), 3000, '頭頂 100+2900');
  assert.equal(ceilArcZAt(c, 0), 2500); assert.equal(ceilArcZAt(c, 4000), 2600);
  near(Math.hypot(0 - c.cx, 2500 - c.cz), c.r, '始点は円周上');
  near(Math.hypot(4000 - c.cx, 2600 - c.cz), c.r, '終点は円周上');
});

test('【円が作れない（失敗系）】ceilArc なし・頭頂が端寄り/外・弦と同じ高さ・非有限・下側の弧は null', () => {
  assert.equal(ceilArcCircleOf({ ...SEG, ceilArc: undefined }), null);
  assert.equal(ceilArcCircleOf(null), null);
  for (const alongX of [0.2, 3999.8, -10, 4500, NaN]) assert.equal(ceilArcCircleOf({ ...SEG, ceilArc: { alongX, chMm: 2800 } }), null, `alongX=${alongX}`);
  assert.equal(ceilArcCircleOf({ ...SEG, ceilArc: { alongX: 2000, chMm: 2400.3 } }), null, '弦との差 0.5mm 未満は直線');
  assert.equal(ceilArcCircleOf({ ...SEG, ceilArc: { alongX: 2000, chMm: 2000 } }), null, '頭頂が弦より下（上側の弧でない）');
  assert.equal(ceilArcCircleOf({ ...SEG, chMm: NaN }), null);
});

test('【円弧プリミティブ】図の座標（y 下向き）: 中心 (2000, +2400)・始点 −112.62°・掃引 +45.24°・style を載せる', () => {
  const c = ceilArcCircleOf(SEG);
  const p = ceilArcPrimitive(c, 0, 4000, { weight: 'thick' });
  assert.equal(p.type, 'arc'); assert.equal(p.weight, 'thick');
  near(p.cx, 2000, 'cx'); near(p.cy, 2400, 'cy'); near(p.r, 5200, 'r');
  near(p.startDeg, -(180 - (Math.atan(4800 / 2000) * 180) / Math.PI), 'startDeg');
  near(p.sweepDeg, 2 * (90 - (Math.atan(4800 / 2000) * 180) / Math.PI), 'sweepDeg');
  // 一部の範囲: 中心から右の半分は −90°（頭頂）から始まる
  const half = ceilArcPrimitive(c, 2000, 4000, {});
  near(half.startDeg, -90, '頭頂の角度'); near(half.sweepDeg, (Math.atan(2000 / 4800) * 180) / Math.PI, '右半分の掃引');
  assert.equal(ceilArcPrimitive(c, 3000, 3000, {}), null, '幅 0 は null');
  assert.equal(ceilArcPrimitive(c, 3000, 2000, {}), null, '逆順は null');
});

test('【半円（ライズ＝幅/2）】端の高さが中心と同じでも角度が −180/0 に正しく出る（atan2 の ±π を避ける）', () => {
  const c = ceilArcCircleOf({ loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 1000, chMm: 3400 } });
  near(c.r, 1000, 'r'); near(c.cz, 2400, 'cz');
  const p = ceilArcPrimitive(c, 0, 2000, {});
  near(p.startDeg, -180, '始点'); near(p.sweepDeg, 180, '掃引');
});

test('【弦の列】鉛直差 1mm 以下・端は元の値・頭頂が節・連続・最低 4 本最大 64 本', () => {
  const c = ceilArcCircleOf(SEG);
  const chords = ceilArcChords(c);
  assert.ok(chords.length >= 4 && chords.length <= 64, `本数 ${chords.length}`);
  assert.equal(chords[0].loX, 0); assert.equal(chords[0].ceilZ, 2400);
  assert.equal(chords.at(-1).hiX, 4000); assert.equal(chords.at(-1).ceilZHi, 2400);
  assert.ok(chords.some(s => s.hiX === 2000 && s.ceilZHi === 2800), '頭頂が節（z は元の値）');
  for (let i = 0; i + 1 < chords.length; i++) {
    near(chords[i].hiX, chords[i + 1].loX, '連続 x'); near(chords[i].ceilZHi, chords[i + 1].ceilZ, '連続 z');
  }
  // 鉛直差（同じ x での円弧と弦の高さの差）が 1mm 以下
  const worst = maxVerticalDeviation(c, chords);
  assert.ok(worst <= 1 + 1e-6 && worst >= 0, `最大の鉛直差 ${worst}`);
});

// 全弦・全標本点での「円弧 − 弦」の高さ（負なら弦が円弧を突き抜ける）の最大。負の側は別に検査する。
function maxVerticalDeviation(c, chords) {
  let worst = 0;
  for (const s of chords) {
    for (let k = 0; k <= 40; k++) {
      const x = s.loX + ((s.hiX - s.loX) * k) / 40;
      const chordZ = s.ceilZ + ((s.ceilZHi - s.ceilZ) * (x - s.loX)) / (s.hiX - s.loX);
      const d = ceilArcZAt(c, x) - chordZ;
      assert.ok(d >= -1e-6, `弦が円弧を突き抜ける x=${x} 差=${d}`); // 壁の帯の天端が円弧を超えない
      worst = Math.max(worst, d);
    }
  }
  return worst;
}

test('【弦は端付近ほど細かい】幅 2000・ライズ 600（急な円弧）: 鉛直差 1mm 以下で、端の弦は頭頂の弦より短い', () => {
  const c = ceilArcCircleOf({ loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 1000, chMm: 3000 } });
  const chords = ceilArcChords(c);
  assert.ok(maxVerticalDeviation(c, chords) <= 1 + 1e-6);
  const first = chords[0], apexRight = chords.find(s => s.loX === 1000);
  assert.ok(first.hiX - first.loX < apexRight.hiX - apexRight.loX, `端 ${first.hiX - first.loX} < 頭頂寄り ${apexRight.hiX - apexRight.loX}`);
});

test('【弦の本数の下限・上限】浅い円弧でも 4 本以上・巨大な円弧でも 64 本以下', () => {
  const shallow = ceilArcChords(ceilArcCircleOf({ loX: 0, hiX: 400, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 200, chMm: 2401 } }));
  assert.equal(shallow.length, 4);
  const big = ceilArcChords(ceilArcCircleOf({ loX: 0, hiX: 40000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 20000, chMm: 22400 } }));
  assert.equal(big.length, 64);
});

// ---- sliceCeilSeg: 下階が一部だけ覆う面で区間を割った小片（elevationVoid.js）の両端の高さを元の形から取り直す ----
test('【下階が一部だけ覆う円弧の片】小片の両端は元の円の上・頭頂が小片の外なら ceilArc を外す', () => {
  const z = x => -2400 + Math.sqrt(5200 ** 2 - (x - 2000) ** 2);
  const left = sliceCeilSeg(SEG, 0, 1000);
  near(left.chMm, 2400, '左端'); near(left.chHiMm, z(1000), '右端は元の円の高さ 2702.94');
  assert.equal('ceilArc' in left, false, '頭頂は小片の外');
  const mid = sliceCeilSeg(SEG, 1000, 3000);
  near(mid.chMm, z(1000), '左端'); near(mid.chHiMm, z(3000), '右端');
  assert.deepEqual(mid.ceilArc, SEG.ceilArc, '頭頂が内側なら保つ');
  const right = sliceCeilSeg(SEG, 3000, 4000);
  near(right.chMm, z(3000), '左端'); near(right.chHiMm, 2400, '右端');
  assert.equal(sliceCeilSeg(SEG, 0, 4000).chHiMm, 2400, '区間全体はそのまま');
  const withFloor = sliceCeilSeg({ ...SEG, floorDeltaMm: 100, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 2000, chMm: 2800 } }, 0, 1000);
  near(withFloor.chHiMm, z(1000), '床段差込みでも床基準の高さ（絶対高さ−床段差）');
});

test('【傾斜・平面の小片】傾斜は直線補間・平面は元のまま（失敗系: 幅 0 の元区間も例外にしない）', () => {
  const slope = { loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 3000 };
  const s = sliceCeilSeg(slope, 1000, 3000);
  near(s.chMm, 2550, 'lo'); near(s.chHiMm, 2850, 'hi');
  assert.deepEqual(sliceCeilSeg({ loX: 0, hiX: 4000, chMm: 2400 }, 1000, 3000), { chMm: 2400 });
  assert.deepEqual(sliceCeilSeg({ loX: 0, hiX: 0, chMm: 2400, chHiMm: 2500 }, 0, 0), { chMm: 2400 });
});
