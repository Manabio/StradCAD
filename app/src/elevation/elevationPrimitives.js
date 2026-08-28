/**
 * 展開図: プリミティブ配列の共通操作（buildRoomBand・buildStairBand 共有）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * translatePrimitive・collectGridCLs・部屋名枠の組み立ては、以前は elevationBand.js と
 * elevationStair.js にコピペで二重実装されており（QA指摘）、片方だけpolylineケースが
 * 抜ける・片方だけ部屋名枠を組み立てない、といった分岐が生じていた。両ビルダーはこのファイルの
 * 実装だけを使う。
 */
import { CenterLineType, isGridCenterLine } from '@core';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { ElevationLineRole, weightForRole, DEFAULT_NAME_GAP_MM } from './elevationStyle.js';
import { graphList } from '../graphReadScope.js';

const NAME_BOX_H_MM      = 400;
const NAME_BOX_CHAR_W_MM = 350;
const NAME_BOX_MIN_W_MM  = 1200;

/**
 * 帯内の全プリミティブ種を一律 (dx,dy) だけ平行移動する（xCursor配置・floorOffset適用の共通処理）。
 * mirrorPrimitiveX と対を成す幾何変換——両関数は同じプリミティブ型集合を扱うこと
 * （片方にだけ型を追加すると、その型だけ移動/反転されない無言バグになる）。
 */
export function translatePrimitive(p, dx, dy) {
  switch (p.type) {
    case 'line':
    case 'arrow':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'rect':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':
    case 'tag':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'miterTriangle':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'polyline':
      return { ...p, points: p.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'dim':
      return p.dir === 'h'
        ? { ...p, from: p.from + dx, to: p.to + dx, at: p.at + dy, foot: p.foot != null ? p.foot + dy : p.foot }
        : { ...p, from: p.from + dy, to: p.to + dy, at: p.at + dx, foot: p.foot != null ? p.foot + dx : p.foot };
    default:
      return p;
  }
}

/**
 * プリミティブを x=0..width の範囲内で左右反転する（x → width − x。yは不変）。
 * 開口の姿図（openings/openingElevationFigure.js）は「世界座標昇順＝図のx昇順」の
 * 正準向きで生成される（吊元 hingeSide<0＝coord1側＝図のx=0。平面記号
 * renderer/OpeningsLayer.jsx swingSymbol の hingeAlong と同じ世界アンカー）ため、
 * 世界順とローカル順が反転する面（dirSign<0）ではこの反転を掛けてから配置する——
 * 掛けないと吊元・親子扉の子・レバーハンドル等の非対称要素が逆端に描かれる。
 * translatePrimitive と対を成す幾何変換——両関数は同じプリミティブ型集合を扱うこと。
 * @param {object} p - 姿図プリミティブ（line/arrow/rect/text/polyline/circle/tag/miterTriangle/dim）
 * @param {number} width - 反転の基準幅（開口幅）
 */
export function mirrorPrimitiveX(p, width) {
  const m = (x) => width - x;
  switch (p.type) {
    case 'line':
    case 'arrow':
      return { ...p, x1: m(p.x1), x2: m(p.x2) };
    case 'rect':
      return { ...p, x: m(p.x + p.w) };
    case 'text': {
      const anchor = p.anchor === 'start' ? 'end' : p.anchor === 'end' ? 'start' : p.anchor;
      return { ...p, x: m(p.x), anchor };
    }
    case 'circle':
    case 'tag':
      return { ...p, cx: m(p.cx) };
    case 'miterTriangle':
      return { ...p, x: m(p.x), dir: -p.dir };
    case 'polyline':
      return { ...p, points: p.points.map(([x, y]) => [m(x), y]) };
    case 'dim':
      // 水平dimは区間[from,to]を反転、縦dimはat（x位置）と補助線foot（同じくx位置）を反転する
      // （translatePrimitive の縦dimが at/foot 両方を平行移動するのと同じ対応関係）
      return p.dir === 'h'
        ? { ...p, from: m(p.to), to: m(p.from) }
        : { ...p, at: m(p.at), foot: p.foot != null ? m(p.foot) : p.foot };
    default:
      return p;
  }
}

/**
 * 面軸に直交するグリッド通り芯（labeled struct CL）表示用に、graph全体の通り芯一覧を集める。
 * RADIAL（放射CL。value=角度deg）は座標軸を持たずgeometry未対応のため除外する
 * （structural/structuralAutoFill.js の secondaryBeamSpansFor と同じガード）。
 * 通り芯かどうかの判定は`isGridCenterLine`（core/centerLine.js）へ一本化する
 * ——`labeled`だけでは中心線（UI経路の既定でlabeled:true）まで拾ってしまう。
 */
export function collectGridCLs(graph) {
  return (graphList(graph, 'centerLines') ?? []).filter(cl =>
    isGridCenterLine(cl) && cl.centerLineType !== CenterLineType.RADIAL);
}

/**
 * 引出線の留め三角（直角三角形。外側の辺が垂直、底辺が引出線上、斜辺が内側へ下る）。
 * 高さ・底辺幅はスクリーン固定サイズ（TRIANGLE_HEIGHT_SCREEN_MM・TRIANGLE_ANGLE_DEG。
 * elevationStyle.js）のため、ここではmm座標に焼き込まずアンカー点(px,py=引出線の端点)と
 * 向き(dir)だけを持つ専用プリミティブにする——figurePrimitivesKonva.jsxが描画時に
 * 校正値(screenPxPerMm)でpx換算する（tagのrPxと同じ考え方。.claude/elevation-model.md参照）。
 * @param {number} px - アンカーx（引出線の外側の端点＝三角の垂直辺の位置）
 * @param {number} py - アンカーy（引出線のy＝三角の底辺の位置）
 * @param {1|-1} dir - 底辺が内側(部屋名枠側)へ伸びる向き（+1=右へ、-1=左へ）
 */
function miterTriangle(px, py, dir) {
  return { type: 'miterTriangle', x: px, y: py, dir };
}

/**
 * 部屋名枠＋左右引出線＋留め三角を primitives の末尾へ追加する（破壊的。図群中心下側に配置）。
 * primitives が空（面が1つも無い）ときは何もしない。buildRoomBand・buildStairBand共有。
 * @param {object[]} primitives
 * @param {string} roomName
 * @param {{nameGapModelMm?:number, leftX?:number|null, rightX?:number|null}} [opts]
 *   nameGapModelMm - 部屋名枠の上余白（モデルmm）。QA G5: 実画面NAME_GAP_BELOW_SCREEN_MMを
 *   ElevationModeState.initがscreenMmToModelMmで換算した値を渡す。未指定時はDEFAULT_NAME_GAP_MM。
 *   leftX/rightX - 左右の留め三角・引出線の水平アンカー（モデルmm。項目9: 左＝天井高寸法線の外側、
 *   右＝一番右の壁中心線の外側、それぞれ実画面10mm）。呼び出し側(buildRoomBand/buildStairBand)が
 *   算出して渡す。未指定時はfigureBounds(primitives)のminX/maxX（このモジュール単体テスト・
 *   面0件以外の呼び出し向けフォールバック）。
 */
export function appendRoomNameFrame(primitives, roomName, opts = {}) {
  if (primitives.length === 0) return;
  const nameGapModelMm = opts.nameGapModelMm ?? DEFAULT_NAME_GAP_MM;
  const preBounds = figureBounds(primitives);
  const leftX  = opts.leftX  ?? preBounds.minX;
  const rightX = opts.rightX ?? preBounds.maxX;
  const cx = (leftX + rightX) / 2;
  const boxW = Math.max(NAME_BOX_MIN_W_MM, (roomName?.length ?? 1) * NAME_BOX_CHAR_W_MM);
  const labelTop = preBounds.maxY + nameGapModelMm;
  const labelCY  = labelTop + NAME_BOX_H_MM / 2;
  primitives.push({ type: 'rect', x: cx - boxW / 2, y: labelTop, w: boxW, h: NAME_BOX_H_MM });
  primitives.push({ type: 'text', x: cx, y: labelCY, text: roomName, anchor: 'middle', baseline: 'middle' });

  const leaderWeight = weightForRole(ElevationLineRole.DETAIL);
  if (leftX < cx - boxW / 2) {
    primitives.push({ type: 'line', x1: leftX, y1: labelCY, x2: cx - boxW / 2, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(leftX, labelCY, 1));
  }
  if (rightX > cx + boxW / 2) {
    primitives.push({ type: 'line', x1: cx + boxW / 2, y1: labelCY, x2: rightX, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(rightX, labelCY, -1));
  }
}
