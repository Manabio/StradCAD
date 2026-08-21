/**
 * 展開図: 段差見付け面（部分指定の子Roomが親より低いFLで壁際に接するとき、その段差の
 * 「見えがかり（見付け）」を1枚の面として描くための抽出・合成）。設計意図は
 * .claude/elevation-model.md 参照。
 */
import { cellBoundsList, outlineSegments, worldToCell } from '../finish/gridCells.js';
import { letterOf, DIR_SIGN, perpFaceAt, CORNER_TOL_MM } from './elevationFaces.js';
import { roomOwnerByCell, collectRunBreaks, findRunCLAt } from './elevationFloorProfile.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { MIN_FACE_RUN_MM, GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from './elevationStyle.js';
// GAP_EPS: 物理的に意味を持たない極小幅(mm)の許容差。CL昇格/降格・再スナップ由来の
// sub-micron誤差を吸収する目的（elevationFloorProfile.js等と共通。R4）。
// PROBE_EPS_MM: 輪郭線分から内側/外側へ覗き込むプローブ距離（R4共通定数）。

/**
 * parentRoom（自身の未指定セル＋各部分指定の子）をFLの異なるゾーンごとにグループ化し、
 * 「自分より低い隣」に接する外形線分（見付け面の元）を抽出する。
 * まずセルキー→owner（親 or 部分指定の子。子が親を上書き）の索引を室内全域について作り、
 * ownerごとにグループ化してcellBoundsList→outlineSegments（finish/gridCells.js）で外形線分を
 * 求める。各線分を分割CL値で刻み、外側（±PROBE_EPS_MM）の点をworldToCellで判定する:
 *   - 索引に無いセル（部屋外・他室）→ 捨てる（壁がある境界は既存のwallAdjacentFloorSegmentsが
 *     床の段差プロファイルとして描く。ここは「同じ部屋の中で壁の無い内部境界」だけを対象にする）
 *   - 自分自身のグループ（内側へ覗いた場合）→ 捨てる
 *   - 相手のFL >= 自分のFL → 捨てる（見えがかりが生じない・重複排除。低い側からは生成しない）
 *   - 相手のFL < 自分のFL → 採用。inward=相手（低い側）へ向かう符号
 * 同一value・inward・(highFL,lowFL)で隣接する区間は結合する。
 * @param {import('@core').Room} parentRoom
 * @param {object} graph
 * @returns {Array<{isVertical:boolean, value:number, lo:number, hi:number, inward:1|-1,
 *   highFL:number, lowFL:number, ownerRoom:import('@core').Room}>}
 */
export function stepRiserSegments(parentRoom, graph) {
  // 部屋全体をownerごとにグループ化する索引（子が親を上書き。QA修正: elevationFloorProfile.js の
  // roomOwnerByCellへ統合——elevationStepFace.js独自のownerByCell構築を廃止）。
  const ownerByCell = roomOwnerByCell(parentRoom, graph);
  const groups = new Map(); // owner -> cellKey[]
  for (const [key, owner] of ownerByCell) {
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(key);
  }

  const out = [];
  for (const [owner, keys] of groups) {
    const ownerFL = graph.effectiveFloorLevel(owner);
    const bounds = cellBoundsList(keys, graph);
    if (bounds.length === 0) continue;

    for (const seg of outlineSegments(bounds)) {
      // 線分自身の伸びる方向のCLで刻む（outlineSegmentsの線分は縦線(isVertical=true)ならy方向に、
      // 横線ならx方向に伸びる——線分の伸びる方向と直交するCLではなく、線分自身と同じ向きの
      // 中心線で刻む。elevationFloorProfile.jsのcollectRunBreaksと実装が完全同一のためR2で統合）。
      const breaks = collectRunBreaks(graph, seg.isVertical, seg.lo, seg.hi);
      for (let i = 0; i + 1 < breaks.length; i++) {
        const lo = breaks[i], hi = breaks[i + 1];
        // QA修正: CL昇格/降格・再スナップ等で「同じ位置のはずの別CL」が極小差(sub-micron)で
        // 隣接すると、collectRunBreaksが物理的に意味を持たない極小幅の区間を作ることがある
        // （elevationFloorProfile.jsのwallAdjacentFloorSegmentsで同種のバグを修正済み——
        // GAP_EPS吸収パス。ここは「常に全区間を覆う」制約が無くsegs単独で成立するため、
        // 吸収ではなく単純に読み飛ばす=幅0の見付け面を生成しない）。
        if (hi - lo < GAP_EPS) continue;
        const mid = (lo + hi) / 2;
        for (const inward of [1, -1]) {
          const probe = inward * PROBE_EPS_MM;
          const wx = seg.isVertical ? seg.value + probe : mid;
          const wy = seg.isVertical ? mid : seg.value + probe;
          const cell = worldToCell(wx, wy, graph);
          if (!cell) continue; // セルなし（部屋外）→ 捨てる
          const otherOwner = ownerByCell.get(cell.key);
          if (!otherOwner || otherOwner === owner) continue; // 他室 or 自グループ側 → 捨てる
          const otherFL = graph.effectiveFloorLevel(otherOwner);
          if (otherFL >= ownerFL) continue; // 相手が高い/同じ → 重複排除で捨てる
          out.push({
            isVertical: seg.isVertical, value: seg.value, lo, hi, inward,
            highFL: ownerFL, lowFL: otherFL, ownerRoom: owner,
            // 問題修正2026-08その6: 低い側（見付けの先に見えるエリア）の所有Room。見付け面の
            // 天井断面（=低い側エリアの天井）の解決に使う。
            lowOwnerRoom: otherOwner,
          });
        }
      }
    }
  }
  return mergeRiserSegments(out);
}

// 同一value・inward・(highFL,lowFL)・両側の所有Roomで隣接する区間を結合する
// （問題修正2026-08その6: 所有Roomが異なるとFLが同じでも天井高さ(CH)が異なりうるため結合しない）。
function mergeRiserSegments(segs) {
  const sorted = [...segs].sort((a, b) =>
    a.isVertical - b.isVertical || a.value - b.value || a.inward - b.inward || a.lo - b.lo);
  const merged = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.isVertical === s.isVertical && last.value === s.value && last.inward === s.inward &&
        last.highFL === s.highFL && last.lowFL === s.lowFL &&
        last.ownerRoom === s.ownerRoom && last.lowOwnerRoom === s.lowOwnerRoom && last.hi === s.lo) {
      last.hi = s.hi;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * stepRiserSegments の1件 → 見付け面（buildRoomFacesの面と同型＋kind:'step'）。
 * letter/dirSign/originWorldは通常面と同じ式（letterOf(seg.isVertical,seg.inward)・DIR_SIGN）。
 * lo/hiは両端にある直交壁面のfaceValueへ詰める（CORNER_TOL_MM以内に直交壁面が無ければCL値のまま）。
 * @param {object} seg - stepRiserSegmentsの1件
 * @param {object[]} wallFaces - buildRoomFacesの面配列（隅探索用）
 * @param {object} graph
 * @param {number} parentFL - 親Roomの実効FL（graph.effectiveFloorLevel(parentRoom)）。
 *   baseFloorDeltaMmは他の面のfloorDeltaMmと同じ「親Room基準の相対値」で持つ
 *   （buildFaceFigureのfloorYOf(s)=-s.floorDeltaMmと同じ座標系に揃えるため）。
 * @returns {object}
 */
export function buildStepFaces(seg, wallFaces, graph, parentFL) {
  const letter = letterOf(seg.isVertical, seg.inward);
  const dirSign = DIR_SIGN[letter];
  const axisCL = findAxisCL(graph, seg.isVertical, seg.value);
  const loFace = perpFaceAt(wallFaces, seg.isVertical, seg.value, seg.lo);
  const hiFace = perpFaceAt(wallFaces, seg.isVertical, seg.value, seg.hi);
  let lo = loFace ? loFace.faceValue : seg.lo;
  let hi = hiFace ? hiFace.faceValue : seg.hi;
  // QA修正（幅0の展開図バグ）: 元のseg自体が短い（隣接する2つの隅にごく近い）場合、両端の
  // 隣接壁面のfaceValueへ個別に詰めるとスナップ後にlo>=hiへ反転・退化しうる（例: 短い見付け面の
  // 両端が異なる方向へスナップされ交差する）。反転・退化したらスナップ前のCL値(seg.lo/hi)へ
  // フォールバックする——それでも短い場合はcomposeRoomFaces最終段のMIN_FACE_RUN_MMガードが除去する。
  if (hi - lo < GAP_EPS) { lo = seg.lo; hi = seg.hi; }
  const stepHeightMm = seg.highFL - seg.lowFL;
  // QA修正（項目4根本原因）: startCLId/endCLIdへ段差自身のaxisCL.id（=面に直交する軸）を
  // 両端とも詰めていたため、faceBoundaryLocalX（startCLId/endCLIdの位置差でROW1境界を求める）が
  // 同一CLの差=0という退化した幅0の境界を返していた。通常面と同じ規約
  // （startCLIdは世界座標loを・endCLIdは世界座標hiを決めるCLのid。elevationOpenSpan.jsの
  // resolveEndのコメント参照）に合わせ、両端の直交壁面（loFace/hiFace）自身のaxisCL.idを使う
  // ——見つからなければ段差自身のaxisCL.id（従来どおり。退化はするが少なくとも例外にはしない）。
  const startCLId = loFace ? loFace.axisCL.id : (axisCL?.id ?? null);
  const endCLId   = hiFace ? hiFace.axisCL.id : (axisCL?.id ?? null);
  // 問題修正2026-08その6（ユーザー明示指示。実機の「C1」=この見付け面）: 見付け面は
  // 「低い側エリア（例: 部屋3）を見込む展開図」——天井断面はその低い側エリア自身の天井
  // （ceilAbsMm=低い側FL+低い側の解決済みCH）。高い側エリア（親3'等）の天井は
  // 「向こう側の天井」としてbeyondCeilAbsMmに持ち、天井断面より上なら細線の破線で描く
  // （「C1の天井断面上+100に3'の天井を表す破線」）。lowOwnerRoom未設定（旧経路）は
  // 低い側FL+帯CHへフォールバック。
  const lowCeilAbsMm = (seg.lowFL - parentFL) +
    roomCeilingHeight(graph, seg.lowOwnerRoom ?? seg.ownerRoom).mm;
  const highCeilAbsMm = (seg.highFL - parentFL) + roomCeilingHeight(graph, seg.ownerRoom).mm;
  return {
    letter, dirSign, isVertical: seg.isVertical, axisCL, inward: seg.inward,
    faceValue: seg.value, hasRealWall: true,
    lo, hi, run: hi - lo, originWorld: dirSign > 0 ? lo : hi,
    startCLId, endCLId,
    // 見付け面は常に壁あり端扱い（意図的）: 両端縦線は「実際に切断される壁の断面」として
    // 常にCUTで描く仕様（elevation-model.md「段差見付け面」節・ユーザー明示指示）のため、
    // 通常面の壁のない端部判定（perpWallCrossesFacePlane）は通さない。
    hasWallAtLocal0: true, hasWallAtLocalRun: true,
    kind: 'step', stepHeightMm, baseFloorDeltaMm: seg.lowFL - parentFL,
    ceilAbsMm: lowCeilAbsMm, beyondCeilAbsMm: highCeilAbsMm,
  };
}

// R6: axis方向（isVertical面ならVERTICAL）のCL探索は、findRunCLAt（run方向=axis方向の反転）に
// isVerticalを反転して渡すのと等価なため委譲する（elevationFloorProfile.js）。
function findAxisCL(graph, isVertical, value) {
  return findRunCLAt(graph, !isVertical, value);
}

/**
 * riserSegs（stepRiserSegmentsの結果。段差見付け面の候補）から、faces中の同一
 * (isVertical, axisCL.value, inward) を持つ面の open スパンが覆う区間を差し引く（仕様3+開放
 * スパンの相互排除）。開放スパン（elevationOpenSpan.js）は「壁のある区間の先に続く同室の
 * 開放区間」を面自体の一部として描くため、その区間に段差見付け面を独立して重ねて描くと
 * 二重表現になる——D1/B1のような「面平面上の段差」はopenスパン側の遠側床線・あきで表現し、
 * 段差見付け面は「面平面の外（同一(isVertical,axisCL.value,inward)の面が存在しない位置）」の
 * 内部段差だけを対象にする。
 * 差し引いた残りの幅がMIN_FACE_RUN_MM未満の断片は捨てる（意味を持たない極小段差見付け面を
 * 作らないため。elevationFaceList.jsの最終フィルタと同じ考え方）。
 * @param {Array<{isVertical:boolean, value:number, lo:number, hi:number, inward:1|-1}>} riserSegs
 * @param {object[]} faces - extendFacesWithOpenSpans適用後の面配列（spansを持つ）
 * @returns {Array<{isVertical:boolean, value:number, lo:number, hi:number, inward:1|-1}>}
 */
// 区間配列を昇順に統合する（隣接・重複を1本化）。
function unionRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + GAP_EPS) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// segs（{lo,hi}[]）を、rangesのいずれかと重なる部分だけに丸める（積集合）。
function clipToRanges(segs, ranges) {
  const out = [];
  for (const seg of segs) {
    for (const [rlo, rhi] of ranges) {
      const lo = Math.max(seg.lo, rlo), hi = Math.min(seg.hi, rhi);
      if (hi - lo >= GAP_EPS) out.push({ lo, hi });
    }
  }
  return out;
}

export function subtractOpenSpanCoverage(riserSegs, faces) {
  const out = [];
  for (const r of riserSegs) {
    const matchingFaces = faces.filter(f =>
      f.kind !== 'step' && f.isVertical === r.isVertical &&
      f.axisCL.value === r.value && f.inward === r.inward);

    let remaining = [{ lo: r.lo, hi: r.hi }];
    if (matchingFaces.length > 0) {
      // riserはセル輪郭の生CL値基準で抽出されるが、matchingFacesの[lo,hi]は実壁の隅で
      // 仕上げ面基準にスナップされた描画範囲——両者は壁厚みぶん(数十mm)ズレることがある。
      // riserの端がmatchingFacesの描画範囲の外（壁厚みの内側）にはみ出す部分は、対応する面が
      // そもそも描かれない位置なので、先に面の合計描画範囲へ丸めておく（そうしないとopen区間の
      // 外側にごく僅かな幅の見付け面が残ってしまう。実際にこの不具合で幅50mm前後の縮退した
      // 見付け面が生成されるのを発見・修正した）。
      const covered = unionRanges(matchingFaces.map(f => [Math.min(f.lo, f.hi), Math.max(f.lo, f.hi)]));
      remaining = clipToRanges(remaining, covered);
    }
    for (const f of matchingFaces) {
      if (!f.spans) continue;
      for (const s of f.spans) {
        if (s.kind !== 'open') continue;
        const worldA = f.originWorld + s.loX * f.dirSign;
        const worldB = f.originWorld + s.hiX * f.dirSign;
        const openLo = Math.min(worldA, worldB), openHi = Math.max(worldA, worldB);
        const next = [];
        for (const seg of remaining) {
          if (openHi <= seg.lo + GAP_EPS || openLo >= seg.hi - GAP_EPS) { next.push(seg); continue; } // 重ならない
          if (openLo > seg.lo) next.push({ lo: seg.lo, hi: Math.min(openLo, seg.hi) });
          if (openHi < seg.hi) next.push({ lo: Math.max(openHi, seg.lo), hi: seg.hi });
        }
        remaining = next.filter(seg => seg.hi - seg.lo >= GAP_EPS);
      }
    }
    for (const seg of remaining) {
      if (seg.hi - seg.lo < MIN_FACE_RUN_MM) continue; // 差し引いた残りが極小なら捨てる
      out.push({ ...r, lo: seg.lo, hi: seg.hi });
    }
  }
  return out;
}

/**
 * faces（袖壁分割済みの面配列）に段差見付け面を挿入する（仕様3）。
 * 挿入位置: 見付け面の始点（local x=0 の世界座標）を含む壁面W（直交・span内包・faceValue
 * 最近接。CORNER_TOL_MM）の直後。候補複数ならchain index最大。Wが無ければ末尾。
 * 開放スパン（elevationOpenSpan.js）が同じ区間を面自体の一部として既に表現している場合は
 * subtractOpenSpanCoverageで差し引き、独立した見付け面としては挿入しない（相互排除）。
 * @param {object[]} faces
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object[]}
 */
export function insertStepFaces(faces, room, graph) {
  const rawRisers = stepRiserSegments(room, graph);
  const risers = subtractOpenSpanCoverage(rawRisers, faces);
  if (risers.length === 0) return faces;

  const parentFL = graph.effectiveFloorLevel(room);
  const stepFaces = risers.map(seg => buildStepFaces(seg, faces, graph, parentFL));
  const out = [...faces];
  for (const step of stepFaces) {
    const startWorld = step.dirSign > 0 ? step.lo : step.hi; // local x=0 の世界座標（段差自身の軸上）
    // 直交面fはisVertical=false（例）ならfの位置(axisCL)がY・スパン(lo/hi)がXという具合に、
    // 段差面とは軸が入れ替わる——「段差の固定軸位置(faceValue)がfのスパン内か」（到達判定）と
    // 「段差の始点(startWorld)とfの位置(axisCL)の近さ」（どちらが最寄りか）は別の軸同士の比較になる
    // 点に注意（nearestPerpFaceAtと同じ理屈）。
    let insertAfter = -1;
    let bestDist = Infinity;
    for (let i = 0; i < out.length; i++) {
      const f = out[i];
      if (f.kind === 'step') continue;
      if (f.isVertical === step.isVertical) continue; // 直交のみ
      if (!(step.faceValue >= f.lo - CORNER_TOL_MM && step.faceValue <= f.hi + CORNER_TOL_MM)) continue;
      const dist = Math.abs(f.axisCL.effectiveValue - startWorld);
      // QA修正（幅0の展開図バグの調査で発見。nearestPerpFaceAtと同じ穴）: 到達判定（上のif）だけ
      // ではdistに上限が無く、真に隅を共有しない遠い直交面でも「その時点でいちばん近い」という
      // だけでW扱いにしてしまっていた。CORNER_TOL_MM以内でなければ候補にしない
      // （「Wが無ければ末尾」というdocコメントの規則を実際に成立させる）。
      if (dist > CORNER_TOL_MM) continue;
      if (dist <= bestDist) { bestDist = dist; insertAfter = i; } // 同着はindex最大を優先(<=)
    }
    if (insertAfter === -1) out.push(step);
    else out.splice(insertAfter + 1, 0, step);
  }
  return out;
}
