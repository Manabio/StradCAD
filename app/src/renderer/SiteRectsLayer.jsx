import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text, Rect } from 'react-konva';
import { SiteLineKind } from '@core';
import { rectEdges, rectEdge, computeOutlineSegments } from '../site/siteRectGeometry.js';
import { computeRectPreview, RECT_ANCHOR_NODE_NAME } from '../site/siteRectInput.js';
import { KIND_COLOR, SITE_SELECTED_COLOR, lineHitWidth, HIT_PX_MAX } from './SiteLinesLayer.jsx';

// 敷地モードの長方形（.claude/data-model.md「敷地の長方形入力」節）。
// 4辺（内側色）＋導出した外周（境界色）＋選択中の共有辺・基点の丸＋番号バッジ＋入力中のプレビュー。
// 辺は subMode==='rect' のときだけ listening。
export const SiteRectsLayer = observer(({ site, mode, viewport, onSelectRectEdge }) => {
  const rects   = site.rects;
  const rectMode = mode.subMode === 'rect';
  const sel     = mode.selectedRectEdge;
  const r       = 4  / viewport.scaleX; // 端点丸の半径（SiteLinesLayer と同じ式）
  const badgeR  = 10 / viewport.scaleX;
  const sw      = viewport.lineWeightsPx.medium / viewport.scaleX;
  const badgeFs = 9  / viewport.scaleX;

  const outline = computeOutlineSegments(rects);
  const preview = computeRectPreview(site.rectMap, sel, mode.rectAnchor, mode.rectInputState);

  const selRect = sel ? site.rectMap.get(sel.rectId) : null;
  const selEdge = selRect ? rectEdge(selRect, sel.side) : null;
  const anchorPt = selEdge ? (mode.rectAnchor === 'a' ? selEdge.a : selEdge.b) : null;
  const otherPt  = selEdge ? (mode.rectAnchor === 'a' ? selEdge.b : selEdge.a) : null;
  // 辺の当たり幅の上限と同じ値。選択辺の端点付近で直交辺を押せなくならない大きさ
  const hitW = HIT_PX_MAX / viewport.scaleX;

  const anchorCircle = (key, pt, fill) => (
    <Circle
      key={key}
      name={RECT_ANCHOR_NODE_NAME}
      x={pt.x} y={pt.y}
      radius={r}
      fill={fill}
      stroke="transparent"
      strokeWidth={hitW}
      listening={rectMode}
      onClick={() => mode.toggleRectAnchor()}
      onTap={() => mode.toggleRectAnchor()}
    />
  );

  return (
    <>
      {/* 各長方形の4辺（内側色。選択中の辺は選択色） */}
      {rects.flatMap(rect => rectEdges(rect).map(edge => {
        const isSel = sel?.rectId === rect.id && sel.side === edge.side;
        const len = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
        return (
          <Line
            key={`e-${rect.id}-${edge.side}`}
            points={[edge.a.x, edge.a.y, edge.b.x, edge.b.y]}
            stroke={isSel ? SITE_SELECTED_COLOR : KIND_COLOR[SiteLineKind.OTHER]}
            strokeWidth={viewport.lineWeightsPx.thin}
            strokeScaleEnabled={false}
            hitStrokeWidth={lineHitWidth({ length: len }, viewport)}
            listening={rectMode}
            onClick={() => onSelectRectEdge?.(rect.id, edge.side)}
            onTap={() => onSelectRectEdge?.(rect.id, edge.side)}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          />
        );
      }))}

      {/* 外周（長方形の和集合の外形＝境界線） */}
      {outline.map((s, i) => (
        <Line
          key={`o-${i}`}
          points={[s.a.x, s.a.y, s.b.x, s.b.y]}
          stroke={KIND_COLOR[SiteLineKind.BOUNDARY]}
          strokeWidth={viewport.lineWeightsPx.thick}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}

      {/* 選択中の共有辺（外周の上に選択色で重ねる）＋基点（赤）・他端（青） */}
      {selEdge && (
        <Line
          points={[selEdge.a.x, selEdge.a.y, selEdge.b.x, selEdge.b.y]}
          stroke={SITE_SELECTED_COLOR}
          strokeWidth={viewport.lineWeightsPx.thick}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
      {selEdge && anchorCircle('anchor', anchorPt, '#ef4444')}
      {selEdge && anchorCircle('other', otherPt, '#3b82f6')}

      {/* 番号バッジ（長方形の中心。三角形バッジと同じ見え方） */}
      {rects.map((rect, i) => (
        <Group key={`rb-${rect.id}`} x={rect.x + rect.w / 2} y={rect.y + rect.h / 2} listening={false}>
          <Circle radius={badgeR} fill="white" stroke="#334155" strokeWidth={sw} />
          <Text
            text={String(i + 1)}
            fontSize={badgeFs}
            fill="#334155"
            align="center"
            verticalAlign="middle"
            width={badgeR * 2}
            height={badgeR * 2}
            offsetX={badgeR}
            offsetY={badgeR}
          />
        </Group>
      ))}

      {/* 入力中の長方形のプレビュー（SiteDrawPreview と同じ破線オレンジ） */}
      {preview && (
        <Rect
          x={preview.x} y={preview.y} width={preview.w} height={preview.h}
          stroke="#f97316"
          strokeWidth={2}
          dash={[8, 4]}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
    </>
  );
});
