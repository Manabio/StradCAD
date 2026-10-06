/**
 * per-floor CL の階またぎ対応付け（type:value 照合）。
 *
 * per-floor CL（中心線・補助線）は階ごとに別インスタンス（別id）のため、ある階で解決した
 * CL を別階へ持ち越すには「同種別・同座標」で対応先を探す必要がある。通り芯（structGraph
 * 側の CL）は全階共通idのため、この照合は不要——呼び出し側が先に structGraph.shapeMap.has(id)
 * で判定する（本ファイルの translateCLId 参照）。
 *
 * stairFloorSync.js（階段の上階自動同期）・finish/eccentricityFloorSync.js（CL偏芯の階またぎ
 * 連動）・finish/equipment/equipmentFloorPlan.js（昇降機の上階事前チェック）が共用する。
 *
 * translateExtent・translateCellKey・translateCellSet・collectNeededCLs・addMissingCLs は
 * 本体を変えずに finish/stair/stairFloorSync.js から移した（昇降機の仕様追加 ステップ4 S1・
 * 2026-09-29）。stairFloorSync.js は本ファイルから import する。
 *
 * findCounterpartCL・addMissingCLs の任意引数（predicate/isCounterpart）はステップ4 S2で追加した。
 * 省略時は完全に従来どおりの経路（種別を問わず最初の1件）を通る——階段（stairFloorSync.js）は
 * 省略のまま呼ぶため挙動は変わらない。昇降機の経路（equipmentFloorPlan.js）だけが
 * isFinishCellDivider（core/centerLineKindPolicy.js）を渡し、区画を割る種別（通り芯・中心線）
 * だけを対応先として認める——上階の同じ座標に梁芯・補助線しか無い場合は「対応先なし」として
 * 新しい中心線を足す（S0計測で実データに実在を確認済み）。
 */
import { sameCoordCounterparts, isFinishCellDivider } from '../core/centerLineKindPolicy.js';
import { isGridCenterLine } from '../core/centerLine.js';
import { serializeGraph, restoreGraph, decodeFloorSnapshot } from '../graphSnapshot.js';
import { healDerivedGeometry } from './wallGeneration.js';
import { remapLineIdsInSnapshot, findLineIdOccurrences, hasAbsorptionConflict } from '../lineIdRemap.js';

const EPS = 1e-6;

// graph 内で type:value が一致する CL を探す。走査は sameCoordCounterparts（core/centerLineKindPolicy.js）
// 経由——種別条件の無い素の graph.centerLines 走査を個別に書かない（ステップ7、2026-09-20移行。
// tolMm に本ファイル既定の EPS を明示的に渡すため既存の許容誤差は変わらない）。
// 既知の限界: type と value のみで照合し、線種（lineType）・discipline は見ない
// （sameCoordCounterparts自体も種別を見ない走査APIのため、この限界は移行後も変わらない）。同一座標に
// 別種のCL（例: 通り芯と補助線）が併存する構成では誤って別種CLへ解決しうる。stairFloorSync.js
// での既存の実績を踏まえ、挙動は変更しない（影響範囲を読み切れないため）。
// 引数不正（type未指定・valueが数値でない）は null を返す（throwしない）——sameCoordCounterparts自体は
// 引数不正をthrowするが、findCounterpartCLの契約（移行前は `graph.centerLines.find(...)` がどんな
// type/valueでも単に該当なしとして null を返していた）を保つため、ここで先にガードする
// （QA指摘: translateCLId が非CL形状のid（centerLineType/valueを持たない）を渡すケースがあり、
// 移行前は暗黙にnullへ収束していた）。
// predicate（省略可）: 見つかった候補をさらに絞る述語（例: isFinishCellDivider）。省略時
// （null）は絞り込みをせず従来どおり最初の1件を返す——呼び出し側が明示的に渡さない限り
// 挙動は変わらない（team-lessons「明示vs省略のA/B等価テストが既定生成で恒真化する」に沿い、
// 省略＝完全に旧経路、明示＝新経路という2値のみを持つ。既定で別の絞り込みを自動生成しない）。
export function findCounterpartCL(graph, type, value, predicate = null) {
  if (type == null || typeof value !== 'number' || Number.isNaN(value)) return null;
  const matches = sameCoordCounterparts(graph, { centerLineType: type, value, tolMm: EPS });
  return (predicate ? matches.filter(predicate) : matches)[0] ?? null;
}

/**
 * per-floor CL id を別階（またはstructGraph共通）の対応CL idへ変換する。
 * 通り芯（structGraph 側）は全階共通のため同一IDのまま。設置階 per-floor CLは
 * type:value 照合で対象階側の対応CLを探す。解決できなければ null（呼び出し側は安全側でスキップ）。
 * @param {string} id - 変換元グラフ（sourceGraph）に属する CL の id
 * @param {object} sourceGraph - id が属するグラフ
 * @param {object} structGraph - 通り芯共通グラフ（project.structGraph）
 * @param {object} targetGraph - 対応先を探すグラフ
 */
export function translateCLId(id, sourceGraph, structGraph, targetGraph) {
  if (structGraph?.shapeMap.has(id)) return id;
  const cl = sourceGraph.shapeMap.get(id);
  // cl が CL でない（centerLineType を持たない／value が数値でない。壁・柱等の別 Shape が同じ
  // shapeMap から誤って渡されたケース）場合も null——「解決できなければ null」の契約を守る
  // （findCounterpartCL 側の引数ガードとの二重防御。QA指摘）。
  if (!cl || cl.centerLineType == null || typeof cl.value !== 'number' || Number.isNaN(cl.value)) return null;
  const counterpart = findCounterpartCL(targetGraph, cl.centerLineType, cl.value);
  return counterpart ? counterpart.id : null;
}

/**
 * 設置階 CL の side('lo'|'hi') 側 extent を上階グラフ向けに変換する。
 * - 通り芯参照（全階共通の structGraph CL）→ 参照をそのまま維持
 * - 設置階 per-floor CL への参照 → 上階の同 type:value CL へ付け替え
 * - 壁参照・付け替え先なし → 解決済み座標を静的値として持たせる（壁は階固有）
 * @returns {{ref: object|null, staticVal: number|null}}
 */
// isCounterpart はここでは使わない——extentLoRef/HiRefが参照する相手（aux等、分割線とは限らない）を
// 追従参照として持たせるかどうかの判定であり、addMissingCLsの「対応するCLが既に上階にあるか」
// （分割線としての対応。isCounterpart対象）とは別の関心事（S2裁定）。
function translateExtent(src, side, activeGraph, structGraph, upperGraph) {
  const ref       = side === 'lo' ? src.extentLoRef : src.extentHiRef;
  const staticVal = side === 'lo' ? src._extentLo   : src._extentHi;
  const resolved  = side === 'lo' ? src.extentLo    : src.extentHi;
  if (ref?.clId) {
    if (structGraph?.shapeMap.has(ref.clId)) return { ref, staticVal: null };
    const srcRef = activeGraph.shapeMap.get(ref.clId);
    const counterpart = srcRef
      ? findCounterpartCL(upperGraph, srcRef.centerLineType, srcRef.value)
      : null;
    if (counterpart) {
      return { ref: { clId: counterpart.id, offset: ref.offset ?? 0 }, staticVal: null };
    }
    return { ref: null, staticVal: resolved };
  }
  if (ref?.wallId) return { ref: null, staticVal: resolved };
  return { ref: null, staticVal };
}

// セルキー（"leftId:topId:rightId:bottomId"）を上階のCL id集合へ変換する。1つでも解決不能なら null。
function translateCellKey(key, activeGraph, structGraph, upperGraph) {
  const ids = key.split(':').map(id => translateCLId(id, activeGraph, structGraph, upperGraph));
  return ids.every(Boolean) ? ids.join(':') : null;
}

/**
 * cells（Set<string>）を上階の CL id 空間へ type:value 照合で変換する（階段・部屋どちらの
 * セル集合にも使う汎用ヘルパ）。1つでも解決不能なセルがあれば null を返す（安全側。
 * 呼び出し側は該当エンティティの自動追加をスキップする）。
 */
export function translateCellSet(cells, activeGraph, structGraph, upperGraph) {
  const result = new Set();
  for (const key of cells) {
    const translated = translateCellKey(key, activeGraph, structGraph, upperGraph);
    if (!translated) return null;
    result.add(translated);
  }
  return result;
}

/**
 * cellKeys（Set<string>）が参照する per-floor 中心線を type:value で集める（通り芯は
 * sourceGraph.shapeMap に無いため自然にスキップされる）。
 * @returns {Map<string, import('@core').CenterLine>} `${type}:${value}` → CenterLine
 */
export function collectNeededCLs(cellKeys, sourceGraph) {
  const needed = new Map();
  for (const key of cellKeys) {
    for (const clId of key.split(':')) {
      const cl = sourceGraph.shapeMap.get(clId);
      if (!cl) continue;
      needed.set(`${cl.centerLineType}:${cl.value}`, cl);
    }
  }
  return needed;
}

/**
 * cellKeys（設置階のセル）を囲む4辺のうち、設置階の per-floor 中心線が作る辺について、上階の同座標の
 * 仕上げセル分割線（isFinishCellDivider。梁芯・補助線は数えない）の有効区間（extent）が辺の全長を覆って
 * いなければ、最も近い1本の区間を辺まで延ばす（union。延びるのは足元の辺を覆うまでだけ。既に覆って
 * いれば何もしない）。addMissingCLs は同座標の中心線が上階にあれば区間を見ずに「対応先あり」とみなす
 * ため、区間が足元に届かない上階では足元の辺で格子が割れず、原子セルが足元より大きくなる。
 * 通り芯（structGraph 側）の辺は常に有効なので対象外。同座標に分割線が1本も無い辺は何もしない
 * （足す側は addMissingCLs）。延ばすのは区間の静的値（参照は外れる）で、直列化に載るため階の
 * before/after のバイト列合成でそのまま undo できる。
 * @returns {number} 区間を延ばした中心線の数（0 なら変更なし）
 */
export function extendDividerExtents(cellKeys, sourceGraph, structGraph, upperGraph) {
  let extended = 0;
  const valueOf = (id) => (sourceGraph.shapeMap.get(id) ?? structGraph?.shapeMap.get(id))?.value;
  const cells = [];
  for (const key of cellKeys) {
    const [leftId, topId, rightId, bottomId] = key.split(':');
    const [x1, y1, x2, y2] = [leftId, topId, rightId, bottomId].map(valueOf);
    if ([x1, y1, x2, y2].some(v => typeof v !== 'number')) continue;
    cells.push({ ids: [leftId, topId, rightId, bottomId], x1, y1, x2, y2 });
  }
  const inSet = (x, y) => cells.some(c => x > c.x1 && x < c.x2 && y > c.y1 && y < c.y2);
  const OUT = 1; // 辺の外側を見る距離(mm)。足元どうしの内部の辺（隣も足元）には分割線を要しない
  for (const c of cells) {
    const mx = (c.x1 + c.x2) / 2, my = (c.y1 + c.y2) / 2;
    const edges = [
      { id: c.ids[0], lo: c.y1, hi: c.y2, inner: inSet(c.x1 - OUT, my) },
      { id: c.ids[2], lo: c.y1, hi: c.y2, inner: inSet(c.x2 + OUT, my) },
      { id: c.ids[1], lo: c.x1, hi: c.x2, inner: inSet(mx, c.y1 - OUT) },
      { id: c.ids[3], lo: c.x1, hi: c.x2, inner: inSet(mx, c.y2 + OUT) },
    ];
    for (const e of edges) {
      const src = sourceGraph.shapeMap.get(e.id);
      if (e.inner || !src || src.centerLineType == null) continue; // 通り芯は常に有効
      if (extendOneEdge(upperGraph, src, Math.min(e.lo, e.hi), Math.max(e.lo, e.hi))) extended++;
    }
  }
  return extended;
}

/**
 * translateCellSet が返したセルキーのうち、per-floor 中心線の id を、同座標の分割線のうち辺の区間を覆う
 * ものへ付け替える（既に覆っていればそのまま）。translateCLId は同 type:value の最初の1本を返すので、
 * 同座標に区間の違うピースが複数ある上階では、辺を覆わないピースの id がキーに入り、壁生成が軸CLの区間
 * （clipToAxisExtent）で辺の壁を落とす。覆うものが無ければ元の id のまま。通り芯（structGraph）は不変。
 * @returns {Set<string>} 付け替え後のキー集合
 */
export function retargetKeysToCoveringCLs(keys, graph, structGraph) {
  const out = new Set();
  const valueOf = (id) => (graph.shapeMap.get(id) ?? structGraph?.shapeMap.get(id))?.value;
  const covers = (d, lo, hi) => isGridCenterLine(d) || d.extentLo == null || d.extentHi == null
    || (d.extentLo <= lo + EPS && d.extentHi >= hi - EPS);
  for (const key of keys) {
    const ids = key.split(':');
    const [x1, y1, x2, y2] = ids.map(valueOf);
    if ([x1, y1, x2, y2].some(v => typeof v !== 'number')) { out.add(key); continue; }
    const spans = [[y1, y2], [x1, x2], [y1, y2], [x1, x2]]; // left, top, right, bottom の辺の区間
    const next = ids.map((id, i) => {
      const cl = graph.shapeMap.get(id);
      if (!cl || cl.centerLineType == null) return id; // 通り芯
      const lo = Math.min(...spans[i]), hi = Math.max(...spans[i]);
      if (isFinishCellDivider(cl) && covers(cl, lo, hi)) return id;
      const alt = sameCoordCounterparts(graph, { centerLineType: cl.centerLineType, value: cl.value, tolMm: EPS })
        .find(d => isFinishCellDivider(d) && covers(d, lo, hi));
      return alt ? alt.id : id;
    });
    out.add(next.join(':'));
  }
  return out;
}

// 同座標の分割線が上階に1本も無い（梁芯・補助線だけで addMissingCLs が「対応先あり」とみなした）ときは、
// 辺の区間だけの中心線を足す。ある場合は最も近い1本を延ばす。足す／延ばすなら true。
function extendOneEdge(upperGraph, src, lo, hi) {
  const { centerLineType: type, value } = src;
  const sameCoord = sameCoordCounterparts(upperGraph, { centerLineType: type, value, tolMm: EPS });
  if (sameCoord.length === 0) return false; // 同座標に何も無い（足すのは addMissingCLs の担当）
  const dividers = sameCoord.filter(isFinishCellDivider);
  if (dividers.length === 0) {
    upperGraph.addCenterLine(type, value, {
      labeled: false, trim: false, discipline: src.discipline, lineWeight: src.lineWeight,
      lineType: src.lineType, color: src.color, extentLo: lo, extentHi: hi,
    });
    return true;
  }
  // 区間の未被覆の隙間を、隣のピースを辺まで延ばして埋める（延びるのは辺を覆うところまで。隣のピースに
  // ちょうど接したら1本に結合する——重なりは作らない。mergeAdjacentDividers）。結合で階のグラフが復元し
  // 直されるので、1回ごとに同座標の分割線を引き直す。
  let changed = false;
  for (let guard = 0; guard < 16; guard++) {
    const pieces = sameCoordCounterparts(upperGraph, { centerLineType: type, value, tolMm: EPS }).filter(isFinishCellDivider);
    if (pieces.some(d => isGridCenterLine(d) || d.extentLo == null || d.extentHi == null)) return changed; // 全長有効
    const gap = firstUncoveredGap(pieces, lo, hi);
    if (!gap) return changed;
    const [g1, g2] = gap;
    const left = pieces.filter(d => d.extentHi <= g1 + EPS).reduce((b, d) => (!b || d.extentHi > b.extentHi ? d : b), null);
    const right = pieces.filter(d => d.extentLo >= g2 - EPS).reduce((b, d) => (!b || d.extentLo < b.extentLo ? d : b), null);
    const dl = left ? g1 - left.extentHi : Infinity;
    const dr = right ? right.extentLo - g2 : Infinity;
    if (dl === Infinity && dr === Infinity) return changed;
    if (dl <= dr) {
      upperGraph.setCenterLineExtentRef(left, 'hi', null, g2);
      if (right && Math.abs(right.extentLo - g2) < EPS) mergeAdjacentDividers(upperGraph, left.id, right.id);
    } else {
      upperGraph.setCenterLineExtentRef(right, 'lo', null, g1);
      if (left && Math.abs(left.extentHi - g1) < EPS) mergeAdjacentDividers(upperGraph, left.id, right.id);
    }
    changed = true;
  }
  return changed;
}

// 区間 [lo,hi] のうち、ピース群（区間は有限）が覆っていない最初の隙間 [g1,g2]。無ければ null。
function firstUncoveredGap(pieces, lo, hi) {
  const spans = pieces.map(d => [d.extentLo, d.extentHi]).sort((a, b) => a[0] - b[0]);
  let cursor = lo;
  for (const [a, b] of spans) {
    if (a > cursor + EPS) return [cursor, Math.min(a, hi)];
    cursor = Math.max(cursor, b);
    if (cursor >= hi - EPS) return null;
  }
  return cursor < hi - EPS ? [cursor, hi] : null;
}

/**
 * 同座標・同種別で端がちょうど接する2本の分割線 lowerId（hi 側が接する）と upperId（lo 側が接する）を、
 * 1本（lowerId）に結合する。吸収する upperId を指す参照（部屋のセルキー・階段・壁の軸と始終端・建具・
 * 他の線の extent 参照・偏芯レコード等）は、階の保存形式の中間オブジェクトへの一括置換
 * （lineIdRemap.js remapLineIdsInSnapshot。線種変更の移籍一本化と同じ仕組み）で lowerId へ付け替え、
 * 階のグラフを復元し直す（エンティティは作り直されるが id は保たれる）。生き残る線の far 側の区間は
 * 吸収される線の値になる（参照だった場合は参照のまま。片側の参照は静的値化されうる）。
 * 柱芯オフセット・CL偏芯・腰壁垂れ壁が両方の線に付いていて衝突する（hasAbsorptionConflict）ときは
 * 何も変えず false（接した2本のまま残る＝重なりは無いので壁生成の軸CLの区間だけが足りなくなりうる）。
 * @returns {boolean} 結合したか
 */
export function mergeAdjacentDividers(graph, lowerId, upperId) {
  const snapshot = decodeFloorSnapshot(serializeGraph(graph));
  const lower = snapshot.centerLines.find(c => c.id === lowerId);
  const upper = snapshot.centerLines.find(c => c.id === upperId);
  if (!lower || !upper) return false;
  lower.extentHi = upper.extentHi ?? null;
  lower.extentHiRef = upper.extentHiRef ?? null;
  snapshot.centerLines = snapshot.centerLines.filter(c => c !== upper);
  const remapped = remapLineIdsInSnapshot(snapshot, new Map([[upperId, lowerId]]));
  if (hasAbsorptionConflict(remapped, lowerId)) return false;
  if (findLineIdOccurrences(remapped, [upperId]).length > 0) return false; // 事後条件: 旧 id が残らない
  restoreGraph(graph, remapped);
  healDerivedGeometry(graph);
  // 読み込み経路（FloorSwapManager activate/peek の _healDerivedGeometry）と同じく、復元した壁の出隅を閉じ直す
  // （復元直後の状態を読み込み直後と同じにする。冪等）
  return true;
}

/**
 * needed（collectNeededCLs の結果）のうち upperGraph に無いものを追加し、短縮区間（extent）も
 * translateExtent で写す。stairFloorSync 内の全ての「上階への不足CL同期」処理はこれを使う
 * （二重実装しない）。
 * @param {{isCounterpart?: (cl: object) => boolean}} [opts] - 省略時（既定 null）は種別を問わず
 *   findCounterpartCL の既定どおり最初の1件を「対応先あり」とみなす（階段の既存挙動は不変）。
 *   昇降機の経路は isFinishCellDivider を渡し、区画を割る種別（通り芯・中心線）だけを対応先と
 *   認める——上階の同座標に梁芯・補助線しか無ければ「対応先なし」として新しい中心線を足す。
 * @returns {number} 追加した CL 数（0 なら変更なし）
 */
export function addMissingCLs(needed, sourceGraph, structGraph, upperGraph, { isCounterpart = null } = {}) {
  const added = []; // [元CL, upperGraphに追加したCL]
  for (const cl of needed.values()) {
    if (findCounterpartCL(upperGraph, cl.centerLineType, cl.value, isCounterpart)) continue;
    const nc = upperGraph.addCenterLine(cl.centerLineType, cl.value, {
      labeled: false, trim: false, discipline: cl.discipline,
      lineWeight: cl.lineWeight, lineType: cl.lineType, color: cl.color,
    });
    added.push([cl, nc]);
  }
  for (const [src, nc] of added) {
    for (const side of ['lo', 'hi']) {
      const { ref, staticVal } = translateExtent(src, side, sourceGraph, structGraph, upperGraph);
      if (ref || staticVal != null) upperGraph.setCenterLineExtentRef(nc, side, ref, staticVal);
    }
  }
  return added.length;
}
