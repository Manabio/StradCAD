// stairElevPlanDiff.mjs（展開図の階段の蹴上 × 平面の踏面線・放射線の交点の両方向照合）の単体テスト。
// 蹴上の取り出し（段鼻）・面ローカル→世界・交点・±0.5 の両方向照合・範囲外・非有限を確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  noseLocalXs, verticalLineXs, localToWorldRun, planCrossings, compareRuns, summarizeCut, totalOf, formatRows, uniqueSorted, splitEdgeRuns,
} from './stairElevPlanDiff.mjs';

// 蹴込 k=20・歩行方向 +x の段板厚つき（木造）のジグザグ: 足元 (x+k) → 蹴込板 → 下面 → 段鼻面 → 次の足元。最終段は蹴込板だけ。
const woodZigzag = [[20, 0], [20, -170], [0, -170], [0, -200], [250 + 20, -200], [270, -370], [250, -370], [250, -400], [500 + 20, -400], [520, -570]];
// 蹴込 k=20 の鉄骨・RC（斜めの蹴上）: 足元 (x+k) → 段鼻 x → 次の足元
const steelZigzag = [[20, 0], [0, -200], [270, -200], [250, -400], [520, -400], [500, -600]];

test('noseLocalXs: 木造（段板厚つき）の各段の段鼻を返し、最終段は蹴込板の縦線から蹴込ぶん戻す', () => {
  assert.deepEqual(noseLocalXs([{ type: 'polyline', points: woodZigzag }], { nosingMm: 20 }), [0, 250, 500]);
});

test('noseLocalXs: 鉄骨・RC（斜めの蹴上）は段鼻の頂点そのもの、歩行方向が逆でも同じ', () => {
  assert.deepEqual(noseLocalXs([{ type: 'polyline', points: steelZigzag }], { nosingMm: 20 }), [0, 250, 500]);
  const rev = steelZigzag.map(([x, y]) => [0 - x, y]);
  assert.deepEqual(noseLocalXs([{ type: 'polyline', points: rev }], { nosingMm: 20 }), [-500, -250, 0]);
});

test('noseLocalXs: 終点が面の端に寄せられた縦線（edgeXs）は蹴込の補正をしない。非有限の点を含む polyline は捨てる', () => {
  const clamped = woodZigzag.slice(0, -1).concat([[500, -200], [500, -570]]); // 最終段の縦線が x=500 に寄せられた
  assert.deepEqual(noseLocalXs([{ type: 'polyline', points: clamped }], { nosingMm: 20, edgeXs: [500] }).at(-1), 500);
  assert.deepEqual(noseLocalXs([{ type: 'polyline', points: [[0, 0], [NaN, -200], [10, -200]] }]), []);
  assert.deepEqual(noseLocalXs([{ type: 'line', x1: 0, y1: 0, x2: 0, y2: -10 }, null, { type: 'polyline', points: [[0, 0]] }]), []);
});

test('verticalLineXs: 縦線だけを返す（水平・非有限は捨てる）', () => {
  const prims = [
    { type: 'line', x1: 10, y1: 0, x2: 10, y2: -200 },
    { type: 'line', x1: 0, y1: -200, x2: 300, y2: -200 },
    { type: 'line', x1: NaN, y1: 0, x2: NaN, y2: -200 },
  ];
  assert.deepEqual(verticalLineXs(prims), [10]);
});

test('localToWorldRun: origin + x*dirSign（dirSign が負なら世界の run は減る向き）', () => {
  assert.equal(localToWorldRun(300, 1000, 1), 1300);
  assert.equal(localToWorldRun(300, 1000, -1), 700);
});

test('planCrossings: 放射線（斜め）と直線の踏面線が切断線と交わる run 座標。平行な線・範囲外・非有限は数えない', () => {
  const line = { isVertical: true, axisValue: 100, lo: 0, hi: 1000 }; // x=100 の縦の切断線、run は y
  const segs = [
    { x1: 0, y1: 200, x2: 300, y2: 200 }, // 直線の踏面: 交点 y=200
    { x1: 0, y1: 0, x2: 200, y2: 400 }, // 放射線: x=100 で y=200 でなく 200（t=0.5）→ y=200 と重複するので別の線で
    { x1: 0, y1: 500, x2: 200, y2: 900 }, // 放射線: t=0.5 → y=700
    { x1: 100, y1: 0, x2: 100, y2: 900 }, // 切断線と平行（重なっていても交点なし）
    { x1: 0, y1: 1500, x2: 300, y2: 1500 }, // 範囲外（hi=1000 の外）
    { x1: 500, y1: 300, x2: 600, y2: 300 }, // x=100 に届かない
    { x1: NaN, y1: 0, x2: 300, y2: 0 },
  ];
  assert.deepEqual(planCrossings(segs, line), [200, 700]);
  const h = { isVertical: false, axisValue: 50, lo: 0, hi: 100 }; // y=50 の横の切断線、run は x
  assert.deepEqual(planCrossings([{ x1: 30, y1: 0, x2: 30, y2: 100 }], h), [30]);
});

test('compareRuns: 一致・展開図だけ・平面だけを両方向に数える（空の側があっても落ちない）', () => {
  const same = compareRuns([0, 250, 500], [0, 250, 500]);
  assert.deepEqual({ m: same.matched, e: same.elevOnly, p: same.planOnly }, { m: 3, e: [], p: [] });
  const elevExtra = compareRuns([0, 250, 500, 750], [0, 250, 500]);
  assert.deepEqual(elevExtra.elevOnly, [750]);
  assert.deepEqual(elevExtra.planOnly, []);
  const planExtra = compareRuns([0, 250], [0, 250, 500]);
  assert.deepEqual(planExtra.planOnly, [500]);
  assert.deepEqual(planExtra.elevOnly, []);
  assert.deepEqual(compareRuns([], [10]).planOnly, [10]);
  assert.deepEqual(compareRuns(undefined, undefined), { matched: 0, elevOnly: [], planOnly: [] });
});

test('compareRuns: 許容幅の境界（0.5 ちょうどは一致・0.5+0.001 は不一致）', () => {
  assert.equal(compareRuns([100], [100.5]).matched, 1);
  assert.equal(compareRuns([100], [100.501]).matched, 0);
  assert.equal(compareRuns([100], [99.5]).matched, 1);
  assert.equal(compareRuns([100], [99.499]).matched, 0);
  assert.equal(compareRuns([100], [100.7], 1).matched, 1); // tol 引数
});

test('summarizeCut/totalOf/formatRows: 不一致の本数が合計に出て、verbose で座標が列挙される', () => {
  const ok = summarizeCut({ doc: 'd', floor: '1階', room: 'r', seq: 'seq2', kind: '縦断', elevRuns: [0, 250], planRuns: [0, 250.2] });
  const ng = summarizeCut({ doc: 'd', floor: '1階', room: 'r', seq: 'seq4', kind: '縦断', elevRuns: [0, 260], planRuns: [0, 250, 500] });
  assert.equal(ok.ok, true);
  assert.equal(ng.ok, false);
  assert.deepEqual({ e: ng.elevOnly, p: ng.planOnly }, { e: [260], p: [250, 500] });
  const total = totalOf([ok, ng]);
  assert.deepEqual(total, { cuts: 2, checked: 2, okCuts: 1, elev: 4, plan: 5, matched: 3, elevOnly: 1, planOnly: 2, edge: 0, badCuts: 1 });
  const text = formatRows([ok, ng], { verbose: true, localOf: (r, w) => w - 10 });
  assert.match(text, /NG/);
  assert.match(text, /展開図だけ: 世界run=260 面ローカルx=250/);
  assert.match(text, /平面だけ: 世界run=500/);
});

test('summarizeCut: 横断・階段なし（E も P も空）は未検査「—」で、ok 数にも不一致数にも入らない', () => {
  const cross = summarizeCut({ doc: 'd', floor: '1階', room: 'r', seq: 'seq1', kind: '横断', elevRuns: [], planRuns: [] });
  assert.equal(cross.checked, false);
  assert.equal(cross.ok, false);
  assert.equal(cross.status, '—');
  const ok = summarizeCut({ doc: 'd', floor: '1階', room: 'r', seq: 'seq2', kind: '縦断', elevRuns: [0], planRuns: [0] });
  const t = totalOf([cross, ok]);
  assert.equal(t.cuts, 2);
  assert.equal(t.checked, 1);
  assert.equal(t.okCuts, 1);
  assert.equal(t.badCuts, 0);
  assert.match(formatRows([cross]), /—（未検査）/);
  assert.ok(!formatRows([cross]).split('\n')[1].endsWith('OK'));
});

test('summarizeCut: 面端にクランプされたジグザグ（真の段鼻が面ローカル 10）は一致にならず面端欄に入る', () => {
  // 真の最終段の段鼻は x=10 だが、点列が [0,500] へクランプされて終点の縦線が x=0 になった。
  const clamped = [[500, -200], [250, -200], [250, -400], [0, -400], [0, -600]];
  const elev = noseLocalXs([{ type: 'polyline', points: clamped }], { nosingMm: 20, edgeXs: [0, 500] });
  assert.ok(elev.includes(0), '前提: 終点の縦線が面端 x=0 の段鼻として取り出される');
  const row = summarizeCut({ doc: 'd', floor: '1', room: 'r', seq: 'seq5', kind: '縦断', elevRuns: elev, planRuns: [250], edgeRuns: [0, 500] });
  assert.deepEqual(row.edgeElev, [0]);
  assert.equal(row.matched, 1); // 面端の 0 は一致に数えず、内側の 250 だけが一致
  assert.deepEqual(row.elevOnly, []);
  assert.deepEqual(row.planOnly, []);
  assert.equal(row.ok, true);
  assert.equal(totalOf([row]).edge, 1);
});

test('summarizeCut: 面端 ±tol の平面の交点も面端欄へ移り、不一致に数えない', () => {
  const row = summarizeCut({ doc: 'd', floor: '1', room: 'r', seq: 'seq2', kind: '縦断', elevRuns: [250], planRuns: [0.4, 250, 500.5], edgeRuns: [0, 500] });
  assert.deepEqual(row.edgePlan, [0.4, 500.5]);
  assert.deepEqual(row.planOnly, []);
  assert.equal(row.ok, true);
  assert.equal(totalOf([row]).edge, 2);
  assert.deepEqual(splitEdgeRuns([0.6], [0]), { inner: [0.6], edge: [] });
});

test('compareRuns: 平面側の許容幅の境界（planOnly 側も 0.5 ちょうどは一致）', () => {
  assert.deepEqual(compareRuns([100.5], [100]).planOnly, []);
  assert.deepEqual(compareRuns([100.501], [100]).planOnly, [100]);
});

test('summarizeCut: 片側だけの不一致も NG（展開図だけ／平面だけのどちらでも）', () => {
  assert.equal(summarizeCut({ doc: 'd', floor: '1', room: 'r', seq: 's', kind: '縦断', elevRuns: [0], planRuns: [0, 250] }).ok, false);
  assert.equal(summarizeCut({ doc: 'd', floor: '1', room: 'r', seq: 's', kind: '縦断', elevRuns: [0, 250], planRuns: [0] }).ok, false);
});

test('planCrossings: 切断線に届かない線分は交点なし。範囲の ±tol の端（hi=1000 に 1000.4 は含み 1000.6 は含まない）', () => {
  const line = { isVertical: true, axisValue: 100, lo: 0, hi: 1000 };
  assert.deepEqual(planCrossings([{ x1: 0, y1: 300, x2: 50, y2: 300 }], line), []);
  assert.deepEqual(planCrossings([{ x1: 0, y1: 1000.4, x2: 200, y2: 1000.4 }], line), [1000.4]);
  assert.deepEqual(planCrossings([{ x1: 0, y1: 1000.6, x2: 200, y2: 1000.6 }], line), []);
  assert.deepEqual(planCrossings([{ x1: 0, y1: -0.4, x2: 200, y2: -0.4 }], line), [-0.4]);
  assert.deepEqual(planCrossings([{ x1: 0, y1: -0.6, x2: 200, y2: -0.6 }], line), []);
});

test('uniqueSorted: 0.01 以内の重複を畳み、0.5 離れたものは別に残す', () => {
  assert.deepEqual(uniqueSorted([0, 0.005, 0.5]), [0, 0.5]);
});

// ---- CLI（子プロセスで起動。トップレベルで process.exit する） ----
const CLI = path.join(import.meta.dirname, 'diffStairElevPlan.mjs');
function run(args) {
  try {
    execFileSync(process.execPath, ['--import', pathToFileURL(path.join(import.meta.dirname, '..', 'testSetup.mjs')).href, CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status, stderr: String(e.stderr ?? '') };
  }
}

// 階段 0 件の実データ（cl-delete-test.stq）が無い環境では skip（実データ依存のため）
const NO_STAIR_DOC = 'D:/tatsuya/Download/cl-delete-test.stq';
test('【失敗系】CLI: 検査した縦断が 0 件（階段なしの文書）は exit 3（何も見ていないのに 0 を返さない）', { skip: !fs.existsSync(NO_STAIR_DOC) }, () => {
  assert.equal(run([NO_STAIR_DOC]).code, 3);
});

test('【失敗系】CLI: 引数なし・存在しないファイル・不正なオプション値は用法エラーで exit 2', () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(['存在しない.stq']).code, 2);
  const noFile = run(['存在しない.stq', '--entry-turn-steps', '-1']);
  assert.equal(noFile.code, 2);
  assert.match(noFile.stderr, /usage/);
});
