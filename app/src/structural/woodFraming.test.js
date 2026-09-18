// woodFraming.js（在来木造の梁成表・下地割付・袖材・玄関開口・火打ち条件）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature } from '../core/constants.js';
import {
  woodBeamDepthMm, woodBeamSectionKey, woodBeamSectionForDepth, woodBeamDepthForSpans, crossingBeamLoadCoords,
  mergeWallIntervals, subtractCoveredSpan, throughBeamRuns, columnSplitPoints, propagateCarrierDepths, columnSupportBeamCandidates,
  beamWallCrossPoints, studPositions, studSpec, openingJambSpec, entranceOpeningWidthMm, hipBraceAllowed,
  wallRunFaces, faceStudPositions, sillTopLevelOffsetMm, jambAxisValue, jambColumnPositions, rectsOverlap,
  supportSpanColumnPositions, mergePrimaryBeamRuns,
} from './woodFraming.js';
import { WOOD_BEAM_DEPTH_TABLE, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { findSectionEntry, woodRectSectionKey, SECTION_CATALOG } from './sectionCatalog.js';

test('woodBeamDepthMm: 梁成表（最終行は中間荷重3か所＝ユーザー確認済み）を距離区分×中間荷重数で引く', () => {
  // 1820以下
  assert.equal(woodBeamDepthMm(1820, 0), 120);
  assert.equal(woodBeamDepthMm(910, 1), 150);
  assert.equal(woodBeamDepthMm(1820, 2), 210);
  assert.equal(woodBeamDepthMm(1820, 3), 240);
  // 2730以下（1820超）
  assert.equal(woodBeamDepthMm(1821, 0), 240);
  assert.equal(woodBeamDepthMm(2730, 1), 270);
  assert.equal(woodBeamDepthMm(2730, 2), 270);
  assert.equal(woodBeamDepthMm(2730, 3), 300);
  // 3640以下（2730超）
  assert.equal(woodBeamDepthMm(2731, 0), 300);
  assert.equal(woodBeamDepthMm(3640, 1), 330);
  assert.equal(woodBeamDepthMm(3640, 2), 330);
  assert.equal(woodBeamDepthMm(3640, 3), 360);
});

test('woodBeamDepthMm: 表の外（3640超・4か所以上）は表の最大側の値（ユーザー裁定2026-09-14「表の最大値360を使う」）', () => {
  assert.equal(woodBeamDepthMm(3641, 0), 300, '3640超は3640以下の列');
  assert.equal(woodBeamDepthMm(5460, 3), 360, '3640超×3か所＝表の最大値');
  assert.equal(woodBeamDepthMm(1820, 4), 240, '4か所以上は3か所の行');
  assert.equal(woodBeamDepthMm(9999, 9), 360);
});

test('【失敗系】woodBeamDepthMm: 非数・0以下の距離、負や非整数の荷重数は null', () => {
  assert.equal(woodBeamDepthMm(0, 0), null);
  assert.equal(woodBeamDepthMm(NaN, 0), null);
  assert.equal(woodBeamDepthMm(undefined, 0), null);
  assert.equal(woodBeamDepthMm(1820, -1), null);
  assert.equal(woodBeamDepthMm(1820, 1.5), null);
});

test('woodBeamSectionKey: 支持間距離と中間荷重から「柱同寸×成」の断面キーを返し、表のすべての成×正角幅がカタログにある', () => {
  assert.equal(woodBeamSectionKey(3640, 3, 120), 'WOOD-120x360');
  assert.equal(woodBeamSectionKey(1820, 0, 120), 'WOOD-120x120', '成120×幅120＝正角');
  assert.equal(woodBeamSectionKey(1820, 0, 105), 'WOOD-105x120');
  assert.equal(woodBeamSectionKey(2730, 2, 90), 'WOOD-90x270');
  assert.equal(woodBeamSectionKey(5000, 5, 120), 'WOOD-120x360', '表外は最大値');
  for (const width of [90, 105, 120]) {
    for (const row of WOOD_BEAM_DEPTH_TABLE.depthsByLoads) {
      for (const depth of row) {
        assert.equal(woodRectSectionKey(width, depth), `WOOD-${width}x${depth}`, `${width}×${depth} がカタログに無い`);
      }
    }
  }
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.columnSection).width, 120, '在来木造の柱は120角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.hipBraceSection)?.width, 90, '火打ち梁は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.purlinSection)?.width, 90, '母屋は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.ridgeSection)?.width, 120, '棟木は120角');
  assert.ok(findSectionEntry('WOOD-105x105'), '旧既定 105角 は旧文書のため残す');
});

test('【失敗系】woodBeamSectionKey: 梁成が引けない・幅が非数/0以下・カタログに無い幅は null', () => {
  assert.equal(woodBeamSectionKey(0, 0, 120), null);
  assert.equal(woodBeamSectionKey(1820, 0, 0), null);
  assert.equal(woodBeamSectionKey(1820, 0, NaN), null);
  assert.equal(woodBeamSectionKey(1820, 0, 150), null, '150幅の木角材はカタログに無い');
});

test('sectionCatalog: 木造エントリは正角（90/105/120）と「正角幅×梁成」の矩形で、材種WOOD・幅≦成', () => {
  const wood = SECTION_CATALOG.filter(s => s.materialType === 'WOOD');
  assert.ok(wood.length >= 3 + 3 * 8, `木造エントリが少ない（${wood.length}）`);
  for (const s of wood) {
    assert.ok([90, 105, 120].includes(s.width), `${s.key}: 幅は正角材の寸法`);
    assert.ok(s.height >= s.width, `${s.key}: 成は幅以上`);
    assert.equal(s.key, `WOOD-${s.width}x${s.height}`);
  }
});

test('woodBeamSectionForDepth: 成→断面キー（材幅＝柱同寸）。woodBeamSectionKeyはこれへ委譲する', () => {
  assert.equal(woodBeamSectionForDepth(360, 120), 'WOOD-120x360');
  assert.equal(woodBeamSectionForDepth(120, 120), 'WOOD-120x120', '成120×幅120＝正角');
  assert.equal(woodBeamSectionForDepth(120, 105), 'WOOD-105x120');
  // woodBeamSectionKey は woodBeamDepthMm→woodBeamSectionForDepth の合成と一致する（委譲の確認）。
  assert.equal(woodBeamSectionKey(1820, 0, 120), woodBeamSectionForDepth(woodBeamDepthMm(1820, 0), 120));
});

test('【失敗系】woodBeamSectionForDepth: 成がnull・幅が非数/0以下・カタログに無い幅は null', () => {
  assert.equal(woodBeamSectionForDepth(null, 120), null);
  assert.equal(woodBeamSectionForDepth(120, 0), null);
  assert.equal(woodBeamSectionForDepth(120, NaN), null);
  assert.equal(woodBeamSectionForDepth(120, 150), null, '150幅の木角材はカタログに無い');
});

test('woodBeamDepthForSpans: 支持点間を区間に分け、各区間の内部荷重数から梁成表を引いた最大値を返す', () => {
  assert.equal(woodBeamDepthForSpans([0, 3640], []), 300, '単一区間・荷重なし');
  assert.equal(woodBeamDepthForSpans([0, 1820], [910]), 150, '単一区間・内部荷重1');
  assert.equal(woodBeamDepthForSpans([0, 1820, 5460], []), 300, '区間最大: [0,1820]=120, [1820,5460]=300 → 300');
  assert.equal(woodBeamDepthForSpans([0, 1820, 3640], [1820]), 120, '荷重が支持点(端)に一致する位置は内部荷重に数えない');
  assert.equal(woodBeamDepthForSpans([0, 1820], [910, 910.3]), 150, '同位置(tol未満)の複数荷重源は1か所にまとめる');
  assert.equal(woodBeamDepthForSpans([0, 0.2, 1820], []), 120, '支持点もtol未満は1点にまとめる');
  assert.equal(woodBeamDepthForSpans([0, 10000], []), 300, '表外の距離は表の最大側の列');
});

test('【失敗系】woodBeamDepthForSpans: 支持点0/1個・非数混入・荷重の非数混入は null', () => {
  assert.equal(woodBeamDepthForSpans([], []), null, '支持点0個');
  assert.equal(woodBeamDepthForSpans([1820], []), null, '支持点1個');
  assert.equal(woodBeamDepthForSpans([0, 0.2], []), null, '支持点がtolでまとまって実質1点');
  assert.equal(woodBeamDepthForSpans([0, NaN], []), null, '支持点に非数混入');
  assert.equal(woodBeamDepthForSpans([0, 1820], [NaN]), null, '荷重に非数混入');
  assert.equal(woodBeamDepthForSpans(null, []), null);
});

test('crossingBeamLoadCoords: 同位置で両方向(+1/-1)そろう十字貫通は除外し、片側だけ(T字)は1か所として残す', () => {
  assert.deepEqual(crossingBeamLoadCoords([{ coord: 910, dir: 1 }, { coord: 910, dir: -1 }]), [], '十字貫通は荷重に数えない');
  assert.deepEqual(crossingBeamLoadCoords([{ coord: 910, dir: 1 }]), [910], 'T字は1か所');
  assert.deepEqual(
    crossingBeamLoadCoords([{ coord: 910, dir: 1 }, { coord: 910, dir: -1 }, { coord: 1820, dir: 1 }]),
    [1820], '貫通する910は除外し、T字の1820だけ残す',
  );
  assert.deepEqual(crossingBeamLoadCoords([]), []);
});

test('mergeWallIntervals: 重なるか隙間がtol以下の区間を連結し、昇順の最大区間にする', () => {
  assert.deepEqual(mergeWallIntervals([{ lo: 0, hi: 100 }, { lo: 50, hi: 150 }]), [{ lo: 0, hi: 150 }], '重なりは連結');
  assert.deepEqual(mergeWallIntervals([{ lo: 0, hi: 100 }, { lo: 100.5, hi: 200 }]), [{ lo: 0, hi: 200 }], '隙間=tol(0.5)は連結');
  assert.deepEqual(
    mergeWallIntervals([{ lo: 0, hi: 100 }, { lo: 100.6, hi: 200 }]),
    [{ lo: 0, hi: 100 }, { lo: 100.6, hi: 200 }],
    '隙間>tolは分離',
  );
  // 未ソート入力でも昇順に並ぶ
  assert.deepEqual(
    mergeWallIntervals([{ lo: 500, hi: 600 }, { lo: 0, hi: 100 }]),
    [{ lo: 0, hi: 100 }, { lo: 500, hi: 600 }],
  );
  // tol指定
  assert.deepEqual(mergeWallIntervals([{ lo: 0, hi: 100 }, { lo: 110, hi: 200 }], 10), [{ lo: 0, hi: 200 }]);
});

test('【失敗系】mergeWallIntervals: 非数・hi<=loの不正区間は除去、空配列は空配列', () => {
  assert.deepEqual(
    mergeWallIntervals([{ lo: 0, hi: 100 }, { lo: 50, hi: 50 }, { lo: NaN, hi: 10 }, { lo: 10, hi: 5 }, null, undefined]),
    [{ lo: 0, hi: 100 }],
  );
  assert.deepEqual(mergeWallIntervals([]), []);
  assert.deepEqual(mergeWallIntervals(null), []);
});

// ---- subtractCoveredSpan（土台の候補源(b)基礎梁スパンから候補源(a)壁線runの和集合を差し引く。
// 「1階の土台が同軸で重複」修正・2026-09-18裁定）----
test('subtractCoveredSpan: coveringが無ければtargetをそのまま1ピース（loCut/hiCutともfalse）で返す', () => {
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, []), [{ lo: 0, hi: 3640, loCut: false, hiCut: false }]);
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, null), [{ lo: 0, hi: 3640, loCut: false, hiCut: false }]);
});

test('subtractCoveredSpan: 完全に覆われれば空配列（土台は通し1本だけが残る＝候補源bを生成しない）', () => {
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: 0, hi: 3640 }]), []);
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: -100, hi: 4000 }]), [], '覆う側がtargetより広くても完全被覆');
  // 複数のcoveringの合算で完全に覆われる場合も空配列。
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: 0, hi: 1820 }, { lo: 1820, hi: 3640 }]), []);
});

test('subtractCoveredSpan: 片側だけ覆われれば残りの片側だけを返し、覆われた側の端はhiCut/loCutがtrue', () => {
  // [0,3640]を覆う候補源a([0,3640])に対し候補源bが[0,7280]なら残りは[3640,7280]（loCut:true=境界CL使用）。
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 7280 }, [{ lo: 0, hi: 3640 }]),
    [{ lo: 3640, hi: 7280, loCut: true, hiCut: false }],
  );
  // 逆側（高い方が覆われる）。
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 7280 }, [{ lo: 3640, hi: 7280 }]),
    [{ lo: 0, hi: 3640, loCut: false, hiCut: true }],
  );
});

test('subtractCoveredSpan: 中間だけ覆われれば両側2ピースを返し、covering側の端はどちらもCut', () => {
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 9100 }, [{ lo: 3640, hi: 5460 }]),
    [
      { lo: 0, hi: 3640, loCut: false, hiCut: true },
      { lo: 5460, hi: 9100, loCut: true, hiCut: false },
    ],
  );
});

test('subtractCoveredSpan: coveringは内部でmergeWallIntervalsされる（隣接・重複するcoveringも1つの覆いとして扱う）', () => {
  // [0,1820]と[1820,3640]は隣接（隙間0）——merge後は[0,3640]の単一coveringとして扱われ、
  // 覆う側の中間境界(x=1820)はピース境界として現れない。
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 7280 }, [{ lo: 0, hi: 1820 }, { lo: 1820, hi: 3640 }]),
    [{ lo: 3640, hi: 7280, loCut: true, hiCut: false }],
  );
});

test('【失敗系】subtractCoveredSpan: coveringが完全に外側（targetと重ならない）ならtargetをそのまま返す', () => {
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: 5000, hi: 6000 }]),
    [{ lo: 0, hi: 3640, loCut: false, hiCut: false }],
    'coveringがtargetより後ろ',
  );
  assert.deepEqual(
    subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: -2000, hi: -1000 }]),
    [{ lo: 0, hi: 3640, loCut: false, hiCut: false }],
    'coveringがtargetより前',
  );
});

test('【失敗系】subtractCoveredSpan: targetが不正（非数・hi<=lo）は空配列', () => {
  assert.deepEqual(subtractCoveredSpan({ lo: 100, hi: 100 }, [{ lo: 0, hi: 200 }]), []);
  assert.deepEqual(subtractCoveredSpan({ lo: NaN, hi: 100 }, []), []);
  assert.deepEqual(subtractCoveredSpan(null, []), []);
});

test('【失敗系】subtractCoveredSpan: tol以下に縮む断片は捨てる（境界がtol未満の差でぴったり重なる場合は完全被覆扱い）', () => {
  assert.deepEqual(subtractCoveredSpan({ lo: 0, hi: 3640 }, [{ lo: 0, hi: 3639.8 }]), [], 'tol(0.5)未満の残りは捨てる');
});

test('throughBeamRuns: 連続する被覆ペアは1本の通し梁にまとめる（区間が分かれていても連続被覆なら1本）', () => {
  // 3点全被覆(1つの区間) → 通しで1本
  assert.deepEqual(throughBeamRuns([0, 1820, 3640], [{ lo: 0, hi: 3640 }]), [{ lo: 0, hi: 3640 }]);
  // 3点全被覆(区間が分かれていても連続して被覆されていれば1本にまとめる)
  assert.deepEqual(
    throughBeamRuns([0, 1820, 3640], [{ lo: 0, hi: 1820 }, { lo: 1820, hi: 3640 }]),
    [{ lo: 0, hi: 3640 }],
  );
});

test('throughBeamRuns: 中間ペアが未被覆(壁が途切れている)なら2本に割れ、片側だけ被覆なら未被覆側は捨てて1本', () => {
  // 中間ペアが未被覆(壁が途切れている)なら2本に割れる
  assert.deepEqual(
    throughBeamRuns([0, 1820, 3640, 5460], [{ lo: 0, hi: 1820 }, { lo: 3640, hi: 5460 }]),
    [{ lo: 0, hi: 1820 }, { lo: 3640, hi: 5460 }],
  );
  // 片側だけ被覆なら1本(未被覆側は捨てる)
  assert.deepEqual(throughBeamRuns([0, 1820, 3640], [{ lo: 0, hi: 1820 }]), [{ lo: 0, hi: 1820 }]);
  // 壁が途中で切れる点(被覆区間の外の点)は端にならない
  assert.deepEqual(throughBeamRuns([0, 1820, 2000], [{ lo: 0, hi: 1820 }]), [{ lo: 0, hi: 1820 }]);
});

test('throughBeamRuns: tol境界（iv.hi === p - tol の等号）は被覆とみなす', () => {
  assert.deepEqual(throughBeamRuns([0, 1820], [{ lo: 0, hi: 1819.5 }]), [{ lo: 0, hi: 1820 }], 'iv.hi=p-tolは境界(等号)で被覆');
  assert.deepEqual(throughBeamRuns([0, 1820], [{ lo: 0, hi: 1819.4 }]), [], 'iv.hi<p-tolは非被覆');
});

test('throughBeamRuns: 重複・未ソートの点もdedup・昇順化してから判定する', () => {
  assert.deepEqual(throughBeamRuns([1820, 0, 0.2], [{ lo: 0, hi: 1820 }]), [{ lo: 0, hi: 1820 }]);
});

test('【失敗系】throughBeamRuns: 点2点未満・被覆なし・非数混入は空配列', () => {
  assert.deepEqual(throughBeamRuns([1000], [{ lo: 0, hi: 2000 }]), [], '点1個');
  assert.deepEqual(throughBeamRuns([], []), []);
  assert.deepEqual(throughBeamRuns([0, 1820], []), [], '被覆する区間が無い');
  assert.deepEqual(throughBeamRuns([0, 1820], [{ lo: 5000, hi: 6000 }]), [], '被覆する区間が無い(別位置)');
  assert.deepEqual(throughBeamRuns([0, NaN, 1820], [{ lo: 0, hi: 1820 }]), [], '点に非数混入');
  assert.deepEqual(throughBeamRuns(null, [{ lo: 0, hi: 1820 }]), []);
});

// ---- columnSplitPoints（ステップ3c-2b: runを下階柱の位置で分割する端点列挙）----
// isVertical=false（横壁線・axisCoord=y=0）: 法線方向座標=y、走行方向座標(along)=x。
test('columnSplitPoints: 区間内部の下階柱1点で[lo,c,hi]の3点、2点なら4点（[lo,c1,c2,hi]）を返す', () => {
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1820, y: 0 }]), [0, 1820, 3640]);
  assert.deepEqual(
    columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1000, y: 0 }, { x: 2000, y: 0 }]),
    [0, 1000, 2000, 3640],
  );
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, []), [0, 3640], '下階柱0件は分割しない');
});

test('columnSplitPoints: run両端（tol以内）に一致する下階柱は分割点にしない（既存の端点そのもの）', () => {
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 0, y: 0 }]), [0, 3640], 'lo自体は分割点でない');
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 3640, y: 0 }]), [0, 3640], 'hi自体は分割点でない');
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 0.2, y: 0 }]), [0, 3640], 'lo+tol未満は端点扱い');
  // 「厳密に内側」＝ちょうどtol分だけ内側の点（lo+tol, hi-tol）も等号側は端点扱い（分割点にしない）。
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 0.5, y: 0 }], 0.5), [0, 3640], 'lo+tolちょうどは端点扱い（不等号は厳密<）');
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 3639.5, y: 0 }], 0.5), [0, 3640], 'hi-tolちょうどは端点扱い（不等号は厳密<）');
});

test('columnSplitPoints: 法線方向の座標がaxisCoordからtol以上外れた点は無視する', () => {
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1820, y: 1000 }], 0.5), [0, 3640], '法線方向1000mm外れ・tol0.5では拾わない');
});

test('【対照】columnSplitPoints: tol指定で法線方向の許容を広げれば拾われる', () => {
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1820, y: 100 }], 0.5), [0, 3640], 'tol=0.5では法線方向100mm外れは拾わない');
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1820, y: 100 }], 150), [0, 1820, 3640], 'tol=150なら拾う');
});

test('columnSplitPoints: run範囲外の点は無視し、tol未満で近接する2点は1点にdedupする', () => {
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: -100, y: 0 }, { x: 5000, y: 0 }]), [0, 3640], '範囲外は無視');
  assert.deepEqual(
    columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: 1820, y: 0 }, { x: 1820.2, y: 0 }]),
    [0, 1820, 3640],
    'tol未満の近接2点は1点にまとまる',
  );
});

test('columnSplitPoints: isVertical=trueの縦runは法線=x・走行=yで判定する（横runとx/yの役割が入れ替わる）', () => {
  assert.deepEqual(
    columnSplitPoints({ lo: 0, hi: 3640 }, 0, true, [{ x: 0, y: 1820 }, { x: 1820, y: 1820 }]),
    [0, 1820, 3640],
    '法線(x)がaxisCoordに一致するx=0の点だけ拾い、走行方向(y)の1820が分割点になる。x=1820の点は法線方向に外れて無視',
  );
});

test('【失敗系】columnSplitPoints: run不正（非数・hi<=lo）・axisCoord非数は空配列、columnPoints省略/null/[]はいずれも[lo,hi]', () => {
  assert.deepEqual(columnSplitPoints(null, 0, false, []), []);
  assert.deepEqual(columnSplitPoints({ lo: NaN, hi: 3640 }, 0, false, []), []);
  assert.deepEqual(columnSplitPoints({ lo: 3640, hi: 0 }, 0, false, []), []);
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 0 }, 0, false, []), []);
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, NaN, false, []), []);
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false), [0, 3640]);
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, null), [0, 3640]);
  assert.deepEqual(columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, []), [0, 3640]);
  // 個々の点が非数混入でも例外を投げず、その点だけ無視する。
  assert.doesNotThrow(() => {
    assert.deepEqual(
      columnSplitPoints({ lo: 0, hi: 3640 }, 0, false, [{ x: NaN, y: 0 }, { x: 1000, y: 0 }]),
      [0, 1000, 3640],
    );
  });
});

// ---- columnSupportBeamCandidates（ステップ3h: 頭つなぎ・受梁の候補区間）----
// segments は {isVertical, coord, lo, hi} のプレーン配列（graph非依存の純関数のためオブジェクトを都度作る）。
test('columnSupportBeamCandidates: 短い方向（縦）が選ばれる', () => {
  // 矩形 x:0..5000, y:0..1000。点(2500,500)は縦方向(支持=横梁y=0,1000。距離1000)が横方向(支持=縦梁x=0,5000。距離5000)より短い。
  const segments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 }, // 横梁 y=0
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 }, // 横梁 y=1000
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 }, // 縦梁 x=0
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 }, // 縦梁 x=5000
  ];
  const points = [{ x: 2500, y: 500, kind: 'below' }];
  const result = columnSupportBeamCandidates(points, segments);
  assert.equal(result.length, 1);
  assert.deepEqual(
    { isVertical: result[0].isVertical, coord: result[0].coord, lo: result[0].lo, hi: result[0].hi },
    { isVertical: true, coord: 2500, lo: 0, hi: 1000 },
    '縦方向(支持間1000)が横方向(支持間5000)より短いため採用',
  );
  assert.equal(result[0].kind, 'below');
});

test('columnSupportBeamCandidates: 総長が同じなら横梁(isVertical:false)を優先する', () => {
  // 正方形の中心(1000,1000)は縦横どちらも支持間2000で同長。
  const segments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 2000 },
    { isVertical: false, coord: 2000, lo: 0, hi: 2000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 2000 },
    { isVertical: true,  coord: 2000, lo: 0, hi: 2000 },
  ];
  const result = columnSupportBeamCandidates([{ x: 1000, y: 1000, kind: 'self' }], segments);
  assert.equal(result.length, 1);
  assert.equal(result[0].isVertical, false, '同長は横梁を優先');
});

test('【失敗系】columnSupportBeamCandidates: 片側にしか支持が無い方向は候補外（もう一方が使えればそちらを返す）', () => {
  // 横梁はy=0のみ（y=1000が無い）→縦方向は片側支持のみで候補外。縦梁x=0,5000は両方あるので横方向は候補になる。
  const segments = [
    { isVertical: false, coord: 0, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 },
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 },
  ];
  const result = columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'below' }], segments);
  assert.equal(result.length, 1);
  assert.equal(result[0].isVertical, false, '縦方向(片側支持)は候補外、横方向だけが残る');
  assert.deepEqual([result[0].lo, result[0].hi], [0, 5000]);
});

test('【失敗系】columnSupportBeamCandidates: 両方向とも片側しか支持が無ければ点自体をスキップする', () => {
  const segments = [
    { isVertical: false, coord: 0, lo: 0, hi: 5000 }, // 横方向の片側のみ
    { isVertical: true,  coord: 0, lo: 0, hi: 1000 }, // 縦方向の片側のみ
  ];
  assert.deepEqual(columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'below' }], segments), []);
});

test('【失敗系】columnSupportBeamCandidates: 既存梁区間の上（平行・直交とも）にある点はno-op（候補にしない）', () => {
  const segments = [
    { isVertical: true,  coord: 0,    lo: 0, hi: 2000 }, // 縦梁 x=0
    { isVertical: false, coord: 0,    lo: 0, hi: 1000 }, // 横梁 y=0
    { isVertical: false, coord: 2000, lo: 0, hi: 1000 },
    { isVertical: true,  coord: 1000, lo: 0, hi: 2000 },
  ];
  assert.deepEqual(columnSupportBeamCandidates([{ x: 0, y: 500, kind: 'below' }], segments), [], '縦梁x=0の上（平行）');
  assert.deepEqual(columnSupportBeamCandidates([{ x: 500, y: 0, kind: 'below' }], segments), [], '横梁y=0の上（直交）');
});

test('【指摘B】columnSupportBeamCandidates: 端点一致だが無支持（L字自由コーナー・単独の梁端）はno-opにせず、Pを含む側へトリムした延長候補を返す', () => {
  const rect = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 },
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 },
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 },
  ];
  // Pは(2500,500)——単独の梁（dangling、x=2500・y:[500,2000]）の端(lo=500)に一致する。旧仕様は
  // 「既存梁区間の上（端点含む）」で無条件no-opだったが、支持なし（supportPoints省略＝[]）の
  // 端点一致は候補評価へ進み、縦方向候補[0,1000]がdanglingと重なるためPを含む側[0,500]へ
  // トリムした延長候補になる。
  const dangling = { isVertical: true, coord: 2500, lo: 500, hi: 2000 };
  const segments = [...rect, dangling];
  const result = columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'self' }], segments);
  assert.equal(result.length, 1, '無支持の端点一致は候補評価へ進む');
  assert.equal(result[0].isVertical, true);
  assert.deepEqual([result[0].lo, result[0].hi], [0, 500]);
  assert.equal(result[0].extendsHiSeg, dangling, 'danglingとの重なりをPを含む側へトリムした延長');
  assert.equal(result[0].extendsLoSeg, null);
});

test('【指摘B】columnSupportBeamCandidates: 端点一致かつsupportPoints（下階柱）に一致する点があればno-op（従来どおり）', () => {
  const rect = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 },
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 },
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 },
  ];
  const dangling = { isVertical: true, coord: 2500, lo: 500, hi: 2000 };
  const segments = [...rect, dangling];
  const supportPoints = [{ x: 2500, y: 500 }]; // Pと同じ位置に下階柱がある＝既に支持済み
  const result = columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'self' }], segments, supportPoints);
  assert.deepEqual(result, [], '端点一致かつsupportPoints一致はno-op');
});

test('【指摘B・T字】columnSupportBeamCandidates: 端点一致でも別の梁の内部（T字）ならno-op（interior判定が優先）', () => {
  const rect = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 },
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 },
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 },
  ];
  const tBeam = { isVertical: false, coord: 500, lo: 0, hi: 5000 }; // y=500。Pはこの内部（T字の受け側）
  const dangling = { isVertical: true, coord: 2500, lo: 500, hi: 2000 }; // Pはこの端
  const result = columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'self' }], [...rect, tBeam, dangling]);
  assert.deepEqual(result, [], 'T字（別梁の内部）はsupportPoints無しでもno-op');
});

test('【指摘B】columnSupportBeamCandidates: 延長トリム後の残りがtol以下ならその方向は候補外（もう一方の方向が候補外なら点自体スキップ）', () => {
  // 縦方向候補窓は[0,1000]（y=0,y=1000の横梁で支持）。Pの along=500 を挟んで同軸(x=2500)に
  // segA[0,499.8]・segB[500.2,1000]の2本があり、トリム後の残りは[499.8,500.2]=0.4mm(<tol=0.5)。
  // 横方向は片側(x=0)しか支持が無く候補外——両方向とも候補外になり点自体がスキップされる。
  const segA = { isVertical: true, coord: 2500, lo: 0,     hi: 499.8 };
  const segB = { isVertical: true, coord: 2500, lo: 500.2, hi: 1000 };
  const segments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 },
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 }, // 横方向は片側支持のみ（x=5000側が無い）
    segA, segB,
  ];
  const result = columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'self' }], segments);
  assert.deepEqual(result, [], '縦方向は残り0.4mm(<tol)で候補外、横方向も片側支持のみで候補外＝点自体スキップ');
});

test('columnSupportBeamCandidates: 同軸の既存梁区間と重なればPを含む側へトリムした延長候補にする、端点一致（隣接）はそのまま延長として許す', () => {
  const base = [
    { isVertical: true, coord: 0,    lo: 0, hi: 2000 },
    { isVertical: true, coord: 3000, lo: 0, hi: 2000 },
  ];
  const point = [{ x: 2000, y: 1000, kind: 'self' }]; // 横方向候補: coord=1000, [loA,hiA]=[0,3000]
  const overlapping = [...base, { isVertical: false, coord: 1000, lo: 500, hi: 1500 }]; // 候補区間の内側に重なる
  // 指摘B（2026-09-18）: 旧仕様は「候補外」だったが、Pを含む側の残り区間（[1500,3000]。P.x=2000は
  // 重なる既存区間[500,1500]より外側＝alongが既存区間のhi側）へトリムし、延長候補として返すよう
  // 変更した（既存区間の延長。woodFraming.js columnSupportBeamCandidatesのJSDoc参照）。
  const overlapResult = columnSupportBeamCandidates(point, overlapping);
  assert.equal(overlapResult.length, 1, '内側に重なる既存梁があれば、Pを含む側の残りへトリムした延長候補になる');
  assert.deepEqual([overlapResult[0].lo, overlapResult[0].hi], [1500, 3000]);
  assert.equal(overlapResult[0].extendsLoSeg?.hi, 1500, 'extendsLoSegは重なった既存区間そのもの（loが延長元のhiへ寄る）');
  assert.equal(overlapResult[0].extendsHiSeg, null);

  const adjacent = [...base, { isVertical: false, coord: 1000, lo: 3000, hi: 4000 }]; // hiA=3000で端点一致
  const result = columnSupportBeamCandidates(point, adjacent);
  assert.equal(result.length, 1, '端点一致（隣接）は延長として許す');
  assert.deepEqual([result[0].lo, result[0].hi], [0, 3000]);
});

test('columnSupportBeamCandidates: 同一線上の2点は同一区間にdedupeされ、loSeg/hiSegは入力segmentsの要素そのもの（===）', () => {
  const yLo = { isVertical: false, coord: 0,    lo: 0, hi: 1000 };
  const yHi = { isVertical: false, coord: 5000, lo: 0, hi: 1000 };
  const segments = [yLo, yHi];
  const points = [{ x: 500, y: 1000, kind: 'below' }, { x: 500, y: 4000, kind: 'below' }];
  const result = columnSupportBeamCandidates(points, segments);
  assert.equal(result.length, 1, '同一区間[0,5000]にdedupeされる');
  assert.equal(result[0].loSeg, yLo, 'loSegは入力segmentsの要素そのもの');
  assert.equal(result[0].hiSeg, yHi, 'hiSegは入力segmentsの要素そのもの');
});

// QA第2巡・(b)・m10: 同一区間へ下階柱(below)と自階柱(self)の両方が到達したら、pointsの並び順で
// 先着したkindが勝つ（dedupeがseenへの先着で決まるため）。woodAutoFill.jsは
// [...belowTiePts, ...selfCarrierPts] の順で渡すため below が self より優先される
// （不変条件・ソース走査テストで固定。本テストは順序依存の性質そのものを固定する）。
test('columnSupportBeamCandidates: 同一区間へ下階柱(below)と自階柱(self)の両方が到達したら先着が勝つ', () => {
  const segments = [
    { isVertical: true, coord: 0,    lo: 0, hi: 2000 },
    { isVertical: true, coord: 3000, lo: 0, hi: 2000 },
  ];
  const belowFirst = [{ x: 500, y: 1000, kind: 'below' }, { x: 1500, y: 1000, kind: 'self' }];
  const r1 = columnSupportBeamCandidates(belowFirst, segments);
  assert.equal(r1.length, 1, '同一区間[0,3000]にdedupeされる');
  assert.equal(r1[0].kind, 'below', 'belowが先着のためbelowが勝つ');

  const selfFirst = [{ x: 1500, y: 1000, kind: 'self' }, { x: 500, y: 1000, kind: 'below' }];
  const r2 = columnSupportBeamCandidates(selfFirst, segments);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].kind, 'self', '逆順ならselfが先着のためselfが勝つ');
});

test('【失敗系】columnSupportBeamCandidates: 非数の点は無視、空入力は空配列、例外を投げない', () => {
  const segments = [
    { isVertical: false, coord: 0,    lo: 0, hi: 5000 },
    { isVertical: false, coord: 1000, lo: 0, hi: 5000 },
    { isVertical: true,  coord: 0,    lo: 0, hi: 1000 },
    { isVertical: true,  coord: 5000, lo: 0, hi: 1000 },
  ];
  assert.deepEqual(columnSupportBeamCandidates([], segments), []);
  assert.deepEqual(columnSupportBeamCandidates(null, segments), []);
  assert.deepEqual(columnSupportBeamCandidates([{ x: NaN, y: 500, kind: 'below' }], segments), []);
  assert.deepEqual(columnSupportBeamCandidates([{ x: 2500, y: NaN, kind: 'below' }], segments), []);
  assert.doesNotThrow(() => columnSupportBeamCandidates([{ x: 2500, y: 500, kind: 'below' }], null));
  assert.doesNotThrow(() => columnSupportBeamCandidates(undefined, undefined));
});

// ---- beamWallCrossPoints（ステップ3h-2: 上階の頭つなぎ・受梁を「壁とみなして」下階の壁と交わる点）----
test('beamWallCrossPoints: 直交する梁区間×壁区間の交点を返す', () => {
  const beams = [{ isVertical: false, coord: 2000, lo: 0, hi: 4000 }]; // 横梁 y=2000（x:0..4000）
  const walls = [{ isVertical: true, coord: 1000, lo: 0, hi: 3000 }];  // 縦壁 x=1000（y:0..3000）
  assert.deepEqual(beamWallCrossPoints(beams, walls), [{ x: 1000, y: 2000 }]);
});

test('beamWallCrossPoints: 梁端が壁区間の内側で終わる点（梁が壁上に載って終わる）も含める', () => {
  const beams = [{ isVertical: false, coord: 0, lo: 0, hi: 2000 }]; // 横梁 y=0（x:0..2000）
  const walls = [{ isVertical: false, coord: 0, lo: 1500, hi: 4000 }]; // 同軸(横壁 y=0)、x:1500..4000
  assert.deepEqual(beamWallCrossPoints(beams, walls), [{ x: 2000, y: 0 }], '梁端(2000)が壁区間[1500,4000]内');
});

test('【失敗系】beamWallCrossPoints: 平行だが別coordは交点なし、範囲外の直交梁も交点なし', () => {
  const beams = [{ isVertical: false, coord: 0, lo: 0, hi: 2000 }];
  const walls = [{ isVertical: false, coord: 500, lo: 0, hi: 2000 }]; // 平行・別coord
  assert.deepEqual(beamWallCrossPoints(beams, walls), []);
  const orthoOutside = [{ isVertical: true, coord: 1000, lo: 3000, hi: 4000 }]; // x=1000は範囲内だがy範囲が梁の外
  assert.deepEqual(beamWallCrossPoints(beams, orthoOutside), []);
});

test('beamWallCrossPoints: tol境界（既定CL_OVERLAP_TOL_MM=0.5mm）は交点扱い、それを超えると交点なし', () => {
  const beams = [{ isVertical: false, coord: 2000, lo: 0, hi: 4000 }];
  const withinTol = [{ isVertical: true, coord: 1000, lo: 2000.5, hi: 3000 }]; // beam.coord=2000, wall.lo-0.5=2000ちょうど
  assert.deepEqual(beamWallCrossPoints(beams, withinTol), [{ x: 1000, y: 2000 }]);
  const beyondTol = [{ isVertical: true, coord: 1000, lo: 2000.6, hi: 3000 }];
  assert.deepEqual(beamWallCrossPoints(beams, beyondTol), []);
  // tol引数を広げれば拾う。
  assert.deepEqual(beamWallCrossPoints(beams, beyondTol, 1), [{ x: 1000, y: 2000 }]);
});

test('beamWallCrossPoints: 複数の交点・同軸端点を重複なく列挙し、x→yの順で決定的にソートする', () => {
  const beams = [
    { isVertical: false, coord: 0, lo: 0, hi: 4000 },
    { isVertical: false, coord: 2000, lo: 0, hi: 4000 },
  ];
  const walls = [
    { isVertical: true, coord: 1000, lo: 0, hi: 4000 },
    { isVertical: true, coord: 3000, lo: 0, hi: 4000 },
  ];
  assert.deepEqual(beamWallCrossPoints(beams, walls), [
    { x: 1000, y: 0 }, { x: 1000, y: 2000 }, { x: 3000, y: 0 }, { x: 3000, y: 2000 },
  ]);
  // 重複（同一点を複数経路で拾う）はdedupeされる。
  const dup = beamWallCrossPoints(
    [{ isVertical: false, coord: 0, lo: 0, hi: 1000 }],
    [{ isVertical: true, coord: 1000, lo: 0, hi: 1000 }, { isVertical: true, coord: 1000, lo: 0, hi: 1000 }],
  );
  assert.deepEqual(dup, [{ x: 1000, y: 0 }]);
});

test('【失敗系】beamWallCrossPoints: 非数混入・空入力は無視して例外を投げない', () => {
  const beams = [{ isVertical: false, coord: 2000, lo: 0, hi: 4000 }];
  const walls = [{ isVertical: true, coord: 1000, lo: 0, hi: 3000 }];
  assert.deepEqual(beamWallCrossPoints([], walls), []);
  assert.deepEqual(beamWallCrossPoints(beams, []), []);
  assert.doesNotThrow(() => beamWallCrossPoints(null, undefined));
  assert.deepEqual(beamWallCrossPoints(null, undefined), []);
  assert.deepEqual(
    beamWallCrossPoints([{ isVertical: false, coord: NaN, lo: 0, hi: 4000 }, ...beams], walls),
    [{ x: 1000, y: 2000 }],
    '非数混入の要素だけ無視する',
  );
});

test('propagateCarrierDepths: 1段伝播（carrierの成をhostへmaxで反映）', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 300, isCarrier: true, hostIds: ['host'] },
    { id: 'host', depth: 240, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('carrier'), 300, 'carrier自身の成は不変');
  assert.equal(result.get('host'), 300, 'hostの成はcarrierと同寸へ上がる');
});

test('propagateCarrierDepths: 多段伝播（hostのhostまで、伝播元がcarrierかどうかは問わない）', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 360, isCarrier: true, hostIds: ['host1'] },
    { id: 'host1', depth: 240, isCarrier: false, hostIds: ['host2'] },
    { id: 'host2', depth: 120, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host1'), 360, 'carrierから直接伝播');
  assert.equal(result.get('host2'), 360, 'host1が上がった分がさらにhost2へ伝播（荷重経路を辿る）');
});

test('propagateCarrierDepths: hostのほうが元々大きければ据え置き', () => {
  const result = propagateCarrierDepths([
    { id: 'carrier', depth: 240, isCarrier: true, hostIds: ['host'] },
    { id: 'host', depth: 300, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host'), 300, 'carrierより大きいhostの成は下げない');
});

test('propagateCarrierDepths: isCarrier=falseのノードは起点にならない（同じ成・hostIdsでも伝播しない）', () => {
  const result = propagateCarrierDepths([
    { id: 'notCarrier', depth: 300, isCarrier: false, hostIds: ['host'] },
    { id: 'host', depth: 120, isCarrier: false, hostIds: [] },
  ]);
  assert.equal(result.get('host'), 120, 'carrierでない梁からは伝播しない');
});

test('propagateCarrierDepths: 循環（A→B→A）があっても停止し、両者ともmaxの成に収束する', () => {
  const result = propagateCarrierDepths([
    { id: 'a', depth: 300, isCarrier: true, hostIds: ['b'] },
    { id: 'b', depth: 120, isCarrier: false, hostIds: ['a'] },
  ]);
  assert.equal(result.get('a'), 300);
  assert.equal(result.get('b'), 300);
});

test('【失敗系】propagateCarrierDepths: 未知hostId・非数depthは無視し例外を投げない', () => {
  assert.doesNotThrow(() => {
    const result = propagateCarrierDepths([
      { id: 'carrier', depth: 300, isCarrier: true, hostIds: ['missing', 'host'] },
      { id: 'host', depth: 120, isCarrier: false, hostIds: [] },
      { id: 'nanDepth', depth: NaN, isCarrier: true, hostIds: ['host'] },
    ]);
    assert.equal(result.get('host'), 300, '未知hostIdは無視しつつ、存在するhostへは伝播する');
    assert.equal(result.has('nanDepth'), false, '非数depthのノードは結果に含めない');
    assert.equal(result.has('missing'), false);
  });
  assert.deepEqual([...propagateCarrierDepths([]).entries()], []);
  assert.deepEqual([...propagateCarrierDepths(null).entries()], []);
});

test('studPositions: AB間の両端に (L − (商−1)×455)/2 をとり、残りを455で割り付ける（位置は材の中心）', () => {
  // L=2730: 商=6 → 内側5ピッチ=2275、両端=(2730−2275)/2=227.5
  assert.deepEqual(studPositions(2730), [227.5, 682.5, 1137.5, 1592.5, 2047.5, 2502.5]);
  // L=1820: 商=4 → 内側3ピッチ=1365、両端=227.5
  assert.deepEqual(studPositions(1820), [227.5, 682.5, 1137.5, 1592.5]);
  // ピッチ違い（外壁の「縦下地間隔」変更）: L=1820, p=303 → 商=6 → 内側5×303=1515、両端=152.5
  assert.deepEqual(studPositions(1820, 303), [152.5, 455.5, 758.5, 1061.5, 1364.5, 1667.5]);
  // 対称性: 最初と最後の位置は両端から同じ距離。材厚（studSpec.depth）には依存しない。
  const p = studPositions(3000);
  assert.ok(Math.abs(p[0] - (3000 - p[p.length - 1])) < 1e-9);
  assert.equal(TRADITIONAL_WOOD_BACKING.studPitchMm, 455, '既定ピッチ455');
});

test('【失敗系】studPositions: 距離が2ピッチ未満は中央1本、0以下・非数・ピッチ0以下は空配列', () => {
  assert.deepEqual(studPositions(900), [450]);   // 商=1 → 内側0ピッチ → 中央
  assert.deepEqual(studPositions(300), [150]);   // 商=0 → 中央1本（0本にはしない）
  assert.deepEqual(studPositions(0), []);
  assert.deepEqual(studPositions(-1), []);
  assert.deepEqual(studPositions(NaN), []);
  assert.deepEqual(studPositions(1820, 0), []);
});

test('studSpec / openingJambSpec: 壁下地＝柱寸×30、外壁アルミ窓の袖＝柱寸×45・扉の袖＝柱同寸、クリアランス5', () => {
  assert.deepEqual(studSpec(120), { width: 120, depth: 30 });
  assert.deepEqual(openingJambSpec('window', 120), { width: 120, depth: 45, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 120), { width: 120, depth: 120, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 105), { width: 105, depth: 105, clearanceMm: 5 });
});

test('【失敗系】studSpec / openingJambSpec: 未知の種別・柱寸が非数/0以下は null', () => {
  assert.equal(studSpec(0), null);
  assert.equal(studSpec(NaN), null);
  assert.equal(openingJambSpec('shutter', 120), null);
  assert.equal(openingJambSpec('window', 0), null);
  assert.equal(openingJambSpec('window', NaN), null);
});

test('jambAxisValue: 建具の袖柱1本の走行方向座標＝開口の外形からclearance+柱寸/2だけ離れた位置', () => {
  assert.equal(jambAxisValue(-1, 1550, 2450, 120), 1485, 'lo側: 1550-(5+60)');
  assert.equal(jambAxisValue(1, 1550, 2450, 120), 2515, 'hi側: 2450+(5+60)');
  assert.equal(jambAxisValue(-1, 1550, 2450, 120, 0), 1490, 'クリアランス0: 1550-60');
  assert.equal(jambAxisValue(-1, 1550, 2450, 105), 1492.5, '柱寸105: 1550-(5+52.5)');
});

test('【失敗系】jambAxisValue: lo>=hi・非数・柱寸/クリアランス不正はnull', () => {
  assert.equal(jambAxisValue(-1, 2450, 1550, 120), null, 'lo>hi');
  assert.equal(jambAxisValue(-1, 1550, 1550, 120), null, 'lo===hi');
  assert.equal(jambAxisValue(-1, NaN, 2450, 120), null);
  assert.equal(jambAxisValue(-1, 1550, 2450, 0), null, '柱寸0');
  assert.equal(jambAxisValue(-1, 1550, 2450, -10), null, '柱寸負');
  assert.equal(jambAxisValue(-1, 1550, 2450, 120, -1), null, 'クリアランス負');
  assert.equal(jambAxisValue(-1, 1550, 2450, NaN), null);
});

test('jambColumnPositions: 開口ごとに両袖(side:-1,1)の座標を返す', () => {
  const result = jambColumnPositions([{ id: 'o1', lo: 1550, hi: 2450 }], 120);
  assert.deepEqual(result, [
    { id: 'o1', side: -1, jamb: 1485 },
    { id: 'o1', side: 1, jamb: 2515 },
  ]);
});

test('【失敗系】jambColumnPositions: 不正な開口要素は静かにスキップする（例外を投げない）', () => {
  assert.deepEqual(jambColumnPositions(null, 120), []);
  assert.deepEqual(jambColumnPositions(undefined, 120), []);
  assert.deepEqual(jambColumnPositions([null, { id: 'x', lo: NaN, hi: 100 }], 120), [], 'lo非数の開口はjambAxisValueがnullを返しどちらのsideも積まれない');
  assert.deepEqual(jambColumnPositions([{ lo: 1550, hi: 2450 }], 120), [], 'idの無い要素はスキップ');
});

test('rectsOverlap: 辺が接するだけは重なりなし、1mmでも重なれば重なりあり', () => {
  const a = { xLo: 0, xHi: 100, yLo: 0, yHi: 100 };
  const touching = { xLo: 100, xHi: 200, yLo: 0, yHi: 100 };
  assert.equal(rectsOverlap(a, touching), false, '辺が接するだけは重なりなし');
  const overlap1mm = { xLo: 99, xHi: 199, yLo: 0, yHi: 100 };
  assert.equal(rectsOverlap(a, overlap1mm), true, '1mmの重なりはtrue');
  assert.equal(rectsOverlap(a, overlap1mm, 1), false, 'tol=1を指定すると1mm以下の重なりは無視される');
});

test('entranceOpeningWidthMm: 玄関建具部分の基礎・両袖取付柱の開口＝扉幅＋両端5mm（既定はルール値）', () => {
  assert.equal(entranceOpeningWidthMm(900), 910);
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.entranceClearanceMm, 5);
  assert.equal(entranceOpeningWidthMm(900, 10), 920);
  assert.equal(entranceOpeningWidthMm(0), null);
  assert.equal(entranceOpeningWidthMm(900, -1), null);
});

test('sillTopLevelOffsetMm: 土台天端はFL-100（梁天端beamTopBelowFLMmと同じ値を共有。既定引数は在来木造のframing）', () => {
  assert.equal(sillTopLevelOffsetMm(), -100);
  assert.equal(sillTopLevelOffsetMm(TRADITIONAL_WOOD_FRAMING), -TRADITIONAL_WOOD_FRAMING.beamTopBelowFLMm);
  assert.equal(sillTopLevelOffsetMm({ beamTopBelowFLMm: 80 }), -80, '値を変えれば追従する');
});

test('【失敗系】sillTopLevelOffsetMm: framingがnull（非在来）・beamTopBelowFLMmが非数なら null', () => {
  assert.equal(sillTopLevelOffsetMm(null), null);
  assert.equal(sillTopLevelOffsetMm({ beamTopBelowFLMm: NaN }), null);
  assert.equal(sillTopLevelOffsetMm({}), null);
});

test('hipBraceAllowed: 16㎡以下の四角は可、吹抜け(VOID)は可、階段(STAIR)・階段吹抜け(STAIR_VOID)・削除済み(UNDEFINED)・非四角・16㎡超は不可', () => {
  assert.equal(hipBraceAllowed({ areaM2: 16, isRectangle: true }), true);
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.VOID }), true, '吹抜けには設置可能');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR }), false, '階段内は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR_VOID }), false, '階段吹抜けも階段内');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.UNDEFINED }), false, '削除済み部屋は床なし');
  assert.equal(hipBraceAllowed({ areaM2: 16.01, isRectangle: true }), false, '16㎡超は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: false }), false, '四角でなければ不可');
  assert.equal(hipBraceAllowed({ areaM2: 0, isRectangle: true }), false);
  assert.equal(TRADITIONAL_WOOD_FRAMING.hipBraceMaxAreaM2, 16);
});

test('【失敗系】hipBraceAllowed: cell が undefined/null でも例外を投げず false', () => {
  assert.equal(hipBraceAllowed(undefined), false);
  assert.equal(hipBraceAllowed(null), false);
});

test('structureRules: 在来木造だけが framing/backing を持ち、柱120角・梁既定＝柱同寸・梁天端FL−100・床梁1820・下地455等の値を返す', () => {
  const r = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(r.defaultSections.column, 'WOOD-120x120');
  assert.equal(r.defaultSections.beam, r.framing.columnSection, '梁の既定断面は柱同寸の正角');
  assert.equal(r.framing.beamTopBelowFLMm, 100);
  assert.equal(r.framing.floorBeamMaxPitchMm, 1820);
  assert.equal(r.backing.studDepthMm, 30);
  assert.equal(r.framing.sillPackingThicknessMm, 20, 'ネコ土台の厚み');
  assert.equal(r.foundation.sectionDefaults.baseWidth, 600);
  for (const key of ['木造（2"×4"）', 'S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', '未定']) {
    assert.equal(rulesFor(key).framing, null, `${key} は framing を持たない`);
    assert.equal(rulesFor(key).backing, null, `${key} は backing を持たない`);
  }
  assert.equal(rulesFor('木造（2"×4"）').defaultSections.column, 'WOOD-105x105', '2×4の既定断面は変えない');
});

test('wallRunFaces: 下地区間を壁上の柱区間で面（2点間）に分け、柱で終わる端に印を付ける', () => {
  // 柱 [-60,60]（区間の始端に柱面が接する＝T字の相手壁上の柱）・[1760,1880]・[3580,3700]
  assert.deepEqual(wallRunFaces(60, 3700, [[1760, 1880], [-60, 60], [3580, 3700]]), [
    { lo: 60, hi: 1760, columnAtLo: true, columnAtHi: true },
    { lo: 1880, hi: 3580, columnAtLo: true, columnAtHi: true },
  ]);
  // 開口の縁で終わる区間（柱なし）は両端とも false
  assert.deepEqual(wallRunFaces(2803, 3553, [[-60, 60], [3580, 3700]]),
    [{ lo: 2803, hi: 3553, columnAtLo: false, columnAtHi: false }]);
  // 区間の途中で始まる／終わる柱は面の端を柱面へ寄せる
  assert.deepEqual(wallRunFaces(0, 1000, [[900, 1020]]), [{ lo: 0, hi: 900, columnAtLo: false, columnAtHi: true }]);
  assert.deepEqual(wallRunFaces(0, 1000, [[-20, 100]]), [{ lo: 100, hi: 1000, columnAtLo: true, columnAtHi: false }]);
});

test('【失敗系】wallRunFaces: 幅0以下の区間は空、区間外・不正な柱区間は無視、柱に覆い尽くされた区間は面なし', () => {
  assert.deepEqual(wallRunFaces(100, 100, [[0, 50]]), []);
  assert.deepEqual(wallRunFaces(NaN, 100, []), []);
  assert.deepEqual(wallRunFaces(0, 1000, [[2000, 2120], [NaN, 10], [500, 400]]),
    [{ lo: 0, hi: 1000, columnAtLo: false, columnAtHi: false }]);
  assert.deepEqual(wallRunFaces(0, 100, [[-10, 110]]), []);
  assert.deepEqual(wallRunFaces(0, 100, null), [{ lo: 0, hi: 100, columnAtLo: false, columnAtHi: false }]);
});

test('faceStudPositions: 柱で終わる端は柱面から10mmクリアランスの端部材（中心25）、内側は面の全長を455で割付', () => {
  // L=1700（柱面〜柱面）: 商3 → 内側2ピッチ=910、両端395 → 395/850/1305 ＋ 端部材 25/1675
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }), [25, 395, 850, 1305, 1675]);
  // 片側だけ柱（もう一方は開口の縁）: 端部材は柱側だけ
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true }), [25, 395, 850, 1305]);
  assert.deepEqual(faceStudPositions(1700, { columnAtHi: true }), [395, 850, 1305, 1675]);
  // 柱なし（両端とも開口の縁など）は studPositions のまま
  assert.deepEqual(faceStudPositions(1700, {}), studPositions(1700));
  // 値はルール（クリアランス10・材厚30・ピッチ455）から
  assert.equal(TRADITIONAL_WOOD_BACKING.studColumnClearanceMm, 10);
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }, { clearanceMm: 20, depthMm: 40 }),
    [40, 395, 850, 1305, 1660]);
  // ピッチ違い（外壁の「縦下地間隔」）: L=1700, p=303 → 商5 → 内側4×303=1212、両端244
  assert.deepEqual(faceStudPositions(1700, { columnAtLo: true, columnAtHi: true }, { pitchMm: 303 }),
    [25, 244, 547, 850, 1153, 1456, 1675]);
});

test('【失敗系】faceStudPositions: 端部材と重なる割付材は落とす、端部材が入らない短い面は空、非数・0以下は空', () => {
  // L=100: 端部材 25/75、中央の割付材50は端部材と重なる（材厚30）ので落とす
  assert.deepEqual(faceStudPositions(100, { columnAtLo: true, columnAtHi: true }), [25, 75]);
  // L=70: 端部材は片側（25）だけ入る（もう一方 70-40=30 < 40 で重なる）
  assert.deepEqual(faceStudPositions(70, { columnAtLo: true, columnAtHi: true }), [25]);
  // L=30: 端部材（クリアランス10＋材厚30=40）が入らない → 割付材の中央15は面に収まる
  assert.deepEqual(faceStudPositions(30, { columnAtLo: true, columnAtHi: true }), [15]);
  assert.deepEqual(faceStudPositions(13, { columnAtLo: true, columnAtHi: false }), []);
  assert.deepEqual(faceStudPositions(0, { columnAtLo: true }), []);
  assert.deepEqual(faceStudPositions(NaN, {}), []);
  assert.deepEqual(faceStudPositions(1700, {}, { depthMm: 0 }), []);
  assert.deepEqual(faceStudPositions(1700, {}, { clearanceMm: -1 }), []);
});

// ================================================================
// supportSpanColumnPositions（ステップ3i・2026-09-19）: 梁の支持長が1820を超える区間へ柱を足す位置。
// 既定 maxSpanMm=1820・gridPitchMm=910・tol=CL_OVERLAP_TOL_MM(0.5)。
// ================================================================

test('supportSpanColumnPositions: 支持長が1820以下の区間には何も足さない', () => {
  assert.deepEqual(supportSpanColumnPositions([0, 1820], [], () => true), []);
  assert.deepEqual(supportSpanColumnPositions([0, 1000], [], () => true), []);
});

test('supportSpanColumnPositions: 支持長3640は中央(1820)に1本。直交CLがあればそこを使う', () => {
  assert.deepEqual(
    supportSpanColumnPositions([0, 3640], [1820], () => true),
    [{ along: 1820, kind: 'struct' }], '数値のみのclAlongsは優先度struct扱い（後方互換）');
});

test('supportSpanColumnPositions: CLを優先し、窓内にCLが無ければ910グリッドへフォールバックする', () => {
  // span=3000: 理想位置1500、採用窓[1180,1955]（CLが窓内にあれば理想との距離に関わらずCLを優先する）。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [1550], () => true),
    [{ along: 1550, kind: 'struct' }], 'CLが窓内にあればグリッド候補(1820)より優先される');
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [], () => true),
    [{ along: 1820, kind: 'grid' }], 'CLが無ければ910グリッド（窓内で理想1500に最も近い1820）');
});

test('supportSpanColumnPositions（QA裁定2026-09-19）: 窓内に通り芯(struct)と意匠中心線(center)が両方あれば通り芯を優先する（距離で横断比較しない）', () => {
  // span=3000: 実行可能範囲[1180,1820]（n=2,i=1: feasLo=max(tol,3000-1820)=1180,
  // feasHi=min(1820,3000-tol)=1820）。center(1560)の方がstruct(1200)よりideal(1500)に近いが、
  // struct群に1件でもあればcenter群は見ない。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [{ along: 1560, priority: 'center' }, { along: 1200, priority: 'struct' }], () => true),
    [{ along: 1200, kind: 'struct' }], '距離はcenter(1560)の方が近いが、struct(1200)が優先される');
  // structが範囲外・isAllowedで不可・存在しない場合はcenterへフォールバック。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [{ along: 1560, priority: 'center' }], () => true),
    [{ along: 1560, kind: 'center' }], 'structが無ければcenterを使う');
  // center・structともに実行不可能／isAllowed不可なら910グリッドへ（グリッドだけideal±455の窓で絞る）。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [{ along: 1560, priority: 'center' }], v => v !== 1560),
    [{ along: 1820, kind: 'grid' }], 'centerもisAllowedで不可ならグリッドへ');
});

test('supportSpanColumnPositions（QA裁定2026-09-19・実行可能範囲）: 基準線は等分位置から離れていても支持長を1820以下に保てる位置なら採る（moku3実測の再現）', () => {
  // span=2604（moku3 V x=9100 [-9884..-7280]相当。n=2,i=1）: ideal=1302、実行可能範囲は
  // [784,1820]（feasLo=max(tol,2604-1820)=784, feasHi=min(1820,2604-tol)=1820）。
  // struct(784)はideal(1302)から518mm離れ、旧実装の窓（ideal±455=[847,1757]）の外だったが、
  // 実行可能範囲[784,1820]には入るため採用される——「支持長を1820以下に保てる位置に通り芯・中心線が
  // あれば、等分位置から離れていてもそこを優先する」というユーザー仕様どおり。
  assert.deepEqual(
    supportSpanColumnPositions([0, 2604], [{ along: 784, priority: 'struct' }, { along: 1694, priority: 'center' }], () => true),
    [{ along: 784, kind: 'struct' }], '等分位置(1302)から518mm離れたstruct(784)でも実行可能なら優先採用される');
  // structが実行不可能な位置（600。残りの区間が2604-600=2004>1820になり支持長を満たせない）なら、
  // 実行可能なcenter(1694)へフォールバックする。
  assert.deepEqual(
    supportSpanColumnPositions([0, 2604], [{ along: 600, priority: 'struct' }, { along: 1694, priority: 'center' }], () => true),
    [{ along: 1694, kind: 'center' }], 'structが実行不可能(600)ならcenter(1694)を使う');
  // struct・centerとも実行不可能な位置なら910グリッドへ（グリッドの窓はideal±455のまま）。
  assert.deepEqual(
    supportSpanColumnPositions([0, 2604], [{ along: 600, priority: 'struct' }, { along: 2500, priority: 'center' }], () => true),
    [{ along: 910, kind: 'grid' }], 'struct(600)・center(2500)とも実行不可能なら910グリッドへ（ideal=1302に最も近い910）');
});

test('【失敗系】supportSpanColumnPositions: clAlongsの不正要素（along非数・priority未知）は無視する', () => {
  assert.deepEqual(
    supportSpanColumnPositions([0, 3640], [{ along: NaN, priority: 'struct' }, { along: 1820, priority: 'unknown' }, 'x', null], () => true),
    [{ along: 1820, kind: 'grid' }], '不正な要素は無視され910グリッドへフォールバックする');
});

test('supportSpanColumnPositions: 支持長2000は910グリッド1本だけ（180mmの端数ピースを作らない）', () => {
  const result = supportSpanColumnPositions([0, 2000], [], () => true);
  assert.deepEqual(result, [{ along: 910, kind: 'grid' }]);
  assert.ok(result[0].along >= 180 + 0.5, '端の180mm片ぎりぎりの位置を選ばない');
});

test('【失敗系】supportSpanColumnPositions: isAllowedが常にfalseなら候補が無いため空', () => {
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [1820], () => false), []);
  assert.deepEqual(supportSpanColumnPositions([0, 3000], [1550], () => false), []);
});

test('supportSpanColumnPositions: 一部の理想位置がisAllowedで不可でも、attemptを増やして分割し直す', () => {
  // span=3640・attempt=2（中央1820のみ）はisAllowedで拒否されるため、attempt=3（910・2730）へ増える。
  const isAllowed = v => Math.abs(v - 1820) > 1;
  assert.deepEqual(
    supportSpanColumnPositions([0, 3640], [], isAllowed),
    [{ along: 910, kind: 'grid' }, { along: 2730, kind: 'grid' }]);
});

test('【失敗系】supportSpanColumnPositions: どのattempt（n, n+1, n+2）でも1820以下に分割しきれない場合は、最後に試したattemptの部分的な結果を返す（0本より縮む方を優先）', () => {
  // span=5460（n=3）: isAllowedがv<=2500だけを許すため、2500超の位置（1820超のグリッド）は使えず、
  // attempt=3,4,5のいずれも全ピース1820以下にはならないが、見つかった範囲までは柱を追加する。
  const isAllowed = v => v <= 2500;
  const result = supportSpanColumnPositions([0, 5460], [], isAllowed);
  assert.deepEqual(result, [{ along: 910, kind: 'grid' }, { along: 1820, kind: 'grid' }],
    '見つけられた範囲（910・1820）までは柱を追加し、2500超で見つからない残りは支持長が長いまま（3dが大きい成を引く）');
});

test('【失敗系】supportSpanColumnPositions: 支持点が2点未満・非数混入は空', () => {
  assert.deepEqual(supportSpanColumnPositions([], [1820], () => true), []);
  assert.deepEqual(supportSpanColumnPositions([1000], [1820], () => true), []);
  assert.deepEqual(supportSpanColumnPositions([0, NaN, 3640], [1820], () => true), []);
  // dedupe後に1点未満になる場合も同様（tol=0.5未満は同一点）。
  assert.deepEqual(supportSpanColumnPositions([1000, 1000.2], [1820], () => true), []);
});

test('【失敗系】supportSpanColumnPositions: 候補（CL・グリッドとも）が窓内に1つも無ければ空（例外を投げない）', () => {
  // gridPitchMmを極端に大きくすると、窓[1820,1820]に910刻みの格子点が1つも入らない。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3640], [], () => true, { gridPitchMm: 100000 }),
    []);
});

test('supportSpanColumnPositions: 支持長が1820の倍数ちょうどで採用窓が1点に退化する（QA指摘・回帰固定）', () => {
  // span=3640: 窓[1820,1820]（1点）。struct候補1821は窓外なので使われずグリッド1820が採用される。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3640], [1821], () => true),
    [{ along: 1820, kind: 'grid' }]);
  // span=5460（=3×1820）: attempt=3で1820・3640ともグリッド（窓がそれぞれ1点に退化）。
  assert.deepEqual(
    supportSpanColumnPositions([0, 5460], [], () => true),
    [{ along: 1820, kind: 'grid' }, { along: 3640, kind: 'grid' }]);
});

test('supportSpanColumnPositions: 同距離のタイは小さい座標を優先する（struct候補・グリッド候補とも）', () => {
  // span=3000: ideal=1500、窓[1180,1955]。struct候補1250・1750は理想からの距離が同じ(250)。
  assert.deepEqual(
    supportSpanColumnPositions([0, 3000], [{ along: 1250, priority: 'struct' }, { along: 1750, priority: 'struct' }], () => true),
    [{ along: 1250, kind: 'struct' }], '同距離のstruct候補は小さい座標(1250)を優先');
});

test('【失敗系】supportSpanColumnPositions: clAlongsがnullでも例外を投げずグリッドへフォールバックする', () => {
  assert.deepEqual(supportSpanColumnPositions([0, 3640], null, () => true), [{ along: 1820, kind: 'grid' }]);
});

test('【失敗系】supportSpanColumnPositions: opts不正（maxSpanMm<=0・gridPitchMm非数/負・tol負）は空', () => {
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [], () => true, { maxSpanMm: 0 }), []);
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [], () => true, { maxSpanMm: -100 }), []);
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [], () => true, { gridPitchMm: NaN }), []);
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [], () => true, { gridPitchMm: -1 }), []);
  assert.deepEqual(supportSpanColumnPositions([0, 3640], [], () => true, { tol: -1 }), []);
});

// ================================================================
// mergePrimaryBeamRuns（QA裁定2026-09-19・Major-1）: role:'primary'の区間を同軸でrunへ束ね直す。
// floor等は素通し。3iの収束先が階の処理順に依存する不具合の是正（下階柱による分割点を「梁端」から
// 除くことで、点源が下階柱の増減と無関係な静的な量になる）。
// ================================================================

test('mergePrimaryBeamRuns: 同軸で端が接する2区間（下階柱による分割相当）を1本のrunへ束ね直す', () => {
  const segs = [
    { isVertical: true, coord: 9100, lo: -9884, hi: -9100, role: 'primary' },
    { isVertical: true, coord: 9100, lo: -9100, hi: -7280, role: 'primary' },
  ];
  assert.deepEqual(mergePrimaryBeamRuns(segs), [
    { isVertical: true, coord: 9100, lo: -9884, hi: -7280, role: 'primary' },
  ]);
});

test('mergePrimaryBeamRuns: 隙間tol以下・重なりも連結し、別軸・別coordは束ねない。floorはそのまま素通しする', () => {
  const segs = [
    { isVertical: true, coord: 0, lo: 0, hi: 1000, role: 'primary' },
    { isVertical: true, coord: 0, lo: 999.8, hi: 2000, role: 'primary' }, // 0.2mm重なり=tol以内
    { isVertical: true, coord: 3640, lo: 0, hi: 1000, role: 'primary' },  // 別coord
    { isVertical: false, coord: 0, lo: 0, hi: 1000, role: 'primary' },    // 別軸(isVertical違い)
    { isVertical: true, coord: 0, lo: 5000, hi: 6000, role: 'floor' },    // floorは素通し
  ];
  const result = mergePrimaryBeamRuns(segs);
  const primaries = result.filter(s => s.role === 'primary').sort((a, b) => a.coord - b.coord || a.lo - b.lo);
  assert.deepEqual(primaries, [
    { isVertical: true, coord: 0, lo: 0, hi: 2000, role: 'primary' },
    { isVertical: false, coord: 0, lo: 0, hi: 1000, role: 'primary' },
    { isVertical: true, coord: 3640, lo: 0, hi: 1000, role: 'primary' },
  ].sort((a, b) => a.coord - b.coord || a.lo - b.lo));
  assert.deepEqual(result.filter(s => s.role === 'floor'), [{ isVertical: true, coord: 0, lo: 5000, hi: 6000, role: 'floor' }]);
});

test('【失敗系】mergePrimaryBeamRuns: 非数混入・null/undefined要素・空/未指定入力は無視して例外を投げない', () => {
  assert.deepEqual(mergePrimaryBeamRuns([]), []);
  assert.deepEqual(mergePrimaryBeamRuns(undefined), []);
  assert.deepEqual(mergePrimaryBeamRuns(null), []);
  assert.deepEqual(mergePrimaryBeamRuns([
    null, undefined,
    { isVertical: true, coord: NaN, lo: 0, hi: 100, role: 'primary' },
    { isVertical: true, coord: 0, lo: NaN, hi: 100, role: 'primary' },
    { isVertical: true, coord: 0, lo: 0, hi: 100, role: 'primary' },
  ]), [{ isVertical: true, coord: 0, lo: 0, hi: 100, role: 'primary' }]);
});
