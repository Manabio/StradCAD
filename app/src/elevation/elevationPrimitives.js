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
import { ElevationLineRole, weightForRole } from './elevationStyle.js';

const NAME_BOX_H_MM      = 400;
const NAME_BOX_CHAR_W_MM = 350;
const NAME_BOX_MIN_W_MM  = 1200;
const NAME_GAP_BELOW_MM  = 500;
const MITER_SIZE_MM      = 80;

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

// 引出線の留め三角（45°の塗りつぶし三角形。端点を頂点に持つ小さな矢じり状マーカー）。
function miterTriangle(px, py) {
  return {
    type: 'polyline', closed: true, fill: '#1e293b',
    points: [[px - MITER_SIZE_MM, py - MITER_SIZE_MM], [px + MITER_SIZE_MM, py - MITER_SIZE_MM], [px, py + MITER_SIZE_MM]],
  };
}

/**
 * 部屋名枠＋左右引出線＋留め三角を primitives の末尾へ追加する（破壊的。図群中心下側に配置）。
 * primitives が空（面が1つも無い）ときは何もしない。buildRoomBand・buildStairBand共有。
 * @param {object[]} primitives
 * @param {string} roomName
 */
export function appendRoomNameFrame(primitives, roomName) {
  if (primitives.length === 0) return;
  const preBounds = figureBounds(primitives);
  const cx = (preBounds.minX + preBounds.maxX) / 2;
  const boxW = Math.max(NAME_BOX_MIN_W_MM, (roomName?.length ?? 1) * NAME_BOX_CHAR_W_MM);
  const labelTop = preBounds.maxY + NAME_GAP_BELOW_MM;
  const labelCY  = labelTop + NAME_BOX_H_MM / 2;
  primitives.push({ type: 'rect', x: cx - boxW / 2, y: labelTop, w: boxW, h: NAME_BOX_H_MM });
  primitives.push({ type: 'text', x: cx, y: labelCY, text: roomName, anchor: 'middle', baseline: 'middle' });

  const leaderWeight = weightForRole(ElevationLineRole.DETAIL);
  if (preBounds.minX < cx - boxW / 2) {
    primitives.push({ type: 'line', x1: preBounds.minX, y1: labelCY, x2: cx - boxW / 2, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(preBounds.minX, labelCY));
  }
  if (preBounds.maxX > cx + boxW / 2) {
    primitives.push({ type: 'line', x1: cx + boxW / 2, y1: labelCY, x2: preBounds.maxX, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(preBounds.maxX, labelCY));
  }
}
