// 階段の設置階（install）・上階見下げ（upper）の描画エントリ構築（純関数群）。App.jsx から抽出。
// StairLayer の描画と 2a壁の描画クリップ（stairUnderClip.js）の双方が使う派生値をここで計算する。
// snap.js（store.js経由でlocalStorage/indexedDBに依存し node:test から import 不能）には依存しない
// —— 破れ線の見た目端部のはり出し量（stairBreakOverhangMm）は呼び出し側（App.jsx）が
// overhangMm(viewport, false) で算出し opts 経由で渡す。
import { LodLevel } from '../../viewport.js';
import { floorHeightAbove } from './stairDimensions.js';
import { measureStairSpans } from './stairClassify.js';
import { cellsBeyondBreak, LANE_GAP } from './stairGeometry.js';
import { stairUnderWallClips } from './stairUnderClip.js';
import { roomBounds, cellBoundsList, refreshCells } from '../gridCells.js';

// 矩形2つが実質的に重なる（浮動小数の際どい接触は無視）か。EPS(mm) 未満の重なりは無視する。
const RECT_OVERLAP_EPS = 1; // mm
function rectsOverlap(a, b) {
  return a.x1 < b.x2 - RECT_OVERLAP_EPS && a.x2 > b.x1 + RECT_OVERLAP_EPS
      && a.y1 < b.y2 - RECT_OVERLAP_EPS && a.y2 > b.y1 + RECT_OVERLAP_EPS;
}

// listA のいずれかの矩形が listB のいずれかの矩形と重なるか（下階階段の見下げ upper エントリが
// 自階 install エントリと同一 footprint かどうかの判定に使う。cellBounds 同士の総当たり）。
export function anyCellBoundsOverlap(listA, listB) {
  if (!listA?.length || !listB?.length) return false;
  return listA.some(a => listB.some(b => rectsOverlap(a, b)));
}

// 上階ビュー peek 用: 直下階の階段を、上階表現（全段）の描画用エントリへ解決する
// （App.jsx の直下階 peek useEffect から抽出。effect 自体（floorSwapManager.peek 呼び出し）は App に残る）。
export function buildUpperStairPeekEntries(belowGraph, floorHeight) {
  return belowGraph.stairs.map(s => ({
    id: s.id,
    stair: s,
    graph: belowGraph, // 側面線の壁有無判定（resolveStairSideLines）。その階段が実在する下階のグラフを渡す
    bounds: roomBounds(s.cells, belowGraph),
    cellBounds: cellBoundsList(s.cells, belowGraph), // 実セル占有（選択枠用。選択は startDrag 経由で一本化）
    riser: s.riser ?? (floorHeight != null ? floorHeight / Math.max(1, s.totalSteps) : null),
    spans: measureStairSpans(s, belowGraph), // セル実測の区間長（区間長指定の反映）
    view: 'upper',
    selectable: false,
  }));
}

/**
 * 階段の設置階（install）・上階見下げ（upper）の描画エントリと 2a壁クリップを構築する。
 * @param {object} graph 自階グラフ
 * @param {object} project
 * @param {object} opts
 * @param {string} opts.appMode
 * @param {object} opts.viewport
 * @param {Array|null} opts.upperStairEntriesPeek 直下階peekの解決結果（App.jsx state。null=未解決）
 * @param {number} opts.stairBreakOverhangMm 破れ線の見た目端部のはり出し量（App.jsx が
 *   overhangMm(viewport, false)（snap.js）で算出して渡す。本モジュールはsnap.jsに依存しない）
 * @param {Array|null} [opts.upperSlabOpenings] 直上階のスラブ開口矩形（slabOpening.js）。
 *   破れ線から先を点線で描くときの可視範囲。null=上階なし／未解決（クリップしない）
 * @returns {{ isStairMode, installEntries, upperEntries, stairLaneGapMm, stairBreakOverhangMm, stairUnderClips }}
 */
export function buildStairEntries(graph, project, { appMode, viewport, upperStairEntriesPeek, upperSlabOpenings = null, stairBreakOverhangMm }) {
  // isStairMode: site・structure モードでは階段を描画しないため、cellsBeyondBreak・
  // refreshCells・measureStairSpans 等の無駄な計算と observable 購読（graph.stairs等）を
  // 空配列で止める（QA指摘）。stairUnderClips のゲートも同じ変数で揃える。
  const isStairMode = appMode === 'finish' || appMode === 'floorplan';
  const stairFh = floorHeightAbove(project, project.activePlane);
  const installEntries = isStairMode ? graph.stairs.map(s => {
    const riser = s.riser ?? (stairFh != null ? stairFh / Math.max(1, s.totalSteps) : null);
    // 破れ線先セルはヒット領域から除外する（下階階段の見下げクリック・階段下エリアの
    // 部屋ドラッグは startDrag に一本化されているため、ここでは自階階段の onClick を発火させない）。
    const beyond = cellsBeyondBreak(s, graph, riser);
    const beyondRects = cellBoundsList(beyond, graph);
    const refreshed = refreshCells(s.cells, graph);
    const hitCells = beyond.size > 0
      ? new Set([...refreshed].filter(k => !beyond.has(k)))
      : s.cells;
    return {
      id: s.id,
      stair: s,
      graph, // 側面線の壁有無判定（resolveStairSideLines）に使う
      bounds: roomBounds(s.cells, graph),
      cellBounds: cellBoundsList(s.cells, graph), // 実セル占有（L字等の選択枠用）
      hitCellBounds: cellBoundsList(hitCells, graph), // クリックヒット領域（破れ線先セル除外）
      beyondBreakBounds: beyondRects, // 破れ線先セルのワールド矩形（重なるupperの踏面間引きに使う）
      // 破れ線から先を点線で描き足すときの可視範囲（直上階のスラブ開口）。null=クリップしない。
      // 「空配列」も「この階段の破れ先とまったく重ならない」も安全側で制約なしとして扱う——
      // 階段の上には必ず開口があるはずで、どちらも上階モデルの事実ではなく導出失敗を意味する
      // （このまま採用すると点線が丸ごと消え、破れ先が無表現に戻ってしまう）。
      slabOpeningBounds: anyCellBoundsOverlap(upperSlabOpenings, beyondRects) ? upperSlabOpenings : null,
      riser,
      spans: measureStairSpans(s, graph), // セル実測の区間長（区間長指定の反映）
      view: 'install',
      selectable: appMode === 'finish',
    };
  }) : [];
  // 階切替の非同期過渡で同一階段が install/upper 両方に入るのを防ぐ
  // （install が設置階の正であり、upper は直下階由来。重複時は install を優先）
  const installStairIds = new Set(installEntries.map(e => e.id));
  // footprint が自階 install 階段と重なる upper エントリ（下階階段が自階の
  // 自動設置階段と同じ位置に見下げ表示される場合）は installOverlap を付与し、
  // StairLayer 側でプリミティブ別に独立フィルタする: 矢印は install の破れ線で
  // クリップ、踏面線は破れ線先セル（beyondBreakBounds。cellsBeyondBreak で
  // 全タイプ単一ソース判定済み）の中点判定、段数字はアンカー点判定で破れ先の
  // 番号だけ残す（重ならなければ従来どおりフル描画）。
  // upperStairEntriesPeek===null（未解決）の間は StairLayer には従来どおり空扱いで渡す
  // （初回マウント時の見た目は元々空だったため変化なし）。中間階ガードの安全側判定は
  // 下記 stairUnderClips 側で null を別途見て行う。isStairMode===false でも空配列に
  // 揃える（site・structure モードでの無駄なフィルタ・マップ計算を止める）。
  const upperEntries = isStairMode
    ? (upperStairEntriesPeek ?? [])
        .filter(e => !installStairIds.has(e.id))
        .map(e => {
          const overlapInstall = installEntries.find(ie => anyCellBoundsOverlap(e.cellBounds, ie.cellBounds));
          return overlapInstall
            ? {
                ...e, installOverlap: true, clipAgainstId: overlapInstall.id,
                beyondBreakBounds: overlapInstall.beyondBreakBounds,
              }
            : e;
        })
    : [];

  // 折返し階段の往路・復路の間のあき（簡略LODのみ0）。
  // StairLayer の描画と2a壁クリップ計算の双方へ渡す（描かれる破れ線とクリップ線のズレ防止）。
  const stairLaneGapMm = viewport.lodLevel === LodLevel.SCHEMATIC ? 0 : LANE_GAP;

  // 2a壁（階段下部屋の偏芯壁）の破れ線より階段踏面側を描画しないための、壁ID→クリップ多角形。
  // StairLayer と同じ条件（isStairMode）でゲートする——それ以外のモード（site等）では
  // 壁を常にクリップなしで描く（モード間で壁の見え方を変えない）。また upperStairEntriesPeek が
  // 未解決（null。階/モード切替直後の1フレーム）の間は中間階ガードが判定不能なため、
  // 安全側で一切クリップしない（QA指摘）。stairUnderWallClips はクリップ対象が0件のとき自ら
  // null を返す（毎レンダー新規の空Mapを渡し続けて observer の差分検出が無駄に走るのを防ぐ）。
  const stairUnderClips = isStairMode && upperStairEntriesPeek !== null
    ? stairUnderWallClips(graph, installEntries, {
        laneGapMm: stairLaneGapMm,
        breakOverhangMm: stairBreakOverhangMm,
        detail: viewport.lodLevel === LodLevel.DETAIL,
        lowerStairCellBounds: upperEntries.map(e => e.cellBounds).filter(Boolean).flat(),
      })
    : null;

  return { isStairMode, installEntries, upperEntries, stairLaneGapMm, stairBreakOverhangMm, stairUnderClips };
}
