/**
 * 平面詳細LODの壁仕上げ材の線（面線・妻線・内側線・木口線）を、**材の領域の境界**として解く
 * 純モジュール。設計意図と移行の道筋は `.claude/plan-wall-region.md`。
 *
 * ## 何を領域にするか
 * 平面切断面の材を2つの層の矩形集合として持つ:
 *   - `material` … 実際に材が在る範囲（`Wall.materialRange` ∪ `backingRange`）× 描画上のスパン
 *     （端は相手の内側線まで延長）
 *   - `backing`  … 下地帯（`Wall.backingRange`）× 同じスパン（端は相手の内側線へ延長／短縮）
 * 描くのは、
 *   - `material` の合併境界 … **面線と妻線**（線の向きが壁と同じなら面線、直交なら妻線。
 *     区別は描画側の呼び名だけで、解決としては同じ1本の境界）
 *   - `backing` の合併境界のうち `material` の**厳密内部**にある部分 … **内側線と木口線**
 * これだけで、T字の切り欠き・出隅入隅の内側線の合流・妻線の抑止・分割線の結合が、
 * 個別の分類を持たずにすべて境界計算の帰結として決まる。
 *
 * ## 消えるのは機構であって規則ではない
 * 「内側線どうしが取り合う」規則（相手の内側線＝`finBoundary` に端を置く）は境界計算の帰結には
 * ならない——壁生成の `closeConvexCorners` が出隅で端を相手の材の遠位面まで伸ばすため、下地の
 * 矩形をそのまま入れると相手の仕上げ帯へ食い込み、角に仕上げ厚ぶんの断片が残る。規則は
 * **下地矩形の端の正規化**（`backingSpanFor`）として残し、取り合い先の供給源は従来どおり
 * `finish/wallFinishJoin.js` の `finishJoinBoundary` 1箇所にする。
 *
 * ## 旧方式から引き継ぐもの（引き継がないもの）
 * 引き継ぐ: `wallJunctionResolve.js` の**パス0（高さが違う壁の取り合い）だけ**——切断面に居ない
 * 壁（腰壁）を領域から外す高さクラス分けと、低い壁の帯を覆う延長（`endExtend`）・覆われる区間
 * （`spanCuts`）・端部の回り込み（`endWrap`）。「境界を求める」問題の外側にある。
 * 引き継がない: パス6（通り抜けた端の詰め。`regionSpan` 参照）・パス1（T字の切り欠き・下地延長）・
 * パス2（内側線の端点合わせ）・パス3（fin線の下地貫通防止）・パス5（妻線抑止）と
 * `finishLineSplits.js`（分割線の結合）——すべて境界計算の帰結（または上記の正規化）になるため、
 * 線を削る機構としては持たない。
 *
 * ## 対称壁の矩形（軸CL側を出さない理由）
 * 対称壁（`backingDepth == null`）の `materialRange` は軸CL〜仕上げ面の**半分**だが、`backingRange` は
 * 軸CL中心で反対側へはみ出す。下地は実在する材なので、材の矩形は**下地の遠位面まで広げて**入れる
 * （切ると穴になり、直交する壁の材が薄壁の面線を覆えない）。広げた側の面は材の面ではなく共有壁の
 * 中の継ぎ目（反対側の部屋の壁が別Wallとして表される）なので、`hide` で持ち出しだけを止め、
 * 覆い判定には参加させる。下地の遠位辺は、反対側に薄壁の材が接していれば継ぎ目として内側線になる
 * （旧描画の薄壁の内側線と同じ）。反対側の壁の材がその辺を厳密に含む配置（外壁と内壁で `wallBase` が
 * 違う階）は全長の偽線になりうるが、実データ（11.stq）には無いことを確認済みで、規則は持たない。
 *
 * ## 畳んだ線の出所（`ids`）
 * 共線で接する辺は1本へ畳まれ、代表元の壁が描く。寄与した**すべての壁のid**を線に残す——柱の
 * 切り欠き（`applyColumnCuts`）は壁単位の後処理で、代表元だけで当てると、柱に接する短い壁の線が
 * 隣の長い壁へ畳まれたときに柱包みを貫通する。
 *
 * 純モジュール（node:test から単体 import 可能。store.js・*.jsx を静的に引かない）。
 */
import { ShapeType } from '@core';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { ENDPOINT_EPS, resolveFinVisibility, finishJoinBoundary } from '../finish/wallFinishJoin.js';
import { CAP_OVERHANG } from '../finish/kneeDropWall.js';
import { q, unq, rectFromMm, unionBoundary, clipEdgeToInterior } from './orthoRegion.js';

/**
 * 壁1本の「描画上のスパン区間」（開口とspanCutsで分割済み）を返す。
 * @returns {Array<[number,number]>}
 */
export function wallSpanIntervals(lo, hi, openings, spanCuts) {
  const raw = [];
  let cursor = lo;
  for (const o of openings ?? []) {
    if (o.coord1 > cursor) raw.push([cursor, o.coord1]);
    cursor = Math.max(cursor, o.coord2);
  }
  if (cursor < hi) raw.push([cursor, hi]);
  if (!spanCuts?.length) return raw;
  return raw.flatMap(([a, b]) => subtractIntervals(a, b, spanCuts));
}

/**
 * 領域に入れる壁のスパン（長さ方向）。`endExtend`（`wallJunctionResolve.js`）のうち**外へ伸ばす**
 * もの（パス0＝低い壁の帯の遠位面まで覆う延長）だけを採り、**内へ詰める**もの（パス6＝直交壁を
 * 通り抜けた端の詰め）は使わない。パス6は線トリム方式のための後始末で、領域では相手の帯を
 * 通り抜けた材は合併で相手の材に呑まれるだけ（通り抜けた先の妻線も相手の面に重なる）で害が無い。
 * 逆に詰めると、壁生成が交差部で両方の壁を相手の帯まで通していた十字・T字で、交差部の矩形が
 * どの壁の材でもなくなり、下地どうしの交差が輪郭線で囲まれて見える（実機 1階 X=-3000×Y=-3500）。
 * @returns {[number,number]}
 */
export function regionSpan(wall, junction) {
  const physLo = Math.min(wall.coord1, wall.coord2), physHi = Math.max(wall.coord1, wall.coord2);
  const endExtend = junction?.endExtend ?? {};
  return [
    endExtend.lo != null && endExtend.lo < physLo ? endExtend.lo : physLo,
    endExtend.hi != null && endExtend.hi > physHi ? endExtend.hi : physHi,
  ];
}

/**
 * 壁1本ぶんの領域入力（POJO）。`materialRange`/`backingRange` は MobX の computed なので
 * 1回だけ読んで写す（`wallJunctionResolve.js` の makeView と同じ手口）。
 */
function wallInput(wall, { junction, openings, kneeDrop, clipGroup }) {
  const [lo, hi] = regionSpan(wall, junction);
  // 天板（腰壁・垂れ壁）の壁は `spanCuts`（パス0「高い壁の帯に覆われる区間は描かない」）を使わない
  // ——同じことを天板の領域から全高の材を差し引いて表す（`resolveCapLines`）。
  const spans = wallSpanIntervals(lo, hi, openings, kneeDrop ? [] : (junction?.spanCuts ?? []));
  const backing = wall.backingRange;
  // 対称壁（`backingDepth == null`）の `backingRange` は軸CLを中心に `materialRange`（軸CL〜仕上げ面の
  // 半分）をはみ出す。**下地は実在する材**なので、材の矩形を下地の遠位面まで広げて被覆に参加させる
  // （下地を材で切ると、はみ出した45mmがどの矩形にも属さない穴になり、反対側が対称壁のペアではなく
  // 薄壁のとき、直交する壁の材がその穴で薄壁の面線を覆えず線が素通りする。実機 1階 x=6955×y=-3600）。
  // 広げた側の面は材の面ではない（反対側の部屋の壁との継ぎ目）ので `hide` で持ち出さない（`seamSide`）。
  const material = backing
    ? { lo: Math.min(wall.materialRange.lo, backing.lo), hi: Math.max(wall.materialRange.hi, backing.hi) }
    : wall.materialRange;
  // 線種（色・線幅・破線）が違う線は畳まない。**描画クリップの単位（2a壁＝階段下部屋の偏芯壁。
  // ShapesLayer.jsx の `stairUnderClips`）が違う線も畳まない**——クリップは壁id単位の Group
  // clipFunc で掛かるため、2a壁の線が隣の非2a壁の線へ畳まれると階段踏面側が切られず、逆に
  // 非2a壁の線が2a壁へ畳まれると相手の区間まで切られる。2a壁かどうかは graph だけでは決まらない
  // （階段モード・上階の見下げ依存）ので、呼び出し側から `clipGroups` として受け取る。
  const drawKey = `${wall.color}|${wall.lineWeight}|${wall.lineType}`
    + (clipGroup != null ? `|clip:${clipGroup}` : '');
  return {
    id: wall.id,
    isVertical: wall.isVertical,
    spanLo: lo, spanHi: hi, spans,
    material,
    backing,
    extentLo: wall.axisCL?.extentLo ?? null,
    extentHi: wall.axisCL?.extentHi ?? null,
    wallFinish: wall.wallFinish,
    faceDir: wall.faceDir,
    axisValue: wall.axisValue,
    symmetric: wall.backingDepth == null,
    // 取り合い先（内側線の位置と可視性）。規則の供給源は finish/wallFinishJoin.js。
    finLine: resolveFinVisibility(wall),
    drawKey,
    // 天板の輪郭で描かれる壁（腰壁・垂れ壁）は切断面に材を持たない＝全高の領域に参加せず、
    // 高さクラスごとの天板の領域（`resolveCapLines`）で描く。
    capOutline: !!kneeDrop,
    cap: kneeDrop ? { mode: kneeDrop.mode, capLo: kneeDrop.capLo, capHi: kneeDrop.capHi,
      height: kneeDrop.mode === 'knee' ? kneeDrop.topHeight : Infinity } : null,
    endWrap: junction?.endWrap ?? {},
  };
}

// 天板どうしが角で取り合うとみなす許容差(mm)。壁端は既存トリム（closeConvexCorners 等）が相手の材の
// 面へスナップし、天板の帯は材より CAP_OVERHANG ぶん外へ広いので、理論上は必ず相手の帯の内側に
// 入る。厳密スナップを経ていない壁（手動壁）も拾えるよう、wallJunctionResolve.js の TOUCH_TOLERANCE と同値。
const CAP_JOIN_TOL = 30; // mm

/**
 * 天板（腰壁＝実線・垂れ壁＝破線）を**高さクラスごとの領域**として解き、線分を壁ごとに積む。
 *
 * - クラスは (mode, 高さ) の組。腰壁は天端高さ、垂れ壁は全高と同じ扱い（切断面より上に在る＝全高の壁に
 *   差し引かれるだけで、腰壁とは交わらない）。
 * - **低いクラスは高いクラスを差し引く**（案3の優先度）: 高いクラスの材が天板の材の帯（`capLo+出幅 〜
 *   capHi-出幅`）を厚み方向に覆う区間は天板を描かない（旧パス0の `spanCuts` と同じ規則を領域で表す）。
 *   さらに高いクラスの材は境界の**覆い判定**に参加させる（`unionBoundary` の `covers`）——天板の端が
 *   高い壁の面上で終わるとき、その面線がそこに在るので天板の端部の線を重ねない（出幅ぶんの外側だけが残る）。
 * - **角の取り合いは合併境界の帰結**——ただし条件Aと同じ理由で矩形の端の正規化が要る: 壁生成は角で端を
 *   相手の**材**の遠位面までしか伸ばさないので、天板（材より出幅ぶん広い）の矩形をそのまま入れると角に
 *   出幅×出幅の欠けが残る。**相互に**相手の帯の中で終わる組（角。素通りするT字・十字は違う）では、端を
 *   相手の帯の遠位面まで伸ばす。すると外側の長辺どうしは遠位面で、内側の長辺どうしは近位面で出会う
 *   （旧 `capJoins`「外側どうし・内側どうしでトリムし、端部の線は描かない」）。
 * - 線種（実線／破線）・高さが違う天板は畳まない（`styleKey`）。
 */
function resolveCapLines(inputs, materialRects, push) {
  const capWalls = inputs.filter(w => w.capOutline && w.spans.length > 0);
  if (capWalls.length === 0) return;
  const classes = new Map();
  for (const w of capWalls) {
    const key = `${w.cap.mode}:${w.cap.height}`;
    (classes.get(key) ?? classes.set(key, []).get(key)).push(w);
  }
  const order = [...classes.entries()].sort((a, b) => b[1][0].cap.height - a[1][0].cap.height);
  const higherCaps = []; // 上位の腰壁クラスの天板矩形（累積）
  for (const [key, group] of order) {
    const covers = [...materialRects, ...higherCaps];
    const rects = [];
    for (const w of group) {
      const { capLo, capHi } = w.cap;
      const matLo = q(capLo + CAP_OVERHANG), matHi = q(capHi - CAP_OVERHANG);
      // 高いクラスの材（全高の壁・柱壁）が天板の材の帯を厚み方向に覆う区間（全高＝高い方が優先）。
      const cuts = [];
      for (const r of covers) {
        const [aLo, aHi, tLo, tHi] = w.isVertical ? [r.yLo, r.yHi, r.xLo, r.xHi] : [r.xLo, r.xHi, r.yLo, r.yHi];
        if (tLo <= matLo && tHi >= matHi) cuts.push([unq(aLo), unq(aHi)]);
      }
      // 角の取り合い: 相互に相手の帯の中で終わる直交する同クラスの天板へ、端を相手の帯の遠位面まで伸ばす。
      let lo = w.spanLo, hi = w.spanHi;
      const inBand = (c, v) => c >= v.cap.capLo - CAP_JOIN_TOL && c <= v.cap.capHi + CAP_JOIN_TOL;
      for (const [end, coord, dir] of [['lo', w.spanLo, -1], ['hi', w.spanHi, 1]]) {
        for (const v of group) {
          if (v === w || v.isVertical === w.isVertical) continue;
          if (!inBand(coord, v) || !(inBand(v.spanLo, w) || inBand(v.spanHi, w))) continue;
          const far = dir > 0 ? v.cap.capHi : v.cap.capLo;
          if (end === 'lo') lo = Math.min(lo, far); else hi = Math.max(hi, far);
        }
      }
      const tag = { styleKey: `${w.drawKey}|cap:${key}`, isVertical: w.isVertical, style: w.cap.mode };
      for (const [a, b] of w.spans) {
        const sLo = a <= w.spanLo ? lo : a, sHi = b >= w.spanHi ? hi : b;
        for (const [c, d] of subtractIntervals(sLo, sHi, cuts)) {
          const r = rect(w.isVertical, c, d, capLo, capHi, w.id, tag);
          if (r) rects.push(r);
        }
      }
    }
    for (const e of unionBoundary(rects, covers)) {
      push(e, e.lo, e.hi, e.vertical === !!e.tag?.isVertical ? 'kd' : 'kdcap', e.tag.style);
    }
    if (group[0].cap.mode === 'knee') higherCaps.push(...rects);
  }
}

// 長さ方向の位置(along)・厚み方向の位置(across) から矩形を作る（縦壁は軸が入れ替わる）。
function rect(isVertical, alongLo, alongHi, acrossLo, acrossHi, id, tag, hide) {
  const r = isVertical
    ? rectFromMm(acrossLo, acrossHi, alongLo, alongHi, id, tag)
    : rectFromMm(alongLo, alongHi, acrossLo, acrossHi, id, tag);
  if (r && hide?.length) r.hide = hide;
  return r;
}

// 対称壁の軸CL側（材の面ではない継ぎ目）の side 名。
function seamSide(isVertical, faceDir) {
  if (isVertical) return faceDir > 0 ? ['xLo'] : ['xHi'];
  return faceDir > 0 ? ['yLo'] : ['yHi'];
}

/**
 * 材と下地の端をどこに置くか（矩形の正規化。`.claude/plan-wall-region.md`「消えるのは機構であって
 * 規則ではない」）。取り合いの相手は、直交する壁のうち**この端がその材の中／面上にあり**、かつ
 * 長さ方向がこの壁の材に触れている（横切る・端で接する）もの。合わせ先はその壁の内側線
 * （`finishJoinBoundary`。内側線が描かれない壁とは取り合わない＝null）。候補が複数（帯の境目で
 * 終わる端は隣り合う2枚の両方に触れる）なら、自分の本体に最も近い内側線を採る——相手の帯を
 * 通り抜けた端も最初の内側線で止まる。
 *  下地 … 相手の内側線に置く。T字・入隅では延長、出隅では**短縮**になる（`closeConvexCorners` が
 *    出隅で端を相手の材の遠位面まで伸ばしているため、伸ばすだけでは下地が相手の仕上げ帯へ
 *    食い込んだまま残り、角に仕上げ厚ぶんの断片が出る）。相手は薄壁（下地なし）も含む——入隅で
 *    薄壁の面に突き当たる下地をその面で止めると、下地幅の木口線が薄壁の面に出る。
 *  材 … 相手の内側線まで**延長だけ**する（出隅で縮めると角が欠ける）。T字では相手の仕上げ帯を
 *    自分の材幅ぶん占める（旧パス1の faceCuts）、入隅では対角に接するだけの2枚の材の間の角を
 *    埋める（旧パス2の finEnd＝内側線どうしの合流と妻線抑止）——どちらも延長した矩形の合併境界の
 *    帰結になる。
 *  回り込み … 仕上げ材が端を回り込む端（`wrapEnds`）は取り合わず、下地だけ仕上げ厚ぶん手前まで
 *    縮める（旧 endWrap）。
 *  通り抜けた端（旧パス6）は詰めない——相手の材の中の部分は合併で呑まれるだけで害が無く、十字では
 *    詰めると交差部が誰の材でもなくなる（`regionSpan`）。壁生成が軸CLまで通した端も、対称壁の材を
 *    下地の遠位面まで広げている（`wallInput`）ので相手の材の中に収まる。
 * @returns {{material:[number,number], backing:[number,number]|null, studs:[number,number]|null}}
 *   material/backing: 領域に入れる矩形の長さ方向の範囲。studs: 下地スタッドを並べる範囲。
 */
function endSpansFor(w, inputs, wrapEnds) {
  let mLo = w.spanLo, mHi = w.spanHi;
  let bLo = w.spanLo, bHi = w.spanHi;
  let sLo = w.spanLo, sHi = w.spanHi;
  const finish = w.wallFinish > 0 ? w.wallFinish : 0;
  // 直交して取り合いうる壁: 長さ方向がこの壁の材（厚み方向の範囲）に触れているもの（端で接する
  // だけの壁も含む——T字の通し壁は突き当たる壁の位置で部屋ごとに分かれていることが多い）。
  const partners = inputs.filter(v => v !== w && v.isVertical !== w.isVertical && !v.capOutline
    && !(v.spanHi < w.material.lo - ENDPOINT_EPS || v.spanLo > w.material.hi + ENDPOINT_EPS));
  for (const [end, dir] of [['lo', -1], ['hi', 1]]) {
    const coord = end === 'lo' ? w.spanLo : w.spanHi;
    if (wrapEnds?.[end] && finish > 0) {
      if (end === 'lo') bLo = sLo = coord + finish; else bHi = sHi = coord - finish;
      continue;
    }
    // 置き先は端の現在位置にある相手から決め、動いたらその位置で再び相手を探す（帯＝薄壁＋オーナー
    // 壁の組へ正面から当たる端は、薄壁の内側線（継ぎ目）を経てオーナー壁の下地も通り抜ける。
    // 1回だけだと薄壁の内側線で止まり、通し壁が突き当たる壁の位置で分かれているとき、交差部の
    // 矩形がどの壁の材でもなくなる）。
    let target = coord, studTarget = null;
    for (let round = 0; round < 4; round++) {
      let next = null;
      for (const v of partners) {
        // 端がvの材の中／面上にあること（＝突き当たっている／貫通している）
        if (target < v.material.lo - ENDPOINT_EPS || target > v.material.hi + ENDPOINT_EPS) continue;
        const join = finishJoinBoundary(v.finLine);
        if (join == null) continue; // 内側線が描かれない壁とは取り合わない
        // 相手の仕上げ面側から当たる端（入隅・T字。dir が相手の faceDir と逆）の**矩形**は、相手の
        // 内側線を越えて下地を通り抜け、その背面まで置く——入隅で両方の壁を相手の内側線で止めると、
        // 2本の内側線に挟まれた下地どうしの角の矩形がどちらの材でもなくなり、輪郭線で囲まれて見える
        // （実機 1階 X=-1600×Y=-6000 の偏芯壁どうしの入隅）。T字では相手の下地の中に隠れるので
        // 見た目は同じ。相手が対称壁なら背面は軸CL（ペアの反対側の壁との継ぎ目）——ペアの壁が
        // そこに在る（材が継ぎ目を含む）ときだけ通り抜け、無ければ内側線に置く（軸CL上に妻線が出る）。
        // 相手の背面側から当たる端（出隅。壁生成が相手の遠位面まで伸ばした端）は相手の内側線に置く
        // ＝短縮。薄壁（下地なし）は内側線＝背面なので区別が無い。
        // **スタッドの範囲**は最初に当たる相手の内側線まで（相手の下地の中へ間柱を描かない）。
        const back = v.backing ? (dir > 0 ? v.backing.hi : v.backing.lo) : null;
        const through = dir !== v.faceDir && v.backing && (!v.symmetric || partners.some(o =>
          o !== v && o.material.lo <= back + ENDPOINT_EPS && o.material.hi >= back - ENDPOINT_EPS));
        const at = through ? back : join;
        if (next == null || dir * (at - next) < 0) next = at;                  // 本体に最も近い位置
        if (round === 0 && (studTarget == null || dir * (join - studTarget) < 0)) studTarget = join;
      }
      if (next == null || Math.abs(next - target) <= ENDPOINT_EPS) break;
      target = next;
    }
    if (studTarget == null) continue; // 取り合う相手が無い＝物理端のまま
    if (end === 'lo') { bLo = target; sLo = studTarget; mLo = Math.min(mLo, target); }
    else { bHi = target; sHi = studTarget; mHi = Math.max(mHi, target); }
  }
  return {
    material: [mLo, mHi],
    backing: w.backing && bHi > bLo ? [bLo, bHi] : null,
    studs: w.backing && sHi > sLo ? [sLo, sHi] : null,
  };
}

/**
 * 端部を仕上げ材が回り込む端（木口線を出す端）。旧 `resolveWallLines` の ecap 判定と同じ2条件:
 * 低い壁の端部を覆った端（パス0の endWrap）と、軸CLの線分範囲を越えた端点はねだし。
 */
function wrapEndsFor(w, junction, endpointAt) {
  const out = {};
  const finish = w.wallFinish > 0 ? w.wallFinish : 0;
  if (finish <= 0) return out;
  if (junction?.endWrap?.lo) out.lo = true;
  if (junction?.endWrap?.hi) out.hi = true;
  if (w.extentLo != null && w.spanLo < w.extentLo && endpointAt?.lo) out.lo = true;
  if (w.extentHi != null && w.spanHi > w.extentHi && endpointAt?.hi) out.hi = true;
  return out;
}

/**
 * @typedef {{vertical:boolean, at:number, lo:number, hi:number, kind:string, ids:string[],
 *   style?:'knee'|'drop'}} WallRegionLine
 *   世界mm座標の線分。`kind` は 'face'|'cap'|'fin'|'ecap'（仕上げ材。描画は同じ）と 'kd'|'kdcap'
 *   （天板の長辺・端部。`style` が線種＝腰壁は実線・垂れ壁は破線）。`ids` は畳まれた1本に
 *   寄与したすべての壁のid（代表元＝この線を持つ壁を含む）。
 */

/**
 * 壁の集合から材の領域を組み立て、境界の線分を**壁ごと**に振り分けて返す。
 *
 * @param {object[]} walls graph.walls
 * @param {{
 *   junctions?: Map<string, object>|null,
 *   openingsByWall?: Map<string, object[]>,
 *   kneeDropOverlays?: Map<string, object>|null,
 *   endpointAtByWall?: Map<string, {lo:boolean, hi:boolean}>,
 *   columnWraps?: Array<{id:string, outer:{xLo:number,xHi:number,yLo:number,yHi:number},
 *     finishes:{xLo?:number,xHi?:number,yLo?:number,yHi?:number}}>|null,
 *   clipGroups?: Map<string, string>|null,
 *   detail?: boolean,
 * }} deps
 *   clipGroups: 壁id → 描画クリップの単位（同じ単位の壁とだけ線を畳む。上記 wallInput 参照）。
 * @returns {{lines: Map<string, WallRegionLine[]>, backingSpans: Map<string, [number,number]|null>}}
 *   lines: 壁id → その壁が描く線分。
 *   backingSpans: 壁id → 下地スタッドを並べる長さ方向の範囲（取り合い・回り込みの正規化済み）。
 */
export function resolveWallRegionLines(walls, {
  junctions = null, openingsByWall = null, kneeDropOverlays = null,
  endpointAtByWall = null, columnWraps = null, clipGroups = null, detail = true,
} = {}) {
  const inputs = [];
  for (const wall of walls) {
    if (wall.type !== ShapeType.WALL) continue;
    inputs.push(wallInput(wall, {
      junction: junctions?.get(wall.id),
      openings: openingsByWall?.get(wall.id),
      kneeDrop: kneeDropOverlays?.get(wall.id),
      clipGroup: clipGroups?.get(wall.id) ?? null,
    }));
  }
  const active = inputs.filter(w => !w.capOutline && w.spans.length > 0);

  const materialRects = [], backingRects = [];
  const backingSpans = new Map();
  for (const w of active) {
    const hide = w.symmetric ? seamSide(w.isVertical, w.faceDir) : undefined;
    const tag = { styleKey: w.drawKey, isVertical: w.isVertical };
    const wrapEnds = wrapEndsFor(w, junctions?.get(w.id), endpointAtByWall?.get(w.id));
    const { material: mSpan, backing: bSpan, studs } = endSpansFor(w, active, wrapEnds);
    backingSpans.set(w.id, studs);
    for (const [a, b] of w.spans) {
      // 端の正規化は壁の**物理端に接する区間**だけに効かせる（開口で分かれた内側の端は
      // 開口の縁であって壁の端ではない）。
      const atLo = a <= w.spanLo, atHi = b >= w.spanHi;
      const m = rect(w.isVertical, atLo ? mSpan[0] : a, atHi ? mSpan[1] : b,
        w.material.lo, w.material.hi, w.id, tag, hide);
      if (m) materialRects.push(m);
      if (!bSpan) continue;
      const bLo = atLo ? bSpan[0] : a;
      const bHi = atHi ? bSpan[1] : b;
      if (bHi <= bLo) continue;
      const r = rect(w.isVertical, bLo, bHi, w.backing.lo, w.backing.hi, w.id, tag);
      if (r) backingRects.push(r);
    }
  }

  const out = new Map();
  const push = (e, lo, hi, kind, style) => {
    if (!(hi > lo)) return;
    const list = out.get(e.id) ?? out.set(e.id, []).get(e.id);
    const line = { vertical: e.vertical, at: unq(e.at), lo: unq(lo), hi: unq(hi), kind, ids: e.ids };
    if (style) line.style = style;
    list.push(line);
  };

  // 柱の仕上げ包み（柱壁）は全高の材として領域に参加する——ただし**覆い判定だけ**（`covers`）で、
  // 境界は出さない。柱壁の線は renderer/StructuralLayer.jsx が描き、壁の面線が引き継ぐ辺
  // （finish/columnWrap.js の `continued`＝壁の仕上げ面へ揃えてトリムした辺）だけを省く。
  // 領域側では、柱壁の材が覆う壁の辺（引き継ぐ辺の柱壁の区間・柱壁に呑まれた妻線）が出なくなる
  // ので、両者で同じ辺を描かず、欠けもしない。層ごとに矩形が違う: 材＝外形、下地＝外形を各辺の
  // 仕上げ厚（`finishes`。壁の仕上げ面へ揃えた辺では相手の内側線まで外へ出るので負）だけ内側へ寄せたもの
  // ——壁の内側線は柱壁の内側境界の位置で途切れ、柱壁の内側境界の線へ折れて続く。
  const wrapOuter = [], wrapInner = [];
  for (const c of columnWraps ?? []) {
    const o = c.outer, f = c.finishes ?? {};
    const outer = rectFromMm(o.xLo, o.xHi, o.yLo, o.yHi, `col:${c.id}`);
    if (outer) wrapOuter.push(outer);
    const inner = rectFromMm(o.xLo + (f.xLo ?? 0), o.xHi - (f.xHi ?? 0), o.yLo + (f.yLo ?? 0), o.yHi - (f.yHi ?? 0), `col:${c.id}`);
    if (inner) wrapInner.push(inner);
  }

  // 材の合併境界 → 面線・妻線
  for (const e of unionBoundary(materialRects, wrapOuter)) {
    push(e, e.lo, e.hi, e.vertical === !!e.tag?.isVertical ? 'face' : 'cap');
  }
  // 下地の合併境界のうち材（柱壁の材を含む）の厳密内部にある部分 → 内側線・木口線（詳細LODのみ）
  if (detail) {
    const interior = wrapOuter.length ? [...materialRects, ...wrapOuter] : materialRects;
    for (const e of unionBoundary(backingRects, wrapInner)) {
      for (const [lo, hi] of clipEdgeToInterior(e, interior)) {
        push(e, lo, hi, e.vertical === !!e.tag?.isVertical ? 'fin' : 'ecap');
      }
    }
  }

  // 天板（腰壁・垂れ壁）: 全高の材（壁と柱壁）を差し引いた高さクラスごとの領域。
  resolveCapLines(inputs, wrapOuter.length ? [...materialRects, ...wrapOuter] : materialRects, push);
  return { lines: out, backingSpans };
}

