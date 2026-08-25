/**
 * 2.5D断面エンジン: emitColumns / emitOpenGapMarks（線種テーブル・アキX連結・最終降格。WP-E2）。
 * 設計意図はarchitect承認済みの実装指示書§5.6参照。WP-E5bでelevationStairSequence.js
 * （直接。stairPrimitivesForCut内のemitLine経由でも）から呼ばれるようになった。
 *
 * §5.6「線種テーブル」の唯一の情報源。破線は必ずlineプリミティブで出す
 * （レンダラのpolyline分岐はdash非対応。.claude/elevation-model.md）。
 */
import { ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { zToY } from './sectionTypes.js';

/**
 * §5.6最終フィルタの唯一の適用箇所（emitLine(x1,z1,x2,z2,role)の1箇所だけで適用する、という
 * 設計方針どおり）。線分の両端がともに「baseFloorZより下」または「天井断面より上」（向こう側）
 * なら、role・dashに関わらずDETAIL+dash:'dashed'へ降格する。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @param {string} role - ElevationLineRoleの値
 * @param {{dash?:string, ceilZ?:number, neverDowngrade?:boolean}} [opts] - ceilZ未指定は
 *   cut.zRange.hiZへフォールバック（§5.6「天井断面」＝この列で見えている天井——通常はzRange
 *   上端と一致するため、これを既定にする）。neverDowngrade:true（実機フィードバック第3弾C。
 *   リード裁定で契約変更を承認済み）は本関数のbeyond/forceDash判定を丸ごと無効化し、
 *   渡されたrole・dashをそのまま使う——CUT断面（ささら12×300矩形・踊り場床CUT線・踊り場桁断面）
 *   はbaseFloorZより下でも太線実線のまま、ささらの見えがかり帯（DETAIL）は同じくbaseFloorZより
 *   下でも細線実線のまま、という「降格が残るのは踏面梯子(正面視)と壁断面の見えがかりだけ」という
 *   線種裁定を呼び出し側（sectionStair.js）から明示的に選択できるようにするフラグ
 *   （既定false＝既存呼び出しは無変更）。
 * @returns {object} lineプリミティブ（y=zToY(z)変換済み）
 */
export function emitLine(cut, x1, z1, x2, z2, role, opts = {}) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const ceilZ = opts.ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  // 水平線（z1===z2。床線・天井線・段の踏面線等の大半）は「ちょうどbaseFloorZ／ceilZに触れる」
  // だけでは向こう側と判定しない（strict <・>）——通常の床線(z=baseFloorZそのもの)を誤って
  // 降格しないため（WP-E5b回帰: 元は両端の緩い判定(<=)にしていたところ、床z=baseFloorZの
  // 通常の水平線まで「向こう側」扱いされてしまった）。垂直線・斜め線（z1!==z2）は、
  // sectionProbe.jsがcut.baseFloorZをzBreaksに割り込ませるため片端がbaseFloorZちょうどに
  // 一致するのが通常のケースになる——「ちょうど境界」を含めて向こう側とみなす（Math.max/minの
  // 緩い判定）。水平線側で「band全体がbaseFloorZ以下」を降格させたい場合はopts.forceDashで
  // 明示する（emitColumns参照）。
  const isDegenerate = Math.abs(z1 - z2) < GAP_EPS;
  const beyond = isDegenerate
    ? (z1 < baseFloorZ - GAP_EPS || z1 > ceilZ + GAP_EPS)
    : (Math.max(z1, z2) <= baseFloorZ + GAP_EPS || Math.min(z1, z2) >= ceilZ - GAP_EPS);
  const forced = opts.forceDash === true;
  const downgrade = !opts.neverDowngrade && (beyond || forced);
  const finalRole = downgrade ? ElevationLineRole.DETAIL : role;
  const finalDash = downgrade ? 'dashed' : (opts.dash ?? undefined);
  const prim = { type: 'line', x1, y1: zToY(z1), x2, y2: zToY(z2), weight: weightForRole(finalRole) };
  if (finalDash) prim.dash = finalDash;
  return prim;
}

// band全体がbaseFloorZ以下／ceilZ以上（水平な上端・下端エッジが「ちょうど境界に触れるだけ」
// でも降格させたい場合の判定。emitLineのopts.forceDashに渡す）。
function bandFullyBeyond(cut, band, ceilZ) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const top = ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  return band.z1 <= baseFloorZ + GAP_EPS || band.z0 >= top - GAP_EPS;
}

// z区間が重なるか（隣接列の同一kind判定・アキ連結成分判定の共通ヘルパ）。
function overlapsZ(a, b) {
  return a.z0 < b.z1 - GAP_EPS && a.z1 > b.z0 + GAP_EPS;
}

// col（SectionColumn|null）から、[z0,z1]と重なる指定kindのband（無ければnull）を返す。
function matchingBand(col, z0, z1, kind) {
  if (!col) return null;
  return col.bands.find(b => b.kind === kind && overlapsZ(b, { z0, z1 })) ?? null;
}

/**
 * 背景側の水平線（見えがかり壁の上下端縁・スラブ端）が、**手前の切断壁の断面線でトリムされる**か
 * （ユーザー実機指摘2026-08「6」D1・B「1F天井断面が2階袖壁断面線とトリムされていない」）。
 * その列に切断壁(cut)があり、水平線がその壁の天端以下なら、線は壁の断面線の手前で終わる＝
 * その列には描かない。天端より上（例: 腰壁・袖壁の上を通る上階天井）は壁に遮られないので対象外。
 */
function trimmedByCutWall(col, z) {
  return col.bands.some(b => b.kind === 'cut' && z <= b.z1 + GAP_EPS);
}

/**
 * 連続する列にまたがる同一の帯を1つのrun（x範囲）へまとめる（キーが一致し、かつ列が隣接する
 * 場合のみ連結する）。
 * @param {object[]} columns
 * @param {string} kind
 * @param {(band:object)=>*} keyOf - 同一性のキー（cut帯は壁参照、slab帯はz範囲）
 */
function bandRuns(columns, kind, keyOf) {
  const runs = [];
  columns.forEach((col, i) => {
    for (const b of col.bands) {
      if (b.kind !== kind) continue;
      const key = keyOf(b);
      const open = runs.find(r => r.key === key && r.lastIndex === i - 1);
      if (open) { open.x1 = col.x1; open.lastIndex = i; }
      else runs.push({ key, band: b, x0: col.x0, x1: col.x1, lastIndex: i });
    }
  });
  return runs;
}

/**
 * 切断壁（`cut`帯）の天端のCUT水平線。腰壁のように**見えている天井より下で終わる**切断壁は、
 * その上端が切断面の一部（そこで断面が閉じる）なので水平線を描く
 * （ユーザー実機指摘2026-08「6」D「腰壁断面線は、天端で曲がり、壁厚だけ左に進み」。
 * `cutAlong`の上端エッジと同じ扱い）。列ごとではなく**壁ごとに1本**描く——列は壁と無関係な
 * 断点でも分割されるため、列ごとに描くと同じ天端が複数本になる（seq1の既存テストが
 * 「上端水平線は1本・幅=壁厚」を固定している）。下端は描かない: 壁が載っている床
 * （スラブ端・床断面線）が既に描いており、同指摘のプロファイルも天端→外側面→2FL床と回って
 * 壁の下を通らない。
 */
function cutWallTopEdges(columns, cut, ceilZ) {
  const topZ = ceilZ ?? cut.zRange?.hiZ ?? null;
  if (topZ == null) return [];
  return cutWallRuns(columns)
    .filter(r => r.band.z1 < topZ - GAP_EPS)
    .map(r => emitLine(cut, r.x0, r.band.z1, r.x1, r.band.z1, ElevationLineRole.CUT, { ceilZ }));
}

// 切断壁の断面をz範囲で（壁参照ではなく）まとめる。**壁は片面ずつのWallオブジェクトとして
// 持つデータモデル**のため、実機の袖壁1枚が2つのWallに分かれており（列ダンプでx=45に境界）、
// 壁参照でまとめると同じ断面が2つのrunに割れてしまう——同じz範囲で連続する列は1枚の壁の
// 断面とみなす。
function cutWallRuns(columns) {
  return bandRuns(columns, 'cut', b => `${b.z0}|${b.z1}`);
}

/**
 * 上階床スラブの端に**切断壁が載っている**（袖壁・腰壁）ときの取り合い
 * （ユーザー実機指摘2026-08「6」D1・B「CL内側まで進んで、上を向いて2階袖壁の階段側断面線と
 * トリム／1FL天井から2FL床までの上へ向かう線分がない」）。
 * スラブは吹抜けの開口縁（CL）で終わるが、袖壁はそのCLに芯を合わせて左右へ張り出す。作図は
 *   下階天井(slab.z0) …→ 袖壁の反対側の面 → そこを**上へ**立ち上げて 上階床(slab.z1) へ
 * とつなぎ、袖壁の断面線と交点で取り合わせる。この立上りが無いと天井線が宙で終わる。
 * 上階床側（slab.z1）の水平線は袖壁の手前の面で止まる（`trimmedByCutWall`）——同指摘の
 * 「2FL床断面まで下りる、再度CLの外へ延長して終わる」どおり、壁の下は通らない。
 */
function slabEdgeCutWallJunction(columns, cut, ceilZ) {
  const prims = [];
  const slabs = bandRuns(columns, 'slab', b => `${b.z0}|${b.z1}`);
  for (const c of cutWallRuns(columns)) {
    for (const s of slabs) {
      if (Math.abs(s.band.z1 - c.band.z0) > GAP_EPS) continue; // 壁がこのスラブの上に載っている
      // スラブが伸びている側の反対＝袖壁の「向こう側」の面。実機ではそれが階段側になる。
      const slabOnLoSide = s.x0 < c.x0 - GAP_EPS;
      const nearX = slabOnLoSide ? c.x0 : c.x1;
      const farX  = slabOnLoSide ? c.x1 : c.x0;
      prims.push(emitLine(cut, nearX, s.band.z0, farX, s.band.z0, ElevationLineRole.SILHOUETTE, { ceilZ }));
      prims.push(emitLine(cut, farX, s.band.z0, farX, s.band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
    }
  }
  return prims;
}

// col（SectionColumn|null）の[z0,z1]範囲が「アキ扱い」（kind==='open' または
// openingPassThrough:true）で完全に覆われているか（凹み判定・cut縁のopen判定に使う）。
// 列が無い（範囲外）場合はopen扱い（画面の外は常に開放）。
function isOpenSideAt(col, z0, z1) {
  if (!col) return true;
  return col.bands.some(b => (b.kind === 'open' || b.openingPassThrough) && overlapsZ(b, { z0, z1 }));
}

/**
 * SectionColumn[] → 切断壁の断面（両縁）・見えがかり壁面の輪郭／凹み側面線 のプリミティブ列
 * （§3.4役割分担表・§5.5・§5.6）。アキXはemitOpenGapMarks側（本関数はopen/slab bandを描かない
 * ——slabは非描画のまま、AMBIGUITY F）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number, openEndLo?:boolean, openEndHi?:boolean}} [emitCtx]
 * @returns {object[]}
 */
export function emitColumns(columns, cut, emitCtx = {}) {
  const prims = [];
  const ceilZ = emitCtx.ceilZ;
  // 注: 「壁のない端部で線を図の外側へ延長する」処理はここには無い。プリミティブを後から
  // 引き伸ばすのではなく、**探査範囲そのものを外へ広げる**（sectionProbe.jsの
  // probeExtendLo/HiMm。ユーザー裁定2026-08 A案）——面の外の列も実データとして生成されるため、
  // 延長ぶんの線は通常の帯の縁として自然に出る。両方やると二重に伸びるので、ここでは何もしない。
  columns.forEach((col, i) => {
    const prev = columns[i - 1] ?? null;
    const next = columns[i + 1] ?? null;
    for (const band of col.bands) {
      if (band.kind === 'cut') {
        // 切断壁の断面矩形の両縁: その縁が接する側がopenならCUT、塞がれていればSILHOUETTE
        // （AMBIGUITY B）。列の外（画面端）はopen扱い。WP-E5b修正: 隣接列が「別のcut band」で
        // なければopen扱いにしていた旧実装（`|| !matchingBand(...,'cut')`）は、隣接列が
        // 'wall'（距離のある見えがかり壁）のときも「塞がれていない」と誤判定していた
        // （例: seq1で切断された往復間の壁の縁が、遠くに見える別の壁（'wall'band）に接する場合。
        // 保存意味論「seq1では切断線を横切るcutとして厚みの2縁=open側CUT/塞がれ側SILHOUETTE」
        // を満たすには、'wall'・'cutAlong'等どの種類であれ何らかの実体があれば「塞がれている」
        // とみなす必要がある——isOpenSideAtは`kind==='open'`（または開口貫通）だけをopenと
        // みなすため、そのままの結果を使えばよい）。
        // **同じ壁のcut帯が隣接列にも続いていれば、その境界は壁の内部なので線を描かない**
        // （ユーザー実機指摘2026-08「6」D。腰壁の断面がx=-57.5..57.5の1枚なのに、列が
        // x-57.5..0/0..45/45..57.5へ分割されていたため、内部にV x0・V x45の縦線が出ていた）。
        // cutAlongの端部縦線と同じ「隣接列に同じ壁が続くか」のパターン。壁の同一性は
        // band.wall参照で見る——両側にwallが載っている場合だけ抑止し、載っていない
        // （単体テストの手書き列など）場合は従来どおり描く。
        const sameWall = b => !!b && !!b.wall && !!band.wall && b.wall === band.wall;
        if (!sameWall(matchingBand(prev, band.z0, band.z1, 'cut'))) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1,
            isOpenSideAt(prev, band.z0, band.z1) ? ElevationLineRole.CUT : ElevationLineRole.SILHOUETTE,
            { ceilZ }));
        }
        if (!sameWall(matchingBand(next, band.z0, band.z1, 'cut'))) {
          prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1,
            isOpenSideAt(next, band.z0, band.z1) ? ElevationLineRole.CUT : ElevationLineRole.SILHOUETTE,
            { ceilZ }));
        }
      } else if (band.kind === 'wall') {
        // 見えがかり壁面の輪郭（上端・下端）。水平線（縮退）はemitLineの単独判定では
        // 「ちょうどbaseFloorZ/ceilZに触れるだけ」を向こう側と見なさないため、band全体が
        // baseFloorZ以下／ceilZ以上ならforceDashで明示的に降格する（WP-E5b: sectionProbe.jsが
        // cut.baseFloorZをzBreaksに割り込ませることで生じる、内部分割されたband用の対応）。
        const beyondBand = bandFullyBeyond(cut, band, ceilZ);
        // **手前の切断壁でこの帯が切られただけの縁は描かない**（ユーザー実機指摘2026-08「6」D）。
        // 同じ列で切断壁(cut)の上端/下端とちょうど一致する縁は、見えがかり壁の実際の端ではなく
        // 「手前の腰壁に遮られてそこで見えなくなった」だけの遮蔽境界で、壁自体はその裏へ続いている
        // （実機症状: 腰壁の内側半分x0..57.5の下に、遠い壁の天端としてH z3000が出ていた）。
        // 腰壁の天端側はcut帯自身がCUT水平線として描くので、線が失われることはない。
        if (!trimmedByCutWall(col, band.z0)) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x1, band.z0, ElevationLineRole.SILHOUETTE, { ceilZ, forceDash: beyondBand }));
        }
        if (!trimmedByCutWall(col, band.z1)) {
          prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ, forceDash: beyondBand }));
        }
        // 凹み: 隣接列で同一z区間のwallのdistMmが変化した境界にSILHOUETTE縦線（§5.5）。
        // 凹み側面線。**列の外側の端（prev/nextが無い＝描画範囲の端）では、その端に壁が
        // 無ければ描かない**（ユーザー実機指摘2026-08「3500左CLにエッジはない」）——
        // 隣接列が無いことは「そこで壁が終わる」ことを意味しない。範囲外は単に未探査であり、
        // 面が「壁のない端部」だと分かっている側（emitCtx.openEndLo/openEndHi）では
        // 壁面はその先へ続いている。旧実装は`!prevWall`だけで判定していたため、
        // 先頭列・末尾列には常に縦線が出ていた（全パネルの端に出る症状）。
        // **凹みは同じ層(layerRole)の壁どうしでしか成立しない**（ユーザー実機指摘2026-08「6」D。
        // 実機症状: 左CL上のz3800..5400に縦線が出ていた——隣は上階側の遠い壁(d7250 above)、
        // こちらは設置階の壁(d2250 self)で、距離が変わるのは「1枚の壁面が凹んだ」からではなく
        // **見えている壁が別の層のものへ入れ替わった**だけ。連続面の折れ角ではないので描かない）。
        // 隣接列に見えがかり壁が無い場合は従来どおり「そこで壁が終わる」＝描く。
        const isRecessAgainst = nb => {
          if (!nb) return true;                                // 壁がそこで終わる
          if (nb.layerRole !== band.layerRole) return false;    // 層が入れ替わっただけ
          return nb.distMm !== band.distMm;
        };
        const prevWall = matchingBand(prev, band.z0, band.z1, 'wall');
        if ((prev ? isRecessAgainst(prevWall) : !emitCtx.openEndLo)) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
        const nextWall = matchingBand(next, band.z0, band.z1, 'wall');
        if ((next ? isRecessAgainst(nextWall) : !emitCtx.openEndHi)) {
          prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
      } else if (band.kind === 'cutAlong') {
        // cutAlong（縦断された壁。WP-E5リード裁定・§6.1）: 見付面自体は塗らず輪郭のみ描く。
        // 上端エッジ（腰壁ならtopHeight位置。壁がz途中で終わる場合その上はrayが継続し別kindの
        // bandになる＝band.z1が常に「この壁のこの位置での実際の上端」）はCUT水平線
        // （band全体がbaseFloorZ以下なら降格。'wall'と同じforceDash判定）。
        prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.CUT,
          { ceilZ, forceDash: bandFullyBeyond(cut, band, ceilZ) }));
        // 端部縦線: 壁のx方向の実際の端（隣接列に同じcutAlong壁が続かない側）にCUT縦線
        // （壁の実端の断面。§5.5の凹み側面線と同じ「隣接列と比較」パターンだが、cutAlongは
        // 塗り分けを持たないため常にCUT——壁が存在しない側=open端という区別を線種に反映する
        // 必要が無い、壁の実端そのものを示す線のため）。
        const prevAlong = matchingBand(prev, band.z0, band.z1, 'cutAlong');
        if (!prevAlong) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.CUT, { ceilZ }));
        }
        const nextAlong = matchingBand(next, band.z0, band.z1, 'cutAlong');
        if (!nextAlong) {
          prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.CUT, { ceilZ }));
        }
      }
      // open/slabの帯自体はここでは描かない（AMBIGUITY F）。ただしslab→openの境界（＝above層の
      // 床の端）はSILHOUETTE水平線として描く（WP-E5b追加。§5.6「2FLの中線= above層の床スラブ端
      // （slabとopenの境界）→SILHOUETTE水平線」）。同一列内でz方向に隣接するslab/open帯の境界を
      // 対象にする——列をまたぐslab⇄open（x方向の境界）は凹み側面線に相当する概念が無く
      // （床の厚み方向の境界であってwallの見付面ではない）、本WPでは対象外（ASSUMED）。
    }
    for (let i = 0; i + 1 < col.bands.length; i++) {
      const a = col.bands[i], b = col.bands[i + 1];
      const aIsFloorEdge = (a.kind === 'slab' || a.kind === 'open');
      const bIsFloorEdge = (b.kind === 'slab' || b.kind === 'open');
      if (aIsFloorEdge && bIsFloorEdge && a.kind !== b.kind) {
        if (!trimmedByCutWall(col, a.z1)) {
          prims.push(emitLine(cut, col.x0, a.z1, col.x1, a.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
      }
    }
  });
  prims.push(...cutWallTopEdges(columns, cut, ceilZ));
  prims.push(...slabEdgeCutWallJunction(columns, cut, ceilZ));
  return dedupeLines(prims);
}

// 完全に同一（type/x1/y1/x2/y2/weight/dash）の線プリミティブを1本にまとめる（WP-E5b追加）。
// sectionProbe.jsがcut.baseFloorZ/ceilZをzBreaksに割り込ませる（§5.6最終フィルタをband内部の
// 一部にも適用できるようにするため）副作用として、同一kindの隣接z区間が「上端／下端」を
// それぞれ独立に描く際、その内部分割の境界ちょうどで同じ水平線が2回出ることがある
// （例: wallの下側区間の上端縁と上側区間の下端縁が同じz=baseFloorZに重なる）——見た目には
// 影響しない冗長プリミティブだが、テスト側の本数アサーションを不安定にするため統合する。
function dedupeLines(prims) {
  const seen = new Set();
  const out = [];
  for (const p of prims) {
    const key = p.type === 'line' ? `${p.type}|${p.x1}|${p.y1}|${p.x2}|${p.y2}|${p.weight}|${p.dash ?? ''}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(p);
  }
  return out;
}

// 線分(x1,y1)-(x2,y2)が軸並行矩形の内側にある媒介変数区間[t0,t1]（Liang-Barsky。交わらなければ
// null）。矩形はz→y変換済み（yLo<=yHi）で渡す。
function segmentInsideRect(x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [x1 - r.xLo, r.xHi - x1, y1 - r.yLo, r.yHi - y1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    const p = ps[i], q = qs[i];
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

// 媒介変数区間の集合を昇順・非重複へ統合する。
function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

/**
 * アキのバツ（`emitOpenGapMarks`が出す一点鎖線の対角線）のうち、**手前の階段に隠れる区間だけを
 * 破線へ落とす**（ユーザー実機指摘2026-08「6」C「但し、階段に隠れる部分は破線」）。
 * 対象は`dash:'center'`の斜め線だけ——既に`dashed`のもの（床断面より下のアキ）や水平・垂直線は
 * そのまま通す。区間ごとに線分を分割して積み直すため、1本のバツが複数の線分になる。
 * @param {object[]} prims - emitOpenGapMarksの出力（他のプリミティブが混ざっていてもよい）
 * @param {Array<{xLo:number, xHi:number, zLo:number, zHi:number}>} rects - 階段の見付け矩形
 * @returns {object[]}
 */
export function splitGapMarksByStair(prims, rects) {
  if (!rects?.length) return prims;
  const boxes = rects.map(r => ({
    xLo: Math.min(r.xLo, r.xHi), xHi: Math.max(r.xLo, r.xHi),
    yLo: zToY(Math.max(r.zLo, r.zHi)), yHi: zToY(Math.min(r.zLo, r.zHi)),
  }));
  const out = [];
  for (const p of prims) {
    const isDiagonal = p.type === 'line' && p.dash === 'center'
      && Math.abs(p.x1 - p.x2) > GAP_EPS && Math.abs(p.y1 - p.y2) > GAP_EPS;
    if (!isDiagonal) { out.push(p); continue; }
    const hidden = mergeIntervals(boxes
      .map(b => segmentInsideRect(p.x1, p.y1, p.x2, p.y2, b))
      .filter(Boolean));
    if (hidden.length === 0) { out.push(p); continue; }
    const at = t => ({ x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t });
    const push = (t0, t1, dash) => {
      if (t1 - t0 <= 1e-9) return;
      const a = at(t0), b = at(t1);
      out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y, dash });
    };
    let cursor = 0;
    for (const [h0, h1] of hidden) {
      push(cursor, h0, 'center');   // 見えている区間
      push(h0, h1, 'dashed');       // 階段に隠れる区間
      cursor = h1;
    }
    push(cursor, 1, 'center');
  }
  return out;
}

/**
 * SectionColumn[] → アキのX（対角線2本。AMBIGUITY E）のプリミティブ列。
 * kind==='open' の band、および openingPassThrough:true が付いた band（kind問わず。§5.4・
 * WP-E7でopeningがこのフラグを立てる想定——本関数自体はフラグの由来を問わない）を
 * 「アキ扱い」とみなし、列をまたいでz範囲が重なるもの同士を連結成分としてまとめてから
 * 1組ずつXを描く（defer D1「開口が2階アキと連続する場合の1つの大きなX」の一般規則。§7）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number}} [emitCtx]
 * @returns {object[]}
 */
export function emitOpenGapMarks(columns, cut, emitCtx = {}) {
  const ceilZ = emitCtx.ceilZ;
  const cells = [];
  columns.forEach((col, colIndex) => {
    for (const b of col.bands) {
      if (b.kind === 'open' || b.openingPassThrough) {
        cells.push({ colIndex, x0: col.x0, x1: col.x1, z0: b.z0, z1: b.z1 });
      }
    }
  });

  // 連結成分（列インデックスが隣接し、z範囲が重なるセル同士を1つにまとめる）。
  const groups = [];
  for (const cell of cells) {
    const touching = groups.filter(g => g.some(c =>
      Math.abs(c.colIndex - cell.colIndex) <= 1 && overlapsZ(c, cell)));
    if (touching.length === 0) { groups.push([cell]); continue; }
    const [target, ...rest] = touching;
    target.push(cell);
    for (const other of rest) {
      target.push(...other);
      groups.splice(groups.indexOf(other), 1);
    }
  }

  const prims = [];
  for (const g of groups) {
    const x0 = Math.min(...g.map(c => c.x0));
    const x1 = Math.max(...g.map(c => c.x1));
    const z0 = Math.min(...g.map(c => c.z0));
    const z1 = Math.max(...g.map(c => c.z1));
    // §5.6: baseFloorZより上=一点鎖線(center)、床断面より下=破線(dashed)。連結成分がbaseFloorZを
    // またぐ（D1の「開口+上階アキ」等）場合は、床断面より下へ到達している時点でdashedを選ぶ
    // （ASSUMED: 設計書はこの併合時の様式を明記していないため、より弱い表現＝dashedを安全側の
    // 既定にした。報告に明記する）。
    const dash = z0 >= (cut.baseFloorZ ?? 0) - GAP_EPS ? 'center' : 'dashed';
    prims.push(emitLine(cut, x0, z0, x1, z1, ElevationLineRole.DETAIL, { dash, ceilZ }));
    prims.push(emitLine(cut, x0, z1, x1, z0, ElevationLineRole.DETAIL, { dash, ceilZ }));
  }
  return prims;
}
