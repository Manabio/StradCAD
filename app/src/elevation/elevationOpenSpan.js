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
import { roomOwnerByCell, runBoundaryCLIds, collectRunBreaks, findRunCLAt } from './elevationFloorProfile.js';
import { perpFaceAt } from './elevationFaces.js';
import { MIN_FACE_RUN_MM } from './elevationStyle.js';

const PROBE_EPS_MM = 5; // far側セルへ覗き込むプローブ距離
const GAP_EPS = 1e-6;

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
  const segs = [];
  for (const key of refreshCells(room.cells, graph)) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    const nearOnWall = face.isVertical
      ? (face.inward > 0 ? b.x1 === axisValue : b.x2 === axisValue)
      : (face.inward > 0 ? b.y1 === axisValue : b.y2 === axisValue);
    if (!nearOnWall) continue;
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

      let kind = 'wall', farFloorDeltaMm;
      if (farCell && ownerByCell.has(farCell.key) && isOpenSpanEligible({ key }, farCell, graph)) {
        const farOwner = ownerByCell.get(farCell.key);
        kind = 'open';
        farFloorDeltaMm = graph.effectiveFloorLevel(farOwner) - graph.effectiveFloorLevel(room);
      }
      const loCLId = runLo === cellRunLo ? cellLoCLId : (findRunCLAt(graph, face.isVertical, runLo)?.id ?? null);
      const hiCLId = runHi === cellRunHi ? cellHiCLId : (findRunCLAt(graph, face.isVertical, runHi)?.id ?? null);
      segs.push({ runLo, runHi, kind, farFloorDeltaMm, loCLId, hiCLId });
    }
  }
  segs.sort((a, b) => a.runLo - b.runLo);
  return segs;
}

// 隣接する同種区間（kind・farFloorDeltaMmが同じ、かつrunHi===次のrunLo）を結合する。
function mergeSameKind(segs) {
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.kind === s.kind && last.farFloorDeltaMm === s.farFloorDeltaMm &&
        Math.abs(last.runHi - s.runLo) < GAP_EPS) {
      last.runHi = s.runHi;
      last.hiCLId = s.hiCLId;
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
  let loBound = ownIdx, hiBound = ownIdx;
  while (loBound > 0 && Math.abs(merged[loBound - 1].runHi - merged[loBound].runLo) < GAP_EPS) loBound--;
  while (hiBound < merged.length - 1 && Math.abs(merged[hiBound].runHi - merged[hiBound + 1].runLo) < GAP_EPS) hiBound++;
  const spans = merged.slice(loBound, hiBound + 1).map(s => ({ ...s }));
  const extendedAtLo = loBound < ownIdx;
  const extendedAtHi = hiBound > ownIdx;

  const runLo = spans[0].runLo, runHi = spans[spans.length - 1].runHi;
  const extendedAtLocal0   = face.dirSign > 0 ? extendedAtLo : extendedAtHi;
  const extendedAtLocalRun = face.dirSign > 0 ? extendedAtHi : extendedAtLo;

  // 延長した端の隅を、通常面と同じ規則（直交壁面のfaceValueへスナップ）で確定する。
  // 延長していない端は元のface.lo/hi・startCLId/endCLIdのまま（壁の実隅で既に正しい）——
  // このときhasWallも面自身の元の値（hasWallAtLocal0/Run）をそのまま引き継ぐ。stairOpenings等
  // 開放スパンとは無関係な理由で元々false（壁のない端部）だった面を、延長が起きていないのに
  // trueへ書き換えてしまわないため（QA修正: 実際にこの不具合を確認・修正）。
  // 重要: face.lo/hi・startCLId/endCLIdは常に「世界座標のlo/hi」（dirSignに関わらずlo<=hi）を
  // 表す不変条件（snapFaceEndsToCornersのdocコメント参照）——loEndは常にface.startCLId/face.lo、
  // hiEndは常にface.endCLId/face.hiをフォールバックに使う（dirSignによる分岐は不要。これを
  // dirSignで分岐させていたのはQA修正: 実際にこの不具合でstartCLId/endCLIdが入れ替わり
  // ROW1境界が誤った位置に出ていたのを発見・修正した）。「延長されたか」の判定だけは
  // extendedAtLocal0/Run（ローカル空間のフィールド）とdirSignの対応を踏まえる必要がある。
  const origHasWallAtLo = face.dirSign > 0 ? (face.hasWallAtLocal0 ?? true) : (face.hasWallAtLocalRun ?? true);
  const origHasWallAtHi = face.dirSign > 0 ? (face.hasWallAtLocalRun ?? true) : (face.hasWallAtLocal0 ?? true);
  const wasLoExtended = face.dirSign > 0 ? extendedAtLocal0 : extendedAtLocalRun;
  const wasHiExtended = face.dirSign > 0 ? extendedAtLocalRun : extendedAtLocal0;
  const loEnd = resolveEnd(face, wallFaces, runLo, face.startCLId, face.lo, wasLoExtended, origHasWallAtLo);
  const hiEnd = resolveEnd(face, wallFaces, runHi, face.endCLId, face.hi, wasHiExtended, origHasWallAtHi);

  const newFace = {
    ...face,
    lo: loEnd.value, hi: hiEnd.value, run: hiEnd.value - loEnd.value,
    originWorld: face.dirSign > 0 ? loEnd.value : hiEnd.value,
    startCLId: face.dirSign > 0 ? loEnd.clId : hiEnd.clId,
    endCLId:   face.dirSign > 0 ? hiEnd.clId : loEnd.clId,
    hasWallAtLocal0:   face.dirSign > 0 ? loEnd.hasWall : hiEnd.hasWall,
    hasWallAtLocalRun: face.dirSign > 0 ? hiEnd.hasWall : loEnd.hasWall,
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
      hiCLId: swapped ? s.loCLId : s.hiCLId,
    };
  }).sort((x, y) => x.loX - y.loX);
  localSpans[localSpans.length - 1].hiCLId = null; // 面全体の末尾は境界ではなく面端そのもの
  newFace.spans = localSpans.map(s => ({ ...s, hiCLX: s.hiCLId != null ? s.hiX : null }));

  return newFace;
}

// face の端（lo側 or hi側）を確定する。延長した場合は直交壁面のfaceValueへスナップ
// （perpFaceAt。見つかれば真の隅＝hasWall:true、無ければCL値のまま・hasWall:false）。
// 延長していない場合は元の値・元のhasWallをそのまま使う（実壁の隅・stairOpenings等の
// 壁のない端部いずれも、開放スパンとは無関係に既に正しい状態のため触らない）。
function resolveEnd(face, wallFaces, runCoord, origCLId, origValue, wasExtended, origHasWall) {
  if (!wasExtended) {
    return { value: origValue, clId: origCLId, hasWall: origHasWall };
  }
  const perp = perpFaceAt(wallFaces, face.isVertical, face.axisCL.value, runCoord);
  if (perp) {
    return { value: perp.faceValue, clId: perp.axisCL.id, hasWall: true };
  }
  return { value: runCoord, clId: null, hasWall: false };
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
