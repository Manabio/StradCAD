// ================================================================
// 開口（建具・窓） — ホスト壁の解決と配置検証（純関数）
//
// Opening は Wall インスタンスを参照しないため、軸直交方向の実座標
// （axisValue）と壁厚方向の情報は常に「いまその位置にある壁」を
// ライブ検索して得る。
// ================================================================

import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';

/**
 * Opening と同じ axisCL・向き・側（wallSide）にあり、span が opening を完全に
 * 包含する壁を1本返す。シンボル配置（OpeningsLayer）・当たり判定（findOpeningAt）
 * 専用 — 壁線のギャップ判定には使わない（findOpeningsOnWall 参照）。
 *
 * 通常運用では候補は常に1本に定まる（部屋の壁は自動生成のみで、cells が排他的
 * なため同じ (axisCL, 符号, span) を複数の部屋が同時に主張することはない）。
 * 該当する壁が複数あれば axisOffset の絶対値が最小のものを採用するが、これは
 * レガシーインポートデータに対する防御的なフォールバックに過ぎない。
 * 該当なし = null（開口は描画されない）。
 */
export function findHostWall(opening, graph) {
  let best = null, bestAbs = Infinity;
  for (const w of graph.walls) {
    if (w.isVertical !== opening.isVertical) continue;
    if (w.axisCL.id  !== opening.axisCL.id)  continue;
    // CL偏芯の仕上げ面合わせで axisOffset===0（CL上に面が一致）になった壁は両側にマッチさせる
    const wSign = Math.sign(w.axisOffset);
    if (wSign !== 0 && wSign !== opening.wallSide) continue;
    const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
    if (opening.coord1 < lo || opening.coord2 > hi) continue;
    if (Math.abs(w.axisOffset) < bestAbs) { bestAbs = Math.abs(w.axisOffset); best = w; }
  }
  return best;
}

/**
 * 壁1本に物理的に重なる開口の一覧（ShapesLayer のギャップ描画用）。
 *
 * 部屋境界の壁は同じ axisCL・span 上に符号違いで複数本生成される
 * （部屋同士の間仕切り＝両室がそれぞれ自分側の壁を独立生成／部屋と外壁＝
 * 部屋自身の内向き壁と外皮としての外向き壁が同じ境界に独立生成される。
 * いずれも generateRoomWallsFromOutline / generateExteriorWalls 参照）。
 *
 * 1つの開口は物理的にその場所の壁すべてを貫通するため、ここでは
 * axisCL・向き・span の重なりのみで判定し、findHostWall のような
 * wallSide（符号）の厳格一致は要求しない。これにより、間仕切りや
 * 外壁の両面どちらの壁線にも正しくギャップが入る。
 */
export function findOpeningsOnWall(wall, graph) {
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  return graph.openings.filter(o =>
    o.isVertical === wall.isVertical &&
    o.axisCL.id  === wall.axisCL.id &&
    o.coord1 >= lo && o.coord2 <= hi
  );
}

/**
 * 壁の仕上げ面が向く側（±1）。finishSide 明示指定があれば優先し、無ければ axisValue と
 * axisCL.effectiveValue の差の符号から導出する。差が0（CL上に面が一致するCL偏芯壁等）の
 * ときは fallback を返す。openingTagPlacement.js の roomSideDir・openingEdit.js の
 * swingSide既定決定で共有する（fallback値は呼び出し側の既存挙動に合わせて渡すこと）。
 */
export function wallFaceDir(wall, fallback = 1) {
  return wall.finishSide ?? (Math.sign(wall.axisValue - wall.axisCL.effectiveValue) || fallback);
}

/**
 * 開き戸が直交方向(perp)の指定側（±1。isVertical壁ならx、水平壁ならy）へ開くための
 * swingSide（±1）を返す。OpeningsLayer.jsx swingSymbol の開き角度式
 * （perpDir = (isVertical?1:-1) * swingSide * hingeSide）の逆解き。
 * perpDir に0を渡した場合は1（fallback扱い）として扱い、0/NaNを返さない。
 */
export function swingSideTowardPerp(isVertical, hingeSide, perpDir) {
  const dir = perpDir || 1;
  return (isVertical ? 1 : -1) * dir * hingeSide;
}

/**
 * 壁ラジアルメニューのヒット判定: 押下点（perp。isVertical壁ならworld.x、水平壁ならworld.y）が
 * 壁の面線（axisValue）近傍にあるかを判定する。「壁線とその近傍」＝壁線そのものを含むため、
 * 部屋側と材側で非対称の許容を持つ:
 *   - 部屋側（面線から見て材と反対側。面線上=0を含む）: thresholdWorld(mm) 未満
 *   - 材側（面線から見て軸CL側）: inwardWorld(mm) と 面線〜軸CLの距離 の小さい方(未満)
 * どちらも壁の真ん中（軸CL）には決して届かないようクランプし、通り芯側のメニューに譲る。
 *
 * 面線〜軸CLの距離は符号付き（toCL）で求める——`Math.abs(wall.axisOffset)` は使わない。
 * CL偏芯（finish/clEccentricity.js:227,304 が axisOffset と finishSide を独立に設定するため、
 * `|e| > b/2+f` のとき符号が食い違いうる）では、faceDir から見て軸CLが材側でなく**部屋側**に
 * 来ることがある。この場合 axisOffset の絶対値は「面線〜軸CLの距離」の代理にならず、材側は
 * クランプ対象自体が存在しない（許容0）、逆に部屋側の thresholdWorld を軸CL手前でクランプ
 * しないと「壁の真ん中は通り芯に譲る」不変条件が壊れる。
 * findNearestWall がpx→mm換算した thresholdWorld・inwardWorld（各 px/scale）を渡して使う。
 */
export function isWallRadialHit(wall, perp, thresholdWorld, inwardWorld) {
  const faceDir = wallFaceDir(wall);
  const signedDist = (perp - wall.axisValue) * faceDir; // >=0: 部屋側, <0: 材側
  // toCL: 面線から軸CLまでの符号付き距離（faceDir方向を正とする）。
  // 通常( >=0 側から見て軸CLは材側): toCL < 0。CL偏芯で符号が食い違う異常系: toCL > 0（軸CLが部屋側）。
  const toCL = (wall.axisCL.effectiveValue - wall.axisValue) * faceDir;
  if (signedDist >= 0) {
    const roomLimit = toCL > 0 ? Math.min(thresholdWorld, toCL) : thresholdWorld;
    return signedDist < roomLimit;
  }
  const maxInward = Math.min(inwardWorld, toCL < 0 ? -toCL : 0);
  return -signedDist < maxInward;
}

/**
 * 壁1本ぶんの壁ラジアルヒット判定＋スクリーン距離（findNearestWall の壁ループ本体）。
 * 垂直壁は scaleX・水平壁は scaleY で px⇔mm 換算する（軸を取り違えるとヒット判定が反転する
 * ため、両者の換算は必ずこの関数に閉じ込め、呼び出し側で軸を選び間違えないようにする）。
 * ヒットしなければ null。dist は nearest 選定用のスクリーン距離(px)。
 * @returns {number|null}
 */
export function wallRadialHitDist(wall, wx, wy, thresholdPx, scaleX, scaleY, inwardPx) {
  const scale = wall.isVertical ? scaleX : scaleY;
  const perp  = wall.isVertical ? wx : wy;
  if (!isWallRadialHit(wall, perp, thresholdPx / scale, inwardPx / scale)) return null;
  const along = wall.isVertical ? wy : wx;
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  if (along < lo || along > hi) return null;
  return Math.abs(wall.axisValue - perp) * scale;
}

/**
 * walls（graph.walls）のうちカーソルに最も近い壁を返す（開口配置の長押し検出用。腰壁・垂れ壁
 * メニュー・カーソル pointer 表示も同じ結果を使う——単一のヒット判定なので用途によって挙動を
 * 分けない）。自動生成壁（isRoomWall）のみを対象とする — 現行UIには壁の手描きツールが
 * 存在しないため、レガシーインポートデータ由来の isRoomWall:false 壁を開口のホスト候補から
 * 確実に除外する。snap.js findNearestWall の本体（node:test 単体テスト対応のため純関数として
 * ここに置く。snap.js は store.js を静的 import するため node:test から単体 import できない）。
 */
export function nearestWallHit(walls, wx, wy, thresholdPx, scaleX, scaleY, inwardPx) {
  let nearest = null, minDist = Infinity;
  for (const w of walls) {
    if (!w.isRoomWall) continue;
    const dist = wallRadialHitDist(w, wx, wy, thresholdPx, scaleX, scaleY, inwardPx);
    if (dist == null || dist >= minDist) continue;
    minDist = dist; nearest = w;
  }
  return nearest;
}

/** 配置検証: 壁範囲内か／既存開口と重なっていないか。OK なら null、NGならエラーメッセージ。 */
export function validateOpeningPlacement(wall, coord1, coord2, graph, excludeId = null) {
  const lo = Math.min(wall.coord1, wall.coord2), hi = Math.max(wall.coord1, wall.coord2);
  if (coord1 < lo || coord2 > hi) return ERR_OPENING_OUT_OF_WALL;
  const overlap = findOpeningsOnWall(wall, graph).some(o =>
    o.id !== excludeId && coord1 < o.coord2 && coord2 > o.coord1);
  if (overlap) return ERR_OPENING_OVERLAP;
  return null;
}

/**
 * 壁の実材範囲（materialRange）× 長さ方向範囲（coord1/coord2）のワールド矩形。
 * finish/stair/stairUnderClip.js（2a壁クリップの障害物判定）・openings/openingTagPlacement.js
 * （建具記号丸の壁バンド回避）の両方から共有する単一実装。
 */
export function wallWorldRect(w) {
  const lo = Math.min(w.coord1, w.coord2), hi = Math.max(w.coord1, w.coord2);
  const { lo: mLo, hi: mHi } = w.materialRange;
  return w.isVertical
    ? { x1: mLo, y1: lo, x2: mHi, y2: hi }
    : { x1: lo, y1: mLo, x2: hi, y2: mHi };
}

/**
 * host と同じ axisCL・向きで符号違い（反対側）にあり、span が重なる壁を1本返す（境界の反対側の壁）。
 * 部屋間の間仕切り＝両室がそれぞれ自室側に1枚ずつ、建物外周＝室内向き壁＋外向きの外壁の2枚——
 * いずれも1つの境界にWallは2枚ある（本ファイル冒頭コメント参照）ため、host単体では境界の全体像
 * （例: 外壁境界か）が判定できない。見つからない場合（外壁・手動壁で反対側が無い）は null。
 *
 * along（長さ方向座標。省略時=null は従来どおり最初に見つかった候補）を渡すと、その座標を
 * 自スパンに含む候補だけに絞る——1本の境界の背後が途中まで屋外・途中から隣室（segmented）の
 * 平面では、span が少しでも重なる最初の1本を返すだけでは登録順しだいで誤った相手を拾う
 * （実配置位置と無関係な区間の壁を「反対側」と誤認する）ため。wallFaceRange は面範囲を返す
 * 用途（along非依存）のため along を渡さず現行挙動を維持し、openingEdit.js（外壁境界判定）は
 * 実際に開口が置かれる位置を渡す。
 */
export function findCounterpartWall(host, graph, along = null) {
  const lo = Math.min(host.coord1, host.coord2), hi = Math.max(host.coord1, host.coord2);
  return graph.walls.find((w) => {
    if (w === host || w.axisCL !== host.axisCL || w.isVertical !== host.isVertical) return false;
    if (Math.sign(w.axisOffset) !== -Math.sign(host.axisOffset)) return false;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (wLo >= hi || wHi <= lo) return false;
    return along == null || (along >= wLo && along <= wHi);
  }) ?? null;
}

/**
 * host の両面位置 [faceLo, faceHi] を返す。反対側の壁（findCounterpartWall）が見つかれば
 * その面位置、見つからない場合（外壁・手動壁）は軸CLを中心に対称とみなす。
 * OpeningsLayer（詳細LOD枠描画）・openingTagPlacement（記号丸のオフセット配置）で共有する。
 */
export function wallFaceRange(host, graph) {
  const counterpart = findCounterpartWall(host, graph);
  const otherFace = counterpart ? counterpart.axisValue : 2 * host.axisCL.effectiveValue - host.axisValue;
  return [Math.min(host.axisValue, otherFace), Math.max(host.axisValue, otherFace)];
}

/**
 * 境界（wall自身または findCounterpartWall で見つかる反対側の壁）が外壁を含むなら、その外壁の
 * 仕上げ面が向く側（＝室外側）を返す。どちらも外壁でなければ null（＝屋内境界。呼び出し側が
 * 触れた側をそのまま使う）。室内向き壁（isExteriorWall:false）を触っても、境界の反対側にある
 * 外壁を見て「外壁境界である」と判定できるようにするための helper（openingEdit.js 参照）。
 * along（長さ方向座標）は findCounterpartWall にそのまま渡す——境界が長さ方向で外壁区間／
 * 隣室区間に分かれる（segmented）平面では、実際に開口が置かれる位置で反対側の壁を特定しないと
 * 誤った区間の相手を拾う。
 */
export function exteriorSideDir(wall, graph, along = null) {
  if (wall.isExteriorWall) return wallFaceDir(wall);
  const counterpart = findCounterpartWall(wall, graph, along);
  if (counterpart?.isExteriorWall) return wallFaceDir(counterpart);
  return null;
}
