import { observer } from 'mobx-react-lite';
import { Rect, Circle, Path } from 'react-konva';
import { findSectionEntry, SectionShape } from '../structural/sectionCatalog.js';

const COLUMN_SIZE_MM = 120; // sectionDefId が断面マスターに無い場合の固定サイズ矩形の辺長

// H形鋼の断面プロファイル（フランジ2本+ウェブ1本）を独立した矩形3つのSVGパスとして表す。
function hSectionPathD(width, height, flangeT, webT) {
  const hw = width / 2, hh = height / 2;
  return [
    `M ${-hw} ${-hh} h ${width} v ${flangeT} h ${-width} Z`,
    `M ${-hw} ${hh - flangeT} h ${width} v ${flangeT} h ${-width} Z`,
    `M ${-webT / 2} ${-hh} h ${webT} v ${height} h ${-webT} Z`,
  ].join(' ');
}

// 柱の実形状シンボル（構造モードの ColumnsLayer で使用）。
// sectionDefId が断面マスターに無い場合は固定サイズ矩形にフォールバック。
// outline=true（STANDARD LOD）のとき中実断面（木角材・RC矩形/丸・H形）は塗りなし＋輪郭線で描く。
// 中空断面（角形鋼管・丸形鋼管）は元々塗りが無いため outline の影響を受けない。
//
// observer でラップするのは、通り芯スナップ移動中に column.x/column.y（verticalCL/horizontalCL の
// effectiveValue＝pendingDelta 経由で変化する computed）を再描画に反映させるため。親の ColumnsLayer は
// graph.columns 配列しか購読しておらず、座標の読み取りはこの子で起きるため observer がないと追従しない。
export const ColumnSymbol = observer(function ColumnSymbol({ column, color, outline = false, outlineStrokeWidth }) {
  const sec = findSectionEntry(column.sectionDefId);
  // 中実断面の塗り/輪郭線。outline時は塗りを外し、代わりに輪郭線を描く。
  const solidFill   = outline ? undefined : color;
  const solidStroke = outline ? color : undefined;
  if (!sec) {
    return (
      <Rect
        x={column.x} y={column.y}
        width={COLUMN_SIZE_MM} height={COLUMN_SIZE_MM}
        offsetX={COLUMN_SIZE_MM / 2} offsetY={COLUMN_SIZE_MM / 2}
        rotation={column.rotation}
        fill={solidFill} stroke={solidStroke} strokeWidth={outlineStrokeWidth}
        listening={false}
      />
    );
  }
  const { shape, width, height } = sec;
  if (shape === SectionShape.ROUND_PIPE || shape === SectionShape.ROUND) {
    const isSolid = shape === SectionShape.ROUND; // RC丸柱=中実、丸形鋼管=中空
    return (
      <Circle
        x={column.x} y={column.y} radius={width / 2}
        fill={isSolid ? solidFill : undefined}
        stroke={isSolid ? solidStroke : color}
        strokeWidth={isSolid ? (outline ? outlineStrokeWidth : 0) : width * 0.08}
        listening={false}
      />
    );
  }
  if (shape === SectionShape.SQUARE_PIPE) {
    return (
      <Rect
        x={column.x} y={column.y}
        width={width} height={height}
        offsetX={width / 2} offsetY={height / 2}
        rotation={column.rotation}
        stroke={color} strokeWidth={width * 0.08}
        listening={false}
      />
    );
  }
  if (shape === SectionShape.H_SECTION) {
    const flangeT = sec.flangeThickness ?? height * 0.1;
    const webT = sec.webThickness ?? width * 0.1;
    return (
      <Path
        x={column.x} y={column.y}
        rotation={column.rotation}
        data={hSectionPathD(width, height, flangeT, webT)}
        fill={solidFill} stroke={solidStroke} strokeWidth={outlineStrokeWidth}
        listening={false}
      />
    );
  }
  // RECT（木造・RC矩形）
  return (
    <Rect
      x={column.x} y={column.y}
      width={width} height={height}
      offsetX={width / 2} offsetY={height / 2}
      rotation={column.rotation}
      fill={solidFill} stroke={solidStroke} strokeWidth={outlineStrokeWidth}
      listening={false}
    />
  );
});
