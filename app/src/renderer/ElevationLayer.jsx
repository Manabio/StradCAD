import { observer } from 'mobx-react-lite';
import { Group, Text } from 'react-konva';
import { viewport } from '../appViewport.js';
import { scaleLabel } from '../structural/sectionFigure/sectionGeometry.js';
import { makeElevationTransform, bandContentOriginMm } from '../elevation/elevationLayout.js';
import { renderFigurePrimitives } from './figurePrimitivesKonva.jsx';

// ================================================================
// 展開モードの描画本体。mode.scale/mode.layout（=ElevationModeState、固定倍率・帯レイアウト）
// だけを見て描く。viewport.scaleX/offsetX は一切参照しない（ズームなし・平面へ戻ると元のビュー
// のまま、という展開モードの不変条件）。lineWeightsPx（校正値ベースの固定px）だけは
// viewport から借りる（ズーム非依存の値のため。.claude/elevation-model.md §8.3）。
// ================================================================
// onOpeningClick: QA項目3。展開図の建具記号丸クリックで呼ぶ（openingIdを渡す。App.jsxが
// mode.selectOpening(id)へつなぎ、建具リストパネルを開いて選択状態にする）。
export const ElevationLayer = observer(({ mode, size, onOpeningClick }) => {
  if (!mode || mode.loading || !size) return null;

  const scale = mode.scale;
  if (!(scale > 0)) return null;
  const viewHeightMm = size.height / scale;
  const placements = mode.visibleBands(viewHeightMm);
  const bandsById = new Map(mode.bands.map(b => [b.roomId, b]));
  const screenPxPerMm = (viewport.pxPerMmX + viewport.pxPerMmY) / 2;

  return (
    <>
      {placements.map((pl, i) => {
        const band = bandsById.get(pl.roomId);
        if (!band) return null;
        const faceOffsetMm = mode.faceOffsetFor(band);
        // originPxY: 帯のプリミティブ座標(y=0=床線)が画面mm空間のどこに来るか。placement.topMmを
        // そのままy=0へ対応させると天井線・壁材ラベルが画面外へはみ出す（QA F1）ため、
        // 帯の実描画範囲(band.bounds.minY..maxY)の上端をtopMmへ合わせる。
        const originMmY = bandContentOriginMm(pl, band);
        const t = makeElevationTransform(scale, -faceOffsetMm * scale, originMmY * scale);
        const renderOpts = { lineWeightsPx: viewport.lineWeightsPx, screenPxPerMm, onTagClick: onOpeningClick };
        // 建具ドラッグ中のプレビュー（ElevationModeState.setOpeningDragPreview）: 帯は再構築せず、
        // その建具のプリミティブ（openingId 付き）だけを別 Group に分け、帯ローカルxの移動量ぶん
        // px でずらして描く。確定時に refOffset が書かれて帯が再構築され、プレビューは消える。
        const preview = mode.openingDragPreview;
        const moving = preview ? band.primitives.filter(p => p.openingId === preview.openingId) : [];
        const still  = moving.length ? band.primitives.filter(p => p.openingId !== preview.openingId) : band.primitives;
        return (
          <Group key={`${pl.roomId}-${i}`}>
            {renderFigurePrimitives(still, t, renderOpts)}
            {moving.length > 0 && (
              <Group x={preview.dxLocalMm * scale}>
                {renderFigurePrimitives(moving, t, renderOpts)}
              </Group>
            )}
          </Group>
        );
      })}
      <Text
        x={size.width - 70} y={size.height - 26}
        text={scaleLabel(scale)} fontSize={13} fill="#64748b" listening={false}
      />
    </>
  );
});
