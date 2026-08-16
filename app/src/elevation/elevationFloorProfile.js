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
    touching.push({ runLo: Math.max(runLo, face.lo), runHi: Math.min(runHi, face.hi), owner });
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
    if (t.runLo > cursor) segs.push({ runLo: cursor, runHi: t.runLo, floorDeltaMm: 0 }); // 欠測=親扱い
    const floorDeltaMm = graph.effectiveFloorLevel(t.owner) - parentFL;
    // 重なり（t.runLo が cursor より小さい）はcursorへスナップし、区間の逆転・二重描画を防ぐ。
    const runLo = Math.max(t.runLo, cursor);
    if (t.runHi > runLo) segs.push({ runLo, runHi: t.runHi, floorDeltaMm });
    cursor = Math.max(cursor, t.runHi);
  }
  if (cursor < face.hi) segs.push({ runLo: cursor, runHi: face.hi, floorDeltaMm: 0 });

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
    } else {
      merged.push({ ...s });
    }
  }

  // ローカルx（0..run）へ変換（dirSignが負の面はrunLo/runHiの大小が反転するため正規化する）。
  // worldCoord===face.originWorldのとき(0)*dirSignで-0になり得るため、+0で正規化する
  // （-0はJSでは0と数値的に等しいが、Object.is比較（assert.strict等）では区別され不便なため）。
  const toLocal = worldCoord => (worldCoord - face.originWorld) * face.dirSign + 0;
  return merged
    .map(s => {
      const a = toLocal(s.runLo), b = toLocal(s.runHi);
      return { loX: Math.min(a, b), hiX: Math.max(a, b), floorDeltaMm: s.floorDeltaMm };
    })
    .sort((a, b) => a.loX - b.loX);
}
