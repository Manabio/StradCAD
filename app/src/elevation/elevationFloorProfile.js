/**
 * 展開図: 壁面1枚の「壁際セルの実効FL」プロファイル（項目4。純関数）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 部分指定Room（referenceRoomIdsで親Roomを参照。.claude/glossary.md「部分指定 / 参照元」）が
 * 親Roomの一部セルを占め、かつ親と floorLevel が異なる場合、その区間だけ床線を段差させる
 * ための入力データを組み立てる。セル→世界座標の変換は finish/gridCells.js の既存ユーティリティ
 * （cellBoundsFromKey・refreshCells）をそのまま再利用する（Room.cells は中心線グリッドの
 * セルキー集合であり、この対応関係を再実装しないため）。
 *
 * QA修正2026-09（二重実装の統合）: 面の「断面線（下側の輪郭）」＝`FloorProfile`（折れ線）
 * まわりの一式（floorProfileFromSegments / mergeFloorProfiles / drawnFloorProfileZAt /
 * drawnFloorProfileZMax / clipContentAboveDrawnProfile）は section/sectionEmit.js から
 * ここへ移した——床/天井のプロファイルを扱う関数（wallAdjacentFloorSegments・
 * familyCeilingSegments・drawnRiserX・drawnCeilingRiserX）と同じ層の話であり、
 * 断面エンジンの出力（線種テーブル）とは責務が違うため。import は
 * `sectionEmit.js` → 本ファイルの一方向で、本ファイルは section/ を一切引かない。
 */
import { CenterLineType } from '@core';
import { refreshCells, cellBoundsFromKey, worldToCell, gridIndexOf } from '../finish/gridCells.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../finish/wallGeneration.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { graphList, scopedValue } from '../graphReadScope.js';
import { GAP_EPS_MM as GAP_EPS, PROBE_EPS_MM } from './elevationStyle.js';
// PROBE_EPS_MM: 自室セルの境界がface側で粗い（extent制限されたCLが該当行では無効域にあり
// 分割されない）場合に、runの伸びる方向へ覗き込むプローブ距離（elevationOpenSpan.jsと共通。
// elevationStyle.jsのR4共通定数）。

// 実壁が引けない面（単体テスト等の合成face）向けの半壁厚フォールバック(mm)。
// 既定壁下地厚(DEFAULT_WALL_BASE)の半分+既定仕上げ厚(DEFAULT_WALL_FINISH) = 45+12.5 = 57.5。
const DEFAULT_HALF_WALL_MM = DEFAULT_WALL_BASE / 2 + DEFAULT_WALL_FINISH;

/**
 * [lo,hi] 区間を、run の伸びる方向と同じ向きのCL値で刻む（elevationStepFace.js の
 * collectAxisBreaks・elevationOpenSpan.js の collectRunBreaks と同じ考え方。QA修正:
 * wallAdjacentFloorSegments でも同じ「粗いセル境界」問題が起きるため、唯一の実装として
 * ここへ統合し elevationOpenSpan.js から re-export する）。
 * @param {object} graph
 * @param {boolean} isVertical - 面のisVertical（runがY方向ならtrue）
 * @param {number} lo
 * @param {number} hi
 * @returns {number[]}
 */
export function collectRunBreaks(graph, isVertical, lo, hi) {
  // 全CLの座標値（分割CLに限らない）はグリッド索引が持つ——スコープ内なら組み直さない。
  const g = gridIndexOf(graph);
  const values = new Set([lo, hi]);
  for (const v of (isVertical ? g.allYValues : g.allXValues)) {
    if (v > lo && v < hi) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/** run方向のCL（isVertical面ならHORIZONTAL）のうち、value に一致するものを返す。 */
export function findRunCLAt(graph, isVertical, value) {
  const type = isVertical ? CenterLineType.HORIZONTAL : CenterLineType.VERTICAL;
  return (graphList(graph, 'centerLines') ?? []).find(cl => cl.centerLineType === type && cl.value === value) ?? null;
}

/**
 * セル矩形bの「面のnear側（inwardの向く側）の辺」がaxisValueに一致するか判定する（R5:
 * wallAdjacentFloorSegments・elevationOpenSpan.jsのcollectNearCellSegmentsで共通利用する唯一の実装）。
 * @param {object} face - isVertical・inwardを持つ面（buildRoomFacesの1件）
 * @param {{x1:number,y1:number,x2:number,y2:number}} b - cellBoundsFromKey等の矩形
 * @param {number} axisValue - face.axisCL.value
 * @returns {boolean}
 */
export function cellNearSideOnFace(face, b, axisValue) {
  return face.isVertical
    ? (face.inward > 0 ? b.x1 === axisValue : b.x2 === axisValue)
    : (face.inward > 0 ? b.y1 === axisValue : b.y2 === axisValue);
}

/**
 * セル矩形bが面の切断面（axisValue）を**跨いでいる**か（＝面の両側に同じセルが広がる）。
 * `cellNearSideOnFace`（near側の辺がaxisValueに一致する）と対になる述語。面のあるCLがその位置
 * まで延長されていない場合、自室のセルはそこで分割されず1枚のまま面を跨ぐ——このセルは
 * 「軸に接していない」ため`cellNearSideOnFace`では拾えないが、near側は確かに自室が占めている。
 * 開放スパンの近側セル列挙（`collectNearCellSegments`）だけがこの述語を併用する
 * （床の段差プロファイルは「軸に接する辺」の高さを問う処理のため対象外——役割を混ぜない）。
 * 実機2階の室22では、Y=-3500のCLがx=0..1000には延びておらずこの帯のセルが上下に割れないため、
 * A1（Y=-3500の壁）がX3..X4の抜けを開放区間として描けなかった（問題修正2026-08その9）。
 * @param {object} face - isVerticalを持つ面
 * @param {{x1:number,y1:number,x2:number,y2:number}} b
 * @param {number} axisValue - face.axisCL.value
 * @returns {boolean}
 */
export function cellStraddlesFace(face, b, axisValue) {
  return face.isVertical
    ? (b.x1 < axisValue && axisValue < b.x2)
    : (b.y1 < axisValue && axisValue < b.y2);
}

/**
 * touching（自室セルが軸に直接触れる区間）に欠測がある[lo,hi]区間を、runの伸びる方向のCLで
 * 刻んで区間ごとに個別プローブし、実際の所有Roomを求める（QA修正・項目6根本原因）。
 * 従来はこの欠測区間を無条件で「親扱い（floorDeltaMm:0）」にフォールバックしていたが、
 * extent制限されたCL（例: Round Fフィクスチャの中心2/中心6）により自室セルの境界がface側で
 * 粗い場合、実際には部分指定の子が所有する区間まで「親扱い」に丸めてしまい、本来存在しない
 * 極小の段差（子→親(極小)→子）が生まれる——elevationOpenSpan.jsのcollectNearCellSegmentsで
 * 既に修正済みの「粗いセル境界での1点プローブ誤分類」と同根の問題のため、同じ刻み+個別プローブ
 * 方式で解決する。プローブしても所有者が見つからない（部屋外等）区間のみ、従来通り親扱いにする。
 * @param {object} graph
 * @param {object} face
 * @param {Map<string, import('@core').Room>} ownerByCell
 * @param {number} lo
 * @param {number} hi
 * @returns {Array<{runLo:number, runHi:number, owner:import('@core').Room|null}>}
 */
function probeGapOwners(graph, face, ownerByCell, lo, hi) {
  const breaks = collectRunBreaks(graph, face.isVertical, lo, hi);
  const out = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const runLo = breaks[i], runHi = breaks[i + 1];
    if (runHi - runLo < GAP_EPS) continue; // R4: elevationStyle.jsのGAP_EPS_MMと同定数
    const mid = (runLo + runHi) / 2;
    const axisValue = face.axisCL.value;
    const px = face.isVertical ? axisValue + face.inward * PROBE_EPS_MM : mid;
    const py = face.isVertical ? mid : axisValue + face.inward * PROBE_EPS_MM;
    const cell = worldToCell(px, py, graph);
    const owner = cell ? (ownerByCell.get(cell.key) ?? null) : null;
    out.push({ runLo, runHi, owner });
  }
  return out;
}

// セルキー(leftId:topId:rightId:bottomId)から、face.isVertical に応じたrunLo/runHi側のCL idを返す。
// elevationOpenSpan.jsもこの規約（cellBoundsFromKeyのtop<bottom・left<right）に依存するためexport。
export function runBoundaryCLIds(key, isVertical) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  // cellBoundsFromKeyの規約どおりtop<bottom・left<rightのため、runLo側は常にtop/left。
  return isVertical ? { loCLId: topId, hiCLId: bottomId } : { loCLId: leftId, hiCLId: rightId };
}

/**
 * room（自身の未指定セル）∪ 各部分指定の子のセル → 所有Roomの索引（子が親を上書き）。
 * elevationFloorProfile.js（wallAdjacentFloorSegments）・elevationStepFace.js
 * （stepRiserSegments）・elevationOpenSpan.js が共通で使う唯一の実装（QA修正: 3箇所の
 * 独立実装を統合）。
 * @param {import('@core').Room} room
 * @param {object} graph
 * @returns {Map<string, import('@core').Room>}
 */
export function roomOwnerByCell(room, graph) {
  // 面ごと（wallAdjacentFloorSegments / familyCeilingSegments / stepRiserSegments 等）に
  // 同じ部屋で何度も呼ばれるためスコープ内でmemo化する。**返り値は読み取り専用**。
  return scopedValue(graph, room, () => _roomOwnerByCell(room, graph));
}

function _roomOwnerByCell(room, graph) {
  const map = new Map();
  for (const key of refreshCells(room.cells, graph)) map.set(key, room);
  for (const r of graphList(graph, 'rooms') ?? []) {
    if (!r.referenceRoomIds?.has(room.id)) continue;
    for (const key of refreshCells(r.cells, graph)) map.set(key, r); // 子が親を上書き
  }
  return map;
}

/**
 * face（parentRoomの壁面1枚）に沿った実効FLの区間プロファイルを、face のローカルx（0..run。
 * face.isVertical の面ではy相当だが、buildRoomFaces の run 方向にそのまま乗る）で返す。
 *
 * @param {object} face - buildRoomFaces の1件
 * @param {import('@core').Room} parentRoom - この面を持つ部屋（壁を所有する側。部分指定の親）
 * @param {object} graph
 * @returns {Array<{loX:number, hiX:number, floorDeltaMm:number, chMm:number}>}
 *   floorDeltaMm = graph.effectiveFloorLevel(owner) - graph.effectiveFloorLevel(parentRoom)。
 *   chMm = 区間の所有Roomの解決済み天井高さ（roomCeilingHeight。問題修正2026-08:
 *   天井断面線は区間（エリア）の床断面からそのエリアのCHの距離に描くため、床と対で持つ）。
 *   0..face.run（ローカル座標）を隙間なく覆う（対応セルが見つからない区間は
 *   parentRoom扱い＝floorDeltaMm:0 にフォールバックする）。隣接区間でfloorDeltaMm・chMmが
 *   ともに同じなら結合し、区間が1つなら「床・天井とも段差なし」を意味する。
 */
export function wallAdjacentFloorSegments(face, parentRoom, graph) {
  const axisValue = face.axisCL.value; // finish/gridCells.js のセル境界も同じ.value基準
  const ownerByCell = roomOwnerByCell(parentRoom, graph);
  const chByRoom = new Map();
  const chOf = r => {
    if (!chByRoom.has(r.id)) chByRoom.set(r.id, roomCeilingHeight(graph, r).mm);
    return chByRoom.get(r.id);
  };

  // parentRoom自身のセルのうち、この面（壁）の「室内側(near)」に接しているものを壁沿いに拾う。
  // QA修正: 従来は`b.x1===axisValue || b.x2===axisValue`と面の両側（near/far）を拾っており、
  // 面に接するセルが両側にある構成（凹んだ部屋形状等）で区間が重複しうる不具合があった。
  // face.inward（室内へ向かう符号）で近い側の辺だけに限定する。
  const touching = [];
  for (const key of refreshCells(parentRoom.cells, graph)) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    if (!cellNearSideOnFace(face, b, axisValue)) continue;
    const [runLo, runHi] = face.isVertical ? [b.y1, b.y2] : [b.x1, b.x2];
    if (runHi <= face.lo || runLo >= face.hi) continue; // この面の範囲外
    const owner = ownerByCell.get(key) ?? parentRoom;
    const { loCLId, hiCLId } = runBoundaryCLIds(key, face.isVertical);
    touching.push({
      runLo: Math.max(runLo, face.lo), runHi: Math.min(runHi, face.hi), owner, chMm: chOf(owner),
      // クランプ（face.lo/hiでの切り詰め）が起きた端は、そのCLではなくfaceの端そのものが境界
      // のため、クランプが働いた側のCL idはnull（=segsのgap-fillと同じ「不明」扱い）にする。
      loCLId: runLo >= face.lo ? loCLId : null,
      hiCLId: runHi <= face.hi ? hiCLId : null,
    });
  }
  touching.sort((a, b) => a.runLo - b.runLo);

  // QA修正（項目2・3の根本原因）: 本来ぴったり隣接するはずの2セル境界が、CLの昇格/降格・
  // 再スナップ等で「同じ位置のはずの別CL」を参照するようになった場合、cellBoundsFromKeyが
  // 読む.valueに極小の誤差（浮動小数の丸め・別CLの僅差）が生じうる。この極小差がgap-fill
  // （下のcursor↔t.runLoの隙間埋め）を素通りしてsegsに残ると、その区間自体がfloorDeltaMmの
  // 異なる独立区間として扱われ、隣接区間の結合（delta一致マージ）では拾えない——
  // delta不一致のまま「子→親(極小)→子」という見た目上の1往復（段差の抽出不良）になる。
  // gap-fill判定自体にepsilonを持たせる案もあるが、生成された極小区間は結局すぐ下の
  // 「極小幅の区間を吸収する」処理で必ず除去されるため冗長——物理的に意味を持たない極小幅の
  // 区間をdeltaに関わらず一括で吸収する、この1箇所だけに許容差を持たせれば十分
  // （GAP_EPSはelevationStyle.jsのGAP_EPS_MM。R4）。
  const parentFL = graph.effectiveFloorLevel(parentRoom);
  // QA修正（項目6根本原因）: 欠測区間（touchingがそのまま覆わない箇所）を無条件で
  // 「親扱い（floorDeltaMm:0）」にせず、probeGapOwnersで刻んで個別に所有者を求める
  // （extent制限CLにより自室セルの境界がface側で粗い場合の誤分類を防ぐ。上部コメント参照）。
  // それでも所有者が見つからない区間だけ、従来通り親扱いにフォールバックする。
  const pushGap = (segs, lo, hi) => {
    for (const g of probeGapOwners(graph, face, ownerByCell, lo, hi)) {
      const floorDeltaMm = g.owner ? graph.effectiveFloorLevel(g.owner) - parentFL : 0;
      segs.push({
        runLo: g.runLo, runHi: g.runHi, floorDeltaMm, chMm: chOf(g.owner ?? parentRoom),
        loCLId: null, hiCLId: null,
      });
    }
  };
  const segs = [];
  let cursor = face.lo;
  for (const t of touching) {
    if (t.runLo > cursor) pushGap(segs, cursor, t.runLo);
    const floorDeltaMm = graph.effectiveFloorLevel(t.owner) - parentFL;
    // 重なり（t.runLo が cursor より小さい）はcursorへスナップし、区間の逆転・二重描画を防ぐ。
    const runLo = Math.max(t.runLo, cursor);
    if (t.runHi > runLo) segs.push({ runLo, runHi: t.runHi, floorDeltaMm, chMm: t.chMm, loCLId: t.loCLId, hiCLId: t.hiCLId });
    cursor = Math.max(cursor, t.runHi);
  }
  if (cursor < face.hi) pushGap(segs, cursor, face.hi);

  // 物理的に意味を持たない極小幅(<GAP_EPS)の区間は、floorDeltaMmが前後と異なっていても
  // 前（無ければ次）の区間へ吸収してから、通常のdelta一致マージへ進む（QA修正・上記コメント参照）。
  for (let i = segs.length - 1; i >= 0 && segs.length > 1; i--) {
    const s = segs[i];
    if (s.runHi - s.runLo >= GAP_EPS) continue;
    if (i > 0) segs[i - 1].runHi = s.runHi;
    else segs[i + 1].runLo = s.runLo;
    segs.splice(i, 1);
  }

  // 隣接区間でfloorDeltaMm・chMmがともに同じなら結合する（不要な段差線を出さないため。
  // 問題修正2026-08: 床が同じ高さでも天井高さ(chMm)が異なる境界は天井断面線の段差＝縦線に
  // なるため、chMmが異なる区間は結合しない）。
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.floorDeltaMm === s.floorDeltaMm && last.chMm === s.chMm && Math.abs(last.runHi - s.runLo) < GAP_EPS) {
      last.runHi = s.runHi;
      last.hiCLId = s.hiCLId;
    } else {
      merged.push({ ...s });
    }
  }

  // ローカルx（0..run）へ変換（dirSignが負の面はrunLo/runHiの大小が反転するため正規化する）。
  // worldCoord===face.originWorldのとき(0)*dirSignで-0になり得るため、+0で正規化する
  // （-0はJSでは0と数値的に等しいが、Object.is比較（assert.strict等）では区別され不便なため）。
  // 仕様4: loCLId/hiCLIdはrunLo/runHiと同じ向き（dirSign<0のfaceではlocalのlo/hiがrunの
  // hi/loと入れ替わるため、そちらもあわせて入れ替える）でsegsへ引き継ぐ——ROW1寸法のCL分割点
  // （elevationDimSplit.jsのS1=segs[i].hiCLId）が指すのは常に「オフセット前の実際のCL」。
  const toLocal = worldCoord => (worldCoord - face.originWorld) * face.dirSign + 0;
  return merged
    .map(s => {
      const a = toLocal(s.runLo), b = toLocal(s.runHi);
      const swapped = a > b;
      return {
        loX: Math.min(a, b), hiX: Math.max(a, b), floorDeltaMm: s.floorDeltaMm, chMm: s.chMm,
        loCLId: swapped ? s.hiCLId : s.loCLId, hiCLId: swapped ? s.loCLId : s.hiCLId,
      };
    })
    .sort((a, b) => a.loX - b.loX);
}

/**
 * 段差の描画x（オフセット後）を返す（仕様4）。segs[i]・segs[i+1]の境界（segs[i].hiX。オフセット前）
 * を、床が低い側へ半壁厚(halfWallMm)だけずらす——寸法・CL一点鎖線（オフセット前のsegs[i].hiXを
 * そのまま使う）とは別の値として持つ設計（elevation-model.md参照）。
 * @param {Array<{hiX:number, floorDeltaMm:number}>} segs
 * @param {number} i - 境界の手前側のインデックス（segs[i]とsegs[i+1]の間の境界）
 * @param {number} halfWallMm
 * @returns {number}
 */
export function drawnRiserX(segs, i, halfWallMm) {
  const towardLow = segs[i].floorDeltaMm > segs[i + 1].floorDeltaMm ? 1 : -1;
  return segs[i].hiX + towardLow * halfWallMm;
}

/**
 * 面の壁の「向こう側（far側）」にある部屋ファミリー（親＋部分指定の子＝部分指定関係のある部屋）
 * のセルを面のrun軸で刻んでプローブした「天井の絶対高さ区間」一覧（問題修正2026-08その3改）。
 * 展開図の「天井断面より上の向こう側の天井」を破線（かくれ線）で描くための入力。
 *
 * 問題修正2026-08その5（原因特定）: 旧実装は「ファミリー全セルを面のrun軸へ投影」しており、
 * 壁の向こう側に部分指定関係の部屋が無い面（外周壁のA1/B1/D2等）でも、部屋内の別エリアが
 * run座標上で重なるだけで破線が出ていた。破線は「壁の向こう側に部分指定関係のある部屋がある
 * 展開図（またぐ面）のみ」（ユーザー明示指示）のため、開放スパンのfarプローブと同じ要領で
 * axisCLのfar側を区間ごとに worldToCell プローブし、ファミリー所有セルがある区間だけを返す。
 * @param {object} face - buildRoomFaces/composeRoomFacesの1件
 * @param {import('@core').Room} parentRoom
 * @param {object} graph
 * @returns {Array<{loX:number, hiX:number, ceilAbsMm:number}>} ローカルx・同一天井高さの隣接区間は結合済み
 */
export function familyCeilingSegments(face, parentRoom, graph) {
  const ownerByCell = roomOwnerByCell(parentRoom, graph);
  const parentFL = graph.effectiveFloorLevel(parentRoom);
  const chByRoom = new Map();
  const chOf = r => {
    if (!chByRoom.has(r.id)) chByRoom.set(r.id, roomCeilingHeight(graph, r).mm);
    return chByRoom.get(r.id);
  };
  const axisValue = face.axisCL.value;
  const breaks = collectRunBreaks(graph, face.isVertical, face.lo, face.hi);
  const found = []; // 世界run座標の {lo, hi, ceilAbsMm}
  for (let i = 0; i + 1 < breaks.length; i++) {
    const lo = breaks[i], hi = breaks[i + 1];
    if (hi - lo < GAP_EPS) continue;
    const mid = (lo + hi) / 2;
    const px = face.isVertical ? axisValue - face.inward * PROBE_EPS_MM : mid;
    const py = face.isVertical ? mid : axisValue - face.inward * PROBE_EPS_MM;
    const cell = worldToCell(px, py, graph);
    const owner = cell ? (ownerByCell.get(cell.key) ?? null) : null;
    if (!owner) continue; // 向こう側が部屋外・部分指定関係のない部屋 → 破線の対象外
    const ceilAbsMm = (graph.effectiveFloorLevel(owner) - parentFL) + chOf(owner);
    const last = found[found.length - 1];
    if (last && last.ceilAbsMm === ceilAbsMm && Math.abs(last.hi - lo) < GAP_EPS) last.hi = hi;
    else found.push({ lo, hi, ceilAbsMm });
  }
  const toLocal = w => (w - face.originWorld) * face.dirSign + 0;
  return found
    .map(s => {
      const a = toLocal(s.lo), b = toLocal(s.hi);
      return { loX: Math.min(a, b), hiX: Math.max(a, b), ceilAbsMm: s.ceilAbsMm };
    })
    .sort((a, b) => a.loX - b.loX || a.ceilAbsMm - b.ceilAbsMm);
}

/**
 * 天井段差の描画x（オフセット後）を返す（問題修正2026-08）。CLをまたいで天井高さ
 * （天井の絶対高さ=floorDeltaMm+chMm）が異なる境界（segs[i].hiX。オフセット前）を、
 * 「低い方からみてCLの向こう側の壁厚」＝天井が高い側へ半壁厚(halfWallMm)だけずらす
 * （床のdrawnRiserX＝低い側へずらす、と対になる規約。寸法・CL一点鎖線側はオフセット前の
 * segs[i].hiXのまま）。
 * @param {Array<{hiX:number, floorDeltaMm:number, chMm?:number}>} segs
 * @param {number} i - 境界の手前側のインデックス（segs[i]とsegs[i+1]の間の境界）
 * @param {number} halfWallMm
 * @param {number} fallbackCeilAbsMm - chMm未指定の区間の天井絶対高さ（帯のCH）。両区間が
 *   chMmを持つ場合のみ省略可——chMm未指定の区間を含む呼び出しで省略すると比較が壊れる。
 * @returns {number}
 */
export function drawnCeilingRiserX(segs, i, halfWallMm, fallbackCeilAbsMm) {
  const ceilAbs = s => (s.chMm != null ? s.floorDeltaMm + s.chMm : fallbackCeilAbsMm);
  const towardHigh = ceilAbs(segs[i + 1]) > ceilAbs(segs[i]) ? 1 : -1;
  return segs[i].hiX + towardHigh * halfWallMm;
}

/**
 * face自身の壁厚の半分(mm)。|faceValue - axisCL.effectiveValue|（面自身の芯からのオフセット量＝
 * 半壁厚）を返す。0（合成face等でfaceValueが不明・芯に一致する場合）はDEFAULT_HALF_WALL_MM
 * （既定壁下地厚の半分+既定仕上げ厚=57.5mm）へフォールバックする。
 * @param {object} face
 * @returns {number}
 */
export function halfWallThicknessMm(face) {
  const v = Math.abs((face.faceValue ?? face.axisCL?.effectiveValue ?? 0) - (face.axisCL?.effectiveValue ?? 0));
  return v > 0 ? v : DEFAULT_HALF_WALL_MM;
}

// ---- 断面線（下側の輪郭）＝FloorProfile（QA修正2026-09でsection/sectionEmit.jsから移設） ----

/**
 * @typedef {Array<[number, number]>} FloorProfile
 *   その面の**断面線（下側の輪郭）**を表す折れ線。`[[localX, absZ], ...]`・x昇順で、垂直な
 *   段差は同じxを2点書く。範囲外（壁のない端部のはり出しぶん）は端点の値を保持する。
 *   `elevationFigure.js`の`ceilAbsAtX`が解釈する`ceilingProfile`（天井プロファイル）の
 *   **双子**——上下が逆なだけで、規約も補間の仕方もわざと同一に揃えてある（床と天井で
 *   別々の読み方を覚えなくていいように。elevationFigure.js側は本ファイルの
 *   drawnFloorProfileZAtをそのまま呼ぶ＝実装も1つ）。
 */

/**
 * floorSegments（[{loX,hiX,floorDeltaMm}]。昇順・隙間なし）→ FloorProfile。
 * 段差は同じxを2点書いて垂直に落とす（`elevationStairSequence.js`のstepCeilingProfileと
 * 同じ規約）。空・未指定は空配列。
 * @param {Array<{loX:number,hiX:number,floorDeltaMm?:number}>|null|undefined} segs
 * @returns {FloorProfile}
 */
export function floorProfileFromSegments(segs) {
  if (!segs?.length) return [];
  const pts = [];
  for (const s of segs) {
    const z = s.floorDeltaMm ?? 0;
    const last = pts[pts.length - 1];
    if (!last) pts.push([s.loX, z]);
    else if (Math.abs(last[1] - z) > GAP_EPS) pts.push([s.loX, z]); // 垂直な段差＝同じxを2点
    else pts.pop();                                                 // 同じ高さの続き＝末尾を伸ばす
    pts.push([s.hiX, z]);
  }
  return pts;
}

// profileLimitsOnで外挿（1/4・3/4の2点から線形に延ばす）を行う最小の区間長(mm)。GAP_EPS(1e-6)
// では分母(2q)が図面の実寸法スケールから外れるほど小さくなり、区間内にプロファイルの準垂直な
// 段差（同じ位置のはずの2点が丸め誤差でμm単位ずれた状態）が挟まると、外挿値が段差の高さぶん
// 上下へ飛び出す（QA指摘8）。1e-3mm＝1µmは作図上まったく意味を持たない幅なので、ここより
// 短い区間は外挿せず端点値をそのまま返す。
const PROFILE_LIMIT_MIN_SPAN_MM = 1e-3;

// [xl,xr]の**内側**でのprofileの線形な値（左端の右極限・右端の左極限）。区間内にprofileの
// 断点が無いことを前提に、内側の2点（1/4・3/4）から線形に外挿して求める——端点をそのまま
// 引くと、垂直な段差のある境界でどちら側の値が返るかが曖昧になる（drawnFloorProfileZAtは
// ceilAbsAtXと同じく「同じxの2点目」を返す規約）。
function profileLimitsOn(profile, xl, xr) {
  // 極小区間（またはxr<=xl・NaN）は外挿せず端点値。`!(… > …)`はNaNもこちらへ落とすため。
  if (!(xr - xl > PROFILE_LIMIT_MIN_SPAN_MM)) {
    return [drawnFloorProfileZAt(profile, xl), drawnFloorProfileZAt(profile, xr)];
  }
  const q = (xr - xl) / 4;
  const z1 = drawnFloorProfileZAt(profile, xl + q);
  const z2 = drawnFloorProfileZAt(profile, xr - q);
  const slope = (z2 - z1) / (2 * q);
  return [z1 - slope * q, z2 + slope * q];
}

/**
 * 2つのFloorProfileを**max**（＝2本の断面線のうち高い方が下側の輪郭）に合成する。
 * 断点は両者のx（和集合）に加え、区間内で大小が入れ替わる**交点x**も挿入する——入れないと
 * 交差の手前まで低い側の値が採られ、輪郭が実際より下（余分に描く側）へ膨らむ。
 * 片方が空なら他方のコピー。
 *
 * **各プロファイルは自分のx範囲の中でだけ効き、範囲外は相手に譲る**——読み出し側
 * （drawnFloorProfileZAt）の「範囲外は端点値を保持」をそのまま合成に持ち込むと、踊り場の
 * ような**短い寄与**の端点値が面の全長を覆い、そこにある階段の勾配を丸ごと飲み込んでしまう
 * （回帰: seq2のレーンの床線が全区間消える）。両方の範囲外は、結果の端点保持で表現される。
 * @param {FloorProfile|null|undefined} a
 * @param {FloorProfile|null|undefined} b
 * @returns {FloorProfile}
 */
export function mergeFloorProfiles(a, b) {
  if (!a?.length) return b?.length ? b.map(p => [...p]) : [];
  if (!b?.length) return a.map(p => [...p]);
  const breaks = [...new Set([...a, ...b].map(([x]) => x))].sort((p, q) => p - q);
  const out = [];
  const push = (x, z) => {
    const last = out[out.length - 1];
    // 同じ点の重複だけ落とす（同じx・違うz＝垂直な段差は両方残す）。
    if (last && Math.abs(last[0] - x) <= GAP_EPS && Math.abs(last[1] - z) <= GAP_EPS) return;
    out.push([x, z]);
  };
  if (breaks.length < 2) {
    const x = breaks[0];
    return [[x, Math.max(drawnFloorProfileZAt(a, x), drawnFloorProfileZAt(b, x))]];
  }
  const covers = (p, xl, xr) => p[0][0] <= xl + GAP_EPS && p[p.length - 1][0] >= xr - GAP_EPS;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const xl = breaks[i], xr = breaks[i + 1];
    if (xr - xl <= GAP_EPS) continue;
    const active = [a, b].filter(p => covers(p, xl, xr));
    if (active.length === 0) continue; // どちらの範囲でもない区間（両者が離れている）は跨いで結ぶ
    if (active.length === 1) {
      const [l, r] = profileLimitsOn(active[0], xl, xr);
      push(xl, l); push(xr, r);
      continue;
    }
    const [al, ar] = profileLimitsOn(a, xl, xr);
    const [bl, br] = profileLimitsOn(b, xl, xr);
    push(xl, Math.max(al, bl));
    const dl = al - bl, dr = ar - br;
    if ((dl > GAP_EPS && dr < -GAP_EPS) || (dl < -GAP_EPS && dr > GAP_EPS)) {
      const t = dl / (dl - dr);
      push(xl + (xr - xl) * t, al + (ar - al) * t);
    }
    push(xr, Math.max(ar, br));
  }
  return out;
}

/**
 * FloorProfileの高さ（絶対z）を面ローカルxで引く。null・空は-Infinity＝下限なし。
 * 補間・範囲外クランプの規約はelevationFigure.jsの`ceilingProfile`（天井プロファイル）と
 * 同一——同ファイルの`ceilAbsAtX`は本関数へ委譲している（QA修正2026-09で実装を1つに統合）。
 * @param {FloorProfile|null|undefined} profile
 * @param {number} x
 * @returns {number}
 */
export function drawnFloorProfileZAt(profile, x) {
  if (!profile?.length) return -Infinity;
  const first = profile[0], last = profile[profile.length - 1];
  const cx = Math.min(Math.max(x, first[0]), last[0]); // 範囲外は端点値へクランプ
  for (let i = 0; i + 1 < profile.length; i++) {
    const [x1, z1] = profile[i];
    const [x2, z2] = profile[i + 1];
    if (cx >= x1 - GAP_EPS && cx <= x2 + GAP_EPS) {
      return x2 === x1 ? z2 : z1 + ((cx - x1) / (x2 - x1)) * (z2 - z1);
    }
  }
  return last[1];
}

/**
 * FloorProfileの[x0,x1]区間での**最大**高さ（区分線形なので端点＋区間内の断点のmaxで足りる）。
 * null・空は-Infinity。
 * @param {FloorProfile|null|undefined} profile
 * @param {number} x0
 * @param {number} x1
 * @returns {number}
 */
export function drawnFloorProfileZMax(profile, x0, x1) {
  if (!profile?.length) return -Infinity;
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  let z = Math.max(drawnFloorProfileZAt(profile, lo), drawnFloorProfileZAt(profile, hi));
  for (const [x, pz] of profile) if (x > lo + GAP_EPS && x < hi - GAP_EPS) z = Math.max(z, pz);
  return z;
}

// 同区間の**最小**（矩形＝建具の姿の下端を詰める用。最も低い床で判定しないと、レーンの上へ
// 伸びる姿まで切ってしまう）。
function profileZMin(profile, x0, x1) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  let z = Math.min(drawnFloorProfileZAt(profile, lo), drawnFloorProfileZAt(profile, hi));
  for (const [x, pz] of profile) if (x > lo + GAP_EPS && x < hi - GAP_EPS) z = Math.min(z, pz);
  return z;
}

// 線分[x1,z1]-[x2,z2]のうち**輪郭より上**（z_line >= z_profile）の部分だけを返す。
// 輪郭の断点で分割し、各片（輪郭も線分も線形）で交点を厳密に求める。
function clipSegmentAboveProfile(profile, x1, z1, x2, z2) {
  const kept = [];
  const addRun = (a, b) => {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last[1][0] - a[0]) <= GAP_EPS && Math.abs(last[1][1] - a[1]) <= GAP_EPS) {
      last[1] = b; // 隣り合う片は1本へ繋ぐ
    } else kept.push([a, b]);
  };
  if (Math.abs(x2 - x1) <= GAP_EPS) {
    // 縦線: xが1点なので輪郭の値も1つ。z範囲を切り詰めるだけ。
    // 上端が輪郭ちょうど（＝残りが長さ0）も落とす——残すと長さ0の線が図に積もる。
    const floor = drawnFloorProfileZAt(profile, x1);
    const zLo = Math.min(z1, z2), zHi = Math.max(z1, z2);
    if (zHi <= floor + GAP_EPS) return [];
    if (zLo >= floor - GAP_EPS) return [[[x1, z1], [x2, z2]]];
    return z1 < z2 ? [[[x1, floor], [x2, z2]]] : [[[x1, z1], [x2, floor]]];
  }
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
  const xs = [lo, ...profile.map(([px]) => px).filter(px => px > lo + GAP_EPS && px < hi - GAP_EPS), hi];
  const zLineAt = x => z1 + ((x - x1) / (x2 - x1)) * (z2 - z1);
  for (let i = 0; i + 1 < xs.length; i++) {
    const xl = xs[i], xr = xs[i + 1];
    if (xr - xl <= GAP_EPS) continue;
    const [fl, fr] = profileLimitsOn(profile, xl, xr);
    const dl = zLineAt(xl) - fl, dr = zLineAt(xr) - fr;
    const keepL = dl >= -GAP_EPS, keepR = dr >= -GAP_EPS;
    if (keepL && keepR) { addRun([xl, zLineAt(xl)], [xr, zLineAt(xr)]); continue; }
    if (!keepL && !keepR) continue;
    const t = dl / (dl - dr);
    const xc = xl + (xr - xl) * t;
    if (keepL) addRun([xl, zLineAt(xl)], [xc, zLineAt(xc)]);
    else addRun([xc, zLineAt(xc)], [xr, zLineAt(xr)]);
  }
  // 元の線分の向き（x1→x2）へ戻す。
  return x1 <= x2 ? kept : kept.reverse().map(([a, b]) => [b, a]);
}

/**
 * **断面線の外は描画しない**（ユーザー明示指示2026-09「展開図では、断面線の外は描画しない」
 * 「階段下に部屋がある場合、断面下は描画しない」）——その面の断面線（`profile`。帯の床と
 * 縦断する階段寄与を合成した折れ線）より下を落とす。
 *
 * 適用対象は**壁の断面・見えがかり・建具の姿**だけ。呼び出し側で次の3つを対象外にする:
 * - **階段自身の断面**（踊り場桁枠・ささら断面は踊り場から桁成ぶん下がる）＝断面線そのもの
 * - **階段の見えがかり**（正面視の破線梯子・1FL足元線・ささらの端面）＝ユーザー裁定2026-09で
 *   「階段は描く」（実機「6」C）
 * - **アキ（`emitOpenGapMarks`のバツ・「ア キ」）**＝展開図一般化Phase 6b-2 C-2（設計
 *   `.claude/elevation-redesign.md`§5.11）でこの輪郭クリップの対象から外れた。アキの下端は
 *   もう`sectionHits.js`の`visibleBandsOf`が決めたband自身の値をそのまま使う——ここで
 *   二重にクリップすると、`open`帯が輪郭より下へ正しく伸びている区間（階段の桁の間の隙間等）を
 *   誤って持ち上げてしまう。
 * 構造梁も同じ理由で対象外（踊り場受け梁は踊り場から梁成ぶん下がる断面）。
 *
 * 水平線は「輪郭より下のときだけ落とす」非対称な扱い——輪郭とちょうど同じ高さの線
 * （床断面線そのもの）を落とさないため、判定は`>= 輪郭 - GAP_EPS`で行う。
 * `|| 0`は-0を避ける（sectionStair.jsのstairCutFloorProfile・elevationFigure.jsの
 * endFloorYOfと同じ規約。z=0の輪郭で出力が-0になると既存の比較（Object.is）がズレる）。
 * @param {object[]} prims
 * @param {FloorProfile|null|undefined} profile - null・空は下限なし＝**引数をそのまま返す**
 * @returns {object[]}
 */
export function clipContentAboveDrawnProfile(prims, profile) {
  if (!profile?.length) return prims;
  const out = [];
  for (const p of prims) {
    if (p.type === 'line') {
      for (const [a, b] of clipSegmentAboveProfile(profile, p.x1, -p.y1, p.x2, -p.y2)) {
        out.push({ ...p, x1: a[0], y1: -a[1] || 0, x2: b[0], y2: -b[1] || 0 });
      }
    } else if (p.type === 'polyline' && Array.isArray(p.points)) {
      let run = [];
      const flush = () => { if (run.length > 1) out.push({ ...p, points: run }); run = []; };
      for (let i = 0; i + 1 < p.points.length; i++) {
        const [ax, ay] = p.points[i], [bx, by] = p.points[i + 1];
        const parts = clipSegmentAboveProfile(profile, ax, -ay, bx, -by);
        for (const [a, b] of parts) {
          const head = [a[0], -a[1] || 0], tail = [b[0], -b[1] || 0];
          const last = run[run.length - 1];
          if (!last || Math.abs(last[0] - head[0]) > GAP_EPS || Math.abs(last[1] - head[1]) > GAP_EPS) {
            flush();
            run = [head];
          }
          run.push(tail);
        }
        if (parts.length === 0) flush();
      }
      flush();
    } else if (p.type === 'rect') {
      const floor = profileZMin(profile, p.x, p.x + (p.w ?? 0));
      const zTop = -p.y, zBot = -(p.y + (p.h ?? 0));
      if (zTop <= floor + GAP_EPS) continue;
      out.push(zBot >= floor - GAP_EPS ? p : { ...p, h: zTop - floor });
    } else if (p.type === 'text') {
      if (-p.y >= drawnFloorProfileZAt(profile, p.x) - GAP_EPS) out.push(p);
    } else {
      // 呼び出し側（elevationStairSequence.jsのcontentForCut）が出すのはline/polyline/rect/text
      // の4種だけ——それ以外（dim/miterTriangle等の注記系）はこの経路に入らない前提で素通しする。
      out.push(p);
    }
  }
  return out;
}
