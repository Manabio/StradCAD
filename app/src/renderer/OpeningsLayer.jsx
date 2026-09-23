import { Fragment } from 'react';
import { observer } from 'mobx-react-lite';
import { Group, Line, Rect, Path } from 'react-konva';

// 建具記号の線分のヒット幅（画面px。壁ラジアルの WALL_THRESHOLD_PX と同じ8px）
const OPENING_HIT_PX = 8;
import { buildHostWallByOpening, wallFaceRange } from '../openings/openingGeometry.js';
import { openingExteriorDir } from '../openings/openingPlanSymbolGeometry.js';
import { graphComputed } from './graphDerived.js';
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { arcPathD } from './ShapesLayer.jsx';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { buildOpeningPlanSymbol } from '../openings/openingPlanSymbol.js';

// 選択中の建具の表示は「建具ターゲット（記号丸）自身を選択状態にする」方式に一本化する
// （ユーザー指示2026-09。旧: 開口を囲む水色の矩形を重ねていた——図面に無い線が増える上、
// タップ対象である記号丸と選択表示が別物になっていた）。renderer/OpeningTagLayer.jsx 参照。
//
// ステップ11「作図P2」（2026-09-23・11a〜11e）: 平面記号の判断（LOD・機構・枠種別・線幅の役割・
// 回転中心・内法区間）はすべて openings/openingPlanSymbol.js（純関数）へ移した。このコンポーネント
// はhost壁・面線・entryを引いてctxを組み、buildOpeningPlanSymbolが返すプリミティブ列を
// renderPlanPrimitiveでKonva要素へ機械的に変換するだけ（判断は持たない。詳細は
// .claude/opening-model.md 参照）。
export const OpeningsLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const { scaleX, scaleY, lodLevel } = viewport;

  // 開口ごとのホスト壁は graph が変わらない限り同じ——パン・ズームの再レンダーで
  // 引き直さないよう graph 単位にキャッシュする（graphDerived.js）。
  const hostByOpening = graphComputed(graph, 'hostWallByOpening', () => buildHostWallByOpening(graph));

  // 壁面線(faceLo/faceHi)は略図LOD以外で引く。詳細LODの見込帯だけでなく、蝶番系の回転中心
  // （＝扉が開く側の壁面。planSymbolPlan）が一般LODでも面線を要るため——一般LODでも壁は
  // 面線＋材の厚みで描かれるので、回転中心を叩いた面に固定したままだと「開く方向反転」後に
  // 扉が壁を貫く。略図LODは扉記号自体を描かない（ティックのみ）ため不要。
  // wallFaceRange→findCounterpartWallはgraph.wallsの
  // 線形探索（O(壁数)）のため、開口ごとに毎回呼ぶとO(開口数×壁数)になる（F6）。ホスト壁が
  // 同じ複数開口（1本の壁に窓が並ぶ等）で重複計算しないよう、ホスト壁の id 単位で1回だけ計算し
  // graph 単位にキャッシュする（hostByOpeningと同じ graphComputed パターン。実装方針9）。
  //
  // 注意（graphDerived.js の規約）: compute は自身の実行中に読んだobservable/computedだけを
  // 依存として登録する。外側の変数（上のhostByOpening）をクロージャで捕まえるだけだと、
  // その参照はこのcomputedが最初に作られた時点のものに固定され、graph.openingsが変わって
  // hostWallByOpeningが再計算されても（graph.wallsが変わらない限り）このcomputedは無効化
  // されない——`wallFaceRange`がgraph.wallsを読むために"たまたま"連動していただけの壊れやすい
  // 依存だった。compute内で`graphComputed(graph, 'hostWallByOpening', ...)`を呼び直し、
  // その場でhostWallByOpening computedを`.get()`することで、MobXのcomputed同士の依存追跡に
  // 正しく乗せる（computed-observes-computedはMobXの標準パターン）。
  const faceRangeByHostId = lodLevel !== LodLevel.SCHEMATIC
    ? graphComputed(graph, 'wallFaceRangeByHostId', () => {
        const hosts = graphComputed(graph, 'hostWallByOpening', () => buildHostWallByOpening(graph));
        const map = new Map();
        for (const host of hosts.values()) {
          if (!map.has(host.id)) map.set(host.id, wallFaceRange(host, graph));
        }
        return map;
      })
    : null;

  // 建具ドラッグ（interaction/usePointerInteraction.js）の起点にするため、建具1件の記号線分を
  // name='opening-symbol'・openingId 属性の Group で包み、線分自体にヒット幅（画面8px相当）を持たせる。
  // fillEnabled:false は必須——Konva のヒットキャンバスは fill の値（このレイヤは全て transparent）に
  // 関係なく fillEnabled（既定 true）なら図形内部を塗るため、これが無いと動作弧の扇形・見込帯の内部が
  // 丸ごとヒット域になり、扇形の内側からのパンが建具移動になる（QA指摘 2026-09-14）。
  // 押下側は e.target.findAncestor('.opening-symbol') で openingId を引く（記号丸は OpeningTagLayer の
  // Circle に直接 openingId 属性）。クリックハンドラは付けない——選択は従来どおり pointerUp 側の
  // nearOpening 判定と記号丸クリックが担う。
  const hitStrokeWidth = OPENING_HIT_PX / Math.min(scaleX, scaleY);
  // ホバー時のカーソルは記号丸（OpeningTagLayer.jsx）・部材タグ等と同じ「container.style.cursor を直接書く」
  // 流儀（ユーザー指示 2026-09-14）。App.jsx の cursor 算出（nearOpening 等）は壁線近傍しか見ないため、
  // 壁から離れた動作弧などは Konva のホバーで補う。
  const setCursor = (e, cursor) => { e.target.getStage().container().style.cursor = cursor; };

  // openings/openingPlanSymbol.js の PlanPrimitive 1件をKonva要素へ機械的に変換する
  // （判断は持たない。太さの解決＝weightMm→strokeWidthだけがここの仕事）。
  function renderPlanPrimitive(p, i, base) {
    const sp = {
      ...base,
      strokeWidth: resolveStrokeWidth(p.weightMm, Math.min(scaleX, scaleY), viewport.lineWeightsPx, viewport.pxPerMmX),
    };
    switch (p.type) {
      case 'line':     return <Line key={i} points={[p.x1, p.y1, p.x2, p.y2]} dash={p.dash} {...sp} />;
      case 'polyline': return <Line key={i} points={p.points} closed={p.closed} fill="transparent" {...sp} />;
      case 'rect':     return <Rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} dash={p.dash} fill="transparent" {...sp} />;
      case 'arc':      return <Path key={i} data={arcPathD(p.cx, p.cy, p.r, p.startDeg, p.sweepDeg)} dash={p.dash} fill="transparent" {...sp} />;
      default:         return null;
    }
  }

  return graph.openings.map((opening) => {
    const el = renderOpeningSymbol(opening);
    return el ? (
      <Group key={opening.id} name="opening-symbol" openingId={opening.id}
        onMouseEnter={e => setCursor(e, 'pointer')} onMouseLeave={e => setCursor(e, 'default')}>
        {el}
      </Group>
    ) : null;
  });

  function renderOpeningSymbol(opening) {
    const host = hostByOpening.get(opening.id) ?? null;
    if (!host) return null; // ホスト壁が見つからない開口は描画しない（壁の削除・トリム後の縮退仕様）

    const entry = findCatalogEntry(opening.category, opening.subType);

    // キャッシュミス（本来起きない想定だが、キー衝突等の異常系でも描画を丸ごと落とさない
    // ための保険）はメモ化なしで直接計算し、その1件だけ縮退させる。
    const [faceLo, faceHi] = faceRangeByHostId
      ? (faceRangeByHostId.get(host.id) ?? wallFaceRange(host, graph))
      : [undefined, undefined];

    const prims = buildOpeningPlanSymbol(opening, {
      entry, lodLevel, axisValue: host.axisValue, faceLo, faceHi,
      exteriorDirOf: () => openingExteriorDir(host, graph, opening.centerCoord),
    });
    const base = { stroke: opening.color, listening: true, hitStrokeWidth, fillEnabled: false };
    return <Fragment key={opening.id}>{prims.map((p, i) => renderPlanPrimitive(p, i, base))}</Fragment>;
  }
});
