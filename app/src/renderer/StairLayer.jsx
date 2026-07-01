import { observer } from 'mobx-react-lite';
import { Group, Line, Text, Rect, Circle, Arrow } from 'react-konva';
import { buildStairGeometry } from '../finish/stair/stairGeometry.js';

const STAIR_STROKE = '#1e293b';

/**
 * 階段を描画する。entries は描画用に解決済みの配列:
 *   { id, stair, bounds:{x1,y1,x2,y2}, riser:number|null, view:'install'|'upper', selectable:boolean }
 * install/upper の両ビュー（設置階・設置上階）を同じ経路で描く。
 * bounds は呼び出し側でワールド座標に解決済みのため、上階（peek した非アクティブ階）でも描ける。
 */
export const StairLayer = observer(({
  entries = [],
  viewport,
  detail = false,
  selectedStairId = null,
  onSelectStair = null,
}) => {
  const px = (w) => w / viewport.scaleX; // ズーム非依存の線幅

  const groups = entries.map((e) => {
    const { id, stair, bounds: b, riser, view, selectable } = e;
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || b.x2 <= b.x1 || b.y2 <= b.y1) {
      return null;
    }
    const geom = buildStairGeometry(stair, b, { view, detail, riser });
    const isSel = id === selectedStairId;

    const lineProps = { stroke: STAIR_STROKE, strokeWidth: px(1.5), listening: false };
    // 踏み面は線種の共通定義（LINE_WEIGHT_MM）の thin を参照する
    const treads = geom.treads.map((s, i) => (
      <Line key={`t${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps} stroke="#000000" strokeWidth={viewport.lineWeightsPx.thin} />
    ));
    const outline = geom.outline.map((s, i) => (
      <Line
        key={`o${i}`}
        points={[s.x1, s.y1, s.x2, s.y2]}
        {...lineProps}
        strokeWidth={px(2)}
        dash={s.dashed ? [px(40), px(30)] : undefined}
      />
    ));
    const breakLine = (geom.breakLine ?? []).map((s, i) => (
      <Line key={`b${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps} />
    ));
    const arrows = (geom.arrows ?? []).map((a, i) => (
      <Group key={`a${i}`}>
        {/* 始点: 寸法線と同じ塗り丸 */}
        <Circle x={a.x1} y={a.y1} radius={px(2)} fill={STAIR_STROKE} listening={false} />
        {/* 終点に矢じり（points があれば折れ線U字矢印） */}
        <Arrow
          points={a.points ?? [a.x1, a.y1, a.x2, a.y2]}
          stroke={STAIR_STROKE} fill={STAIR_STROKE} strokeWidth={px(1.5)}
          pointerLength={px(10)} pointerWidth={px(8)} listening={false}
        />
        {a.label && (
          <Text
            x={a.labelX} y={a.labelY}
            text={a.label} fontSize={200}
            fill={STAIR_STROKE} offsetX={60} offsetY={100} listening={false}
          />
        )}
      </Group>
    ));
    const stepNumbers = geom.stepNumbers.map((n, i) => (
      <Text
        key={`n${i}`}
        x={n.x} y={n.y} text={n.text} fontSize={120}
        fill={STAIR_STROKE} offsetX={40} offsetY={60} listening={false}
      />
    ));

    return (
      <Group key={`${view}:${id}`}>
        {selectable && onSelectStair && (
          <Rect
            x={b.x1} y={b.y1}
            width={b.x2 - b.x1} height={b.y2 - b.y1}
            fill={isSel ? 'rgba(37,99,235,0.10)' : 'transparent'}
            stroke={isSel ? '#2563eb' : 'transparent'}
            strokeWidth={isSel ? px(2) : 0}
            onClick={() => onSelectStair(id)}
            onTap={() => onSelectStair(id)}
          />
        )}
        {treads}
        {outline}
        {breakLine}
        {arrows}
        {stepNumbers}
      </Group>
    );
  });

  return <Group>{groups}</Group>;
});
