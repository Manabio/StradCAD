// ================================================================
// 建具モード 平面記号（renderer/OpeningsLayer.jsx）の幾何計算（純関数）。
//
// openingTagPlacement.js ⇄ renderer/OpeningTagLayer.jsx と同じ分離方針: react-konva を
// 静的 import しないことで node:test から単体 import できるようにする
// （抽出純モジュールはnode:testから単体import可能に保つという不変条件）。
// ================================================================

import { exteriorSideDir, swingSideTowardPerp } from './openingGeometry.js';
import { HINGED_MECHANISMS, SASH_OPEN_MECHANISMS, hingeSideMatters } from './openingCatalog.js';
// viewport.js は mobx と @core しか import しない純モジュールのため、node:test 単体import制約
// （抽出純モジュールはnode:testから単体import可能に保つ）に抵触しない（openingTagPlacement.js と同じ）。
import { LodLevel } from '../viewport.js';

export const DOOR_OPEN_ANGLE_DEG = 90;

// 平面記号の見込帯・枠寸法（すべて mm）。renderer/OpeningsLayer.jsx から移設——
// planFrameBand が一般/詳細の唯一の分岐点になるため、その入出力に関わる寸法定数もここに置く。
export const SASH_DEPTH_MM         = 40; // 一般LODの見込帯（固定）
export const FRAME_OVERHANG_MM     = 10; // 枠が壁面から室内外へ出る量
export const FRAME_JAMB_WIDTH_MM   = 30; // 方立の全幅（本体20 + かかり代10）
export const FRAME_KAKARI_WIDTH_MM = 10; // 方立のうち開口側かかり代

/**
 * 開き戸が開く直交方向(±1。isVertical壁ならx、水平壁ならy)。蝶番系以外は0を返す。
 *
 * 扉は「開く側の壁面」で閉じる（蝶番＝その面にある）ため、平面記号の回転中心・閉じた扉の
 * 四角・方立の欠き込みはすべてこの向きに従う——host.axisValue（ユーザーが叩いた面）に
 * 固定すると、「開く方向反転」後に扉が壁を貫いて反対側へ開く（planSymbolPlan参照）。
 *
 * 式は openingGeometry.js swingSideTowardPerp と同一（perpDir と swingSide を入れ替えても
 * 成り立つ自己逆関数のため、順方向計算にそのまま使う＝式を二重定義しない）。
 * 両開き系（hingeSideMatters が false）は *LeafSpecs が coord1 側 leaf を hingeSide=-1 固定で
 * 作り opening.hingeSide を参照しないため、実効吊元を -1 として計算する。
 */
export function swingOpenPerpDir(isVertical, hingeSide, swingSide, mechanism, entry) {
  if (!HINGED_MECHANISMS.has(mechanism)) return 0;
  const effHingeSide = hingeSideMatters(mechanism, entry) ? hingeSide : -1;
  return swingSideTowardPerp(isVertical, effHingeSide, swingSide);
}

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

/**
 * 詳細LODの片開き戸「閉じた状態の扉」の矩形区間（長さ方向 along・直交方向 perp）。
 *
 * 扉は開いた位置を1本線＋円弧で示し、厚みのある四角は閉じた位置に描く（ユーザー指示2026-09）。
 * 閉じ位置の扉は方立の欠き込み（pivotPerp から壁中心側へ扉厚ぶん。OpeningsLayer.jsx
 * swingFrameSymbol の notchFar と同じ区間）にそのまま納まる——欠き込みの向き outward は
 * 呼び出し側が Math.sign(host.axisOffset) で与える。
 * 長さ方向は吊元 hingeAlong から閉じ方向（closedAngleFor と同じ towardFar の規約）へ leafLength。
 */
export function swingClosedLeafSpan({ hingeAlong, hingeSide, leafLength, pivotPerp, outward, thickness }) {
  const towardFar = hingeSide < 0 ? 1 : -1;
  const alongFar  = hingeAlong + towardFar * leafLength;
  const perpFar   = pivotPerp - (outward || 1) * thickness;
  return {
    alongLo: Math.min(hingeAlong, alongFar),
    alongHi: Math.max(hingeAlong, alongFar),
    perpLo:  Math.min(pivotPerp, perpFar),
    perpHi:  Math.max(pivotPerp, perpFar),
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

/**
 * 平面記号の見込帯（壁厚方向の範囲）。詳細LODは「一般記号を実寸の帯で描き直したもの」であり
 * 別実装ではない——この関数が一般／詳細の唯一の分岐点になる（機構を追加しても詳細側の枠処理には
 * 手を入れなくてよい拡張ポイント。.claude/opening-model.md参照）。frameDepth（ユーザー入力の
 * 見込み、実装方針6）を最優先し、未設定（0/負値/null=不正値。heightと同じ規約）または壁厚以上の
 * ときのみ壁厚いっぱい（面±overhang）へ縮退する。exteriorDirは半外付けの寄せ方向——境界が
 * 屋内で室外側が定まらない（0/null/undefined）ときは面間の中央に置く。
 * @returns {{lo:number, hi:number, center:number, depth:number}}
 */
export function planFrameBand({ axisValue, faceLo, faceHi, frameDepth, exteriorDir, detail }) {
  if (!detail) {
    const lo = axisValue - SASH_DEPTH_MM / 2, hi = axisValue + SASH_DEPTH_MM / 2;
    return { lo, hi, center: axisValue, depth: hi - lo };
  }
  const outerLo = Math.min(faceLo, faceHi) - FRAME_OVERHANG_MM;
  const outerHi = Math.max(faceLo, faceHi) + FRAME_OVERHANG_MM;
  const d = frameDepth > 0 ? frameDepth : null;
  let lo, hi;
  if (d === null || d >= outerHi - outerLo) {
    lo = outerLo; hi = outerHi;
  } else if (exteriorDir > 0) {
    hi = outerHi; lo = hi - d;
  } else if (exteriorDir < 0) {
    lo = outerLo; hi = lo + d;
  } else {
    const c = (outerLo + outerHi) / 2;
    lo = c - d / 2; hi = c + d / 2;
  }
  return { lo, hi, center: (lo + hi) / 2, depth: hi - lo };
}

/** 見込帯の相対位置t(0..1)に対応するperp座標。leafのトラック位置計算で使う。 */
export function bandPerp(band, t) {
  return band.lo + band.depth * t;
}

/**
 * 枠内法（両端の方立の内側）の長さ方向区間。詳細LODでは記号本体をこの区間へ寄せる。
 * width<=jambWidth*2の細い開口でも区間を反転させない（中央へ縮退させる）。
 * @returns {{lo:number, hi:number, width:number}}
 */
export function frameInnerSpan(coord1, coord2, jambWidth) {
  const width = coord2 - coord1;
  if (width <= jambWidth * 2) {
    const mid = (coord1 + coord2) / 2;
    return { lo: mid, hi: mid, width: 0 };
  }
  const lo = coord1 + jambWidth, hi = coord2 - jambWidth;
  return { lo, hi, width: hi - lo };
}

/**
 * 詳細LODディスパッチの「判断」を1箇所に集約する純関数。renderer/OpeningsLayer.jsx は
 * `.jsx`のためnode:testから単体importできず、判断ロジックをそこへ残すと結線ミスが単体テストで
 * 検出できない（QA実測: F1のcenterCoord消失・F2のpivotPerp未クランプが1779/1779緑のまま混入した。
 * 過去にもleaf仕様決定を*LeafSpecs関数へ一本化した際に同種の指摘を受けている）。
 *
 * - frame: 'notched'  蝶番系（HINGED_MECHANISMS。SWING含む）——扉が通過するため方立に欠き込みが
 *            要る（呼び出し側はswingFrameSymbolを使う。SWING自身は既存のFRAME_HINGE_INSET_MM等
 *            専用inset方式のままで、innerSpanは使わない＝現状維持）。
 *          'sashOpen' 記号自身が開口全幅の枠矩形を描く非蝶番系（SASH_OPEN_MECHANISMS）——方立は
 *            内側の縦線を持たない3辺（コの字）で描く（記号側の枠矩形と同一座標の二重描画防止。F5）。
 *          'sash'     それ以外の非蝶番系（記号が枠矩形を描かない）——方立は閉じた矩形。
 *            SLIDE_DOUBLEもここに分類されるが、OpeningsLayer.jsxはSLIDE_DOUBLEを専用ブランチ
 *            （slideDoubleDetailSymbol）で早期returnして消費するため、この'sash'は実際には
 *            参照されない（IMPLEMENTED_MECHANISMSの29機構を漏れなく分類する総関数にするための
 *            既定値。呼び出し側が実際にsashFrameSymbolを描く「sash」機構は5件）。
 *          'none'     SCHEMATIC/STANDARD（lodLevelがDETAILでない）。
 * - innerSpan: frameInnerSpanの結果。frame==='none'のときはnull（呼び出し側はspan-shrinkを
 *   行わない＝一般記号は開口全幅のまま）。
 * - pivotPerp: 回転中心のperp座標。**蝶番系は「扉が開く側の壁面」**（openPerpDir＞0ならfaceHi、
 *   ＜0ならfaceLo）——扉は開く側の面で閉じ、蝶番もその面にあるため。host.axisValue
 *   （ユーザーが叩いた面）に固定すると「開く方向反転」後に閉じた扉・欠き込みが元の面に残り、
 *   扉が壁厚を貫いて反対側へ開く（実際に起きた不具合）。既定配置では開く側＝叩いた面のため
 *   従来と同じ位置になる。面線（faceLo/faceHi）が渡らない・非蝶番系はaxisValueへフォールバック。
 *   詳細LODではさらにband内へクランプする——frameDepthで半外付けに帯が寄ると面自身がband外に
 *   出るため（F2。回転中心を「枠の中心」ではなく「band内の最寄りの面」に保つ）。一般LODのbandは
 *   axisValue±20mmの便宜的な帯で壁面を含まないため、クランプすると面ではなく帯の縁に吸着する。
 * - leafOutward: 閉じた扉の四角（swingClosedLeafSpan）・方立の欠き込みが壁の中心側へ向かう向き
 *   （＝openPerpDir。pivot面から壁内部へ扉厚ぶん）。Math.sign(host.axisOffset) は使わない——
 *   hostは叩いた面の壁で室外側・開く側のどちらとも一致せず、CL偏芯でも破綻する。
 * @returns {{frame:'notched'|'sash'|'sashOpen'|'none', innerSpan:{lo:number,hi:number,width:number}|null, pivotPerp:number, leafOutward:number}}
 */
export function planSymbolPlan({ mechanism, lodLevel, coord1, coord2, axisValue, band, jambWidth, faceLo, faceHi, openPerpDir = 0 }) {
  const hasFaces = Number.isFinite(faceLo) && Number.isFinite(faceHi);
  const pivotFace = openPerpDir && hasFaces
    ? (openPerpDir > 0 ? Math.max(faceLo, faceHi) : Math.min(faceLo, faceHi))
    : axisValue;
  const detail = lodLevel === LodLevel.DETAIL;
  const pivotPerp = detail ? Math.min(Math.max(pivotFace, band.lo), band.hi) : pivotFace;
  const leafOutward = openPerpDir || 1;
  if (!detail) return { frame: 'none', innerSpan: null, pivotPerp, leafOutward };
  const frame = HINGED_MECHANISMS.has(mechanism)
    ? 'notched'
    : SASH_OPEN_MECHANISMS.has(mechanism)
      ? 'sashOpen'
      : 'sash';
  const innerSpan = frameInnerSpan(coord1, coord2, jambWidth);
  return { frame, innerSpan, pivotPerp, leafOutward };
}

/**
 * 詳細LODで枠の内法へ記号本体を寄せるための派生opening。coord1/coord2/widthのみ`span`
 * （frameInnerSpanの結果）に差し替え、centerCoordは変えない（OVERHEAD/EMERGENCY等が向き判定に
 * 使うため）。
 *
 * `{...opening}`はMobXのcomputed（centerCoord/coord1/coord2。core/wall.js Openingのgetterが
 * `makeObservable`でinstanceにenumerable:falseとして定義される）を**own enumerable property
 * として拾えない**ため、上書きしない限りcenterCoordは必ずundefinedになる——実装時に一度この形で
 * 落とし、実Openingインスタンスで再現・修正した実バグ（PIVOT/EMERGENCYの記号が詳細LODで消える・
 * overheadSymbol/emergencySymbolのalong=undefined化でexteriorSideDirのsegmented判定が壊れる）。
 * 将来Openingにcomputedフィールドが増えたときも同じ形で再発しうるため、この関数へ一本化する。
 */
export function innerSpanOpening(opening, span) {
  return { ...opening, coord1: span.lo, coord2: span.hi, width: span.width, centerCoord: opening.centerCoord };
}
