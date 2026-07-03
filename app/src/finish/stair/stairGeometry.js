import { StairType, totalStepsFromSections } from '@core';

const BREAK_HEIGHT = 1600;   // mm — 破れ縁の断面高さ（FL+1600）
const MIN_LANDING  = 1200;   // mm — 踊り場の最小長さ（問題.md）

const seg  = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, dashed: false });
const line = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
const clamp01 = (t) => Math.max(0, Math.min(1, t));

const LABEL_OUT = 350; // mm — U/D ラベルを始点（踏面1本目線）の外側へ押し出す距離
const NUM_GAP   = 1 / 4; // 段数数字を基点側の線（踏面線／踊場・周回部の入口境界線）から離す量（区間内比率）
const NUM_OUT   = 0.15;  // 段数字を幅方向の外周側（隣接壁側）へ寄せる位置（外側端からの距離。レーン/アーム/全幅で共通利用）
const TURN_OUT  = 0.7;   // 踊場・周回部（マスw≥2）の2段目以降を pivot→外周 の混合で外周部近くへ寄せる比率

const BREAK_TILT = Math.PI / 6; // 30° — 破断線を踏面（＝幅）方向から傾ける角度。全階段共通。
// 縦連なり踏面を切る（垂直で切る＝幅が水平）→ 水平から30°、横連なり踏面を切る（水平で切る＝幅が垂直）→ 水平から60° の "/"。
const BREAK_TICK = 90;          // mm — 中央ジョグ（Z字）の突起高さ
const BREAK_JOG  = 90;          // mm — 中央ジョグの線方向半幅

// 破断線: 全幅カット p→q を踏面（幅）方向から30°傾け、中央に Z 字ジョグを入れた図形（seg配列）。
// world では常に "/"（右上がり）で、走行方向・反転（flip）によらず向きは一定。幅が水平（縦連なり
// 踏面＝垂直で切る）なら水平から30°、幅が垂直（横連なり踏面＝水平で切る）なら水平から60°になる。
// p1/p2 は実際の破断線の両端点（p側/q側）。傾きにより p1 は p から、p2 は q から走行方向へ
// ∓(幅/2)*tan(BREAK_TILT) だけずれる（p側とq側で符号が逆）。呼び出し側は両側線をここへ延長・短縮して繋ぐ。
function breakSymbol(p, q) {
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const W = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const wx = (q.x - p.x) / W, wy = (q.y - p.y) / W;        // 幅方向 単位（p→q）
  const cos = Math.cos(BREAK_TILT), sin = Math.sin(BREAK_TILT);
  let nx = -wy, ny = wx;                                   // w の法線 単位
  let dx = wx * cos + nx * sin, dy = wy * cos + ny * sin;  // 幅方向を tilt 回転した線方向
  if (dx * dy > 0) { nx = -nx; ny = -ny; dx = wx * cos + nx * sin; dy = wy * cos + ny * sin; } // "/"（右上がり）へ固定
  const L = W / cos;                                        // 幅投影=全幅 となる長さ
  const along = (s) => ({ x: mx + dx * s, y: my + dy * s });
  const P1 = along(-L / 2), P2 = along(L / 2);
  const A = along(-BREAK_JOG), C = along(BREAK_JOG);
  const B = { x: A.x + nx * BREAK_TICK, y: A.y + ny * BREAK_TICK };
  const D = { x: C.x - nx * BREAK_TICK, y: C.y - ny * BREAK_TICK };
  return { segs: [seg(P1, A), seg(A, B), seg(B, D), seg(D, C), seg(C, P2)], p1: P1, p2: P2 };
}

// breakSymbol の傾きにより、全幅 widthMm の破断線が p側/q側で走行方向へずれる量(mm、片側分)。
// 踏面線・段数字は、破れ線が両側線を切り始める手前（この分だけ手前）で止める。
function breakInsetMm(widthMm) {
  return (widthMm / 2) * Math.tan(BREAK_TILT);
}

function unit(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// 踊場・周回部に隣接する破断線の対角（ジョグ無視、直線）を表す。始点＝outerPt（外周部＝隣接壁との
// 交点。直進部の初段＝踊場との接続部と外周部の交点）を完全固定し、「壁→内側」（acrossDir）と
// 「踊場・周回部から離れる走行方向」（awayDir）を合成した向きへ30°傾ける。
// breakSymbolの世界座標基準"/"固定（upDirection/flip次第で内側の安全な向きが変わりうる）とは異なり、
// 踊場・周回部へは確実に食い込まない向きを明示的に選ぶ。outerPtが延長済みでも整合するよう、
// 深さ・幅方向位置は常にouterPt起点の相対量で計算する（踏面線・矢印を対角へ正確に接続するため）。
function breakDiagonalFrame(outerPt, acrossDir, awayDir) {
  const cos = Math.cos(BREAK_TILT), sin = Math.sin(BREAK_TILT);
  const dir = { x: acrossDir.x * cos + awayDir.x * sin, y: acrossDir.y * cos + awayDir.y * sin };
  const along = (s) => ({ x: outerPt.x + dir.x * s, y: outerPt.y + dir.y * s });
  return {
    dir,
    along,
    atDepth: (depthMm) => along(depthMm / sin), // outerPtからの走行方向(awayDir)の深さ→対角上の点
    atPoint: (p) => along(((p.x - outerPt.x) * acrossDir.x + (p.y - outerPt.y) * acrossDir.y) / cos), // pと同じ幅方向位置→対角上の点
  };
}

function breakSymbolAwayFromLanding(outerPt, acrossDir, awayDir, widthMm) {
  const { dir, along } = breakDiagonalFrame(outerPt, acrossDir, awayDir);
  const nx = -dir.y, ny = dir.x;
  const L = widthMm / Math.cos(BREAK_TILT);
  const inner = along(L);
  const A = along(L / 2 - BREAK_JOG), C = along(L / 2 + BREAK_JOG);
  const B = { x: A.x + nx * BREAK_TICK, y: A.y + ny * BREAK_TICK };
  const D = { x: C.x - nx * BREAK_TICK, y: C.y - ny * BREAK_TICK };
  // s順（outerPt=0 → A(L/2-JOG) → B/D(ジョグ) → C(L/2+JOG) → inner=L）に辿ることで、
  // 斜め線がZ（ジョグ）区間を横断しないようにする（A/Cの前後を誤ると斜め線がジョグを飛び越えて交差する）。
  return { segs: [seg(outerPt, A), seg(A, B), seg(B, D), seg(D, C), seg(C, inner)], inner, outer: outerPt };
}

// 走行矢印: 始点 start（丸を描く）→ 終点 end（矢じり）。
// label（U/D）は start から end と逆向き（＝踏面1本目線の外）へ押し出した中心に置く。
function runArrow(start, end, label) {
  const dx = start.x - end.x, dy = start.y - end.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x1: start.x, y1: start.y, x2: end.x, y2: end.y,
    labelX: start.x + (dx / len) * LABEL_OUT,
    labelY: start.y + (dy / len) * LABEL_OUT,
    label,
  };
}

// U字（折り返し）矢印: 折れ線 pts[0]→…→pts[n]。pts[0] に始点丸、終点に矢じり。
// label は始点から2点目と逆向き（走行始点の外）へ押し出す。
function uTurnArrow(pts, label) {
  const [p0, p1] = pts;
  const dx = p0.x - p1.x, dy = p0.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x1: p0.x, y1: p0.y,
    points: pts.flatMap((p) => [p.x, p.y]),
    labelX: p0.x + (dx / len) * LABEL_OUT,
    labelY: p0.y + (dy / len) * LABEL_OUT,
    label,
  };
}

// 設置エリア矩形 b から走行軸方向 t∈[0,1] / 幅方向 s∈[0,1] → ワールド点 の写像を作る。
export function makeFrame(stair, b) {
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  const runLength = (vertical ? (b.y2 - b.y1) : (b.x2 - b.x1)) || 1;
  const coordAt = (t) => {
    switch (stair.upDirection) {
      case 'down':  return b.y1 + t * (b.y2 - b.y1);
      case 'right': return b.x1 + t * (b.x2 - b.x1);
      case 'left':  return b.x2 - t * (b.x2 - b.x1);
      case 'up':
      default:      return b.y2 - t * (b.y2 - b.y1);
    }
  };
  const acrossLo = vertical ? b.x1 : b.y1;
  const acrossHi = vertical ? b.x2 : b.y2;
  const acrossAt = (s) => {
    const ss = stair.flip ? 1 - s : s;
    return acrossLo + ss * (acrossHi - acrossLo);
  };
  const pt = (t, s) => vertical
    ? { x: acrossAt(s), y: coordAt(t) }
    : { x: coordAt(t), y: acrossAt(s) };
  return { vertical, runLength, pt };
}

// FL+1600 で切れるマス番号（install ビューの破れ位置。マス番号=蹴上の続き番号）。
function breakStepOf(totalRisers, riser, view) {
  if (view !== 'install') return totalRisers;
  return riser
    ? Math.min(totalRisers - 1, Math.max(1, Math.floor(BREAK_HEIGHT / riser)))
    : Math.max(1, Math.round(totalRisers * 0.6));
}

// 共通の外周・破れ縁・矢印を生成する。install view では両側線を破断線の実端点まで延長／短縮して繋ぎ、
// 踏面線・段数字が破断線の手前で止まるよう breakInset（mm）を返す。破れ線の見た目は、幅方向の
// 外周端（隣接壁のCL側）だけさらにはね出す（b は inset 後の設置エリア矩形）。
// wideSide: 破断線は幅方向から30°傾くため s=0側/s=1側で走行方向の見えがかり長さが異なる（I字の
// 「破れ線の広い方」判定用）。0=s=0側が広い／1=s=1側が広い／null=破れなし（install以外）。
function frameDecor(f, topT, view, b) {
  const c00 = f.pt(0, 0), c01 = f.pt(0, 1), c10 = f.pt(topT, 0), c11 = f.pt(topT, 1);
  let breakLine = null;
  let sideEnd0 = c10, sideEnd1 = c11;
  let breakInset = 0; // mm
  let wideSide = null;
  if (view === 'install') {
    const { p1, p2 } = breakSymbol(c10, c11); // 全幅カットを傾けたZ字破断線（側線連結用・実寸）
    sideEnd0 = p1; sideEnd1 = p2;
    breakLine = breakSymbol(extendBreakEndToCL(c10, b), extendBreakEndToCL(c11, b)).segs; // 見た目はCLまではね出す
    breakInset = breakInsetMm(Math.hypot(c11.x - c10.x, c11.y - c10.y));
    const tx = c10.x - c00.x, ty = c10.y - c00.y; // 走行方向（0→topT）への射影で比較
    const proj = (p) => (p.x - c00.x) * tx + (p.y - c00.y) * ty;
    wideSide = proj(p1) >= proj(p2) ? 0 : 1;
  }
  const outline = [{ ...seg(c00, c01), thin: true }, seg(c00, sideEnd0), seg(c01, sideEnd1)]; // c00-c01=区画初段
  if (view !== 'install') outline.push({ ...seg(c10, c11), thin: true }); // 設置階上階への到達辺（$）はthin
  // D（降り口）はいちばん大きい踏面番号側（かみがた）を始点にし、番号の小さい方へ向かう矢印にする。
  const arrow = view === 'install'
    ? runArrow(f.pt(0, 0.5), f.pt(topT, 0.5), 'U')
    : runArrow(f.pt(topT, 0.5), f.pt(0, 0.5), 'D');
  return { outline, breakLine, arrows: [arrow], breakInset, wideSide };
}

const WALL_BASE  = 90;            // mm — 既定壁下地厚（壁生成の既定値に合わせる。仕上げ厚は含めない）
const WALL_INSET = WALL_BASE / 2; // mm — 中心線から逃げる量

// 設置エリア矩形 b の各辺を、隣接壁の中心線から壁厚/2だけ内側へ逃がす。
// 幅方向（走行方向に直交する両側線）は常に逃がす。走行方向の2辺（始端=登り口／終端=上階到達）は、
// 設置階（install）は登り口を除く終端のみ、設置階上階（upper）は登り口・終端とも逃がす。
export function insetStairBounds(stair, b, view) {
  const vertical = stair.upDirection === 'up' || stair.upDirection === 'down';
  let { x1, y1, x2, y2 } = b;
  if (vertical) { x1 += WALL_INSET; x2 -= WALL_INSET; }
  else          { y1 += WALL_INSET; y2 -= WALL_INSET; }
  const insetEntry = view !== 'install';
  switch (stair.upDirection) {
    case 'down':  if (insetEntry) y1 += WALL_INSET; y2 -= WALL_INSET; break; // 始端=y1 終端=y2
    case 'right': if (insetEntry) x1 += WALL_INSET; x2 -= WALL_INSET; break; // 始端=x1 終端=x2
    case 'left':  x1 += WALL_INSET; if (insetEntry) x2 -= WALL_INSET; break; // 始端=x2 終端=x1
    case 'up':
    default:      y1 += WALL_INSET; if (insetEntry) y2 -= WALL_INSET; break; // 始端=y2 終端=y1
  }
  return { x1, y1, x2, y2 };
}

// 破れ線の見た目だけを、階段の幅方向の外周端（＝隣接壁の中心線 CL 側）まで、さらに壁厚/2 はね出す。
// 突き抜けた先に階段が無い前提（隣接する階段の有無は判定しない）。b は inset 後の設置エリア矩形。
// 点 p が b の外周辺（x1/x2/y1/y2）に乗っていなければ内周（吹抜け側等）の端点とみなし、動かさない。
function extendBreakEndToCL(p, b) {
  const EPS = 1e-3;
  if (Math.abs(p.x - b.x1) < EPS) return { x: p.x - WALL_INSET, y: p.y };
  if (Math.abs(p.x - b.x2) < EPS) return { x: p.x + WALL_INSET, y: p.y };
  if (Math.abs(p.y - b.y1) < EPS) return { x: p.x, y: p.y - WALL_INSET };
  if (Math.abs(p.y - b.y2) < EPS) return { x: p.x, y: p.y + WALL_INSET };
  return p;
}

/**
 * 階段の統一モデル: sections は歩行順の区間別・実段数の配列で、全タイプ共通に
 * 偶数index=直進部、奇数index=踊場・周回部 の並びとして解釈する（タイプの違いは写像だけ）。
 * 図に描くマス（踏面）数は、直進部=実段数-1（最終の1段は次区間・上階へ乗る段でマスを持たない）、
 * 踊場・周回部=実段差ぶん（平踊場は1）。段数字は歩行順のマスへの続き番号で、
 * 最終番号（設置階上階への到達）= 総マス数+1 = stair.totalSteps = 総蹴上数。
 */
function stairParts(sections) {
  let c = 0;
  const parts = sections.map((risers, i) => {
    const kind = i % 2 === 0 ? 'run' : 'turn';
    const cells = kind === 'run' ? Math.max(1, risers - 1) : Math.max(1, risers);
    const part = { kind, risers, cells, numberStart: c + 1, index: i };
    c += cells;
    return part;
  });
  return { parts, totalSteps: c + 1 };
}

// stair.sections が未設定（null）の場合に totalSteps から妥当な既定値を組み立てる
//（totalStepsFromSections の逆算。区間の実段数は直進部≥2・周回部≥1 を保つ）。
function defaultSections(stair) {
  const total = Math.max(2, stair.totalSteps);
  const half = (t) => { const a = Math.max(2, Math.ceil(t / 2)); return [a, Math.max(2, t - a)]; };
  switch (stair.type) {
    case StairType.STRAIGHT:
      return [total];
    case StairType.STRAIGHT_LANDING:
    case StairType.L_TURN:
    case StairType.SWITCHBACK: {
      const [a, s] = half(total);
      return [a, 1, s];
    }
    case StairType.WINDING: {
      const w = 3;
      const [a, s] = half(total + 1 - w);
      return [a, w, s];
    }
    case StairType.FLARED: {
      const w = 2;
      const [a, s] = half(total + 1 - w);
      return [a, w, s];
    }
    case StairType.OPEN_WELL: {
      const n = Math.max(2, Math.ceil(total / 3));
      return [n, 1, n, 1, Math.max(2, total - 2 * n)];
    }
    default:
      return null;
  }
}
const getSections = (stair) => stair.sections ?? defaultSections(stair);

// 実測区間長（セル割り由来。measureStairSpans の結果）が sections 個数と揃っていれば返す。
function measuredLengths(spans, count) {
  const ls = spans?.lengths;
  return Array.isArray(ls) && ls.length === count && ls.every((v) => Number.isFinite(v) && v > 0)
    ? ls : null;
}

// ---- 共通描画（直進部・踊場・周回部の2プリミティブ。タイプ側は区間内位置→ワールドの写像だけを渡す）----

// 直進部: 区間内のマス境界線（1..cells-1。区間終端の境界は接続する踊場・周回部／外周が描く）と
// マス番号（続き番号）。axis.treadLine(mm)/axis.labelPt(mm) は区間基点からの距離→ワールドの写像。
// limitMm は破れ線の手前で止める上限（区間内の距離。単位は axis と同じであれば mm でなくてもよい）。
function emitRun(out, part, pitch, axis, { detail, limitMm = Infinity, nosingMm = 0 }) {
  for (let k = 1; k < part.cells; k++) {
    const mm = k * pitch + nosingMm;
    if (mm <= 1e-6 || mm >= limitMm) continue;
    out.treads.push(axis.treadLine(mm));
  }
  if (!detail) return;
  for (let k = 1; k <= part.cells; k++) {
    const mm = (k - 1 + NUM_GAP) * pitch;
    if (mm >= limitMm) break;
    const p = axis.labelPt(mm);
    out.stepNumbers.push({ x: p.x, y: p.y, text: String(part.numberStart + k - 1) });
  }
}

// 踊場・周回部: 平踊場（マス1）・回り曲がり（マスw≥2）とも、初段（直前区間からの続き＝下手側）は
// geo.entryPt() で「直前区間と同じ幅方向位置」かつ「入口境界線近く」に置く。マスw≥2の2段目以降は
// 放射境界 w-1 本（geo.radialLine）と外周部近くの番号（geo.cellPt）。区間の入口・出口境界はタイプ側が描く。
function emitTurn(out, part, geo, { detail }) {
  if (part.cells > 1) {
    for (let j = 1; j < part.cells; j++) out.treads.push(geo.radialLine(j / part.cells));
  }
  if (!detail) return;
  const p0 = geo.entryPt();
  out.stepNumbers.push({ x: p0.x, y: p0.y, text: String(part.numberStart) });
  for (let j = 2; j <= part.cells; j++) {
    const p = geo.cellPt((j - 0.5) / part.cells);
    out.stepNumbers.push({ x: p.x, y: p.y, text: String(part.numberStart + j - 1) });
  }
}

// pivot から perim（外周点）へ TURN_OUT ぶん寄せた点（回り・曲がり部の2段目以降を外周部近くへ）。
function radialMix(pivot, perim, ratio = TURN_OUT) {
  return { x: pivot.x + (perim.x - pivot.x) * ratio, y: pivot.y + (perim.y - pivot.y) * ratio };
}

// 設置階上階への到達番号（最終番号 = totalSteps）。upper のみ呼ぶ。
function emitArrival(out, totalSteps, p, detail) {
  if (detail) out.stepNumbers.push({ x: p.x, y: p.y, text: String(totalSteps) });
}

// ---- 直進階段 ----
function buildStraight(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const { parts, totalSteps } = stairParts(getSections(stair));
  const run = parts[0];
  const L = f.runLength;          // 区間長 = 設置枠の走行全長
  const pitch = L / run.cells;
  const breakCell = breakStepOf(totalSteps, riser, view);
  const shownMm = view === 'install' ? (breakCell - 1) * pitch : L;
  const topT = shownMm / L;
  const nosingMm = detail ? stair.nosing * (view === 'install' ? -1 : 1) : 0;

  const { outline, breakLine, arrows, breakInset, wideSide } = frameDecor(f, topT, view, b);
  // I字: 破れ線が広い方（走行方向により長く見えがかる側＝文字をより多く描画できる側）へ寄せる。
  // 破れがない（upper）場合は既定で外周寄り（1-NUM_OUT）に置く。
  const numS = wideSide === 0 ? NUM_OUT : 1 - NUM_OUT;
  const out = { treads: [], stepNumbers: [] };
  emitRun(out, run, pitch, {
    treadLine: (mm) => line(f.pt(clamp01(mm / L), 0), f.pt(clamp01(mm / L), 1)),
    labelPt:   (mm) => f.pt(mm / L, numS),
  }, { detail, limitMm: view === 'install' ? shownMm - breakInset : Infinity, nosingMm });
  if (view !== 'install') emitArrival(out, totalSteps, f.pt(1, numS), detail);
  return { ...out, outline, arrows, breakLine };
}

// ---- 踊り場付直進階段 ----
// 走行軸上に 直進部 → 踊場（マス1・平坦バンド）→ 直進部 を配置する。区間長はセル実測
//（区間長指定）があればそれを使い、無ければ 踏面寸×マス数＋最小踊場 を合成して枠に引き伸ばす。
function buildStraightLanding(stair, b, { view, detail, riser, spans }) {
  const f = makeFrame(stair, b);
  const { parts, totalSteps } = stairParts(getSections(stair));
  const [run1, land, run2] = parts;
  const tread = stair.tread;
  const ms = measuredLengths(spans, 3);
  const L1 = ms ? ms[0] : run1.cells * tread;
  const LD = ms ? ms[1] : Math.max(4 * tread, MIN_LANDING);
  const L2 = ms ? ms[2] : run2.cells * tread;
  const landingEnd = L1 + LD;
  const budget = (landingEnd + L2) || 1;
  const pitch1 = L1 / run1.cells, pitch2 = L2 / run2.cells;
  const tAt = (mm) => mm / budget;

  // 破れ位置: マス番号（=蹴上の続き番号）→ 走行軸mm（そのマスの基点側境界）
  const breakCell = breakStepOf(totalSteps, riser, view);
  const cellStartMm = (c) => {
    if (c <= run1.cells) return (c - 1) * pitch1;
    if (c === land.numberStart) return L1;
    return landingEnd + (c - run2.numberStart) * pitch2;
  };
  const shownMm = view === 'install' ? cellStartMm(breakCell) : budget;
  const topT = tAt(shownMm);
  const nosingMm = detail ? stair.nosing * (view === 'install' ? -1 : 1) : 0;

  const { outline, breakLine, arrows, breakInset, wideSide } = frameDecor(f, topT, view, b);
  const limitMm = view === 'install' ? shownMm - breakInset : Infinity; // 破れ線が両側線を切り始める手前
  // I字: 破れ線が広い方へ寄せる（破れなしは既定で外周寄り）。区間全体で同じ側に統一する。
  const numS = wideSide === 0 ? NUM_OUT : 1 - NUM_OUT;

  const out = { treads: [], stepNumbers: [] };
  const lineAt = (mm) => line(f.pt(clamp01(tAt(mm)), 0), f.pt(clamp01(tAt(mm)), 1));
  const pushBoundary = (mm) => { if (mm > 1e-6 && mm < limitMm - 1e-6) out.treads.push(lineAt(mm)); };

  // 直進部1（踊場入口境界=区間終端は踊場側が描く）
  emitRun(out, run1, pitch1, {
    treadLine: lineAt,
    labelPt:   (mm) => f.pt(tAt(mm), numS),
  }, { detail, limitMm, nosingMm });
  // 踊場: 入口・後縁の境界と番号（初段=下手側の run1 と同じ幅方向位置、入口境界線近く）
  pushBoundary(L1 + nosingMm);
  pushBoundary(landingEnd);
  const landEntryMm = L1 + NUM_GAP * pitch1; // 直進部と同じ離れ（pitch1基準）
  if (landEntryMm < limitMm) {
    emitTurn(out, land, { entryPt: () => f.pt(tAt(landEntryMm), numS) }, { detail });
  }
  // 直進部2（最終境界=上階到達辺は frameDecor の outline が描く）
  emitRun(out, run2, pitch2, {
    treadLine: (mm) => lineAt(landingEnd + mm),
    labelPt:   (mm) => f.pt(tAt(landingEnd + mm), numS),
  }, { detail, limitMm: limitMm - landingEnd, nosingMm });
  if (view !== 'install') emitArrival(out, totalSteps, f.pt(1, numS), detail);
  return { ...out, outline, arrows, breakLine };
}

// U字系（屈折・回り）の共通レイアウト: 往路(レーンA: s 0→0.5) と 復路(レーンB: s 0.5→1) を平行配置し、
// 走行端（t=tRun〜1）に両レーンをまたぐ踊場・周回部を置く。区間境界（踊場前縁）はセル実測
//（区間長指定）があれば実位置、無ければ 踏面寸×マス数＋深さ(レーン幅相当) を合成して枠に引き伸ばす。
function uTurnLayout(f, b, runA, runB, tread, spans) {
  const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
  const ms = measuredLengths(spans, 3);
  const laneLen = ms ? ms[0] : runA.cells * tread;
  const depth = ms ? Math.max(1, f.runLength - laneLen) : Math.max(acrossLen * 0.5, tread);
  const budget = (laneLen + depth) || 1;
  const tAt = (mm) => mm / budget;
  return {
    laneLen, tAt,
    tRun: tAt(laneLen),                 // 区間境界＝踊場・周回部の前縁
    pitchA: laneLen / runA.cells,
    pitchB: laneLen / runB.cells,       // 復路も同じ区間長（レーン平行）
  };
}

// ---- 屈折階段（折り返し・180度）----
// install の破れは常に踊場との接続部（復路の初段線＝tRun）。FL+1600/riser では位置決めしない。
// 復路の段数字は install では表示しない（初段線位置＝破れの始点のため、初段に続き番号を置けない）。
// 踏面線は、破れ線（対角）に触れるまで吹抜け側から描画できる分だけ描く。
function buildSwitchback(stair, b, { view, detail, spans }) {
  const f = makeFrame(stair, b);
  const { parts, totalSteps } = stairParts(getSections(stair));
  const [runA, land, runB] = parts;
  const { laneLen, tAt, tRun, pitchA, pitchB } = uTurnLayout(f, b, runA, runB, stair.tread, spans);
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));
  const isInstall = view === 'install';
  const c = (t, s) => f.pt(t, s);

  const out = { treads: [], stepNumbers: [] };
  // 往路（レーンA s:0→0.5）
  emitRun(out, runA, pitchA, {
    treadLine: (mm) => lineS(tAt(mm), 0, 0.5),
    labelPt:   (mm) => f.pt(tAt(mm), NUM_OUT),        // 外側 s=0 寄せ
  }, { detail });
  // 踊場（両レーンをまたぐ平場）: 前縁境界（往路側・復路側）と番号
  out.treads.push(lineS(tRun, 0, 0.5));
  out.treads.push(lineS(tRun, 0.5, 1));
  const tMid = (tRun + 1) / 2;
  // 初段=下手側（往路runA）と同じ幅方向位置（NUM_OUT）・同じ離れ（pitchA基準）で入口境界線近くに置く
  emitTurn(out, land, { entryPt: () => f.pt(tAt(laneLen + NUM_GAP * pitchA), NUM_OUT) }, { detail });

  // 復路（レーンB s:0.5→1、踊場から base へ戻る）と、始点＝直進部2（復路）の初段＝踊場との
  // 接続部（tRun）と外周部（s=1、隣接壁側）の交点に固定した破れ線を、共通の幾何から作る。
  const widthMm = Math.hypot(c(tRun, 0.5).x - c(tRun, 1).x, c(tRun, 0.5).y - c(tRun, 1).y);
  let breakLine = null;
  let breakDiag = null; // 破れ線の対角（踏面線・矢印を正確に接続するため）
  if (isInstall) {
    // 内側（s=0.5、吹抜け側）は「壁→吹抜け」×「踊場から離れる走行方向」を合成した向きへ30°傾け、
    // upDirection/flipによらず踊場側へは確実に食い込まない（breakSymbolの世界座標基準"/"固定とは別）。
    const outerPt = extendBreakEndToCL(c(tRun, 1), b);
    const acrossDir = unit(c(tRun, 0.5).x - c(tRun, 1).x, c(tRun, 0.5).y - c(tRun, 1).y);
    const awayPt = c(tAt(laneLen - pitchB), 0.5); // レーンB内部（踊場から1ピッチ離れた参照点）
    const awayDir = unit(awayPt.x - c(tRun, 0.5).x, awayPt.y - c(tRun, 0.5).y);
    breakDiag = breakDiagonalFrame(outerPt, acrossDir, awayDir);
    breakLine = breakSymbolAwayFromLanding(outerPt, acrossDir, awayDir, widthMm).segs;
    // 踏面線: 破れ線が届く深さD（吹抜け側）まで、各マス境界を吹抜け側(s=0.5)から
    // 破れ線（対角）に触れる位置まで正確に描く。Dを超える境界はどの幅位置でも破れの奥（非表示）。
    const D = widthMm * Math.tan(BREAK_TILT);
    for (let k = 1; k < runB.cells; k++) {
      const depth = k * pitchB;
      if (depth >= D) break;
      out.treads.push(line(f.pt(tAt(laneLen - depth), 0.5), breakDiag.atDepth(depth)));
    }
  } else {
    emitRun(out, runB, pitchB, {
      treadLine: (mm) => lineS(tAt(laneLen - mm), 0.5, 1),
      labelPt:   (mm) => f.pt(tAt(laneLen - mm), 1 - NUM_OUT), // 外側 s=1 寄せ
    }, { detail });
  }

  // 外周（base 側・両レーン外側・踊り場の三方）＋ 中央仕切り。base側は往路出発／復路到達(設置階上階)で2分割する。
  const outline = [
    { ...seg(c(0, 0), c(0, 0.5)), thin: true },     // base側（往路出発＝区画初段）
    { ...seg(c(0, 0.5), c(0, 1)), thin: true },     // base側（復路到達＝設置階上階の最終段）
    seg(c(0, 0), c(tRun, 0)),    // レーンA外側
    seg(c(0, 1), c(tRun, 1)),    // レーンB外側
    seg(c(tRun, 0), c(1, 0)),    // 踊り場側面A
    seg(c(tRun, 1), c(1, 1)),    // 踊り場側面B
    seg(c(1, 0), c(1, 1)),       // 踊り場奥
    seg(c(0, 0.5), c(tRun, 0.5)),// 中央仕切り（吹抜け側）
  ];

  // U字矢印: install(U)は往路中心を上り→踊り場中心を通って破れ線（対角、s=0.75位置）に突き当たるまで。
  // upper(D)はいちばん大きい踏面番号側（復路基部＝かみがた）を始点に、番号の小さい方（往路基部）へ向かう。
  const uArrowEnd = isInstall ? breakDiag.atPoint(f.pt(tRun, 0.75)) : f.pt(0, 0.75);
  const arrows = [isInstall
    ? uTurnArrow([f.pt(0, 0.25), f.pt(tMid, 0.25), f.pt(tMid, 0.75), uArrowEnd], 'U')
    : uTurnArrow([f.pt(0, 0.75), f.pt(tMid, 0.75), f.pt(tMid, 0.25), f.pt(0, 0.25)], 'D')];

  if (!isInstall) emitArrival(out, totalSteps, f.pt(0, 1 - NUM_OUT), detail);
  return { ...out, outline, arrows, breakLine };
}

// ---- 回り階段（180度・折り返し部が回り段）----
// 屈折と同じ2レーン配置だが、走行端の踊場を「周回部（扇形マスw）」に置き換える。
// install の破れは常に周回部との接続部（復路の初段線＝tRun）。FL+1600/riser では位置決めしない。
// 復路の段数字は install では表示しない（初段線位置＝破れの始点のため、初段に続き番号を置けない）。
// 踏面線は、破れ線（対角）に触れるまで吹抜け側から描画できる分だけ描く。
function buildWinding(stair, b, { view, detail, spans }) {
  const f = makeFrame(stair, b);
  const { parts, totalSteps } = stairParts(getSections(stair));
  const [runA, turn, runB] = parts;
  const { laneLen, tAt, tRun, pitchA, pitchB } = uTurnLayout(f, b, runA, runB, stair.tread, spans);
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));
  const isInstall = view === 'install';
  const c = (t, s) => f.pt(t, s);

  const out = { treads: [], stepNumbers: [] };
  // 往路（レーンA s:0→0.5）
  emitRun(out, runA, pitchA, {
    treadLine: (mm) => lineS(tAt(mm), 0, 0.5),
    labelPt:   (mm) => f.pt(tAt(mm), NUM_OUT),        // 外側 s=0 寄せ
  }, { detail });
  // 周回部（扇形）: 入口・出口境界と、pivot=(tRun,0.5) から外周（s0辺→奥t1辺→s1辺）へ放射するマス
  out.treads.push(lineS(tRun, 0, 0.5));   // 入口境界（往路側）
  out.treads.push(lineS(tRun, 0.5, 1));   // 出口境界（復路側）
  const P = f.pt(tRun, 0.5);
  const perim = (u) => {
    if (u <= 1 / 3) { const k = u / (1 / 3);           return f.pt(tRun + k * (1 - tRun), 0); }
    if (u <= 2 / 3) { const k = (u - 1 / 3) / (1 / 3); return f.pt(1, k); }
    const k = (u - 2 / 3) / (1 / 3);                   return f.pt(1 - k * (1 - tRun), 1);
  };
  // 初段=下手側（往路runA）と同じ幅方向位置（NUM_OUT）・同じ離れ（pitchA基準）で入口境界線近くに置く。
  // 2段目以降は pivot→外周 の混合（TURN_OUT）で外周部近くへ寄せる。
  emitTurn(out, turn, {
    radialLine: (u) => line(P, perim(u)),
    cellPt: (u) => radialMix(P, perim(u)),
    entryPt: () => f.pt(tAt(laneLen + NUM_GAP * pitchA), NUM_OUT),
  }, { detail });
  // 復路（レーンB s:0.5→1）と、始点＝直進部2（復路）の初段＝周回部との接続部（tRun）と
  // 外周部（s=1、隣接壁側）の交点に固定した破れ線を、共通の幾何から作る。
  const widthMm = Math.hypot(c(tRun, 0.5).x - c(tRun, 1).x, c(tRun, 0.5).y - c(tRun, 1).y);
  let breakLine = null;
  let breakDiag = null; // 破れ線の対角（踏面線・矢印を正確に接続するため）
  if (isInstall) {
    // 内側（s=0.5、吹抜け側）は「壁→吹抜け」×「周回部から離れる走行方向」を合成した向きへ30°傾け、
    // upDirection/flipによらず周回部側へは確実に食い込まない（breakSymbolの世界座標基準"/"固定とは別）。
    const outerPt = extendBreakEndToCL(c(tRun, 1), b);
    const acrossDir = unit(c(tRun, 0.5).x - c(tRun, 1).x, c(tRun, 0.5).y - c(tRun, 1).y);
    const awayPt = c(tAt(laneLen - pitchB), 0.5); // レーンB内部（周回部から1ピッチ離れた参照点）
    const awayDir = unit(awayPt.x - c(tRun, 0.5).x, awayPt.y - c(tRun, 0.5).y);
    breakDiag = breakDiagonalFrame(outerPt, acrossDir, awayDir);
    breakLine = breakSymbolAwayFromLanding(outerPt, acrossDir, awayDir, widthMm).segs;
    // 踏面線: 破れ線が届く深さD（吹抜け側）まで、各マス境界を吹抜け側(s=0.5)から
    // 破れ線（対角）に触れる位置まで正確に描く。Dを超える境界はどの幅位置でも破れの奥（非表示）。
    const D = widthMm * Math.tan(BREAK_TILT);
    for (let k = 1; k < runB.cells; k++) {
      const depth = k * pitchB;
      if (depth >= D) break;
      out.treads.push(line(f.pt(tAt(laneLen - depth), 0.5), breakDiag.atDepth(depth)));
    }
  } else {
    emitRun(out, runB, pitchB, {
      treadLine: (mm) => lineS(tAt(laneLen - mm), 0.5, 1),
      labelPt:   (mm) => f.pt(tAt(laneLen - mm), 1 - NUM_OUT), // 外側 s=1 寄せ
    }, { detail });
  }

  const outline = [
    { ...seg(c(0, 0), c(0, 0.5)), thin: true },  // base側（往路出発＝区画初段）
    { ...seg(c(0, 0.5), c(0, 1)), thin: true },  // base側（復路到達＝設置階上階の最終段）
    seg(c(0, 0), c(tRun, 0)),     // レーンA外側
    seg(c(0, 1), c(tRun, 1)),     // レーンB外側
    seg(c(tRun, 0), c(1, 0)),     // 回り部側面A
    seg(c(1, 0), c(1, 1)),        // 回り部奥
    seg(c(1, 1), c(tRun, 1)),     // 回り部側面B
    seg(c(0, 0.5), c(tRun, 0.5)), // 中央仕切り（吹抜け側）
  ];

  // U字矢印: 折り返し階段と同じ（破れ線の対角に突き当たるまで延長）。
  const tMid = (tRun + 1) / 2;
  const uArrowEnd = isInstall ? breakDiag.atPoint(f.pt(tRun, 0.75)) : f.pt(0, 0.75);
  const arrows = [isInstall
    ? uTurnArrow([f.pt(0, 0.25), f.pt(tMid, 0.25), f.pt(tMid, 0.75), uArrowEnd], 'U')
    : uTurnArrow([f.pt(0, 0.75), f.pt(tMid, 0.75), f.pt(tMid, 0.25), f.pt(0, 0.25)], 'D')];

  if (!isInstall) emitArrival(out, totalSteps, f.pt(0, 1 - NUM_OUT), detail);
  return { ...out, outline, arrows, breakLine };
}

// ---- 矩折階段（かねおれ・L字90度）・曲がり階段（FLARED）----
// 正規化座標 (u,v)∈[0,1]² の L 字（arm1=水平/下、arm2=垂直/右、コーナーは(1,1)）を
// upDirection/flip で回転・鏡像して world へマップする。
// コーナーは踊場・周回部（L_TURNはマス1の平踊場、FLAREDはマスw≥1の扇形回り段）。
function buildLTurn(stair, b, { view, detail, riser }) {
  const { parts, totalSteps } = stairParts(getSections(stair));
  const [run1, corner, run2] = parts;
  const W = b.x2 - b.x1, H = b.y2 - b.y1;
  const aw = 0.45;        // アーム幅（正規化）
  const runU = 1 - aw;    // 直進部の終端（コーナー前縁）
  const pitch1 = runU / run1.cells; // 正規化単位のマスピッチ
  const pitch2 = runU / run2.cells;

  const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
  const toWorld = normToWorld(stair, pt);
  const lineUV = (u0, v0, u1, v1) => line(toWorld(u0, v0), toWorld(u1, v1));
  // コーナー扇形の外周（(1,runU)→(1,1)→(runU,1)）を t∈[0,1] で辿る
  const perimCorner = (t) => t <= 0.5
    ? toWorld(1, runU + (t / 0.5) * (1 - runU))
    : toWorld(1 - ((t - 0.5) / 0.5) * (1 - runU), 1);

  const isInstall = view === 'install';
  const breakCell = breakStepOf(totalSteps, riser, view);
  const inArm1 = breakCell <= run1.cells;
  const inCorner = !inArm1 && breakCell < run2.numberStart;
  const drawCorner = !(isInstall && inArm1);
  const drawArm2 = !(isInstall && (inArm1 || inCorner));

  // コーナーから離れる向き（アーム1側=u減少／アーム2側=v減少）。破れ線の内側（吹抜け・コーナー側）を
  // 必ずこの向きへ傾けるための基準（breakSymbolの世界座標基準"/"固定は向きを保証しないため使わない）。
  const awayDirArm1 = unit(toWorld(0, runU).x - toWorld(runU, runU).x, toWorld(0, runU).y - toWorld(runU, runU).y);
  const awayDirArm2 = unit(toWorld(1, 0).x - toWorld(1, runU).x, toWorld(1, 0).y - toWorld(1, runU).y);

  const out = { treads: [], stepNumbers: [] };
  let breakLine = null;
  let breakInset = 0;             // mm
  let bpU = null, bpV = null;     // arm1/arm2 内の破れ位置（正規化。マスの基点側境界）
  if (isInstall) {
    let bp, bq, awayDir;
    if (inArm1) {
      bpU = (breakCell - 1) * pitch1;
      bp = toWorld(bpU, runU); bq = toWorld(bpU, 1);
      awayDir = awayDirArm1;
    } else if (inCorner) {
      bp = toWorld(runU, runU); bq = toWorld(1, runU); // 扇形内 → arm2 入口で破れ
      awayDir = awayDirArm2;
    } else {
      bpV = runU - (breakCell - run2.numberStart) * pitch2;
      bp = toWorld(runU, bpV); bq = toWorld(1, bpV);
      awayDir = awayDirArm2;
    }
    // 始点＝外周部（隣接壁側、bq）に固定し、内側（吹抜け・コーナー側）は「壁→吹抜け」×
    // 「コーナーから離れる走行方向」を合成した向きへ30°傾ける。
    const acrossDir = unit(bq.x - bp.x, bq.y - bp.y);
    const widthMm = Math.hypot(bq.x - bp.x, bq.y - bp.y);
    const outerPt = extendBreakEndToCL(bq, b);
    const breakDiag = breakDiagonalFrame(outerPt, acrossDir, awayDir);
    breakLine = breakSymbolAwayFromLanding(outerPt, acrossDir, awayDir, widthMm).segs;
    breakInset = breakInsetMm(widthMm);
    // コーナーとの接続部（runU）に始点を固定した場合（inCorner）、arm2は全非表示になるが、
    // 破れ線が届く深さD（吹抜け側、mm）までは、各マス境界を吹抜け側(v=runU)から
    // 破れ線（対角）に触れる位置まで正確に描画できる分だけ描く（pitch2は正規化単位のためmm換算する）。
    if (inCorner) {
      const D = widthMm * Math.tan(BREAK_TILT); // mm
      const vAxisMm = Math.hypot(toWorld(runU, 1).x - toWorld(runU, 0).x, toWorld(runU, 1).y - toWorld(runU, 0).y);
      for (let k = 1; k < run2.cells; k++) {
        const v = runU - k * pitch2;
        const depthMm = k * pitch2 * vAxisMm;
        if (depthMm >= D) break;
        out.treads.push(line(toWorld(runU, v), breakDiag.atDepth(depthMm)));
      }
    }
  }

  // 破れ線が傾くぶん、踏面線・段数字は手前で止める（arm1/arm2 のみ。コーナー扇形は破れ時に非表示）
  const uAxisLen = Math.hypot(toWorld(1, runU).x - toWorld(0, runU).x, toWorld(1, runU).y - toWorld(0, runU).y);
  const vAxisLen = Math.hypot(toWorld(runU, 1).x - toWorld(runU, 0).x, toWorld(runU, 1).y - toWorld(runU, 0).y);
  const limit1 = isInstall && inArm1 ? bpU - breakInset / uAxisLen : Infinity;
  const limit2 = isInstall && bpV != null ? (runU - bpV) - breakInset / vAxisLen : Infinity;

  const midA = (runU + 1) / 2; // 矢印用（幅方向中央）。段数字はNUM_OUTで外周部近くへ寄せる。
  // アーム1（コーナー入口境界=区間終端はコーナー側が描く）。外側=v=1 側へ寄せる。
  emitRun(out, run1, pitch1, {
    treadLine: (u) => lineUV(u, runU, u, 1),
    labelPt:   (u) => toWorld(u, 1 - NUM_OUT),
  }, { detail, limitMm: limit1 });
  if (drawCorner) {
    out.treads.push(lineUV(runU, runU, runU, 1)); // arm1→コーナー入口境界
    out.treads.push(lineUV(runU, runU, 1, runU)); // コーナー→arm2 出口境界
    const pivot = toWorld(runU, runU);
    // 初段=下手側（arm1）と同じ幅方向位置（1-NUM_OUT）・同じ離れ（pitch1基準）で入口境界線近くに置く。
    // 2段目以降は pivot→外周 の混合（TURN_OUT）で外周部近くへ寄せる。
    emitTurn(out, corner, {
      radialLine: (t) => line(pivot, perimCorner(t)),
      cellPt: (t) => radialMix(pivot, perimCorner(t)),
      entryPt: () => toWorld(runU + NUM_GAP * pitch1, 1 - NUM_OUT),
    }, { detail });
  }
  if (drawArm2) {
    // arm2 far端（上階到達）は outline が描く。外側=u=1 側へ寄せる。
    emitRun(out, run2, pitch2, {
      treadLine: (mm) => lineUV(runU, runU - mm, 1, runU - mm),
      labelPt:   (mm) => toWorld(1 - NUM_OUT, runU - mm),
    }, { detail, limitMm: limit2 });
  }

  const outline = [
    { ...seg(toWorld(0, runU), toWorld(0, 1)), thin: true }, // arm1 base 端（区画初段）
    seg(toWorld(0, 1),    toWorld(1, 1)),       // arm1 外側
    seg(toWorld(1, 1),    toWorld(1, 0)),       // arm2 外側
    { ...seg(toWorld(1, 0), toWorld(runU, 0)), thin: true }, // arm2 far 端（設置階上階の最終段）
    seg(toWorld(runU, 0), toWorld(runU, runU)), // 内側（吹抜け側・縦）
    seg(toWorld(runU, runU), toWorld(0, runU)), // 内側（吹抜け側・横）
  ];

  const arrows = [runArrow(toWorld(0, midA), toWorld(runU, midA), 'U')];
  // D（upper）はいちばん大きい踏面番号側（arm2到達＝かみがた）を始点に、番号の小さい方（コーナー側）へ向かう。
  if (drawArm2) {
    arrows.push(isInstall
      ? runArrow(toWorld(midA, runU), toWorld(midA, 0), '')
      : runArrow(toWorld(midA, 0), toWorld(midA, runU), 'D'));
  }
  if (!isInstall) emitArrival(out, totalSteps, toWorld(1 - NUM_OUT, 0), detail);
  return { ...out, outline, arrows, breakLine };
}

// ---- 中空き階段（OPEN_WELL）----
// 中央に吹抜け（well）を持ち、下→踊場1→右→踊場2→上 の3直進部+2踊場（各マス1）がC字に囲む。
function buildOpenWell(stair, b, { view, detail, riser }) {
  const { parts, totalSteps } = stairParts(getSections(stair));
  const [run1, land1, run2, land2, run3] = parts;
  const W = b.x2 - b.x1, H = b.y2 - b.y1;
  const aw = 0.3;          // アーム幅（正規化）
  const runW = 1 - aw;     // 下/上アームの走行終端（右ストリップ手前）

  const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
  const toWorld = normToWorld(stair, pt);
  const lineUV = (u0, v0, u1, v1) => line(toWorld(u0, v0), toWorld(u1, v1));

  // 右アーム（中間アーム）はコーナー踊場が両端に接するため走行区間を aw ぶん両側短縮する。
  const rV0 = 1 - aw, rV1 = aw, rSpan = rV0 - rV1; // v: rV0(踊場1側)→rV1(踊場2側)
  const pitch1 = runW / run1.cells;
  const pitch2 = rSpan / run2.cells;
  const pitch3 = runW / run3.cells;

  const isInstall = view === 'install';
  const bs = breakStepOf(totalSteps, riser, view); // 破れマス番号（=蹴上の続き番号）
  const inBottom = bs <= run1.cells;
  const inRight  = !inBottom && bs < land2.numberStart; // 踊場1マス（右アーム入口で破れ）を含む
  const drawLand1 = !isInstall || bs >= land1.numberStart;
  const drawRight = !isInstall || bs > land1.numberStart;
  const drawLand2 = !isInstall || bs >= land2.numberStart;
  const drawTop   = !isInstall || bs > land2.numberStart;

  // 隣接する踊場から離れる向き（下アーム=u減少／右アーム=v減少／上アーム=u減少）。
  // 破れ線の内側（ウェル側）を必ずこの向きへ傾けるための基準。
  const awayDirBottom = unit(toWorld(0, 1 - aw).x - toWorld(runW, 1 - aw).x, toWorld(0, 1 - aw).y - toWorld(runW, 1 - aw).y);
  const awayDirRight  = unit(toWorld(runW, rV1).x - toWorld(runW, rV0).x, toWorld(runW, rV1).y - toWorld(runW, rV0).y);
  const awayDirTop    = unit(toWorld(0, aw).x - toWorld(runW, aw).x, toWorld(0, aw).y - toWorld(runW, aw).y);

  // mm換算用の軸スケール（u/vは正規化単位のため）。破れ線が傾くぶん、踏面線・段数字は手前で止める。
  const uAxisLen = Math.hypot(toWorld(1, 0).x - toWorld(0, 0).x, toWorld(1, 0).y - toWorld(0, 0).y);
  const vAxisLen = Math.hypot(toWorld(0, 1).x - toWorld(0, 0).x, toWorld(0, 1).y - toWorld(0, 0).y);

  const out = { treads: [], stepNumbers: [] };
  let breakLine = null;
  let breakInset = 0; // mm
  let bpU1 = null, bpV = null, bpU3 = null; // 各アーム内の破れ位置（正規化。マスの基点側境界）
  if (isInstall) {
    let bp, bq, awayDir;
    if (inBottom) {
      bpU1 = (bs - 1) * pitch1;
      bp = toWorld(bpU1, 1 - aw); bq = toWorld(bpU1, 1);
      awayDir = awayDirBottom;
    } else if (inRight) {
      bpV = bs === land1.numberStart ? rV0 : rV0 - (bs - run2.numberStart) * pitch2;
      bp = toWorld(runW, bpV); bq = toWorld(1, bpV);
      awayDir = awayDirRight;
    } else {
      bpU3 = bs === land2.numberStart ? runW : runW - (bs - run3.numberStart) * pitch3;
      bp = toWorld(bpU3, aw); bq = toWorld(bpU3, 0); // bp=内側（ウェル）／bq=外側（壁）に統一
      awayDir = awayDirTop;
    }
    // 始点＝外周部（隣接壁側、bq）に固定し、内側（ウェル側）は「壁→ウェル」×
    // 「踊場から離れる走行方向」を合成した向きへ30°傾ける。
    const acrossDir = unit(bq.x - bp.x, bq.y - bp.y);
    const widthMm = Math.hypot(bq.x - bp.x, bq.y - bp.y);
    const outerPt = extendBreakEndToCL(bq, b);
    const breakDiag = breakDiagonalFrame(outerPt, acrossDir, awayDir);
    breakLine = breakSymbolAwayFromLanding(outerPt, acrossDir, awayDir, widthMm).segs;
    breakInset = breakInsetMm(widthMm);
    const D = widthMm * Math.tan(BREAK_TILT); // 破れ線が届く最大深さ（mm、ウェル側）
    // 踊場との接続部に始点を固定した場合（右アーム入口＝bs===land1.numberStart、上アーム入口＝
    // bs===land2.numberStart）、そのアームは全非表示になるが、Dまでは各マス境界を
    // ウェル側から破れ線（対角）に触れる位置まで正確に描画できる分だけ描く
    // （pitch2/3は正規化単位のためmm換算）。
    if (inRight && bs === land1.numberStart) {
      for (let k = 1; k < run2.cells; k++) {
        const v = rV0 - k * pitch2;
        const depthMm = k * pitch2 * vAxisLen;
        if (depthMm >= D) break;
        out.treads.push(line(toWorld(runW, v), breakDiag.atDepth(depthMm)));
      }
    } else if (!inBottom && !inRight && bs === land2.numberStart) {
      for (let k = 1; k < run3.cells; k++) {
        const u = runW - k * pitch3;
        const depthMm = k * pitch3 * uAxisLen;
        if (depthMm >= D) break;
        out.treads.push(line(toWorld(u, aw), breakDiag.atDepth(depthMm)));
      }
    }
  }

  const limit1 = bpU1 != null ? bpU1 - breakInset / uAxisLen : Infinity;
  const limit2 = bpV  != null ? (rV0 - bpV) - breakInset / vAxisLen : (isInstall && inBottom ? 0 : Infinity);
  const limit3 = bpU3 != null ? (runW - bpU3) - breakInset / uAxisLen : (isInstall && !drawTop ? 0 : Infinity);

  const midBottom = (1 - aw + 1) / 2; // 下アームの幅方向中心（既存の配置基準。踊場1の初段もここに揃える）
  const midRight  = (runW + 1) / 2;   // 右アームの幅方向中心（踊場2の初段もここに揃える）
  // 下アーム（u 0→runW, v 1-aw→1）昇り→右。踊場1入口境界は踊場側が描く。
  emitRun(out, run1, pitch1, {
    treadLine: (u) => lineUV(u, 1 - aw, u, 1),
    labelPt:   (u) => toWorld(u, midBottom),
  }, { detail, limitMm: limit1 });
  if (drawLand1) {
    out.treads.push(lineUV(runW, 1 - aw, runW, 1));  // 踊場1入口境界（下アーム側）
    out.treads.push(lineUV(runW, 1 - aw, 1, 1 - aw)); // 踊場1出口境界（右アーム側）
    // 初段=下手側（下アーム）と同じ幅方向位置・同じ離れ（pitch1基準）で入口境界線近くに置く
    emitTurn(out, land1, { entryPt: () => toWorld(runW + NUM_GAP * pitch1, midBottom) }, { detail });
  }
  // 右アーム（u runW→1, v rV0→rV1）下→上。踊場2入口境界は踊場側が描く。
  if (drawRight) {
    emitRun(out, run2, pitch2, {
      treadLine: (mm) => lineUV(runW, rV0 - mm, 1, rV0 - mm),
      labelPt:   (mm) => toWorld(midRight, rV0 - mm),
    }, { detail, limitMm: limit2 });
  }
  if (drawLand2) {
    out.treads.push(lineUV(runW, aw, 1, aw));   // 踊場2入口境界（右アーム側）
    out.treads.push(lineUV(runW, 0, runW, aw)); // 踊場2出口境界（上アーム側）
    // 初段=下手側（右アーム）と同じ幅方向位置・同じ離れ（pitch2基準）で入口境界線近くに置く
    emitTurn(out, land2, { entryPt: () => toWorld(midRight, aw - NUM_GAP * pitch2) }, { detail });
  }
  // 上アーム（u runW→0, v 0→aw）右→左。左端（上階到達）は outline が描く。
  if (drawTop) {
    emitRun(out, run3, pitch3, {
      treadLine: (mm) => lineUV(runW - mm, 0, runW - mm, aw),
      labelPt:   (mm) => toWorld(runW - mm, aw / 2),
    }, { detail, limitMm: limit3 });
  }

  // 外周（C 字）＋ 中央ウェル
  const outline = [
    seg(toWorld(0, 1), toWorld(1, 1)),         // 下辺
    seg(toWorld(1, 1), toWorld(1, 0)),         // 右辺
    seg(toWorld(1, 0), toWorld(0, 0)),         // 上辺
    { ...seg(toWorld(0, 0), toWorld(0, aw)), thin: true },     // 左・上アーム端（設置階上階の最終段）
    { ...seg(toWorld(0, 1 - aw), toWorld(0, 1)), thin: true }, // 左・下アーム端（区画初段）
    // ウェル内周（開口は左）
    seg(toWorld(0, aw), toWorld(runW, aw)),
    seg(toWorld(runW, aw), toWorld(runW, 1 - aw)),
    seg(toWorld(runW, 1 - aw), toWorld(0, 1 - aw)),
  ];

  const vB = (1 - aw + 1) / 2;
  const arrows = [runArrow(toWorld(0, vB), toWorld(runW, vB), 'U')];
  // D（upper）はいちばん大きい踏面番号側（上アーム到達＝かみがた）を始点に、番号の小さい方へ向かう。
  if (drawTop) {
    arrows.push(isInstall
      ? runArrow(toWorld(runW, aw / 2), toWorld(0, aw / 2), '')
      : runArrow(toWorld(0, aw / 2), toWorld(runW, aw / 2), 'D'));
  }
  if (!isInstall) emitArrival(out, totalSteps, toWorld(0, aw / 2), detail);
  return { ...out, outline, arrows, breakLine };
}

/**
 * 階段の描画プリミティブ（ワールド座標）を生成する。タイプ別にディスパッチ。
 *
 * @param {import('@core').Stair} stair - 階段（スカラ属性のみ参照。cells は不使用）
 * @param {{ x1,y1,x2,y2 }} b - 設置エリアの包絡矩形（ワールド座標。呼び出し側で解決）
 * @param {{ view:'install'|'upper', detail:boolean, riser:number|null,
 *           spans?:{lengths:number[]}|null }} opts
 *   spans … セル割りから実測した区間長（measureStairSpans）。区間長指定の反映用。null なら合成。
 * @returns {{
 *   treads:{x1,y1,x2,y2}[], outline:{x1,y1,x2,y2,dashed}[],
 *   arrows:{x1,y1,x2,y2,labelX,labelY,label}[], breakLine:{x1,y1,x2,y2}[]|null,
 *   stepNumbers:{x,y,text}[],
 * }}
 */
export function buildStairGeometry(stair, b, opts) {
  const bi = insetStairBounds(stair, b, opts.view);
  if (stair.type === StairType.STRAIGHT_LANDING) return buildStraightLanding(stair, bi, opts);
  if (stair.type === StairType.SWITCHBACK)       return buildSwitchback(stair, bi, opts);
  if (stair.type === StairType.WINDING)          return buildWinding(stair, bi, opts);
  if (stair.type === StairType.L_TURN)           return buildLTurn(stair, bi, opts);
  if (stair.type === StairType.FLARED)           return buildLTurn(stair, bi, opts);
  if (stair.type === StairType.OPEN_WELL)        return buildOpenWell(stair, bi, opts);
  return buildStraight(stair, bi, opts);
}

// L字／中空きの正規化(u,v)→world 写像（buildLTurn/buildOpenWell と同一）。pt は fx,fy∈[0,1]→world。
function normToWorld(stair, pt) {
  return (u, v) => {
    const vv = stair.flip ? 1 - v : v;
    switch (stair.upDirection) {
      case 'left':  return pt(1 - u, vv);
      case 'down':  return pt(vv, u);
      case 'up':    return pt(vv, 1 - u);
      default:      return pt(u, vv);
    }
  };
}

// 各タイプの区間（直進部・踊場・周回部）を走行軸に平行な区間として返す。
// 返り値: [ [worldPointA, worldPointB, label, sectionsIndex|null], ... ]。sectionsIndex は
// stair.sections の対応インデックス（＝図中編集の対象。null は固定値・読取専用＝平踊場）。
// ラベル・編集値は踏面数（マス数）で表す（段数はたずねない）。
function segmentSpans(stair, b, spans) {
  const { parts } = stairParts(getSections(stair));
  const tread = stair.tread;
  switch (stair.type) {
    case StairType.STRAIGHT: {
      const f = makeFrame(stair, b);
      return [
        [f.pt(0, 0), f.pt(1, 0), `直進 踏面${parts[0].cells}`, 0],
      ];
    }
    case StairType.STRAIGHT_LANDING: {
      const f = makeFrame(stair, b);
      const [run1, , run2] = parts;
      const ms = measuredLengths(spans, 3);
      const L1 = ms ? ms[0] : run1.cells * tread;
      const LD = ms ? ms[1] : Math.max(4 * tread, MIN_LANDING);
      const L2 = ms ? ms[2] : run2.cells * tread;
      const budget = (L1 + LD + L2) || 1;
      const tAt = (mm) => mm / budget;
      return [
        [f.pt(0, 0),            f.pt(tAt(L1), 0),      `最初 踏面${run1.cells}`, 0],
        [f.pt(tAt(L1), 0),      f.pt(tAt(L1 + LD), 0), '踊り場',                 null],
        [f.pt(tAt(L1 + LD), 0), f.pt(1, 0),            `直進 踏面${run2.cells}`, 2],
      ];
    }
    case StairType.SWITCHBACK:
    case StairType.WINDING: {
      const f = makeFrame(stair, b);
      const [runA, turn, runB] = parts;
      const { tRun } = uTurnLayout(f, b, runA, runB, tread, spans);
      const isWinding = stair.type === StairType.WINDING;
      return [
        [f.pt(0, 0),    f.pt(tRun, 0), `往路 踏面${runA.cells}`, 0],
        [f.pt(tRun, 0), f.pt(1, 0),    isWinding ? `回り 踏面${turn.cells}` : '踊り場', isWinding ? 1 : null],
        [f.pt(0, 1),    f.pt(tRun, 1), `復路 踏面${runB.cells}`, 2],
      ];
    }
    case StairType.L_TURN:
    case StairType.FLARED: {
      const [run1, corner, run2] = parts;
      const W = b.x2 - b.x1, H = b.y2 - b.y1, aw = 0.45, runU = 1 - aw;
      const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
      const tw = normToWorld(stair, pt);
      const isFlared = stair.type === StairType.FLARED;
      return [
        [tw(0, 1),    tw(runU, 1), `アーム1 踏面${run1.cells}`,   0],
        [tw(runU, 1), tw(1, 1),    isFlared ? `曲がり 踏面${corner.cells}` : '踊り場', isFlared ? 1 : null],
        [tw(1, runU), tw(1, 0),    `アーム2 踏面${run2.cells}`, 2],
      ];
    }
    case StairType.OPEN_WELL: {
      const [run1, , run2, , run3] = parts;
      const W = b.x2 - b.x1, H = b.y2 - b.y1, aw = 0.3, runW = 1 - aw;
      const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
      const tw = normToWorld(stair, pt);
      return [
        [tw(0, 1),      tw(runW, 1),   `直進 踏面${run1.cells}`, 0],
        [tw(1, 1),      tw(1, 1 - aw), '踊り場',                 null],
        [tw(1, 1 - aw), tw(1, aw),     `直進 踏面${run2.cells}`, 2],
        [tw(1, aw),     tw(1, 0),      '踊り場',                 null],
        [tw(runW, 0),   tw(0, 0),      `直進 踏面${run3.cells}`, 4],
      ];
    }
    default:
      return [];
  }
}

/**
 * タイプ別区間を、図の外側（全長寸法のさらに外）へ踏面数／長さの寸法線として配置する
 * プリミティブ（AutoScaledFigure 形式）を返す。g は外側への張り出し量(mm)。
 * sections のインデックスを持つ区間は editable（図中クリックで踏面数を編集）にする。
 * spans はセル実測の区間長（measureStairSpans。null なら合成）。
 */
export function stairSegmentDims(stair, b, g, spans) {
  const segs = segmentSpans(stair, b, spans);
  if (segs.length === 0) return [];
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const OUT = g * 2; // 全長寸法（g）のさらに外側へ寸法鎖を並べる
  return segs.map(([a, c, label, index]) => {
    const edit = index != null ? { editable: true, target: 'sections', index } : {};
    if (Math.abs(a.x - c.x) >= Math.abs(a.y - c.y)) {
      const y = (a.y + c.y) / 2, out = y >= cy ? 1 : -1;
      return { type: 'dim', dir: 'h', from: a.x, to: c.x, at: y + out * OUT, label, ...edit };
    }
    const x = (a.x + c.x) / 2, out = x >= cx ? 1 : -1;
    return { type: 'dim', dir: 'v', from: a.y, to: c.y, at: x + out * OUT, label, labelSide: out < 0 ? 'left' : undefined, ...edit };
  });
}

export { getSections, defaultSections, stairParts, totalStepsFromSections };
