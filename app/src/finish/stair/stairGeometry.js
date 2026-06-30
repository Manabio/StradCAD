import { StairType } from '@core';

const BREAK_HEIGHT = 1600;   // mm — 破れ縁の断面高さ（FL+1600）
const MIN_LANDING  = 1200;   // mm — 踊り場の最小長さ（問題.md）

const seg  = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, dashed: false });
const line = (p, q) => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// 破れ縁（ブレークライン）: p→q を結ぶ線の中央に Z 字ノッチを入れた折れ線。
function zigzag(p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;     // 単位ベクトル
  const nx = -uy, ny = ux;                // 法線
  const a = Math.min(len * 0.15, 80);     // ノッチ寸法(mm)
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const m1 = { x: mx - ux * a * 0.5 + nx * a, y: my - uy * a * 0.5 + ny * a };
  const m2 = { x: mx + ux * a * 0.5 - nx * a, y: my + uy * a * 0.5 - ny * a };
  return [seg(p, m1), seg(m1, m2), seg(m2, q)];
}

// 設置エリア矩形 b から走行軸方向 t∈[0,1] / 幅方向 s∈[0,1] → ワールド点 の写像を作る。
function makeFrame(stair, b) {
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

// 共通の外周・破れ縁・矢印を生成する。
function frameDecor(f, topT, view) {
  const c00 = f.pt(0, 0), c01 = f.pt(0, 1), c10 = f.pt(topT, 0), c11 = f.pt(topT, 1);
  const outline = [seg(c00, c01), seg(c00, c10), seg(c01, c11)];
  let breakLine = null;
  if (view === 'install') breakLine = zigzag(c10, c11);
  else outline.push(seg(c10, c11));
  const aStart = f.pt(Math.min(0.08, topT * 0.2), 0.5);
  const aEnd   = f.pt(topT - 0.06, 0.5);
  const arrow  = { ...line(aStart, aEnd), label: view === 'install' ? 'U' : 'D' };
  return { outline, breakLine, arrows: [arrow] };
}

// ---- 直進階段 ----
function buildStraight(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const total = Math.max(1, stair.totalSteps);
  const breakStep = breakStepOf(total, riser, view);
  const shownSteps = view === 'install' ? breakStep : total;
  const topT = shownSteps / total;
  const nosingT = detail ? (stair.nosing / f.runLength) * (view === 'install' ? -1 : 1) : 0;

  const treads = [];
  for (let k = 1; k < shownSteps; k++) {
    const t = clamp01(k / total + nosingT);
    treads.push(line(f.pt(t, 0), f.pt(t, 1)));
  }

  const { outline, breakLine, arrows } = frameDecor(f, topT, view);

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownSteps; k++) {
      const c = f.pt((k - 0.5) / total, 0.85);
      stepNumbers.push({ x: c.x, y: c.y, text: String(k) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 踊り場付直進階段 ----
// 走行軸上に first 段 → 踊り場（平坦バンド）→ straight 段 を配置する。
function buildStraightLanding(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const s3 = stair.segments ?? {};
  const tread = stair.tread;
  const first    = Math.max(0, Math.round(s3.first ?? Math.floor(stair.totalSteps / 2)));
  const straight = Math.max(0, Math.round(s3.straight ?? (stair.totalSteps - first)));
  const landingLen = Math.max((s3.landing ?? 4) * tread, MIN_LANDING);
  const totalRisers = Math.max(1, first + straight);
  const budget = first * tread + landingLen + straight * tread || 1;
  const tAt = (mm) => mm / budget;

  const landingStart = first * tread;
  const landingEnd   = landingStart + landingLen;
  // 実段の境界 mm と段番号
  const stepBoundaries = [];
  for (let k = 1; k <= first; k++)    stepBoundaries.push({ mm: k * tread, num: k });
  for (let j = 1; j <= straight; j++) stepBoundaries.push({ mm: landingEnd + j * tread, num: first + j });

  const breakStep = breakStepOf(totalRisers, riser, view);
  const breakMm = breakStep <= first ? breakStep * tread : landingEnd + (breakStep - first) * tread;
  const shownMm = view === 'install' ? breakMm : budget;
  const topT = tAt(shownMm);
  const nosingMm = detail ? stair.nosing * (view === 'install' ? -1 : 1) : 0;

  const treads = [];
  const pushLineAt = (mm) => {
    if (mm <= 1e-6 || mm >= shownMm - 1e-6) return;
    const t = clamp01(tAt(mm));
    treads.push(line(f.pt(t, 0), f.pt(t, 1)));
  };
  for (const sb of stepBoundaries) pushLineAt(sb.mm + nosingMm);
  // 踊り場の前後縁（平坦バンドの輪郭）
  pushLineAt(landingStart);
  pushLineAt(landingEnd);

  const { outline, breakLine, arrows } = frameDecor(f, topT, view);

  const stepNumbers = [];
  if (detail) {
    for (const sb of stepBoundaries) {
      const centerMm = sb.num <= first
        ? (sb.num - 0.5) * tread
        : landingEnd + (sb.num - first - 0.5) * tread;
      if (centerMm >= shownMm) continue;
      const c = f.pt(tAt(centerMm), 0.85);
      stepNumbers.push({ x: c.x, y: c.y, text: String(sb.num) });
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 屈折階段（折り返し・180度）----
// 走行軸 t に沿って 往路(レーンA: s 0→0.5) と 復路(レーンB: s 0.5→1) を平行配置し、
// 走行端（t=tRun〜1）に両レーンをまたぐ踊り場を置く。
function buildSwitchback(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const tread = stair.tread;
  const total = Math.max(2, stair.totalSteps);
  const n = stair.segments?.straight ? Math.max(1, Math.round(stair.segments.straight)) : Math.ceil(total / 2);
  const m = Math.max(1, total - n); // 復路段数
  const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
  const landingDepth = Math.max(acrossLen * 0.5, tread); // 踊り場深さ（レーン幅相当）
  const budget = n * tread + landingDepth || 1;
  const tAt = (mm) => mm / budget;
  const tRun = tAt(n * tread); // 段部終端＝踊り場前縁
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));

  const breakStep = breakStepOf(total, riser, view);
  const inLaneA = breakStep <= n;
  const isInstall = view === 'install';

  const treads = [];
  // 往路（レーンA s:0→0.5）
  const shownA = isInstall && inLaneA ? breakStep : n;
  for (let k = 1; k < shownA; k++) treads.push(lineS(tAt(k * tread), 0, 0.5));
  // 復路（レーンB s:0.5→1、踊り場から base へ戻る）
  const drawB = !(isInstall && inLaneA);
  const shownB = isInstall ? Math.max(0, breakStep - n) : m;
  if (drawB) {
    for (let j = 1; j < shownB; j++) treads.push(lineS(tAt(n * tread - j * tread), 0.5, 1));
  }
  treads.push(lineS(tRun, 0, 1));                 // 踊り場前縁

  // 外周（base 側・両レーン外側・踊り場の三方）＋ 中央仕切り
  const c = (t, s) => f.pt(t, s);
  const outline = [
    seg(c(0, 0), c(0, 1)),       // base 側
    seg(c(0, 0), c(tRun, 0)),    // レーンA外側
    seg(c(0, 1), c(tRun, 1)),    // レーンB外側
    seg(c(tRun, 0), c(1, 0)),    // 踊り場側面A
    seg(c(tRun, 1), c(1, 1)),    // 踊り場側面B
    seg(c(1, 0), c(1, 1)),       // 踊り場奥
    seg(c(0, 0.5), c(tRun, 0.5)),// 中央仕切り（吹抜け側）
  ];

  let breakLine = null;
  if (isInstall) {
    breakLine = inLaneA
      ? zigzag(c(tAt(breakStep * tread), 0), c(tAt(breakStep * tread), 0.5))
      : zigzag(c(tAt(n * tread - (breakStep - n) * tread), 0.5), c(tAt(n * tread - (breakStep - n) * tread), 1));
  }

  const arrows = [{ ...line(f.pt(tAt(tread * 0.3), 0.25), f.pt(tRun - 0.02, 0.25)), label: 'U' }];
  if (drawB) arrows.push({ ...line(f.pt(tRun - 0.02, 0.75), f.pt(tAt(tread * 0.3), 0.75)), label: isInstall ? '' : 'D' });

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownA; k++) {
      const p = f.pt(tAt((k - 0.5) * tread), 0.25);
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (drawB) {
      for (let j = 1; j <= shownB; j++) {
        const p = f.pt(tAt(n * tread - (j - 0.5) * tread), 0.75);
        stepNumbers.push({ x: p.x, y: p.y, text: String(n + j) });
      }
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 回り階段（180度・折り返し部が回り段）----
// 屈折と同じ2レーン配置だが、走行端の踊り場を「回り段（扇形に放射する段）」に置き換える。
function buildWinding(stair, b, { view, detail, riser }) {
  const f = makeFrame(stair, b);
  const tread = stair.tread;
  const total = Math.max(3, stair.totalSteps);
  const w = stair.segments?.landing ? Math.max(1, Math.round(stair.segments.landing)) : 3;     // 回り段数
  const n = stair.segments?.straight ? Math.max(1, Math.round(stair.segments.straight)) : Math.ceil((total - w) / 2); // 片側直進段
  const m = Math.max(1, total - w - n); // 復路直進段
  const acrossLen = f.vertical ? (b.x2 - b.x1) : (b.y2 - b.y1);
  const turnDepth = Math.max(acrossLen * 0.5, tread);
  const budget = n * tread + turnDepth || 1;
  const tAt = (mm) => mm / budget;
  const tRun = tAt(n * tread);
  const lineS = (t, s0, s1) => line(f.pt(t, s0), f.pt(t, s1));

  const isInstall = view === 'install';
  const breakStep = breakStepOf(total, riser, view);
  const inLaneA = breakStep <= n;

  const treads = [];
  // 往路（レーンA）
  const shownA = isInstall && inLaneA ? breakStep : n;
  for (let k = 1; k < shownA; k++) treads.push(lineS(tAt(k * tread), 0, 0.5));

  const drawTurn = !(isInstall && inLaneA);
  // 回り段（扇形）: pivot=(tRun,0.5) から外周（s0辺→奥t1辺→s1辺）へ放射
  const P = f.pt(tRun, 0.5);
  const perim = (u) => {
    if (u <= 1 / 3) { const k = u / (1 / 3);       return f.pt(tRun + k * (1 - tRun), 0); }
    if (u <= 2 / 3) { const k = (u - 1 / 3) / (1 / 3); return f.pt(1, k); }
    const k = (u - 2 / 3) / (1 / 3);               return f.pt(1 - k * (1 - tRun), 1);
  };
  if (drawTurn) {
    treads.push(lineS(tRun, 0, 1)); // 回り段の前縁
    for (let j = 1; j < w; j++) treads.push(line(P, perim(j / w)));
  }

  // 復路（レーンB）: 回りを越えて破れる場合のみ
  const drawB = drawTurn && (!isInstall || breakStep > n + w);
  const shownB = isInstall ? Math.max(0, breakStep - n - w) : m;
  if (drawB) {
    for (let j = 1; j < shownB; j++) treads.push(lineS(tAt(n * tread - j * tread), 0.5, 1));
  }

  const c = (t, s) => f.pt(t, s);
  const outline = [
    seg(c(0, 0), c(0, 1)),        // base 側
    seg(c(0, 0), c(tRun, 0)),     // レーンA外側
    seg(c(0, 1), c(tRun, 1)),     // レーンB外側
    seg(c(tRun, 0), c(1, 0)),     // 回り部側面A
    seg(c(1, 0), c(1, 1)),        // 回り部奥
    seg(c(1, 1), c(tRun, 1)),     // 回り部側面B
    seg(c(0, 0.5), c(tRun, 0.5)), // 中央仕切り（吹抜け側）
  ];

  let breakLine = null;
  if (isInstall) {
    if (inLaneA) breakLine = zigzag(c(tAt(breakStep * tread), 0), c(tAt(breakStep * tread), 0.5));
    else if (breakStep > n + w) breakLine = zigzag(c(tAt(n * tread - (breakStep - n - w) * tread), 0.5), c(tAt(n * tread - (breakStep - n - w) * tread), 1));
  }

  const arrows = [{ ...line(f.pt(tAt(tread * 0.3), 0.25), f.pt(tRun - 0.02, 0.25)), label: 'U' }];
  if (drawB) arrows.push({ ...line(f.pt(tRun - 0.02, 0.75), f.pt(tAt(tread * 0.3), 0.75)), label: isInstall ? '' : 'D' });

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownA; k++) {
      const p = f.pt(tAt((k - 0.5) * tread), 0.25);
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (drawTurn) {
      for (let j = 1; j <= w; j++) {
        const p = perim((j - 0.5) / w);
        stepNumbers.push({ x: (p.x + P.x) / 2, y: (p.y + P.y) / 2, text: String(n + j) });
      }
    }
    if (drawB) {
      for (let j = 1; j <= shownB; j++) {
        const p = f.pt(tAt(n * tread - (j - 0.5) * tread), 0.75);
        stepNumbers.push({ x: p.x, y: p.y, text: String(n + w + j) });
      }
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 矩折階段（かねおれ・L字90度）----
// 正規化座標 (u,v)∈[0,1]² の L 字（arm1=水平/下、arm2=垂直/右、コーナーは(1,1)）を
// upDirection/flip で回転・鏡像して world へマップする。
// 曲がり階段（FLARED）= コーナーに w 段の扇形を持つ矩折。w=0 なら矩折（平踊り場）。
function buildLTurn(stair, b, { view, detail, riser }) {
  const total = Math.max(2, stair.totalSteps);
  const first    = stair.segments?.first    ? Math.max(1, Math.round(stair.segments.first))    : Math.ceil(total / 2);
  const straight = stair.segments?.straight ? Math.max(1, Math.round(stair.segments.straight)) : Math.max(1, total - first);
  const w = stair.type === StairType.FLARED ? Math.max(1, Math.round(stair.segments?.landing ?? 2)) : 0;
  const totalRisers = first + w + straight;
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

  const treads = [];
  const shownFirst = isInstall && inArm1 ? breakStep : first;
  for (let k = 1; k < shownFirst; k++) treads.push(lineUV(runU * k / first, runU, runU * k / first, 1));

  if (drawCorner) {
    treads.push(lineUV(runU, runU, runU, 1)); // arm1→コーナー前縁
    treads.push(lineUV(runU, runU, 1, runU)); // コーナー→arm2 前縁
    const pivot = toWorld(runU, runU);
    for (let i = 1; i < w; i++) treads.push(line(pivot, perimCorner(i / w))); // 扇形の段
  }
  if (drawArm2) {
    const shownStraight = isInstall ? Math.max(0, breakStep - first - w) : straight;
    for (let j = 1; j < shownStraight; j++) {
      const v = runU * (1 - j / straight);
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

  let breakLine = null;
  if (isInstall) {
    if (inArm1) {
      const u = runU * breakStep / first;
      breakLine = zigzag(toWorld(u, runU), toWorld(u, 1));
    } else if (breakStep <= first + w) {
      breakLine = zigzag(toWorld(runU, runU), toWorld(1, runU)); // 扇形内 → arm2 入口で破れ
    } else {
      const v = runU * (1 - (breakStep - first - w) / straight);
      breakLine = zigzag(toWorld(runU, v), toWorld(1, v));
    }
  }

  const midA = (runU + 1) / 2;
  const arrows = [{ ...line(toWorld(runU * 0.1, midA), toWorld(runU - 0.02, midA)), label: 'U' }];
  if (drawArm2) arrows.push({ ...line(toWorld(midA, runU - 0.02), toWorld(midA, 0.05)), label: isInstall ? '' : 'D' });

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownFirst; k++) {
      const p = toWorld(runU * (k - 0.5) / first, midA);
      stepNumbers.push({ x: p.x, y: p.y, text: String(k) });
    }
    if (drawCorner && w > 0) {
      const pivot = toWorld(runU, runU);
      for (let i = 1; i <= w; i++) {
        const q = perimCorner((i - 0.5) / w);
        stepNumbers.push({ x: (pivot.x + q.x) / 2, y: (pivot.y + q.y) / 2, text: String(first + i) });
      }
    }
    if (drawArm2) {
      const shownStraight = isInstall ? Math.max(0, breakStep - first - w) : straight;
      for (let j = 1; j <= shownStraight; j++) {
        const p = toWorld(midA, runU * (1 - (j - 0.5) / straight));
        stepNumbers.push({ x: p.x, y: p.y, text: String(first + w + j) });
      }
    }
  }
  return { treads, outline, arrows, breakLine, stepNumbers };
}

// ---- 中空き階段（OPEN_WELL）----
// 中央に吹抜け（well）を持ち、下→右→上 の3直進部が C 字に囲む。各直進部 n 段。
function buildOpenWell(stair, b, { view, detail, riser }) {
  const total = Math.max(3, stair.totalSteps);
  const n = stair.segments?.straight ? Math.max(1, Math.round(stair.segments.straight)) : Math.ceil(total / 3);
  const totalRisers = n * 3;
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

  const isInstall = view === 'install';
  const bs = breakStepOf(totalRisers, riser, view);
  const shownBottom = isInstall ? Math.min(bs, n) : n;
  const shownRight  = isInstall ? Math.max(0, Math.min(bs - n, n)) : n;
  const shownTop    = isInstall ? Math.max(0, Math.min(bs - 2 * n, n)) : n;

  const treads = [];
  // 下アーム（u 0→runW, v 1-aw→1）昇り→右
  for (let k = 1; k < shownBottom; k++) { const u = runW * k / n; treads.push(lineUV(u, 1 - aw, u, 1)); }
  // 右アーム（u runW→1, v 1→0）下→上
  for (let k = 1; k < shownRight; k++) { const v = 1 - k / n; treads.push(lineUV(runW, v, 1, v)); }
  // 上アーム（u runW→0, v 0→aw）右→左
  for (let k = 1; k < shownTop; k++) { const u = runW * (1 - k / n); treads.push(lineUV(u, 0, u, aw)); }

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

  let breakLine = null;
  if (isInstall) {
    if (bs <= n)        { const u = runW * bs / n;        breakLine = zigzag(toWorld(u, 1 - aw), toWorld(u, 1)); }
    else if (bs <= 2 * n) { const v = 1 - (bs - n) / n;     breakLine = zigzag(toWorld(runW, v), toWorld(1, v)); }
    else                { const u = runW * (1 - (bs - 2 * n) / n); breakLine = zigzag(toWorld(u, 0), toWorld(u, aw)); }
  }

  const arrows = [{ ...line(toWorld(runW * 0.1, (1 - aw + 1) / 2), toWorld(runW - 0.02, (1 - aw + 1) / 2)), label: 'U' }];
  if (shownTop > 0) arrows.push({ ...line(toWorld(runW - 0.02, aw / 2), toWorld(runW * 0.1, aw / 2)), label: isInstall ? '' : 'D' });

  const stepNumbers = [];
  if (detail) {
    for (let k = 1; k <= shownBottom; k++) { const p = toWorld(runW * (k - 0.5) / n, (1 - aw + 1) / 2); stepNumbers.push({ x: p.x, y: p.y, text: String(k) }); }
    for (let k = 1; k <= shownRight;  k++) { const p = toWorld((runW + 1) / 2, 1 - (k - 0.5) / n);       stepNumbers.push({ x: p.x, y: p.y, text: String(n + k) }); }
    for (let k = 1; k <= shownTop;    k++) { const p = toWorld(runW * (1 - (k - 0.5) / n), aw / 2);       stepNumbers.push({ x: p.x, y: p.y, text: String(2 * n + k) }); }
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
 *   arrow:{x1,y1,x2,y2,label}|null, breakLine:{x1,y1,x2,y2}[]|null,
 *   stepNumbers:{x,y,text}[],
 * }}
 */
export function buildStairGeometry(stair, b, opts) {
  if (stair.type === StairType.STRAIGHT_LANDING) return buildStraightLanding(stair, b, opts);
  if (stair.type === StairType.SWITCHBACK)       return buildSwitchback(stair, b, opts);
  if (stair.type === StairType.WINDING)          return buildWinding(stair, b, opts);
  if (stair.type === StairType.L_TURN)           return buildLTurn(stair, b, opts);
  if (stair.type === StairType.FLARED)           return buildLTurn(stair, b, opts);
  if (stair.type === StairType.OPEN_WELL)        return buildOpenWell(stair, b, opts);
  return buildStraight(stair, b, opts);
}
