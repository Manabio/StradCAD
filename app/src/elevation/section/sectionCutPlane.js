/**
 * 展開図の「仮想断面線をどこへ置くか」の単一情報源（ユーザー明示指示2026-08）。
 *
 * **規則: 描画対象の面の壁の中心線から、室内側（`face.inward`方向）へ下がる。**
 * 下がる量は、その面を見るときに手前で邪魔になりうるものが全て切断面より向こう側
 * （＝見える側）に収まる距離＝次の最大値（1mm単位で切り上げ）:
 *   1. その面の壁の中心線 → 壁仕上げ面
 *   2. その面に現れる柱型の、室内側への出（`finish/columnWrap.js`の包み外形）
 *   3. その面の前の造作家具の出（カウンター・キッチン等。**ドメインモデル未実装のためdefer**。
 *      `opts.builtInProjectionMm`のフックだけ用意する）
 * **多層帯では全ての層について同じ評価を行い、その最大を採る**——ユーザー例「6」A:
 * 「2階の左右断面位置（X2とX3）を見て柱型・造作家具はない／1階の左右断面位置（X2から左へ3200と
 * X3）をさぐり柱型・造作家具はない」。層ごとに面の走り範囲も壁厚も違うため、自階だけ見ると
 * 上階の柱型に切断面が食い込む。
 *
 * **なぜこれが要るのか（旧実装の誤り）**: 旧`elevationVoid.js`は切断線を面自身の壁の中心線
 * ちょうどに置いていた。切断面が壁の中を通るため、(a)見えがかり候補は全て室外の壁になり
 * `withinViewRoom`に全部落とされ、(b)所有Roomの1点プローブが室の外に落ちてroom=nullになり、
 * 床スラブ・天井懐の分類ごとスキップされていた——実測で A/C面が`[["open",0,5400]]`（全部アキ＝
 * 何も抽出されない）になっていた。階段帯（正しく出ている方）は切断線をレーン位置＝**室の中**へ
 * 置いており、両者の違いはまさにこの1点だった。
 *
 * 純モジュール（store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 */
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { graphList } from '../../graphReadScope.js';
import { structuralColumnContribution } from './sectionStructure.js';

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

/**
 * 面の軸から見て「室内側（+inward方向）へどれだけ出ているか」。負（室外側）は0へ丸める。
 * @param {number} axisValue - 面の軸CLの世界座標
 * @param {1|-1} inward - 面の軸から室内へ向かう世界方向
 * @param {number} lo - 対象の厚み方向の世界範囲
 * @param {number} hi
 * @returns {number}
 */
function inwardProjection(axisValue, inward, lo, hi) {
  const nearSide = inward > 0 ? Math.max(lo, hi) : Math.min(lo, hi);
  return Math.max(0, (nearSide - axisValue) * inward);
}

/**
 * 規則1「その面の壁の中心線→壁仕上げ面」を、指定した層の壁から求める。
 * `face.faceValue`（自階の内壁仕上げ面）に依存せず**層ごとに引き直す**——多層帯では上階の壁厚が
 * 違いうるため（自階だけ見ると上階の壁に切断面が食い込む）。
 * 面と同一直線上（軸CLの世界座標が一致・向きが一致）で走り範囲が重なる壁が対象。
 * @param {{isVertical:boolean, inward:number, lo:number, hi:number}} face
 * @param {number} axisValue
 * @param {object} graph
 * @returns {number}
 */
function wallFinishProjection(face, axisValue, graph) {
  let max = 0;
  for (const w of graphList(graph, 'walls') ?? []) {
    if (!!w.isVertical !== !!face.isVertical) continue;
    if (Math.abs(w.axisCL.effectiveValue - axisValue) > GAP_EPS) continue;
    const c1 = Math.min(w.coord1, w.coord2), c2 = Math.max(w.coord1, w.coord2);
    if (!rangesOverlap(face.lo, face.hi, c1, c2)) continue;
    const mr = w.materialRange;
    if (!mr) continue;
    max = Math.max(max, inwardProjection(axisValue, face.inward, mr.lo, mr.hi));
  }
  return max;
}

/**
 * 規則2「その面に現れる柱型の室内側への出」。
 * 「その面に現れるか」の判定は`structuralColumnPrimitivesForCut`と同じ2条件
 * （①接続した壁の軸CLが面の軸と一致 ②または柱の断面が面の軸をまたぐ）を使う——柱と面を結ぶ
 * 関係の二重管理を増やさないため。走り方向は面の範囲と重なることを要求する。
 * ユーザー仕様は「左右の端に柱型があれば」だが、**面の途中に立つ柱も同じ理由で手前を塞ぐ**ため
 * 面上の柱すべてを対象にする（端の柱はこの一般規則に含まれる）。
 * @param {{isVertical:boolean, inward:number, lo:number, hi:number}} face
 * @param {number} axisValue
 * @param {import('./sectionStructure.js').ColumnSolid[]} columnSolids
 * @returns {number}
 */
function columnProjection(face, axisValue, columnSolids) {
  let max = 0;
  for (const col of columnSolids ?? []) {
    const onFaceWall = (col.wallAxes ?? []).some(a =>
      !!a.isVertical === !!face.isVertical && Math.abs(a.axisValue - axisValue) <= GAP_EPS);
    const [acrossLo, acrossHi] = face.isVertical ? [col.xLo, col.xHi] : [col.yLo, col.yHi];
    const straddles = axisValue >= acrossLo - GAP_EPS && axisValue <= acrossHi + GAP_EPS;
    if (!onFaceWall && !straddles) continue;
    const [runLo, runHi] = face.isVertical ? [col.yLo, col.yHi] : [col.xLo, col.xHi];
    if (!rangesOverlap(face.lo, face.hi, runLo, runHi)) continue;
    max = Math.max(max, inwardProjection(axisValue, face.inward, acrossLo, acrossHi));
  }
  return max;
}

/**
 * 仮想断面線を面の軸から室内側へ下げる量(mm)。本ファイル冒頭の規則の実装。
 * @param {{isVertical:boolean, inward:number, lo:number, hi:number, axisCL:object}} face
 * @param {Array<{graph:object, floorZMm:number, role?:string}>} layers - 帯が持つ全ての層
 * @param {{builtInProjectionMm?:number, columnSolids?:object[]}} [opts]
 *   builtInProjectionMm … 造作家具の出（ドメインモデル未実装のためのフック。既定0＝defer）。
 *   columnSolids … 既に算出済みのColumnSolid[]（省略時はlayersから求める）。
 * @returns {number} 0以上。1mm単位で切り上げ。
 */
export function cutPlaneOffsetMm(face, layers, opts = {}) {
  const axisValue = face?.axisCL?.effectiveValue;
  if (!Number.isFinite(axisValue) || (face.inward !== 1 && face.inward !== -1)) return 0;
  const columnSolids = opts.columnSolids ?? structuralColumnContribution(layers ?? []);
  let max = Math.max(0, opts.builtInProjectionMm ?? 0);
  max = Math.max(max, columnProjection(face, axisValue, columnSolids));
  for (const layer of layers ?? []) {
    if (!layer?.graph) continue;
    max = Math.max(max, wallFinishProjection(face, axisValue, layer.graph));
  }
  return Math.ceil(max);
}

/**
 * 面 → SectionCut の CutLine（仮想断面線）。`axisValue`は面の軸から室内側へ`offsetMm`下げた位置。
 *
 * `faceAxisValue`（面自身の軸CLの世界座標）を併せて載せる——切断線が面の軸から離れると、
 * 「その面の壁と接続した柱か」のような**面の軸との照合**（`sectionStructure.js`）が
 * `cut.line.axisValue`では成り立たなくなるため、面の軸は別の値として保持する。
 * `lo/hi`と`dirSign`は動かさないので、断面ローカルxと面ローカルxが同値である不変条件
 * （`sectionTypes.js`の`cutOriginWorld`）はそのまま保たれる。
 * @param {{isVertical:boolean, inward:number, lo:number, hi:number, axisCL:object, faceValue?:number}} face
 * @param {number} offsetMm - cutPlaneOffsetMmの結果
 * @returns {import('./sectionTypes.js').CutLine & {faceAxisValue:number}}
 */
export function faceCutLine(face, offsetMm) {
  const axisValue = face.axisCL.effectiveValue;
  return {
    isVertical: !!face.isVertical,
    axisValue: axisValue + face.inward * offsetMm,
    lo: face.lo, hi: face.hi,
    faceAxisValue: axisValue,
    // 直交壁は面の壁に突き当たって室内側の面で終わる（面の軸CL上までは届かない）。切断線を
    // 室内側へ下げたぶんだけ突き当たり位置は近づくので、許容差は「壁仕上げ面までの距離 −
    // 下げた量」で足りる（負なら0）。sectionProbe.jsのisCutWall参照。
    buttToleranceMm: Math.max(0,
      Math.abs((face.faceValue ?? axisValue) - axisValue) - offsetMm),
  };
}

/**
 * 面の視線方向（世界方向の符号）。**面の軸から室内側が`inward`、視線はその逆**＝壁を見る向き。
 * `sectionProbe.js`の`isSightlineShape`契約「見えがかり候補はlineから+viewSign側」と、
 * 展開記号の規約`letterOf(isVertical, -cut.viewSign)`（.claude/elevation-model.md）の両方に
 * 一致する単一の定義（呼び出し側で符号を書き下ろさない——過去に符号が経路ごとに食い違った）。
 * @param {{inward:number}} face
 * @returns {1|-1}
 */
export function faceViewSign(face) {
  return face.inward > 0 ? -1 : 1;
}
