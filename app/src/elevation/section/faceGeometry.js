/**
 * 面（face）の形状に関する純粋な小関数（展開記号・直交面の探索・壁のない端部の判定）。
 *
 * 断面エンジン（section/・section/cuts/）が引く部分を、面の体裁（elevationFaces.js）から
 * 切り出したもの（展開図リファクタ S1: section/ から親ディレクトリへ逆向きに import しない
 * ため）。elevationFaces.js は本ファイルから re-export するので、既存の呼び出し側は変わらない。
 * graph・部屋は引かない（face の plain なフィールドだけを読む）。
 */

// letter マップ（buildRoomFaces ヘッダ参照）。isVertical・axisOffset(inward)の符号だけで決まる。
// 新仕様（elevationFaceList.js の composeRoomFaces）でも段差見付け面のletter算出に使うためexport。
export function letterOf(isVertical, axisOffset) {
  if (!isVertical) return axisOffset > 0 ? 'A' : 'C';
  return axisOffset < 0 ? 'B' : 'D';
}

export const DIR_SIGN = { A: 1, B: 1, C: -1, D: -1 };

/**
 * 「軸の向き × 図のローカルx方向」から展開記号を逆引きする（`DIR_SIGN`の逆写像）。
 *
 * 展開記号A/B/C/Dは**視線の向き**（A=12時/B=3時/C=6時/D=9時）を表し、図の左→右がどちらの
 * 世界方向かで一意に決まる——だから`DIR_SIGN[letter] === face.dirSign`は面の不変条件である。
 * 階段帯は「上り口→踊り場」という歩行方向で作図順（＝ローカルx方向）が決まるため
 * （`reorientFace`）、部屋のコンパス向き由来のletterをそのまま残すとこの不変条件が破れ、
 * 実機で「9時方向を見ている図にBの記号が付く」（ユーザー実機指摘2026-08）ことになる。
 * 階段の展開記号がケースバイケースで変わるのはこの逆引きの結果であり、例外規則ではない。
 * @param {boolean} isVertical - 面（壁）が垂直軸に沿うか
 * @param {1|-1} dirSign - 図のローカルx昇順が指す世界方向の符号
 * @returns {'A'|'B'|'C'|'D'}
 */
export function letterForDirSign(isVertical, dirSign) {
  if (!isVertical) return dirSign > 0 ? 'A' : 'C';
  return dirSign > 0 ? 'B' : 'D';
}

// 直交面の実壁が「この面の切断面（仕上げ面の平面）を室内側へ横切っている」とみなす最小
// 進入量(mm)。横切りの正例は数百mm以上・負例（壁が面の向こう側で終わる）は仕上げ面〜芯の
// 数十mm手前で止まるため、丸め誤差だけを吸収する小さい値でよい。
export const PLANE_CROSS_EPS_MM = 1;

/**
 * 面端の直交面（perpFace）の壁が、face の**仮想断面**を室内側へ横切っているか。横切っていれば
 * 図の端部にその壁の断面（返し）が現れる＝通常の隅。横切っていない（壁が面の向こう側だけに
 * あり、こちら側では図の端部に壁断面が現れない）端は「壁断面のない中心線」＝壁のない端部として
 * 扱う（続きがある表現＝床・天井線の延長）。
 * perpFace.lo/hi は face の奥行き方向に沿った直交面のスパン。
 *
 * **基準は仮想断面線そのもの**（`planeValue`。`section/sectionCutPlane.js`の
 * `cutPlaneOffsetMm`で面の軸から室内側へ下げた位置）——ユーザー明示指示2026-09
 * 「壁断面の判定については仮想断面が何を切っているのかを正しく判定できるようにして」。
 * 省略時は面の壁の仕上げ面（`face.faceValue`）へフォールバックする（幾何を持たない合成face・
 * graph無しの単体テスト向け）。仕上げ面は仮想断面と一致するか手前にあるため、旧実装は
 * 柱型が仕上げ面より室内へ張り出す面で「切っていない壁を切っている」と誤判定しえた。
 * @param {{lo:number, hi:number}} perpFace
 * @param {{faceValue:number, inward:number}} face
 * @param {number} [planeValue] - 仮想断面の世界座標
 * @returns {boolean}
 */
export function perpWallCrossesFacePlane(perpFace, face, planeValue) {
  // inward不明（幾何を持たない合成face＝既存単体テストの後方互換）は判定不能のため
  // 従来どおり「横切っている＝壁あり」へフォールバックする（hasRealWall ?? true と同じ規約）。
  if (face.inward !== 1 && face.inward !== -1) return true;
  const plane = Number.isFinite(planeValue) ? planeValue : face.faceValue;
  return face.inward > 0
    ? perpFace.hi > plane + PLANE_CROSS_EPS_MM
    : perpFace.lo < plane - PLANE_CROSS_EPS_MM;
}

/**
 * 「壁のない端部」（体裁の延長・縦線なしの対象）の単一判定（QA是正2026-09・§5.12 D2-1是正）。
 *
 * **「壁が無い」（`hasWallAtLocal0/Run`=false）だけでは壁のない端部と判定しない**——
 * wallFilterで除外された実壁（`hiddenWallAtLocal0/Run`=true。§5.12是正）も`hasWallAt*`は
 * falseになるが、これは「この帯では数えないだけで実壁はある」端であり、上り口・下り口のような
 * 本当に何も無い端と同じ体裁の延長（`wallLessExtendMm`ぶん図の外側へ床・天井線を延ばす）を
 * 適用してはいけない（実機「6」D2: 2a壁を数えない端に150延長が混入し、2F床の小口が
 * 57.5→207.5へ広がり、面全体が+150平行移動していた根本原因）。
 *
 * `elevationFigure.js`（`drawnX0/Run`・`upperFloorEdgeSpanAt`のxInner）・`elevationFaces.js`の
 * `faceWallLessExtents`・`section/sectionContent.js`の`layerRunWindowsOf`/`planeOverhangForFace`・
 * `elevationStairSequence.js`の`upperOverhangOf`——体裁の延長に関わる**全箇所**がこの1関数を
 * 呼ぶ（判定の二重管理を禁じる）。**例外は探査窓**（`section/sectionContent.js`の
 * `withProbeExtension`）——探査は「壁が無い（hasWallAt*=false）」だけで広げ続ける。探査を
 * 締めるとhidden端の实壁自体が列から消え、その壁を手掛かりにする`recessLo`等の既存描画が
 * 全滅する（QA変異MUT-Dで確認済み）。「探査は広げる・描画は締める」——広く探って、
 * 描画時にこの関数で真に壁のない端だけへ絞る、という役割分担。
 * @param {{hasWallAtLocal0?:boolean, hasWallAtLocalRun?:boolean,
 *   hiddenWallAtLocal0?:boolean, hiddenWallAtLocalRun?:boolean}} face
 * @param {'0'|'Run'} end
 * @returns {boolean}
 */
export function wallLessEndAt(face, end) {
  const hasWall = face[`hasWallAtLocal${end}`] ?? true;
  const hiddenWall = !!face[`hiddenWallAtLocal${end}`];
  return !hasWall && !hiddenWall;
}

// perpFaceAt の隅一致判定許容差(mm)。elevationStepFace.js（見付け面の隅スナップ・挿入位置探索）・
// elevationOpenSpan.js（開放スパンの端の直交壁面スナップ）が共有する。
export const CORNER_TOL_MM = 200;

/**
 * wallFaces（直交面の候補集合）のうち、指定した固定軸位置(targetAxisValue)がスパン内に収まり、
 * かつ位置(pos)がCORNER_TOL_MM以内で最も近いものを返す（旧elevationStepFace.jsの
 * nearestPerpFaceAtをexport化・汎用化。QA修正: 各消費者で個別実装されていたロジックを統合）。
 * 直交面fはisVertical=falseなら自身の位置(axisCL)がY・スパン(lo/hi)がXという具合に、
 * targetIsVertical側とは軸が入れ替わる——「targetAxisValueがfのスパン内か」（到達判定）と
 * 「pos（target自身の伸びる方向の座標）とfの位置(axisCL)の近さ」（どちらが最寄りか）は
 * 別の軸同士の比較になる点に注意。
 * @param {object[]} wallFaces - buildRoomFaces/composeRoomFacesの面配列（隅探索用）
 * @param {boolean} targetIsVertical - 探している対象自身のisVertical（直交面はこれと異なる）
 * @param {number} targetAxisValue - 対象の固定軸位置（fのスパンに収まるか判定する値）
 * @param {number} pos - 対象の伸びる方向の座標（fの位置との近さを測る値）
 * @returns {object|null}
 */
export function perpFaceAt(wallFaces, targetIsVertical, targetAxisValue, pos) {
  let best = null, bestDist = Infinity;
  for (const f of wallFaces) {
    if (f.kind === 'step') continue;
    if (f.isVertical === targetIsVertical) continue; // 直交面のみ
    if (!(targetAxisValue >= f.lo - CORNER_TOL_MM && targetAxisValue <= f.hi + CORNER_TOL_MM)) continue;
    const dist = Math.abs(f.axisCL.effectiveValue - pos);
    // 到達判定（上のif）だけではdistに上限が無く、真の隅から遠く離れた直交面でも「その時点で
    // いちばん近い」というだけで採用してしまう（例: 部屋を貫通する上下の壁面は、targetAxisValueさえ
    // 範囲内なら室内のどの位置からも「候補」に入ってしまう）。CORNER_TOL_MM以内でなければ
    // 候補にしない——真に隅を共有する直交面が無ければ呼び出し側はフォールバック値を使うべき。
    if (dist > CORNER_TOL_MM) continue;
    if (dist < bestDist) { bestDist = dist; best = f; }
  }
  return best;
}
