/**
 * 展開図: プリミティブ配列の共通操作（buildRoomBand・buildStairBand 共有）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * translatePrimitive・collectGridCLs・部屋名枠の組み立ては、以前は elevationBand.js と
 * elevationStair.js にコピペで二重実装されており（QA指摘）、片方だけpolylineケースが
 * 抜ける・片方だけ部屋名枠を組み立てない、といった分岐が生じていた。両ビルダーはこのファイルの
 * 実装だけを使う。
 */
import { CenterLineType, Discipline } from '@core';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import { ElevationLineRole, weightForRole, DEFAULT_NAME_GAP_MM } from './elevationStyle.js';

const NAME_BOX_H_MM      = 400;
const NAME_BOX_CHAR_W_MM = 350;
const NAME_BOX_MIN_W_MM  = 1200;

/** 帯内の全プリミティブ種を一律 (dx,dy) だけ平行移動する（xCursor配置・floorOffset適用の共通処理）。 */
export function translatePrimitive(p, dx, dy) {
  switch (p.type) {
    case 'line':
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
 * 面軸に直交するグリッド通り芯（labeled struct CL）表示用に、graph全体の通り芯一覧を集める。
 * RADIAL（放射CL。value=角度deg）は座標軸を持たずgeometry未対応のため除外する
 * （structural/structuralAutoFill.js の secondaryBeamSpansFor と同じガード）。
 */
export function collectGridCLs(graph) {
  return graph.centerLines.filter(cl =>
    cl.labeled && cl.discipline === Discipline.STRUCT && cl.centerLineType !== CenterLineType.RADIAL);
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
 * @param {number} [nameGapModelMm] - 部屋名枠の上余白（モデルmm）。QA G5: 実画面
 *   NAME_GAP_BELOW_SCREEN_MM をElevationModeState.initがscreenMmToModelMmで換算した値を渡す
 *   （面間ギャップと同じ2パス方式）。未指定時はDEFAULT_NAME_GAP_MM（倍率決定用の1パス目・
 *   このモジュール単体テスト向けの仮値）。
 */
export function appendRoomNameFrame(primitives, roomName, nameGapModelMm = DEFAULT_NAME_GAP_MM) {
  if (primitives.length === 0) return;
  const preBounds = figureBounds(primitives);
  const cx = (preBounds.minX + preBounds.maxX) / 2;
  const boxW = Math.max(NAME_BOX_MIN_W_MM, (roomName?.length ?? 1) * NAME_BOX_CHAR_W_MM);
  const labelTop = preBounds.maxY + nameGapModelMm;
  const labelCY  = labelTop + NAME_BOX_H_MM / 2;
  primitives.push({ type: 'rect', x: cx - boxW / 2, y: labelTop, w: boxW, h: NAME_BOX_H_MM });
  primitives.push({ type: 'text', x: cx, y: labelCY, text: roomName, anchor: 'middle', baseline: 'middle' });

  const leaderWeight = weightForRole(ElevationLineRole.DETAIL);
  if (preBounds.minX < cx - boxW / 2) {
    primitives.push({ type: 'line', x1: preBounds.minX, y1: labelCY, x2: cx - boxW / 2, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(preBounds.minX, labelCY, 1));
  }
  if (preBounds.maxX > cx + boxW / 2) {
    primitives.push({ type: 'line', x1: cx + boxW / 2, y1: labelCY, x2: preBounds.maxX, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(preBounds.maxX, labelCY, -1));
  }
}
