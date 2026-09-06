// 壁仕上げ材の取り合い規則（wallFinishJoin.js）の単体テスト。
// ここで固定した値が「壁同士の取り合い（renderer/wallJunctionResolve.js パス2）」と
// 「壁と柱の仕上げ包みの取り合い（finish/columnWrap.js）」の**両方**の見え方になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFinVisibility, finishJoinBoundary, finishJoinInset, ENDPOINT_EPS } from './wallFinishJoin.js';

// 壁1本分のダブル（実Wallの axisValue / faceDir / materialRange / wallFinish / axisCL のみ参照）。
const mkWall = (axisCL, axisValue, wallFinish, mr) => ({
  axisValue, faceDir: Math.sign(axisValue - axisCL) || 1, wallFinish,
  materialRange: mr, axisCL: { effectiveValue: axisCL },
});

test('resolveFinVisibility: 内側線は仕上げ面から仕上げ厚ぶん軸CL側へ入った位置', () => {
  const wall = mkWall(0, 57.5, 12.5, { lo: 0, hi: 57.5 });
  assert.deepEqual(resolveFinVisibility(wall), { finBoundary: 45, finVisible: true });
  const negative = mkWall(4000, 3942.5, 12.5, { lo: 3942.5, hi: 4000 });
  assert.equal(resolveFinVisibility(negative).finBoundary, 3955, 'faceDirが負なら軸CL側＝+方向');
});

test('【失敗系】resolveFinVisibility: 仕上げ厚0・内側線が材の外へ出る壁は不可視', () => {
  assert.equal(resolveFinVisibility(mkWall(0, 57.5, 0, { lo: 0, hi: 57.5 })).finVisible, false);
  assert.equal(resolveFinVisibility(mkWall(0, 57.5, 100, { lo: 0, hi: 57.5 })).finVisible, false,
    '仕上げ厚が材幅を超えると内側線は材の外＝描かれない');
});

// ---- 2026-09 偏芯壁対応: 内側線が軸CLと重なるかは可視性に関係しない。
// `|axisOffset|===wallFinish` の薄壁（階段下部屋の外側仕上げ薄壁。偏芯壁は下地を室内側へ
// 全寄せするので、その外側の仕上げ材の内側面がちょうど軸CL上に来る）で内側線を抑止すると、
// 12.5mmの帯が1本線で描かれ、直交して取り合う壁の内側線が受け手を失って宙で終わる ----
test('resolveFinVisibility: 内側線が軸CL上に来る薄壁でも、材の中にある限り描く', () => {
  assert.equal(resolveFinVisibility(mkWall(0, 12.5, 12.5, { lo: 0, hi: 12.5 })).finVisible, true,
    '仕上げ材の帯は2本線（仕上げ面と内側線）で描かれるはず');
  assert.equal(resolveFinVisibility(mkWall(0, 12.5, 12.5, { lo: 0, hi: 12.5 })).finBoundary, 0);
  assert.equal(resolveFinVisibility(mkWall(0, 12.5 + ENDPOINT_EPS * 2, 12.5, { lo: 0, hi: 25 })).finVisible, true);
});

test('finishJoinBoundary: 取り合い先は相手の内側線の位置。描かれない壁とは取り合わない', () => {
  assert.equal(finishJoinBoundary({ finBoundary: 45, finVisible: true }), 45);
  assert.equal(finishJoinBoundary({ finBoundary: 45, finVisible: false }), null);
  assert.equal(finishJoinBoundary(null), null);
  assert.equal(finishJoinBoundary(undefined), null);
});

test('finishJoinInset: 面から相手の内側線までの見込み量（内向き正）。相手の材の中なら負', () => {
  const finLine = { finBoundary: 3955, finVisible: true };
  assert.equal(finishJoinInset(finLine, 3942.5, 1), -12.5,
    'hi側の面: 相手の内側線は面より外側（材の中）なので負＝外へ出す');
  assert.equal(finishJoinInset({ finBoundary: 45, finVisible: true }, 57.5, -1), -12.5,
    'lo側の面: 符号の向きが反転しても同じ量になるはず');
  assert.equal(finishJoinInset({ finBoundary: 57.5, finVisible: true }, 57.5, -1) === 0, true,
    '内側線が面と同じ位置なら0（nullへは落ちない。符号付きゼロは区別しない）');
  assert.equal(finishJoinInset({ finBoundary: 45, finVisible: false }, 57.5, -1), null,
    '取り合わない相手にはnull（呼び出し側が自前の寸法で納める）');
});
