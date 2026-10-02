// beamJunction.js（在来木造の梁の交点処理・B-3・2026-09-17裁定「通しが勝つ」）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBeamJunctionSpans, continuousBeamLengths } from './beamJunction.js';

const THROUGH = Object.freeze({ beamJunction: 'throughWins' });

// role='primary'既定、base1/base2は省略時end1/end2（＝柱トリムなし）。
function beam(id, isVertical, axisValue, end1, end2, opts = {}) {
  const { role = 'primary', halfWidth = 60, sectionKey = 'S', base1 = end1, base2 = end2 } = opts;
  return { id, role, isVertical, axisValue, end1, end2, base1, base2, halfWidth, sectionKey };
}

test('(a) 共線同断面ペア＋T字 → ペアはthrough(p)、Tはwinnerface(p+dir・Wh)', () => {
  const beams = [
    beam('H1', false, 0, -1000, 0, { sectionKey: 'S', halfWidth: 60 }),
    beam('H2', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: 60 }),
    beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H1').coord2, 0);
  assert.equal(j.get('H1').ends[1].kind, 'through');
  assert.equal(j.get('H1').ends[1].capped, false);
  assert.equal(j.get('H2').coord1, 0);
  assert.equal(j.get('H2').ends[0].kind, 'through');
  assert.equal(j.get('V').coord1, 60); // p(0) + dir(+1)*Wh(60)
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
  assert.equal(j.get('V').ends[0].capped, false);
});

test('(b) 共線ペア断面違い → 3本とも出力なし（sectionBreak＝勝者なし）', () => {
  const beams = [
    beam('H1', false, 0, -1000, 0, { sectionKey: 'A', halfWidth: 60 }),
    beam('H2', false, 0, 0, 1000, { sectionKey: 'B', halfWidth: 60 }),
    beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.size, 0, `いずれも変化しないはず: ${[...j.keys()]}`);
});

test('(c) passing＋T → TだけwinnerFace（通過梁自身は出力に現れない）', () => {
  const beams = [
    beam('P', false, 0, -1000, 1000, { sectionKey: 'S', halfWidth: 60 }), // 交点を内部で通過
    beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.has('P'), false, '通過するだけの梁は出力に現れない');
  assert.equal(j.get('V').coord1, 60);
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
});

test('(d) L字は長い方がcornerClose(capped)・短い方がwinnerFace（検算値: H勝ち→H端=−v・V端=+h）', () => {
  const h = 60, v = 45;
  const beams = [
    beam('H', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: h }), // 体+x・長さ1000
    beam('V', true, 0, 0, 800, { sectionKey: 'T', halfWidth: v }),   // 体+y・長さ800（Hより短い）
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H').ends[0].kind, 'cornerClose');
  assert.equal(j.get('H').ends[0].capped, true);
  assert.equal(j.get('H').coord1, -v); // p(0) − dir(+1)×Lh(v)
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
  assert.equal(j.get('V').ends[0].capped, false);
  assert.equal(j.get('V').coord1, h); // p(0) + dir(+1)×Wh(h)
});

test('(e) L字同長 → X方向が勝つ', () => {
  const beams = [
    beam('H', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: 60 }),
    beam('V', true, 0, 0, 1000, { sectionKey: 'T', halfWidth: 45 }), // 同長
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H').ends[0].kind, 'cornerClose', 'X（H）が勝者');
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
});

test('(f) 十字両通し → X方向がthrough・Y方向がwinnerFace（十字の既定タイブレークはX）', () => {
  const beams = [
    beam('H1', false, 0, -1000, 0, { sectionKey: 'S', halfWidth: 60 }),
    beam('H2', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: 60 }),
    beam('V1', true, 0, -800, 0, { sectionKey: 'T', halfWidth: 45 }),
    beam('V2', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H1').ends[1].kind, 'through');
  assert.equal(j.get('H2').ends[0].kind, 'through');
  assert.equal(j.get('V1').ends[1].kind, 'winnerFace');
  assert.equal(j.get('V1').coord2, -60); // p(0) + dir(−1)×Wh(60)
  assert.equal(j.get('V2').ends[0].kind, 'winnerFace');
  assert.equal(j.get('V2').coord1, 60); // p(0) + dir(+1)×Wh(60)
});

test('(g) 下階柱の無い交点でも同じ分類（base1/base2＝柱トリムの有無に依らずends/coordは不変）', () => {
  const withColumns = [
    beam('P', false, 0, -1000, 1000, { sectionKey: 'S', halfWidth: 60, base1: -900, base2: 900 }),
    beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const withoutColumns = [
    beam('P', false, 0, -1000, 1000, { sectionKey: 'S', halfWidth: 60 }), // base=end（柱なし）
    beam('V', true, 0, 0, 500, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const jWith = resolveBeamJunctionSpans(THROUGH, withColumns);
  const jWithout = resolveBeamJunctionSpans(THROUGH, withoutColumns);
  assert.deepEqual(jWith.get('V'), jWithout.get('V'), '柱の有無（baseの範囲）で交点分類・coordが変わってはならない');
});

test('【失敗系】(h) 床梁・小梁（role!=primary）を混ぜても大梁（primary）を切らない', () => {
  const beams = [
    beam('H1', false, 0, -1000, 0, { sectionKey: 'S', halfWidth: 60 }), // 唯一のprimary（この交点で孤立端）
    beam('Sec', false, 0, 0, 1000, { role: 'secondary', sectionKey: 'S', halfWidth: 60 }), // 同断面・逆向き（除外対象）
    beam('Floor', false, 0, 0, 1500, { role: 'floor', sectionKey: 'S', halfWidth: 60 }), // 同上（除外対象）
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.has('H1'), false,
    '小梁・床梁を「通しの相方」と誤認してH1をthroughへ切ってはならない（role==primaryのみ参加）');
  assert.equal(j.has('Sec'), false, '非primaryは出力に現れない');
  assert.equal(j.has('Floor'), false, '非primaryは出力に現れない');
});

test("【失敗系】(i) drawing.beamJunction!=='throughWins'（'columnFace'・未知値・undefined・null）は常に空Map", () => {
  const beams = [
    beam('H', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: 60 }),
    beam('V', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 45 }),
  ];
  assert.equal(resolveBeamJunctionSpans({ beamJunction: 'columnFace' }, beams).size, 0);
  assert.equal(resolveBeamJunctionSpans({ beamJunction: 'no-such-value' }, beams).size, 0);
  assert.equal(resolveBeamJunctionSpans(undefined, beams).size, 0);
  assert.equal(resolveBeamJunctionSpans(null, beams).size, 0);
  assert.equal(resolveBeamJunctionSpans({}, beams).size, 0);
});

test('【失敗系】(j) 端点がtol超で離れていれば別交点（マージされず勝者判定に至らない）', () => {
  // H1・H2は同軸・同断面だが端点が既定tol(0.5)超の2mm離れているため別クラスタになり、
  // どちらも「相方」を見つけられず（直交方向にarmが無いのでL字判定にも至らない）出力なし。
  const beams = [
    beam('H1', false, 0, -1000, 0, { sectionKey: 'S', halfWidth: 60 }),
    beam('H2', false, 0, 2, 1000, { sectionKey: 'S', halfWidth: 60 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.size, 0, '端点が別クラスタになり、いずれの梁も交点の相手を見つけられないはず');
});

test('(k) halfWidth=0で全kindがpに一致する', () => {
  const beams = [
    beam('H', false, 0, 0, 1000, { sectionKey: 'S', halfWidth: 0 }),
    beam('V', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 0 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H').ends[0].kind, 'cornerClose');
  assert.equal(j.get('H').coord1, 0);
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
  assert.equal(j.get('V').coord1, 0);
});

test('(l) base端の座標はbase1/base2（柱面トリム後の実体スパン）を使う。end1/end2（AXIS・未トリム）ではない', () => {
  const beams = [
    // 交点(0,0)・(100,0)の両方を内部で通過する共通の通し梁。
    beam('P', false, 0, -1000, 1000, { sectionKey: 'S', halfWidth: 60 }),
    // 上端(end2=800)は柱面トリムでbase2=740まで既に控えられている想定（end2とは別の値）。
    // endIndex1（end1側=下端、Pと交わる側）がwinnerFace、endIndex0（上端）は相方が無くbaseに落ちる。
    beam('V', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 45, base2: 740 }),
    // Vと対称に向きを反転（end1=上端・base1=740、end2=0側がPと交わる）——end1側(endIndex0)がbaseに
    // 落ちる構成にして、base1の取り違え（end1で代用してしまう回帰）も同じテストで検出する。
    beam('W', true, 100, 800, 0, { sectionKey: 'T', halfWidth: 45, base1: 740 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('V').coord1, 60, '下端はwinnerFace（p+dir・Wh）');
  assert.equal(j.get('V').ends[1].kind, 'base', '上端は交点処理の対象外（相方が無い）＝base');
  assert.equal(j.get('V').coord2, 740, 'base側の座標はbase2を使う（end2=800を使ってはならない）');

  assert.equal(j.get('W').coord2, 60, '下端(endIndex1)はwinnerFace（p+dir・Wh）');
  assert.equal(j.get('W').ends[0].kind, 'base', '上端(endIndex0)は交点処理の対象外＝base');
  assert.equal(j.get('W').coord1, 740, 'base側の座標はbase1を使う（end1=800を使ってはならない）');
});

test("【失敗系】(m) 軒桁(eaves)・基礎梁(foundation)はrole!=='primary'のため交点処理に参加しない（L字であっても出力なし）", () => {
  const beams = [
    beam('E1', false, 0, 0, 1000, { role: 'eaves', sectionKey: 'S', halfWidth: 60 }),
    beam('E2', true, 0, 0, 800, { role: 'eaves', sectionKey: 'T', halfWidth: 45 }),
    beam('F1', false, 0, 0, 1000, { role: 'foundation', sectionKey: 'S', halfWidth: 60 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.size, 0,
    '軒桁(eaves)・基礎梁(foundation)は対象外——基礎梁はwoodFoundationBandsが別系統で処理し、軒桁・屋根材は3f以降で別途裁定する');
});

test('(n) L字で片方向に複数armがあっても各方向の最長で比較する（X:1000と600、Y:800の1本→X勝ち）', () => {
  const beams = [
    beam('XA', false, 0, 0, 1000, { sectionKey: 'A', halfWidth: 60 }),
    beam('XB', false, 0, 0, 600, { sectionKey: 'B', halfWidth: 60 }),
    beam('YV', true, 0, 0, 800, { sectionKey: 'T', halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('XA').ends[0].kind, 'cornerClose', '最長(1000)がX方向の代表値としてYの800に勝つ');
  assert.equal(j.get('XA').coord1, -45); // p(0) − dir(+1)×Lh(45)
  assert.equal(j.get('XB').ends[0].kind, 'cornerClose', '同方向の他armも勝者側なのでcornerClose');
  assert.equal(j.get('XB').coord1, -45);
  assert.equal(j.get('YV').ends[0].kind, 'winnerFace');
  assert.equal(j.get('YV').coord1, 60); // p(0) + dir(+1)×Wh(max(60,60)=60)
});

test('【失敗系】(o) beams が null / 空配列でも例外を投げず空Mapを返す', () => {
  assert.equal(resolveBeamJunctionSpans(THROUGH, null).size, 0);
  assert.equal(resolveBeamJunctionSpans(THROUGH, []).size, 0);
  assert.doesNotThrow(() => resolveBeamJunctionSpans(THROUGH, null));
});

// ---- 出隅の長さ＝同じ軸で連続する梁の全長（ユーザー裁定2026-10-02「短手と長手が出会うとき、長手勝ち」）----
const TOL = 0.5;

test('(p1) 連続長: 1本だけなら材長（end1>end2の向きでも同じ）', () => {
  const m = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', true, 5000, 800, 0)], TOL);
  assert.equal(m.get('A'), 1000);
  assert.equal(m.get('B'), 800);
});

test('(p2) 連続長: 端と端がつながる2本・3本は全員が合計の長さ（並び順・向きに依らない）', () => {
  const two = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 1000, 2500)], TOL);
  assert.equal(two.get('A'), 2500);
  assert.equal(two.get('B'), 2500);
  const three = continuousBeamLengths([
    beam('C', false, 0, 3000, 2000), // end1>end2
    beam('A', false, 0, 0, 1000),
    beam('B', false, 0, 1000, 2000),
  ], TOL);
  for (const id of ['A', 'B', 'C']) assert.equal(three.get(id), 3000, id);
});

test('(p3) 連続長: tol 以内のずれはつなぎ、すき間・重なりはつながない（別の run）', () => {
  const near = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 1000.3, 2000)], TOL);
  assert.equal(near.get('A'), 2000);
  const gap = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 1100, 2000)], TOL);
  assert.equal(gap.get('A'), 1000);
  assert.equal(gap.get('B'), 900);
  const overlap = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 600, 2000)], TOL);
  assert.equal(overlap.get('A'), 1000);
  assert.equal(overlap.get('B'), 1400);
});

test('(p9) 連続長: end1/end2（柱面トリム前）でつなぐ——分割点の両側が柱幅ぶん離れた base1/base2 では見ない', () => {
  // 下階柱（幅120）の位置 x=1000 で分割された2本。描画スパン（base）は柱の面 940・1060 で止まっていて離れている。
  const m = continuousBeamLengths([
    beam('A', false, 0, 0, 1000, { base2: 940 }),
    beam('B', false, 0, 1000, 2500, { base1: 1060 }),
  ], TOL);
  assert.equal(m.get('A'), 2500);
  assert.equal(m.get('B'), 2500);
});

test('(p10) 連続長: 端の差がちょうど tol のすき間・重なりはどちらもつながない（tol 未満だけつなぐ）', () => {
  const gap = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 1000 + TOL, 2000)], TOL);
  assert.equal(gap.get('A'), 1000);
  const overlap = continuousBeamLengths([beam('A', false, 0, 0, 1000), beam('B', false, 0, 1000 - TOL, 2000)], TOL);
  assert.equal(overlap.get('A'), 1000);
});

test('(p4) 連続長: 断面（sectionKey）が違ってもつなぐ。途中のT字・十字の交点があっても同じ軸ならつなぐ', () => {
  const m = continuousBeamLengths([
    beam('A', false, 0, 0, 1000, { sectionKey: 'S120x120' }),
    beam('B', false, 0, 1000, 3000, { sectionKey: 'S120x270' }),
    beam('T', true, 0, 1000, 2000), // 分割点に別方向の梁が突き当たる
  ], TOL);
  assert.equal(m.get('A'), 3000);
  assert.equal(m.get('B'), 3000);
  assert.equal(m.get('T'), 1000, '別方向の梁は混ざらない');
});

test('(p5) 連続長: 向き・軸座標が違う梁は混ざらない（端が一致していても別の run）', () => {
  const m = continuousBeamLengths([
    beam('A', false, 0, 0, 1000),
    beam('B', false, 100, 1000, 2000), // 軸が違う
    beam('C', true, 0, 1000, 2000),    // 向きが違う（座標は同じ数値）
  ], TOL);
  assert.equal(m.get('A'), 1000);
  assert.equal(m.get('B'), 1000);
  assert.equal(m.get('C'), 1000);
});

test('【失敗系】(p6) 連続長: primary でない梁は数えず・つなぎの橋にもならない', () => {
  const m = continuousBeamLengths([
    beam('A', false, 0, 0, 1000),
    beam('F', false, 0, 1000, 2000, { role: 'floor' }),
    beam('B', false, 0, 2000, 3000),
  ], TOL);
  assert.equal(m.has('F'), false);
  assert.equal(m.get('A'), 1000);
  assert.equal(m.get('B'), 1000);
});

test('【失敗系】(p7) 連続長: 長さ0・座標が有限でない梁・null/空入力でも例外を投げない', () => {
  const m = continuousBeamLengths([
    beam('Z', false, 0, 500, 500),
    beam('N1', false, 0, NaN, 1000),
    beam('N2', false, undefined, 0, 1000),
    beam('N3', false, 0, 0, Infinity),
    beam('A', false, 0, 0, 500),
  ], TOL);
  assert.equal(m.get('Z'), 500, '長さ0の梁は隣とつながる（0を足すだけ）');
  assert.equal(m.get('A'), 500);
  for (const id of ['N1', 'N2', 'N3']) assert.equal(m.has(id), false, id);
  assert.equal(continuousBeamLengths(null, TOL).size, 0);
  assert.equal(continuousBeamLengths([], TOL).size, 0);
});

test('(p8) 連続長: 長い鎖（500本）でも合計になる（走査し直さない実装の正しさ）', () => {
  const beams = [];
  for (let i = 0; i < 500; i++) beams.push(beam(`B${i}`, i % 2 === 0, 0, i * 100, (i + 1) * 100));
  // 向きが交互なので、同じ向きの梁は100おきに離れる＝つながらない
  const m = continuousBeamLengths(beams, TOL);
  assert.equal(m.get('B0'), 100);
  const chain = [];
  for (let i = 0; i < 500; i++) chain.push(beam(`C${i}`, false, 0, i * 100, (i + 1) * 100));
  const c = continuousBeamLengths(chain, TOL);
  assert.equal(c.get('C0'), 50000);
  assert.equal(c.get('C499'), 50000);
});

test('(q1) 出隅: 分割された長辺（短い断片が角に来る）対 分割されていない短辺 → 長辺が勝つ（旧規則なら短辺が勝つ構成）', () => {
  const beams = [
    beam('H1', false, 0, 0, 1000, { sectionKey: 'A', halfWidth: 60 }),     // 長辺（X）の角の断片
    beam('H2', false, 0, 1000, 3000, { sectionKey: 'B', halfWidth: 60 }),  // 断面違いで分割
    beam('V', true, 0, 0, 2000, { sectionKey: 'T', halfWidth: 45 }),       // 短辺（Y）1本
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H1').ends[0].kind, 'cornerClose', '連続長3000>2000＝Xが勝者');
  assert.equal(j.get('H1').coord1, -45);
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
  assert.equal(j.get('V').coord1, 60);
});

test('(q2) 出隅: 短辺側が分割されていても、連続長が長ければ短辺側（Y）が勝つ', () => {
  const beams = [
    beam('H', false, 0, 0, 2000, { halfWidth: 60 }),
    beam('V1', true, 0, 0, 1000, { halfWidth: 45 }),
    beam('V2', true, 0, 1000, 3000, { halfWidth: 45 }),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('V1').ends[0].kind, 'cornerClose');
  assert.equal(j.get('H').ends[0].kind, 'winnerFace');
});

test('(q3) 出隅: 連続長が同じなら X 方向（従来どおり）', () => {
  const beams = [
    beam('H1', false, 0, 0, 1000), beam('H2', false, 0, 1000, 2000),
    beam('V', true, 0, 0, 2000),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H1').ends[0].kind, 'cornerClose');
  assert.equal(j.get('V').ends[0].kind, 'winnerFace');
});

test('【失敗系】(q4) 出隅: 片方の方向にしか arm が無い角は勝者なし（従来どおり）', () => {
  const beams = [
    beam('H1', false, 0, 0, 1000, { sectionKey: 'A' }),
    beam('H2', false, 0, 1000, 3000, { sectionKey: 'A' }),
  ];
  // 断面が同じ共線ペアは (1000,0) で通し（X方向）、(0,0)・(3000,0) は片方向のみで勝者なし。
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('H1').ends[0].kind, 'base');
  assert.equal(j.get('H1').ends[1].kind, 'through');
  assert.equal(j.get('H2').ends[1].kind, 'base');
});

test('(q5) 出隅: 連続長が離れた別の run（すき間あり）は合わせない＝角の梁1本ずつの長さで比べる', () => {
  const beams = [
    beam('H1', false, 0, 0, 1000),
    beam('H2', false, 0, 1500, 3500), // すき間500＝別の run（旧規則と同じ結果になる）
    beam('V', true, 0, 0, 2000),
  ];
  const j = resolveBeamJunctionSpans(THROUGH, beams);
  assert.equal(j.get('V').ends[0].kind, 'cornerClose', 'H1 は 1000 のまま＜2000');
  assert.equal(j.get('H1').ends[0].kind, 'winnerFace');
});
