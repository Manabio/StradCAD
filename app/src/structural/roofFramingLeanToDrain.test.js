// L字（矩形でない）の下屋の「水下だけが進む場」（roofFramingGeometry.js の leanToDrainFraming・leanToWingsOf の drains/longDepthMm/辺の種別・
// orthogonalHipLines の firstLevelMm・roofFramingLines/roofHipDiagonals の leanToDrains）のテスト。期待値は手計算（y は下向き正）。
// 規則: 面の高さ＝勾配×T、T＝水下（軒の辺のうち翼の流れの先のもの）への到達時刻（水下だけが等速で内側へ進み、壁・けらばは動かない。
// 点から水下へ屋根の中だけを通る垂線の長さの最小）。母屋の段は水下から r + k×910
// （r＝長手方向の翼の奥行きに purlinLayoutFromRidge を当てた、軒までの残り）。隅木・谷木は2つの水下までの到達時刻が等しい点の軌跡。
// T が連続でない形（段違いの水下など）は規則で作れない形＝ valid:false で線・面は空（軒先の線だけ）。
// 割付（ピッチ910・1本目の候補 [455,910]）の残り r: 奥行き1820→910、3000→725、3640→910、2000→635、4000→815。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leanToWingsOf, leanToDrainFraming, orthogonalHipLines, purlinLayoutFromRidge, roofFramingLines, roofHipDiagonals, roofOutline,
  extendLinesToOutline, extendDiagonalsToOutline,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const ct = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const DR = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const DG = (kind, x1, y1, x2, y2) => ({ kind, x1, y1, x2, y2 });
const ln = (isVertical, coord, lo, hi) => ({ isVertical, coord, lo, hi });
const plain = lines => lines.map(({ isVertical, coord, lo, hi }) => ln(isVertical, coord, lo, hi));

/** 形から水下の場を求める（母屋の段の始まりは長手方向の翼の奥行きの purlinLayoutFromRidge。入口の roofFramingLines と同じ導き方）。 */
function fieldOf({ rects, contacts }) {
  const w = leanToWingsOf({ rects, contacts, tolMm: TOL });
  const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: w.longDepthMm, pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL });
  return { w, r: eaveGapMm, fr: leanToDrainFraming({ rects, drains: w.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL }) };
}

// ---- 形（roofFramingLeanTo.test.js と同じ記号。座標は mm） ----
const F1A = { rects: [rc(0, 3640, 3640, 5460), rc(3640, 3640, 5460, 5460), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
const F1B = { rects: [rc(0, 3640, 5460, 7280), rc(3640, 0, 5460, 3640)], contacts: [ct(false, 3640, 0, 3640, -1), ct(true, 3640, 0, 3640, -1)] };
const F2 = { rects: [rc(0, 0, 5460, 1820), rc(3640, 1820, 5460, 3640)], contacts: [ct(false, 0, 0, 5460, -1)] };
const F3 = { rects: [rc(0, 0, 5460, 1820), rc(0, 1820, 1820, 3640)], contacts: [ct(false, 0, 0, 5460, -1), ct(true, 0, 0, 3640, -1)] };
// 入隅: 水下 y=1820（上の腕の下辺）と x=1820（左下の腕の右辺）が入隅の角 (1820,1820) で出会う
const F5 = { rects: F3.rects, contacts: [ct(false, 0, 1820, 5460, -1), ct(true, 0, 0, 3640, -1)] };
const F6 = { rects: [rc(2000, 1500, 4000, 3000), rc(4000, 1500, 6000, 3000), rc(2000, 3000, 4000, 4500)], contacts: [] };
const FRT1 = {
  rects: [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -7280, 9100, -3640), rc(7280, -9884, 9100, -9100), rc(7280, -9100, 9100, -7280)],
  contacts: [ct(true, 7280, -9884, -9100, -1), ct(false, -3640, 3640, 7280, -1), ct(true, 7280, -7280, -3640, -1), ct(true, 7280, -9100, -7280, -1)],
};
// U字（3翼）: 屋内 x1820..3640 × y0..3640 の左・下・右を回る
const FU = {
  rects: [rc(0, 3640, 5460, 5460), rc(0, 0, 1820, 3640), rc(3640, 0, 5460, 3640)],
  contacts: [ct(true, 1820, 0, 3640, 1), ct(false, 3640, 1820, 3640, -1), ct(true, 3640, 0, 3640, -1)],
};
// 段違いの壁: 上の壁が y=0（x 0..3640）と y=1820（x 3640..5460）。水下は下辺 y=3640 の一直線
const FSTEP = { rects: [rc(0, 0, 3640, 3640), rc(3640, 1820, 5460, 3640)], contacts: [ct(false, 0, 0, 3640, -1), ct(false, 1820, 3640, 5460, -1)] };
// 長手の翼の奥行きが 2000（455 の倍数でない）。短い翼は 1000。壁は y=0 の一直線（水下 y=2000 と y=1000 が段違い＝規則で作れない形）
const F2000 = { rects: [rc(0, 0, 2000, 2000), rc(2000, 0, 4000, 1000)], contacts: [ct(false, 0, 0, 4000, -1)] };
// 奥行きが 2000 の同じ奥行きの L字（形1a を 2000 にした形。水下は一直線の右辺と下辺・規則で作れる）。r=635
const F2000L = { rects: [rc(0, 2000, 2000, 4000), rc(2000, 2000, 4000, 4000), rc(2000, 0, 4000, 2000)], contacts: [ct(false, 2000, 0, 2000, -1), ct(true, 2000, 0, 2000, -1)] };
// 規則で作れる形（水下が一直線か入隅・向かい合い）と、作れない形（水下が段違い＝段の角で到達時刻が崖になる）
const VALID_FORMS = { F1A, F1B, F5, FRT1, FU, FSTEP, F2000L };
const INVALID_FORMS = { F2, F3, F6, F2000 };

// ---- orthogonalHipLines の段の始まり（firstLevelMm） ----

test('orthogonalHipLines: firstLevelMm を省く（既定）と今までどおり k×ピッチ。pitchMm を渡しても同じ結果。渡すと段は firstLevelMm + k×ピッチ', () => {
  const rects = [rc(0, 0, 5460, 3640)];
  const base = orthogonalHipLines({ rects, pitchMm: 910, tolMm: TOL });
  assert.deepEqual(orthogonalHipLines({ rects, pitchMm: 910, firstLevelMm: undefined, tolMm: TOL }), base, 'undefined は省略と同じ');
  assert.deepEqual(orthogonalHipLines({ rects, pitchMm: 910, firstLevelMm: 910, tolMm: TOL }), base, 'firstLevelMm=pitchMm は既定と同じ');
  const levels = lines => [...new Set(lines.map(l => l.levelMm))].sort((a, b) => a - b);
  assert.deepEqual(levels(base.purlins), [910], '既定: 910 だけ（段 1820 は棟木の段と同じなので、母屋でなく棟木の線になる）');
  assert.deepEqual(levels(base.ridges), [1820]);
  const shifted = orthogonalHipLines({ rects, pitchMm: 910, firstLevelMm: 455, tolMm: TOL });
  assert.deepEqual(levels(shifted.purlins), [455, 1365], 'firstLevelMm=455: 455・1365');
  assert.deepEqual(shifted.ridges, base.ridges, '棟木は段の始まりに依らない');
  assert.deepEqual(levels(orthogonalHipLines({ rects, pitchMm: 910, firstLevelMm: 635, tolMm: TOL }).purlins), [635, 1545]);
});

test('【失敗系】orthogonalHipLines: firstLevelMm が 0 以下・非有限なら RangeError', () => {
  const ok = { rects: [rc(0, 0, 5460, 3640)], pitchMm: 910, tolMm: TOL };
  for (const bad of [0, -1, NaN, Infinity, '910']) assert.throws(() => orthogonalHipLines({ ...ok, firstLevelMm: bad }), RangeError, String(bad));
});

// ---- leanToWingsOf: 水下・長手方向の翼の奥行き・辺の種別 ----

test('leanToWingsOf drains: 形1a は右辺と下辺の全長（外の2辺）。壁の2辺は水下でない', () => {
  const r = leanToWingsOf({ ...F1A, tolMm: TOL });
  assert.deepEqual(r.drains, [DR(true, 5460, 0, 5460, 1), DR(false, 5460, 0, 5460, 1)]);
  assert.equal(r.longDepthMm, 1820);
});

test('leanToWingsOf drains: 水下は辺の途中で切れる（形5: 下辺は x 1820..5460 だけ。左下の腕の下辺は流れと平行なのでけらば）。入隅の2つの水下', () => {
  const r = leanToWingsOf({ ...F5, tolMm: TOL });
  assert.deepEqual(r.drains, [DR(false, 1820, 1820, 5460, 1), DR(true, 1820, 1820, 3640, 1)]);
});

test('leanToWingsOf drains: 同じ直線の水下は辺の中で連続していれば1本（形1b の右辺 y 0..7280。右の腕の延長と下の腕にまたがる）', () => {
  assert.deepEqual(leanToWingsOf({ ...F1B, tolMm: TOL }).drains, [DR(true, 5460, 0, 7280, 1), DR(false, 7280, 0, 5460, 1)]);
});

test('leanToWingsOf 辺の種別: どれかの翼の壁と平行なら軒（けらばは全ての翼の流れと平行な辺だけ）。U字は外周の左右が軒・上辺の腕の先がけらば', () => {
  const r = leanToWingsOf({ ...FU, tolMm: TOL });
  const kind = (isVertical, coord) => r.kindZones.filter(z => z.isVertical === isVertical && z.coord === coord).map(z => `${z.lo}..${z.hi}${z.kind[0]}`);
  assert.deepEqual(kind(true, 0), ['0..5460e'], '左辺: 左の腕（流れ -x）が直交→軒。下の腕の延長（流れ +y）は平行だが軒が勝つ');
  assert.deepEqual(kind(true, 5460), ['0..5460e']);
  assert.deepEqual(kind(false, 5460), ['0..5460e']);
  assert.deepEqual(kind(false, 0), ['0..1820g', '3640..5460g'], '上辺: 腕の先（流れと平行）はけらば');
});

test('leanToWingsOf longDepthMm: 水下が最も長い側の翼の奥行き。同長の水下が複数なら壁の区間が長い翼（同長は番号の小さい翼）', () => {
  assert.equal(leanToWingsOf({ ...F1B, tolMm: TOL }).longDepthMm, 1820, '右辺 7280 へ流れる右の腕（奥行き 1820）。下の腕（3640）ではない');
  assert.equal(leanToWingsOf({ ...FRT1, tolMm: TOL }).longDepthMm, 1820, 'roof-test1: 右辺 9884 へ流れる W1（奥行き 1820）。W2（3640）ではない');
  assert.equal(leanToWingsOf({ ...F6, tolMm: TOL }).longDepthMm, 3000, '水下 2000 と 2000 が同長 → 壁の区間も同長 → 番号の小さい翼（奥行き 3000）');
  assert.equal(leanToWingsOf({ ...F2000, tolMm: TOL }).longDepthMm, 2000, '同長 → 番号の小さい翼（奥行き 2000。短い翼は 1000）');
  assert.equal(leanToWingsOf({ rects: [rc(0, 0, 4000, 3000)], contacts: [ct(false, 0, 0, 4000, -1)], tolMm: TOL }).longDepthMm, 3000);
  const u = leanToWingsOf({ ...FU, tolMm: TOL });
  assert.equal(u.longDepthMm, 1820, 'U字: 3つの水下が同長（5460）。どの翼も奥行き 1820');
});

// ---- leanToDrainFraming: 形ごと ----

test('形1a（奥行きが同じ L字）: 母屋と隅木は今の線（翼ごとの母屋・継ぎ目）と一致する。面は水下ごとの2つ', () => {
  const { fr, r } = fieldOf(F1A);
  assert.equal(r, 910);
  assert.deepEqual(fr.ridges, []);
  assert.deepEqual(plain(fr.purlins), [ln(false, 4550, 0, 4550), ln(true, 4550, 0, 4550)]);
  assert.deepEqual(fr.diagonals, [DG('hip', 5460, 5460, 3640, 3640)]);
  assert.deepEqual(fr.faces.map(f => [f.drain, f.lineIsVertical, plain(f.lines)]), [
    [DR(false, 5460, 0, 5460, 1), false, [ln(false, 4550, 0, 4550)]],
    [DR(true, 5460, 0, 5460, 1), true, [ln(true, 4550, 0, 4550)]],
  ], '面の順: 水下の長さ（同長）→ 上・下・左・右（下が先）');
  assert.deepEqual(fr.purlins.map(l => l.levelMm), [910, 910], '母屋は水下から 910');
});

test('形1b（奥行きが違う L字）: 隅木は外の角 (5460,7280) から45°で、浅い翼（右の腕）の壁 x=3640 を越え、深い翼の壁 y=3640 に当たって (1820,3640) で終わる', () => {
  const { fr, r } = fieldOf(F1B);
  assert.equal(r, 910, '長手方向＝右辺 7280 → 右の腕の奥行き 1820');
  assert.deepEqual(fr.diagonals, [DG('hip', 5460, 7280, 1820, 3640)]);
  assert.deepEqual(plain(fr.purlins), [
    ln(false, 4550, 0, 2730), ln(false, 5460, 0, 3640), ln(false, 6370, 0, 4550),
    ln(true, 2730, 3640, 4550), ln(true, 3640, 3640, 5460), ln(true, 4550, 0, 6370),
  ], '壁の上（x=3640 の y<3640・y=3640 の x<3640）の切れ端は捨てる。x=3640 の y 3640..5460 は屋根の内部の線なので残る');
  assert.deepEqual(fr.faces.map(f => plain(f.lines).length), [3, 3], '右辺の面（縦の母屋）と下辺の面（横の母屋）が3本ずつ');
});

test('roof-test1.stq の2階: 隅木 (9100,0)→(5460,-3640)、母屋6本、面2つ（右へ流れる面・下へ流れる面）。軒先の角 (9555,455) まで延びる', () => {
  const { fr, r, w } = fieldOf(FRT1);
  assert.equal(r, 910);
  assert.deepEqual(fr.diagonals, [DG('hip', 9100, 0, 5460, -3640)]);
  assert.deepEqual(plain(fr.purlins), [
    ln(false, -2730, 3640, 6370), ln(false, -1820, 3640, 7280), ln(false, -910, 3640, 8190),
    ln(true, 6370, -3640, -2730), ln(true, 7280, -3640, -1820), ln(true, 8190, -9884, -910),
  ]);
  assert.equal(fr.faces.length, 2);
  const { edges } = roofOutline({ rects: FRT1.rects, shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm: 455, gableOverhangMm: 455, zeroZones: FRT1.contacts, kindZones: w.kindZones, tolMm: TOL });
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: fr.diagonals, edges, tolMm: TOL }), [DG('hip', 9555, 455, 5460, -3640)], '普通の角の規則（midEdge 不要）');
});

test('入隅の L字（形5）: 2つの水下の入隅の角 (1820,1820) から谷木。壁の角 (0,0) で終わる。軒先の入隅の角 (2275,2275) まで延ばせる（valleys）', () => {
  const { fr, w } = fieldOf(F5);
  assert.deepEqual(fr.diagonals, [DG('valley', 1820, 1820, 0, 0)]);
  assert.deepEqual(plain(fr.purlins), [ln(false, 910, 910, 5460), ln(true, 910, 910, 3640)]);
  const { edges } = roofOutline({ rects: F5.rects, shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm: 455, gableOverhangMm: 455, zeroZones: F5.contacts, kindZones: w.kindZones, tolMm: TOL });
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: fr.diagonals, edges, valleys: true, tolMm: TOL }), [DG('valley', 2275, 2275, 0, 0)]);
  assert.deepEqual(extendDiagonalsToOutline({ diagonals: fr.diagonals, edges, tolMm: TOL }), fr.diagonals, '既定（valleys なし）は谷木を延ばさない');
});

test('面の同点（形5の入隅）: 縦の母屋 x=910 は2つの水下から等距離。線の向きと水下の向きが一致する面（水下 x=1820）に入り、水下 y=1820 の面は横の母屋だけになる', () => {
  const { fr } = fieldOf(F5);
  assert.deepEqual(fr.faces.map(f => [f.drain, f.lineIsVertical, plain(f.lines)]), [
    [DR(false, 1820, 1820, 5460, 1), false, [ln(false, 910, 910, 5460)]],
    [DR(true, 1820, 1820, 3640, 1), true, [ln(true, 910, 910, 3640)]],
  ]);
});

test('3翼（U字）: 水下は左・下・右の3本。隅木は水下と水下の外の角（(0,5460)・(5460,5460)）の2本で、棟木は出ない', () => {
  const { fr, w } = fieldOf(FU);
  assert.equal(w.drains.length, 3);
  assert.deepEqual(fr.ridges, []);
  assert.deepEqual(fr.diagonals, [DG('hip', 0, 5460, 1820, 3640), DG('hip', 5460, 5460, 3640, 3640)]);
  assert.deepEqual(plain(fr.purlins), [ln(false, 4550, 910, 4550), ln(true, 910, 0, 4550), ln(true, 4550, 0, 4550)]);
  assert.deepEqual(fr.faces.map(f => [f.drain.isVertical, f.drain.outward, plain(f.lines).length]), [[false, 1, 1], [true, -1, 1], [true, 1, 1]], '面＝水下ごと（下・左・右の順）');
});

test('段違いの壁（水下が一直線）: 面は1つで継ぎ目は出ない。壁の上に乗る母屋（y=1820 の x 3640..5460・y=0）は捨てる', () => {
  const { fr, w } = fieldOf(FSTEP);
  assert.equal(w.wings.length, 1, '前提: 翼は左の1つ（右の部分は左の翼の延長に入る。段違いの壁 y=1820 は翼の壁として別に数えない）');
  assert.deepEqual(w.drains, [DR(false, 3640, 0, 5460, 1)]);
  assert.deepEqual(fr.diagonals, []);
  assert.equal(fr.faces.length, 1);
  assert.deepEqual(plain(fr.purlins), [ln(false, 910, 0, 3640), ln(false, 1820, 0, 3640), ln(false, 2730, 0, 5460)]);
  assert.deepEqual(plain(fr.faces[0].lines), plain(fr.purlins));
});

test('奥行きが 455 の倍数でない（2000）の同じ奥行きの L字: r=635。水下から 635・1545 の段（右辺 x=4000・下辺 y=4000 から）', () => {
  const { fr, r, w } = fieldOf(F2000L);
  assert.equal(r, 635, '奥行き 2000 → 455 始まり: 455・1365（残り 635）');
  assert.deepEqual(w.drains, [DR(true, 4000, 0, 4000, 1), DR(false, 4000, 0, 4000, 1)]);
  assert.equal(fr.valid, true);
  assert.deepEqual(fr.diagonals, [DG('hip', 4000, 4000, 2000, 2000)], '外の角 (4000,4000) から入隅の壁の角 (2000,2000) まで');
  assert.deepEqual(plain(fr.purlins), [ln(false, 2455, 0, 2455), ln(false, 3365, 0, 3365), ln(true, 2455, 0, 2455), ln(true, 3365, 0, 3365)],
    '水下 x=4000・y=4000 から 635（3365）・1545（2455）。段は全て r + k×910。壁の上（y=2000 の x<2000・x=2000 の y<2000）は捨てる');
  assert.deepEqual(fr.purlins.map(l => l.levelMm).sort((a, b) => a - b), [635, 635, 1545, 1545]);
});

// 旧: 長手の奥行きが 2000・短い翼 1000 の L字（形 2000）は、長手の水下から 635・1545、短い翼の水下からも同じ段（635）の母屋が出た。
// 新: 水下 y=2000 と y=1000 は段違い。段の角（x=2000）で、壁 y=0 の側の点は近い水下 y=1000 へ、遠い点は水下 y=2000 へ流れ、
// 到達時刻が崖になる（連続しない）ので規則で作れない形（valid:false・線なし）
test('段違いの水下（形6・形2000・形2・形3。屋内に接しない／壁が段違い）は規則で作れない形＝ valid:false。線・面は空で、崖の線分が invalidAt に入る', () => {
  const cliffs = {
    F6: { kind: 'cliff', isVertical: true, coord: 4000, lo: 1500, hi: 3000 },
    F2000: { kind: 'cliff', isVertical: true, coord: 2000, lo: 0, hi: 1000 },
    F2: { kind: 'cliff', isVertical: true, coord: 3640, lo: 0, hi: 1820 },
    F3: { kind: 'cliff', isVertical: true, coord: 1820, lo: 0, hi: 1820 },
  };
  assert.deepEqual(Object.keys(cliffs).sort(), Object.keys(INVALID_FORMS).sort(), '前提: 作れない形を全部見る');
  for (const [name, form] of Object.entries(INVALID_FORMS)) {
    const { fr, r } = fieldOf(form);
    assert.ok(r > 0, `${name}: 前提: 母屋の段の基準は求まる（水下の側は正常）`);
    assert.equal(fr.valid, false, name);
    assert.deepEqual([fr.ridges, fr.purlins, fr.diagonals, fr.faces], [[], [], [], []], `${name}: 線・面は空`);
    assert.deepEqual(fr.invalidAt.filter(x => x.kind === 'cliff' && x.isVertical === cliffs[name].isVertical && x.coord === cliffs[name].coord), [cliffs[name]], `${name}: 崖の線分`);
  }
});

test('向かい合う水下（2本）: 棟木が中央に出る。母屋は各水下から 910。面は水下ごと', () => {
  const rects = [rc(0, 0, 3640, 1820)];
  const fr = leanToDrainFraming({ rects, drains: [DR(true, 0, 0, 1820, -1), DR(true, 3640, 0, 1820, 1)], pitchMm: 910, firstLevelMm: 910, tolMm: TOL });
  assert.deepEqual(plain(fr.ridges), [ln(true, 1820, 0, 1820)]);
  assert.deepEqual(plain(fr.purlins), [ln(true, 910, 0, 1820), ln(true, 2730, 0, 1820)]);
  assert.deepEqual(fr.diagonals, []);
  assert.deepEqual(fr.faces.map(f => [f.drain.coord, plain(f.lines)]), [[0, [ln(true, 910, 0, 1820), ln(true, 1820, 0, 1820)]], [3640, [ln(true, 2730, 0, 1820)]]],
    '棟木も面に入る（小屋梁が支える）。2つの水下から等距離で向きも同じなので番号の小さい水下（x=0）の面');
});

test('中庭（穴）に面する水下: 帯は向こう側の屋根に当たって止まる。穴の四隅から谷木、母屋は穴を囲む環', () => {
  const rects = [rc(0, 0, 5460, 1820), rc(0, 3640, 5460, 5460), rc(0, 1820, 1820, 3640), rc(3640, 1820, 5460, 3640)];
  const hole = [DR(false, 1820, 1820, 3640, 1), DR(false, 3640, 1820, 3640, -1), DR(true, 1820, 1820, 3640, 1), DR(true, 3640, 1820, 3640, -1)];
  const fr = leanToDrainFraming({ rects, drains: hole, pitchMm: 910, firstLevelMm: 910, tolMm: TOL });
  assert.deepEqual(plain(fr.purlins), [ln(false, 910, 910, 4550), ln(false, 4550, 910, 4550), ln(true, 910, 910, 4550), ln(true, 4550, 910, 4550)]);
  assert.deepEqual(fr.diagonals, [DG('valley', 1820, 1820, 0, 0), DG('valley', 1820, 3640, 0, 5460), DG('valley', 3640, 1820, 5460, 0), DG('valley', 3640, 3640, 5460, 5460)]);
});

test('矩形の屋根範囲は矩形の片流れの式と一致する（R1: 上辺の壁・R2: 左辺の壁）。継ぎ目なし・面は1つ', () => {
  const RECT = rc(0, 0, 4000, 3000);
  for (const [contacts, highSide] of [[[ct(false, 0, 0, 4000, -1)], 'top'], [[ct(false, 0, 1000, 2000, -1), ct(true, 0, 0, 3000, -1)], 'left']]) {
    const { fr } = fieldOf({ rects: [RECT], contacts });
    const direct = roofFramingLines({ rect: RECT, shape: RoofShape.MONO, highSide, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL });
    assert.deepEqual(plain(fr.purlins), direct.purlins, highSide);
    assert.deepEqual(fr.diagonals, [], highSide);
    assert.equal(fr.faces.length, 1, highSide);
  }
});

test('面: 母屋・棟木はちょうど1つの面に属する。面の lines は sortLines 済みで、全面を合わせると purlins と ridges を合わせたものと一致する（全形）', () => {
  const byLine = (a, b) => (a.isVertical === b.isVertical ? 0 : (a.isVertical ? 1 : -1)) || a.coord - b.coord || a.lo - b.lo;
  let lines = 0;
  for (const [name, form] of Object.entries(VALID_FORMS)) {
    const { fr } = fieldOf(form);
    assert.equal(fr.valid, true, name);
    assert.deepEqual(fr.faces.flatMap(f => f.lines).sort(byLine), [...fr.purlins, ...fr.ridges].sort(byLine), name);
    for (const f of fr.faces) assert.deepEqual(f.lines, [...f.lines].sort(byLine), `${name}: lines は sortLines 済み`);
    // 水下だけが進む場では、面の中の線は全て水下と同じ向き（流れは面の中で一定）
    for (const f of fr.faces) for (const l of f.lines) assert.equal(l.isVertical, f.lineIsVertical, `${name}: 面の線の向きは水下と同じ`);
    lines += fr.purlins.length + fr.ridges.length;
  }
  assert.ok(lines >= 20, `検査が空振りしない（線 ${lines} 本）`);
});

// ---- 入口（roofFramingLines・roofHipDiagonals）と leanToDrainFraming の一致 ----

test('入口: roofFramingLines の母屋・棟木と roofHipDiagonals の斜め線は leanToDrainFraming と一致する（全形）。ピッチ・段の始まりは入口が purlinLayoutFromRidge で導く', () => {
  let compared = 0;
  for (const [name, form] of Object.entries({ ...VALID_FORMS, ...INVALID_FORMS })) {
    const { fr, w } = fieldOf(form);
    compared += fr.purlins.length + fr.diagonals.length;
    const base = { rect: null, rects: form.rects, shape: RoofShape.MONO, ridgeIsVertical: null, highSide: null, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL };
    assert.deepEqual(roofFramingLines({ ...base, leanToDrains: w.drains, leanToPurlinDepthMm: w.longDepthMm }), { ridges: fr.ridges, purlins: fr.purlins }, name);
    assert.deepEqual(roofHipDiagonals({ rect: null, rects: form.rects, shape: RoofShape.MONO, leanToDrains: w.drains, tolMm: TOL }), fr.diagonals, name);
  }
  assert.ok(compared >= 20, `検査が空振りしない（線 ${compared} 本。作れない形は空どうしで一致）`);
});

// ---- 失敗系 ----

test('【失敗系】leanToDrainFraming: 水下が空・使える矩形が無いときは全て空（例外にしない）', () => {
  const empty = { ridges: [], purlins: [], diagonals: [], faces: [], valid: false, invalidAt: [] }; // 水下が空・矩形が無いは屋根面が無い＝ valid:false（崖ではない）
  const ok = { rects: F1A.rects, drains: leanToWingsOf({ ...F1A, tolMm: TOL }).drains, pitchMm: 910, firstLevelMm: 910, tolMm: TOL };
  assert.equal(leanToDrainFraming(ok).valid, true, '対照: 正常な入力は valid:true');
  assert.deepEqual(leanToDrainFraming({ ...ok, drains: [] }), empty, '水下なし');
  assert.deepEqual(leanToDrainFraming({ ...ok, rects: [] }), empty, '矩形なし');
  assert.deepEqual(leanToDrainFraming({ ...ok, rects: [rc(0, 0, 0.2, 100)] }), empty, '幅が許容差以下');
  assert.deepEqual(leanToDrainFraming({ ...ok, drains: [DR(true, 5460, 0, 0.2, 1)] }), empty, '長さが許容差以下の水下は捨てる');
});

test('【失敗系】leanToDrainFraming: ピッチ・段の始まり・許容差・rects・drains が不正なら RangeError', () => {
  const drains = leanToWingsOf({ ...F1A, tolMm: TOL }).drains;
  const ok = { rects: F1A.rects, drains, pitchMm: 910, firstLevelMm: 910, tolMm: TOL };
  for (const bad of [0, -910, NaN, undefined]) assert.throws(() => leanToDrainFraming({ ...ok, pitchMm: bad }), RangeError, `pitch ${bad}`);
  for (const bad of [0, -1, NaN]) assert.throws(() => leanToDrainFraming({ ...ok, firstLevelMm: bad }), RangeError, `firstLevel ${bad}`);
  assert.doesNotThrow(() => leanToDrainFraming({ ...ok, firstLevelMm: undefined }), '省略は pitchMm');
  assert.throws(() => leanToDrainFraming({ ...ok, tolMm: -1 }), RangeError);
  assert.throws(() => leanToDrainFraming({ ...ok, rects: null }), RangeError);
  assert.throws(() => leanToDrainFraming({ ...ok, rects: [rc(0, 0, NaN, 10)] }), RangeError);
  assert.throws(() => leanToDrainFraming({ ...ok, rects: [rc(10, 0, 0, 10)] }), RangeError);
  assert.throws(() => leanToDrainFraming({ ...ok, drains: null }), RangeError);
  assert.throws(() => leanToDrainFraming({ ...ok, drains: [DR(true, 5460, 100, 0, 1)] }), RangeError, 'lo>hi');
  assert.throws(() => leanToDrainFraming({ ...ok, drains: [DR(true, 5460, 0, 100, 0)] }), RangeError, 'outward');
  assert.throws(() => leanToDrainFraming({ ...ok, drains: [DR(true, NaN, 0, 100, 1)] }), RangeError, 'coord');
  assert.throws(() => leanToDrainFraming({ ...ok, drains: [{ coord: 0, lo: 0, hi: 1, outward: 1 }] }), RangeError, 'isVertical が無い');
});

test('【失敗系】leanToWingsOf の drains・longDepthMm: 使える矩形が無ければ空・null。接していない（仮の壁）L字でも水下は出る', () => {
  const none = leanToWingsOf({ rects: [], contacts: [], tolMm: TOL });
  assert.deepEqual([none.drains, none.longDepthMm], [[], null]);
  const loose = leanToWingsOf({ rects: F2.rects, contacts: [], tolMm: TOL });
  assert.ok(loose.drains.length > 0 && loose.longDepthMm > 0);
});

test('orthogonalHipLines の既定が不変: leanToDrainFraming が使う firstLevelMm を足しても、寄棟（firstLevelMm なし）の矩形・L字の結果は変わらない', () => {
  const lShape = [rc(0, 0, 5460, 3640), rc(0, 3640, 5460, 7280), rc(5460, 3640, 9100, 7280)];
  for (const rects of [[rc(0, 0, 7280, 5460)], lShape]) {
    const base = orthogonalHipLines({ rects, pitchMm: 910, tolMm: TOL });
    assert.deepEqual(orthogonalHipLines({ rects, pitchMm: 910, firstLevelMm: 910, tolMm: TOL }), base);
    assert.ok(base.purlins.length > 0);
  }
  assert.deepEqual(plain(orthogonalHipLines({ rects: lShape, pitchMm: 910, tolMm: TOL }).purlins).slice(0, 3),
    [ln(false, 910, 910, 4550), ln(false, 1820, 1820, 3640), ln(false, 4550, 4550, 8190)], '矩形でない寄棟の既存の結果（framingDrawing.test.js の C2e-2 と同じ）');
});

test('extendLinesToOutline: 場の母屋（水下から測る）の端が外形の辺の上にあれば、けらば側だけ延びる（形1b。右辺・下辺の水下側は延びない）', () => {
  const { fr, w } = fieldOf(F1B);
  const { edges } = roofOutline({ rects: F1B.rects, shape: RoofShape.MONO, highSide: 'top', eaveOverhangMm: 600, gableOverhangMm: 300, zeroZones: F1B.contacts, kindZones: w.kindZones, tolMm: TOL });
  assert.deepEqual(extendLinesToOutline({ lines: fr.purlins, edges, tolMm: TOL }).map(l => [l.isVertical, l.coord, l.lo, l.hi]), [
    [false, 4550, -300, 2730], [false, 5460, -300, 3640], [false, 6370, -300, 4550], [true, 2730, 3640, 4550], [true, 3640, 3640, 5460], [true, 4550, -300, 6370],
  ]);
});
