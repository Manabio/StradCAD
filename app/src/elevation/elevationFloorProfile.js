/**
 * 展開図: 壁面1枚の「壁際セルの実効FL」プロファイル（項目4。純関数）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * 部分指定Room（referenceRoomIdsで親Roomを参照。.claude/glossary.md「部分指定 / 参照元」）が
 * 親Roomの一部セルを占め、かつ親と floorLevel が異なる場合、その区間だけ床線を段差させる
 * ための入力データを組み立てる。セル→世界座標の変換は finish/gridCells.js の既存ユーティリティ
 * （cellBoundsFromKey・refreshCells）をそのまま再利用する（Room.cells は中心線グリッドの
 * セルキー集合であり、この対応関係を再実装しないため）。
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
