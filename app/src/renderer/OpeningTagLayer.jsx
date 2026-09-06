import { observer } from 'mobx-react-lite';
import { Group, Circle, Line, Text } from 'react-konva';
import { shouldShowOpeningTags, layoutOpeningTags } from '../openings/openingTagPlacement.js';
import { openingTagPartsOf } from '../openings/openingNumbering.js';

// 記号丸のスクリーン上サイズ(px)。ズーム非依存で常にこの見た目サイズになる
// （RoomLabelsLayer.jsx / MemberTagLayer.jsx と同じ「fontSize等をscaleXで逆補正」方式）。
const TAG_RADIUS_PX    = 16;
const TAG_FONT_SIZE_PX = 11;
const TAG_GAP_PX       = 4; // 丸同士・丸と壁の最低間隔（格子探索のピッチにも使う）

// 選択中の建具の表示は「建具ターゲット（記号丸）自身を選択状態にする」方式に一本化する
// （ユーザー指示2026-09。旧: renderer/OpeningsLayer.jsx が開口を囲む水色の矩形を重ねていた）。
// 変えるのは丸（塗り＝薄い水色／輪郭＝水色でやや太）だけ——直径横線の太さ、記号名／採番の
// 文字色は非選択時のまま（ユーザー指示2026-09）。塗りを不透明にするのは、半透明にすると下の
// 壁線・扉線が透けて記号が読みにくくなるため。輪郭の「やや太」は4段階の太さ表で1段上げた値
// （medium→thick）を使い、独自の倍率を持ち込まない（viewport.js resolveLineWeightsPx）。
const TAG_SELECTED_FILL   = '#dbeafe'; // 薄い水色（gutterPrimitives.jsx の帯と同じ）
const TAG_SELECTED_STROKE = '#2563eb'; // 水色（アプリ共通の選択色。SnapIndicator・階段の選択枠と同じ）
const TAG_FILL            = '#fff';

// 記号丸1件分: 円＋直径横線＋上段(記号)/下段(採番)テキスト。回転は一切かけない（常に正対）。
// クリックで建具モードへ遷移・該当建具を選択する（onSelect経由）。
const OpeningTag = observer(({ x, y, radius, fontSize, stroke, strokeWidth, fill, ringStroke, ringStrokeWidth, symbol, number, onSelect }) => {
  // 文字と直径横線の離れ（＝文字ボックスの端から横線までの隙間）。上下半円の中央に文字を置く
  // （＝離れ (radius-fontSize)/2）より詰め、その半分にする（ユーザー指示2026-09。上下とも同じ）。
  // 文字ボックスは高さfontSizeで横線から gap だけ離す——半円の高さいっぱいの箱に
  // verticalAlign:'middle' で置く旧方式だと、離れが半径と字高だけで決まり調整点が無かった。
  const gap = Math.max(0, (radius - fontSize) / 4);
  return (
  <Group x={x} y={y}>
    <Circle
      radius={radius}
      fill={fill}
      stroke={ringStroke}
      strokeWidth={ringStrokeWidth}
      strokeScaleEnabled={false}
      onClick={onSelect}
      onTap={onSelect}
      onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
      onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
      listening
    />
    <Line
      points={[-radius, 0, radius, 0]}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeScaleEnabled={false}
      listening={false}
    />
    <Text
      x={-radius} y={-(gap + fontSize)} width={radius * 2} height={fontSize}
      align="center" verticalAlign="middle"
      text={symbol}
      fontSize={fontSize}
      fill={stroke}
      listening={false}
    />
    <Text
      x={-radius} y={gap} width={radius * 2} height={fontSize}
      align="center" verticalAlign="middle"
      text={number ?? ''}
      fontSize={fontSize}
      fill={stroke}
      listening={false}
    />
  </Group>
  );
});

/**
 * 建具記号丸（円に直径横線・上段記号／下段採番）レイヤー。
 * 平面モードDETAIL LOD・建具モードSTANDARD/DETAIL LODでのみ表示する（shouldShowOpeningTags）。
 * 配置計算（アンカー・円弧反転・重なり回避）は純モジュール openings/openingTagPlacement.js に
 * 委ね、ここでは viewport 由来の px→mm 換算と Konva 描画・クリック配線のみを行う。
 */
export const OpeningTagLayer = observer(({ graph, project, viewport, appMode, selectedId = null, onSelectOpening }) => {
  if (!graph) return null;
  if (!shouldShowOpeningTags(appMode, viewport.lodLevel)) return null;
  if (graph.openings.length === 0) return null;

  const radiusMm = TAG_RADIUS_PX / viewport.scaleX;
  const gapMm    = TAG_GAP_PX / viewport.scaleX;
  const stepMm   = 2 * radiusMm + gapMm;
  const fontSize = TAG_FONT_SIZE_PX / viewport.scaleX;
  const strokeWidth = viewport.lineWeightsPx.medium;

  const placements = layoutOpeningTags(graph, { radiusMm, gapMm, stepMm });

  return placements.map((p) => {
    const { symbol, number } = openingTagPartsOf(p.opening, project);
    const isSelected = p.openingId === selectedId;
    return (
      <OpeningTag
        key={p.openingId}
        x={p.x} y={p.y}
        radius={radiusMm}
        fontSize={fontSize}
        stroke={p.opening.color}
        strokeWidth={strokeWidth}
        fill={isSelected ? TAG_SELECTED_FILL : TAG_FILL}
        ringStroke={isSelected ? TAG_SELECTED_STROKE : p.opening.color}
        ringStrokeWidth={isSelected ? viewport.lineWeightsPx.thick : strokeWidth}
        symbol={symbol}
        number={number}
        onSelect={() => onSelectOpening(p.openingId)}
      />
    );
  });
});
