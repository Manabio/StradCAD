// finish/roof/roofPlanWallTrim.js の単体テスト。faceAt は偽の関数（壁の面を決め打ち）。
// 期待値は roof-test1（L字の片流れの下屋。壁の外壁面＝通り芯＋72.5）の形を手計算で写したもの（y は下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimRoofPlanLinesAtWalls } from './roofPlanWallTrim.js';

const TOL = 0.5;
const REACH = 455.5;
const D = 72.5; // 壁の屋根側の外端（通り芯からの距離）

const line = (role, points, closed = false) => ({ kind: 'line', key: `k:${role}`, role, points, closed, detailOnly: false });

/** 呼び出しを記録する faceAt。table は (q) => 面 | null。 */
function recorder(table) {
  const calls = [];
  const faceAt = q => { calls.push(q); return table(q); };
  return { faceAt, calls };
}
const run = (primitives, faceAt, zeroZones = []) => trimRoofPlanLinesAtWalls(primitives, { faceAt, zeroZones, reachMm: REACH, tolMm: TOL });

// 壁: x=7280（縦・屋根は +x 側）と y=-3640（横・屋根は +y 側）。それ以外は壁なし
const wallTable = q => {
  if (q.isVertical && q.coord === 7280 && q.outward === 1) return 7280 + D;
  if (!q.isVertical && q.coord === -3640 && q.outward === 1) return -3640 + D;
  return null;
};
const ZONES = [
  { isVertical: false, coord: -3640, lo: 3640, hi: 7280, outward: -1 },
  { isVertical: true, coord: 7280, lo: -9884, hi: -3640, outward: -1 },
];

test('外形線の端（区間の範囲外）: 開いた折れ線の先頭が壁の直線 x=7280 に突き当たる端は、線に沿って面まで戻す', () => {
  const { faceAt, calls } = recorder(wallTable);
  const outline = line('outline', [7280, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -3640]);
  const [out] = run([outline], faceAt);
  assert.deepEqual(out.points, [7280 + D, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -3640 + D]);
  assert.deepEqual(calls[0], { isVertical: true, coord: 7280, at: -10339, reachMm: REACH, outward: 1 }, '先頭: 縦の壁の直線・端の y・線の本体の側（+x）');
  assert.deepEqual(calls[1], { isVertical: false, coord: -3640, at: 3185, reachMm: REACH, outward: 1 }, '末尾: 横の壁の直線・端の x・線の本体の側（+y）');
  assert.equal(out.key, outline.key);
  assert.deepEqual(outline.points, [7280, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -3640], '入力は変えない');
});

test('外形線の端（段差の小辺）: 最後の線分が短い小辺でも、その線分に直交する直線の壁の面まで戻す', () => {
  const { faceAt } = recorder(wallTable);
  // 軒先の線 y=455 から段差の小辺（x=3185・長さ 455）で壁 y=-3640 の手前まで来る形
  const [out] = run([line('outline', [9555, 455, 3185, 455, 3185, -3640])], faceAt);
  assert.deepEqual(out.points, [9555, 455, 3185, 455, 3185, -3640 + D]);
});

test('外形線の端: 戻す向きは縮める向きだけ。面が端より外側（延ばす向き）・線分を潰す面・null は変えない', () => {
  const pts = [7280, -10339, 9555, -10339];
  const same = line('outline', pts);
  const behind = run([same], () => 7200)[0]; // 面が端より外（本体と反対側）
  assert.equal(behind, same);
  assert.equal(run([same], () => 9600)[0], same, '面が線分の反対の端より先（潰す）');
  assert.equal(run([same], () => null)[0], same, 'faceAt が null');
  assert.equal(run([same], () => 7280.2)[0], same, '動く量が tol 以下');
  const slanted = line('outline', [0, 0, 1000, 900]); // 斜めの最後の線分は壁の直線を決められない
  assert.equal(run([slanted], () => 50)[0], slanted);
});

test('閉じた外形線は変えない（faceAt が答えても）', () => {
  const closed = line('outline', [7280, -10339, 9555, -10339, 9555, 455, 7280, 455], true);
  const { faceAt, calls } = recorder(() => 7352.5);
  assert.equal(run([closed], faceAt)[0], closed);
  assert.equal(calls.length, 0, '閉じた外形線では faceAt を呼ばない');
});

test('区間の上の隅木（45°）: 端が屋内に接する区間の直線上なら、壁の面まで線に沿って戻す', () => {
  const { faceAt, calls } = recorder(wallTable);
  const [out] = run([line('hip', [9555, 455, 5460, -3640])], faceAt, ZONES);
  assert.deepEqual(out.points, [9555, 455, 5460 + D, -3640 + D]);
  assert.deepEqual(calls, [{ isVertical: false, coord: -3640, at: 5460, reachMm: REACH, outward: 1 }]);
});

test('谷木・棟木も同じ（区間の上の端だけ戻る）。区間の範囲外・壁に当たらない端は変えない', () => {
  const { faceAt } = recorder(wallTable);
  const valley = line('valley', [7280, -3640, 8190, -2730]); // 出隅（x=7280 の区間と y=-3640 の区間の両方の上）
  const ridge = line('ridge', [3185, -1820, 7000, -1820]); // 区間の上に端が無い
  const [v, r] = run([valley, ridge], faceAt, ZONES);
  assert.notEqual(v, valley);
  assert.equal(r, ridge, '壁に当たらない線は同じオブジェクト');
  assert.deepEqual(r.points, [3185, -1820, 7000, -1820]);
  // 区間 y=-3640（3640..7280）の外（x=7300）にある端は対象外
  const out = line('hip', [7300, -3640, 8000, -2940]);
  assert.equal(run([out], faceAt, ZONES)[0], out);
});

test('建物の出隅（端が2つの区間の直線上）: 戻る量の大きい方を採る', () => {
  const zones = [
    { isVertical: true, coord: 0, lo: 0, hi: 1000, outward: -1 }, // 屋根は +x 側
    { isVertical: false, coord: 0, lo: 0, hi: 1000, outward: -1 }, // 屋根は +y 側
  ];
  const faces = { true: 30, false: 80 };
  const [out] = run([line('hip', [0, 0, 1000, 1000])], q => faces[q.isVertical], zones);
  assert.deepEqual(out.points, [80, 80, 1000, 1000], '縦の壁は 30・横の壁は 80 → 大きい 80');
  const [swapped] = run([line('hip', [0, 0, 1000, 1000])], q => ({ true: 120, false: 40 })[q.isVertical], zones);
  assert.deepEqual(swapped.points, [120, 120, 1000, 1000]);
});

test('壁の帯の中に収まる線は捨てる（戻すと長さが tol 以下になる）。他の線は残る', () => {
  const zones = [{ isVertical: false, coord: 0, lo: 0, hi: 1000, outward: -1 }];
  const tiny = line('hip', [0, 0, 50, 50]); // 面 y=80 まで戻すと線の外へ出る
  const keep = line('ridge', [200, 500, 800, 500]);
  const out = run([tiny, keep], () => 80, zones);
  assert.deepEqual(out, [keep]);
  // ちょうど tol 以下の長さで残る場合も捨てる
  const nearly = line('hip', [0, 0, 100, 100]); // 長さ 141.4。y=100-0.2 まで戻す → 残り約 0.28
  assert.deepEqual(run([nearly], () => 99.8, zones), []);
  const survives = line('hip', [0, 0, 100, 100]);
  assert.equal(run([survives], () => 50, zones)[0].points[1], 50);
});

test('壁に平行な線・屋内側へ向かう線・faceAt が null の線は変えない', () => {
  const zones = [{ isVertical: false, coord: 0, lo: 0, hi: 1000, outward: -1 }];
  const parallel = line('ridge', [0, 0, 1000, 0]); // 区間の直線に沿う棟木
  const inward = line('hip', [500, 0, 900, -400]); // 屋内（-y）へ向かう
  const none = line('hip', [0, 0, 400, 400]);
  assert.equal(run([parallel], () => 60, zones)[0], parallel);
  assert.equal(run([inward], () => 60, zones)[0], inward);
  assert.equal(run([none], () => null, zones)[0], none);
  assert.deepEqual(run([], () => 60, zones), [], '空の入力は空');
});

test('文字・矢印（傾斜ラベル）は素通し: faceAt が面を答えても座標を変えず、同じオブジェクトのまま。線は従来どおり止まる', () => {
  const arrow = { kind: 'arrow', key: 'a', points: [7280, -3640, 8180, -3640], head: [0, 0, 1, 1, 2, 2], detailOnly: true };
  const text = { kind: 'text', key: 't', x: 7280, y: -3640, text: '屋根', fontSizeMm: 200, detailOnly: true };
  const hip = line('hip', [9555, 455, 5460, -3640]);
  const { faceAt } = recorder(() => 100);
  const out = run([arrow, text, hip], wallTable, ZONES);
  assert.equal(out[0], arrow);
  assert.equal(out[1], text);
  assert.deepEqual(out[2].points, [9555, 455, 5460 + D, -3640 + D], '線は止まる');
  const calls = [];
  run([arrow, text], q => { calls.push(q); return 100; }, ZONES);
  assert.equal(calls.length, 0, 'ラベルでは faceAt を呼ばない');
  assert.equal(faceAt({}), 100);
});

test('壁が無い階（faceAt が常に null）は全ての線が変わらない', () => {
  const prims = [
    line('outline', [7280, -10339, 9555, -10339, 9555, 455, 3185, 455, 3185, -3640]),
    line('hip', [9555, 455, 5460, -3640]),
    line('ridge', [3185, -1820, 7000, -1820]),
  ];
  const out = run(prims, () => null, ZONES);
  assert.equal(out.length, prims.length);
  out.forEach((p, i) => assert.equal(p, prims[i]));
});
