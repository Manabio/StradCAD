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
import { refreshCells, cellBoundsFromKey } from '../finish/gridCells.js';
import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../finish/wallGeneration.js';

// 実壁が引けない面（単体テスト等の合成face）向けの半壁厚フォールバック(mm)。
// 既定壁下地厚(DEFAULT_WALL_BASE)の半分+既定仕上げ厚(DEFAULT_WALL_FINISH) = 45+12.5 = 57.5。
const DEFAULT_HALF_WALL_MM = DEFAULT_WALL_BASE / 2 + DEFAULT_WALL_FINISH;

// セルキー(leftId:topId:rightId:bottomId)から、face.isVertical に応じたrunLo/runHi側のCL idを返す。
function runBoundaryCLIds(key, isVertical) {
  const [leftId, topId, rightId, bottomId] = key.split(':');
  // cellBoundsFromKeyの規約どおりtop<bottom・left<rightのため、runLo側は常にtop/left。
  return isVertical ? { loCLId: topId, hiCLId: bottomId } : { loCLId: leftId, hiCLId: rightId };
}

/**
 * face（parentRoomの壁面1枚）に沿った実効FLの区間プロファイルを、face のローカルx（0..run。
 * face.isVertical の面ではy相当だが、buildRoomFaces の run 方向にそのまま乗る）で返す。
 *
 * @param {object} face - buildRoomFaces の1件
 * @param {import('@core').Room} parentRoom - この面を持つ部屋（壁を所有する側。部分指定の親）
 * @param {object} graph
 * @returns {Array<{loX:number, hiX:number, floorDeltaMm:number}>}
 *   floorDeltaMm = graph.effectiveFloorLevel(owner) - graph.effectiveFloorLevel(parentRoom)。
 *   0..face.run（ローカル座標）を隙間なく覆う（対応セルが見つからない区間は
 *   parentRoom扱い＝floorDeltaMm:0 にフォールバックする）。隣接区間でfloorDeltaMmが同じなら
 *   結合し、区間が1つ（floorDeltaMm:0 のみ）なら「段差なし」を意味する。
 */
export function wallAdjacentFloorSegments(face, parentRoom, graph) {
  const axisValue = face.axisCL.value; // finish/gridCells.js のセル境界も同じ.value基準

  // 部分指定（parentRoomをreferenceRoomIdsで参照するRoom）の現在セル → 所有Room の索引。
  const childOwnerByCell = new Map();
  for (const r of graph.rooms) {
    if (!r.referenceRoomIds?.has(parentRoom.id)) continue;
    for (const key of refreshCells(r.cells, graph)) childOwnerByCell.set(key, r);
  }

  // parentRoom自身のセルのうち、この面（壁）に接しているものを壁沿いに拾う。
  const touching = [];
  for (const key of refreshCells(parentRoom.cells, graph)) {
    const b = cellBoundsFromKey(key, graph);
    if (!b) continue;
    const onWall = face.isVertical
      ? (b.x1 === axisValue || b.x2 === axisValue)
      : (b.y1 === axisValue || b.y2 === axisValue);
    if (!onWall) continue;
    const [runLo, runHi] = face.isVertical ? [b.y1, b.y2] : [b.x1, b.x2];
    if (runHi <= face.lo || runLo >= face.hi) continue; // この面の範囲外
    const owner = childOwnerByCell.get(key) ?? parentRoom;
    const { loCLId, hiCLId } = runBoundaryCLIds(key, face.isVertical);
    touching.push({
      runLo: Math.max(runLo, face.lo), runHi: Math.min(runHi, face.hi), owner,
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
  // 区間をdeltaに関わらず一括で吸収する、この1箇所だけに許容差を持たせれば十分。
  const GAP_EPS = 1e-6;
  const parentFL = graph.effectiveFloorLevel(parentRoom);
  const segs = [];
  let cursor = face.lo;
  for (const t of touching) {
    if (t.runLo > cursor) segs.push({ runLo: cursor, runHi: t.runLo, floorDeltaMm: 0, loCLId: null, hiCLId: null }); // 欠測=親扱い
    const floorDeltaMm = graph.effectiveFloorLevel(t.owner) - parentFL;
    // 重なり（t.runLo が cursor より小さい）はcursorへスナップし、区間の逆転・二重描画を防ぐ。
    const runLo = Math.max(t.runLo, cursor);
    if (t.runHi > runLo) segs.push({ runLo, runHi: t.runHi, floorDeltaMm, loCLId: t.loCLId, hiCLId: t.hiCLId });
    cursor = Math.max(cursor, t.runHi);
  }
  if (cursor < face.hi) segs.push({ runLo: cursor, runHi: face.hi, floorDeltaMm: 0, loCLId: null, hiCLId: null });

  // 物理的に意味を持たない極小幅(<GAP_EPS)の区間は、floorDeltaMmが前後と異なっていても
  // 前（無ければ次）の区間へ吸収してから、通常のdelta一致マージへ進む（QA修正・上記コメント参照）。
  for (let i = segs.length - 1; i >= 0 && segs.length > 1; i--) {
    const s = segs[i];
    if (s.runHi - s.runLo >= GAP_EPS) continue;
    if (i > 0) segs[i - 1].runHi = s.runHi;
    else segs[i + 1].runLo = s.runLo;
    segs.splice(i, 1);
  }

  // 隣接区間でfloorDeltaMmが同じなら結合する（不要な段差線を出さないため）。
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && last.floorDeltaMm === s.floorDeltaMm && Math.abs(last.runHi - s.runLo) < GAP_EPS) {
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
        loX: Math.min(a, b), hiX: Math.max(a, b), floorDeltaMm: s.floorDeltaMm,
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
