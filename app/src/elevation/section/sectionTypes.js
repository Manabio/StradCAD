/**
 * 2.5D断面エンジン: 型定義（JSDoc）・world↔断面ローカルx・z↔描画y変換（純関数のみ）。
 * 設計意図は architect承認済みの実装指示書（section-engine-design.md。タスク発注時の
 * スクラッチパスに格納。§番号はそちらを参照）参照。関連する現行仕様は
 * .claude/elevation-model.md「階をまたぐ2層帯」節。
 *
 * WP-E1（sectionTypes.js + sectionProbe.js）。WP-E5bでelevationStairSequence.js/
 * sectionStair.js/switchbackCuts.jsから呼ばれるようになった。純モジュール不変条件
 * （store.js/snap.js/*.jsx/react-konva/appViewport.js を静的importしない）を維持する。
 *
 * 高さはこのモジュール以下すべて「絶対z（上が正・設置階FL=0基準）」で扱い、プリミティブ化の
 * 最後（sectionEmit.js）でのみ y=-z へ変換する（§2項目6）。
 */
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

/**
 * @typedef {{ isVertical:boolean, axisValue:number, lo:number, hi:number }} CutLine
 *   既存faceの (isVertical, axisCL.value, lo, hi) と同型。isVertical=trueは切断線自身が
 *   固定X（axisValue）・Y方向(lo..hi)に伸びることを表す（faceの規約と同じ）。
 *   probeExtendLo/HiMm（任意）… 壁のない端部で図の外へ伸ばす量。`cutDrawRange`の情報源。
 *   unionExtendLo/HiMm（任意。既定=probeExtendLo/HiMm）… **探査だけ**を広げる量＝全層の
 *   探査窓（`SectionCut.layerRunWindows`）の和。層ごとに面の端が違うため（下記）、実際に
 *   レイキャストする範囲は`cutDrawRange`より広くなりうる。
 */

/**
 * @typedef {{
 *   seqNo: string,
 *   line: CutLine,
 *   viewSign: 1|-1,
 *   dirSign: 1|-1,
 *   layers: Array<{graph:object, floorZMm:number, role:'self'|'above'|'below'}>,
 *   zRange: {loZ:number, hiZ:number},
 *   baseFloorZ: number,
 *   stairCut?: object,
 *   airRoom?: object,
 *   underRooms?: Set<object>,
 *   layerRunWindows?: Map<object,{lo:number,hi:number}>,
 *   floorZProfile?: Array<{loX:number, hiX:number, floorZ:number}>,
 *   chDimSplitAbsYs?: number[],
 *   anchorRoom?: object,
 * }} SectionCut
 *   airRoom（任意。展開図一般化Phase 6）… その帯自身の空気ボリュームを代表するRoom
 *   （階段帯なら階段室。`section/cuts/switchbackCuts.js`が設定）。
 *   underRooms（任意。展開図一般化Phase 6）… 階段下に指定された部屋の集合（同上が設定）。
 *   `section/sectionHits.js`の`isHiddenWall`が、壁の両側のセルのRoomを見て、片側だけが
 *   `underRooms`に含まれ、かつその反対側が`airRoom`の連結成分と一致する壁を「実体ごと見ない」
 *   （階段下の閉じた部屋の壁は階段帯から見えない）判定に使う。どちらも未指定なら常に非隠蔽
 *   （従来どおり全ての壁が見える）。
 *   layerRunWindows（任意）… 層 → その層を探査してよい走り方向の世界範囲。**面の端は層ごとに
 *   違う**（自階の面は自階の壁で終わるが、同じ通りの上階の壁はその先へ続きうる）ことを表す
 *   付加データで、`cut.layers`配列自体は写さない（参照同一性とprobeCtxのキャッシュを壊さない）。
 *   生成は`sectionContent.js`の`withProbeExtension`、消費は`sectionProbe.js`。
 *   floorZProfile（任意）… `ceilProfile`の床側の双子（区間ごとの床断面高さ・断面ローカルx）。
 *   下階の層への探査窓のgate（`sectionContent.js`の`planeOverhangForFace`）だけが読む。
 *   layers[].ceilZMm（任意）… その層の天井z。**下階の層**のgateで「帯の床がその層の天井より
 *   下か」を見るために呼び出し側（帯）が載せる（層の部屋のCHは帯しか知らない）。
 */

/**
 * @typedef {{
 *   kind: 'cut'|'cutAlong'|'wall'|'open'|'slab'|'farVoid'|'hidden',
 *   z0:number, z1:number,
 *   wall?:object, layerRole?:string, distMm?:number, ownerRoom?:object,
 *   floorZ?:number, ceilZ?:number, thicknessMm?:number,
 *   nearEdgeOpen?:boolean, farEdgeOpen?:boolean,
 *   openingPassThrough?:boolean,
 *   farFloorZ?:number|null, farCeilZ?:number|null, farDepthMm?:number,
 * }} ZBand
 *   hidden（展開図一般化Phase 6b-2。`sectionHits.js`の`isHiddenWall`該当の実体）＝
 *   「そこに壁は実在するが描かない」区間。`wall`/`distMm`/`openingPassThrough`/`far*`等の
 *   付帯情報は一切持たない（他kindと違い実体の詳細を渡さない、という宣言そのもの）。
 *   `open`（アキ）とは別kind——アキのバツ・見えがかり線の対象にならず、かつ`overCutWall`
 *   （切断壁の天端の上はアキではない、の判定）にも当たらない独立したkindとして扱う。
 *   slab=床スラブ・天井懐（今回は非描画）。z0<z1（絶対z）。
 *   farVoid（Phase4。`elevationStyle.js`の`HORIZONTAL_FACES_ENABLED`。裁定済み2026-09-11・
 *   既定on）＝floorFace/ceilFaceより向こう側（向こうの部屋の天井懐・床構造）の非描画区間。
 *   slabと同じ「非描画」だが実体の所有者情報（ownerRoom/floorZ/ceilZ）を持たないため別kindにした
 *   （`sectionEngine.js`の`splitOpenByFarFace`が生成。`emitColumns`/`emitOpenGapMarks`はどちらも
 *   `'open'`しか見ないため、このkindは自動的に「線を描かずアキにもしない」）。
 *   `open`のfarFloorZ/farCeilZ/farDepthMm（Phase4）＝`sectionHits.js`の`visibleBandsOf`が
 *   付帯情報として載せる「上限内の最も近いfloorFace/ceilFaceのzと深度」（`splitOpenByFarFace`の
 *   入力）。フラグoffでは常にundefined。
 */

/**
 * @typedef {{ x0:number, x1:number, worldLo:number, worldHi:number,
 *   bands:ZBand[], loCLId?:string, hiCLId?:string }} SectionColumn
 */

/**
 * その列に「z（＝上階のFL）からそのまま立ち上がる切断壁」の帯があるか。
 *
 * 「上階の床の断面線は、境界に立つ切断壁の**断面の中**を通さない／壁の向こう側の面から
 * 描き始める」という既存規約（`sectionEmit.js`の`ceilStepSlabSection`）と、はり出し外端の
 * 判定（`sectionContent.js`の`upperFloorCutWallEndsOf`）は**同じ1つの問い**なので、述語も
 * εもここへ一本化する（別々に書くと片方だけ腰壁の中を線が通る）。
 *
 * 見るのは`kind==='cut'`だけ——面と**平行**な壁（`kind==='cutAlong'`＝縦断された壁）は端の外縁を
 * 決めないため**意図的に除外**する。`sectionEngine.js`の`isCutBand`等が`cutAlong`を含むのとは
 * **別の問い**（あちらは「その帯を断面として扱うか」、こちらは「上階の床の断面線をどこから
 * 描き始めるか＝その列の外縁が床の小口の起点になるか」）。`ceilStepSlabSection`との同値性を
 * 保つため、片方だけ`cutAlong`を足してはいけない。
 * @param {SectionColumn|undefined} column
 * @param {number} z - 絶対z（上階のFL）
 * @returns {boolean}
 */
export function hasCutWallStandingOn(column, z) {
  if (!column || !Number.isFinite(z)) return false;
  return (column.bands ?? []).some(b => b.kind === 'cut' && Math.abs(b.z0 - z) < GAP_EPS);
}

/**
 * その帯の種類が「実体」（展開図一般化Phase 6b-2 設計(d)の「囲む実体」＝
 * `slab ∪ cut ∪ cutAlong`）か。`wall`（通常の見えがかり壁）・`hidden`（そこに壁は実在するが
 * 描かない区間。§5.10で階段の占有形状が遮蔽物として参加する側に回ったため実体には含めない）・
 * `open`・`farVoid`は対象外。`solidRectsOf`が使う単一の述語（列挙を1箇所にする）。
 * `band`はnullを許容しない契約（呼び出し側は必ず`col.bands`の要素を渡す。列自体の非null防御は
 * `solidRectsOf`側の`columns ?? []`が担う——`nearestSightlineDistMm`と同じ役割分担）。
 * @param {import('./sectionTypes.js').ZBand} band - 非null
 * @returns {boolean}
 */
export function isSolidBand(band) {
  return band.kind === 'slab' || band.kind === 'cut' || band.kind === 'cutAlong';
}

/**
 * 連続する列にまたがる同一の帯を1つのrun（x範囲）へまとめる（キーが一致し、かつ列が隣接する
 * 場合のみ連結する）。QA是正（2026-09-13・F4）: `sectionEmit.js`の同名関数の逐語コピーだった
 * ものをここへ移設し、`sectionEmit.js`側はこの関数をimportして使う（単一情報源化）。
 * @param {SectionColumn[]} columns
 * @param {string} kind
 * @param {(band:ZBand)=>*} keyOf - 同一性のキー（cut帯は壁参照、slab帯はz範囲）
 */
export function bandRuns(columns, kind, keyOf) {
  const runs = [];
  columns.forEach((col, i) => {
    for (const b of col.bands ?? []) {
      if (b.kind !== kind) continue;
      const key = keyOf(b);
      const open = runs.find(r => r.key === key && r.lastIndex === i - 1);
      if (open) { open.x1 = col.x1; open.lastIndex = i; }
      else runs.push({ key, band: b, x0: col.x0, x1: col.x1, lastIndex: i });
    }
  });
  return runs;
}

// 2つのslab帯が**同じ層の床**か（`sectionProbe.js`の`slabBandOf`が層のfloorZをそのまま持たせる）。
// 手書き列（単体テスト）のようにfloorZを持たない帯どうしは「同じ」とみなす。
// QA是正（2026-09-13・F4）: `sectionEmit.js`から移設（単一情報源化）。
function sameSlabOwner(a, b) {
  if (!Number.isFinite(a.floorZ) || !Number.isFinite(b.floorZ)) {
    return !Number.isFinite(a.floorZ) && !Number.isFinite(b.floorZ);
  }
  return Math.abs(a.floorZ - b.floorZ) < GAP_EPS;
}

/**
 * スラブの走り（`bandRuns`の'slab'）。ただし**所有層が同じでzが連続するslab帯は1本のスラブ**
 * として数える（同じ1枚の床構造が、腰壁の切断高のような物理境界でない値でzBreaksが割り込むと
 * 2つの走りに割れてしまうのを防ぐ）。所有層が違う隣接slab（1階の天井懐と2階の床構造）は
 * **結合しない**——その境界（2FL）は実体の境界そのものだから。詳細な経緯は
 * `sectionEmit.js`のQA是正コメント（実機「6」C・「5」D1・B）参照。
 * QA是正（2026-09-13・F4）: `sectionEmit.js`から移設し、`solidRectsOf`も同じ関数を引く
 * （単一情報源化。移設前は`solidRectsOf`が縦マージ無しの簡易版を独自に持っていた）。
 * @param {SectionColumn[]} columns
 * @returns {{key:string, band:ZBand, x0:number, x1:number}[]}
 */
export function slabRuns(columns) {
  const merged = columns.map(col => {
    const bands = [];
    for (const b of col.bands ?? []) {
      const last = bands[bands.length - 1];
      if (b.kind === 'slab' && last?.kind === 'slab'
        && Math.abs(last.z1 - b.z0) < GAP_EPS && sameSlabOwner(last, b)) {
        bands[bands.length - 1] = { ...last, z1: b.z1 };
        continue;
      }
      bands.push(b);
    }
    return { ...col, bands };
  });
  return bandRuns(merged, 'slab', b => `${b.z0}|${b.z1}`);
}

// 切断壁の断面をz範囲で（壁参照ではなく）まとめる。**壁は片面ずつのWallオブジェクトとして
// 持つデータモデル**のため、実機の袖壁1枚が2つのWallに分かれており、壁参照でまとめると同じ
// 断面が2つのrunに割れてしまう——同じz範囲で連続する列は1枚の壁の断面とみなす。
// QA是正（2026-09-13・F4）: `sectionEmit.js`から移設（単一情報源化）。
export function cutWallRuns(columns) {
  return bandRuns(columns, 'cut', b => `${b.z0}|${b.z1}`);
}

/**
 * `cutRun`（`cutWallRuns`の1件）が`slabRun`（`slabRuns`の1件）の**上に立っている**か
 * （壁の下端＝スラブの上端。GAP_EPS内で一致）。立っていなければ`null`。立っていれば、壁の
 * footprintのうちスラブに近い面`nearX`と、その**向こう側の面**`farX`を返す——壁の
 * footprintはスラブのrunとxで重なりうる（壁の厚みぶんスラブの縁へ食い込む）ため、
 * 「cutRunがslabRunのx範囲の外に完全に出ている」という前提は置かない（`slabOnLoSide`＝
 * runの始点どうしの前後関係で決める）。
 * QA是正（2026-09-13第2ラウンド・F3〈farX判定の重複解消〉）: `sectionEmit.js`の
 * `slabEdgeCutWallJunction`と本ファイルの`solidRectsOf`が同じ式（同じGAP_EPS・同じ
 * 比較対象）をそれぞれ複製していたのをこの1関数へ一本化した。
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} slabRun
 * @param {{x0:number, x1:number, band:{z0:number,z1:number}}} cutRun
 * @returns {{nearX:number, farX:number, slabOnLoSide:boolean}|null}
 */
export function farXOfCutOnSlab(slabRun, cutRun) {
  if (Math.abs(cutRun.band.z0 - slabRun.band.z1) > GAP_EPS) return null;
  const slabOnLoSide = slabRun.x0 < cutRun.x0 - GAP_EPS;
  const nearX = slabOnLoSide ? cutRun.x0 : cutRun.x1;
  const farX  = slabOnLoSide ? cutRun.x1 : cutRun.x0;
  return { nearX, farX, slabOnLoSide };
}

/**
 * 列群から「実体で囲まれた矩形」の集合を作る（展開図一般化Phase 6b-2 設計(d)。「6」面Cのアキ矩形
 * （6b-2）と同じ考え方を階段自身の幾何へ広げ、階段のささらの見えがかりのうちこの矩形の
 * **厳密内部**にある区間を描かない、という一般判定の入力にする——`.claude/elevation-redesign.md`
 * §5.12参照）。
 *
 * `slab`の矩形は、その上に立つ`cut`壁の**向こう側の面**（farX）まで延ばす（`farXOfCutOnSlab`。
 * `sectionEmit.js`の`slabEdgeCutWallJunction`が小口の縦線を立てるxと同一の規則・同一関数）。
 * `wall`（見えがかり壁。断面ではない）が上に載っている場合は延ばさない——「小口の縦線は
 * 切断壁の断面にだけ現れる」という既存規則と同じ境界線をここでも守る。
 *
 * 返す矩形は**GAP_EPSだけ内側へ縮めた厳密内部**（`elevationPrimitives.js`の
 * `subtractRectsFromPrimitives`が使う`segmentInsideRect`はLiang-Barskyのp≈0分岐で辺上を内側と
 * 判定するため、縮めないと矩形の縁にちょうど乗る裁定済みの見えがかり線（例: 面C x=1492.5の
 * 復路ささら）まで消えてしまう）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @returns {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>}
 */
export function solidRectsOf(columns) {
  const rects = [];
  for (const col of columns ?? []) {
    for (const b of col.bands ?? []) {
      // slabは列にまたがるrun（sameSlabOwnerの縦マージ込み）＋farX延長が要るため下のループで
      // まとめて扱う（ここでは素通り）。
      if (isSolidBand(b) && b.kind !== 'slab') rects.push({ xLo: col.x0, xHi: col.x1, zLo: b.z0, zHi: b.z1 });
    }
  }
  // `slabEdgeCutWallJunction`（sectionEmit.js）と同じrun生成（cutWallRuns/slabRuns）を引く
  // ——単一情報源化（QA是正2026-09-13・F4）。以前はここだけの簡易版（縦マージ無し）を
  // 複製していたが、実データで縦マージが必要な構成（同一層のslabがzBreaksで2走りに割れる）
  // に対して不一致を起こしうるため解消した。
  const cutRuns = cutWallRuns(columns ?? []);
  for (const run of slabRuns(columns ?? [])) {
    let xLo = run.x0, xHi = run.x1;
    for (const c of cutRuns) {
      const hit = farXOfCutOnSlab(run, c);
      if (!hit) continue;
      if (hit.slabOnLoSide) xHi = Math.max(xHi, hit.farX); // slabのhi側に立つ壁→farXへ延ばす
      else xLo = Math.min(xLo, hit.farX); // slabのlo側に立つ壁→farXへ延ばす
    }
    rects.push({ xLo, xHi, zLo: run.band.z0, zHi: run.band.z1 });
  }
  return rects
    .map(r => ({
      xLo: Math.min(r.xLo, r.xHi) + GAP_EPS, xHi: Math.max(r.xLo, r.xHi) - GAP_EPS,
      zLo: Math.min(r.zLo, r.zHi) + GAP_EPS, zHi: Math.max(r.zLo, r.zHi) - GAP_EPS,
    }))
    .filter(r => r.xHi > r.xLo && r.zHi > r.zLo);
}

/**
 * cut.line の run方向（isVerticalならY、falseならX）で、図のx=0に対応する世界座標
 * （dirSignの向きに応じてline.lo/hiのどちらかが起点になる。faceのoriginWorldと同じ規約）。
 * @param {SectionCut} cut
 * @returns {number}
 */
export function cutOriginWorld(cut) {
  return cut.dirSign > 0 ? cut.line.lo : cut.line.hi;
}

/**
 * world座標（cut.lineのrun方向の値）→ 断面ローカルx（elevationFigure.jsのlocalXOf(face,coord)と
 * 同じ式。cutは面ではなく別の型のため、section/配下に独立実装として持つ——faceの
 * originWorld/dirSignの一般化であり、section/がelevationFigure.jsへ依存する必要はない）。
 * @param {SectionCut} cut
 * @param {number} worldCoord
 * @returns {number}
 */
export function localXOf(cut, worldCoord) {
  return (worldCoord - cutOriginWorld(cut)) * cut.dirSign;
}

/**
 * 断面ローカルx → world座標（localXOfの逆写像）。
 * @param {SectionCut} cut
 * @param {number} localX
 * @returns {number}
 */
export function worldOf(cut, localX) {
  return cutOriginWorld(cut) + localX * cut.dirSign;
}

/**
 * `ceilProfile`（`SectionCut.ceilProfile`と同型。区間ごとの天井断面の高さ。断面ローカルx）から、
 * [x0,x1]の中点を含む区間の天井を引く。profileが無ければnull＝打ち切らない（階段帯など、区間の
 * 天井を持たない呼び出し側は従来どおり）。
 *
 * **profileの範囲外（壁のない端部の探査延長で作られる面の外の列）は端の区間の値へクランプする**
 * ——面図側が天井線を`drawnX0..drawnXRun`（延長込み）まで端の区間の高さで引き延ばしている
 * （`elevationFigure.js`の`ceilAbsAtX`と同じ規約）以上、打ち切り高さもそこまで同じ値でなければ
 * ならない。nullを返すと**その列だけ打ち切りが効かず**、描かれている天井線より上の帯の側縁が
 * 面の端に出る（実測: 実機「5」で面の左端に z2400..3000 の中線が出た）。
 *
 * `sectionEngine.js`の列分割（`ceilZ`）が使う天井プロファイル解決の単一情報源（旧実装は
 * `sectionEngine.js`内の私設関数`ceilZAt`だった。展開図一般化Phase 6b-3でここへ集約）。
 * @param {Array<{loX:number, hiX:number, ceilZ:number}>|undefined} ceilProfile
 * @param {number} x0
 * @param {number} x1
 * @returns {number|null}
 */
export function ceilProfileZAt(ceilProfile, x0, x1) {
  const prof = ceilProfile;
  if (!Array.isArray(prof) || prof.length === 0) return null;
  const mid = (x0 + x1) / 2;
  const hit = prof.find(s => mid >= s.loX - GAP_EPS && mid <= s.hiX + GAP_EPS)
    ?? (mid < prof[0].loX ? prof[0] : prof[prof.length - 1]);
  return hit && Number.isFinite(hit.ceilZ) ? hit.ceilZ : null;
}

/**
 * その切断の描画範囲（断面ローカルx。`cut.line.lo..hi` ＋ 壁のない端部の探査延長
 * `probeExtendLo/HiMm`）。**面の外に断面（梁・ささら・踊り場桁枠の矩形）を描かない**ための
 * 共通判定の単一情報源（ユーザー実機指摘2026-08「6」。面が0..2885なのに x=-57.5 や x=2942.5、
 * さらに別スパンの梁が x=-6882.5 に描かれていた）。
 * @param {SectionCut} cut
 * @returns {{lo:number, hi:number}}
 */
export function cutDrawRange(cut) {
  const line = cut.line;
  const a = localXOf(cut, line.lo - (line.probeExtendLoMm ?? 0));
  const b = localXOf(cut, line.hi + (line.probeExtendHiMm ?? 0));
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/**
 * 絶対z（上が正）→ 描画y（下向き正のy=-z。展開図の既存プリミティブ座標系）。
 * プリミティブ化の最後（sectionEmit.js）にのみ使う（§2項目6。エンジン内部はzのまま扱う）。
 * @param {number} z
 * @returns {number}
 */
export function zToY(z) { return -z; }
