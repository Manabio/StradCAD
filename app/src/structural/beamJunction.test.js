// beamJunction.js（在来木造の梁の交点処理・B-3・2026-09-17裁定「通しが勝つ」）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBeamJunctionSpans } from './beamJunction.js';

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
