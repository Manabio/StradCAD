/**
 * 展開図: 面の範囲を「壁のあるアウトラインエッジ」から「同一axisCL平面上でnear側に自室セルが
 * 連続する最大区間」へ拡張する（開放スパン。純関数のみ・描画に触れない）。設計意図は
 * .claude/elevation-model.md 参照。
 *
 * 従来のbuildRoomFacesは実際に生成されたWall（部屋の外周）だけから面を作るため、同じ部屋の
 * 内部で壁が存在しない区間（同室のセル同士が直接隣接する箇所）は面に含まれず、そこで面が
 * 途切れていた。ユーザー期待図は「壁のある区間＋壁のない開放区間」を1枚の連続した面として
 * 描くことを要求する——開放区間の先には別の実効FLを持つセル（部分指定や別部屋）が続き、
 * そちらの床が「見えがかり」として見える、という建築表現。
 *
 * 実装方針: room自身の登録セル（refreshCells。extent解決済み＝gridCells.jsに委譲、ここでは
 * 再実装しない）のうち、この面のaxisCL・near側に接するもの全件を列挙し（wallAdjacentFloorSegments
 * と同じ「near側限定」の考え方）、各セルのfar側（axisCLを挟んだ反対側）を1点プローブして
 * wall/openを分類する。既存のface.lo/hi（実壁の隅で確定済み）を含む連続クラスタだけを採用する
 * ——微小刻みでface.lo/hiの外側へプローブする方式は、確定済みの隅（直交壁の厚み帯）の内側を
 * 誤って「壁あり」と拾い続けてしまうため採用しない（この方式で実際に不具合を確認・破棄した）。
 */
import { refreshCells, cellBoundsFromKey, worldToCell } from '../finish/gridCells.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import {
  roomOwnerByCell, runBoundaryCLIds, collectRunBreaks, findRunCLAt, cellNearSideOnFace,
  cellStraddlesFace,
} from './elevationFloorProfile.js';
import { perpFaceAt, perpWallCrossesFacePlane } from './elevationFaces.js';
import { MIN_FACE_RUN_MM, GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from './elevationStyle.js';

// 跨ぎ由来の「アキだけ（情報ゼロ）の区間」が図全体に占めてよい上限比（ユーザー基準2026-08その9）。
const MAX_VOID_SPAN_RATIO = 1 / 4;
// PROBE_EPS_MM: far側セルへ覗き込むプローブ距離（elevationStyle.jsのR4共通定数）。

/**
 * near側セル・far側セルから、この区間を延長してよいか（isOpenSpanEligible）を判定する
 * デフォルト実装——常にtrue（アルコーブ等も統合対象にする）。切替可能にするため1関数へ
 * 切り出す（将来、統合を制限したくなった場合はこの関数だけ差し替えればよい）。
 * @returns {boolean}
 */
export function isOpenSpanEligible(nearCell, farCell, graph) {
  void nearCell; void farCell; void graph;
  return true;
}

// room自身の登録セルのうち、face.axisCLのnear側（inwardの向く側）に接するもの一覧（runLo昇順）。
// 各セルについて、far側（axisCLを挟んだ反対側の1点）をプローブしてwall/openを分類する:
//   - farセルが無い、またはownerByCellに無い（他室・部屋外）→ wall
//   - farセルがownerByCellにある（親でも部分指定の子でも「同室」扱い）→ open
// 自室のセル境界はfar側の部屋境界より粗いことがある（例: extentLo/Hiで範囲制限されたCLが
// near側の行では有効域外にあり分割されない）——1セルを1点だけでプローブすると、far側で
// 実際には複数の部屋にまたがる区間を丸ごと誤分類してしまう。runの伸びる方向のCLで刻んでから
// 区間ごとに個別プローブする（QA修正: 実際にこの不具合でopen/wallの境界が抜け落ちるのを発見・
// 修正した）。
function collectNearCellSegments(face, ownerByCell, room, graph) {
  const axisValue = face.axisCL.value;
  // QA G5: roomCeilingHeightは内部でgraph.rooms.findを回すため、セル×刻み毎に呼び直さず
  // Roomごとにメモ化する（elevationFloorProfile.jsのchByRoomと同じパターン）。
  const chByRoom = new Map();
  const chOf = r => {
    if (!chByRoom.has(r.id)) chByRoom.set(r.id, roomCeilingHeight(graph, r).mm);
    return chByRoom.get(r.id);
  };
  const segs = [];
  for (const key of refreshCells(room.cells, graph)) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    // near側の辺が軸に一致するセルに加え、軸を跨ぐセル（面のCLがその位置まで延長されておらず
    // 分割されなかったセル）も対象にする——どちらも near 側は自室が占めており、跨ぐ場合は
    // far側も同じセル＝抜けている（open）。跨ぎを拾わないと、CLが届いていない帯の抜けが
    // 開放区間として描かれない（問題修正2026-08その9。実機2階の室22 A1のX3..X4）。
    // 跨ぎ由来の区間は「そこには境界線が1本も無い＝完全な空白」であり、取り込みすぎると図が
    // アキだらけになるため、延長の可否はstraddleフラグを見てextendFaceWithOpenSpansが決める。
    const touching = cellNearSideOnFace(face, b, axisValue);
    if (!touching && !cellStraddlesFace(face, b, axisValue)) continue;
    const [cellRunLo, cellRunHi] = face.isVertical ? [b.y1, b.y2] : [b.x1, b.x2];
    const { loCLId: cellLoCLId, hiCLId: cellHiCLId } = runBoundaryCLIds(key, face.isVertical);

    const breaks = collectRunBreaks(graph, face.isVertical, cellRunLo, cellRunHi);
    for (let i = 0; i + 1 < breaks.length; i++) {
      const runLo = breaks[i], runHi = breaks[i + 1];
      if (runHi - runLo < GAP_EPS) continue;
      const mid = (runLo + runHi) / 2;
      const farX = face.isVertical ? axisValue - face.inward * PROBE_EPS_MM : mid;
      const farY = face.isVertical ? mid : axisValue - face.inward * PROBE_EPS_MM;
      const farCell = worldToCell(farX, farY, graph);

      let kind = 'wall', farFloorDeltaMm, farCeilAbsMm, informative = false;
      if (farCell && ownerByCell.has(farCell.key) && isOpenSpanEligible({ key }, farCell, graph)) {
        const farOwner = ownerByCell.get(farCell.key);
        kind = 'open';
        farFloorDeltaMm = graph.effectiveFloorLevel(farOwner) - graph.effectiveFloorLevel(room);
        // 問題修正2026-08その2: 開放先の天井の絶対高さ（band部屋FL基準。far床＋far所有Roomの
        // 解決済みCH）——描画側が「開放先の天井の見えがかり線」を引くのに使う。
        farCeilAbsMm = farFloorDeltaMm + chOf(farOwner);
        // informative（問題修正2026-08その8）: この区間が展開図として**情報を持つ**か。
        // near側とfar側でFLも天井高も同じなら、そこに描かれるのはアキ（バツ）だけ＝情報ゼロ。
        // FL差・CH差があれば遠側床線／遠側天井線という実体のある見えがかりが現れる。
        // 「入口側の隅」を越える延長を許すかの判定に使う（extendFaceWithOpenSpans）。
        const nearOwner = ownerByCell.get(key) ?? room;
        const nearFloorDeltaMm = graph.effectiveFloorLevel(nearOwner) - graph.effectiveFloorLevel(room);
        informative = farFloorDeltaMm !== nearFloorDeltaMm ||
          farCeilAbsMm !== nearFloorDeltaMm + chOf(nearOwner);
      }
      const loCLId = runLo === cellRunLo ? cellLoCLId : (findRunCLAt(graph, face.isVertical, runLo)?.id ?? null);
      const hiCLId = runHi === cellRunHi ? cellHiCLId : (findRunCLAt(graph, face.isVertical, runHi)?.id ?? null);
      segs.push({ runLo, runHi, kind, farFloorDeltaMm, farCeilAbsMm, informative, straddle: !touching, loCLId, hiCLId });
    }
  }
  segs.sort((a, b) => a.runLo - b.runLo);
  return segs;
}

// 隣接する同種区間（kind・farFloorDeltaMm・farCeilAbsMm・straddleが同じ、かつrunHi===次のrunLo）を
// 結合する。**straddleを結合キーに含める**のは、軸に接するセル由来の区間と跨ぎ由来（その位置に
// 境界線が1本も無い空白）の区間が地続きになったとき、1本に融合させないため——融合すると小さな
// 正当な開放区間まで巨大な空白と一体で取捨判定され、丸ごと落ちる（実機1階5/C2で、生の400の
// 開放区間が跨ぎ由来の2942と融合し55%扱いになって消えるのを確認・修正。問題修正2026-08その9）。
function mergeSameKind(segs) {
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind && last.farFloorDeltaMm === s.farFloorDeltaMm &&
        last.farCeilAbsMm === s.farCeilAbsMm && !!last.straddle === !!s.straddle &&
        Math.abs(last.runHi - s.runLo) < GAP_EPS) {
      last.runHi = s.runHi;
      last.hiCLId = s.hiCLId;
      last.informative = last.informative || s.informative; // 結合キーには含めない（既存の結合を変えない）
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * face を開放スパンぶん延長し、spans/extendedAtLocal0/extendedAtLocalRun/lo/hi/run/
 * startCLId/endCLId/hasWallAtLocal0/hasWallAtLocalRun を差し替えた新しい面オブジェクトを返す。
 * kind==='step'の面はそのまま素通りする（対象外）。
 * @param {object} face - buildRoomFacesの1件
 * @param {object[]} wallFaces - buildRoomFacesの面配列（延長後の端の隅スナップに使う）
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object}
 */
export function extendFaceWithOpenSpans(face, wallFaces, room, graph) {
  if (face.kind === 'step') return face;
  const ownerByCell = roomOwnerByCell(room, graph);
  const cellSegs = collectNearCellSegments(face, ownerByCell, room, graph);
  if (cellSegs.length === 0) return face; // near側に自室セルの境界が見つからない（合成face等）

  // face自身の既知区間（face.lo/hiは仕上げ面基準のため、隣接する実CL値ベースの区間と
  // 直接比較できない——「区間の中点がface.lo..hiに収まるか」でこの面自身の区間を同定する）。
  const knownMid = (face.lo + face.hi) / 2;
  const merged = mergeSameKind(cellSegs);
  const ownIdx = merged.findIndex(s => s.runLo <= knownMid && knownMid <= s.runHi);
  if (ownIdx === -1) return face; // 対応するセル区間が見つからない（安全側フォールバック）

  // mergedはroom自身が所有するセル区間だけを列挙したものであり、他室が間に挟まる箇所は
  // 要素そのものが欠落する（配列上は隣接していても、値としては連続していない）——
  // そのため「配列上ownIdxの前後を無条件に取り込む」のではなく、runHi===次のrunLoで
  // 実際に連続している範囲だけを延長対象にする（不連続なら他室領域を挟んでいるのでそこで止める。
  // 実際にこの不具合でC2/B2等の面のspansに他室領域ぶんの穴が空くのを発見・修正した）。
  const entrySideIsLo = face.dirSign > 0;
  let loBound = ownIdx, hiBound = ownIdx;
  while (loBound > 0 && Math.abs(merged[loBound - 1].runHi - merged[loBound].runLo) < GAP_EPS) loBound--;
  while (hiBound < merged.length - 1 && Math.abs(merged[hiBound].runHi - merged[hiBound + 1].runLo) < GAP_EPS) hiBound++;

  // 端の座標を確定するのに使う「元の面の端の状態」（延長しない端はそのまま引き継ぐ）。
  // 重要: face.lo/hi・startCLId/endCLIdは常に「世界座標のlo/hi」（dirSignに関わらずlo<=hi）を
  // 表す不変条件（snapFaceEndsToCornersのdocコメント参照）——loEndは常にface.startCLId/face.lo、
  // hiEndは常にface.endCLId/face.hiをフォールバックに使う（dirSignによる分岐は不要。これを
  // dirSignで分岐させていたのはQA修正: 実際にこの不具合でstartCLId/endCLIdが入れ替わり
  // ROW1境界が誤った位置に出ていたのを発見・修正した）。「延長されたか」の判定は
  // extendedAtLo/Hi（世界側lo/hiのフィールド。dirSignに関わらずそのまま使える）で行う。
  const origHasWallAtLo = face.dirSign > 0 ? (face.hasWallAtLocal0 ?? true) : (face.hasWallAtLocalRun ?? true);
  const origHasWallAtHi = face.dirSign > 0 ? (face.hasWallAtLocalRun ?? true) : (face.hasWallAtLocal0 ?? true);
  const origEdgeAtLo    = face.dirSign > 0 ? (face.edgeAtLocal0 ?? false) : (face.edgeAtLocalRun ?? false);
  const origEdgeAtHi    = face.dirSign > 0 ? (face.edgeAtLocalRun ?? false) : (face.edgeAtLocal0 ?? false);

  // さらに（問題修正2026-08その8/その9。ユーザー期待図「2階22」＋明示指示「情報を全く持って
  // いないところ（アキ・バツだけの区間）が描画延長の1/4を超えたら延長しない」）、取り込んだ
  // **端の区間**を次の規則で取捨する。落とした端は従来どおり「壁断面のない端部」（床・天井線を
  // 図の外へ延長して続きがあることを示す表現）で終わる。
  //   1. informative（near/farでFLか天井高が違う＝遠側床線・遠側天井線という実体が現れる）区間は
  //      常に残す。RoundFの2 C2(b側+50)・3 A2(g側-100)がこれ。
  //   2. 情報ゼロ（アキだけ）でも、**出口側の隅**（ローカルrun端＝chainで次の面へ渡る隅。
  //      dirSign>0ならworld hi・dirSign<0ならworld lo。originWorld=`dirSign>0?lo:hi`の裏返し）を
  //      越える延長で、かつ近側セルが軸に**接している**（＝その位置に境界線が実在する）なら残す。
  //      入隅は必ず2面で共有されるため、見通しそのものは出口側の面だけが担えば過不足がない。
  //      実機「2階22」のD2（段差CLの隅が出口側）がこれ。
  //   3. それ以外（入口側 or 跨ぎ由来＝その位置に境界線が1本も無い完全な空白）は、区間長が
  //      図全体の1/4以下のときだけ残す。
  // **比は「実際に描かれる長さ」で採る**——延長した端はresolveEndが直交壁の仕上げ面へ詰めるため、
  // 生のセル区間長とは大きく異なることがある（実機1階5/C2は生3400に対し描かれるアキは400。
  // 生の長さで判定すると、ユーザー確認済みの開放スパンまで落ちる）。そのため端の確定
  // （resolveEnd）を取捨ループの内側で行い、詰め後の値で比を採る。
  // 実機で確認: 残る=1階5/C2(400/3143=13%)・10/C2(743/3600=21%)・10/B2(943/4885=19%)・
  // 2階22のA1(942/8885=11%。跨ぎ)・2階22のD2(規則2)／落ちる=2階22のD1(3443/6885=50%。入口側で
  // Y1まで伸び図の半分がアキだった)・1階5/D1(1943/3443=56%)・壁のない端部フィクスチャの
  // 2' C2(49%。跨ぎ)・3' B1(75%。跨ぎ)。
  let loEnd, hiEnd;
  for (;;) {
    loEnd = resolveEnd(face, wallFaces, merged[loBound].runLo, face.startCLId, face.lo,
      loBound < ownIdx, origHasWallAtLo, origEdgeAtLo);
    hiEnd = resolveEnd(face, wallFaces, merged[hiBound].runHi, face.endCLId, face.hi,
      hiBound > ownIdx, origHasWallAtHi, origEdgeAtHi);
    const total = hiEnd.value - loEnd.value;
    const dropEnd = (i, isEntrySide, drawnLen) => {
      const g = merged[i];
      if (g.informative) return false;                // 規則1
      if (!isEntrySide && !g.straddle) return false;  // 規則2
      return drawnLen > total * MAX_VOID_SPAN_RATIO;  // 規則3
    };
    if (loBound < ownIdx && dropEnd(loBound, entrySideIsLo, merged[loBound].runHi - loEnd.value)) { loBound++; continue; }
    if (hiBound > ownIdx && dropEnd(hiBound, !entrySideIsLo, hiEnd.value - merged[hiBound].runLo)) { hiBound--; continue; }
    break;
  }
  const spans = merged.slice(loBound, hiBound + 1).map(s => ({ ...s }));
  const extendedAtLo = loBound < ownIdx;
  const extendedAtHi = hiBound > ownIdx;

  const extendedAtLocal0   = face.dirSign > 0 ? extendedAtLo : extendedAtHi;
  const extendedAtLocalRun = face.dirSign > 0 ? extendedAtHi : extendedAtLo;

  const newFace = {
    ...face,
    lo: loEnd.value, hi: hiEnd.value, run: hiEnd.value - loEnd.value,
    originWorld: face.dirSign > 0 ? loEnd.value : hiEnd.value,
    startCLId: face.dirSign > 0 ? loEnd.clId : hiEnd.clId,
    endCLId:   face.dirSign > 0 ? hiEnd.clId : loEnd.clId,
    hasWallAtLocal0:   face.dirSign > 0 ? loEnd.hasWall : hiEnd.hasWall,
    hasWallAtLocalRun: face.dirSign > 0 ? hiEnd.hasWall : loEnd.hasWall,
    edgeAtLocal0:      face.dirSign > 0 ? loEnd.edge : hiEnd.edge,
    edgeAtLocalRun:    face.dirSign > 0 ? hiEnd.edge : loEnd.edge,
    extendedAtLocal0, extendedAtLocalRun,
  };

  // spans最外側の境界を、セルの生CL値ではなく確定済みのloEnd/hiEnd.value（延長していなければ
  // 元のface.lo/hiという仕上げ面基準の値・延長していれば直交壁面のfaceValueへスナップ済みの値）
  // へ差し替える——内部境界（区間同士の境界）は生CL値のままでよい（実際にそこにCLがあるため）。
  spans[0].runLo = loEnd.value;
  spans[spans.length - 1].runHi = hiEnd.value;

  // 不変条件: 幅<MIN_FACE_RUN_MMのopen区間は前後のwallへ吸収する（意味を持たない極小の
  // 開放区間を作らない。前が無ければ次の区間へ）。
  for (let i = spans.length - 1; i >= 0 && spans.length > 1; i--) {
    const s = spans[i];
    if (s.kind !== 'open' || s.runHi - s.runLo >= MIN_FACE_RUN_MM) continue;
    if (i > 0) { spans[i - 1].runHi = s.runHi; spans[i - 1].hiCLId = s.hiCLId; }
    else spans[i + 1].runLo = s.runLo;
    spans.splice(i, 1);
  }
  const finalSpans = mergeSameKind(spans);

  // spansをローカルx（0..run）へ変換する。loX/hiX=仕上げ面基準（floorSegmentsと同じ二重管理規約）。
  // QA修正: dirSign<0の面はworld順とlocal順が反転する（wallAdjacentFloorSegmentsと同じ現象）ため、
  // 各区間のloCLId/hiCLId（world runLo/runHi側のCL id）もlocal側の意味に合わせて入れ替える
  // 必要がある——さらに「末尾（面全体で最後の区間）はhiCLId=null（境界ではなく面端そのもの）」
  // という判定も、world順のまま(i===finalSpans.length-1)で決めると、dirSign<0では並び替え後に
  // 別の区間へずれてしまう（実際にこの不具合でROW1に余計な分割点が出るのを発見・修正した）。
  // ソート後の配列順で最後の要素だけhiCLIdをnullにするという形で確定させる。
  const toLocal = worldCoord => (worldCoord - newFace.originWorld) * newFace.dirSign + 0;
  const localSpans = finalSpans.map(s => {
    const a = toLocal(s.runLo), b = toLocal(s.runHi);
    const swapped = a > b;
    return {
      loX: Math.min(a, b), hiX: Math.max(a, b), kind: s.kind,
      farFloorDeltaMm: s.kind === 'open' ? s.farFloorDeltaMm : undefined,
      farCeilAbsMm: s.kind === 'open' ? s.farCeilAbsMm : undefined,
      hiCLId: swapped ? s.loCLId : s.hiCLId,
    };
  }).sort((x, y) => x.loX - y.loX);
  localSpans[localSpans.length - 1].hiCLId = null; // 面全体の末尾は境界ではなく面端そのもの
  newFace.spans = localSpans.map(s => ({ ...s, hiCLX: s.hiCLId != null ? s.hiX : null }));

  return newFace;
}

// face の端（lo側 or hi側）を確定する。延長した場合は直交壁面のfaceValueへスナップ
// （perpFaceAt。見つかれば真の隅＝hasWall:true、無ければCL値のまま・hasWall:false）。
// ユーザー明示指示2026-08: 直交面が見つかっても、その実壁がこの面の切断面を室内側へ
// 横切っていない（perpWallCrossesFacePlane=false＝壁が面の向こう側だけにあり、図の端部に
// 壁断面が現れない）場合は壁のない端部として扱う——値もスナップせずCL値のまま
// （「図の端部が壁断面のない中心線の場合は、図の外側まで床と天井断面をのばす」）。
// 延長していない場合は元の値・元のhasWallをそのまま使う（実壁の隅・stairOpenings等の
// 壁のない端部いずれも、開放スパンとは無関係に既に正しい状態のため触らない）。
function resolveEnd(face, wallFaces, runCoord, origCLId, origValue, wasExtended, origHasWall, origEdge = false) {
  if (!wasExtended) {
    return { value: origValue, clId: origCLId, hasWall: origHasWall, edge: origEdge };
  }
  const perp = perpFaceAt(wallFaces, face.isVertical, face.axisCL.value, runCoord);
  const perpReal = !!perp && (perp.hasRealWall ?? true);
  if (perpReal) {
    // 実壁あり: 横切っていれば通常の隅（壁あり）、横切っていなければ見えがかりエッジ。
    // どちらも端座標は直交面のfaceValue（壁の実端）へ詰める（snapFaceEndsToCornersと同じ規約。
    // ユーザー確認2026-08: エッジ縦線・延長の起点は中心線位置ではなく壁の実端）。
    const crosses = perpWallCrossesFacePlane(perp, face);
    return { value: perp.faceValue, clId: perp.axisCL.id, hasWall: crosses, edge: !crosses };
  }
  return { value: runCoord, clId: perp?.axisCL.id ?? null, hasWall: false, edge: false };
}

/**
 * spans（extendFaceWithOpenSpansの結果）を、断片のローカル範囲[loLocal,hiLocal]へクリップし、
 * 断片自身のローカル座標系（x=0起点）へ再原点化する（splitFacesAtPartitionWallsが断片化した
 * 面用）。範囲外のspanは除去し、範囲をまたぐspanは境界でクリップする。
 * @param {Array<{loX:number, hiX:number, kind:string, farFloorDeltaMm?:number,
 *   hiCLX:number|null, hiCLId:string|null}>} spans
 * @param {number} loLocal
 * @param {number} hiLocal
 * @returns {Array<{loX:number, hiX:number, kind:string, farFloorDeltaMm?:number,
 *   hiCLX:number|null, hiCLId:string|null}>}
 */
export function clipSpans(spans, loLocal, hiLocal) {
  const out = [];
  for (const s of spans) {
    const lo = Math.max(s.loX, loLocal), hi = Math.min(s.hiX, hiLocal);
    if (hi - lo < GAP_EPS) continue;
    const keepsBoundary = s.hiCLId != null && Math.abs(hi - s.hiX) < GAP_EPS;
    out.push({
      loX: lo - loLocal, hiX: hi - loLocal, kind: s.kind, farFloorDeltaMm: s.farFloorDeltaMm,
      farCeilAbsMm: s.farCeilAbsMm,
      hiCLX: keepsBoundary ? hi - loLocal : null,
      hiCLId: keepsBoundary ? s.hiCLId : null,
    });
  }
  return out;
}

/**
 * faces（buildRoomFacesの結果）全件へ開放スパンを適用し、同一(axisCL.id, inward)で範囲が
 * 重なる面はchain順で最先のものを残して包絡する。
 * @param {object[]} faces
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object[]}
 */
export function extendFacesWithOpenSpans(faces, room, graph) {
  const extended = faces.map(f => extendFaceWithOpenSpans(f, faces, room, graph));

  // 同一(axisCL.id, inward)で範囲(lo..hi)が重なる面はchain順最先を残し、他は包絡へ吸収して除去する。
  const out = [];
  for (const f of extended) {
    if (f.kind === 'step') { out.push(f); continue; }
    const dupIdx = out.findIndex(o =>
      o.kind !== 'step' && o.axisCL.id === f.axisCL.id && o.inward === f.inward &&
      f.lo < o.hi - GAP_EPS && f.hi > o.lo + GAP_EPS);
    if (dupIdx === -1) { out.push(f); continue; }
    const o = out[dupIdx];
    if (Math.abs(f.lo - o.lo) < GAP_EPS && Math.abs(f.hi - o.hi) < GAP_EPS) continue; // 完全一致は単純にスキップ
    // 包絡: 既存側(chain順最先)の範囲を広げる（lo/hi・run。spansは既存側のまま——延長経路が
    // 同じ開放スパン判定を通っているため通常は同一の内容になる）。
    const lo = Math.min(o.lo, f.lo), hi = Math.max(o.hi, f.hi);
    o.lo = lo; o.hi = hi; o.run = hi - lo;
    o.originWorld = o.dirSign > 0 ? lo : hi;
  }
  return out;
}

