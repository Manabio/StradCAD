import { observer } from 'mobx-react-lite';
import { Rect, Circle, Path, Group, Line } from 'react-konva';
import { findSectionEntry, SectionShape } from '../structural/sectionCatalog.js';
import { COLUMN_FALLBACK_SIZE_MM, columnSectionSize, columnCrossPointsLocal } from '../structural/framingDrawing.js';

// H形鋼の断面プロファイル（フランジ2本+ウェブ1本）を独立した矩形3つのSVGパスとして表す。
function hSectionPathD(width, height, flangeT, webT) {
  const hw = width / 2, hh = height / 2;
  return [
    `M ${-hw} ${-hh} h ${width} v ${flangeT} h ${-width} Z`,
    `M ${-hw} ${hh - flangeT} h ${width} v ${flangeT} h ${-width} Z`,
    `M ${-webT / 2} ${-hh} h ${webT} v ${height} h ${-webT} Z`,
  ].join(' ');
}

// hitProps（既定 DEFAULT_HIT_PROPS＝{ listening: false }）は柱タップ（renderer/StructuralLayer.jsx
// ColumnsLayer の pick=true時のみ）が当たり判定props（listening/fillEnabled/hitStrokeWidth）を
// 差し込むための素通し口。既定値のときは従来の listening={false} と完全に同じ——柱記号の他の呼び出し元
// （平面・伏図の非在来）は一切変わらない。モジュールスコープ定数にするのは、唯一の呼び出し元
// （renderer/StructuralLayer.jsx ColumnsLayer）が常に明示的にhitPropsを渡すため通常は素通りするが、
// 将来hitProps省略で呼ぶ経路が増えても毎レンダー新規オブジェクトを作らないようにするため（QA指摘6。
// ColumnSymbolはobserver＝mobx-react-liteが内部でReact.memoを使うため、参照の変わるpropsはmemoを壊す）。
const DEFAULT_HIT_PROPS = { listening: false };

// 柱の実形状シンボル（構造モードの ColumnsLayer で使用）。
// sectionDefId が断面マスターに無い場合は固定サイズ矩形にフォールバック。
// outline=true（STANDARD LOD）のとき中実断面（木角材・RC矩形/丸・H形）は塗りなし＋輪郭線で描く。
// 中空断面（角形鋼管・丸形鋼管）は元々塗りが無いため outline の影響を受けない。
//
// observer でラップするのは、通り芯スナップ移動中に column.x/column.y（verticalCL/horizontalCL の
// effectiveValue＝pendingDelta 経由で変化する computed）を再描画に反映させるため。親の ColumnsLayer は
// graph.columns 配列しか購読しておらず、座標の読み取りはこの子で起きるため observer がないと追従しない。
export const ColumnSymbol = observer(function ColumnSymbol({ column, color, outline = false, outlineStrokeWidth, hitProps = DEFAULT_HIT_PROPS }) {
  const sec = findSectionEntry(column.sectionDefId);
  // 中実断面の塗り/輪郭線。outline時は塗りを外し、代わりに輪郭線を描く。
  const solidFill   = outline ? undefined : color;
  const solidStroke = outline ? color : undefined;
  if (!sec) {
    return (
      <Rect
        x={column.x} y={column.y}
        width={COLUMN_FALLBACK_SIZE_MM} height={COLUMN_FALLBACK_SIZE_MM}
        offsetX={COLUMN_FALLBACK_SIZE_MM / 2} offsetY={COLUMN_FALLBACK_SIZE_MM / 2}
        rotation={column.rotation}
        fill={solidFill} stroke={solidStroke} strokeWidth={outlineStrokeWidth}
        {...hitProps}
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
        {...hitProps}
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
        {...hitProps}
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
        {...hitProps}
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
      {...hitProps}
    />
  );
});

// 下階柱の伏図記号「×」（断面□に乗せる対角線2本。在来木造の framingColumnSymbol:'crossBox' 専用）
// と、平面図（詳細LOD）の柱の由来×（renderer/originColorKey.js columnOriginMarkKey。柱の由来別
// 色分け ステップ3）の共用コンポーネント。
// 断面外形は columnSectionSize（カタログ未登録は120角フォールバック）、対角線座標は columnCrossPointsLocal
// （structural/framingDrawing.js。純関数側に幾何を集約し、ここは Konva 要素へ写すだけ）。
// overhangRatio（省略時は columnCrossPointsLocal の既定＝COLUMN_CROSS_OVERHANG_RATIO=1.5）は
// ×の端点が断面□の四隅から何倍はみ出すか——伏図の下階柱×は従来どおり1.5（挙動不変）、平面図の
// 由来×は overhangRatio={1}（断面の四隅ちょうどまで）を呼び出し側が明示する。
// observer にする理由は ColumnSymbol と同じ（通り芯スナップ移動中の column.x/y は computed。
// 座標の読み取りは子で起こす）。
export const ColumnCrossMark = observer(function ColumnCrossMark({ column, color, strokeWidth, overhangRatio }) {
  const { width, height } = columnSectionSize(column);
  return (
    <Group x={column.x} y={column.y} rotation={column.rotation}>
      {columnCrossPointsLocal(width, height, overhangRatio).map((points, i) => (
        <Line key={i} points={points} stroke={color} strokeWidth={strokeWidth} listening={false} />
      ))}
    </Group>
  );
});
