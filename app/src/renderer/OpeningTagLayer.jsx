import { observer } from 'mobx-react-lite';
import { Group, Circle, Line, Text } from 'react-konva';
import { shouldShowOpeningTags, layoutOpeningTags } from '../openings/openingTagPlacement.js';
import { openingTagPartsOf } from '../openings/openingNumbering.js';

// 記号丸のスクリーン上サイズ(px)。ズーム非依存で常にこの見た目サイズになる
// （RoomLabelsLayer.jsx / MemberTagLayer.jsx と同じ「fontSize等をscaleXで逆補正」方式）。
const TAG_RADIUS_PX    = 16;
const TAG_FONT_SIZE_PX = 11;
const TAG_GAP_PX       = 4; // 丸同士・丸と壁の最低間隔（格子探索のピッチにも使う）

// 記号丸1件分: 円＋直径横線＋上段(記号)/下段(採番)テキスト。回転は一切かけない（常に正対）。
// クリックで建具モードへ遷移・該当建具を選択する（onSelect経由）。
const OpeningTag = observer(({ x, y, radius, fontSize, stroke, strokeWidth, symbol, number, onSelect }) => (
  <Group x={x} y={y}>
    <Circle
      radius={radius}
      fill="#fff"
      stroke={stroke}
      strokeWidth={strokeWidth}
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
      x={-radius} y={-radius} width={radius * 2} height={radius}
      align="center" verticalAlign="middle"
      text={symbol}
      fontSize={fontSize}
      fill={stroke}
      listening={false}
    />
    <Text
      x={-radius} y={0} width={radius * 2} height={radius}
      align="center" verticalAlign="middle"
      text={number ?? ''}
      fontSize={fontSize}
      fill={stroke}
      listening={false}
    />
  </Group>
));

/**
 * 建具記号丸（円に直径横線・上段記号／下段採番）レイヤー。
 * 平面モードDETAIL LOD・建具モードSTANDARD/DETAIL LODでのみ表示する（shouldShowOpeningTags）。
 * 配置計算（アンカー・円弧反転・重なり回避）は純モジュール openings/openingTagPlacement.js に
 * 委ね、ここでは viewport 由来の px→mm 換算と Konva 描画・クリック配線のみを行う。
 */
export const OpeningTagLayer = observer(({ graph, project, viewport, appMode, onSelectOpening }) => {
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
    return (
      <OpeningTag
        key={p.openingId}
        x={p.x} y={p.y}
        radius={radiusMm}
        fontSize={fontSize}
        stroke={p.opening.color}
        strokeWidth={strokeWidth}
        symbol={symbol}
        number={number}
        onSelect={() => onSelectOpening(p.openingId)}
      />
    );
  });
});
