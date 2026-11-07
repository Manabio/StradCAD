import { observer } from 'mobx-react-lite';
import { Line, Circle, Group, Text, Rect } from 'react-konva';
import {
  rectEdges, rectEdge, computeOutlinePieces, computeOutlineCorners, computeInnerEdgeSpans,
} from '../site/siteRectGeometry.js';
import { computeRectPreview, RECT_ANCHOR_NODE_NAME } from '../site/siteRectInput.js';
import {
  SITE_LINE_COLOR, SITE_BOUNDARY_DASH, SITE_CORNER_MARK_RADIUS_PX, SITE_CORNER_MARK_WEIGHT,
  siteLineWeightKey,
} from '../site/siteLineStyle.js';
import { lineHitWidth, HIT_PX_MAX } from './SiteLinesLayer.jsx';

// 敷地モードの長方形（.claude/data-model.md「敷地の長方形入力」節）。
// 線の描画規則は site/siteLineStyle.js（三斜と共通）: 内側の辺＝細線・実線、外周片＝中線・一点鎖線、
// 色は黒、選択辺は幅を1段上げる。外周の角に小さな丸。＋選択中の共有辺の基点の丸＋番号バッジ＋入力中のプレビュー。
// 辺の当たりは subMode==='rect' のときだけ listening（透明の当たり線を辺全体に敷く）。
export const SiteRectsLayer = observer(({ site, mode, viewport, onSelectRectEdge }) => {
  const rects   = site.rects;
  const rectMode = mode.subMode === 'rect';
  const sel     = mode.selectedRectEdge;
  const r       = 4  / viewport.scaleX; // 端点丸の半径（SiteLinesLayer と同じ式）
  const badgeR  = 10 / viewport.scaleX;
  const sw      = viewport.lineWeightsPx.medium / viewport.scaleX;
  const badgeFs = 9  / viewport.scaleX;

  const markR   = SITE_CORNER_MARK_RADIUS_PX / viewport.scaleX;
  const pieces  = computeOutlinePieces(rects);
  const spans   = computeInnerEdgeSpans(rects, pieces);
  const corners = computeOutlineCorners(pieces);
  const isSelEdge = (rectId, side) => sel?.rectId === rectId && sel.side === side;
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
      {/* 内側の辺（細線・実線。選択中は1段上げ） */}
      {spans.map((s, i) => (
        <Line
          key={`i-${s.rectId}-${s.side}-${i}`}
          points={[s.a.x, s.a.y, s.b.x, s.b.y]}
          stroke={SITE_LINE_COLOR}
          strokeWidth={viewport.lineWeightsPx[siteLineWeightKey(false, isSelEdge(s.rectId, s.side))]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}

      {/* 外周片（中線・一点鎖線。選択中は1段上げ。隣地／道路は描画上同じ） */}
      {pieces.map((p, i) => (
        <Line
          key={`o-${p.rectId}-${p.side}-${i}`}
          points={[p.a.x, p.a.y, p.b.x, p.b.y]}
          stroke={SITE_LINE_COLOR}
          strokeWidth={viewport.lineWeightsPx[siteLineWeightKey(true, p.owners.some(o => isSelEdge(o.rectId, o.side)))]}
          dash={[...SITE_BOUNDARY_DASH]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}

      {/* 外周の角の丸 */}
      {corners.map((c, i) => (
        <Circle
          key={`c-${i}`}
          x={c.x} y={c.y}
          radius={markR}
          stroke={SITE_LINE_COLOR}
          strokeWidth={viewport.lineWeightsPx[SITE_CORNER_MARK_WEIGHT]}
          strokeScaleEnabled={false}
          listening={false}
        />
      ))}

      {/* 辺の当たり（各長方形の4辺全体に透明の線を敷く。rect サブモードのみ listening） */}
      {rectMode && rects.flatMap(rect => rectEdges(rect).map(edge => {
        const len = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
        return (
          <Line
            key={`h-${rect.id}-${edge.side}`}
            points={[edge.a.x, edge.a.y, edge.b.x, edge.b.y]}
            stroke="transparent"
            strokeWidth={1}
            strokeScaleEnabled={false}
            hitStrokeWidth={lineHitWidth({ length: len }, viewport)}
            onClick={() => onSelectRectEdge?.(rect.id, edge.side)}
            onTap={() => onSelectRectEdge?.(rect.id, edge.side)}
            onMouseEnter={e => { e.target.getStage().container().style.cursor = 'pointer'; }}
            onMouseLeave={e => { e.target.getStage().container().style.cursor = 'default'; }}
          />
        );
      }))}

      {/* 選択中の共有辺の基点（赤）・他端（青） */}
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
