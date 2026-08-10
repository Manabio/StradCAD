// ================================================================
// 建具モード 平面記号（renderer/OpeningsLayer.jsx）の幾何計算（純関数）。
//
// openingTagPlacement.js ⇄ renderer/OpeningTagLayer.jsx と同じ分離方針: react-konva を
// 静的 import しないことで node:test から単体 import できるようにする
// （抽出純モジュールはnode:testから単体import可能に保つという不変条件）。
// ================================================================

import { exteriorSideDir } from './openingGeometry.js';

export const DOOR_OPEN_ANGLE_DEG = 90;

/**
 * 蝶番(hinge)から見た「閉じ位置」の方向角(度、ワールド空間)。hingeSide<0→長さ座標が増える
 * 方向、hingeSide>0→減る方向へ閉じる（swingLeafSymbol・freeLeafSymbol・fireLeafSymbol・
 * fireFoldPanel が共有する規約）。
 */
export function closedAngleFor(isVertical, hingeSide) {
  const towardFar = hingeSide < 0 ? 1 : -1;
  return isVertical ? (towardFar > 0 ? 90 : -90) : (towardFar > 0 ? 0 : 180);
}

/**
 * closedAngle から回転センス sense の向きへ angleDeg 分回転した開き角(度)。
 * sense は swingSide と同じ規約（openingGeometry.js swingSideTowardPerp の
 * perpDir=(isVertical?1:-1)*swingSide*hingeSide と整合させる）——1枚構成は opening.swingSide
 * をそのまま渡し、2枚構成（両開き・親子・常時開放防火戸/折戸の両袖）は対向leafのみ符号を
 * 反転して渡す。hingeSide が反転する対向leafは、同じ物理側（perpDir）へ開くには sense も
 * 反転する必要がある（反転しないと2枚が壁の反対側へ開いてしまう回帰バグの再発防止）。
 */
export function leafOpenAngle(closedAngle, sense, angleDeg = DOOR_OPEN_ANGLE_DEG) {
  return closedAngle + sense * angleDeg;
}

/** 角度(度、ワールド空間)の単位ベクトル。dir=その方向、perp=dirに直交する単位ベクトル。 */
export function angleVectors(angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    dir:  { x: Math.cos(rad), y: Math.sin(rad) },
    perp: { x: -Math.sin(rad), y: Math.cos(rad) },
  };
}

/** SWING_CHILD: 親leaf長=width×(1-childRatio)・子leaf長=width×childRatio。 */
export function swingChildLengths(width, childRatio) {
  return { parentLen: width * (1 - childRatio), childLen: width * childRatio };
}

/**
 * SWING_DOUBLE（両開き）のleaf仕様（{hingeAlong, hingeSide, sense, leafLength}[]）。
 * 左右の枠端それぞれを吊元に、各leaf長=width/2。coord2側は対向leaf（hingeSideが反転する）
 * のため、同じ物理側（perpDir）へ開かせるべくsenseをswingSideの符号反転で渡す
 * （leafOpenAngleのコメント参照。呼び出し側（OpeningsLayer.jsx）はこの配列を
 * `.map(s => swingLeafSymbol(isVertical, host, s.hingeAlong, s.hingeSide, s.sense, s.leafLength, sp))`
 * するだけで、leaf仕様の決定ロジック自体はここに一本化される）。
 */
export function swingDoubleLeafSpecs(coord1, coord2, width, swingSide) {
  const leafLength = width / 2;
  return [
    { hingeAlong: coord1, hingeSide: -1, sense: swingSide, leafLength },
    { hingeAlong: coord2, hingeSide: 1, sense: -swingSide, leafLength },
  ];
}

/**
 * SWING_CHILD（親子扉）のleaf仕様。親leaf長=width×(1-childRatio)、子leaf長=width×childRatio。
 * 親の吊元はhingeSide側の枠端、子の吊元は反対側の枠端——子は対向leafのためsenseを反転する
 * （swingDoubleLeafSpecs参照）。
 */
export function swingChildLeafSpecs(coord1, coord2, width, hingeSide, swingSide, childRatio) {
  const { parentLen, childLen } = swingChildLengths(width, childRatio);
  const parentAlong = hingeSide < 0 ? coord1 : coord2;
  const childAlong  = hingeSide < 0 ? coord2 : coord1;
  return [
    { hingeAlong: parentAlong, hingeSide, sense: swingSide, leafLength: parentLen },
    { hingeAlong: childAlong, hingeSide: -hingeSide, sense: -swingSide, leafLength: childLen },
  ];
}

/**
 * FIRE_DOOR（常時開放式防火戸）のleaf仕様。fireLeaves:2は両枠端から対称に（coord2側は対向leaf
 * のためsenseを反転。swingDoubleLeafSpecsと同じ規約）、1はhingeSide側のみ（leaf長=width）。
 * 常に配列を返す（呼び出し側は要素数を問わず`.map()`するだけでよい）。
 */
export function fireDoorLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireLeaves) {
  if (fireLeaves === 2) {
    const leafLength = width / 2;
    return [
      { hingeAlong: coord1, hingeSide: -1, sense: swingSide, leafLength },
      { hingeAlong: coord2, hingeSide: 1, sense: -swingSide, leafLength },
    ];
  }
  const hingeAlong = hingeSide < 0 ? coord1 : coord2;
  return [{ hingeAlong, hingeSide, sense: swingSide, leafLength: width }];
}

/**
 * FIRE_FOLD（常時開放式防火折戸）のleaf仕様。fireAngle:180は両袖（各leaf長=width/2。coord2側は
 * 対向leafのためsenseを反転）、90は片袖（hingeSide側のみ、leaf長=width）。fireDoorLeafSpecsと
 * 同じクラスの符号反転（swingDoubleLeafSpecs参照）が必要なため、同じ形の関数として揃えておく。
 */
export function fireFoldLeafSpecs(coord1, coord2, width, hingeSide, swingSide, fireAngle) {
  if (fireAngle === 180) {
    const leafLength = width / 2;
    return [
      { hingeAlong: coord1, hingeSide: -1, sense: swingSide, leafLength },
      { hingeAlong: coord2, hingeSide: 1, sense: -swingSide, leafLength },
    ];
  }
  const hingeAlong = hingeSide < 0 ? coord1 : coord2;
  return [{ hingeAlong, hingeSide, sense: swingSide, leafLength: width }];
}

/**
 * FOLD/FIRE_FOLDのジグザグ点列（長さ方向alongのみ。perpオフセット(mm)は呼び出し側で
 * axisValueに加算する）。両端(along=coord1/coord1+width)はperpOffset=0で壁軸上に一致する。
 * @returns {{along:number, perpOffset:number}[]}
 */
export function foldZigzagPoints(coord1, width, peaks, amplitudeMm) {
  const segCount = peaks * 2;
  const points = [];
  for (let i = 0; i <= segCount; i += 1) {
    const along = coord1 + (width * i) / segCount;
    const perpOffset = i === 0 || i === segCount ? 0 : (i % 2 === 1 ? -amplitudeMm : amplitudeMm);
    points.push({ along, perpOffset });
  }
  return points;
}

/**
 * SLIDE_LAYOUT: パネルのトラック番号（0始まり）。tracks:3は panels.length が3を超えても
 * 巡回割付（index % tracks）にして範囲外インデックスを防ぐ。tracks:2はfixパネルを外側(0)・
 * 可動を内側(1)へ、fixが1枚も無ければindex交互（index % 2）で振り分ける。
 */
export function trackOf(panel, index, tracks, hasFix) {
  if (tracks === 3) return index % tracks;
  if (hasFix) return panel.fix ? 0 : 1;
  return index % 2;
}

/**
 * SLIDE_LAYOUT: トラック番号(0始まり)→壁軸(axisValue)からの絶対perp座標。sashDepth は
 * サッシ枠の見付奥行き幅（呼び出し側のSASH_DEPTH_MM）。
 */
export function trackPerp(axisValue, track, tracks, sashDepth) {
  return tracks === 3
    ? axisValue - sashDepth / 2 + (sashDepth * (track + 0.5)) / 3
    : (track === 0 ? axisValue - sashDepth / 4 : axisValue + sashDepth / 4);
}

/**
 * SLIDE_LAYOUT: entryから安全にpanels配列を取り出す。未定義entry・slideLayout未設定・
 * panels:[]（空配列）はすべて空配列[]を返す——呼び出し側（OpeningsLayer.jsx slideLayoutSymbol・
 * openingElevationFigure.js slideLayoutPrimitives）は`.map()`するだけで自然に0要素＝0本の
 * leaf線/プリミティブになり、それぞれが個別に空判定・例外処理を持つ必要がない（平面・姿図の
 * 両方が同じ1つの関数の振る舞いに従うため、片方だけ直しても揃う）。
 */
export function resolveSlideLayoutPanels(entry) {
  return entry?.slideLayout?.panels ?? [];
}

/**
 * OVERHEAD/EMERGENCY共通: 開口の「外部側」方向(±1)。境界（host自身または反対側の壁）が
 * 外壁を含むならその外壁の仕上げ面向き（exteriorSideDir）、屋内境界（両側とも非外壁）なら
 * host自身のfaceDirへフォールバックする。host.axisOffsetの符号は「室外側」を意味しない
 * （hostはユーザーが叩いた面の壁で、室内向き壁がhostだと逆を向く。CL偏芯でも破綻する）ため、
 * 単純な Math.sign(host.axisOffset) は使わない（.claude/opening-model.md参照）。
 */
export function openingExteriorDir(host, graph, centerCoord) {
  return exteriorSideDir(host, graph, centerCoord) ?? host.faceDir;
}
