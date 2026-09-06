import { observer } from 'mobx-react-lite';
import { Group, Line, Text, Shape, Circle } from 'react-konva';
import { buildStairGeometry, resolveStairSideLines, LABEL_OUT } from '../finish/stair/stairGeometry.js';
import {
  clipSegmentsBeyondBreak, reversePointPairs, trimBreakOverhang,
  clipPolylineStartAtBreak, clipPolylineEndAtBreak,
} from '../finish/stair/beyondBreakClip.js';
import { pointInRects, clipSegmentsToRects } from '../finish/stair/segmentClip.js';
import { trimOpeningEdgesAgainstStair } from '../finish/stair/slabOpening.js';
import { outlineSegments } from '../finish/gridCells.js';
import { LodLevel } from '../viewport.js';
import {
  stairLineRenderProps, stairDownviewDashPx, stairUpperOpeningDashPx, outlineStrokeWidth,
} from '../finish/stair/stairLineJoinPrimitives.js';

const STAIR_STROKE = '#1e293b';
const CHEVRON_ANGLE = Math.PI / 7; // 矢じり(^)の開き角

// 終点の矢じりを、黒三角ではなく鋭く尖った "^"（開いた山形）の2点で返す。
// pts は矢印本体の points 配列（[x1,y1,x2,y2,...]）。終点側の進行方向へ向けて尖らせる。
function chevronPoints(pts, len) {
  const n = pts.length;
  const tip = { x: pts[n - 2], y: pts[n - 1] };
  const prev = { x: pts[n - 4], y: pts[n - 3] };
  const dx = tip.x - prev.x, dy = tip.y - prev.y;
  const d = Math.hypot(dx, dy) || 1;
  const bx = -dx / d, by = -dy / d; // 進行方向の逆（尖端から広がる向き）
  const cos = Math.cos(CHEVRON_ANGLE), sin = Math.sin(CHEVRON_ANGLE);
  const w1 = { x: bx * cos - by * sin, y: bx * sin + by * cos };
  const w2 = { x: bx * cos + by * sin, y: -bx * sin + by * cos };
  return [
    tip.x + w1.x * len, tip.y + w1.y * len,
    tip.x, tip.y,
    tip.x + w2.x * len, tip.y + w2.y * len,
  ];
}

/**
 * 階段を描画する。entries は描画用に解決済みの配列:
 *   { id, stair, bounds:{x1,y1,x2,y2}, riser:number|null, spans:{lengths:number[]}|null,
 *     view:'install'|'upper', selectable:boolean, graph?:object,
 *     cellBounds:Array<{x1,y1,x2,y2}>|undefined,  // 実セル占有（選択ヒット・枠用。省略時は bounds）
 *     installOverlap?:boolean, clipAgainstId?:string }
 * stepNumbers=false のとき段数字（注記）を描かない。図そのものは変えない。
 *   graph は stair.cells・壁の実体を解決するグラフ（その階段が実在する階のグラフ。upper エントリ
 *   では peek した下階グラフ）。省略時は側面線の壁有無判定をせず常時描画する（安全側）。
 *   installOverlap/clipAgainstId/beyondBreakBounds は、footprint が自階 install 階段と重なる
 *   upper エントリ（下階階段の見下げが自階の自動設置階段と同じ位置に表示される場合)に
 *   App.jsx が付与する。
 *
 *   ■ 破れ線から先＝見下げの表現
 *   installOverlap 付き upper エントリが描くのは「自階スラブの開口越しに見下ろす下階階段」で、
 *   実体は当該平面より下にある。そのため見えがかり線（踏面線・外周線）は破線
 *   （DOWNVIEW_DASH_PX。書式は「上部吹抜け」と共通）で描く。矢印・段数字は見えがかり線ではなく記号のため実線のまま。
 *   描かれる範囲＝自階スラブの開口は「install 階段の破れ線より先」で、線の終点は当該平面の
 *   実線（footprint 境界＝壁面線・到達辺）になる。開口を狭める2要素は別の層が担当し、
 *   ここでは合成しない: 上階階段のとりつき部（破れ線手前側＝スラブが残る側）は破れ線クリップが、
 *   天井高さに達する壁は resolveStairSideLines の壁スパン差し引きが受け持つ。
 *
 *   可視判定はプリミティブ別に独立（共有ゲートを持たない）:
 *   矢印は clipAgainstId が指す install エントリの破れ線（実 polyline）でクリップして
 *   到達点側だけを残す。踏面線・外周線は線分プリミティブとして clipSegmentsBeyondBreak
 *   （beyondBreakClip.js）でクリップする——破れ線を跨ぐ線分は交点で切り、跨がない線分は
 *   中点が beyondBreakBounds（install 階段の cellsBeyondBreak をワールド矩形へ解決したもの。
 *   stairGeometry.js で全タイプ単一ソース判定済み）に入るかで採否を決める。段数字は
 *   点のためアンカー点が beyondBreakBounds（破れ先）に入る番号だけ残す（下階階段の
 *   踏面番号・矢印先端・重複踏面が破れ線手前に残って見える不良の対策）。
 * install/upper の両ビュー（設置階・設置上階）を同じ経路で描く。
 * bounds・spans は呼び出し側でワールド座標に解決済みのため、上階（peek した非アクティブ階）でも描ける。
 */
export const StairLayer = observer(({
  entries = [],
  viewport,
  detail = false,
  laneGapMm = 0,
  breakOverhangMm = 0,
  slabOpeningEdges = [],
  stepNumbers: showStepNumbers = true,
  selectedStairId = null,
  onSelectStair = null,
}) => {
  const px = (w) => w / viewport.scaleX; // ズーム非依存の線幅
  // 見下げ（破れ線から先＝階段下エリア）の破線パターン。書式は「上部吹抜け」と共通
  // （UPPER_VOID_DASH_PX を stairDownviewDashPx が参照する）。踏面線・外周線のdashは
  // stairLineRenderProps側で解決するため、ここではbeyondLines（L字結合を経由しない
  // 常時破線）用にのみ使う。
  const downviewDash = stairDownviewDashPx(viewport.scaleX);
  // 見上げ破線（開口の縁）の線種は「上部吹抜け」と共通（finish/voidGeometry.js の UPPER_VOID_DASH_PX）。
  const upperOpeningDash = stairUpperOpeningDashPx(viewport.scaleX);
  // 省略LODでは開口の縁（見上げ破線）を描かず、破れ先の破線だけ細線で残す（ユーザー決定）。
  const schematic = viewport.lodLevel === LodLevel.SCHEMATIC;

  // laneGapMm（折返し階段の往路・復路の間のあき）・breakOverhangMm（破れ線の見た目端部の
  // はり出し量）は呼び出し側（App.jsx）で1度だけ算出して渡す（2a壁の描画クリップ計算
  // stairUnderClip.js とここで同じ値を使い、描かれる破れ線とクリップ線のズレを防ぐ）。

  // 1パス目: 全エントリの幾何を先に計算する（矢印クリップで他エントリ＝自階installの
  // breakLine を参照するため、レンダーの前に install 分を含め解決しておく必要がある）。
  // 側面線（outline の side タグ）の壁有無は resolveStairSideLines（stairGeometry.js）で
  // 解決する——描画ルールの宣言はそちら側に集約し、ここでは結果を写像するだけにする。
  const resolved = entries.map((e) => {
    const { stair, bounds: b, riser, spans, view, graph } = e;
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || b.x2 <= b.x1 || b.y2 <= b.y1) {
      return null;
    }
    const resolve = (g) => (graph ? resolveStairSideLines(stair, graph, g) : g);
    const built = buildStairGeometry(stair, b, { view, detail, riser, spans, laneGapMm, breakOverhangMm, graph });
    // install エントリは、破れ線から先（＝切断高より上に続く上り部分）を点線で描き足すため、
    // 破断のない全段ジオメトリ（upper ビュー）も併せて作る。実際に描くのは破れ先だけで、
    // 段数字・矢印は install 側が既に持つため使わない（線分プリミティブのみ流用する）。
    const beyondBuilt = view === 'install'
      ? buildStairGeometry(stair, b, { view: 'upper', insetView: 'install', detail, riser, spans, laneGapMm, breakOverhangMm, graph })
      : null;
    return { e, geom: resolve(built), beyondGeom: beyondBuilt ? resolve(beyondBuilt) : null };
  });
  const installGeomById = new Map(
    resolved.filter(r => r && r.e.view === 'install').map(r => [r.e.id, r.geom]),
  );

  // 開口の縁を切るための、実際に描いた破れ先破線と破れ先セル矩形。
  const beyondSegsAll = [];
  const beyondBoundsAll = [];

  // 破れ線から先を「見下げ（下階階段）」として点線で描くエントリがある install の id 集合。
  // その install は自分の上り部分を重ねて描かない（同一 footprint・同一形状で完全に重なるため）。
  const coveredByDownView = new Set(
    resolved.filter(r => r && r.e.installOverlap && r.e.beyondBreakBounds?.length > 0)
      .map(r => r.e.clipAgainstId),
  );

  // 2パス目: 各エントリの外周線・踏面線（破線でない実線）以外のJSXと、L字結合の対象となる
  // 線分列（treadSegs/outlineSegs）・isDownViewを算出する。外周線・踏面線のJSX自体は3パス目
  // （エントリ単位でL字結合を解決した後）で組み立てる——
  // どの線分を対象にし、どの太さで扱うかの判断は finish/stair/stairLineJoinPrimitives.js
  // （L字の角の外角閉じ。renderer/planLineJoin.js経由）に一本化し、ここでは判断結果
  // （stairLineRenderPropsのpoints/strokeWidth/dash）を<Line>へ渡すだけにする。
  const entryCtx = resolved.map((r) => {
    if (!r) return null;
    const { e, geom, beyondGeom } = r;
    const { id, bounds: b, view, selectable, cellBounds, hitCellBounds } = e;
    const isSel = id === selectedStairId;

    const lineProps = { stroke: STAIR_STROKE, strokeWidth: px(1.5), listening: false };

    // 自階 install と footprint が重なる upper エントリは、対応する install の幾何（breakLine）を
    // 使って矢印を破れ線基準に調整する。install が見つからない/破れ線が退化している場合は
    // 安全側で調整せず全描画する（外周・破れ線シンボル自体は常に geom のまま＝変更しない）。
    const installGeom = e.installOverlap && e.clipAgainstId
      ? installGeomById.get(e.clipAgainstId)
      : null;
    // クリップにはり出しを含んだ破れ線を使うと、内側の通り芯を越えて反対レーンの側線まで
    // 切ってしまう（往路のささらが途中から点線化する不良）。はり出しは見た目のみ——実端点で切る。
    const installBreakLine = trimBreakOverhang(installGeom?.breakLine, breakOverhangMm);
    // 見下げ（＝破れ線から先を、自階スラブの開口越しに見下ろす表現）として描くエントリか。
    // install エントリ自身も beyondBreakBounds を持つ（重なる upper へ渡すため）ので、
    // installOverlap でガードしないと自階の手前側まで間引き・点線化されてしまう。
    const isDownView = !!e.installOverlap && e.beyondBreakBounds?.length > 0;

    // install エントリ側: 自分の破れ線から先（＝切断高より上に続く上り部分）を点線で描き足す。
    // 破れ先が導出できない（beyondBreakBounds が空）／破れ線が無い場合は従来どおり何も足さない。
    const ownBreakLine = view === 'install' ? trimBreakOverhang(geom.breakLine, breakOverhangMm) : null;
    const beyondDrawable = ownBreakLine?.length > 0 && e.beyondBreakBounds?.length > 0;
    // 破れ先を「見下げ」として別エントリが点線で描く場合は、同じ形が二重に走るのでこちらは描かない。
    const drawOwnBeyond = beyondDrawable && !!beyondGeom && !coveredByDownView.has(id);
    // 描き足すのは外周線（ささら・到達辺）だけで、踏面線は描かない——破れ線から先の段は
    // 切断面より上にあり、平面図には見えがかりの範囲だけを示せば足りる（ユーザー決定）。
    // 可視範囲は直上階のスラブ開口で「切る」（中点で採否するフィルタでは、境界をまたぐ線分が
    // 全長そのまま残って開口の縁を突き抜ける——過去の不良）。上階の階段とりつき部＝スラブが
    // 残る側は開口に含まれないため、ここで自動的に除かれる。範囲不明なら安全側で切らない。
    const beyondOutlineSegs = drawOwnBeyond
      ? clipSegmentsToRects(
          clipSegmentsBeyondBreak(beyondGeom.outline, ownBreakLine, e.beyondBreakBounds),
          e.slabOpeningBounds,
        )
      : [];
    if (beyondOutlineSegs.length > 0) {
      beyondSegsAll.push(...beyondOutlineSegs);
      beyondBoundsAll.push(...e.beyondBreakBounds);
    }

    // 踏み面は線種の共通定義（LINE_WEIGHT_MM）の thin を参照する。
    // 見下げエントリは clipSegmentsBeyondBreak（beyondBreakClip.js）で破れ先だけに絞る:
    // 破れ線を跨ぐ踏面は交点で切って破れ線どまりにし、跨がない踏面は中点が beyondBreakBounds
    // （install 階段の cellsBeyondBreak を解決したワールド矩形。全タイプ単一ソース判定済み）に
    // 入るかで採否を決める。beyondBreakBounds が空/未提供（cellsBeyondBreak が導出不能で
    // 空 Set を返した場合を含む）なら安全側でフィルタなし（＝isDownView が false。従来どおり
    // 全描画で、二重線は残るが破綻しない）。
    const treadSegs = isDownView
      ? clipSegmentsBeyondBreak(geom.treads, installBreakLine, e.beyondBreakBounds)
      : geom.treads;
    // 外周線も踏面線と同じ「線分」プリミティブとして破れ先へクリップする。クリップしないと
    // 下階階段の側面線・上り口の辺が破れ線の手前側（install が実線で描く区間）まで二重に走り、
    // 点線化した見下げ線が実線の上に重なる。「破れ線から出発した線の終点＝当該平面の実線」は、
    // footprint 境界（＝壁面線・到達辺）で止まる外周線がそのまま満たす。
    // 天井高さに達する壁ぶんの差し引きは resolveStairSideLines（壁スパンの区間差し引き）が
    // 既に済ませているため、ここでは重ねて判定しない。
    // install 側の外周は逆に破れ手前へクリップする。全タイプで外周は view 非依存に全長生成される
    // ため、クリップしないと破れ先を点線で描き直した区間に実線が重なって点線が消えて見える。
    const outlineSegs = isDownView
      ? clipSegmentsBeyondBreak(geom.outline, installBreakLine, e.beyondBreakBounds)
      : beyondDrawable
        ? clipSegmentsBeyondBreak(geom.outline, ownBreakLine, e.beyondBreakBounds, { keep: 'near' })
        : geom.outline;
    // 破れ線から先（上り部分）の外周線の点線。常時点線＝L字結合の対象外のため、
    // stairLineRenderPropsを経由せずoutlineStrokeWidth（外周線の太さの唯一の供給源）を直接呼ぶ。
    const beyondLines = beyondOutlineSegs.map((s, i) => (
      <Line
        key={`bo${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps}
        strokeWidth={schematic ? px(viewport.lineWeightsPx.thin) : outlineStrokeWidth(s, viewport.scaleX, viewport.lineWeightsPx)}
        dash={downviewDash}
      />
    ));
    const breakLine = (geom.breakLine ?? []).map((s, i) => (
      <Line key={`b${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps} />
    ));

    // 矢印を install の破れ線位置でクリップする。塗り丸＝到達点側（下から登ってきた階段の
    // 最大段位置）はそのまま残し、矢じりだけ破れ線交点側に来るようにする（下階階段の「降り」
    // 表現：到達点に立って破れ線方向へ降りる）。全タイプで view!=='install' の矢印は
    // 始点(pts[0])が到達点側になるよう構築されている（stairGeometry.js 確認済み）ため、
    // 通常は終端側だけをクリップすれば足りる（反転不要）。念のため beyondBreakBounds で
    // 実際にどちら側が到達点（先側）かを確認し、型によって逆順の場合は始点側クリップ＋反転に
    // 切り替える（型非依存で統一的に扱う）。交点が求まらなければ安全側でフル矢印のまま。
    const resolvedArrows = (geom.arrows ?? []).map((a) => {
      if (!installBreakLine?.length) return a;
      const pts = a.points ?? [a.x1, a.y1, a.x2, a.y2];
      const bounds = e.beyondBreakBounds;
      const startIsBeyond = !(bounds?.length > 0) || pointInRects(bounds, pts[0], pts[1]);
      const endIsBeyond = bounds?.length > 0 && pointInRects(bounds, pts[pts.length - 2], pts[pts.length - 1]);
      let clippedPts;
      if (!startIsBeyond && endIsBeyond) {
        // このタイプは終点側が到達点（先側）→ 始点側をクリップしてから反転する
        const clipped = clipPolylineStartAtBreak(pts, installBreakLine);
        clippedPts = clipped ? reversePointPairs(clipped) : null;
      } else {
        // 既定: 始点が到達点（先側）→ 終端側だけをクリップする（反転不要）
        clippedPts = clipPolylineEndAtBreak(pts, installBreakLine);
      }
      if (!clippedPts) return a; // 交点なし → 安全側でフル矢印のまま
      const [nx, ny, nx2, ny2] = clippedPts;
      const dx = nx - nx2, dy = ny - ny2;
      const len = Math.hypot(dx, dy) || 1;
      return {
        ...a,
        x1: nx, y1: ny,
        x2: clippedPts[clippedPts.length - 2], y2: clippedPts[clippedPts.length - 1],
        points: clippedPts,
        labelX: nx + (dx / len) * LABEL_OUT, labelY: ny + (dy / len) * LABEL_OUT,
      };
    });

    const arrows = resolvedArrows.map((a, i) => {
      const pts = a.points ?? [a.x1, a.y1, a.x2, a.y2];
      return (
        <Group key={`a${i}`}>
          {/* 始点: 寸法線と同じ塗り丸 */}
          <Circle x={a.x1} y={a.y1} radius={px(2)} fill={STAIR_STROKE} listening={false} />
          {/* 矢印本体（折れ線U字矢印は points で複数点） */}
          <Line points={pts} stroke={STAIR_STROKE} strokeWidth={px(1.5)} listening={false} />
          {/* 終点の矢じり: 黒三角ではなく鋭く尖った "^" */}
          <Line
            points={chevronPoints(pts, px(10))}
            stroke={STAIR_STROKE} strokeWidth={px(1.5)}
            lineCap="round" lineJoin="round" listening={false}
          />
          {a.label && (
            <Text
              x={a.labelX} y={a.labelY}
              text={a.label} fontSize={200}
              fill={STAIR_STROKE} offsetX={60} offsetY={100} listening={false}
            />
          )}
        </Group>
      );
    });
    // 段数字は踏面線のクリップとは独立したルールで間引く: 数字は点なので、重なる upper エントリ
    // ではアンカー点が install の破れ線先セル（beyondBreakBounds）に入る番号（＝下階から登って
    // きた階段の破れ先の部分。到達番号を含む）だけ残す。手前側の番号は install 自身が描くため
    // 重複させない。領域が導出不能（空/未提供）なら従来どおり安全側で全抑止する。
    // stepNumbers=false（平面モード以外）は段数字を丸ごと描かない——注記は平面のみという
    // 規則（planFigureVisibility.js の shouldShowStairStepNumbers）。図（踏面線・矢印・破れ線）は
    // どのモードでも描き続ける。
    const visibleNumbers = !showStepNumbers ? [] : (e.installOverlap
      ? (e.beyondBreakBounds?.length > 0
          ? geom.stepNumbers.filter((n) => pointInRects(e.beyondBreakBounds, n.x, n.y))
          : [])
      : geom.stepNumbers);
    const stepNumbers = visibleNumbers.map((n, i) => (
      <Text
        key={`n${i}`}
        x={n.x} y={n.y} text={n.text} fontSize={120}
        fill={STAIR_STROKE} offsetX={40 * n.text.length} offsetY={60} listening={false}
      />
    ));

    // 選択ヒット領域・ハイライトは実セル占有形状で描く。包絡矩形で描くと
    // L字（矩折・曲がり）や中空きなど非矩形占有のタイプで空きマスまで矩形に
    // 選択されてしまう。塗りは1パス（部屋選択と同方式）、枠は共有辺を打ち
    // 消した外周線分で描く。cellBounds 未解決時は包絡矩形にフォールバック。
    const outlineBounds = cellBounds?.length > 0 ? cellBounds : [b];
    // クリックヒット領域は破れ線先セルを除外した hitCellBounds を優先する（下階階段の見下げ
    // クリック・階段下エリアの部屋ドラッグは Stage 側の startDrag に一本化しているため、
    // ここで自階階段の onClick を発火させない）。未指定時は選択枠と同じ領域を使う。
    const hitBounds = hitCellBounds?.length > 0 ? hitCellBounds : outlineBounds;

    return {
      id, view, isDownView, treadSegs, outlineSegs, lineProps,
      // 描画順は元のJSXと同じ並びを保つため、treads/outline（3パス目でL字結合を解決してから
      // 組み立てる）の前後2つに分けて持ち回る。
      beforeJsx: (
        <>
          {selectable && onSelectStair && (
            <Shape
              sceneFunc={(ctx, shape) => {
                ctx.beginPath();
                for (const cb of hitBounds) ctx.rect(cb.x1, cb.y1, cb.x2 - cb.x1, cb.y2 - cb.y1);
                ctx.fillStrokeShape(shape);
              }}
              fill={isSel ? 'rgba(37,99,235,0.10)' : 'transparent'}
              onClick={() => onSelectStair(id)}
              onTap={() => onSelectStair(id)}
            />
          )}
          {isSel && outlineSegments(outlineBounds).map(seg => (
            <Line
              key={`sel${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`}
              points={seg.isVertical
                ? [seg.value, seg.lo, seg.value, seg.hi]
                : [seg.lo, seg.value, seg.hi, seg.value]}
              stroke="#2563eb"
              strokeWidth={px(2)}
              listening={false}
            />
          ))}
        </>
      ),
      afterJsx: (
        <>
          {beyondLines}
          {breakLine}
          {arrows}
          {stepNumbers}
        </>
      ),
    };
  });

  // 3パス目: エントリ単位でL字結合を解決し（QA指摘2026-09。他エントリの端点とは混ぜない）、
  // 解決済みprops（points/strokeWidth/dash）を<Line>へそのまま渡すだけでJSXを組み立てる。
  // 「どの線分を対象にし、どの太さ・dashで扱うか」はfinish/stair/stairLineJoinPrimitives.jsが
  // 唯一の供給源——ここに判断は残さない。
  const groups = entryCtx.map((ctx) => {
    if (!ctx) return null;
    const { id, view, isDownView, treadSegs, outlineSegs, lineProps, beforeJsx, afterJsx } = ctx;
    const renderProps = stairLineRenderProps(
      { view, id, treadSegs, outlineSegs, isDownView },
      viewport,
      viewport.lineWeightsPx,
    );
    const treads = renderProps.treads.map((p) => (
      <Line
        key={p.key} points={p.points} {...lineProps}
        stroke="#000000"
        strokeWidth={p.strokeWidth}
        dash={p.dash}
      />
    ));
    const outline = renderProps.outline.map((p) => (
      <Line
        key={p.key}
        points={p.points}
        {...lineProps}
        strokeWidth={p.strokeWidth}
        dash={p.dash}
      />
    ));
    return (
      <Group key={`${view}:${id}`}>
        {beforeJsx}
        {treads}
        {outline}
        {afterJsx}
      </Group>
    );
  });

  // 直上階スラブ開口の縁（見上げ破線）。階段エントリ単位ではなく開口単位で1度だけ描く
  // （複数の階段が同じ開口を共有しても二重に描かない）。線種は「上部吹抜け」と共通
  // （UPPER_VOID_DASH_PX。同じ「上階に床が無い範囲の外形」を表す線のため）。当該階の壁に覆われた区間は
  // 呼び出し側（slabOpeningEdges）で既に差し引かれている。さらに、階段のとりつき部では階段側の
  // 破線が縁を担うので、直交する破れ先破線との交点で切って落とす（残りと合わせてL字になる）。
  // 破れ先破線側は既に開口の縁でクリップ済み——切る向きは双方向で、片方だけでは
  // 「縁が破線を突き抜ける」か「縁が切られずL字にならない」のどちらかになる（過去の不良）。
  const trimmedOpeningEdges = schematic
    ? []
    : trimOpeningEdgesAgainstStair(slabOpeningEdges, beyondSegsAll, beyondBoundsAll);
  const openingEdges = trimmedOpeningEdges.map((s, i) => (
    <Line
      key={`so${i}`} points={[s.x1, s.y1, s.x2, s.y2]}
      stroke={STAIR_STROKE} strokeWidth={px(2)} // 破れ先破線（階段外周）と同じ太さに揃える
      dash={upperOpeningDash} listening={false}
    />
  ));

  return <Group>{openingEdges}{groups}</Group>;
});
