// ================================================================
// CL偏芯（EccentricityDialog）の説明図プリミティブ生成（純関数）。
//
// 「厚み方向u・長さ方向v」のローカル座標で組み立て、最後に
//   isVertical ? (x,y)=(u,v) : (x,y)=(v,u)
// で実座標へ写像する（縦=垂直CLは壁が縦に走る図、横=水平CLは横に走る図）。
// 斜めCLは現行データモデルで内壁指定が成立しないため未対応（写像自体は角度非依存の形にしてある）。
//
// プリミティブ形式は structural/sectionFigure/AutoScaledFigure.jsx に準拠
// （structural/sectionFigure/sectionGeometry.js のプリミティブ仕様と同一）。
// ================================================================

const HALF_LEN = 150; // mm — 壁の模式表現（長さ方向vの半長。CLはこの全長で描く）
const BAND_LEN = 220; // mm — 下地・仕上げ帯の長さ（v方向。CLより短くして両端の延びを見せる）
const DIM_GAP  = 28;  // mm — 偏芯量の寸法線を帯の外側へ逃がす距離（v方向）

// ローカル(u,v) → 実座標(x,y)。
function mapPoint(isVertical, u, v) {
  return isVertical ? { x: u, y: v } : { x: v, y: u };
}

// ローカル矩形(uLo..uHi, vLo..vHi) → rect プリミティブ（x,y,w,h は実座標）。
function mapRect(isVertical, uLo, uHi, vLo, vHi, extra = {}) {
  const p1 = mapPoint(isVertical, uLo, vLo);
  const p2 = mapPoint(isVertical, uHi, vHi);
  return {
    type: 'rect',
    x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y),
    ...extra,
  };
}

/**
 * CL偏芯の説明図プリミティブを生成する（副作用なし。ライブプレビュー用に毎回再計算する想定）。
 * @param {{isVertical:boolean, e:number, b:number, fPos:number, fNeg:number,
 *   posLabel:string|null, negLabel:string|null}} params
 *   e = 下地帯中心のCLからの符号付きオフセット(mm)。b = 下地帯の深さ(mm)。
 *   fPos/fNeg = +側/-側の仕上げ厚(mm)。posLabel/negLabel = 各側の部屋名（無ければ null）。
 * @returns {object[]} AutoScaledFigure が描くプリミティブ配列
 */
export function eccentricityFigurePrimitives({ isVertical, e, b, fPos, fNeg, posLabel, negLabel }) {
  const backLo = e - b / 2, backHi = e + b / 2;
  const posLo  = backHi, posHi = backHi + fPos;
  const negLo  = backLo - fNeg, negHi = backLo;

  const vLo = -HALF_LEN, vHi = HALF_LEN;
  const bandVLo = -BAND_LEN / 2, bandVHi = BAND_LEN / 2;
  const dimAt = bandVHi + DIM_GAP;
  const dimDir = isVertical ? 'h' : 'v'; // u方向(厚み)の変位を測る向き。'h'ならat=y(=v)、'v'ならat=x(=v)で一致する

  const cl1 = mapPoint(isVertical, 0, vLo);
  const cl2 = mapPoint(isVertical, 0, vHi);

  const primitives = [
    // CL（一点鎖線）
    { type: 'line', x1: cl1.x, y1: cl1.y, x2: cl2.x, y2: cl2.y, dash: 'center', stroke: '#94a3b8' },
    // 下地帯
    mapRect(isVertical, backLo, backHi, bandVLo, bandVHi, { fill: '#e2e8f0', stroke: '#475569' }),
    // + 側仕上げ帯
    mapRect(isVertical, posLo, posHi, bandVLo, bandVHi, { fill: '#bfdbfe', stroke: '#2563eb' }),
    // - 側仕上げ帯
    mapRect(isVertical, negLo, negHi, bandVLo, bandVHi, { fill: '#fecaca', stroke: '#dc2626' }),
    // 偏芯量の寸法（CL(u=0) → 下地帯中心(u=e)）
    { type: 'dim', dir: dimDir, from: 0, to: e, at: dimAt, label: `${Math.round(e)}`, noTick: true },
  ];

  if (posLabel) {
    const p = mapPoint(isVertical, (posLo + posHi) / 2, 0);
    primitives.push({ type: 'text', x: p.x, y: p.y, text: posLabel, anchor: 'middle', fill: '#1e3a8a' });
  }
  if (negLabel) {
    const p = mapPoint(isVertical, (negLo + negHi) / 2, 0);
    primitives.push({ type: 'text', x: p.x, y: p.y, text: negLabel, anchor: 'middle', fill: '#7f1d1d' });
  }

  return primitives;
}
