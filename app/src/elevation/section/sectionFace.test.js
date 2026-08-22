// sectionFace.js（WP-E2: faceFromCut）の単体テスト。手書きの小さなwallFaces/primaryWall
// リテラルで、lo/hi正規化（travelSign<0でもrun>0）・startCLId/endCLIdを直接検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faceFromCut } from './sectionFace.js';

function makeCut(overrides = {}) {
  return {
    seqNo: '1', line: { isVertical: false, axisValue: 1000, lo: 0, hi: 3000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0, ...overrides,
  };
}

// perpFaceAt(wallFaces, targetIsVertical, targetAxisValue, pos) が拾える最小限の直交面フィクスチャ。
function perpFace(id, effectiveValue, faceValue, isVertical = true, lo = 900, hi = 1100) {
  return { kind: undefined, isVertical, lo, hi, axisCL: { id, effectiveValue }, faceValue, hasRealWall: true };
}

test('【WP-E2】faceFromCut: dirSign>0・通常順（rawLo<rawHi）ではrun>0・startCLId/endCLIdがそのまま対応する', () => {
  const cut = makeCut({ dirSign: 1 });
  const wallFaces = [
    perpFace('clLo', 50, 50),     // line.lo=0付近
    perpFace('clHi', 2950, 2950), // line.hi=3000付近
  ];
  const face = faceFromCut(cut, wallFaces, null);
  assert.equal(face.lo, 50);
  assert.equal(face.hi, 2950);
  assert.equal(face.run, 2900);
  assert.ok(face.run > 0, 'runは正のはず');
  assert.equal(face.startCLId, 'clLo', '非swap時はstartCLId=line.lo側のCLのはず');
  assert.equal(face.endCLId, 'clHi');
});

test('【WP-E2・travelSign<0】faceFromCut: perpFaceAtの結果が入れ替わって返る（rawLo>rawHi）場合でもMath.min/maxで正規化しrun>0になる', () => {
  const cut = makeCut({ dirSign: -1 });
  // line.lo(=0)側で見つかる面のfaceValueが大きく(2950)、line.hi(=3000)側で見つかる面のfaceValueが
  // 小さい(50)——buildMidWallFaceの旧バグと同型の「入れ替わって返る」状況を手書きで再現する。
  const wallFaces = [
    // lo/hi(900..1100)はいずれもcut.axisValue(1000)を含むスパン（perpFaceAtの到達判定に必要）。
    // axisCL.effectiveValueだけがpos(line.lo/line.hi)に近い値になるよう調整する。
    perpFace('clNearLo', 50, 2950),   // pos=line.lo=0に近い(dist=50)がfaceValueは2950
    perpFace('clNearHi', 2950, 50),   // pos=line.hi=3000に近い(dist=50)がfaceValueは50
  ];
  const face = faceFromCut(cut, wallFaces, null);
  assert.equal(face.lo, 50, 'Math.minで正規化されlo=50のはず');
  assert.equal(face.hi, 2950, 'Math.maxで正規化されhi=2950のはず');
  assert.ok(face.run > 0, `travelSign<0でもrunは正のはず（実際:${face.run}）`);
  assert.equal(face.run, 2900);
  // 入れ替わりに合わせてCLIdも入れ替えて引き継ぐ（elevation-model.md「修正済み」節と同じ規約）。
  assert.equal(face.startCLId, 'clNearHi', '入れ替え時はstartCLId=（世界lo=50を持つ）clNearHiのはず');
  assert.equal(face.endCLId, 'clNearLo');
});

test('【WP-E2】faceFromCut: primaryWall指定時はそのaxisCL/axisValueをそのまま使う', () => {
  const cut = makeCut();
  const primaryWall = { axisCL: { id: 'wallAxis', effectiveValue: 1000 }, axisValue: 1005, axisOffset: 5 };
  const face = faceFromCut(cut, [], primaryWall);
  assert.equal(face.axisCL.id, 'wallAxis');
  assert.equal(face.faceValue, 1005);
  assert.equal(face.hasRealWall, true);
});

// ---- 失敗系 ----

test('【失敗系・WP-E2】faceFromCut: primaryWallなし・wallFaces空でも例外を投げずCL芯へフォールバックする', () => {
  const cut = makeCut();
  const face = faceFromCut(cut, [], null);
  assert.equal(face.hasRealWall, false);
  assert.equal(face.faceValue, cut.line.axisValue);
  assert.equal(face.lo, 0);
  assert.equal(face.hi, 3000);
  assert.equal(face.run, 3000);
  assert.equal(face.startCLId, null);
  assert.equal(face.endCLId, null);
  assert.equal(face.axisCL.id, null, 'wallFacesが空なら合成axisCL(id:null)へフォールバックするはず');
});

test('【失敗系・WP-E2】faceFromCut: primaryWallなしでもwallFacesに同じisVertical系統の面があればCLに吸着する', () => {
  const cut = makeCut(); // cut.line.isVertical=false
  const wallFaces = [
    // isVertical違い（cut.lineと直交＝別系統のため無視されるはず）
    { isVertical: true, lo: 0, hi: 3000, axisCL: { id: 'wrong', effectiveValue: 1000 }, faceValue: 1000 },
    // isVertical一致（cut.line.isVertical=falseと同じ）・axisValueに最も近い
    { isVertical: false, lo: 0, hi: 3000, axisCL: { id: 'nearest', effectiveValue: 1010 }, faceValue: 1010 },
    { isVertical: false, lo: 0, hi: 3000, axisCL: { id: 'farther', effectiveValue: 1500 }, faceValue: 1500 },
  ];
  const face = faceFromCut(cut, wallFaces, null);
  assert.equal(face.axisCL.id, 'nearest', 'line.axisValue(1000)に最も近いCLへフォールバックするはず');
});
