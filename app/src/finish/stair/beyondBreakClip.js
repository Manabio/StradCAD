/**
 * 破れ線（install 階段の斜めZ字ポリライン）を基準にした「破れ先」判定・クリップの純関数群。
 *
 * StairLayer.jsx から抽出。react-konva・store.js・snap.js に依存しない（node:test から
 * 単体 import 可能に保つ——.claude/implementation-policy.md の抽出純モジュール規約）。
 *
 * ここに集めるのは「線分と破れ線の交点」といった低水準の幾何ヘルパだけで、プリミティブ別の
 * 可視ルール（踏面線＝線分クリップ／段数字＝点判定／矢印＝ポリラインクリップ）は
 * 呼び出し側に置いたままにする。
 * .claude/stair-model.md の「破れの可視判定はプリミティブ別に独立（不変条件）」を崩さない
 * ——共有するのは道具であって、ゲートそのものではない。
 */

import { pointInRects } from './segmentClip.js';

const CLIP_EPS = 1e-6; // 交点パラメータ(t/u)の許容誤差

// 線分 p1-p2 と p3-p4 の交点を返す（区間内でなければ null）。t は p1-p2 上のパラメータ(0..1)。
export function segIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
  const d1x = p2x - p1x, d1y = p2y - p1y;
  const d2x = p4x - p3x, d2y = p4y - p3y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;
  if (t < -CLIP_EPS || t > 1 + CLIP_EPS || u < -CLIP_EPS || u > 1 + CLIP_EPS) return null;
  return { x: p1x + d1x * t, y: p1y + d1y * t, t };
}

// 線分 s が breakSegs（install の破れ線。複数線分の Z 字ジョグ）のいずれかと交差する
// 最初の交点を返す（s.x1,y1 側から見て最も近いもの）。交差しなければ null。
export function findBreakCrossing(s, breakSegs) {
  if (!breakSegs || breakSegs.length === 0) return null;
  let best = null;
  for (const seg of breakSegs) {
    const ip = segIntersect(s.x1, s.y1, s.x2, s.y2, seg.x1, seg.y1, seg.x2, seg.y2);
    if (ip && (!best || ip.t < best.t)) best = ip;
  }
  return best;
}

/**
 * 描画用の破れ線から「見た目のはり出し」を取り除いた、クリップ用の破れ線を返す。
 *
 * breakSymbol / breakSymbolAwayFromLanding（stairGeometry.js）が返す segs は
 * [E1→A, A→B, B→D, D→C, C→E2] で、両端の E1/E2 だけが overhang ぶん実端点より外側にある。
 * はり出しは中心線の端のはね出しと同じ「見た目のみ」の量で、側線連結・踏面クリップ等の
 * 実端点幾何に影響させてはならない（.claude/stair-model.md）。はり出しを含んだまま
 * クリップに使うと、破れ線が内側の通り芯を越えて反対レーンの側線まで切ってしまう（過去の不良）。
 * @param {{x1,y1,x2,y2}[]|null|undefined} breakLine
 * @param {number} overhangMm はり出し量。0以下ならそのまま返す
 */
export function trimBreakOverhang(breakLine, overhangMm) {
  if (!(breakLine?.length > 0) || !(overhangMm > 0)) return breakLine ?? null;
  // 端の線分を overhangMm だけ内側へ詰める。線分自体がはり出しより短ければ丸ごと落とす。
  const shorten = (s, atStart) => {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len <= overhangMm + 1e-9) return null;
    const ux = dx / len, uy = dy / len;
    return atStart
      ? { ...s, x1: s.x1 + ux * overhangMm, y1: s.y1 + uy * overhangMm }
      : { ...s, x2: s.x2 - ux * overhangMm, y2: s.y2 - uy * overhangMm };
  };
  const segs = breakLine.slice();
  const first = shorten(segs[0], true);
  if (first) segs[0] = first; else segs.shift();
  if (segs.length === 0) return segs;
  const lastIdx = segs.length - 1;
  const last = shorten(segs[lastIdx], false);
  if (last) segs[lastIdx] = last; else segs.pop();
  return segs;
}

/**
 * 破れ線の「弦」（ジョグを無視した両端点の直線）に対する側判定器を作る。
 * 「先側」の符号は破れ線先セル群（beyondBounds）の重心が弦のどちら側かで決める。
 * 弦が退化している／先側が決まらない場合は null（呼び出し側は側判定を使わない）。
 * @returns {{side:(x:number,y:number)=>number, beyondSign:number}|null}
 */
export function breakChordOf(breakLine, beyondBounds) {
  if (!(breakLine?.length > 0) || !(beyondBounds?.length > 0)) return null;
  const a = breakLine[0];
  const z = breakLine[breakLine.length - 1];
  const ox = a.x1, oy = a.y1, dx = z.x2 - ox, dy = z.y2 - oy;
  const side = (x, y) => Math.sign(dx * (y - oy) - dy * (x - ox));
  let cx = 0, cy = 0;
  for (const bb of beyondBounds) { cx += (bb.x1 + bb.x2) / 2; cy += (bb.y1 + bb.y2) / 2; }
  const beyondSign = side(cx / beyondBounds.length, cy / beyondBounds.length);
  return beyondSign === 0 ? null : { side, beyondSign };
}

/**
 * 線分の配列（踏面線・外周線など「線分」プリミティブ）を破れ線の片側だけに絞り込む。
 * - 破れ線と交差する線分 … 交点で切り、採用側の部分線分だけを残す（破れ線どまり）。
 *   採用側の判定はセル粒度の beyondBounds では決められない（破れ線は斜めにセル内へ食い込むため、
 *   破れ線際の線分は両端点とも先セル内になる）ため、弦に対する側で判定する。
 * - 交差しない線分 … 中点が beyondBounds に入るかで採否を決める（弦を無限直線として遠方へ
 *   適用すると L字等で誤判定するため、弦の側判定は交差する線分に限る）。
 * @param {{x1:number,y1:number,x2:number,y2:number}[]} segs
 * @param {{x1:number,y1:number,x2:number,y2:number}[]} breakLine install 階段の破れ線
 * @param {{x1:number,y1:number,x2:number,y2:number}[]} beyondBounds 破れ線先セルのワールド矩形
 * @param {{keep?: 'beyond'|'near'}} [opts] 残す側。既定は 'beyond'（破れ先）。
 *   'near' は補集合＝破れ手前（install 自身の実線を、点線で描き直す先側と重ねないために使う）。
 * @returns {typeof segs} 元の付随プロパティ（thin/medium/side/port 等）は保持する
 */
export function clipSegmentsBeyondBreak(segs, breakLine, beyondBounds, { keep = 'beyond' } = {}) {
  if (!(beyondBounds?.length > 0)) return segs; // 安全側: 領域不明ならフィルタしない
  const chord = breakChordOf(breakLine, beyondBounds);
  const wantBeyond = keep !== 'near';
  return segs.reduce((acc, s) => {
    const crossing = findBreakCrossing(s, breakLine);
    if (crossing && chord) {
      const keepSign = wantBeyond ? chord.beyondSign : -chord.beyondSign;
      const s1 = chord.side(s.x1, s.y1);
      const s2 = chord.side(s.x2, s.y2);
      if (s1 !== s2) {
        if (s1 === keepSign) acc.push({ ...s, x2: crossing.x, y2: crossing.y });
        else if (s2 === keepSign) acc.push({ ...s, x1: crossing.x, y1: crossing.y });
        // どちらの端点も採用側でない（弦上の退化）→ 全体が反対側＝描かない
        return acc;
      }
      // 両端点が同じ側（ジョグ突起だけを掠めた交差等）→ 中点判定へフォールバック
    }
    const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
    if (pointInRects(beyondBounds, mx, my) === wantBeyond) acc.push(s);
    return acc;
  }, []);
}

// フラット点列 [x,y,x,y,...] を (x,y) ペア単位で逆順にする。
export function reversePointPairs(pts) {
  const rev = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
  return rev;
}

// ポリライン pts（フラット [x,y,...]）を始点側から順に走査し、breakLine との最初の交点を探す。
// { index, point } を返す（index は交点を含む区間の始点インデックス）。無ければ null。
function firstBreakHit(pts, breakLine) {
  if (!(breakLine?.length > 0)) return null;
  for (let i = 0; i <= pts.length - 4; i += 2) {
    const p1x = pts[i], p1y = pts[i + 1], p2x = pts[i + 2], p2y = pts[i + 3];
    let best = null;
    for (const seg of breakLine) {
      const ip = segIntersect(p1x, p1y, p2x, p2y, seg.x1, seg.y1, seg.x2, seg.y2);
      if (ip && (!best || ip.t < best.t)) best = ip;
    }
    if (best) return { index: i, point: best };
  }
  return null;
}

// 矢印の経路 pts を、始点側から順に breakLine との最初の交点でクリップし、
// [交点…終点] を返す（始点側を切り捨てる）。交点が見つからなければ null。
export function clipPolylineStartAtBreak(pts, breakLine) {
  const hit = firstBreakHit(pts, breakLine);
  return hit ? [hit.point.x, hit.point.y, ...pts.slice(hit.index + 2)] : null;
}

// 矢印の経路 pts を、始点側から順に breakLine との最初の交点でクリップし、
// [始点…交点] を返す（終端側を切り捨てる）。交点が見つからなければ null。
export function clipPolylineEndAtBreak(pts, breakLine) {
  const hit = firstBreakHit(pts, breakLine);
  return hit ? [...pts.slice(0, hit.index + 2), hit.point.x, hit.point.y] : null;
}
