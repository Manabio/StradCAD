// ================================================================
// 在来木造の梁の交点処理（B-3・ユーザー裁定2026-09-17）。
//
// 「通しの梁（両側に続く梁）が勝ち、T字で突き当たる梁が負け（勝者の面で止まる）」「出隅（L字）は
// 長い方が勝ち、同長ならX方向」——このルールは場面によらず一律に適用する（例外は下屋の軒の側の梁。呼び出し側が
// eaveCorners を渡した角だけ、軒の側が勝ってけらばの出幅ぶん外形線まで延びる。描画だけ）。出隅の長さは、角に端を
// 置く梁1本の材長ではなく、同じ軸で端と端がつながる梁を合わせた全長（continuousBeamLengths。
// 梁は下階柱で分割されるため。ユーザー裁定2026-10-02「短手と長手が出会うとき、長手勝ち」）。実体スパン
// （core/structuralEntities.js の spanForColumns。下階柱面での止め）はここでは一切書き換えない
// ——ここが返すのは描画専用の追加トリム（勝者面での止め・L字の角閉じ）で、renderer/StructuralLayer.jsx
// が spanForColumns の結果を上書きして使う（設計意図は .claude/structural-model.md「在来木造の梁は
// 交点で『通しが勝つ』」節）。
//
// 同一直線上で両側の断面（成）が異なる交点は現行どおり柱面で止める（sectionBreak＝「梁成が変わる
// 交点は描画上そう解釈する」）。
//
// 参加集合は role==='primary' のみ（QA裁定・2026-09-17）。床梁・小梁（core/structuralEntities.js
// PIN_ROLES）は既にホスト梁の縁で止まる（clearance 0）ため対象外。基礎梁（foundation）は
// renderer/StructuralLayer.jsx の woodFoundationBands が別系統（土台・ベース帯）で処理するため対象外。
// 軒桁（eaves）・屋根材（roof）は小屋伏図の別ステップ（3f以降）で裁定するため今回は対象外——
// いずれも将来 primary 相当の交点処理が要る場面が出ても、この関数の対象role集合を広げる形で
// 個別に裁定してから追加する（「primary以外はまとめて対象外」を今の唯一の境界線にする）。
//
// core.js非依存の純モジュール（node:testから単体importできる。team-lessons「抽出モジュールは
// node:testから単体import可能に保つ」）。import は CL_OVERLAP_TOL_MM のみ。
// ================================================================
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

// 方向キー。StructuralBeam.isVertical=true は通り芯X（垂直材＝coord1/2がY座標）に沿う——
// 「X方向」＝isVertical=false（水平材。coord1/2がX座標）、「Y方向」＝isVertical=true。
const dirKey = isVertical => (isVertical ? 'Y' : 'X');
const otherDir = d => (d === 'X' ? 'Y' : 'X');

// 点群を tol でクラスタリングする（mergeWallIntervals/dedupCoords と同じ「隣接をtolでまとめる」発想の
// 2次元版）。貪欲法——チェーン状に少しずつずれる病的な入力での完全性は保証しないが、実データの
// 交点間隔（数百mm〜）に対しtol=0.5mmは十分に小さく実用上問題ない。
function clusterPoints(points, tol) {
  const clusters = [];
  for (const pt of points) {
    let cluster = clusters.find(c => Math.abs(c.x - pt.x) < tol && Math.abs(c.y - pt.y) < tol);
    if (!cluster) {
      cluster = { x: pt.x, y: pt.y, sumX: 0, sumY: 0, count: 0, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(pt);
    cluster.sumX += pt.x;
    cluster.sumY += pt.y;
    cluster.count += 1;
    cluster.x = cluster.sumX / cluster.count;
    cluster.y = cluster.sumY / cluster.count;
  }
  return clusters;
}

/**
 * 同じ軸の上で端と端がつながる梁（role==='primary'）を合わせた全長（連続長）を梁ごとに返す純関数。
 * 出隅（L字）の勝者を「辺の長さ」で決めるために使う——梁は下階柱の位置で分割されるため、1本の材長では
 * 辺の長さを表せない（ユーザー裁定2026-10-02「短手と長手が出会うとき、長手勝ち」）。
 * つながる＝同じ向き・同じ軸座標（tol未満）で、一方の hi 端ともう一方の lo 端の差が tol 未満。
 * 軸座標は直前の梁との差で鎖状にまとめる（clusterPoints と同じ限界: 少しずつずれる軸は1つにつながりうる）。
 * 座標は end1/end2（AXIS・未トリム）を使う——分割点では2本が同じCLを共有してぴたりと一致する
 * （base1/base2 は柱面トリム後で、分割点の両側は柱幅ぶん離れる）。断面（sectionKey）は問わない。
 * 重なり・すき間のある梁は直接にはつながない（重なる梁も共通の隣を介して同じ成分にはなりうる。全長は
 * 成分の「最大hi − 最小lo」なので二重には数えない）。1回の呼び出しで軸ごとにまとめて作る（O(n log n)）。
 * @param {Array<{id:string, role:string, isVertical:boolean, axisValue:number, end1:number, end2:number}>} beams
 * @param {number} tol
 * @returns {Map<string, number>} id -> 連続長。primary でない梁・座標が有限でない梁は含まない。
 */
export function continuousBeamLengths(beams, tol) {
  const lengths = new Map();
  const groups = new Map(); // 向き -> [{b, lo, hi}]
  for (const b of beams ?? []) {
    if (b?.role !== 'primary') continue;
    if (![b.axisValue, b.end1, b.end2].every(Number.isFinite)) continue;
    const key = dirKey(b.isVertical);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ b, lo: Math.min(b.end1, b.end2), hi: Math.max(b.end1, b.end2) });
  }
  for (const items of groups.values()) {
    // 軸座標を tol で隣接クラスタにまとめる（同じ軸の梁だけをつなぐため）。
    items.sort((p, q) => p.b.axisValue - q.b.axisValue);
    let axis = [];
    const flush = () => { if (axis.length > 0) runLengthsOnAxis(axis, tol, lengths); axis = []; };
    for (const it of items) {
      if (axis.length > 0 && it.b.axisValue - axis[axis.length - 1].b.axisValue >= tol) flush();
      axis.push(it);
    }
    flush();
  }
  return lengths;
}

// 同じ軸の梁群を union-find でつなぎ（hi 端と lo 端が tol 以内）、成分ごとの全長（最大hi − 最小lo）を積む。
function runLengthsOnAxis(items, tol, lengths) {
  const parent = items.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const byHi = items.map((_, i) => i).sort((p, q) => items[p].hi - items[q].hi);
  for (let i = 0; i < items.length; i++) {
    // |hi - lo| < tol の梁（clusterPoints と同じ厳密な比較。二分探索で下限を探して昇順に走査）。
    let l = 0, r = byHi.length;
    while (l < r) { const m = (l + r) >> 1; if (items[byHi[m]].hi <= items[i].lo - tol) l = m + 1; else r = m; }
    for (let k = l; k < byHi.length && items[byHi[k]].hi < items[i].lo + tol; k++) {
      const j = byHi[k];
      if (j !== i) parent[find(j)] = find(i);
    }
  }
  const extent = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    const e = extent.get(root);
    if (!e) extent.set(root, { lo: it.lo, hi: it.hi });
    else { e.lo = Math.min(e.lo, it.lo); e.hi = Math.max(e.hi, it.hi); }
  });
  items.forEach((it, i) => { const e = extent.get(find(i)); lengths.set(it.b.id, e.hi - e.lo); });
}

/**
 * 在来木造の梁の交点処理（drawing.beamJunction==='throughWins' のときだけ動作）。
 * @param {{beamJunction?: string}|null|undefined} drawing - structureRules.js の rulesFor(structure).drawing
 * @param {Array<{id:string, role:string, isVertical:boolean, axisValue:number, end1:number, end2:number,
 *   base1:number, base2:number, halfWidth:number, sectionKey:string|null}>} beams
 *   end1/end2＝clStart/clEnd.effectiveValue（AXIS・未トリム）。base1/base2＝spanForColumns の結果
 *   （下階柱面でのトリム済み）。halfWidth＝beamRenderWidth(b,lod)/2（単線LODは0）。sectionKey＝sectionDefId。
 * @param {{tol?: number, eaveCorners?: Array<{x:number, y:number, eaveIsVertical:boolean, extendMm:number}>}} [opts]
 *   eaveCorners＝下屋の軒の側の梁が出隅で勝つ角（roofFramingGeometry.js eaveBeamCorners）。その角の交点では、軒の側が
 *   通しでなければ、短い方でも軒の側が勝ち、端を max(敗者の半幅, extendMm)（けらばの出幅）だけ外へ延ばす（kind 'eaveExtend'・
 *   capped）。けらば側に梁が無くても延ばす。軒の側が通しの角・軒の側に梁の端が無い角は通常の決定のまま。
 *   渡さない・空なら今までと完全に同じ結果。
 * @returns {Map<string, {coord1:number, coord2:number, ends:[{kind:string,capped:boolean},{kind:string,capped:boolean}]}>}
 *   変化した梁（少なくとも片端が base 以外になった梁）だけを収める。'columnFace'/未知値/undefined は
 *   常に空Map（恒等の根拠をここに置く——呼び出し側は分岐しない）。
 */
export function resolveBeamJunctionSpans(drawing, beams, { tol = CL_OVERLAP_TOL_MM, eaveCorners = [] } = {}) {
  const result = new Map();
  if (drawing?.beamJunction !== 'throughWins') return result;
  const primaries = (beams ?? []).filter(b => b.role === 'primary');
  if (primaries.length === 0) return result;

  // 全参加梁の両端点を集めてクラスタリング（交点候補）。
  const points = [];
  for (const b of primaries) {
    const p1 = b.isVertical ? { x: b.axisValue, y: b.end1 } : { x: b.end1, y: b.axisValue };
    const p2 = b.isVertical ? { x: b.axisValue, y: b.end2 } : { x: b.end2, y: b.axisValue };
    points.push({ ...p1, beam: b, endIndex: 0, dir: Math.sign(b.end2 - b.end1) || 1, along: b.end1 });
    points.push({ ...p2, beam: b, endIndex: 1, dir: Math.sign(b.end1 - b.end2) || 1, along: b.end2 });
  }
  const clusters = clusterPoints(points, tol);
  const runLengths = continuousBeamLengths(primaries, tol); // 出隅の勝者用（軸ごとに1回だけ作る）

  // 端ごとの解決結果を id -> [end0, end1] へ積む（両端が別の交点で解決されうるため先に用意する）。
  const perBeam = new Map();
  for (const b of primaries) perBeam.set(b.id, [null, null]);

  for (const cluster of clusters) {
    const armsByDir = { X: [], Y: [] };
    for (const item of cluster.items) armsByDir[dirKey(item.beam.isVertical)].push(item);

    // 通過する梁（passing。role==='primary'限定・スパン内部を厳密に通過。勝者候補のみ）。
    const passingByDir = { X: [], Y: [] };
    for (const b of primaries) {
      const lo = Math.min(b.base1, b.base2), hi = Math.max(b.base1, b.base2);
      if (b.isVertical) {
        if (Math.abs(b.axisValue - cluster.x) < tol && cluster.y > lo + tol && cluster.y < hi - tol) passingByDir.Y.push(b);
      } else if (Math.abs(b.axisValue - cluster.y) < tol && cluster.x > lo + tol && cluster.x < hi - tol) {
        passingByDir.X.push(b);
      }
    }

    const continuous = {}, sectionBreak = {};
    for (const d of ['X', 'Y']) {
      const plus = armsByDir[d].filter(a => a.dir === 1);
      const minus = armsByDir[d].filter(a => a.dir === -1);
      const matched = plus.some(p => minus.some(m => p.beam.sectionKey === m.beam.sectionKey));
      continuous[d] = passingByDir[d].length > 0 || (plus.length > 0 && minus.length > 0 && matched);
      sectionBreak[d] = plus.length > 0 && minus.length > 0 && !matched;
    }

    // 下屋の軒の側の梁が、けらばの側の梁との出隅で勝つ角（eaveCorners。伏図の描画だけ）。軒の側が通しなら対象外
    // （通常の勝者決定のまま）。軒の側に梁の端が無い角も対象外。
    const eaveCorner = (eaveCorners ?? []).find(c => Math.abs(c.x - cluster.x) < tol && Math.abs(c.y - cluster.y) < tol);
    const eaveDir = eaveCorner ? (eaveCorner.eaveIsVertical ? 'Y' : 'X') : null;
    const eaveWins = eaveDir != null && !continuous[eaveDir] && !sectionBreak[eaveDir] && armsByDir[eaveDir].length > 0;

    // 勝者決定（この順で1回）。
    let winner = null;
    if (eaveWins) winner = eaveDir;
    else if (continuous.X && !continuous.Y) winner = 'X';
    else if (continuous.Y && !continuous.X) winner = 'Y';
    else if (continuous.X && continuous.Y) winner = 'X'; // 十字は既定X
    else if (!sectionBreak.X && !sectionBreak.Y) {
      // どちらも連続でなく、断面違いの衝突（sectionBreak）も無い＝出隅（L字）。両方向に実際にarmが
      // あるときだけ連続長（各方向の最大値。同一方向に複数armがあっても代表は最長のもの）で比べる。
      const xArms = armsByDir.X, yArms = armsByDir.Y;
      if (xArms.length > 0 && yArms.length > 0) {
        const lenOf = a => runLengths.get(a.beam.id) ?? Math.abs(a.beam.end2 - a.beam.end1);
        const xLen = Math.max(...xArms.map(lenOf));
        const yLen = Math.max(...yArms.map(lenOf));
        winner = Math.abs(xLen - yLen) <= tol ? 'X' : (xLen > yLen ? 'X' : 'Y');
      }
    }
    if (winner == null) continue; // 勝者なし＝この交点は何もしない（baseのまま）

    // 勝者側の実描画半幅（passing・勝者方向armの最大値。共線ペアなら2本のmax）。
    const winnerHalfWidth = Math.max(
      0,
      ...passingByDir[winner].map(b => b.halfWidth),
      ...armsByDir[winner].map(a => a.beam.halfWidth),
    );

    for (const d of ['X', 'Y']) {
      for (const arm of armsByDir[d]) {
        const b = arm.beam;
        let kind, coord, capped;
        if (d === winner && continuous[winner]) {
          // 通し（連続成立）——勝ち方向armで連続が成り立っている＝pで貫通させたまま。
          kind = 'through';
          coord = arm.along;
          capped = false;
        } else if (d === winner) {
          // L字の勝者（連続不成立）——敗者側armの最大半幅ぶん控えて角を閉じる。
          const loserArms = armsByDir[otherDir(winner)];
          const loserHalf = Math.max(0, ...loserArms.map(a => a.beam.halfWidth));
          // 軒の勝ちは、けらばの出幅ぶん（敗者の半幅より大きければ）外形線まで延ばす
          kind = eaveWins ? 'eaveExtend' : 'cornerClose';
          coord = arm.along - arm.dir * (eaveWins ? Math.max(loserHalf, eaveCorner.extendMm) : loserHalf);
          capped = true;
        } else {
          // 負け方向arm——勝者の面（実描画半幅ぶん）で止める。
          kind = 'winnerFace';
          coord = arm.along + arm.dir * winnerHalfWidth;
          capped = false;
        }
        perBeam.get(b.id)[arm.endIndex] = { kind, capped, coord };
      }
    }
  }

  for (const b of primaries) {
    const [e0, e1] = perBeam.get(b.id);
    if (!e0 && !e1) continue; // 両端とも交点処理の対象外＝base（出力しない）
    // base側の座標は必ず base1/base2（spanForColumns済みの実体スパン）を使う——end1/end2（AXIS・
    // 未トリム）を使うと、柱面トリムを無視して下階柱を突き抜けた座標を返してしまう（beamJunction.test.js
    // (l)がこの取り違えを検出する）。
    const end0 = e0 ?? { kind: 'base', capped: false, coord: b.base1 };
    const end1 = e1 ?? { kind: 'base', capped: false, coord: b.base2 };
    result.set(b.id, {
      coord1: end0.coord,
      coord2: end1.coord,
      ends: [
        { kind: end0.kind, capped: end0.capped },
        { kind: end1.kind, capped: end1.capped },
      ],
    });
  }
  return result;
}
