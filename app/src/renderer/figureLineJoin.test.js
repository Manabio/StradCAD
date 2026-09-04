// figureLineJoin.js（展開図Konvaレンダラの「L字の角の外角を閉じる」案2・第1弾）の回帰テスト。
// canvasのlineCapはbutt（未指定）のまま、直交・斜めに取り合う2本の線の端点が
// モデルmmで厳密一致する角だけを、px空間で角の外側へ延長して閉じる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJoinedLinePoints, weightPx, linePointsPx } from './figureLineJoin.js';

// 恒等変換（mm=px。角の外向きベクトル・延長量の検証を単純にするため）。
const idT = { tx: x => x, ty: y => y };

// 仕様の閉形式をテスト側で独立に再計算する（実装のコピーではなく「式に一致」の検証）。
function expectedExtend(uA, uB, wA, wB) {
  const cos = uA.x * uB.x + uA.y * uB.y;
  const sin = Math.abs(uA.x * uB.y - uA.y * uB.x);
  const cot = cos / sin;
  const clamp = 2 * Math.max(wA, wB);
  const dA = Math.max(0, Math.min((wB / 2) / sin + (wA / 2) * cot, clamp));
  const dB = Math.max(0, Math.min((wA / 2) / sin + (wB / 2) * cot, clamp));
  return { dA, dB };
}

// 角(0,0)で取り合う2本の線分。他端は角から-u*L、corner側はx2,y2=(0,0)に置く
// （resolveJoinedLinePointsは延長した角側の座標だけを差分Mapへ載せる）。
function cornerLine(u, w, L = 100) {
  return { type: 'line', x1: -u.x * L, y1: -u.y * L, x2: 0, y2: 0, width: w };
}

test('weightPx: weight名→lineWeightsPx優先、無ければp.width、それも無ければ既定1', () => {
  assert.equal(weightPx({ weight: 'thick' }, { thick: 5 }), 5);
  assert.equal(weightPx({ width: 2.5 }, {}), 2.5);
  assert.equal(weightPx({}, undefined), 1);
});

test('直交・同太さ（3px×3px）: 各線が相手半幅1.5pxちょうど角の外側へ延びる（向きも一致）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },   // 床線: 他端(0,0)→角(100,0)
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 }, // 縦線: 角(100,0)→他端(100,100)
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  assert.equal(joined.size, 2);

  const [ax1, ay1, ax2, ay2] = joined.get(0);
  assert.equal(ax1, 0); assert.equal(ay1, 0); // 他端は不変
  assert.ok(Math.abs(ax2 - 101.5) < 1e-9, `期待101.5, 実際${ax2}`); // +x方向へ1.5px
  assert.equal(ay2, 0);

  const [bx1, by1, bx2, by2] = joined.get(1);
  assert.ok(Math.abs(bx1 - 100) < 1e-9);
  assert.ok(Math.abs(by1 - -1.5) < 1e-9, `期待-1.5, 実際${by1}`); // -y方向へ1.5px
  assert.equal(bx2, 100); assert.equal(by2, 100); // 他端は不変
});

test('直交・異太さ（3px床線×2px縦線）: 3px側1.0px／2px側1.5px延びる（逆でないこと）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 2 },
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  const [, , ax2] = joined.get(0);
  assert.ok(Math.abs(ax2 - 101.0) < 1e-9, `3px側は相手半幅1.0px、実際${ax2 - 100}`);
  const [, by1] = joined.get(1);
  assert.ok(Math.abs(by1 - -1.5) < 1e-9, `2px側は相手半幅1.5px、実際${-by1}`);
});

test('斜め（45°/135°）: 式に一致し、鈍角は直交より短く鋭角は長い。鋭角クランプが効く', () => {
  const uA = { x: 1, y: 0 };
  const w = 4;
  const orthoD = expectedExtend(uA, { x: 0, y: 1 }, w, w).dA; // 90°

  // 45°（鋭角）: 直交より長い
  const rad45 = Math.PI / 4;
  const uB45 = { x: Math.cos(rad45), y: Math.sin(rad45) };
  const exp45 = expectedExtend(uA, uB45, w, w);
  const joined45 = resolveJoinedLinePoints([cornerLine(uA, w), cornerLine(uB45, w)], idT);
  const [, , a45x, a45y] = joined45.get(0);
  assert.ok(Math.abs(a45x - uA.x * exp45.dA) < 1e-9);
  assert.ok(Math.abs(a45y - uA.y * exp45.dA) < 1e-9);
  assert.ok(exp45.dA > orthoD, '45°(鋭角)の延長は直交より長いはず');

  // 135°（鈍角）: 直交より短い
  const rad135 = (3 * Math.PI) / 4;
  const uB135 = { x: Math.cos(rad135), y: Math.sin(rad135) };
  const exp135 = expectedExtend(uA, uB135, w, w);
  const joined135 = resolveJoinedLinePoints([cornerLine(uA, w), cornerLine(uB135, w)], idT);
  const [, , a135x, a135y] = joined135.get(0);
  assert.ok(Math.abs(a135x - uA.x * exp135.dA) < 1e-9);
  assert.ok(Math.abs(a135y - uA.y * exp135.dA) < 1e-9);
  assert.ok(exp135.dA < orthoD, '135°(鈍角)の延長は直交より短いはず');

  // 5°（鋭角の極端）: クランプ(2*max(wA,wB))が効いて発散しない
  const rad5 = (5 * Math.PI) / 180;
  const uB5 = { x: Math.cos(rad5), y: Math.sin(rad5) };
  const joined5 = resolveJoinedLinePoints([cornerLine(uA, w), cornerLine(uB5, w)], idT);
  const [, , a5x, a5y] = joined5.get(0);
  const dist5 = Math.hypot(a5x, a5y);
  assert.ok(Math.abs(dist5 - 2 * w) < 1e-9, `クランプ${2 * w}pxで頭打ちのはず、実際${dist5}`);
});

test('T字（端点が相手の内部にある）: 差分マップは空', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, width: 3 },      // B: 長い水平線
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: -100, width: 3 }, // A: Bの内部(100,0)から生えるT字
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  assert.equal(joined.size, 0);
});

test('破線が絡む角: 破線側は対象外のため延長しない', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3, dash: 'dashed' },
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  assert.equal(joined.size, 0);
});

test('3本以上の端点が集まる点: 何もしない', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 200, y2: 0, width: 3 },
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  assert.equal(joined.size, 0);
});

test('同一直線上の角: 何もしない（NaN/Infinityにならない）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 200, y2: 0, width: 3 },
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  assert.equal(joined.size, 0);
});

test('長さ0の線分が絡む角: 何もしない（例外なし）', () => {
  const primitives = [
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 0, width: 3 }, // 長さ0
    { type: 'line', x1: 100, y1: 0, x2: 200, y2: 0, width: 3 },
  ];
  assert.doesNotThrow(() => resolveJoinedLinePoints(primitives, idT));
  assert.equal(resolveJoinedLinePoints(primitives, idT).size, 0);
});

test('細線同士（1px×1px）は延長しない。片方だけ細線なら両方延長する', () => {
  const bothThin = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 1 },
  ];
  assert.equal(resolveJoinedLinePoints(bothThin, idT).size, 0);

  const oneThin = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 1 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 },
  ];
  const joined = resolveJoinedLinePoints(oneThin, idT);
  assert.equal(joined.size, 2);
  const [, , ax2] = joined.get(0);
  assert.ok(Math.abs(ax2 - 101.5) < 1e-9); // dA=相手半幅3/2=1.5
  const [, by1] = joined.get(1);
  assert.ok(Math.abs(by1 - -0.5) < 1e-9); // dB=相手半幅1/2=0.5
});

test('lineWeightsPxを渡さなくても例外なし（p.width??1フォールバック）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0 },        // widthなし→1(細線)
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100 },
  ];
  assert.doesNotThrow(() => resolveJoinedLinePoints(primitives, idT));
  const joined = resolveJoinedLinePoints(primitives, idT, undefined);
  assert.ok(joined instanceof Map);
  assert.equal(joined.size, 0); // 両方1px＝細線同士なので延長なし
});

test('y反転の変換でも角の外側へ延びる', () => {
  const invT = { tx: x => x, ty: y => -y };
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 },
  ];
  const joined = resolveJoinedLinePoints(primitives, invT);
  const [, by1] = joined.get(1);
  // 反転前は-y方向(-1.5)へ延びたが、y反転変換後は角の外側=+y方向(+1.5)になるはず。
  assert.ok(by1 > 0, `y反転後は+y方向へ延びるはず（実際${by1}）`);
  assert.ok(Math.abs(by1 - 1.5) < 1e-9);
});

// ---- qa-reviewer FAIL対応: linePointsPx（本番のフォールバック判断そのもの）の直接テスト ----

test('linePointsPx: 差分マップに載る線はマップ値、載らない線は素のmm→px変換を返す', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },
    { type: 'line', x1: 5, y1: 5, x2: 20, y2: 30, width: 1 }, // マップに載らない線
  ];
  const joined = new Map([[0, [0, 0, 101.5, 0]]]);
  assert.deepEqual(linePointsPx(primitives[0], 0, idT, joined), [0, 0, 101.5, 0]);
  assert.deepEqual(linePointsPx(primitives[1], 1, idT, joined), [5, 5, 20, 30]);
});

test('同一幾何の重複プリミティブ（weight違い・逆向き）が絡む角: 何もしない', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },   // A: 床線
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 }, // B: 縦線
    { type: 'line', x1: 100, y1: 0, x2: 0, y2: 0, width: 5 },   // Aの重複（逆向き・別weight）
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  // (100,0)はA・B・重複の3本が集まる点＝対象外。(0,0)はA・重複の2本だが同一直線上（逆向きの
  // 同じ線）のため対象外。結果として差分は生じない。
  assert.equal(joined.size, 0);
});

test('θ≈179°で太さが違う角: 延長量は2*max(wA,wB)以内かつ延長先が相手線の帯幅内', () => {
  const uA = { x: 1, y: 0 };
  const rad179 = (179 * Math.PI) / 180;
  const uB = { x: Math.cos(rad179), y: Math.sin(rad179) };
  const wA = 2, wB = 6;
  const clampMax = 2 * Math.max(wA, wB);

  const joined = resolveJoinedLinePoints([cornerLine(uA, wA), cornerLine(uB, wB)], idT);
  const [, , ax, ay] = joined.get(0);
  const [, , bx, by] = joined.get(1);

  const distFromCorner = (x, y) => Math.hypot(x, y);
  assert.ok(distFromCorner(ax, ay) <= clampMax + 1e-9, `A延長量がクランプ超過: ${distFromCorner(ax, ay)}`);
  assert.ok(distFromCorner(bx, by) <= clampMax + 1e-9, `B延長量がクランプ超過: ${distFromCorner(bx, by)}`);

  // 角(0,0)を通る相手線の無限直線からの垂線距離が、相手線の半幅以内（帯からはみ出さない）。
  const perpDistFromOrigin = (u, x, y) => Math.abs(u.x * y - u.y * x);
  assert.ok(perpDistFromOrigin(uB, ax, ay) <= wB / 2 + 1e-9, 'A延長先がB線の帯幅内にあるはず');
  assert.ok(perpDistFromOrigin(uA, bx, by) <= wA / 2 + 1e-9, 'B延長先がA線の帯幅内にあるはず');
});

test('実機のweight名経路（lineWeightsPx）: thick床線×medium縦線でもwidth経路と同じ式で延びる', () => {
  const lineWeightsPx = { thin: 1, medium: 2, thick: 3 };
  const primitives = [
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, weight: 'thick' },
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, weight: 'medium' },
  ];
  const joined = resolveJoinedLinePoints(primitives, idT, lineWeightsPx);
  const [, , ax2] = joined.get(0);
  assert.ok(Math.abs(ax2 - 101.0) < 1e-9, `thick側は相手(medium)半幅1.0px、実際${ax2 - 100}`);
  const [, by1] = joined.get(1);
  assert.ok(Math.abs(by1 - -1.5) < 1e-9, `medium側は相手(thick)半幅1.5px、実際${-by1}`);
});

test('コの字（3本thick）: 中央の水平線が両端とも延長される（ov集約分岐を通す）', () => {
  const primitives = [
    { type: 'line', x1: 0, y1: 100, x2: 0, y2: 0, width: 3 },     // 左の縦線
    { type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, width: 3 },     // 中央の水平線
    { type: 'line', x1: 100, y1: 0, x2: 100, y2: 100, width: 3 }, // 右の縦線
  ];
  const joined = resolveJoinedLinePoints(primitives, idT);
  const middle = joined.get(1);
  assert.ok(middle, '中央線は両端とも上書きされているはず');
  const [mx1, my1, mx2, my2] = middle;
  assert.ok(Math.abs(mx1 - -1.5) < 1e-9, `左端は-x方向へ1.5px、実際${mx1}`);
  assert.equal(my1, 0);
  assert.ok(Math.abs(mx2 - 101.5) < 1e-9, `右端は+x方向へ1.5px、実際${mx2}`);
  assert.equal(my2, 0);
});
