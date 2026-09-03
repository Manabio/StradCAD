/**
 * 展開図: 部屋 → 最終的な面リスト（唯一の供給源）。設計意図は .claude/elevation-model.md 参照。
 *
 * buildRoomFaces（壁面ループの1周・隅共有の不変条件）はそのまま基礎として使い、その上に
 * 「袖壁・腰壁の分割 → 段差見付け面の挿入 → labelFaces再採番」の3段を重ねる（この順序固定。
 * 段差見付け面の挿入位置判定は分割済みの面配列を前提にする）。elevationBand.js/elevationStair.js
 * は buildRoomFaces ではなくこの composeRoomFaces を唯一の面リスト供給源として使う。
 */
import { buildRoomFaces, labelFaces, perpendicularWallsOnFace, CORNER_TOL_MM } from './elevationFaces.js';
import { SIGHTLINE_DEPTH_LIMIT_MM } from './elevationStyle.js';
import { graphList } from '../graphReadScope.js';
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
  const found = kneeDropRecordForWallSpan(graph, wall.axisCL, wLo, wHi);
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
  const dropped = dropFacesSeenAsSightline(faces, graph);
  // 規則B（パネル統合）は見えがかりの除去の**後**・採番の**前**（下記mergeSteppedFacesIntoPanel
  // のdocコメント参照）。階段帯（keepWallLessFaces）では適用しない——switchbackCutsが面を
  // 並べ替えるため、帯の並び順に依存するこの規則は成立しない。
  return labelFaces(opts.keepWallLessFaces ? dropped : mergeSteppedFacesIntoPanel(dropped));
}

// 面gが面fを「見えがかりとして取り込む」か（下記dropFacesSeenAsSightlineの述語）。
function absorbsAsSightline(g, f, walls) {
  if (g === f || g.kind === 'step' || f.kind === 'step') return false;
  if (!!g.isVertical !== !!f.isVertical) return false;              // 平行な面どうしだけ
  if (Math.sign(g.inward) !== Math.sign(f.inward)) return false;    // 同じ向きを見ている面だけ
  const ga = g.axisCL?.effectiveValue, fa = f.axisCL?.effectiveValue;
  if (!Number.isFinite(ga) || !Number.isFinite(fa)) return false;
  // fがgの視線方向にあり、見えがかりとして描かれる奥行きに収まっているか
  // （上限はsectionEngine.jsの見えがかり判定と同じSIGHTLINE_DEPTH_LIMIT_MM）。
  const depth = (fa - ga) * -Math.sign(g.inward);
  if (!(depth > MIN_FACE_RUN_MM && depth < SIGHTLINE_DEPTH_LIMIT_MM)) return false;
  // gの走り範囲がfを覆っていること＝fの全長がgの図の中に見えていること。
  if (!(g.lo <= f.lo + MIN_FACE_RUN_MM && g.hi >= f.hi - MIN_FACE_RUN_MM)) return false;
  // **gの平面にfの走り範囲と重なる壁があれば、fはgの図に現れない**（自壁に隠れる）。
  // 一部でも隠れれば「丸ごと取り込まれた」とは言えないので、重なりがあれば取り込みとしない。
  return !(walls ?? []).some(w => !!w.isVertical === !!g.isVertical
    && Math.abs((w.axisCL?.effectiveValue ?? NaN) - ga) <= MIN_FACE_RUN_MM
    && Math.min(w.coord1, w.coord2) < f.hi - MIN_FACE_RUN_MM
    && Math.max(w.coord1, w.coord2) > f.lo + MIN_FACE_RUN_MM);
}

/**
 * **他の面の見えがかりとして描かれる面は、独立したパネルにしない**（ユーザー明示指示2026-08
 * 「見えがかりに取り込まれた面は常に落とす」「「5」D1に描画済なのでD2パネルを削除」）。
 *
 * 同じ向きを見ている平行な面のうち、手前の面の走り範囲に全長が収まり、かつ見えがかりとして
 * 描かれる奥行き（`SIGHTLINE_DEPTH_LIMIT_MM`未満）にある奥の面が対象——その面は手前の面の図に
 * 丸ごと現れているので、同じ壁面を2枚のパネルに描くことになる。
 * 奥行きは符号付きなので相互に取り込み合うことはない（片方向だけが正になる）。
 * @param {object[]} faces
 * @param {object} graph
 * @returns {object[]}
 */
export function dropFacesSeenAsSightline(faces, graph) {
  const walls = graphList(graph, 'walls') ?? [];
  return faces.filter(f => !faces.some(g => absorbsAsSightline(g, f, walls)));
}

// 世界座標worldに近い方の端（'lo'|'hi'）と、それに対応するローカル端のキー（'0'|'Run'）。
// ローカル0側の世界座標はoriginWorld=（dirSign>0 ? lo : hi）という不変条件の裏返し。
function localEndKeyAt(face, world) {
  const side = Math.abs(face.lo - world) <= Math.abs(face.hi - world) ? 'lo' : 'hi';
  return (side === 'lo') === (face.dirSign > 0) ? '0' : 'Run';
}

// 接合端の天井の起点が「上階の吹抜けに抜けているか」（voidAbove。elevationVoid.jsが書き込む）。
// 抜けているかどうかで天井の絶対高さ（自階天井 or 上階天井）が変わるため、接合端で食い違えば
// 1枚のパネルとして天井線を通せない。
//
// **床の起点（FL差）は評価しない**（決定2026-09。QA指摘への回答）——面オブジェクトはFLを
// 持たない（`floorDeltaMm`は`wallAdjacentFloorSegments`がgraphから作る**床区間**のフィールドで、
// 面が持つのは段差見付け面だけの`baseFloorDeltaMm`）。graphを引数に足して実際の床区間から引く案は、
// モデルに該当ケースが無く検証できないうえ、この純関数の引数面を広げるため採らない。
// 帰結: 部分指定でFLが変わる段差でも統合される。各メンバーは自分の`floorSegments`で床を描くので、
// 段差は継ぎ目に段として現れる（描き落ちにはならない）。
function panelJointVoidAtEnd(face, key) {
  const ranges = face.voidAbove?.voidLocal ?? [];
  return key === '0'
    ? ranges.some(r => r.lo <= MIN_FACE_RUN_MM && r.hi > MIN_FACE_RUN_MM)
    : ranges.some(r => r.hi >= face.run - MIN_FACE_RUN_MM && r.lo < face.run - MIN_FACE_RUN_MM);
}

/**
 * 面リスト上で連続する2枚 f→g が「壁面の段差でしか分かれていない同じ壁」か（規則Bの述語）。
 * 満たすなら接合部の情報（両面のローカル端キー）を返す。
 * @returns {{fKey:'0'|'Run', gKey:'0'|'Run'}|null}
 */
function steppedPanelJoint(f, g) {
  if (!f || !g || f.kind === 'step' || g.kind === 'step') return null;          // 条件1
  if (!!f.isVertical !== !!g.isVertical) return null;                          // 条件1
  if (Math.sign(f.inward) !== Math.sign(g.inward)) return null;                 // 条件1
  const fa = f.axisCL?.effectiveValue, ga = g.axisCL?.effectiveValue;
  if (!Number.isFinite(fa) || !Number.isFinite(ga)) return null;
  if (Math.abs(fa - ga) <= MIN_FACE_RUN_MM) return null;                        // 条件2（奥行き≠0）
  // 条件3: 世界範囲が重ならず、隙間 <= CORNER_TOL_MM で接する（どちらが lo 側でもよい）。
  const gapLoHi = g.lo - f.hi, gapHiLo = f.lo - g.hi;
  const gap = Math.max(gapLoHi, gapHiLo);
  if (!(gap >= -MIN_FACE_RUN_MM && gap <= CORNER_TOL_MM)) return null;
  const jointWorld = gapLoHi >= gapHiLo ? (f.hi + g.lo) / 2 : (f.lo + g.hi) / 2;
  const fKey = localEndKeyAt(f, jointWorld), gKey = localEndKeyAt(g, jointWorld);
  // 接合の向き: 2枚目は必ず1枚目の**+ローカルx側**へ続いていること。帯の配置式（elevationBand.js
  // のlayoutBandFaces）とパネル全幅の算出は「2枚目が先頭メンバーの右へ続く」前提で組んでおり、
  // 逆向き（2枚目が左へ戻る）を受理すると配置とラベル幅が壊れる。
  if (!(fKey === 'Run' && gKey === '0')) return null;
  if (panelJointVoidAtEnd(f, fKey) !== panelJointVoidAtEnd(g, gKey)) return null;         // 条件5
  // 条件6: 接合部にどちらか一方の壁断面がある（返し壁が実在しない開放的な段差を弾く）。
  if (!((f[`hasWallAtLocal${fKey}`] ?? true) || (g[`hasWallAtLocal${gKey}`] ?? true))) return null;
  return { fKey, gKey };
}

/**
 * **壁面の段差でしか分かれていない同letterの面を1枚のパネルにまとめる**（規則B。ユーザー実機
 * 指摘2026-08「「5」C1とC2は1枚の壁」）。純関数（graph不要）。
 *
 * 室の境界が段差を1つ挟んで一続きになっている場合（実機1階5の南側: x -6200..-3400 が y=-1000、
 * x -3400..0 が y=0）、面は平面ごとに分かれるが**壁としては1枚**であり、2つのパネルに割ると
 * 同じ壁が2回・別々のラベルで現れる。ここでは面を1枚に合成せず（face は axisCL/faceValue/
 * inward を各1つ持つ前提が openingsOnFace・elevationVoid.samePlane 等の全域にあるため）、
 * 共通の `panelId` と**接合端のフラグ2つ**（`hasWallAtLocal*`=true / `edgeAtLocal*`=false）だけを
 * 書き込む。この1点で「はね出しの停止」「断面エンジンの探査延長の停止（section/sectionContent.js
 * のwithProbeExtension）」「接合部の縦線が相手の壁断面の縁と一致してdedupeCoincidentLinesで
 * 1本に畳まれる」の3つが同時に正しくなる——面の端に壁断面が現れるかを面単位ではなく
 * **パネル単位**で評価する、という意味づけ。
 *
 * 呼ぶ位置は `dropFacesSeenAsSightline` の後・`labelFaces` の前（この順序固定）。前者の後で
 * なければ、あいだに残った見えがかり面のせいで「面リスト上の隣接」が成立しない（実機「5」は
 * 旧D2(x=-3400)がD1へ取り込まれて初めてC1とC2が隣り合う）。後者の前でなければ、パネル単位の
 * 採番（labelFacesがpanelIdを見る）ができない。
 *
 * **面リスト上で隣接する2枚だけを見る**のが暴発の安全弁（条件4）。これが無いと、室の反対側
 * どうし（実機「5」のD1とD3のように平行・同向き・端どうしが接する組）が1枚になる。
 * 3枚以上は連鎖で拡張する。
 * @param {object[]} faces - dropFacesSeenAsSightlineの結果（帯の並び順）
 * @returns {object[]} 統合が1件も起きなければ引数の配列をそのまま返す
 */
export function mergeSteppedFacesIntoPanel(faces) {
  if (!Array.isArray(faces) || faces.length < 2) return faces;
  const joints = [];
  for (let i = 0; i + 1 < faces.length; i++) {
    const joint = steppedPanelJoint(faces[i], faces[i + 1]);
    if (joint) joints.push({ i, ...joint });
  }
  if (joints.length === 0) return faces; // 現行と完全同一（同一参照で返す）
  const out = faces.map(f => ({ ...f }));
  let seq = 0;
  for (const { i, fKey, gKey } of joints) {
    const f = out[i], g = out[i + 1];
    const panelId = f.panelId ?? `${f.letter}${++seq}`;
    f.panelId = panelId; g.panelId = panelId;
    f[`hasWallAtLocal${fKey}`] = true; f[`edgeAtLocal${fKey}`] = false;
    g[`hasWallAtLocal${gKey}`] = true; g[`edgeAtLocal${gKey}`] = false;
  }
  return out;
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
