/**
 * 下屋の屋根面（「水下だけが内側へ進み、壁・けらばは動かない」定義）の独立の参照実装と、出力の不変条件の検査（テスト専用）。
 * 製品（roofFramingGeometry.js の drainArrivalTime など）の閉じた式とは別の手続きで、格子の上を前線が1歩ずつ進む様子を
 * そのまま真似る。製品から import しない（テストのヘルパー）。roofFramingGeometry.js も import しない（独立性のため）。
 *
 * 参照実装（drainReference）: 格子幅 g のセルで、水下ごとに前線を内側へ1歩ずつ進める。前線は水下の延長（lo..hi）の列から
 * 始まり、(1) 進んだ先のセルが屋根範囲の外なら、その列はそこで止まる（屋根の中だけを通って直角に流れる）、
 * (2) 水下の端が谷（入隅で、その先の辺も水下）なら、毎歩1列ずつ前線が端の外へ伸びる（45°の広がり）、
 * それ以外の端（出隅・壁やけらばに接する端・辺の途中）は伸びない。各セルが最初に前線に来た時刻 T（＝セルの中心から水下までの
 * 距離）と来た水下 owner を求める。前線に一度も来ないセルは T=Infinity（届かない点）。
 * 隣り合うセルの T の差が 4g を超える所（崖）か届かないセルがあれば valid=false。
 *
 * 座標は mm・y 下向き正。水下は {isVertical, coord, lo, hi, outward}（roofFramingGeometry.js の水下と同じ形）。
 */

const EPS = 1e-6;

/**
 * 水下の端が谷（入隅で、その先の辺も水下）か。参照実装の定義: 端の先の屋内側・水下の外側のどちらの点も屋根範囲の中
 * （＝端は屋根範囲の入隅）で、かつ端の点を端に持つ直交する水下が、水下の側（水下の長さの側）へ外向きに向いている。
 */
function valleyEnds(d, drains, pointInR, tolMm) {
  const n = -d.outward; // 内側の向き（across 方向）
  const at = (a, t) => (d.isVertical ? [t, a] : [a, t]); // (along, across) → (x, y)
  const out = {};
  for (const end of ['lo', 'hi']) {
    const a = d[end];
    const beyond = end === 'hi' ? a + 1 : a - 1; // 端の先（along）
    const inside = pointInR(...at(beyond, d.coord + n));
    const outside = pointInR(...at(beyond, d.coord - n));
    const towardDrain = end === 'hi' ? -1 : 1; // 端から水下の中へ向かう along の向き
    const partner = drains.some(e => e !== d
      && e.isVertical !== d.isVertical
      && Math.abs(e.coord - a) <= tolMm
      // 相手の水下は端の点（d.coord）を端に持ち、d の外側へ伸びる
      && (d.outward > 0 ? Math.abs(e.lo - d.coord) <= tolMm : Math.abs(e.hi - d.coord) <= tolMm)
      && e.outward === towardDrain);
    out[end] = inside && outside && partner;
  }
  return out;
}

/**
 * 参照実装（前線の行進）。
 * @param {object} p
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} p.rects 屋根範囲のセル矩形
 * @param {Array<{isVertical:boolean,coord:number,lo:number,hi:number,outward:1|-1}>} p.drains 水下（まとめ済み）
 * @param {number} p.gMm 格子幅（小さい形用。例 5〜45.5）
 * @param {number} [p.tolMm] 座標の一致の許容差
 */
export function drainReference({ rects, drains, gMm, tolMm = 0.5 }) {
  const g = gMm;
  const x0 = Math.min(...rects.map(r => r.x1));
  const xN = Math.max(...rects.map(r => r.x2));
  const y0 = Math.min(...rects.map(r => r.y1));
  const yN = Math.max(...rects.map(r => r.y2));
  const nx = Math.max(1, Math.ceil((xN - x0) / g - 1e-9));
  const ny = Math.max(1, Math.ceil((yN - y0) / g - 1e-9));
  const pointInR = (x, y) => rects.some(r => r.x1 < x && x < r.x2 && r.y1 < y && y < r.y2);
  // セルの中心は、格子の座標と偶然一致して「屋根範囲の内側」の判定が外れないよう、わずかにずらす
  const cx = i => x0 + (i + 0.5) * g + 0.3719;
  const cy = j => y0 + (j + 0.5) * g + 0.2917;
  const inR = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) inR[j * nx + i] = pointInR(cx(i), cy(j)) ? 1 : 0;
  const T = new Float64Array(nx * ny).fill(Infinity);
  const owner = new Int16Array(nx * ny).fill(-1);

  drains.forEach((d, k) => {
    const n = -d.outward;
    const nAlong = d.isVertical ? ny : nx;
    const nAcross = d.isVertical ? nx : ny;
    const alongCenter = a => (d.isVertical ? cy(a) : cx(a));
    const acrossCenter = t => (d.isVertical ? cx(t) : cy(t));
    const cellIndex = (a, t) => (d.isVertical ? a * nx + t : t * nx + a);
    let cl0 = 0;
    while (cl0 < nAlong && alongCenter(cl0) <= d.lo) cl0++;
    let ch0 = nAlong - 1;
    while (ch0 >= 0 && alongCenter(ch0) >= d.hi) ch0--;
    let t = 0;
    if (n > 0) { while (t < nAcross && acrossCenter(t) <= d.coord) t++; } else { t = nAcross - 1; while (t >= 0 && acrossCenter(t) >= d.coord) t--; }
    const valley = valleyEnds(d, drains, pointInR, tolMm);
    let active = new Uint8Array(nAlong);
    let loAlive = valley.lo;
    let hiAlive = valley.hi;
    for (let s = 0; t >= 0 && t < nAcross; t += n, s++) {
      const next = new Uint8Array(nAlong);
      if (s === 0) {
        for (let a = Math.max(0, cl0); a <= Math.min(nAlong - 1, ch0); a++) if (inR[cellIndex(a, t)]) next[a] = 1;
      } else {
        for (let a = 0; a < nAlong; a++) if (active[a] && inR[cellIndex(a, t)]) next[a] = 1;
      }
      // 谷の端: 毎歩1列、端の外へ前線が伸びる（端からの距離 δ＝歩数 u の列＝45°）
      if (loAlive) {
        const a = cl0 - 1 - s;
        if (a >= 0 && inR[cellIndex(a, t)]) next[a] = 1; else loAlive = false;
      }
      if (hiAlive) {
        const a = ch0 + 1 + s;
        if (a < nAlong && inR[cellIndex(a, t)]) next[a] = 1; else hiAlive = false;
      }
      active = next;
      const u = Math.abs(acrossCenter(t) - d.coord);
      for (let a = 0; a < nAlong; a++) {
        if (!active[a]) continue;
        const idx = cellIndex(a, t);
        if (u < T[idx] - EPS) { T[idx] = u; owner[idx] = k; }
      }
    }
  });

  // 崖（隣り合うセルの T の差）と届かないセル
  let maxJump = 0;
  let unreached = 0;
  const jumps = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!inR[idx]) continue;
      if (!Number.isFinite(T[idx])) { unreached++; continue; }
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii >= nx || jj >= ny) continue;
        const idx2 = jj * nx + ii;
        if (!inR[idx2] || !Number.isFinite(T[idx2])) continue;
        const jump = Math.abs(T[idx] - T[idx2]);
        if (jump > maxJump) maxJump = jump;
        if (jump > 4 * g) jumps.push({ x: (cx(i) + cx(ii)) / 2, y: (cy(j) + cy(jj)) / 2, jump });
      }
    }
  }
  const cell = (x, y) => {
    const i = Math.floor((x - x0) / g);
    const j = Math.floor((y - y0) / g);
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : j * nx + i;
  };
  return {
    g, x0, y0, nx, ny, T, owner, inR, maxJump, unreached, jumps, cx, cy,
    valid: unreached === 0 && jumps.length === 0,
    /** 点 (x,y) の T（屋根範囲の外は NaN・届かない点は Infinity）。 */
    tAt: (x, y) => { const c = cell(x, y); return c < 0 || !inR[c] ? NaN : T[c]; },
    /** 点 (x,y) の水下の番号（屋根範囲の外・届かない点は -1）。 */
    ownerAt: (x, y) => { const c = cell(x, y); return c < 0 || !inR[c] ? -1 : owner[c]; },
    inRAt: (x, y) => { const c = cell(x, y); return c >= 0 && inR[c] === 1; },
  };
}

/**
 * 不変条件 (a)「壁へ下らない」。壁の辺（{isVertical, coord, lo, hi, outward}）の各点から内向きに屋根範囲の中を進む列で、
 * 壁から離れるほど T が大きくなる（＝壁へ向かって下がる）所があれば違反。tAt(x,y)（屋根範囲の外は NaN）を渡す。
 * 列の点は壁から離れる順に tolMm を超えて「それまでの最小の T より大きい」とき違反。
 * @returns {{violations: string[], chains: number}} chains＝検査した列の数（0 のときは空振り）
 */
export function wallDescentViolations({ walls, tAt, stepMm, depthsMm, tolMm }) {
  const violations = [];
  let chains = 0;
  for (const w of walls) {
    const n = -w.outward;
    const alongs = [];
    for (let a = w.lo + stepMm / 2; a < w.hi; a += stepMm) alongs.push(a);
    for (const a of alongs) {
      let minT = Infinity;
      let seen = 0;
      for (const u of depthsMm) {
        const [x, y] = w.isVertical ? [w.coord + n * u, a] : [a, w.coord + n * u];
        const t = tAt(x, y);
        if (Number.isNaN(t)) break; // 屋根範囲の外（凹み）に出たらそこで列を終える
        seen++;
        if (t > minT + tolMm) {
          violations.push(`壁 ${w.isVertical ? 'x' : 'y'}=${w.coord} (${w.lo}..${w.hi}) 沿い ${a}・壁から ${u}: T=${t} が手前の最小 ${minT} より大きい`);
          break;
        }
        minT = Math.min(minT, t);
      }
      if (seen > 0) chains++;
    }
  }
  return { violations, chains };
}

// ---- 製品の出力（棟木・母屋・隅木・谷木・面）を、参照実装と不変条件で検査する ----

/** 点 p と線分（軸に平行な線 {isVertical, coord, lo, hi} か斜めの {x1,y1,x2,y2}）の距離。 */
function distToSegment(px, py, s) {
  const [ax, ay, bx, by] = s.x1 !== undefined ? [s.x1, s.y1, s.x2, s.y2]
    : (s.isVertical ? [s.coord, s.lo, s.coord, s.hi] : [s.lo, s.coord, s.hi, s.coord]);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const pointsOf = (s, fractions) => fractions.map(f => (s.x1 !== undefined
  ? [s.x1 + f * (s.x2 - s.x1), s.y1 + f * (s.y2 - s.y1)]
  : (s.isVertical ? [s.coord, s.lo + f * (s.hi - s.lo)] : [s.lo + f * (s.hi - s.lo), s.coord])));

/**
 * 製品の framing（leanToDrainFraming の戻り値）を、参照実装 ref と不変条件で検査する。違反の文字列と、検査した件数（counts。
 * 0 のものは空振りなので、呼び出し側は下限を assert する）を返す。
 *  (b) すべての母屋・棟木の段（levelMm）＝その線上の点の T（ref の T、±2g）
 *  (c) 面の中の線はすべて水下と同じ向き（流れは面の中で一定）
 *  (d) 線・斜め線の端は、屋根範囲の外周か、棟木・斜め線の上にある（宙に浮いた端が無い）
 *  棟木・斜め線の両側（±2.5g）で ref の owner が違う（面の境目である）。斜め線の両側の水下は直交する向き
 *  逆に、ref の owner の境目（壁・けらばの近くを除く）は、棟木か斜め線の近く（3g 以内）にある
 *  逆に、ref の T が母屋の段（firstLevelMm + k×pitchMm）をまたぐ所（壁・けらばの近くを除く）は、その段の母屋か棟木の近くにある
 * @param {object} p
 * @param {Array<object>} p.rects 屋根範囲のセル矩形
 * @param {object} p.framing leanToDrainFraming の戻り値
 * @param {object} p.ref drainReference の結果
 * @param {Array<object>} p.walls 壁・けらば（水下でない外周の辺）
 * @param {number} p.pitchMm 母屋のピッチ
 * @param {number} p.firstLevelMm 母屋の段の始まり
 * @param {number} [p.tolMm]
 */
export function framingChecks({ rects, framing, ref, walls, pitchMm, firstLevelMm, tolMm = 0.5 }) {
  const g = ref.g;
  const violations = [];
  const counts = { levelPoints: 0, faceLines: 0, endpoints: 0, ridgeSides: 0, diagSides: 0, ownerBoundaries: 0, contourCrossings: 0 };
  const { ridges, purlins, diagonals, faces } = framing;
  const F3 = [0.15, 0.5, 0.85];
  const pointInR = (x, y) => rects.some(r => r.x1 < x && x < r.x2 && r.y1 < y && y < r.y2);
  const inClosedR = (x, y) => rects.some(r => r.x1 - 1e-6 <= x && x <= r.x2 + 1e-6 && r.y1 - 1e-6 <= y && y <= r.y2 + 1e-6);
  const e = 0.02;
  const onBoundary = (x, y) => inClosedR(x, y) && ![[-1, -1], [-1, 1], [1, -1], [1, 1]].every(([sx, sy]) => pointInR(x + sx * e, y + sy * e));
  const nearWall = (x, y, d) => walls.some(w => distToSegment(x, y, w) <= d);
  const label = l => (l.x1 !== undefined ? `斜め (${l.x1},${l.y1})-(${l.x2},${l.y2})` : `${l.isVertical ? 'x' : 'y'}=${l.coord} ${l.lo}..${l.hi}`);

  // (b) 段＝T
  for (const l of [...purlins, ...ridges]) {
    for (const [x, y] of pointsOf(l, F3)) {
      const t = ref.tAt(x, y);
      if (Number.isNaN(t)) continue;
      counts.levelPoints++;
      if (Math.abs(t - l.levelMm) > 2 * g) violations.push(`(b) ${label(l)} L${l.levelMm}: 点 (${x},${y}) の T=${t}`);
    }
  }
  // (c) 面の中の向き
  for (const f of faces) {
    for (const l of f.lines) {
      counts.faceLines++;
      if (l.isVertical !== f.lineIsVertical) violations.push(`(c) 面（水下 ${f.drain.isVertical ? 'x' : 'y'}=${f.drain.coord}）の中に向きの違う線 ${label(l)}`);
    }
  }
  // (d) 端
  const supports = [...ridges, ...diagonals];
  for (const l of [...purlins, ...ridges, ...diagonals]) {
    const ends = l.x1 !== undefined ? [[l.x1, l.y1], [l.x2, l.y2]]
      : (l.isVertical ? [[l.coord, l.lo], [l.coord, l.hi]] : [[l.lo, l.coord], [l.hi, l.coord]]);
    for (const [x, y] of ends) {
      counts.endpoints++;
      if (onBoundary(x, y)) continue;
      if (supports.some(s => s !== l && distToSegment(x, y, s) <= Math.max(tolMm, 1e-3))) continue;
      violations.push(`(d) ${label(l)} の端 (${x},${y}) が宙に浮いている`);
    }
  }
  // 棟木・斜め線の両側の owner
  const sideOffsets = l => {
    if (l.x1 !== undefined) {
      const sx = Math.sign(l.x2 - l.x1);
      const sy = Math.sign(l.y2 - l.y1);
      return [[-sy * 2.5 * g, sx * 2.5 * g], [sy * 2.5 * g, -sx * 2.5 * g]];
    }
    return l.isVertical ? [[-2.5 * g, 0], [2.5 * g, 0]] : [[0, -2.5 * g], [0, 2.5 * g]];
  };
  const drainsOf = framing.faces.map(f => f.drain);
  // 同じ直線・同じ向きの水下どうし（間に別の屋根が入って離れているだけ）の面の境目は、T が同じなので線にならない
  const sameEave = (a, b) => a.isVertical === b.isVertical && a.outward === b.outward && Math.abs(a.coord - b.coord) <= tolMm;
  const ownerSides = (l, kind) => {
    const length = l.x1 !== undefined ? Math.hypot(l.x2 - l.x1, l.y2 - l.y1) : l.hi - l.lo;
    if (length < 8 * g) return; // 短い線は格子では両側を標本にできない
    for (const [x, y] of pointsOf(l, [0.3, 0.5, 0.7])) {
      const [a, b] = sideOffsets(l);
      const o1 = ref.ownerAt(x + a[0], y + a[1]);
      const o2 = ref.ownerAt(x + b[0], y + b[1]);
      if (o1 < 0 || o2 < 0) continue;
      counts[kind]++;
      // ref の owner 番号は drains（製品の faces と同じ並び）の添字
      if (o1 === o2) violations.push(`${kind === 'ridgeSides' ? '棟木' : '斜め線'} ${label(l)} の両側 (${x},${y}) の owner が同じ（${o1}）`);
      else if (kind === 'diagSides' && drainsOf[o1].isVertical === drainsOf[o2].isVertical) violations.push(`斜め線 ${label(l)} の両側 (${x},${y}) の水下が同じ向き（${o1}・${o2}）`);
      else if (kind === 'ridgeSides' && drainsOf[o1].isVertical !== drainsOf[o2].isVertical) violations.push(`棟木 ${label(l)} の両側 (${x},${y}) の水下が直交（${o1}・${o2}）`);
    }
  };
  for (const l of ridges) ownerSides(l, 'ridgeSides');
  for (const l of diagonals) ownerSides(l, 'diagSides');
  // 逆: ref の owner の境目と、T が母屋の段をまたぐ所
  const { nx, ny } = ref;
  const { cx, cy } = ref;
  const levels = [];
  for (let k = 0; firstLevelMm + k * pitchMm < 1e6 && levels.length < 400; k++) { const h = firstLevelMm + k * pitchMm; if (h > Math.max(nx, ny) * g) break; levels.push(h); }
  const levelLines = [...purlins, ...ridges];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!ref.inR[idx] || !Number.isFinite(ref.T[idx])) continue;
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii >= nx || jj >= ny) continue;
        const idx2 = jj * nx + ii;
        if (!ref.inR[idx2] || !Number.isFinite(ref.T[idx2])) continue;
        const bx = (cx(i) + cx(ii)) / 2;
        const by = (cy(j) + cy(jj)) / 2;
        if (nearWall(bx, by, 3 * g)) continue;
        // owner の境目。格子の都合で同点（T が等しい45°の線の上）に幅1〜2セルの別の owner が混ざることがあるので、境目から3セル離れた
        // 両側の点の owner が、それぞれのセルの owner と同じ（＝厚みのある面どうしの境目）ものだけを検査する
        if (ref.owner[idx] !== ref.owner[idx2]
          && !sameEave(drainsOf[ref.owner[idx]], drainsOf[ref.owner[idx2]])
          && ref.ownerAt(cx(i) - 3 * di * g, cy(j) - 3 * dj * g) === ref.owner[idx]
          && ref.ownerAt(cx(ii) + 3 * di * g, cy(jj) + 3 * dj * g) === ref.owner[idx2]) {
          counts.ownerBoundaries++;
          if (![...ridges, ...diagonals].some(s => distToSegment(bx, by, s) <= 3 * g)) violations.push(`owner の境目 (${bx},${by}) の近くに棟木・斜め線が無い（owner ${ref.owner[idx]}・${ref.owner[idx2]}）`);
        }
        const t1 = ref.T[idx];
        const t2 = ref.T[idx2];
        for (const h of levels) {
          if (!((t1 < h && h <= t2) || (t2 < h && h <= t1))) continue;
          counts.contourCrossings++;
          if (!levelLines.some(l => Math.abs(l.levelMm - h) <= 2 * g && distToSegment(bx, by, l) <= 3 * g)) violations.push(`T が段 ${h} をまたぐ点 (${bx},${by}) の近くに母屋・棟木が無い`);
        }
      }
    }
  }
  return { violations, counts };
}
