import { StairType } from '@core';

const BREAK_HEIGHT = 1600;   // mm — 破れ縁の断面高さ（FL+1600）
const MIN_LANDING  = 1200;   // mm — 踊り場の最小長さ（問題.md）

const seg  = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, dashed: false });
const line = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
const clamp01 = (t) => Math.max(0, Math.min(1, t));

const LABEL_OUT = 350; // mm — U/D ラベルを始点（踏面1本目線）の外側へ押し出す距離
const NUM_GAP   = 1 / 6; // 段数数字を各段の基点側踏面線から離す量（段内比率。中央0.5の1/3）
const NUM_OUT   = 0.15;  // 2レーン階段で段数字を外周り端へ寄せる幅方向位置（外側s=0/1 からの距離）

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

// FL+1600 で切れる段（install ビューの破れ位置）。
function breakStepOf(totalRisers, riser, view) {
  if (view !== 'install') return totalRisers;
  return riser
    ? Math.min(totalRisers - 1, Math.max(1, Math.floor(BREAK_HEIGHT / riser)))
    : Math.max(1, Math.round(totalRisers * 0.6));
}

// 共通の外周・破れ縁・矢印を生成する。install view では両側線を破断線の実端点まで延長／短縮して繋ぎ、
// 踏面線・段数字が破断線の手前で止まるよう breakInset（mm）を返す。破れ線の見た目は、幅方向の
// 外周端（隣接壁のCL側）だけさらにはね出す（b は inset 後の設置エリア矩形）。
function frameDecor(f, topT, view, b) {
  const c00 = f.pt(0, 0), c01 = f.pt(0, 1), c10 = f.pt(topT, 0), c11 = f.pt(topT, 1);
  let breakLine = null;
  let sideEnd0 = c10, sideEnd1 = c11;
  let breakInset = 0; // mm
  if (view === 'install') {
    const { p1, p2 } = breakSymbol(c10, c11); // 全幅カットを傾けたZ字破断線（側線連結用・実寸）
    sideEnd0 = p1; sideEnd1 = p2;
    breakLine = breakSymbol(extendBreakEndToCL(c10, b), extendBreakEndToCL(c11, b)).segs; // 見た目はCLまではね出す
    breakInset = breakInsetMm(Math.hypot(c11.x - c10.x, c11.y - c10.y));
  }
  const outline = [seg(c00, c01), seg(c00, sideEnd0), seg(c01, sideEnd1)];
  if (view !== 'install') outline.push({ ...seg(c10, c11), thin: true }); // 設置階上階への到達辺（$）はthin
  // D（降り口）はいちばん大きい踏面番号側（かみがた）を始点にし、番号の小さい方へ向かう矢印にする。
  const arrow = view === 'install'
    ? runArrow(f.pt(0, 0.5), f.pt(topT, 0.5), 'U')
    : runArrow(f.pt(topT, 0.5), f.pt(0, 0.5), 'D');
  return { outline, breakLine, arrows: [arrow], breakInset };
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
 * 階段の「段数」モデル: stair.sections は歩行順の区間別・実段数の配列（直進では未使用）。
 * 踊り場（フラット区間）は常に1段。回り・曲がり区間は実リアル段数（w）をそのまま持つ。
 * 総段数 stair.totalSteps = sections の総和 + 1（最終区間が設置階上階への到達ぶんを1つ多く持つ）。
 * stair.sections が未設定（null）の場合は totalSteps から妥当な既定値を組み立てる。
 */
function defaultSections(stair) {
  const total = Math.max(2, stair.totalSteps);
  switch (stair.type) {
    case StairType.STRAIGHT:
      return [Math.max(1, total - 1)];
    case StairType.STRAIGHT_LANDING:
    case StairType.L_TURN: {
      const first = Math.max(1, Math.floor((total - 2) / 2));
      const straight = Math.max(1, total - 2 - first);
      return [first, 1, straight];
    }
    case StairType.SWITCHBACK: {
      const n = Math.max(1, Math.ceil((total - 2) / 2));
      const m = Math.max(1, total - 2 - n);
      return [n, 1, m];
    }
    case StairType.WINDING: {
      const w = 3;
      const n = Math.max(1, Math.ceil((total - w - 1) / 2));
      const m = Math.max(1, total - w - 1 - n);
      return [n, w, m];
    }
    case StairType.FLARED: {
      const w = 2;
      const first = Math.max(1, Math.ceil((total - w - 1) / 2));
      const straight = Math.max(1, total - w - 1 - first);
      return [first, w, straight];
    }
    case StairType.OPEN_WELL: {
      const n = Math.max(1, Math.ceil((total - 3) / 3));
      return [n, 1, n, 1, n];
    }
    default:
      return null;
  }
}
const getSections = (stair) => stair.sections ?? defaultSections(stair);

// 実段数(risers)から踏面数(spans)を求める共通ヘルパー（stair-model.md: 実段数=踏面数+1）。
// 直進部・アームが実段数から区間の等分数を求める処理は、タイプ側で再実装せず必ずこれを経由する。
function spansFromRisers_new(risers) {
  return Math.max(1, risers - 1);
}

// 踊り場付直進（first段→踊り場→straight段）の区間割り付け。実段数→踏面数(n-1)の換算は
// ここに集約し、buildStraightLanding／segmentSpansの両方から参照する。
function straightLandingLayout_new(sections, tread) {
  const first = sections[0], straight = sections[2];
  const firstSpans_new = spansFromRisers_new(first);
  const straightSpans_new = spansFromRisers_new(straight);
  const landingLen = Math.max(4 * tread, MIN_LANDING);
  const landingStart = firstSpans_new * tread;
  const landingEnd = landingStart + landingLen;
  const budget = landingEnd + straightSpans_new * tread || 1;
  return { first, straight, firstSpans_new, straightSpans_new, landingLen, landingStart, landingEnd, budget };
}

// ---- 直進階段 ----
function buildStraight(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const total = Math.max(1, stair.totalSteps); // 物理段数+1（上階到達分）
  const physical = getSections(stair)[0];      // 物理段数（実際に蹴上を持つ段）
  const spans_new = spansFromRisers_new(physical); // 踏面数（区間をn-1等分する）
  const breakStep = breakStepOf(physical, riser, view);
  const shownSteps = view === 'install' ? breakStep : physical;
  const topT = (shownSteps - 1) / spans_new;
  const nosingT = detail ? (stair.nosing / f.runLength) * (view === 'install' ? -1 : 1) : 0;

  const { outline, breakLine, arrows, breakInset } = frameDecor(f, topT, view, b);
  const treadLimitT = topT - breakInset / f.runLength; // 破れ線が両側線を切り始める手前

  const treads = [];
  for (let k = 1; k < shownSteps - 1; k++) {
    const t = clamp01(k / spans_new + nosingT);
    if (view === 'install' && t >= treadLimitT) break;
    treads.push(line(f.pt(t, 0), f.pt(t, 1)));
  }

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownSteps; k++) {
      const t = (k - 1 + NUM_GAP) / spans_new;
      if (view === 'install' && t >= treadLimitT) break;
      const c = f.pt(t, 0.85);
      stepNumbers.push({ x: c.x, y: c.y, text: String(k) });
    }
    if (view !== 'install') {
      // 設置階上階への到達（総段数=最終番号）。物理段数を持たない別ラベル。
      const end = f.pt(1, 0.85);
      stepNumbers.push({ x: end.x, y: end.y, text: String(total) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 踊り場付直進階段 ----
// 走行軸上に first 段 → 踊り場（1段・平坦バンド）→ straight 段 を配置する。
function buildStraightLanding(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const sections = getSections(stair);
  const tread = stair.tread;
  const { first, straight, firstSpans_new, straightSpans_new, landingStart, landingEnd, budget } =
    straightLandingLayout_new(sections, tread);
  const totalRisers = Math.max(1, first + straight);
  const tAt = (mm) => mm / budget;

  // 踏面境界（線を引く位置）。直進部1は踊り場入口境界まで含む（frameDecorのoutlineに含まれないため）。
  // 直進部2の最終境界（上階到達）はframeDecorのoutlineが描くため含めない。
  const treadLineMms = [];
  for (let k = 1; k <= firstSpans_new; k++)   treadLineMms.push(k * tread);
  for (let j = 1; j < straightSpans_new; j++) treadLineMms.push(landingEnd + j * tread);

  const breakStep = breakStepOf(totalRisers, riser, view);
  const breakMm = breakStep <= first
    ? (breakStep - 1) * tread
    : landingEnd + (breakStep - first - 1) * tread;
  const shownMm = view === 'install' ? breakMm : budget;
  const topT = tAt(shownMm);
  const nosingMm = detail ? stair.nosing * (view === 'install' ? -1 : 1) : 0;

  const { outline, breakLine, arrows, breakInset } = frameDecor(f, topT, view, b);
  const treadLimitMm = shownMm - breakInset; // 破れ線が両側線を切り始める手前

  const treads = [];
  const pushLineAt = (mm) => {
    if (mm <= 1e-6 || mm >= treadLimitMm - 1e-6) return;
    const t = clamp01(tAt(mm));
    treads.push(line(f.pt(t, 0), f.pt(t, 1)));
  };
  for (const mm of treadLineMms) pushLineAt(mm + nosingMm);
  // 踊り場の後縁（平坦バンドの輪郭。入口は直進部1の最終踏面線が兼ねる）
  pushLineAt(landingEnd);

  // 段数字位置（実段数ぶん。踊り場自身の1段を挟んで直進部2の番号を+1シフトする）
  const stepLabels = [];
  for (let k = 1; k <= first;    k++) stepLabels.push({ mm: (k - 1 + NUM_GAP) * tread, num: k });
  for (let j = 1; j <= straight; j++) stepLabels.push({ mm: landingEnd + (j - 1 + NUM_GAP) * tread, num: first + 1 + j });

  const stepNumbers = [];
  if (detail) {
    for (const sl of stepLabels) {
      if (sl.mm >= treadLimitMm) continue;
      const c = f.pt(tAt(sl.mm), 0.85);
      stepNumbers.push({ x: c.x, y: c.y, text: String(sl.num) });
    }
    const landingMid = (landingStart + landingEnd) / 2;
    if (landingMid < treadLimitMm) {
      const c = f.pt(tAt(landingMid), 0.85);
      stepNumbers.push({ x: c.x, y: c.y, text: String(first + 1) });
    }
    if (view !== 'install') {
      const end = f.pt(topT, 0.85);
      stepNumbers.push({ x: end.x, y: end.y, text: String(stair.totalSteps) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 屈折階段（折り返し・180度）----
// 走行軸 t に沿って 往路(レーンA: s 0→0.5) と 復路(レーンB: s 0.5→1) を平行配置し、
// 走行端（t=tRun〜1）に両レーンをまたぐ踊り場（1段）を置く。
function buildSwitchback(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const tread = stair.tread;
  const sections = getSections(stair);
  const n = sections[0], m = sections[2]; // 往路・復路の実段数
  const nSpans_new = spansFromRisers_new(n); // 往路の踏面数（区間長の基準。復路もこの長さに揃える）
  const total = Math.max(2, n + m);
  const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
  const landingDepth = Math.max(acrossLen * 0.5, tread); // 踊り場深さ（レーン幅相当）
  const budget = nSpans_new * tread + landingDepth || 1;
  const tAt = (mm) => mm / budget;
  const tRun = tAt(nSpans_new * tread); // 段部終端＝踊り場前縁
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));

  const isInstall = view === 'install';
  // install の破れは常に復路1段目（踊り場の先）。FL+1600/riser では位置決めしない。
  const breakStep = isInstall ? n + 1 : breakStepOf(total, riser, view);
  const inLaneA = breakStep <= n; // install では必ず復路側（false）

  const treads = [];
  // 往路（レーンA s:0→0.5）。踊り場前縁は下の明示pushが兼ねるため、最後の1本は描かない。
  const shownA = isInstall && inLaneA ? breakStep : n;
  for (let k = 1; k < shownA - 1; k++) treads.push(lineS(tAt(k * tread), 0, 0.5));
  // 復路（レーンB s:0.5→1、踊り場から base へ戻る）。同様に最後の1本（base到達）は描かない。
  const drawB = !(isInstall && inLaneA);
  const shownB = isInstall ? Math.max(0, breakStep - n) : m;
  if (drawB) {
    for (let j = 1; j < shownB - 1; j++) treads.push(lineS(tAt(nSpans_new * tread - j * tread), 0.5, 1));
  }
  treads.push(lineS(tRun, 0, 0.5));                // 踊り場前縁（往路側）
  treads.push(lineS(tRun, 0.5, 1));                // 踊り場前縁（復路側）

  // 外周（base 側・両レーン外側・踊り場の三方）＋ 中央仕切り。base側は往路出発／復路到達(設置階上階)で2分割する。
  const c = (t, s) => f.pt(t, s);
  const outline = [
    seg(c(0, 0), c(0, 0.5)),     // base側（往路出発）
    seg(c(0, 0.5), c(0, 1)),     // base側（復路到達＝設置階上階）
    seg(c(0, 0), c(tRun, 0)),    // レーンA外側
    seg(c(0, 1), c(tRun, 1)),    // レーンB外側
    seg(c(tRun, 0), c(1, 0)),    // 踊り場側面A
    seg(c(tRun, 1), c(1, 1)),    // 踊り場側面B
    seg(c(1, 0), c(1, 1)),       // 踊り場奥
    seg(c(0, 0.5), c(tRun, 0.5)),// 中央仕切り（吹抜け側）
  ];

  const btB = tAt(nSpans_new * tread - (breakStep - n) * tread); // 復路1段目（install時の破れ位置）
  let breakLine = null;
  // 復路レーンのみ（s0.5→1）。外側端（s=1、隣接壁側）だけCLまではね出す（中央仕切り側は吹抜けのため動かさない）。
  if (isInstall) breakLine = breakSymbol(c(btB, 0.5), extendBreakEndToCL(c(btB, 1), b)).segs;

  // U字矢印: install(U)は往路中心を上り→踊り場中心を通って破れ線まで。
  // upper(D)はいちばん大きい踏面番号側（復路基部＝かみがた）を始点に、番号の小さい方（往路基部）へ向かう。
  const tMid = (tRun + 1) / 2;                       // 踊り場中心（走行軸）
  const uEnd = isInstall ? btB : 0;                  // 破れ線位置 or 復路基部
  const arrows = [isInstall
    ? uTurnArrow([f.pt(0, 0.25), f.pt(tMid, 0.25), f.pt(tMid, 0.75), f.pt(uEnd, 0.75)], 'U')
    : uTurnArrow([f.pt(uEnd, 0.75), f.pt(tMid, 0.75), f.pt(tMid, 0.25), f.pt(0, 0.25)], 'D')];

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownA; k++) {
      const p = f.pt(tAt((k - 1 + NUM_GAP) * tread), NUM_OUT); // 往路: 外側 s=0 寄せ
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (shownA >= n) {
      // 踊り場自身の段数字（1段）
      const p = f.pt(tMid, 0.5);
      stepNumbers.push({ x: p.x, y: p.y, text: String(n + 1) });
    }
    // 復路: 踊り場の次から連番。
    if (drawB) {
      for (let j = 1; j <= shownB; j++) {
        const p = f.pt(tAt(nSpans_new * tread - (j - 1 + NUM_GAP) * tread), 1 - NUM_OUT); // 復路: 外側 s=1 寄せ
        stepNumbers.push({ x: p.x, y: p.y, text: String(n + 1 + j) });
      }
    }
    if (view !== 'install') {
      // 設置階上階への到達（総段数=最終番号）
      const p = f.pt(0, 1 - NUM_OUT);
      stepNumbers.push({ x: p.x, y: p.y, text: String(stair.totalSteps) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 回り階段（180度・折り返し部が回り段）----
// 屈折と同じ2レーン配置だが、走行端の踊り場を「回り段（扇形に放射する段。実段数w）」に置き換える。
function buildWinding(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const tread = stair.tread;
  const sections = getSections(stair);
  const n = sections[0], w = sections[1], m = sections[2]; // 往路・回り・復路の実段数
  const nSpans_new = spansFromRisers_new(n); // 往路の踏面数（区間長の基準。復路もこの長さに揃える）
  const wSpans_new = spansFromRisers_new(w); // 回り段の踏面数
  const total = Math.max(3, n + w + m);
  const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
  const turnDepth = Math.max(acrossLen * 0.5, tread);
  const budget = nSpans_new * tread + turnDepth || 1;
  const tAt = (mm) => mm / budget;
  const tRun = tAt(nSpans_new * tread);
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));

  const isInstall = view === 'install';
  // install の破れは常に復路1段目（回り段の先）。FL+1600/riser では位置決めしない。
  const breakStep = isInstall ? n + w + 1 : breakStepOf(total, riser, view);
  const inLaneA = breakStep <= n; // install では必ず復路側（false）

  const treads = [];
  // 往路（レーンA）。回り段入口境界は下の明示pushが兼ねるため、最後の1本は描かない。
  const shownA = isInstall && inLaneA ? breakStep : n;
  for (let k = 1; k < shownA - 1; k++) treads.push(lineS(tAt(k * tread), 0, 0.5));

  const drawTurn = !(isInstall && inLaneA);
  // 回り段（扇形）: pivot=(tRun,0.5) から外周（s0辺→奥t1辺→s1辺）へ放射
  const P = f.pt(tRun, 0.5);
  const perim = (u) => {
    if (u <= 1 / 3) { const k = u / (1 / 3);       return f.pt(tRun + k * (1 - tRun), 0); }
    if (u <= 2 / 3) { const k = (u - 1 / 3) / (1 / 3); return f.pt(1, k); }
    const k = (u - 2 / 3) / (1 / 3);               return f.pt(1 - k * (1 - tRun), 1);
  };
  if (drawTurn) {
    treads.push(lineS(tRun, 0, 0.5));   // 回り段入口境界（往路側）
    for (let j = 1; j < wSpans_new; j++) treads.push(line(P, perim(j / wSpans_new)));
    treads.push(lineS(tRun, 0.5, 1));   // 回り段出口境界（復路側）
  }

  // 復路（レーンB）: 回りを越えて破れる場合のみ。最後の1本（base到達）は描かない。
  const drawB = drawTurn && (!isInstall || breakStep > n + w);
  const shownB = isInstall ? Math.max(0, breakStep - n - w) : m;
  if (drawB) {
    for (let j = 1; j < shownB - 1; j++) treads.push(lineS(tAt(nSpans_new * tread - j * tread), 0.5, 1));
  }

  const c = (t, s) => f.pt(t, s);
  const outline = [
    seg(c(0, 0), c(0, 0.5)),      // base側（往路出発）
    seg(c(0, 0.5), c(0, 1)),      // base側（復路到達＝設置階上階）
    seg(c(0, 0), c(tRun, 0)),     // レーンA外側
    seg(c(0, 1), c(tRun, 1)),     // レーンB外側
    seg(c(tRun, 0), c(1, 0)),     // 回り部側面A
    seg(c(1, 0), c(1, 1)),        // 回り部奥
    seg(c(1, 1), c(tRun, 1)),     // 回り部側面B
    seg(c(0, 0.5), c(tRun, 0.5)), // 中央仕切り（吹抜け側）
  ];

  const btB = tAt(nSpans_new * tread - (breakStep - n - w) * tread); // 復路1段目（install時の破れ位置）
  let breakLine = null;
  // 復路レーンのみ（s0.5→1）。外側端（s=1、隣接壁側）だけCLまではね出す（中央仕切り側は吹抜けのため動かさない）。
  if (isInstall) breakLine = breakSymbol(c(btB, 0.5), extendBreakEndToCL(c(btB, 1), b)).segs;

  // U字矢印: 折り返し階段と同じ。install(U)は往路中心を上り→回り段中心を通って破れ線まで。
  // upper(D)はいちばん大きい踏面番号側（復路基部＝かみがた）を始点に、番号の小さい方（往路基部）へ向かう。
  const tMid = (tRun + 1) / 2;                       // 回り段中心（走行軸）
  const uEnd = isInstall ? btB : 0;                  // 破れ線位置 or 復路基部
  const arrows = [isInstall
    ? uTurnArrow([f.pt(0, 0.25), f.pt(tMid, 0.25), f.pt(tMid, 0.75), f.pt(uEnd, 0.75)], 'U')
    : uTurnArrow([f.pt(uEnd, 0.75), f.pt(tMid, 0.75), f.pt(tMid, 0.25), f.pt(0, 0.25)], 'D')];

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownA; k++) {
      const p = f.pt(tAt((k - 1 + NUM_GAP) * tread), NUM_OUT); // 往路: 外側 s=0 寄せ
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (drawTurn) {
      if (w <= 1) {
        // 平踊り場相当（実段差1）: 中央に1つだけ配置する（buildStraightLandingの踊り場と同じ扱い）
        const p = perim(0.5);
        stepNumbers.push({ x: p.x * 0.7 + P.x * 0.3, y: p.y * 0.7 + P.y * 0.3, text: String(n + 1) });
      } else {
        // 回り段: w-1個の踏面に1..w-1段目を外周(perim)側へ寄せて配置し、w段目（出口境界＝復路の初段扱い）は境界そのものに置く。
        for (let j = 1; j < w; j++) {
          const p = perim((j - 0.5) / wSpans_new);
          stepNumbers.push({ x: p.x * 0.7 + P.x * 0.3, y: p.y * 0.7 + P.y * 0.3, text: String(n + j) });
        }
        const pLast = perim(1);
        stepNumbers.push({ x: pLast.x * 0.7 + P.x * 0.3, y: pLast.y * 0.7 + P.y * 0.3, text: String(n + w) });
      }
    }
    // 復路: 回りの次から連番。最後の縁 n+w+m が上階床（登りきった先）。
    if (drawB) {
      for (let j = 1; j <= shownB; j++) {
        const p = f.pt(tAt(nSpans_new * tread - (j - 1 + NUM_GAP) * tread), 1 - NUM_OUT); // 復路: 外側 s=1 寄せ
        stepNumbers.push({ x: p.x, y: p.y, text: String(n + w + j) });
      }
    }
    if (view !== 'install') {
      // 設置階上階への到達（総段数=最終番号）
      const p = f.pt(0, 1 - NUM_OUT);
      stepNumbers.push({ x: p.x, y: p.y, text: String(stair.totalSteps) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 矩折階段（かねおれ・L字90度）----
// 正規化座標 (u,v)∈[0,1]² の L 字（arm1=水平/下、arm2=垂直/右、コーナーは(1,1)）を
// upDirection/flip で回転・鏡像して world へマップする。
// コーナーは実段数 w を持つ区間（L_TURNはw=1固定の平踊り場、FLAREDはw≥1の扇形回り段）。
function buildLTurn(stair, b, { view, detail, riser }) {
  const sections = getSections(stair);
  const first = sections[0], w = sections[1], straight = sections[2];
  const firstSpans_new = spansFromRisers_new(first);
  const wSpans_new = spansFromRisers_new(w);
  const straightSpans_new = spansFromRisers_new(straight);
  const isFlared = stair.type === StairType.FLARED;
  const totalRisers = first + straight + (isFlared ? w : 0); // 平踊り場(w=1)は蹴上げを持たないため段数に含めない
  const W = b.x2 - b.x1, H = b.y2 - b.y1;
  const aw = 0.45;        // アーム幅（正規化）
  const runU = 1 - aw;    // 直進部の終端（コーナー前縁）

  const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
  const toWorld = (u, v) => {
    const vv = stair.flip ? 1 - v : v;
    switch (stair.upDirection) {
      case 'left':  return pt(1 - u, vv);
      case 'down':  return pt(vv, u);
      case 'up':    return pt(vv, 1 - u);
      case 'right':
      default:      return pt(u, vv);
    }
  };
  const lineUV = (u0, v0, u1, v1) => line(toWorld(u0, v0), toWorld(u1, v1));
  // コーナー扇形の外周（(1,runU)→(1,1)→(runU,1)）を t∈[0,1] で辿る
  const perimCorner = (t) => t <= 0.5
    ? toWorld(1, runU + (t / 0.5) * (1 - runU))
    : toWorld(1 - ((t - 0.5) / 0.5) * (1 - runU), 1);

  const isInstall = view === 'install';
  const breakStep = breakStepOf(totalRisers, riser, view);
  const inArm1 = breakStep <= first;
  const drawCorner = !(isInstall && inArm1);
  const drawArm2 = !(isInstall && breakStep <= first + w);

  let breakLine = null;
  let breakCase = null; // 'arm1' | 'corner' | 'arm2' | null
  let breakInset = 0;   // mm
  if (isInstall) {
    let bp, bq;
    if (inArm1) {
      breakCase = 'arm1';
      const u = runU * breakStep / firstSpans_new;
      bp = toWorld(u, runU); bq = toWorld(u, 1);
    } else if (breakStep <= first + w) {
      breakCase = 'corner';
      bp = toWorld(runU, runU); bq = toWorld(1, runU); // 扇形内 → arm2 入口で破れ
    } else {
      breakCase = 'arm2';
      const v = runU * (1 - (breakStep - first - w) / straightSpans_new);
      bp = toWorld(runU, v); bq = toWorld(1, v);
    }
    // 外周（隣接壁）側の端だけCLまではね出す（吹抜け側の端はそのまま）。
    breakLine = breakSymbol(extendBreakEndToCL(bp, b), extendBreakEndToCL(bq, b)).segs;
    breakInset = breakInsetMm(Math.hypot(bq.x - bp.x, bq.y - bp.y));
  }

  // 破れ線が傾くぶん、踏面線・段数字は手前で止める（arm1/arm2 のみ。コーナー扇形は既存どおり粗判定）
  const uAxisLen = Math.hypot(toWorld(1, runU).x - toWorld(0, runU).x, toWorld(1, runU).y - toWorld(0, runU).y);
  const vAxisLen = Math.hypot(toWorld(runU, 1).x - toWorld(runU, 0).x, toWorld(runU, 1).y - toWorld(runU, 0).y);
  const arm1ULimit = breakCase === 'arm1' ? (runU * breakStep / firstSpans_new) - breakInset / uAxisLen : Infinity;
  const arm2VLimit = breakCase === 'arm2'
    ? runU * (1 - (breakStep - first - w) / straightSpans_new) + breakInset / vAxisLen
    : -Infinity;

  const treads = [];
  // アーム1（コーナー前縁は下の明示pushが兼ねるため、最後の1本は描かない）
  const shownFirst = isInstall && inArm1 ? breakStep : first;
  for (let k = 1; k < shownFirst - 1; k++) {
    const u = runU * k / firstSpans_new;
    if (u >= arm1ULimit) break;
    treads.push(lineUV(u, runU, u, 1));
  }

  if (drawCorner) {
    treads.push(lineUV(runU, runU, runU, 1)); // arm1→コーナー前縁
    treads.push(lineUV(runU, runU, 1, runU)); // コーナー→arm2 前縁
    const pivot = toWorld(runU, runU);
    for (let i = 1; i < wSpans_new; i++) treads.push(line(pivot, perimCorner(i / wSpans_new))); // 扇形の段
  }
  if (drawArm2) {
    // arm2 far端（上階到達）はoutlineが描くため、最後の1本は描かない。
    const shownStraight = isInstall ? Math.max(0, breakStep - first - w) : straight;
    for (let j = 1; j < shownStraight - 1; j++) {
      const v = runU * (1 - j / straightSpans_new);
      if (v <= arm2VLimit) break;
      treads.push(lineUV(runU, v, 1, v));
    }
  }

  const outline = [
    seg(toWorld(0, runU), toWorld(0, 1)),       // arm1 base 端
    seg(toWorld(0, 1),    toWorld(1, 1)),       // arm1 外側
    seg(toWorld(1, 1),    toWorld(1, 0)),       // arm2 外側
    seg(toWorld(1, 0),    toWorld(runU, 0)),    // arm2 far 端
    seg(toWorld(runU, 0), toWorld(runU, runU)), // 内側（吹抜け側・縦）
    seg(toWorld(runU, runU), toWorld(0, runU)), // 内側（吹抜け側・横）
  ];

  const midA = (runU + 1) / 2;
  const arrows = [runArrow(toWorld(0, midA), toWorld(runU, midA), 'U')];
  // D（upper）はいちばん大きい踏面番号側（arm2到達＝かみがた）を始点に、番号の小さい方（コーナー側）へ向かう。
  if (drawArm2) {
    arrows.push(isInstall
      ? runArrow(toWorld(midA, runU), toWorld(midA, 0), '')
      : runArrow(toWorld(midA, 0), toWorld(midA, runU), 'D'));
  }

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownFirst; k++) {
      const u = runU * (k - 1 + NUM_GAP) / firstSpans_new;
      if (u >= arm1ULimit) break;
      const p = toWorld(u, midA);
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (drawCorner) {
      const pivot = toWorld(runU, runU);
      if (w <= 1) {
        // 平踊り場（実段差1）: 中央に1つだけ配置する（buildStraightLandingの踊り場と同じ扱い）
        const q = perimCorner(0.5);
        stepNumbers.push({ x: (pivot.x + q.x) / 2, y: (pivot.y + q.y) / 2, text: String(first + 1) });
      } else {
        // 回り段（実段差w≥2）: w-1個の踏面に1..w-1段目を配置し、w段目（arm2側境界）は境界そのものに置く。
        for (let i = 1; i < w; i++) {
          const q = perimCorner((i - 0.5) / wSpans_new);
          stepNumbers.push({ x: (pivot.x + q.x) / 2, y: (pivot.y + q.y) / 2, text: String(first + i) });
        }
        const qLast = perimCorner(1);
        stepNumbers.push({ x: (pivot.x + qLast.x) / 2, y: (pivot.y + qLast.y) / 2, text: String(first + w) });
      }
    }
    if (drawArm2) {
      const shownStraight = isInstall ? Math.max(0, breakStep - first - w) : straight;
      for (let j = 1; j <= shownStraight; j++) {
        const v = runU * (1 - (j - 1 + NUM_GAP) / straightSpans_new);
        if (v <= arm2VLimit) break;
        const p = toWorld(midA, v);
        stepNumbers.push({ x: p.x, y: p.y, text: String(first + w + j) });
      }
      if (view !== 'install') {
        // 設置階上階への到達（総段数=最終番号）
        const p = toWorld(midA, 0);
        stepNumbers.push({ x: p.x, y: p.y, text: String(stair.totalSteps) });
      }
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 中空き階段（OPEN_WELL）----
// 中央に吹抜け（well）を持ち、下→踊り場1→右→踊り場2→上 の3直進部+2踊り場がC字に囲む。
function buildOpenWell(stair, b, { view, detail, riser }) {
  const sections = getSections(stair);
  const n1 = sections[0], n2 = sections[2], n3 = sections[4]; // 下・右・上の実段数
  const n1Spans_new = spansFromRisers_new(n1);
  const n2Spans_new = spansFromRisers_new(n2);
  const n3Spans_new = spansFromRisers_new(n3);
  const totalRisers = n1 + n2 + n3; // 2つの踊り場（各1段）は蹴上げを持たないため段数に含めない
  const W = b.x2 - b.x1, H = b.y2 - b.y1;
  const aw = 0.3;          // アーム幅（正規化）
  const runW = 1 - aw;     // 下/上アームの走行終端（右ストリップ手前）

  const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
  const toWorld = (u, v) => {
    const vv = stair.flip ? 1 - v : v;
    switch (stair.upDirection) {
      case 'left':  return pt(1 - u, vv);
      case 'down':  return pt(vv, u);
      case 'up':    return pt(vv, 1 - u);
      case 'right':
      default:      return pt(u, vv);
    }
  };
  const lineUV = (u0, v0, u1, v1) => line(toWorld(u0, v0), toWorld(u1, v1));

  // 右アーム（中間アーム）はコーナー踊り場が両端に接するため走行区間を aw ぶん両側短縮する。
  const rV0 = 1 - aw, rV1 = aw, rSpan = rV0 - rV1; // v: rV0(踊り場1側)→rV1(踊り場2側)

  const isInstall = view === 'install';
  const bs = breakStepOf(totalRisers, riser, view);
  const shownBottom = isInstall ? Math.min(bs, n1) : n1;
  const shownRight  = isInstall ? Math.max(0, Math.min(bs - n1, n2)) : n2;
  const shownTop    = isInstall ? Math.max(0, Math.min(bs - n1 - n2, n3)) : n3;
  const landing1 = bs > n1;      // 踊り場1（下→右）
  const landing2 = bs > n1 + n2; // 踊り場2（右→上）

  let breakLine = null;
  let breakCase = null; // 'bottom' | 'right' | 'top' | null
  let breakInset = 0;   // mm
  if (isInstall) {
    let bp, bq;
    if (bs <= n1)           { breakCase = 'bottom'; const u = runW * bs / n1Spans_new; bp = toWorld(u, 1 - aw); bq = toWorld(u, 1); }
    else if (bs <= n1 + n2) { breakCase = 'right';   const v = rV0 - (bs - n1) * (rSpan / n2Spans_new); bp = toWorld(runW, v); bq = toWorld(1, v); }
    else                    { breakCase = 'top';     const u = runW * (1 - (bs - n1 - n2) / n3Spans_new); bp = toWorld(u, 0); bq = toWorld(u, aw); }
    // 外周（隣接壁）側の端だけCLまではね出す（吹抜け側の端はそのまま）。
    breakLine = breakSymbol(extendBreakEndToCL(bp, b), extendBreakEndToCL(bq, b)).segs;
    breakInset = breakInsetMm(Math.hypot(bq.x - bp.x, bq.y - bp.y));
  }

  // 破れ線が傾くぶん、踏面線・段数字は手前で止める。
  const uAxisLen = Math.hypot(toWorld(1, 0).x - toWorld(0, 0).x, toWorld(1, 0).y - toWorld(0, 0).y);
  const vAxisLen = Math.hypot(toWorld(0, 1).x - toWorld(0, 0).x, toWorld(0, 1).y - toWorld(0, 0).y);
  const bottomULimit = breakCase === 'bottom' ? (runW * bs / n1Spans_new) - breakInset / uAxisLen : Infinity;
  const rightVLimit  = breakCase === 'right'  ? (rV0 - (bs - n1) * (rSpan / n2Spans_new)) + breakInset / vAxisLen : -Infinity;
  const topULimit    = breakCase === 'top'    ? (runW * (1 - (bs - n1 - n2) / n3Spans_new)) + breakInset / uAxisLen : -Infinity;

  const treads = [];
  // 下アーム（u 0→runW, v 1-aw→1）昇り→右。踊り場1入口境界は下の明示pushが兼ねるため、最後の1本は描かない。
  for (let k = 1; k < shownBottom - 1; k++) {
    const u = runW * k / n1Spans_new;
    if (u >= bottomULimit) break;
    treads.push(lineUV(u, 1 - aw, u, 1));
  }
  if (landing1) {
    treads.push(lineUV(runW, 1 - aw, runW, 1));   // 踊り場1入口境界（下アーム側）
    treads.push(lineUV(runW, 1 - aw, 1, 1 - aw));  // 踊り場1出口境界（右アーム側）
  }
  // 右アーム（u runW→1, v rV0→rV1）下→上。踊り場2入口境界は下の明示pushが兼ねるため、最後の1本は描かない。
  for (let k = 1; k < shownRight - 1; k++) {
    const v = rV0 - k * (rSpan / n2Spans_new);
    if (v <= rightVLimit) break;
    treads.push(lineUV(runW, v, 1, v));
  }
  if (landing2) {
    treads.push(lineUV(runW, aw, 1, aw));         // 踊り場2入口境界（右アーム側）
    treads.push(lineUV(runW, 0, runW, aw));       // 踊り場2出口境界（上アーム側）
  }
  // 上アーム（u runW→0, v 0→aw）右→左。左端（上階到達）はoutlineが描くため、最後の1本は描かない。
  for (let k = 1; k < shownTop - 1; k++) {
    const u = runW * (1 - k / n3Spans_new);
    if (u <= topULimit) break;
    treads.push(lineUV(u, 0, u, aw));
  }

  // 外周（C 字）＋ 中央ウェル
  const outline = [
    seg(toWorld(0, 1), toWorld(1, 1)),         // 下辺
    seg(toWorld(1, 1), toWorld(1, 0)),         // 右辺
    seg(toWorld(1, 0), toWorld(0, 0)),         // 上辺
    seg(toWorld(0, 0), toWorld(0, aw)),        // 左・上アーム端
    seg(toWorld(0, 1 - aw), toWorld(0, 1)),    // 左・下アーム端
    // ウェル内周（開口は左）
    seg(toWorld(0, aw), toWorld(runW, aw)),
    seg(toWorld(runW, aw), toWorld(runW, 1 - aw)),
    seg(toWorld(runW, 1 - aw), toWorld(0, 1 - aw)),
  ];

  const vB = (1 - aw + 1) / 2;
  const arrows = [runArrow(toWorld(0, vB), toWorld(runW, vB), 'U')];
  // D（upper）はいちばん大きい踏面番号側（上アーム到達＝かみがた）を始点に、番号の小さい方へ向かう。
  if (shownTop > 0) {
    arrows.push(isInstall
      ? runArrow(toWorld(runW, aw / 2), toWorld(0, aw / 2), '')
      : runArrow(toWorld(0, aw / 2), toWorld(runW, aw / 2), 'D'));
  }

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownBottom; k++) {
      const u = runW * (k - 1 + NUM_GAP) / n1Spans_new;
      if (u >= bottomULimit) break;
      const p = toWorld(u, (1 - aw + 1) / 2);
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (landing1) {
      const p = toWorld((runW + 1) / 2, (1 - aw + 1) / 2);
      stepNumbers.push({ x: p.x, y: p.y, text: String(n1 + 1) });
    }
    for (let k = 1; k <= shownRight; k++) {
      const v = rV0 - (k - 1 + NUM_GAP) * (rSpan / n2Spans_new);
      if (v <= rightVLimit) break;
      const p = toWorld((runW + 1) / 2, v);
      stepNumbers.push({ x: p.x, y: p.y, text: String(n1 + 1 + k) });
    }
    if (landing2) {
      const p = toWorld((runW + 1) / 2, aw / 2);
      stepNumbers.push({ x: p.x, y: p.y, text: String(n1 + n2 + 2) });
    }
    for (let k = 1; k <= shownTop; k++) {
      const u = runW * (1 - (k - 1 + NUM_GAP) / n3Spans_new);
      if (u <= topULimit) break;
      const p = toWorld(u, aw / 2);
      stepNumbers.push({ x: p.x, y: p.y, text: String(n1 + n2 + 2 + k) });
    }
    if (!isInstall) {
      // 設置階上階への到達（総段数=最終番号）
      const p = toWorld(0, aw / 2);
      stepNumbers.push({ x: p.x, y: p.y, text: String(stair.totalSteps) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

/**
 * 階段の描画プリミティブ（ワールド座標）を生成する。タイプ別にディスパッチ。
 *
 * @param {import('@core').Stair} stair - 階段（スカラ属性のみ参照。cells は不使用）
 * @param {{ x1,y1,x2,y2 }} b - 設置エリアの包絡矩形（ワールド座標。呼び出し側で解決）
 * @param {{ view:'install'|'upper', detail:boolean, riser:number|null }} opts
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

// 各タイプの区間（踊り場・回り部・各アーム・各直進部）を走行軸に平行な区間として返す。
// 返り値: [ [worldPointA, worldPointB, label, sectionsIndex|null], ... ]。sectionsIndex は
// stair.sections の対応インデックス（＝図中編集の対象。null は固定値・読取専用＝踊り場の1段）。
function segmentSpans(stair, b) {
  const sections = getSections(stair);
  const tread = stair.tread;
  switch (stair.type) {
    case StairType.STRAIGHT: {
      const f = makeFrame(stair, b);
      return [
        [f.pt(0, 0), f.pt(1, 0), `直進 ${sections[0]}段`, 0],
      ];
    }
    case StairType.STRAIGHT_LANDING: {
      const f = makeFrame(stair, b);
      const { first, straight, landingStart: lStart, landingEnd: lEnd, budget } =
        straightLandingLayout_new(sections, tread);
      const tAt = (mm) => mm / budget;
      return [
        [f.pt(0, 0),            f.pt(tAt(lStart), 0), `最初 ${first}段`, 0],
        [f.pt(tAt(lStart), 0),  f.pt(tAt(lEnd), 0),   '踊り場',          null],
        [f.pt(tAt(lEnd), 0),    f.pt(1, 0),           `直進 ${straight}段`, 2],
      ];
    }
    case StairType.SWITCHBACK: {
      const f = makeFrame(stair, b);
      const n = sections[0], m = sections[2];
      const nSpans_new = spansFromRisers_new(n);
      const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
      const landingDepth = Math.max(acrossLen * 0.5, tread);
      const budget = nSpans_new * tread + landingDepth || 1;
      const tRun = (nSpans_new * tread) / budget;
      return [
        [f.pt(0, 0),    f.pt(tRun, 0), `往路 ${n}段`, 0],
        [f.pt(tRun, 0), f.pt(1, 0),    '踊り場',      null],
        [f.pt(0, 1),    f.pt(tRun, 1), `復路 ${m}段`, 2],
      ];
    }
    case StairType.WINDING: {
      const f = makeFrame(stair, b);
      const n = sections[0], w = sections[1], m = sections[2];
      const nSpans_new = spansFromRisers_new(n);
      const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
      const turnDepth = Math.max(acrossLen * 0.5, tread);
      const budget = nSpans_new * tread + turnDepth || 1;
      const tRun = (nSpans_new * tread) / budget;
      return [
        [f.pt(0, 0),    f.pt(tRun, 0), `直進 ${n}段`, 0],
        [f.pt(tRun, 0), f.pt(1, 0),    `回り ${w}段`, 1],
        [f.pt(0, 1),    f.pt(tRun, 1), `直進 ${m}段`, 2],
      ];
    }
    case StairType.L_TURN:
    case StairType.FLARED: {
      const first = sections[0], w = sections[1], straight = sections[2];
      const W = b.x2 - b.x1, H = b.y2 - b.y1, aw = 0.45, runU = 1 - aw;
      const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
      const tw = normToWorld(stair, pt);
      const isFlared = stair.type === StairType.FLARED;
      return [
        [tw(0, 1),    tw(runU, 1), `アーム1 ${first}段`,   0],
        [tw(runU, 1), tw(1, 1),    isFlared ? `曲がり ${w}段` : '踊り場', isFlared ? 1 : null],
        [tw(1, runU), tw(1, 0),    `アーム2 ${straight}段`, 2],
      ];
    }
    case StairType.OPEN_WELL: {
      const n1 = sections[0], n2 = sections[2], n3 = sections[4];
      const W = b.x2 - b.x1, H = b.y2 - b.y1, aw = 0.3, runW = 1 - aw;
      const pt = (fx, fy) => ({ x: b.x1 + fx * W, y: b.y1 + fy * H });
      const tw = normToWorld(stair, pt);
      return [
        [tw(0, 1),      tw(runW, 1),   `直進 ${n1}段`, 0],
        [tw(1, 1),      tw(1, 1 - aw), '踊り場',       null],
        [tw(1, 1 - aw), tw(1, aw),     `直進 ${n2}段`, 2],
        [tw(1, aw),     tw(1, 0),      '踊り場',       null],
        [tw(runW, 0),   tw(0, 0),      `直進 ${n3}段`, 4],
      ];
    }
    default:
      return [];
  }
}

/**
 * タイプ別区間を、図の外側（全長寸法のさらに外）へ段数／長さの寸法線として配置する
 * プリミティブ（AutoScaledFigure 形式）を返す。g は外側への張り出し量(mm)。
 * sections のインデックスを持つ区間は editable（図中クリックで stair.sections[index] を編集）にする。
 * STRAIGHT（内訳なし）は空配列。
 */
export function stairSegmentDims(stair, b, g) {
  const spans = segmentSpans(stair, b);
  if (spans.length === 0) return [];
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const OUT = g * 2; // 全長寸法（g）のさらに外側へ寸法鎖を並べる
  return spans.map(([a, c, label, index]) => {
    const edit = index != null ? { editable: true, target: 'sections', index } : {};
    if (Math.abs(a.x - c.x) >= Math.abs(a.y - c.y)) {
      const y = (a.y + c.y) / 2, out = y >= cy ? 1 : -1;
      return { type: 'dim', dir: 'h', from: a.x, to: c.x, at: y + out * OUT, label, ...edit };
    }
    const x = (a.x + c.x) / 2, out = x >= cx ? 1 : -1;
    return { type: 'dim', dir: 'v', from: a.y, to: c.y, at: x + out * OUT, label, labelSide: out < 0 ? 'left' : undefined, ...edit };
  });
}

export { getSections, defaultSections, spansFromRisers_new };
