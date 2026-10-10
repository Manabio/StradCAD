# 天伏モード（見上げの天井伏図）

天井伏図モード（appMode `'ceiling'`。ModeBar の「天伏」）。見上げ図の描画と、天井欄の指定を行うための専用モード。用語は `glossary.md`「天伏」。

## 構造（S1a'）
- **仕上げモードとは独立**: 専用の State（`modes/CeilingModeState.js`）・専用パネル（`ceiling/CeilingPanel.jsx`。内部／階段タブ。当面は読むだけ）を持つ。仕上げ表との兼用案は捨てた（ユーザー裁定 2026-10-10）。共有するのは**データ（Room の天井欄）と純モジュール**（部屋の述語 `finish/interiorTabRooms.js`・階段タイプ表記）だけ。State は借りない（UI の部品は S3 で材選択の `MaterialSelect` だけ共用）。
- 境界処理（モード切替時の他階反映など）は持たない。パンのみのポインタ分岐、CL 種別ポリシーの ceiling 行は登録済み。

## 見上げ（S1b）
- 描画は平面の断面解決を**向きだけ反転**して流用する（鏡像ラッパー）。切断高は**天伏専用**の階の属性 `ceilingCutHeightMm`（読み口 `ceilingCutHeightMmOf(plane)` 唯一。平面の `planCutHeightMm` と同型。ユーザー裁定 2026-10-10）。既定は 1500（ASSUMED: ユーザー未指定のため平面の既定と同値。値は後で決める）。階チップのメニュー「天伏切断高」から変更（ダイアログは `PlanCutHeightDialog` を title で共用）。方式・窓規則を使わない理由・天井の立体・自階で描く種別・鍵は `.claude/plan-section.md`「見上げ（天伏。S1b）」。
- 天井の面は `ceiling/ceilingSurfaces.js` が唯一の算出（部屋ごとのセル矩形と天井高）。天井の実体（材料・区画・天井芯）が入ったとき、天井立体の中身はこの関数の差し替えで済ませる。
- 同じ高さで隣り合う部屋の天井の境目（壁の無い境界）の線は、**細線グレーで描く**（消さない。ユーザー裁定 2026-10-10）。立体が部屋ごとのため解決器は両立体から1本ずつ（計2本）出す。`ceiling/ceilingBoundaryStyle.js markSameHeightCeilingBoundaries` が出力の ceiling 線のうち同じ高さ（eps 0.5mm）の面の共有辺の上の部分だけに `style:'ceilingBoundary'` を付け（一部だけ乗る線は分割）、(向き, 座標) ごとに出力済みの区間を差し引いた残りだけを出して1本に畳む（T 字の境界でも重ならない）。`PlanSolidsLayer.jsx` が `CEILING_BOUNDARY_COLOR` で描く。高さが違う境界（段差）の見切り線・天井の外形は通常の細線のままだが、座標が完全一致する同座標の重複（段差は両立体の2本）は1本に畳む。

## 選択（S2）
- 天井セルは**ドラッグでなぞったセルだけ**を選ぶ（矩形の補完はしない。連結も要求しない。指示書）。部屋を超えない: 開始セルの所属と同じセルだけ足し、他の所属は捨てる（戻れば再び受け付ける）。純モジュールは `ceiling/ceilingSelection.js`、状態は `CeilingModeState`（`selection`・`dragState`）。
- 所属の優先は「天井を持つ部屋 → 階段 → なし」。部屋は仕上げ `commitDrag` と同じ規則（部分指定の子 → 親、同順位は部屋順の先勝ち）。階段下部屋（2a）は階段のセルに重なっても部屋が勝つ。天井を持たない部分指定の子（吹抜け等）のセルは親の所属にもしない（描画の後勝ちと一致）。索引（`ceilingOwners.js`）は選択専用で、描画の天井面（`buildCellToRoom`）とは述語 `roomHasCeiling` だけを共有する（索引へ寄せると `--up` の合計が変わるため見送り。ユーザー裁定待ちの食い違いが残る）。吹抜け・STAIR_VOID・屋外・未定義・屋根・昇降路・屋外階段・下階の階段は選べない。階段は選択対象（後で階段に沿った傾斜天井を付けるため。ユーザー裁定 2026-10-10）。
- ポインタ: ガター内と2本指ピンチがパン、それ以外のドラッグは選択（仕上げと同じ作法）。move は 4px 刻みで補間し、速いドラッグでセルを飛ばさない。空白のタップは選択解除、選べないセルから始めたドラッグは前の選択を保つ。タップは常に置き換え（トグル・追加なし）。
- 確定すると所属に合わせてタブを自動で切り替え（部屋＝内部／階段＝階段）、パネル上段に「選択中: 名前／セル数／CH」を出す。選択・ドラッグ状態は undo に積まない（階切替・モード切替は既存の effect の dispose で消える。undo/redo では解除せず、解けなくなったキーは描画と要約で落とす）。
- 材（天井材・仕上げ）の指定は S3（下の節）。高さの指定と永続化（天井区画）は S5（下の節）、形状は S6 以降。

## 天井材・仕上げ（S3）
- データ: Room の `customOverrides` に材コードで持つ。`ceilingPanel`（天井材。材カテゴリ 'panel'）・`ceilingFinish`（天井仕上げ。'finish'）。壁材・壁仕上げと同型で、内装マスターには足さない。FBS は汎用の override（keys/vals）なので変更なし。
- 既定: `getFinishInfo()` の読み時に補う（`DEFAULT_CEILING_PANEL`＝せっこうボード t=9.5 `301000000001`／`DEFAULT_CEILING_FINISH`＝ビニールクロス `302000000001`。`DEFAULT_WALL_MATERIAL` の補完と同じ行）。保存データには書かず、旧文書にも既定が出る。空に戻す（`clearOverride`・未選択）と既定に戻る。
- 旧の自由文字列 `RoomFinish.ceilingMaterial` はデータとして残す（FBS・スナップショット・復元は不変）が、仕上げ表の内部タブには出さない（天井グループは 天井材／仕上げ／H／周り縁 の4列）。旧文書の文字列は画面から見えなくなる。
- 照合・保守: `MATERIAL_CODE_OVERRIDE_FIELDS`（FinishModeState）と `isRoomMaterialOverride`（codeNormalization）の両方に2キーを足し、読込み時の正規化・未解決コード検出・保存時の使用中判定の対象にする。
- 表示: 材コードを材マスタ名に解き、`formatMaterialLabel`（`finish/materials/materialLabel.js`。展開図の壁2段書きと共有）で略称にする（「せっこうボード t=9.5」→「PB ア)9.5」）。解けないコードはコードのまま。
- 天伏パネル: 選択中のセル群があれば要約の下に 天井材・仕上げ の `MaterialSelect`（仕上げ表の部品を共用）を出す。「仕上げは部屋に1つ」なので書込み先は常に部屋（所属が部屋ならその部屋、階段なら `stair.roomId` の部屋、部屋の無い階段は disabled の「—」。`ceilingWriteTargetRoom`）。変更は仕上げ表の master 欄と同じ `withFinishUndo` で1欄1エントリの undo。材データは `CeilingModeState.init()` が仕上げモードと同じ経路で読む（graph を持たないので自階コードの照合はせず `materialError` は常に null）。

## 天井区画（S5）
- 選んだセル群ごとの天井高を `Room.ceilingZones`（不変の `CeilingZone`＝`core/ceilingZone.js`。id・cells・heightMm・shape・dims）に持つ。形状・寸法（S6: 傾斜・円弧・ドーム）の箱は先に持ち、S5 は常に flat・寸法なし。高さは「部屋の FL からの CH」で、null は部屋の CH。
- **Z1 区画のセル ⊆ 部屋のセル**は読む側で守る: `ceilingSurfacesOf` が区画のセルを `refreshCells` で今の分割へ展開し、`buildCellToRoom` がその部屋に帰属させるセルだけを採る。`setCells`/`removeCell` では間引かない（部屋の cells は分割の粒度が混ざり、生キーの交差は誤って削る）。部屋のセルが減ればデータは残り描画から外れ、戻せば描画も戻る。天井を持たない部屋の区画は無視。
- **Z2 同じ部屋の区画どうしはセルが重ならない**: 書く側（`ceiling/ceilingZones.js`）が、確定のたびに全区画を今の分割へ展開し直し（解けないキーを捨てる）、新しい区画が既存区画のセルを奪い、空の区画を消す。同じ高さの flat 区画があればそこへ足す。部屋の CH と同じ高さでも区画として残す。復元（`restoreCeilingZones`）は区画をまたぐ生キーの重複を先勝ちで除く。
- **Z3 仕上げ表の CH 欄には書かない**: `roomCeilingHeight` の利用者（展開図・壁の上端・腰壁）を黙って変えないため。パネルの CH 表示だけ、効いている区画があれば最小～最大のレンジ表記。
- 階段所属のセル群の区画は対の部屋（`stair.roomId`）の `ceilingZones` に持つ（入力は S6b で解禁。下の節）。
- 描画: 部屋は「残り（`zoneId` null）→ 区画の配列順」の面に分かれ（`planSolids` の `source.id` は区画なら `部屋id#区画id`、残りは部屋 id のまま）、同じ高さの境界のグレー化は面のリストを汎用に扱う既存の後処理がそのまま効く。
- undo は仕上げの `withFinishUndo`（`snapshotRoomsState` に区画が入る）。階の複製・検討案コピーは snapshot 全体の線 id 振り直しで区画のセルも新 id になる。
- 既知の限界: CL 削除でセルが併合されると区画の旧キーは解けず、そのセルは部屋の CH に戻る（受容）。階段の上下階同期（`stairFloorSync`）は区画を複写しない。

## 形状と寸法（S6a）
- 区画の `shape`（平面 flat／傾斜 slope／円弧 arc／ドーム dome）と汎用の寸法 `dims`（寸法1・寸法2…。形状が違っても欄を共用する。ユーザー裁定 2026-10-10）。S6a は**平面と傾斜**まで。円弧・ドーム（幾何・ラベル）と階段所属の入力解禁は S6b（下の節）。
- `heightMm`＝**基準高**。平面＝天井高／傾斜＝低い側の高さ／円弧・ドーム＝周縁の高さ（null＝部屋の CH）。個数は flat=0・slope=2・arc=2・dome=1（`CEILING_SHAPE_DIM_COUNT`）。傾斜は [ライズ>0, 上がる向き]、向きは y 下向き座標の度で 0=右・90=下・180=左・270=上（階段の `upDirection` との対応は `UP_DIRECTION_TO_DEG`）。円弧は [ライズ, 軸 0|90]、ドームは [ライズ]。
- **形状に合わない寸法は区画を捨てず flat・寸法なしに落とす**（`normalizeCeilingShape`。復元・`fromData`・書く側で共通。余分な dims は切り詰め）。壊れた文書でもセルと基準高が残るため。ただし基準高 null かつ flat に落ちた区画は「指定なし」なので、これまでどおり捨てる。
- 書く側の `assignZoneShape` は**同じ (shape, 基準高, dims) の区画**へ足し id を維持する（S5 の「同じ高さの flat」の一般化）。ライズや向きが違えば別区画。平面で基準高 null は区画の解除と同じ。
- 傾斜の面は下屋と同じ `zAt` の経路で立体になる（`ceilingShape.js ceilingShapeSolidZ`。外接矩形で正規化した u に沿って baseZ〜baseZ+ライズ、範囲外は端へクランプ）。見上げに新しい規則は作らない: 切断高をまたぐ傾斜は鏡像の slopedCut になり、切断高より上の輪郭だけが細線で出る（等高線は出さない＝既知の限界）。
- ラベルは平面以外の面だけ・詳細 LOD だけ。基準点は面積最大の矩形の中心。傾斜は**上がる向き**の矢印（下屋は水下向きだが天井は階段の上り矢印と同じ向き）＋「傾斜 CH低い側〜高い側」。寸法・矢じりは下屋の傾斜ラベルと共通（`ROOF_LABEL_*`・`chevronPoints`）。基準点が切断高より下なら解決器の可視判定で消える。
- 同じ高さの境界のグレー化は**平面どうしだけ**（`sameHeightBoundarySegments`）。傾斜系は高さが一定でないので境界は通常の細線。
- 入力の表と検証は `ceiling/ceilingShapeFields.js`（`parseCeilingZoneDraft` は例外を投げず値で返す。円弧のライズ≤幅/2。天端が切断高・階高を超えても弾かない）。

## 円弧・ドーム・階段（S6b）
- **幾何**（`ceilingShape.js ceilingShapeSolidZ`。外接矩形 B 基準）: 円弧（ヴォールト）は軸 `dims[1]`（0＝x に平行・90＝y に平行）に垂直な幅 w、中心線からの距離 t として `R=(w²/4+rise²)/(2·rise)`・`z=baseZ+√(R²−t²)−(R−rise)`（中心線が baseZ+rise・縁が baseZ）。ライズは描画時に w/2 でクランプ（半円で R=w/2。壊れたデータでも例外にしない）。ドームは B の中心からの正規化座標 p,q∈[−1,1] で `z=baseZ+rise·(1−p²)(1−q²)`（積型の放物面。周縁が baseZ・中心が頂点）。範囲外は端へクランプ。リード既定（裁定待ち）: 積型の放物面。
- **ラベル**: 円弧「円弧 CH低〜高 R=半径mm」（R は mm 整数・高はクランプ後のライズ）・ドーム「ドーム CH低〜高」。矢印なし（向きが無い）で基準点（面積最大の矩形の中心）に中央寄せ。LOD・フォントは傾斜と同じ（詳細だけ）。切断高をまたぐ円弧・ドームは傾斜と同じく切断高より上に残る輪郭だけが出る（等高線なし）。
- **階段所属の入力**: `ceilingZoneTargetRoom` は階段なら対の部屋（`stair.roomId`）を返す（`ceilingWriteTargetRoom` と同じ解決。部屋の無い階段は null＝パネル disabled）。区画は対の部屋の `ceilingZones` に持ち、全形状を入力できる。
- **直進系の初期値**（`ceilingShapeFields.js stairCeilingSlopeDefaults`）: 選択中のセル群に区画が無く所属の階段が STRAIGHT／STRAIGHT_LANDING のときだけ、パネルの下書きを傾斜にする。向き＝`UP_DIRECTION_TO_DEG[upDirection]`／基準高＝対の部屋の CH／ライズ＝`riserOf(stair, 階高)×総段数×（区画セル群の上り方向の長さ ÷ 階段セル群の同方向の長さ）`を mm に丸めた値（区画が階段全体ならライズ＝階高＝踊り場込みの平均勾配）。階高は App から `floorHeight` prop（`floorHeightAbove(project, project.activePlane)`）。蹴上が決まらない（最上階など）・対の部屋なし・折返し／回り／矩折等は null＝平面の初期値（**折返し・回り階段は手入力**）。初期値は下書きだけで、確定するまで区画は書かれない。
- **描画**: `ceilingSurfacesOf` は、天井を持たない対の部屋（feature STAIR）でも `stairHasCeiling` が真で区画を持つなら区画の面を出す（区画のセルのうち `buildCellToRoom` でその部屋に帰属するセルだけ＝階段下部屋 2a が取ったセルは落ちる）。区画の無い階段・区画に入らなかった残りのセルは従来どおり天井を描かない。
- 既知の限界: 円弧・ドームの基準は区画の外接矩形なので、L字など非矩形の区画では頂点が区画の外に出て、区画内では基準高＋ライズに届かない。ラベルと CH 列は基準高＋ライズを表示する。
- 既知の限界: 天端の上限は設けない（階高・切断高を超えても弾かない）。パネルの CH 列と図のラベルは、円弧でライズが幅/2 を超える壊れたデータのときだけ上端がずれる（パネルは検証で弾くので通常起きない）。

## 天井芯（S8a）
- **何か**: 天井セルだけを割る線（中心相当。ユーザー裁定 2026-10-10）。CL の新種別 `'ceiling'`（`discipline:'ceiling'`）。S8a は種別・ポリシー・描画・天井セルの分割まで、追加・削除・移動・延長の操作配線は S8b（下の節）。FBS は不変（discipline は文字列で往復。旧版で開くと中心線に落ちる＝前方互換なしを受容）。
- **他モードに漏らさない**: 天井セルは仕上げのセルを天井芯でさらに割った格子（`gridCells.js` の `grid` 引数＝`CEILING_CELL_GRID`。`FINISH_CELL_GRID` が既定で、天井芯は仕上げの分割線に入らない）。天井だけを `ceiling/ceilingGrid.js`（`ceilingRegionCellsAt`・`ceilingCellsWithin`・`ceilingRefreshCells`・`buildCeilingCellToRoom`）経由で読み、仕上げ・壁・階段・昇降機・構造・展開図は触らない。展開図の区間刻み（`allXValues`）と他階の対応CL探索（`sameCoordCounterparts` の既定）からも天井芯を除く。
- **天伏の見え方と操作**: 描画は天井芯＋通り芯・中心線・補助線（`kindsRenderedIn`＝可視表 ∪ `DISPLAY_ONLY_KINDS_BY_MODE`）、ヒット（操作）は天井芯だけ。通り芯・中心線・補助線は「描くだけ」で、天井芯の端部・移動障害物には通り芯・中心線だけが入る（補助線は入れない）。
- **併合**: 天井セルの key は天井芯 id を含みうる。天井芯の削除で区画のセルが併合されると key が解けず、そのセルは部屋の CH に戻る（S5 と同じ受容）。展開（`ceilingCellsWithin`）は仕上げの `getCellsInRect` と同じ（中心判定なし。L字併合セルへ広がる。裁定: 案A）で、天井芯ゼロなら `refreshCells` と key・順序とも一致する。区画のセルが仕上げ key（S5 の区画）でも天井の分割へ展開される。
- 既知の限界: 天井芯は階固有で他階へ複写しない。中心線にまたがれた（動かして越えた）天井芯の矩形は読む側で min/max に正規化する。

## 天井芯の操作（S8b）
- **入口は平面と同じ描画エリアの長押し**（ガターの長押しは通り芯専用で天伏は使わない）。天伏の `pointerDown` は S2 のセルドラッグ開始に加えて汎用の `longPress` を始め、500ms 静止で `onFire` がセルのドラッグ選択を捨ててメニューを出す（選択済みの `selection` は保つ。動いたら長押しは取り消してセル選択を続ける）。リード既定（裁定待ち）: 静止 500ms をメニューにする。
- **メニューは天井芯の操作だけ**: 空＝垂直線／水平線の追加、線上＝移動／削除、端点＝延長／短縮|削除。交点・壁・建具は `snap.js` が天伏では候補にせず（`pointerTargetScope`）、`buildMenuState` も null で返す（多層防御）。偏芯（内壁指定が無い）・中心⇔通り芯の入替え（平面限定）は条件が立たず出ない。CENTER 寸法の足は天伏では落とす（天井芯の寸法行は出さない）。
- **追加**: `AddCLDialog` の種別は天井芯の1種（`KINDS_BY_MODE.ceiling`）。「基準からの距離」の参照は中心線・補助線・天井芯（`isRenderTarget` で絞る。通り芯は常に別枠）なので、目印の中心線を基準にすると天井芯が追従する。端部は直交する通り芯・中心線・天井芯を参照（`addCenterLineFromDialog` は `extentAnchorStyle==='ref'` の共通経路）。同座標の通り芯・中心線には引けない（`ERR_CL_DUPLICATE(既存の種別)`）、補助線とは共存、同種は重ならなければ結合。構造同期は起動しない（scope=null）。
- **移動**: `CeilingModeState` が平面と同形の `moveState`/`preloadMove`/`startMove`/`updateMove`/`commitMove`/`cancelMove` を持つ。graph は持たず `ctx={graph, project}` を呼び出しごとに受ける。範囲解決とエラー文言は `modes/clMove.js` が平面と共有する。障害物は同方向の通り芯・中心線・他の天井芯・壁（補助線は越える）、吸着先は他の天井芯だけ。確定は `commitCLMoveOp`（梁芯以外の共通経路。bake→結合→undo）。
- **削除**: `deleteCenterLineWithUndo` の非通り芯分岐で壁の再生成は走らない（セル分割線ではない）。undo は階のスナップショット。
- 既知の限界: 同軸の天井芯どうしを移動で結合すると吸われた側の id が消え、その id を含むセルの区画は部屋の CH に戻る（`cl-conversion-limits.md` 14）。

## 今後（裁定待ち）
- 区画を持つときは「同じ高さ・同じ材は1面」へ寄せるのが筋（下の見切り線の後処理はその暫定）。
- 天井面の高さは部屋の床段差を含む（裁定）が、壁の上端（`planSolids.js wallCeilZ`）は床段差を含めない。両者がずれる部屋（段差のある部屋）では天井と壁の高さが揃わない。
