/**
 * 展開図Konvaレンダラ（figurePrimitivesKonva.jsx）のL字の角の外角を閉じる純ロジック（react-konva非依存
 * ＝node:testから単体import可）。dashPhase.js/clMoveMath.jsと同じ切り出し方針。
 *
 * canvasのlineCapはbutt（未指定）のままにしつつ、直交・斜めに取り合う2本の線の交点で生じる
 * すき間（butt capの角に半幅ぶんの三角欠けが出る）を、各線を「自分の方向へ角の外側へ延長」する
 * ことで閉じる（案2・第1弾）。ジオメトリ（モデルmm座標）は一切変更せず、Konvaへ渡す直前のpx座標
 * だけを角の2点に限って動かす——resolveJoinedLinePointsは延長が入ったlineだけを載せた差分Mapを
 * 返し、renderFigurePrimitivesはそれを1回だけ計算してrenderOneへ渡す。
 *
 * 対象は type==='line' かつ破線でない(p.dash無し)線分のみ。モデルmm座標で端点が厳密一致
 * （|Δ|≤MM_MATCH_EPS）する点に、ちょうど2本の端点だけが集まる角だけを閉じる——3本以上が集まる点・
 * 端点が相手の内部にあるT字・交差は対象外（endpoint-to-endpointの厳密一致でしか拾わないため、
 * これらは自然に候補から漏れる）。
 *
 * p.stroke（線の色）は見ない——現状lineに色付きは存在しないため。異色の線が角で取り合う場合、
 * どちらの色が角の延長区間を覆うかはprimitives配列の描画順（上塗り）で決まる（本モジュールは関知しない）。
 */

// 端点のmm厳密一致とみなす許容差（仕様固定値）。
export const MM_MATCH_EPS = 1e-6;
// この px 幅以下を「細線」とみなす（pxリテラルでの判定であり、weight:'thin'指定かどうかではない）。
// 校正値pxPerMm≳11.6のような高倍率ではweight:'thin'でも実際のpx幅が2px以上になり、このガードは
// 効かなくなる（両方thinでも延長される）——仕様上は「見た目が細い線同士」を意図しており、
// pxベースの判定はその近似として妥当という前提。
export const THIN_PX = 1;
// 延長量のクランプ係数（鋭角での発散防止。clampMax = 係数 * max(wA, wB)）。
const EXTEND_CLAMP_FACTOR = 2;
// 「角から外向きの単位ベクトル」同士のsinがこれ未満なら同一直線上とみなし、何もしない。
const COLINEAR_SIN_EPS = 1e-6;

/** 線のpx幅（唯一の情報源。figurePrimitivesKonva.jsxはこれをimportして使う）。 */
export function weightPx(p, lineWeightsPx) {
  if (p.weight && lineWeightsPx?.[p.weight] != null) return lineWeightsPx[p.weight];
  return p.width ?? 1;
}

// 破線でないtype==='line'のうち、モデルmmで長さ0でないものだけを候補にする
// （長さ0は方向が定義できずNaN/Infinityの元になるため対象外）。
function collectCandidates(primitives) {
  const cands = [];
  for (let i = 0; i < primitives.length; i++) {
    const p = primitives[i];
    if (p.type !== 'line' || p.dash) continue;
    const lenMm = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
    if (!(lenMm > MM_MATCH_EPS)) continue;
    cands.push({ idx: i, p });
  }
  return cands;
}

// mm座標をMM_MATCH_EPS単位の格子へ丸めたキー（厳密一致judgementの実装）。
function pointKey(x, y) {
  return `${Math.round(x / MM_MATCH_EPS)}:${Math.round(y / MM_MATCH_EPS)}`;
}

function endpointMm(p, end) {
  return end === '1' ? [p.x1, p.y1] : [p.x2, p.y2];
}

function otherEndMm(p, end) {
  return end === '1' ? [p.x2, p.y2] : [p.x1, p.y1];
}

/**
 * L字の角（ちょうど2本の端点が集まる点）を検出し、延長後のpx座標が入ったlineだけを載せた
 * 差分Mapを返す。
 * @param {object[]} primitives - 展開図プリミティブ配列（figurePrimitivesKonva.jsxの語彙）
 * @param {{tx:Function, ty:Function}} t - mm→px 変換器
 * @param {{thin?:number, medium?:number, thick?:number}} [lineWeightsPx]
 * @returns {Map<number, [number, number, number, number]>} primitives配列のindex → [x1,y1,x2,y2](px)
 */
export function resolveJoinedLinePoints(primitives, t, lineWeightsPx) {
  const result = new Map();
  const cands = collectCandidates(primitives);
  if (cands.length < 2) return result;

  // 端点をmm厳密一致でグルーピングする。
  const groups = new Map();
  for (const c of cands) {
    for (const end of ['1', '2']) {
      const [x, y] = endpointMm(c.p, end);
      const key = pointKey(x, y);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ cand: c, end });
    }
  }

  // 各線が受け取る延長後の端点上書き（両端に別々の角が来る場合があるため線ごとに集約する）。
  const overrides = new Map(); // idx -> { '1'?: [x,y], '2'?: [x,y] }
  const setOverride = (idx, end, x, y) => {
    if (!overrides.has(idx)) overrides.set(idx, {});
    overrides.get(idx)[end] = [x, y];
  };

  for (const entries of groups.values()) {
    if (entries.length !== 2) continue; // ちょうど2本の角だけを対象にする
    const [eA, eB] = entries;
    if (eA.cand.idx === eB.cand.idx) continue; // 念のための防御（長さ0除外で通常発生しない）

    const [oxAmm, oyAmm] = otherEndMm(eA.cand.p, eA.end);
    const [oxBmm, oyBmm] = otherEndMm(eB.cand.p, eB.end);
    const [cxAmm, cyAmm] = endpointMm(eA.cand.p, eA.end);
    const [cxBmm, cyBmm] = endpointMm(eB.cand.p, eB.end);

    const cxAPx = t.tx(cxAmm), cyAPx = t.ty(cyAmm);
    const cxBPx = t.tx(cxBmm), cyBPx = t.ty(cyBmm);
    const oxAPx = t.tx(oxAmm), oyAPx = t.ty(oyAmm);
    const oxBPx = t.tx(oxBmm), oyBPx = t.ty(oyBmm);

    // 「角から外向きの単位ベクトル」＝自分の他端→角の方向を、角の先へ延ばす向き。
    const dxA = cxAPx - oxAPx, dyA = cyAPx - oyAPx;
    const dxB = cxBPx - oxBPx, dyB = cyBPx - oyBPx;
    const lenAPx = Math.hypot(dxA, dyA);
    const lenBPx = Math.hypot(dxB, dyB);
    if (!(lenAPx > 0) || !(lenBPx > 0)) continue; // px空間でも長さ0なら何もしない

    const uAx = dxA / lenAPx, uAy = dyA / lenAPx;
    const uBx = dxB / lenBPx, uBy = dyB / lenBPx;

    const cos = uAx * uBx + uAy * uBy;
    const sin = Math.abs(uAx * uBy - uAy * uBx);
    if (sin < COLINEAR_SIN_EPS) continue; // 同一直線上は何もしない

    const wA = weightPx(eA.cand.p, lineWeightsPx);
    const wB = weightPx(eB.cand.p, lineWeightsPx);
    if (wA <= THIN_PX && wB <= THIN_PX) continue; // 細線同士は延長しない

    const cot = cos / sin; // 1/tanθ（θ=90°でcos=0→0になりNaNを生まない）
    const clampMax = EXTEND_CLAMP_FACTOR * Math.max(wA, wB);
    let dA = (wB / 2) / sin + (wA / 2) * cot;
    let dB = (wA / 2) / sin + (wB / 2) * cot;
    dA = Math.max(0, Math.min(dA, clampMax));
    dB = Math.max(0, Math.min(dB, clampMax));

    setOverride(eA.cand.idx, eA.end, cxAPx + uAx * dA, cyAPx + uAy * dA);
    setOverride(eB.cand.idx, eB.end, cxBPx + uBx * dB, cyBPx + uBy * dB);
  }

  for (const [idx, ov] of overrides) {
    const p = primitives[idx];
    const p1 = ov['1'] ?? [t.tx(p.x1), t.ty(p.y1)];
    const p2 = ov['2'] ?? [t.tx(p.x2), t.ty(p.y2)];
    result.set(idx, [p1[0], p1[1], p2[0], p2[1]]);
  }

  return result;
}

/**
 * type==='line'の1プリミティブが実際にKonvaへ渡すpx座標を返す（差分マップにあればそれ、
 * なければ素のmm→px変換）——フォールバック判断の唯一の情報源。figurePrimitivesKonva.jsxは
 * これを呼ぶだけにし、`joined.get(i) ?? ...`をレンダラ側に書かない（本番経路を変異テストで
 * 守れなくなるため）。
 * @param {object} p - primitives[i]（type==='line'）
 * @param {number} i - primitives配列でのindex
 * @param {{tx:Function, ty:Function}} t - mm→px 変換器
 * @param {Map<number, [number, number, number, number]>} joined - resolveJoinedLinePointsの戻り値
 * @returns {[number, number, number, number]}
 */
export function linePointsPx(p, i, t, joined) {
  return joined.get(i) ?? [t.tx(p.x1), t.ty(p.y1), t.tx(p.x2), t.ty(p.y2)];
}
