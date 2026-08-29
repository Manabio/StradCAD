// beyondBreakClip.js（破れ線先のクリップ・可視判定）の単体テスト。
// store.js / snap.js / .jsx に依存しない純モジュールであること（node:test から直接 import できること）も
// 兼ねて確認する（.claude/implementation-policy.md の抽出純モジュール規約）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segIntersect, findBreakCrossing, breakChordOf,
  clipSegmentsBeyondBreak, reversePointPairs, trimBreakOverhang,
  clipPolylineStartAtBreak, clipPolylineEndAtBreak,
} from './beyondBreakClip.js';

// 破れ線: y=1000 の水平線（1本のジョグなし線分）。先側は y>1000（下側）とする。
const BREAK = [{ x1: 0, y1: 1000, x2: 2000, y2: 1000 }];
// 破れ先セル（y=1000〜3000 の帯）
const BEYOND = [{ x1: 0, y1: 1000, x2: 2000, y2: 3000 }];

test('segIntersect: 交差する線分の交点とパラメータを返す', () => {
  const ip = segIntersect(0, 0, 0, 100, -50, 40, 50, 40);
  assert.ok(ip);
  assert.equal(Math.round(ip.x), 0);
  assert.equal(Math.round(ip.y), 40);
  assert.ok(Math.abs(ip.t - 0.4) < 1e-9);
});

test('segIntersect: 区間外・平行は null', () => {
  assert.equal(segIntersect(0, 0, 0, 100, -50, 400, 50, 400), null); // 区間外
  assert.equal(segIntersect(0, 0, 100, 0, 0, 50, 100, 50), null);    // 平行
});

test('findBreakCrossing: 破れ線と交差しない線分は null', () => {
  assert.equal(findBreakCrossing({ x1: 0, y1: 1500, x2: 2000, y2: 1500 }, BREAK), null);
  assert.equal(findBreakCrossing({ x1: 0, y1: 900, x2: 0, y2: 1100 }, []), null);
});

test('breakChordOf: 先側の符号は破れ先セル群の重心で決まる', () => {
  const chord = breakChordOf(BREAK, BEYOND);
  assert.ok(chord);
  assert.equal(chord.side(100, 2000), chord.beyondSign);   // 先側
  assert.equal(chord.side(100, 500), -chord.beyondSign);   // 手前側
  assert.equal(breakChordOf(BREAK, []), null);
  assert.equal(breakChordOf([], BEYOND), null);
});

test('clipSegmentsBeyondBreak: 破れ線を跨ぐ線分は交点で切って先側だけ残す', () => {
  // 手前(y=500)→先(y=1500) の縦線。y=1000 で切られ、先側 [1000,1500] が残る。
  const out = clipSegmentsBeyondBreak([{ x1: 500, y1: 500, x2: 500, y2: 1500 }], BREAK, BEYOND);
  assert.equal(out.length, 1);
  assert.equal(Math.round(out[0].y1), 1000);
  assert.equal(Math.round(out[0].y2), 1500);
});

test('clipSegmentsBeyondBreak: 端点の順序が逆でも先側だけ残す', () => {
  const out = clipSegmentsBeyondBreak([{ x1: 500, y1: 1500, x2: 500, y2: 500 }], BREAK, BEYOND);
  assert.equal(out.length, 1);
  assert.equal(Math.round(out[0].y1), 1500);
  assert.equal(Math.round(out[0].y2), 1000);
});

test('clipSegmentsBeyondBreak: 跨がない線分は中点判定で採否が決まる', () => {
  const segs = [
    { x1: 0, y1: 1500, x2: 2000, y2: 1500, tag: 'beyond' }, // 先側 → 残る
    { x1: 0, y1: 500, x2: 2000, y2: 500, tag: 'near' },     // 手前 → 消える
  ];
  const out = clipSegmentsBeyondBreak(segs, BREAK, BEYOND);
  assert.deepEqual(out.map(s => s.tag), ['beyond']);
});

test('clipSegmentsBeyondBreak: 付随プロパティ（thin/side/port 等）を保持する', () => {
  const out = clipSegmentsBeyondBreak(
    [{ x1: 500, y1: 500, x2: 500, y2: 1500, side: true, medium: true }], BREAK, BEYOND,
  );
  assert.equal(out[0].side, true);
  assert.equal(out[0].medium, true);
});

test('clipSegmentsBeyondBreak: 破れ先セルが空なら安全側でフィルタしない', () => {
  const segs = [{ x1: 0, y1: 500, x2: 2000, y2: 500 }];
  assert.equal(clipSegmentsBeyondBreak(segs, BREAK, []).length, 1);
  assert.equal(clipSegmentsBeyondBreak(segs, BREAK, undefined).length, 1);
});

test('reversePointPairs: (x,y) ペア単位で逆順にする', () => {
  assert.deepEqual(reversePointPairs([1, 2, 3, 4, 5, 6]), [5, 6, 3, 4, 1, 2]);
});

test('clipPolylineEndAtBreak: 始点〜最初の交点を残す', () => {
  const pts = clipPolylineEndAtBreak([500, 1500, 500, 500], BREAK);
  assert.deepEqual(pts.map(Math.round), [500, 1500, 500, 1000]);
});

test('clipPolylineStartAtBreak: 最初の交点〜終点を残す', () => {
  const pts = clipPolylineStartAtBreak([500, 500, 500, 1500], BREAK);
  assert.deepEqual(pts.map(Math.round), [500, 1000, 500, 1500]);
});

test('clipPolyline*: 交点が無ければ null（呼び出し側は安全側でフル描画）', () => {
  assert.equal(clipPolylineEndAtBreak([500, 1200, 500, 1500], BREAK), null);
  assert.equal(clipPolylineStartAtBreak([500, 1200, 500, 1500], []), null);
});

test("clipSegmentsBeyondBreak keep:'near': 交差する線分は手前側だけ残す（先側の補集合）", () => {
  const out = clipSegmentsBeyondBreak(
    [{ x1: 500, y1: 500, x2: 500, y2: 1500 }], BREAK, BEYOND, { keep: 'near' },
  );
  assert.equal(out.length, 1);
  assert.equal(Math.round(out[0].y1), 500);
  assert.equal(Math.round(out[0].y2), 1000);
});

test("clipSegmentsBeyondBreak keep:'near': 跨がない線分は中点が先側なら落ちる", () => {
  const segs = [
    { x1: 0, y1: 1500, x2: 2000, y2: 1500, tag: 'beyond' },
    { x1: 0, y1: 500, x2: 2000, y2: 500, tag: 'near' },
  ];
  const out = clipSegmentsBeyondBreak(segs, BREAK, BEYOND, { keep: 'near' });
  assert.deepEqual(out.map(s => s.tag), ['near']);
});

test("clipSegmentsBeyondBreak: beyond と near は同じ線分集合を過不足なく二分する", () => {
  const segs = [
    { x1: 500, y1: 500, x2: 500, y2: 1500 }, // 跨ぐ → 両方に分かれる
    { x1: 0, y1: 1500, x2: 2000, y2: 1500 }, // 先側のみ
    { x1: 0, y1: 500, x2: 2000, y2: 500 },   // 手前のみ
  ];
  const beyond = clipSegmentsBeyondBreak(segs, BREAK, BEYOND);
  const near = clipSegmentsBeyondBreak(segs, BREAK, BEYOND, { keep: 'near' });
  assert.equal(beyond.length, 2);
  assert.equal(near.length, 2);
});

test('trimBreakOverhang: 両端の線分をはり出しぶん内側へ詰める（見た目のはり出しをクリップに効かせない）', () => {
  const segs = [
    { x1: 0, y1: 0, x2: 100, y2: 0 },   // 端（はり出しを含む）
    { x1: 100, y1: 0, x2: 200, y2: 0 }, // 中間（ジョグ相当。手を付けない）
    { x1: 200, y1: 0, x2: 300, y2: 0 }, // 端（はり出しを含む）
  ];
  const out = trimBreakOverhang(segs, 30);
  assert.equal(out[0].x1, 30);   // 始点側が30内側へ
  assert.equal(out[0].x2, 100);
  assert.deepEqual(out[1], segs[1]); // 中間は不変
  assert.equal(out[2].x2, 270);  // 終点側が30内側へ
});

test('trimBreakOverhang: はり出し0・空・null はそのまま返す', () => {
  assert.deepEqual(trimBreakOverhang(BREAK, 0), BREAK);
  assert.equal(trimBreakOverhang(null, 30), null);
  assert.deepEqual(trimBreakOverhang([], 30), []);
});

test('trimBreakOverhang: はり出しより短い端の線分は丸ごと落とす', () => {
  const segs = [
    { x1: 0, y1: 0, x2: 10, y2: 0 },    // 長さ10 < はり出し30
    { x1: 10, y1: 0, x2: 200, y2: 0 },
  ];
  const out = trimBreakOverhang(segs, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].x1, 10);
  assert.equal(out[0].x2, 170);
});

test('trimBreakOverhang: 詰めた破れ線は通り芯の先にある線分をもう切らない', () => {
  // 破れ線 y=1000 が x=0..2000 で、はり出し100を含む（実端点は x=100..1900）。
  const withOverhang = [{ x1: 0, y1: 1000, x2: 2000, y2: 1000 }];
  const target = [{ x1: 50, y1: 400, x2: 50, y2: 1400 }]; // x=50＝実端点より外側の線（中点は破れ手前）
  const bounds = [{ x1: 0, y1: 1000, x2: 2000, y2: 3000 }];
  // はり出し込みだと交差して切られてしまう
  assert.equal(clipSegmentsBeyondBreak(target, withOverhang, bounds, { keep: 'near' })[0].y2, 1000);
  // 詰めれば交差せず、中点判定（手前）で全長が残る
  const trimmed = trimBreakOverhang(withOverhang, 100);
  const near = clipSegmentsBeyondBreak(target, trimmed, bounds, { keep: 'near' });
  assert.equal(near.length, 1);
  assert.equal(near[0].y1, 400);
  assert.equal(near[0].y2, 1400);
});
