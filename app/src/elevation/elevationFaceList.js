/**
 * 展開図: 部屋 → 最終的な面リスト（唯一の供給源）。設計意図は .claude/elevation-model.md 参照。
 *
 * buildRoomFaces（壁面ループの1周・隅共有の不変条件）はそのまま基礎として使い、その上に
 * 「袖壁・腰壁の分割 → 段差見付け面の挿入 → labelFaces再採番」の3段を重ねる（この順序固定。
 * 段差見付け面の挿入位置判定は分割済みの面配列を前提にする）。elevationBand.js/elevationStair.js
 * は buildRoomFaces ではなくこの composeRoomFaces を唯一の面リスト供給源として使う。
 */
import { buildRoomFaces, labelFaces, perpendicularWallsOnFace } from './elevationFaces.js';
import { insertStepFaces } from './elevationStepFace.js';
import { extendFacesWithOpenSpans, clipSpans } from './elevationOpenSpan.js';
import { SPLIT_MERGE_EPS_MM, MIN_FACE_RUN_MM } from './elevationStyle.js';
import { kneeDropRecordForWallSpan } from '../finish/kneeDropWall.js';

/**
 * wall（袖壁・腰壁）に対応する kneeDropWalls のレコードを返す（kneeDropRecordForWallSpan。
 * finish/kneeDropWall.jsがkey解読を集約。QA修正L1）。axisCLId一致＋スパン重なりで判定し、
 * 該当が複数あっても先頭を採用する（隅の取り合いぶんだけ隣区間へ食い込んだ壁は対象外
 * ——平面の腰壁描画と同じ判定にする）。腰壁指定（knee）が無ければnull（=partitionCutAtLocal0/Runは
 * topHeight無し＝天井までのCUT枠になる）。
 * @param {import('@core').Wall} wall
 * @param {object} graph
 * @returns {{knee?:{topHeight:number}, drop?:{bottomHeight:number}}|null}
 */
export function kneeDropRecordFor(wall, graph) {
  const wLo = Math.min(wall.coord1, wall.coord2), wHi = Math.max(wall.coord1, wall.coord2);
  const found = kneeDropRecordForWallSpan(graph, wall.axisCL.id, wLo, wHi);
  return found ? found.rec : null;
}

// 袖壁wallの「面の走行方向に沿った」ローカル範囲 [near, far]（near<far。face自身のローカルx系）。
// materialRangeが引ければその両端、引けなければaxisOffsetぶんの対称範囲へフォールバックする。
function sleeveLocalRange(wall, face) {
  const toLocal = v => (v - face.originWorld) * face.dirSign;
  const r = wall.materialRange;
  if (r) {
    const a = toLocal(r.lo), b = toLocal(r.hi);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const center = toLocal(wall.axisCL.effectiveValue);
  const half = Math.abs(wall.axisOffset) || 1;
  return [center - half, center + half];
}

/**
 * face を袖壁・腰壁のローカルx位置で分割する（仕様2）。
 * perpendicularWallsOnFace(face, graph, 'near')（実装済み）が返す袖壁のaxisCL.effectiveValueの
 * ローカルxで昇順に並べ（重複は併合）、各袖壁の位置で面を断片化する。各断片は元面のフィールドを
 * 継承しつつ、分割端だけ差し替える:
 *   - startCLId/endCLId: 分割端は袖壁CLのid（隣接断片が同じidを参照するためfaceBoundaryLocalX
 *     基準の境界が厳密に一致する＝重複ゼロ）
 *   - lo/hi: 分割端は袖壁の仕上げ面（materialRangeの該当端。断片から見て近い側）
 *   - hasWallAtLocal0/hasWallAtLocalRun: 分割端は常にfalse（既存の「壁のない端部」処理＝
 *     床・天井延長＋端の縦線なしで「続きがある」表現をそのまま流用する）
 *   - partitionCutAtLocal0/partitionCutAtLocalRun: {thicknessMm, topHeightMm|null}
 *     （kneeDropRecordFor。null=腰壁指定なし=天井まで）を分割端にだけ持たせる
 * kind==='step'（段差見付け面。仕様3が別に処理する専用面）は対象外のまま素通りする。
 * @param {object[]} faces - buildRoomFacesの結果（chain順・スナップ済み）
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object[]}
 */
export function splitFacesAtPartitionWalls(faces, room, graph) {
  void room; // kneeDropWallsはgraph直読みのため room 自体は使わない（シグネチャのみ設計どおり保持）
  const out = [];
  for (const face of faces) {
    if (face.kind === 'step') { out.push(face); continue; }

    // QA修正（幅0の展開図バグ）: 袖壁の中心が面の端(0/run)にごく近い(SPLIT_MERGE_EPS_MM未満)場合、
    // 分割しても意味の無い極小断片ができるため、単純な`>0`/`<run`ではなく許容差ぶん内側で切る。
    const sleeves = perpendicularWallsOnFace(face, graph, 'near')
      .map(w => ({ w, center: (w.axisCL.effectiveValue - face.originWorld) * face.dirSign }))
      .filter(s => s.center > SPLIT_MERGE_EPS_MM && s.center < face.run - SPLIT_MERGE_EPS_MM)
      .sort((a, b) => a.center - b.center);
    const merged = [];
    for (const s of sleeves) {
      const last = merged[merged.length - 1];
      if (last && s.center - last.center <= SPLIT_MERGE_EPS_MM) continue; // 同位置は先勝ちで併合
      merged.push(s);
    }
    if (merged.length === 0) { out.push(face); continue; }

    // 元面の局所0側・run側それぞれのCL id（snapFaceEndsToCornersと同じ表裏の対応規則）。
    const origStartCLId = face.dirSign > 0 ? face.startCLId : face.endCLId;
    const origEndCLId   = face.dirSign > 0 ? face.endCLId   : face.startCLId;

    // ローカル昇順の境界点列: [開始, 袖壁1near, 袖壁1far, 袖壁2near, ..., 終了]。
    // 隣接ペア(0,1)(2,3)...が断片1枚ぶんのローカル範囲になる。
    const points = [{ local: 0, clId: origStartCLId, cut: null }];
    for (const { w } of merged) {
      const [near, far] = sleeveLocalRange(w, face);
      const rec = kneeDropRecordFor(w, graph);
      const cut = { thicknessMm: Math.abs(far - near) || (Math.abs(w.axisOffset) * 2), topHeightMm: rec?.knee?.topHeight ?? null };
      points.push({ local: near, clId: w.axisCL.id, cut });
      points.push({ local: far,  clId: w.axisCL.id, cut });
    }
    points.push({ local: face.run, clId: origEndCLId, cut: null });

    for (let i = 0; i + 1 < points.length; i += 2) {
      const p0 = points[i], p1 = points[i + 1];
      const worldA = face.originWorld + p0.local * face.dirSign;
      const worldB = face.originWorld + p1.local * face.dirSign;
      const lo = Math.min(worldA, worldB), hi = Math.max(worldA, worldB);
      // dirSign>0: p0→world lo(startCLId)・p1→world hi(endCLId)。dirSign<0はその逆。
      const startCLId = face.dirSign > 0 ? p0.clId : p1.clId;
      const endCLId   = face.dirSign > 0 ? p1.clId : p0.clId;
      const isFirst = i === 0;
      const isLast  = i + 2 === points.length;
      // 親のspans（開放スパン）は親自身のローカル座標系（x=0起点）で持っているため、
      // 断片自身のローカル範囲[p0.local,p1.local]でクリップ・再原点化する（clipSpans。
      // これを忘れると断片のROW1・開放スパン描画が親の座標のままずれる——設計の最重要注意点）。
      const loLocal = Math.min(p0.local, p1.local), hiLocal = Math.max(p0.local, p1.local);
      const spans = face.spans ? clipSpans(face.spans, loLocal, hiLocal) : undefined;
      out.push({
        // 断片は自分自身のローカル座標系（x=0起点）を新たに持つ——buildFaceFigure等は
        // 「face.lo/hi(world)」「originWorld=dirSign>0?lo:hi」「run=hi-lo」の組から
        // ローカルxを導出するため、親faceのoriginWorldをそのまま引き継ぐと断片の中身が
        // 親の途中からのオフセットのままずれてしまう（buildRoomFacesの元の式と同じ規則で
        // 断片ごとに再計算する）。
        ...face, startCLId, endCLId, lo, hi, run: hi - lo, originWorld: face.dirSign > 0 ? lo : hi,
        hasWallAtLocal0:   isFirst ? (face.hasWallAtLocal0   ?? true) : false,
        hasWallAtLocalRun: isLast  ? (face.hasWallAtLocalRun ?? true) : false,
        // 見えがかりエッジ（edgeAtLocal0/Run）は元の面端にのみ引き継ぐ。分割端（袖壁側）は
        // 袖壁自身の断面rect（partitionCutAtLocal0/Run）が端の表現を担うため常にfalse。
        edgeAtLocal0:      isFirst ? (face.edgeAtLocal0   ?? false) : false,
        edgeAtLocalRun:    isLast  ? (face.edgeAtLocalRun ?? false) : false,
        partitionCutAtLocal0:   isFirst ? null : p0.cut,
        partitionCutAtLocalRun: isLast  ? null : p1.cut,
        ...(spans ? { spans } : {}),
      });
    }
  }
  return out;
}

/**
 * 部屋 → 面リスト（袖壁分割・段差見付け面挿入・再採番まで済んだ最終形）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {object[]}
 */
export function composeRoomFaces(room, graph, opts = {}) {
  let faces = buildRoomFaces(room, graph);
  faces = extendFacesWithOpenSpans(faces, room, graph);
  faces = splitFacesAtPartitionWalls(faces, room, graph);
  faces = insertStepFaces(faces, room, graph);
  // QA修正（幅0の展開図バグ）: 各生成経路（段差見付け面の隅スナップ・袖壁分割の境界計算等）を
  // 個別に堅牢化した上でも、未知の経路から幅0・極小幅の面が漏れ出た場合の最後の砦として、
  // run(実効幅)がMIN_FACE_RUN_MM未満の面をここで除去する。labelFacesより前に行う——除去後の
  // 残存面だけでletterごとの出現順（A1/A2等）を数え直す必要があるため。
  faces = faces.filter(f => f.run >= MIN_FACE_RUN_MM);
  // ユーザー実機指摘2026-08「「5」A2：ここに壁はない」: 部屋の輪郭の辺は、そこに壁が生成されて
  // いなくても面として作られる（階段の上り口・下り口のように壁生成を意図的にスキップした辺）。
  // `hasRealWall=false`はその判定結果そのもの（buildRoomFacesのinnerWallFaceAtがnull＝この軸区間に
  // 実壁が1本も無くCL芯へフォールバックした）なので、**展開図の面としては採用しない**——壁が無い
  // ところに壁面の展開を描くのは誤り。隅のスナップ（snapFaceEndsToCorners）・開放スパンの延長・
  // 袖壁分割はすべて全面が揃った状態で済ませてから落とすので、残る面の端の情報は変わらない。
  // keepWallLessFaces: 階段帯だけは例外。上り口の面（壁なし）をレーン範囲の算出（switchbackCuts.js
  // のwEntry）に使うため、面リストから落とすと切断表そのものが組めなくなる。
  if (!opts.keepWallLessFaces) faces = faces.filter(f => f.kind === 'step' || f.hasRealWall !== false);
  return labelFaces(faces);
}

/**
 * faces[i] から見て dir 方向（-1=前・+1=次）にある「壁面」（kind!=='step'）を返す。
 * 段差見付け面（kind==='step'）はスキップする——建具断面の隣接判定（openingsReachingCorner）
 * 等は実壁面同士の隅でのみ成立し、見付け面を挟んでも実質的な隣接関係は変わらないため。
 * 面が2枚未満、または全てstepの場合はnull。
 * @param {object[]} faces
 * @param {number} i
 * @param {1|-1} dir
 * @returns {object|null}
 */
export function neighborWallFace(faces, i, dir) {
  const n = faces.length;
  if (n < 2) return null;
  let j = i;
  for (let k = 0; k < n; k++) {
    j = (j + dir + n) % n;
    if (faces[j].kind !== 'step') return faces[j];
  }
  return null;
}
