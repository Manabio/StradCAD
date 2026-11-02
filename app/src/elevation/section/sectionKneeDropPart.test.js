// 断面エンジンの腰壁の天端・垂れ壁の下端の部分詳細図（emitCtx.kneeDropPartStepsOf。部分詳細図 S8b-1）: sectionEmit.js emitColumns の
// 「手書きの小さな SectionColumn リテラル→期待するプリミティブ」。エンジンは detail/ を引かず、段差の t を受けるだけ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitColumns } from './sectionEmit.js';
import { DETAIL_PRIM_SOURCE } from '../../core/constants.js';

const cut = { seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 1000 }, viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0 };
const kneeCol = (extra = {}) => ({ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
  { kind: 'wall', z0: 0, z1: 800, distMm: 1000, layerRole: 'self', isKneeDrop: true, ...extra },
] });
const dropCol = (extra = {}) => ({ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
  { kind: 'wall', z0: 2000, z1: 2400, distMm: 1000, layerRole: 'self', isKneeDrop: true, ...extra },
] });
const detailLines = prims => prims.filter(p => p.source === DETAIL_PRIM_SOURCE);
const hLinesAt = (prims, y) => prims.filter(p => p.type === 'line' && p.y1 === y && p.y2 === y);

test('腰壁の帯: 天端から t 下に auto＝細線・air＝中線（source=detail・帯の列の幅）。kneeTop が解決していれば従来の天端の下の細線は引かない（S8c）', () => {
  const calls = [];
  const steps = { kneeTop: [{ t: 20, weight: 'auto' }, { t: 40, weight: 'air' }] };
  const prims = emitColumns([kneeCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: (band, col, c) => { calls.push([band.z1, col.x0, c.seqNo]); return steps; } });
  const d = detailLines(prims);
  assert.equal(d.length, 2);
  const at780 = hLinesAt(d, -780);
  const at760 = hLinesAt(d, -760);
  assert.deepEqual([at780.length, at780[0].weight, at780[0].x1, at780[0].x2], [1, 'thin', 0, 1000]);
  assert.deepEqual([at760.length, at760[0].weight], [1, 'medium']);
  assert.equal(hLinesAt(prims.filter(p => p.source === undefined), -750).length, 0, '図が解決したので kneeCapUnderline（天端の 50 下の細線）は引かない');
  // フォールバック: kneeTop が解決しない（null・段差の無い slot）ときは従来の細線が出る
  for (const none of [() => null, () => ({ dropBottom: [{ t: 20, weight: 'auto' }] })]) {
    const fb = emitColumns([kneeCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: none });
    assert.equal(hLinesAt(fb.filter(p => p.source === undefined), -750).length, 1, '従来の kneeCapUnderline へ戻る');
    assert.equal(detailLines(fb).length, 0);
  }
  // 解決したが段差が 0 本（空配列）＝図が担う: 従来の細線へ戻らない
  const empty = emitColumns([kneeCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => ({ kneeTop: [] }) });
  assert.equal(hLinesAt(empty, -750).length, 0);
  assert.ok(calls.length >= 1 && calls.every(c => c[0] === 800 && c[2] === '1'), '帯・列・切断を渡して呼ぶ');
});

test('腰壁の端面（端部抑え）: 内側の縦細線は壁端から kneeCapDrawnFaceMm だけ内側（分母 20＝20・未指定＝50）', () => {
  const cols = () => [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] },
    { x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000, bands: [{ kind: 'wall', z0: 0, z1: 900, distMm: 500, layerRole: 'self', isKneeDrop: true }] },
    { x0: 3000, x1: 4000, worldLo: 3000, worldHi: 4000, bands: [] },
  ];
  const c3 = { ...cut, line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 } };
  const xs = emitCtx => [...new Set(emitColumns(cols(), c3, { ceilZ: 2400, ...emitCtx })
    .filter(p => p.type === 'line' && p.x1 === p.x2 && p.y1 === 0 && p.y2 === -900 && p.weight === 'thin').map(p => p.x1))].sort((a, b) => a - b);
  assert.deepEqual(xs({ scaleDenom: 20 }), [1020, 2980]);
  assert.deepEqual(xs({}), [1050, 2950]);
});

test('垂れ壁の帯: 下端から −t 上（z＝z0−t）に線。腰壁の天端用の段差は垂れ壁の帯に引かない・垂れ壁用は腰壁の帯に引かない', () => {
  const steps = { dropBottom: [{ t: -20, weight: 'auto' }], kneeTop: [{ t: 20, weight: 'auto' }] };
  const prims = emitColumns([dropCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => steps });
  const d = detailLines(prims);
  assert.deepEqual(d.map(p => [p.y1, p.weight]), [[-2020, 'thin']], '垂れ壁の帯は dropBottom だけ（kneeTop の t=20 は引かない）');
  const knee = detailLines(emitColumns([kneeCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => steps }));
  assert.deepEqual(knee.map(p => p.y1), [-780], '腰壁の帯は kneeTop だけ');
});

test('帯の中に収まらない高さ（帯の下端より下・上端より上）は引かない。isKneeDrop でない帯はコールバックを呼ばず何も引かない', () => {
  const tooDeep = emitColumns([kneeCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => ({ kneeTop: [{ t: 900, weight: 'auto' }, { t: -5, weight: 'auto' }, { t: 0, weight: 'auto' }] }) });
  assert.deepEqual(detailLines(tooDeep), [], '天端（t=0）・天端より上・床より下は引かない');
  let called = 0;
  const plain = emitColumns([kneeCol({ isKneeDrop: false })], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => { called += 1; return { kneeTop: [{ t: 20, weight: 'auto' }] }; } });
  assert.deepEqual(detailLines(plain), []);
  assert.equal(called, 0, 'isKneeDrop でない帯ではコールバックを呼ばない');
  const profiled = emitColumns([kneeCol({ profiledTop: true })], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => ({ kneeTop: [{ t: 20, weight: 'auto' }] }) });
  assert.deepEqual(detailLines(profiled), [], '天端プロファイルの壁には笠木が無い');
});

test('割当て無し（コールバック無し・null を返す）の出力は従来と一致する（バイト一致）', () => {
  const base = JSON.stringify(emitColumns([kneeCol(), dropCol()].map(c => ({ ...c })), cut, { ceilZ: 2400 }));
  assert.equal(JSON.stringify(emitColumns([kneeCol(), dropCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => null })), base);
  assert.equal(JSON.stringify(emitColumns([kneeCol(), dropCol()], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => ({}) })), base);
});

test('遮蔽: 手前の切断壁の天端がその高さ以上なら線を引かない。向こう側（床より下の帯）へは破線に降格する', () => {
  // 隣の列の切断壁(cut)が高さ 790 まで立つ列: 同じ列に cut 帯 z0..790 と見えがかり腰壁 790..800 は想定しにくいので、列の中に cut 帯を置く
  const hidden = { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
    { kind: 'cut', z0: 0, z1: 790, layerRole: 'self' },
    { kind: 'wall', z0: 790, z1: 800, distMm: 1000, layerRole: 'self', isKneeDrop: true },
  ] };
  const steps = () => ({ kneeTop: [{ t: 5, weight: 'auto' }] }); // z=795: 帯の中。ただし天端 800 の線自体が手前の cut に遮られているわけではない
  const prims = emitColumns([hidden], cut, { ceilZ: 2400, kneeDropPartStepsOf: steps });
  assert.ok(detailLines(prims).every(p => p.y1 === -795), 'z=795 は cut 帯の天端 790 より上＝遮蔽されない');
  const covered = { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
    { kind: 'cut', z0: 0, z1: 797, layerRole: 'self' },
    { kind: 'wall', z0: 790, z1: 800, distMm: 1000, layerRole: 'self', isKneeDrop: true },
  ] };
  assert.deepEqual(detailLines(emitColumns([covered], cut, { ceilZ: 2400, kneeDropPartStepsOf: steps })), [], 'z=795 が cut の天端 797 以下＝遮蔽されて引かない');
  // 帯全体が床より下（baseFloorZ 以下）なら破線に降格（帯の既存判定＝forceDash）
  const below = { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
    { kind: 'wall', z0: -900, z1: -100, distMm: 1000, layerRole: 'self', isKneeDrop: true },
  ] };
  const dashed = detailLines(emitColumns([below], cut, { ceilZ: 2400, kneeDropPartStepsOf: () => ({ kneeTop: [{ t: 20, weight: 'air' }] }) }));
  assert.equal(dashed.length, 1);
  assert.equal(dashed[0].dash, 'dashed');
  assert.equal(dashed[0].weight, 'thin', '降格すると細線');
});

test('cutAlong の帯: 腰壁の天端の線は引く。垂れ壁の下端は引かない（cutAlong は下端の水平線を描かない）', () => {
  const along = (z0, z1) => ({ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
    { kind: 'cutAlong', z0, z1, layerRole: 'self', isKneeDrop: true },
  ] });
  const steps = () => ({ kneeTop: [{ t: 20, weight: 'auto' }], dropBottom: [{ t: -20, weight: 'auto' }] });
  assert.deepEqual(detailLines(emitColumns([along(0, 800)], cut, { ceilZ: 2400, kneeDropPartStepsOf: steps })).map(p => p.y1), [-780]);
  assert.deepEqual(detailLines(emitColumns([along(2000, 2400)], cut, { ceilZ: 2400, kneeDropPartStepsOf: steps })), []);
});

test('cutAlong の帯: 明示の kneeTop（厚 30）が解決していれば天端 20 下の kneeCapUnderline は引かず 30 下に source=detail だけ・参照切れ（null）なら 20 下に細線（分母 20）', () => {
  const col = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'cutAlong', z0: 0, z1: 800, layerRole: 'self', isKneeDrop: true }] }];
  const plain = prims => prims.filter(p => p.source === undefined);
  const fitted = emitColumns(col, cut, { ceilZ: 2400, scaleDenom: 20, kneeDropPartStepsOf: () => ({ kneeTop: [{ t: 30, weight: 'auto' }] }) });
  assert.deepEqual(detailLines(fitted).map(p => p.y1), [-770]);
  assert.equal(hLinesAt(plain(fitted), -780).length, 0, '図が担うので天端 20 下の細線は無い');
  const gone = emitColumns(col, cut, { ceilZ: 2400, scaleDenom: 20, kneeDropPartStepsOf: () => null });
  assert.equal(detailLines(gone).length, 0);
  assert.equal(hLinesAt(plain(gone), -780).length, 1, '参照切れは従来の天端 20 下の細線');
});
