# 天伏モード（見上げの天井伏図）

天井伏図モード（appMode `'ceiling'`。ModeBar の「天伏」）。見上げ図の描画と、天井欄の指定を行うための専用モード。用語は `glossary.md`「天伏」。

## 構造（S1a'）
- **仕上げモードとは独立**: 専用の State（`modes/CeilingModeState.js`）・専用パネル（`ceiling/CeilingPanel.jsx`）を持つ。仕上げ表との兼用案は捨てた（ユーザー裁定 2026-10-10）。共有するのは**データ（Room の天井欄）と純モジュール**（部屋の述語 `finish/interiorTabRooms.js`・階段タイプ表記）だけ。State は借りない（UI の部品は S3 で材選択の `MaterialSelect` だけ共用）。
- **パネルは仕上げ表に揃えた木**（S12c。ユーザー指示 2026-10-11「仕上げモードに合わせて〔行のドラッグ移動は不可〕」「三角は行末」「1行＝1親部屋」「部分指定は親部屋の中〔ここにも三角〕」）。木と平らな行の組み立ては純関数（`ceilingPanelRows.js` の `ceilingPanelTree`／`ceilingPanelLines`／`nodePathOf`）で、JSX は列を描くだけ。
  - **ノード id＝群 id**（`ceilingGroups.js`）。選択の強調は `selection.groupId === node.id` の一致だけ（群が今は無い選択は選択なし扱い。`selectedNodeId`。**展開は保つ**〔選び直すまで〕。裁定 2026-10-11）。行クリックは `mode.selectNode` で群を選び、押された行の祖先の経路（`line.path`）をそのまま開く（タブは切り替えない。キャンバスの選択だけが所属でタブを切り替える）。同じ対の部屋の2本の階段にまたがる区画は両方の階段の下に同じノードで出る（既知の限界）。シートの持ち上げ信号 `selectedRoomId` は選択中の群 id で、三角の開閉では変わらない。
  - **列**: 部屋名｜天井材｜仕上げ｜CH｜▸（三角は**行末**。全ノードに出す。三角と select のクリックは行へ伝播させない）。見た目〔罫線・見出し・フォント〕は `FinishTable.jsx` に揃える。**並び替えは作らない**（仕上げ表の並びがそのまま出る）。
  - **内部タブ**: 最上位＝仕上げ表の内部タブの部屋のうち部分指定でないもの。部分指定の子は親の下（複数の親はタブにいる最初の親〔graph.rooms の順〕の下。親がタブに無い子は最上位）。部屋を開くと 形状・天井高・寸法の欄（`RoomCeilingFields`。天井を持たない部屋は「天井なし」の1行）→区画の行→子の部屋、の順。区画の行は名前「区画n」、天井材・仕上げの2列を1セルにして「形状｜寸法｜セル数」、CH 列は基準高（平面以外は基準高～基準高＋ライズ）。区画を開くと区画単位の欄（`CeilingZoneFields`）。面が0件の区画も行は出す。
  - **階段タブ**: 最上位＝階段。開くとその階段所属のセルを持つ区画だけ（部屋レベルの欄は出さない。階段の残りは天井を持たない）。区画が無ければ「区画なし」。天井材・仕上げは対の部屋へ書き、部屋の無い階段は「—」。
  - **展開**: `expandedPath`（各段で開く id の経路。各段1つだけ＝アコーディオン）。選択の確定で `nodePathOf` の経路を開く（そのタブの木に無ければ畳む）。内訳の「選択中: Nセル」ブロックは廃止。
- 境界処理は突入時の壁の鮮度判定（`refreshWallsForViewEntry`。見上げも`graph.walls`を読むため。展開と同じ）だけ持つ。exitは不要——天伏モードは`room.ceilingZones`・天井芯しか書かず、壁の入力ではないため。パンのみのポインタ分岐、CL 種別ポリシーの ceiling 行は登録済み。

## 見上げ（S1b）
- 描画は平面の断面解決を**向きだけ反転**して流用する（鏡像ラッパー）。切断高は**天伏専用**の階の属性 `ceilingCutHeightMm`（読み口 `ceilingCutHeightMmOf(plane)` 唯一。平面の `planCutHeightMm` と同型。ユーザー裁定 2026-10-10）。既定は 1500（ユーザー未指定のため平面の既定と同値）。2026-10-22 から**天井の無い所（吹抜け・屋外・天井なしの部屋）の切断高**で、天井のある部屋は部屋ごとに決まる（下の「切断高は部屋ごと」）。階チップのメニュー「天伏切断高」から変更（ダイアログは `PlanCutHeightDialog` を title で共用）。方式・窓規則を使わない理由・天井の立体・自階で描く種別・鍵は `.claude/plan-section.md`「見上げ（天伏。S1b）」。
- 天井の面は `ceiling/ceilingSurfaces.js` が唯一の算出（部屋ごとのセル矩形と天井高）。セルの帰属は選択と同じ所属索引（`ceilingOwners.js`。下の「選択（S2）」）: `kind:'room'` のセル＝その部屋の面（区画＋残り）、`kind:'stair'` のセル＝対の部屋（`stair.roomId`）の区画の面だけ。索引に無いセル（天井を外した屋外・未割当・隣の無い吹抜けなど）は面にならない。吹抜けのセルは隣の部屋の面に溶け込む（下の「選択（S2）」の吹抜けの所属）。天井の実体（材料・区画・天井芯）が入ったとき、天井立体の中身はこの関数の差し替えで済ませる。
- 同じ高さで隣り合う部屋の天井の境目（壁の無い境界）の線は、**細線グレーで描く**（消さない。ユーザー裁定 2026-10-10）。立体が部屋ごとのため解決器は両立体から1本ずつ（計2本）出す。`ceiling/ceilingBoundaryStyle.js markSameHeightCeilingBoundaries` が出力の ceiling 線のうち同じ高さ（eps 0.5mm）の面の共有辺の上の部分だけに `style:'ceilingBoundary'` を付け（一部だけ乗る線は分割）、(向き, 座標) ごとに出力済みの区間を差し引いた残りだけを出して1本に畳む（T 字の境界でも重ならない）。`PlanSolidsLayer.jsx` が `CEILING_BOUNDARY_COLOR` で描く。高さが違う境界（段差）の見切り線・天井の外形は通常の細線のままだが、座標が完全一致する同座標の重複（段差は両立体の2本）は1本に畳む。
- 木造階段の復路下の壁（data-model.md「復路下の壁」。ユーザー指示 2026-10-14）は見上げでも `graph.walls` から現れる（切断高の壁として。専用の処理は持たない）。
- **切断高は部屋ごと**（裁定 2026-10-22。`ceiling/ceilingCutHeight.js ceilingCutResolverOf` が唯一の供給源。10/18 の「階の 1 値＋低い部屋の例外」を置き換えた）。理由: 天井高が部屋で違う図面では、階の 1 値だと実際の天井・下がり梁に切断面が合わないため。
  - 部屋の切断高＝min(天井面の最低点, 部屋の中に見える下がり梁の下端の最小) − 1mm（`CUT_BELOW_CEILING_MM`＝2·eps）。天井面の最低点は床段差込みの絶対 z で、区画と、傾斜・円弧・ドームの低い側を含む。**1mm にした理由**: 0.5mm（eps）だと壁・柱の天端との差が eps に届かず、天井の線を遮蔽できない（13.stq 1階で 22→97 本）。下げる範囲は部屋全体。部分指定の子は親とまとめて 1 部屋（群の最小）。
  - 天井の無い所（吹抜け・屋外・STAIR_VOID・天井なしの部屋）は階の値 `ceilingCutHeightMm`（メニュー「天伏切断高」は残す）。
  - 壁は両側のうち**天井のある側の低い方**（両側とも無ければ階の値）。壁の長さ方向で接する部屋が替われば位置ごとに決まる（`wallCutAt`）。腰壁・垂れ壁は区間に沿った 3 点の最小で 1 区間 1 値。
  - **下がり梁**（自階の層の梁）は 3 条件すべて: (i) 梁の下端が、重なりの中の天井面の最高点（`zMaxIn`）より下／(ii) 足元から壁の帯を引いた残りが部屋の天井面と面積を持って重なる／(iii) 下端が部屋の床面より上（床梁は除く）。天井に届く梁でも下端が天井より下なら下がり梁。外形だけ中線（`droppedBeamStyle.js`）。
  - 全部屋が階の値と同じなら uniform（数値の切断高で解く。出力不変）。
  - 既知の限界: 部屋の境界で切断面が段になる（交線は出さない）／部屋ごとの切断高の違いを示す注記は**未裁定で出さない**／部分指定の子が 2 つの親を参照すると 2 家族が 1 群に合流する（`roomReinterpret.js` が参照を足すだけで外さない。実データ 0 件）／上階の層の梁（踊り場の受け梁など）は見上げの立体に入らず、描かれず下がり梁にもならない（S1 以前から）。
  - **壁の上端に床段差を含める（解消 2026-10-22）**: `planSolids.js wallCeilProfile` は両側の部屋の「床段差＋天井高」の低い方（`kneeDropWall.js effectiveCeilingTopFromFloor`。式は `roomMetrics.js roomCeilingTopMm`＝天井面 `ceilingSurfaces` の zMm と同じ唯一の供給源）を壁の上端にする。13.stq 1階の部屋 11'（床 +100・天井 2500）の壁は 2500 になり、切断面 2499 に届く。壁の上端は区間ごと（ユーザー裁定 2026-10-22）: 壁を、壁と直交する分割CL（`gridCells.dividerCLsBetween`）で区間に割り、区間ごとに両側の部屋の値を取る（`kneeDropWall.js ceilingTopSectionsAlongWall`・`planSolids.js wallCeilProfile`）。複数の部屋にまたがる長い外壁（13.stq 1階 y=0 の外壁 x −8000〜7000）は、11' の位置だけ 2500 になる（x=3400 で 2400|2500）。上端が同じ隣の区間は `ceilingTopSectionsAlongWall` が結合する（区間の境は上端が替わる所だけ。階の全部屋の「床段差＋CH」が既定の天井高〔`graph.defaultCeilingHeight ?? DEFAULT_ROOM_CEILING_HEIGHT`＝層の天井と同じ値〕に等しいときだけ `uniformCeilingTopMm` の早道で割らず、その値を壁全長の上端にする。既定値と等しいので、部屋の無い区間の値〔層の天井〕は早道の有無で変わらない）。`wallSolids` の key でも結合する。端の角の区間は端の区間の高さのまま。両側とも部屋の無い区間は層の天井。13.stq 1階の見上げは 28→24 本（11' の外壁位置の天井の縁・上階の床の縁が消える。残る y=−3000 の ceilingBoundary は、同じ高さ 2500 の隣の部屋（11 と 11'）の壁の無い境のグレーの細線〔裁定 2026-10-10〕）。moku4 1階（売場・廊下・玄関＝床 −350）の壁は −350 だけ低くなる（天井面と揃う。裁定済み）。
- **天伏の建具**（裁定 2026-10-22）: 建具の幅の 5 点のどれか 1 点で、壁の切断高が建具の下端〜上端（両端を含む）にあれば描く。下端＝壁の床面（天井のある側の低い方。無ければ 0）＋窓台（窓のみ）、上端＝下端＋`effectiveHeight`。床の基準は展開図（`drawnFloorDeltaAt`）と違う。描かない建具は記号を描かず壁も途切れさせない（`wallDrawPlan` の `hiddenOpeningIds`）。判定は `ceiling/ceilingOpeningVisibility.js`、結果は `renderer/ceilingUpDerived.js` で ShapesLayer・OpeningsLayer が共有する。見下げは不変。
- 見上げでは、天伏切断高より低い腰壁（knee あり）の天板の輪郭を描かない（`renderer/ShapesLayer.jsx` が `finish/kneeDropWall.js shouldDrawCapOutline` で判定。向きは `SceneLayers.jsx` が `planSectionDirection(appMode)` で渡す）。切断面より下にあって見上げの視線に入らないため（ユーザー指示 2026-10-17）。垂れ壁は天井から下がって見えるので従来どおり（破線）。腰壁の天端が切断高以上なら従来の描画。この線は壁レイヤ（ShapesLayer）が描くもので、`dumpPlanSolids` の出力には現れない。**見上げの腰壁・垂れ壁は天伏の切断高で解く**（裁定 2026-10-18「天伏の切断高は平面と変える」）: `ShapesLayer` が見上げのとき `resolveKneeDropOverlays(graph, kneeDropUpOptions(wallCutAt))` を使い（`buildWallDrawPlan` の `kneeDrop`。鍵に向きを含める）、区間の切断高＝区間に沿った 3 点の `wallCutAt`（壁の両側の天井のある側の低い方）の最小で判定する（低い側で切断面が壁を貫くため。overlay の `cutMm`。`shouldDrawCapOutline` はこれを階の値より優先）。腰壁が切断されるとき（天伏の切断高が腰壁の天端より低い）は通常の壁（切断線）。同じ区間の腰壁＋垂れ壁は見上げでは**垂れ壁**（天井に近い方。平面は従来どおり腰壁に統合）。既知の限界: 柱の仕上げ包み（`planColumnWraps`・StructuralLayer）は向きによらず平面の腰壁・垂れ壁で解く（見上げで overlay の有無が平面と違う壁の隣の柱包みの辺は平面基準のまま）。

## 選択（S2。S12b で群単位へ）
- **選択の単位は群**（`ceiling/ceilingGroups.js ceilingGroupsOf`。ユーザー指示 2026-10-11「親部屋天井セルはユーザー指定セルの排他セル」「部屋内クリックで関連セルが一緒に選択、該当する行が展開」）。所属索引の全セルがちょうど1つの群に入る: 区画の群（部屋 P の区画のセル。`ceilingSurfacesOf` の区画の面と同じ採り方）／部屋の残り（親・部分指定の子とも。区画のセルを除く）／階段の残り。群のセルは描画の面と一致する（不変条件。テストで固定）。群 id は `room:<id>`・`zone:<部屋id>#<区画id>`・`stair:<id>`（パネルのノード id と共用）。
- タップでも途中までのドラッグでも、開始セルの群**全体**を選ぶ（旧: なぞったセルだけ。`selection = {owner, groupId, cellKeys}`、cellKeys は選んだ時点の写しで undo で解除しない）。「なぞったセルだけ」は下の区画作成のジェスチャの中だけで使う（`ceilingSelection.js` の `allowed` で群の外を足さない）。部屋を超えない規則（開始セルの所属と同じセルだけ）は変わらない。純モジュールは `ceilingSelection.js`、状態は `CeilingModeState`（`selection`・`dragState`）。
- **再タップ／ドラッグで区画を作る**（ユーザー指示「複数選択状態で、その内のセルが再度タップ（またはドラッグ）されると、そこに新しい天井セル生成」）。選択中の群が**部屋の残り／階段の残り**で2セル以上のとき、その中のセルのタップ／ドラッグは `intent:'create'`: なぞったセル N が G の**真部分集合**のときだけ、対の部屋（階段の残りは `stair.roomId`）へ新しい区画を作る（`withFinishUndo` で undo 1回）。裁定: 区画の群の中での再タップは何もしない（選択し直すだけ）／子・階段の残りでも作る／N が G 全体・1セルの残りでは作らない／長押しメニューは `cancelDrag` で捨てるので作らない。作った区画の高さは**数値で固定**し、親の CH の変更に追従しない。初期値: 部屋の残りは部屋の CH＋部屋の形状、階段の残りは直進系なら階段に沿った傾斜（`stairCeilingSlopeDefaults`）、算出できなければ平面＋対の部屋の CH。作成後は新しい区画の群を選択して展開する。
- 所属の優先は「天井を持つ部屋 → 階段 → なし」。部屋は仕上げ `commitDrag` と同じ規則（部分指定の子 → 親、同順位は部屋順の先勝ち）。階段下部屋（2a）は階段のセルに重なっても部屋が勝つ。天井を持たない部分指定の子（吹抜け等）のセルは親の所属にもしない。この索引（`ceilingOwners.js`）は**選択と描画（`ceilingSurfacesOf`）の共通の所属**で、親と部分指定の優先は部屋の並び順（仕上げモードの並べ替え・`normalizePartialDominance`）に依存しない（部分指定どうしが同じセルを持つときだけ部屋順の先勝ち）（S9。ユーザー裁定 2026-10-10: 描画も選択と同じ索引を使う。旧来は描画だけ `buildCellToRoom` の後勝ちで食い違いえた）。STAIR_VOID・天井を外した屋外・未定義・屋根・昇降路・屋外階段・下階の階段は選べない（屋外で feature なしの部屋は既定で選べる。下の「外部タブ」）。階段は選択対象（後で階段に沿った傾斜天井を付けるため。ユーザー裁定 2026-10-10）。
- ポインタ: ガター内・2本指ピンチ・描画エリアの任意の点からのドラッグがパン、クリックは選択、ロングタップはメニュー（天井芯）。なぞり（複数セルで区画を作る）は選択中の群のセルから**ゆっくり**動かし始めたドラッグ（8px 超で 80ms の判定窓。窓の中で 16px を超えればパン、超えなければなぞり。2026-10-19。見分けの規則は `.claude/mode-system.md`「描画エリアの押下ジェスチャー」）。move は 4px 刻みで補間し、速いなぞりでセルを飛ばさない。空白のタップは選択解除、選べないセルから始めたなぞりは前の選択を保つ。タップは常に置き換え（トグル・追加なし）。
- **吹抜け（VOID・屋内）の所属**（裁定 2026-10-17。`assignVoidCellsToNeighbor`）: 吹抜けのセルは、**全高の壁で隔てられていない隣接の屋内部屋**（屋外ポーチは候補にしない。裁定 2026-10-19）のうち**面積最大の部屋**（天井を持つ部屋の所属セルの面積の和。同面積は部屋順の先勝ち）の所属になる。吹抜け部屋は複数セルでも 1 単位。意図＝床の穴は N の天井と無関係で、腰壁で囲まれた吹抜けの上は隣の部屋の天井が続くため（旧来は吹抜けが穴として外形線を作っていた）。隔てる判定＝共有辺と重なる壁を**区間ごと**に腰壁・垂れ壁のレコードで解決し（`kneeDropRecordsOnAxis`。1 本の壁の中で指定が違ってもよい）、腰壁だけの区間を除いた全高の区間の和で辺を被覆する。壁の無いすき間がどれも `SPAN_OVERLAP_EPS`（隅の取り合いの許容差。壁は辺の両端を半壁厚ぶん残すのでこれが要る）以下なら隔てる。全高の壁が無ければ隔てない。垂れ壁・指定なしの壁は全高。隣が無い・全辺が隔てられていれば従来どおり索引外。群・区画・パネルは索引に従うので、吹抜けのセルは親の部屋の群と区画に入る。既知の限界: 吹抜け部屋の面積最大判定に吹抜けどうしの隣接は使わない／セルの辺は CL の value、壁は effectiveValue で取るので、通り芯ドラッグ中（pendingDelta≠0）は両者が食い違い得る（天伏はドラッグ中に索引を再計算しない運用）。
- 確定すると所属に合わせてタブを自動で切り替え（部屋＝内部／階段＝階段）、選んだ群のノードまで木が展開する（空白タップで選択解除＝畳む）。選択・ドラッグ状態は undo に積まない（階切替・モード切替は既存の effect の dispose で消える。**undo/redo では選択は追従しない**〔既知の限界〕: 解けなくなったキーは描画で落とし、群がもう無い選択（作成を undo した区画など）はパネルが選択なし扱いにする）。
- 材（天井材・仕上げ）の指定は S3（下の節）。高さの指定と永続化（天井区画）は S5（下の節）、形状は S6 以降。

## 天井材・仕上げ（S3）
- データ: Room の `customOverrides` に材コードで持つ。`ceilingPanel`（天井材。材カテゴリ 'panel'）・`ceilingFinish`（天井仕上げ。'finish'）。壁材・壁仕上げと同型で、内装マスターには足さない。FBS は汎用の override（keys/vals）なので変更なし。
- 既定: `getFinishInfo()` の読み時に補う（`DEFAULT_CEILING_PANEL`＝せっこうボード t=9.5 `301000000001`／`DEFAULT_CEILING_FINISH`＝ビニールクロス `302000000001`。`DEFAULT_WALL_MATERIAL` の補完と同じ行）。保存データには書かず、旧文書にも既定が出る。空に戻す（`clearOverride`・未選択）と既定に戻る。
- 旧の自由文字列 `RoomFinish.ceilingMaterial` はデータとして残す（FBS・スナップショット・復元は不変）が、仕上げ表の内部タブには出さない（天井グループは 天井材／仕上げ／H／周り縁 の4列）。旧文書の文字列は画面から見えなくなる。
- 照合・保守: `MATERIAL_CODE_OVERRIDE_FIELDS`（FinishModeState）と `isRoomMaterialOverride`（codeNormalization）の両方に2キーを足し、読込み時の正規化・未解決コード検出・保存時の使用中判定の対象にする。
- 表示: 材コードを材マスタ名に解き、`formatMaterialLabel`（`finish/materials/materialLabel.js`。展開図の壁2段書きと共有）で略称にする（「せっこうボード t=9.5」→「PB ア)9.5」）。解けないコードはコードのまま。
- 天伏パネル（S10 で入口を行へ移した。ユーザー指示 2026-10-10「部屋ごとに入力」）: **表の各行**に 天井材・仕上げ の `MaterialSelect`（仕上げ表の部品を共用）を置いて直接編集する。区画の欄は区画の行の中にあり、材の欄は持たない（材は部屋に1つ）。「仕上げは部屋に1つ」なので書込み先は常に部屋（部屋のノードならその部屋、階段ノードは `stair.roomId` の部屋、部屋の無い階段の行は disabled の「—」。階段の対の部屋の解決は `ceilingWriteTargetRoom`）。変更は仕上げ表の master 欄と同じ `withFinishUndo` で1欄1エントリの undo。材データは `CeilingModeState.init()` が仕上げモードと同じ経路で読む（graph を持たないので自階コードの照合はせず `materialError` は常に null）。

## 天井区画（S5）
- 選んだセル群ごとの天井高を `Room.ceilingZones`（不変の `CeilingZone`＝`core/ceilingZone.js`。id・cells・heightMm・shape・dims）に持つ。形状・寸法（S6: 傾斜・円弧・ドーム）の箱は先に持ち、S5 は常に flat・寸法なし。高さは「部屋の FL からの CH」で、null は部屋の CH。
- **Z1 区画のセル ⊆ 部屋のセル**は読む側で守る: `ceilingSurfacesOf` が区画のセルを `refreshCells` で今の分割へ展開し、所属索引（`ceilingOwners.js`）がその部屋に帰属させるセルだけを採る。`setCells`/`removeCell` では間引かない（部屋の cells は分割の粒度が混ざり、生キーの交差は誤って削る）。部屋のセルが減ればデータは残り描画から外れ、戻せば描画も戻る。天井を持たない部屋の区画は無視。
- **Z2 同じ部屋の区画どうしはセルが重ならない**: 書く側（`ceiling/ceilingZones.js`）が、確定のたびに全区画を今の分割へ展開し直し（解けないキーを捨てる）、新しい区画が既存区画のセルを奪い、空の区画を消す。同じ spec の区画があっても統合しない（`createZone`）。部屋の CH と同じ高さでも区画として残す。復元（`restoreCeilingZones`）は区画をまたぐ生キーの重複を先勝ちで除く。
- **Z3 仕上げ表の CH 欄には書かない**: `roomCeilingHeight` の利用者（展開図・壁の上端・腰壁）を黙って変えないため。パネルの CH 表示だけ、効いている区画があれば最小～最大のレンジ表記。
- **部屋の削除確認**: 仕上げモードで部屋を削除するとき（`finish/RoomDeleteConfirm.jsx`。仕上げ表・昇降機タブ共通）、削除される部屋（本人＋道連れの子孫）に `ceilingZones` を持つものがあれば、既存の文言の後に1行「指定された天伏情報も削除されます。よろしいですか？」を足す（件数は出さない。判定は純関数 `finish/roomDeleteCeilingNotice.js roomsLosingCeilingZones`）。天井材・仕上げの override（`ceilingPanel`/`ceilingFinish`）は他の仕上げ欄と同じく確認なしで消える。
- **区画単位の書込み（S12b。ユーザー指定ごとに区画が1つ）**: `createZone`（他の区画からセルを奪って新しい uuid の区画を末尾に足す。**同じ spec でも統合しない**）／`updateZoneSpec`（id・セルを保ち形状・基準高・寸法だけ差し替え。統合しない）／`removeZone`（セルは部屋の残りへ戻る）。パネルの区画の欄は区画単位（確定＝`updateZoneSpec`、解除＝`removeZone`）で、平面で天井高が空欄は弾く（`requireFlatHeight`。やめるときは解除）。部屋の残りの欄（`RoomCeilingFields`）は部屋の形状・天井高を書く（S12a）。旧 `assignZoneShape`（同 spec へ統合）・`clearZoneCells`・`zoneStateOfCells` は S12c で削除した（テストのフィクスチャも `createZone` ベース）。部屋の CH がレンジ表記（数値化できない）のとき、残りから作る新区画の高さは既定の CH（`roomCeilingHeight().mm` のフォールバック）で固定する。
- 階段所属のセル群の区画は対の部屋（`stair.roomId`）の `ceilingZones` に持つ（入力は S6b で解禁。下の節）。
- 描画: 部屋は「残り（`zoneId` null）→ 区画の配列順」の面に分かれ（`planSolids` の `source.id` は区画なら `部屋id#区画id`、残りは部屋 id のまま）、同じ高さの境界のグレー化は面のリストを汎用に扱う既存の後処理がそのまま効く。
- undo は仕上げの `withFinishUndo`（`snapshotRoomsState` に区画が入る）。階の複製・検討案コピーは snapshot 全体の線 id 振り直しで区画のセルも新 id になる。
- 既知の限界: CL 削除でセルが併合されると区画の旧キーは解けず、そのセルは部屋の CH に戻る（受容）。階段の上下階同期（`stairFloorSync`）は区画を複写しない。

## 形状と寸法（S6a）
- 区画の `shape`（平面 flat／傾斜 slope／円弧 arc／ドーム dome）と汎用の寸法 `dims`（寸法1・寸法2…。形状が違っても欄を共用する。ユーザー裁定 2026-10-10）。S6a は**平面と傾斜**まで。円弧・ドーム（幾何・ラベル）と階段所属の入力解禁は S6b（下の節）。
- `heightMm`＝**基準高**。平面＝天井高／傾斜＝低い側の高さ／円弧・ドーム＝周縁の高さ（null＝部屋の CH）。個数は flat=0・slope=2・arc=2・dome=1（`CEILING_SHAPE_DIM_COUNT`）。傾斜は [ライズ>0, 上がる向き]、向きは y 下向き座標の度で 0=右・90=下・180=左・270=上（階段の `upDirection` との対応は `UP_DIRECTION_TO_DEG`）。円弧は [ライズ, 軸 0|90]、ドームは [ライズ]。
- **形状に合わない寸法は区画を捨てず flat・寸法なしに落とす**（`normalizeCeilingShape`。復元・`fromData`・書く側で共通。余分な dims は切り詰め）。壊れた文書でもセルと基準高が残るため。ただし基準高 null かつ flat に落ちた区画は「指定なし」なので、これまでどおり捨てる。
- 区画の書込みは同じ (shape, 基準高, dims) でも統合しない（S12b 以降。旧 `assignZoneShape` の統合は廃止）。平面で基準高 null は区画にならない（作成・確定とも弾く）。
- 傾斜の面は下屋と同じ `zAt` の経路で立体になる（`ceilingShape.js ceilingShapeSolidZ`。外接矩形で正規化した u に沿って baseZ〜baseZ+ライズ、範囲外は端へクランプ）。見上げに新しい規則は作らない: 切断高をまたぐ傾斜は鏡像の slopedCut になり、切断高より上の輪郭だけが細線で出る（等高線は出さない＝既知の限界）。
- ラベルは平面以外の面だけ・詳細 LOD だけ。基準点は面積最大の矩形の中心。傾斜は**上がる向き**の矢印（下屋は水下向きだが天井は階段の上り矢印と同じ向き）＋「傾斜 CH低い側〜高い側」。寸法・矢じりは下屋の傾斜ラベルと共通（`ROOF_LABEL_*`・`chevronPoints`）。基準点が切断高より下なら解決器の可視判定で消える。
- 同じ高さの境界のグレー化は**平面どうしだけ**（`sameHeightBoundarySegments`）。傾斜系は高さが一定でないので境界は通常の細線。
- 入力の表と検証は `ceiling/ceilingShapeFields.js`（`parseCeilingZoneDraft` は例外を投げず値で返す。円弧のライズ≤幅/2。天端が切断高・階高を超えても弾かない）。

## 円弧・ドーム・階段（S6b）
- **幾何**（`ceilingShape.js ceilingShapeSolidZ`。外接矩形 B 基準）: 円弧（ヴォールト）は軸 `dims[1]`（0＝x に平行・90＝y に平行）に垂直な幅 w、中心線からの距離 t として `R=(w²/4+rise²)/(2·rise)`・`z=baseZ+√(R²−t²)−(R−rise)`（中心線が baseZ+rise・縁が baseZ）。ライズは描画時に w/2 でクランプ（半円で R=w/2。壊れたデータでも例外にしない）。ドームは B の中心からの正規化座標 p,q∈[−1,1] で `z=baseZ+rise·(1−p²)(1−q²)`（積型の放物面。周縁が baseZ・中心が頂点）。範囲外は端へクランプ。リード既定（裁定待ち）: 積型の放物面。
- **ラベル**: 円弧「円弧 CH低〜高 R=半径mm」（R は mm 整数・高はクランプ後のライズ）・ドーム「ドーム CH低〜高」。矢印なし（向きが無い）で基準点（面積最大の矩形の中心）に中央寄せ。LOD・フォントは傾斜と同じ（詳細だけ）。切断高をまたぐ円弧・ドームは傾斜と同じく切断高より上に残る輪郭だけが出る（等高線なし）。
- **階段所属の入力**: 書込み先は階段なら対の部屋（`stair.roomId`。`ceilingWriteTargetRoom` が解き、パネルのノードの `room` に載る。部屋の無い階段は null＝パネル disabled）。区画は対の部屋の `ceilingZones` に持ち、全形状を入力できる。
- **直進系の初期値**（`ceilingShapeFields.js stairCeilingSlopeDefaults`）: 選択中のセル群に区画が無く所属の階段が STRAIGHT／STRAIGHT_LANDING のときだけ、パネルの下書きを傾斜にする。向き＝`UP_DIRECTION_TO_DEG[upDirection]`／基準高＝対の部屋の CH／ライズ＝`riserOf(stair, 階高)×総段数×（区画セル群の上り方向の長さ ÷ 階段セル群の同方向の長さ）`を mm に丸めた値（区画が階段全体ならライズ＝階高＝踊り場込みの平均勾配）。階高は App から `floorHeight` prop（`floorHeightAbove(project, project.activePlane)`）。蹴上が決まらない（最上階など）・対の部屋なし・折返し／回り／矩折等は null＝平面の初期値（**折返し・回り階段は手入力**）。初期値は下書きだけで、確定するまで区画は書かれない。
- **描画**: `ceilingSurfacesOf` は、天井を持たない対の部屋（feature STAIR）でも `stairHasCeiling` が真で区画を持つなら区画の面を出す（区画のセルのうち所属索引が階段所属としてその部屋に帰属させるセルだけ＝階段下部屋 2a が取ったセルは落ちる）。区画の無い階段・区画に入らなかった残りのセルは従来どおり天井を描かない。
- **階段下の群（ユーザー指示 2026-10-15「最下階の階段下の天井を指定する経路がない」。仕上げモードで階段下セルを階段と二重に登録できるのと同じ）**: 階段の破れ線先セルで直下階に階段が無いもの（最下階は全部）を、階段本体と別の群 `stairUnder:<階段id>` として選べる（`ceilingStairUnder.js`・`ceilingGroups.js`）。**選択専用**で、所属索引・描画・保存形式は変えない（owner は階段のまま＝書込み先の対の部屋・タブの判定は階段と同じ）。下階の判定（セル単位）は App の直下階 peek を `CeilingModeState.stairUnderContext` で渡す（planeId 不一致・peek 不可・検討案の平面〔採用階に無く直下階を判定できない〕は null＝分けない安全側）。2a 部屋があるセルは所属索引で部屋が勝つ。区画に入ったセルは区画の群が先に採る。区画の無い階段下は従来どおり描かない（S12c）。作成規則だけ階段下の群は特例で、1セル以上・群と同じ集合でも区画にできる（他の群は2セル以上の真部分集合）。パネルは階段の子の先頭に「階段下」行、区画はその後ろ。
- 既知の限界: 円弧・ドームの基準は区画の外接矩形なので、L字など非矩形の区画では頂点が区画の外に出て、区画内では基準高＋ライズに届かない。ラベルと CH 列は基準高＋ライズを表示する。
- 既知の限界: 天端の上限は設けない（階高・切断高を超えても弾かない）。パネルの CH 列と図のラベルは、円弧でライズが幅/2 を超える壊れたデータのときだけ上端がずれる（パネルは検証で弾くので通常起きない）。

## 部屋の形状（S12a）
- ユーザー指示 2026-10-11「形状・天井高・寸法1・寸法2は、親部屋に1つ、部分指定ごとに1つ、天伏ユーザ指定（区画）ごとに1つ」。区画以外の「部屋」の分を持たせる。天井高は既存の CH（`ceilingHeight`）で、形状の基準高を兼ねる。
- **保存**: `Room.customOverrides` の2キー。`ceilingShape`（'slope'|'arc'|'dome'。**平面のときはキーを置かない**）と `ceilingDims`（'500,90' のカンマ区切り文字列）。FBS・graphSnapshot・仕上げ undo・`makeRoomUndefined`（`customOverrides.clear()`）は汎用の keys/vals なので変更なし。`wallFreshnessKey`（壁材・壁仕上げだけ）・`codeNormalization`（材キーだけ）には影響しない。
- **読み書き**: `ceiling/roomCeilingShape.js`（純モジュール）。`roomCeilingShapeOf(room)`（`getFinishInfo()` から読み、`normalizeCeilingShape` を通す。不正・room null・getFinishInfo なしは平面・[]）／`setRoomCeilingShape(room, {shape, dims})`（先に正規化。平面なら2キーとも消す。undo は呼び側が `withFinishUndo` で包む）。天井高を天伏から書くときは `applyRoomCeilingHeightDraft`（原文不変は触らない＝仕上げ表のレンジ表記を壊さない／空は override を消す／正の数は数値で書く／それ以外は false）。
- **効き方**: 見上げの「残り」の面（`ceilingSurfacesOf`。区画に入らなかったセル）だけが部屋の形状を持つ。区画の面は不変。**子は親の形状を継承しない**（部屋ごとに1つ。リード既定）。階段の対の部屋の残りは従来どおり描かない。傾斜・円弧・ドームの `zAt`・ラベルは `planSolids.ceilingSolids` が面を汎用に扱うので自動で付く。グレー境界は平面どうしだけなので、形状のある残りの面との境界は通常の細線。パネルの CH 欄は、区画が無くても残りが平面でなければレンジ（基準高〜基準高＋ライズ）。削除確認（`roomsLosingCeilingZones`）は区画に加えて平面でない形状も数える。
- 既知の限界: 展開図の天井線は自室の傾斜・円弧・ドームの部屋形状に追従する（E3a-2・E4。円弧は3点円弧のプリミティブ）。遠側の天井の円弧・ドームは未対応（部屋のCH）。`stairFloorSync.js` は未編集の上階ペア部屋へ overrides を丸ごと写すので形状キーも写る（ペア部屋は天井を持たないので実害なし）。UI からの入力: 部屋の残りの欄 `RoomCeilingFields`（S12b）。dims は固定小数表記で書く（指数 `1e+21` を保存しない）。見上げの「残り」の面には階段所属のセルを混ぜない（`ceilingGroupsOf` の「階段の残り」と同じ。S12c）。

## 天井芯（S8a）
- **何か**: 天井セルだけを割る線（中心相当。ユーザー裁定 2026-10-10）。CL の新種別 `'ceiling'`（`discipline:'ceiling'`）。S8a は種別・ポリシー・描画・天井セルの分割まで、追加・削除・移動・延長の操作配線は S8b（下の節）。FBS は不変（discipline は文字列で往復。旧版で開くと中心線に落ちる＝前方互換なしを受容）。
- **他モードに漏らさない**: 天井セルは仕上げのセルを天井芯でさらに割った格子（`gridCells.js` の `grid` 引数＝`CEILING_CELL_GRID`。`FINISH_CELL_GRID` が既定で、天井芯は仕上げの分割線に入らない）。天井だけを `ceiling/ceilingGrid.js`（`ceilingRegionCellsAt`・`ceilingCellsWithin`・`ceilingRefreshCells`）経由で読み、仕上げ・壁・階段・昇降機・構造・展開図は触らない。展開図の区間刻み（`allXValues`）と他階の対応CL探索（`sameCoordCounterparts` の既定）からも天井芯を除く。
- **天伏の見え方と操作**: 描画は天井芯＋通り芯・中心線・補助線（`kindsRenderedIn`＝可視表 ∪ `DISPLAY_ONLY_KINDS_BY_MODE`）、ヒット（操作）は天井芯だけ。通り芯・中心線・補助線は「描くだけ」で、天井芯の端部・移動障害物には通り芯・中心線だけが入る（補助線は入れない）。
- **併合**: 天井セルの key は天井芯 id を含みうる。天井芯の削除で区画のセルが併合されると key が解けず、そのセルは部屋の CH に戻る（S5 と同じ受容）。展開（`ceilingCellsWithin`）は仕上げの `getCellsInRect` と同じ（中心判定なし。L字併合セルへ広がる。裁定: 案A）で、天井芯ゼロなら `refreshCells` と key・順序とも一致する。区画のセルが仕上げ key（S5 の区画）でも天井の分割へ展開される。
- 既知の限界: 天井芯は階固有で他階へ複写しない。中心線にまたがれた（動かして越えた）天井芯の矩形は読む側で min/max に正規化する。

## 天井芯の操作（S8b）
- **入口は平面と同じ描画エリアの長押し**（ガターの長押しは通り芯専用で天伏は使わない）。天伏の `pointerDown` は押下点で長押しメニューの対象（天井芯・端点・空）を解決し、「なぞりができる点か」（`startDrag` の `intent:'create'`＝選択中の群のセル）だけ判定して `dragState` はすぐ捨て、汎用の `longPress` を始める。500ms 静止で `onFire` は**常にメニュー**（天井芯の追加・移動・削除・延長。判定窓と記録を捨て、選択済みの `selection` は保つ。離したときの確定も走らせない）。成立前に 8px 超動けば長押しは取り消し、なぞり（ゆっくり）かパン（速く）を動き出しで見分ける（2026-10-19 ユーザー裁定「選択中の群の上のロングタップは天井芯追加」。`.claude/mode-system.md`「描画エリアの押下ジェスチャー」）。
- **メニューは天井芯の操作だけ**: 空＝垂直線／水平線の追加、線上＝移動／削除、端点＝延長／短縮|削除。交点・壁・建具は `snap.js` が天伏では候補にせず（`pointerTargetScope`）、`buildMenuState` も null で返す（多層防御）。偏芯（内壁指定が無い）・中心⇔通り芯の入替え（平面限定）は条件が立たず出ない。CENTER 寸法の足は天伏では落とす（天井芯の寸法行は出さない）。
- **追加**: `AddCLDialog` の種別は天井芯の1種（`KINDS_BY_MODE.ceiling`）。「基準からの距離」の参照は中心線・補助線・天井芯（`isRenderTarget` で絞る。通り芯は常に別枠）なので、目印の中心線を基準にすると天井芯が追従する。端部は直交する通り芯・中心線・天井芯を参照（`addCenterLineFromDialog` は `extentAnchorStyle==='ref'` の共通経路）。同座標の通り芯・中心線には引けない（`ERR_CL_DUPLICATE(既存の種別)`）、補助線とは共存、同種は重ならなければ結合。構造同期は起動しない（scope=null）。
- **移動**: `CeilingModeState` が平面と同形の `moveState`/`preloadMove`/`startMove`/`updateMove`/`commitMove`/`cancelMove` を持つ。graph は持たず `ctx={graph, project}` を呼び出しごとに受ける。範囲解決とエラー文言は `modes/clMove.js` が平面と共有する。障害物は同方向の通り芯・中心線・他の天井芯・壁（補助線は越える）、吸着先は他の天井芯だけ。確定は `commitCLMoveOp`（梁芯以外の共通経路。bake→結合→undo）。
- **削除**: `deleteCenterLineWithUndo` の非通り芯分岐で壁の再生成は走らない（セル分割線ではない）。undo は階のスナップショット。
- 既知の限界: 同軸の天井芯どうしを移動で結合すると吸われた側の id が消え、その id を含むセルの区画は部屋の CH に戻る（`cl-conversion-limits.md` 14）。

## 階段上の裏面（S13a）
復路の到達辺は N+1 の床梁の外面＋仕上げ（`stair-model.md`）。`stairSoffitSolids` は `aboveGraph` を受けて合わせる（自階の階段の裏面・復路下の壁の天端）。裏面の面（footprint＋zAt）の式は構造に依らない `stairUndersideSurface` に切り出してあり（唯一の供給源）、`stairSoffitSolids` は木造だけをそれで天伏の立体にする。平面の階段の足元の中の壁の天端（鉄骨・RC 含む）も同じ面を引く（`plan-section.md` の壁の上端）。見上げの N+1 の階段の裏面の到達辺は N+2 の床梁の外面＋仕上げ（S10-6 S3・2026-10-25）: `App.jsx`の上階 peek の effect が見上げ（`planSectionDirection==='up'`）のときだけ N+1 と N+2 を並行に peek し（set は 1 回。N+2 の失敗は warn して null）、`planSolidsLayerSolidsUp`が`abovePeek.aboveAboveGraph`を`opts.aboveGraphOf`で最上の層に渡す（層スタックには積まない。見下げは peek しない）。鍵は見上げだけ末尾に N+2 の plane id。実データ 35 文書の見上げのうち 26 階分（すべて 1 階）で裏面の矩形の到達端と床の穴の縁が 0.1〜25mm 動いた（足元の壁の天端・段の線の変化は 0）。見上げの golden（`golden-plan-solids/planSolidsUp-*`）は npm test から読まれない（検出力なし）＝`dumpPlanSolids.mjs --up` で採り直して目視の基準にする。
N 階の天伏は「N の天井面際から N+1 の床を裏から見た図」。N の階段の足元の上にある N+1 の階段（N の続き）は裏から見た姿で描く。続きの判定は下階の階段とのフットプリント（外接矩形）一致（`openingBeamAxes.js matchingStairBelow`）。
- 上階スラブの穴は、続きの階段では破れ先でなく**足元全体**（`slabOpening.js floorOpeningCellRects` の `stairExtent:'full'`。見上げ＝`planSolids` の `opts.lookUp` だけ）。N の天井は足元の縁で終わる（裁定 Q2a）。
- **鉄骨**: 踏面線を全段、細線の実線で（`stairTread` の輪郭を有効化。破れ線なし）。**木造**: 階段裏に天井材仕上げがあるので踏面線は描かず、傾斜天井（`ceiling/stairSoffit.js stairSoffitSolids`。kind `'ceiling'`・source.kind `'stairSoffit'`）だけを描く。
- 裏面の高さ＝段 k の天端 − dz。dz＝`STAIR_SOFFIT_THICKNESS_MM`（300）/ cosθ（tanθ＝蹴上/踏面）。**300 は傾斜に直交して測った厚み**で、踏面の厚みではない（裁定 Q4）。往路は上り口で「当該階天井」（N の階段の対の部屋の CH＋床段差。無ければ既定の天井高。裁定 Q3a）から回転部の最初の段（zA）まで、復路は回転部の最後の段（zB）から到達辺まで。直進系は 直進部1→踊り場（平ら）→直進部2。
- **階段 1 本＝1 立体**（2026-10-11 ユーザー目視是正。source.part は 0 だけ）。往路・回転部・復路を別立体にすると、接する辺で線が 2 重・ずれた。footprint.rects の 4 枚（往路 R_A・回転部 A の Q_A・回転部 B の Q_B・復路 R_B）にまとめ、同じ立体の矩形の共有辺は輪郭として描かれないので、面の折れ目だけを `innerLines`（role `'stairSoffitFold'`）で描く。
- **回転部の前縁はレーンごと**（ユーザー実機確認後の是正 2026-10-11。「y=−8235 の線を往路側直進部の終端とし、回転部を 2 分した線をピボットまで延長。往路側では −8145 の線を削除。復路側は −8145 の線を復路側の開始端とし、−8235 の線は削除」。先の「両レーン共通の前縁 1 本」案は撤回）: R_A は frontA（柱の往路側の面）で終わり、Q_A の前縁も frontA。R_B は front から始まり、Q_B の前縁も front。柱がなければ frontA＝front。往路レーンに front の線、復路レーンに frontA の線は構造上出ない。柱ありの踊り場は前縁が往路側 frontA・復路側 front の 2 区間になる（受容）。
- **回転部は段数によらず三角 4 つ。2 分線は上階の階段の回り段の扇形のピボットから全長**（ユーザー是正「45 度にすることがゴールではない。隔て板ピボットに合わせることがゴール」）: ピボットは `uTurnPlanLayout().pivotAcross`（`turnPivotS`＝柱があれば柱の往路側の面 column.sA、無ければ sA。buildWinding の pivotA・P2 と同じ。レーンのあき [sA, sB] の中に収める。partitionFrameFor が柱の面をあきの中に収めるので通常は丸めは起きない）で、往路側 P_A＝(pivotAcross, frontA)・復路側 P_B＝(pivotAcross, front)。これは Q_A（s0〜pivotAcross × frontA〜back）・Q_B（pivotAcross〜s1 × front〜back）の前縁側の内側の角そのもの。Q_A は P_A→O_A=(s0, back)、Q_B は P_B→O_B=(s1, back) の対角線で 2 分する（三角 A1=(P_A, F_A, O_A)・A2=(P_A, O_A, I)・B2=(P_B, I, O_B)・B1=(P_B, O_B, F_B)）。頂点が矩形の角なので前縁で R と Q の高さは連続する。
- **頂点の高さ＝回転部を角度で等分**（**裁定待ち**。「段数によらず 4 三角」から導いたリード既定）: Δ＝zB−zA（回転部固有の蹴上×蹴上。マス数−1）。ピボット・前縁の外側の角は zA（往路側）／zB（復路側）、外側の奥の角は zA+Δ/4（往路側）・zA+3Δ/4（復路側）、内側の奥 I は zA+Δ/2。
- **折れ目の線（innerLines）**: 前縁（往路は frontA を s0〜sA、復路は front を sB〜s1。R_A/Q_A・R_B/Q_B の共有辺。残りは矩形の輪郭）、対角線 2 本（ピボットから外側の奥の角まで全長。Δ>0 のときだけ）、回転部 A/B の境（x=pivotAcross、back に近い方の前縁〜back。高さが食い違う共有辺。Δ>0 のときだけ。frontA〜front の区間は Q_A の輪郭）。踊り場（マス数 1）は平らで前縁の線だけ（裁定 Q5 と整合。「段数によらず」は回り段の範囲の話と解釈）。あき 0（sA==sB）のときは往路 R_A と復路 R_B の境（x=sA、frontA/front〜base の共通部分）も足す。直進系は land1・land2 の 2 本（隣り合う部品が両方あるときだけ）。幾何は across/run/vertical の向きに依らない（端は基準の辺からの距離で選ぶ。`uTurnSoffitFromLayout` を layout を模した入力で単体テスト）。
- **見上げでは自階の「続き階段」の段を遮蔽に入れない**（裁定 2026-10-11 案(a)。Q1「N の天井面際から N+1 の床を裏から見る」・Q7「天伏では自階の階段を描かない」と一貫）。続き階段＝上階の層の階段と `matchingStairBelow` で一致する自階の階段で、`planSolids.js stairsContinuedAbove` が `stairTreadSolids` から除く（床の穴・裏面と同じ述語・同じ入力＝`opts.belowGraphOf` が自階を返す上階の層だけ。belowGraphOf が無ければ除かない）。除かないと切断高より上の段（踊り場・復路）が裏面より手前の遮蔽物になり、往路しか線が出ない（moku4 1F で実測）。上階の層が無ければ何も除かない。
- 構造が未設定（null。RC 等で階段の既定構造が null）の階段は鉄骨と同じ扱い＝踏面線を全段描く（ユーザー裁定 2026-10-11）。
- **裏面を天井として扱うかは階段の属性 `soffitFinish` で選べる**（2026-10-25 ユーザー裁定。S8-4）: 唯一の判定は `ceiling/stairSoffit.js stairSoffitFinished(stair)`（'finished'＝天井仕上げあり→裏面を天井に／'exposed'＝あらわし→踏面線／null＝木造なら仕上げ・それ以外あらわし＝従来どおり）。`stairSoffitSolids`（見上げ）と展開図（下階の階段帯 E5・自階の階段下の部屋の帯）が同じ関数を見る。パネルの階段タブは、木造以外の開いた階段ノードの先頭に行種類 `'stairFields'`「階段裏：[裏面あらわし|天井仕上げ]」を出す（木造は仕上げ固定で出さない。RC・構造なしにも出る＝null はあらわし）。階段の構造を変えると `soffitFinish` は null（自動）に戻る（木造へ変えたとき欄が消えて明示値が残らないように）。書込みは `ceilingPanelRows.js writeStairSoffitFinish`（`withFinishUndo`＋`setSoffitFinish`。1 回の変更＝undo 1 回）だけ。反映は N 階の天伏ではなく **N−1 階の天伏の見上げ**（裏面が見える所）。設計意図は `stair-model.md`「階段の裏面の仕上げ」。
- 既知の限界: 取りつき回転部（側面の出入口）は往路の平面に含める／L_TURN・FLARED・OPEN_WELL は裏面なし（木造でも踏面線も出ない）／鉄骨の続きありは実データに無い（テスト用 .stq で確認。下の「検証データ（S13d）」）／柱がある回り階段では Q_A の前縁の輪郭 y=frontA の [sA, pv]（moku4-3 では 852.5〜865 の 12.5mm）が解決器の短線除去（20mm 未満）で出ず、x=sA の線と x=pv の線の間に 12.5mm の切れ目が見える（受容。気になれば別途裁定）。

## 続きの無い階段の上（S13b。2026-10-11 に是正）
仕様「当該階の上階からその上階まで階段が無ければ、吹抜け（細線の×）を描く。設置階の上階の天伏は平面」。続きの無い階段の足元の上には N+1 に STAIR_VOID が残る（`reconcileStairVoids`。続きがあれば吸収される）ので、判定は STAIR_VOID の有無だけでよく `matchingStairBelow` は見ない。
- **N+1（STAIR_VOID のある階）の天伏**: STAIR_VOID は**平らな天井面**（既定の天井高。屋内の STAIR_VOID すべて＝最上階では屋根面の下、中間階では上階の床組が天井に隠れる。選択不可）。自階の×は出さない。当初（S13b）は床の穴の記号（VOID と同じ×）を持ち込んだが誤りだった（最上階の天伏に吹抜けは無い。ユーザー指摘 2026-10-11）ので撤回した。面は `ceilingSurfaces.js stairVoidFace`（zoneId null・flat・zMm＝床段差＋既定天井高。屋内の STAIR_VOID だけ）。**所属索引（`ceilingOwners`）には載せない**＝選べない・群にならない・パネルの行にならない（`roomHasCeiling` は変えない）。索引に載るセルと重なれば索引側が先。隣の部屋と同じ高さの境目は既存の後処理でグレー線。
- **N の天伏**: 足元の上の STAIR_VOID（直上階）に細線の×（role `'upperStairVoid'`・**自階の×と同じ一点鎖線**〔dashKind `'openingCross'`〕）。外形・「上部吹抜け」ラベルは付けない（上階スラブの穴の縁は解決器が実線で出すため）。
- **×の定義＝「N の天井の穴＝直上階 N+1 の床の穴」**（裁定 2026-10-17）: 見上げでは**自階の床の穴の×（role `'cross'`）を出さない**（自階の床の穴は N の天井と無関係）。直上階の VOID・昇降路には STAIR_VOID と同じ×（role `'upperHole'`・dashKind `'openingCross'`・外形とラベルなし。自階の被覆判定もしない）。VOID・昇降路の上階の**破線の外形・ラベル（`'upperVoid'`）は従来どおり見上げでは出さない**。見下げ（平面）は自階の×＋上階の破線で不変。最上階（上階なし）の天伏に×は出ない。`planHoleMarks`／`planHoleMarksOf` の `lookUp` で分岐する。
- 矩形は `floorOpeningGroups` の `stairVoidRect:true`（既定 false）で STAIR_VOID にも解決する。使うのは上階の STAIR_VOID の×（`PlanSolidsLayer` が `aboveStairVoidGroups` を渡す）だけ。**見下げ（平面など）は不変**: 平面は STAIR_VOID に×も「上部吹抜け」も出さず、`selfVoidHoleRects` の被覆判定も STAIR_VOID を無視する。
- 既知の限界: 非矩形の STAIR_VOID（回り階段の 5 セル等。moku1-6）は上階の×なし（平らな天井面は出る）。中間階の STAIR_VOID も面を出すので、moku1-6 2F では 3F の壁 3 本が天井に隠れる（仕様どおり。3F の梁は 2026-10-18 から見上げでは立体にしない）。

## 吹抜け・階段吹抜けの縁と×の分割（2026-10-18）
原則「セル境界（通り芯）は図面に現れない。穴・天井面の縁は囲む壁の面（偏芯を含む）」。立体側の規則（天井面を壁の帯で止める／直上階の void・shaft の下は天井なし／穴を壁の張り出しで狭め縁を中線に／上階の梁は立体にしない）は `.claude/plan-section.md`「見上げ」の「穴と天井面の縁」。ここは×と帰結だけ。
- **×の分割（`plan/planCrossSplit.js`）**: 直上階 STAIR_VOID の×は、自階の天井面（階段下部屋 2a のほか、自階 STAIR_VOID の平らな面・階段の天井区画も含む）のセル矩形を除いた残りを矩形群にして各々に描く。裁定「分割向きはセル群の形を優先。縦横両方に分断されるセル（L 字の根元など）はより大きいセル群に吸収」＝横の群・縦の群に組み両方に属する片は面積の大きい群へ（同面積は横）、和が矩形になる対は併合。外周の辺は faceRect（壁の面）、内側の辺（階段下部屋との境）はセル境界のまま。幅か高さが `SPAN_OVERLAP_EPS` 未満の細片は×にしない。void・shaft の×は分割しない（規則 V で直下の天井が抜けるため）。13.stq 1階は踊り場と往路の 2 枚。
- 帰結: 吹抜けの中に上階の壁面・柱は細線で見えるが梁は見えない。階段吹抜けでは、上階の梁に隠れていた壁・柱・階段裏面の線がつながって出る。

## 自階の階段を描かない（S13c）
天伏では自階の階段の線・外周・矢印も、下階の階段の見下げ（upper エントリ）も描かない（裁定 Q7）。階段は上から見た姿ではなく、上階の裏面（S13a）と平らな天井面（S13b）で表す。述語は `renderer/planFigureVisibility.js shouldShowStairFigure`（`shouldShowPlanFigure` から 'ceiling' を除く）で、`stairEntries.js buildStairEntries` の `isStairMode` がこれを引く＝install・upper・2a壁の描画クリップ（stairUnderClips）がまとめて止まる（2a壁は切断された壁としてそのまま見える）。壁・建具・柱は従来どおり描く。

## 外部タブ（軒裏。2026-10-18）
- 問題.md「天伏に外部、ポーチ、軒裏追加」。タブ `'exterior'`（「外部」）は**平らな表**（部位｜仕上げ｜下地〔上段 下地・下段 向き〕｜備考）で、行はセルの群を持たず選択・展開・強調に関与しない（`ceilingPanelTree` は exterior で []）。行の組み立ては `ceiling/ceilingExteriorRows.js`（純）。
- **行は直上階 N+1 の下屋の軒裏**（屋根セルは屋根面がある階のセルなので、N の見上げに見える軒裏は N+1 の `Room.roofSpec`）＋**最上階（検討案含む）だけ主屋根の軒裏**。直上階の graph は App の直上階 peek を `CeilingModeState.aboveRoofContext` で受け、`aboveRoofGraphOf(graph)` が planeId を照合して階切替直後の古い peek を弾く（`stairUnderKeysOf` と同じ流儀）。
- **直上階の行は表示だけ・主屋根の行だけ編集可**（裁定 2026-10-18）。理由: 他階へ書く前例は境界処理の一括操作（peek→`saveFloor`→階のバイト列で undo）だけで、パネルの欄からの対話的な他階編集は、undo/redo の後に `abovePlanPeek` を取り直す仕組みが無く古い値が残る。編集は N+1 の仕上げモード外部タブ（セルの title で案内）。主屋根は自階の `graph.mainRoofSpec` なので `commitRoofSpecField`（仕上げと共用）＋`markDirty`。
- **屋根区画（2026-10-30 S2）**: 最上階は主屋根の行の次に、区画ごとに「軒裏（屋根区画N）」の行（`SoffitRowKind.ZONE`・id `soffit:zone:<id>`・実効セル0でも出す）を出し、`CeilingModeState.setRoofZoneField`（同じ `commitRoofSpecField`＋`markDirty`）で編集できる。最上階でない階の休眠区画は出さない（`isTopFloorPlane`。`.claude/roof-model.md`「屋根区画」）。
- 最上階では、主屋根・屋根区画の軒先線・割付線・（傾斜なら）棟木等も直上階の下屋と同じ見た目で描く（2026-10-30。外壁の外の軒だけが見える。`plan-section.md`「軒裏」）。
- **屋外部屋の天井（2026-10-18〜19。ユーザー指示「屋外部屋の天井を天伏に出すようにして」）**: 屋外で feature なしの部屋（ポーチ・テラス等）は天井を持つ（`ceiling/exteriorCeiling.js`。`roomHasCeiling` が唯一の述語なので所属・天井面・群・選択・展開図の天井問い合わせが一斉に追従する）。**既定 ON・部屋ごとに外せる**（`customOverrides.exteriorCeiling` を '0' のときだけ置く＝S12a の `ceilingShape` と同じ「既定ならキーを置かない」。FBS 不変）。裁定の理由: 「直上階に部屋や下屋があるセルだけ自動」は天井面の算出に直上階 graph を通す配線（描画・展開図・点問い合わせの全経路）が要り大がかり。既定 OFF でなく ON なのは指示が「出す」ため（帰結: 既存文書のポーチにも即座に天井が出る。バルコニー等は外す）。
  - 既定材は読み時補完を部屋の種別で分け、屋外は天井材＝けい酸カルシウム板 t=8（`DEFAULT_EXTERIOR_CEILING_PANEL`。軒裏と同じ材・別概念）、天井仕上げは補完しない（''＝「—」）。CH は屋外部屋に欄が無いので既定の天井高から始め、天伏の部屋欄（`applyRoomCeilingHeightDraft`）で変える。屋根・屋外階段・昇降路・未定義は従来どおり天井なし。
  - 外部タブの**上段**にこの部屋の木（内部タブと同じ列・区画・形状欄。`exteriorTabRooms`→`roomsTree`〔内部タブと共通の組み立て〕）、行頭に「天井」チェック。外すと群が消えるので `clearSelectionOfRoom` でキャンバスの強調も消す（パネルは選択なし扱い）。キャンバスの選択で切り替わるタブは `tabForOwner`（屋外 room→外部）。下段が軒裏の表。
  - **吹抜けの所属候補は屋内の部屋だけ**（裁定 2026-10-19。`assignVoidCellsToNeighbor`）: 屋外ポーチが天井を持っても、屋内の吹抜けの天井が屋外へ溶け込むのは「腰壁で囲まれた吹抜けの上は隣の部屋の天井が続く」の想定外。隣が屋外だけの吹抜けは索引外のまま。
  - 既知の限界: 天井を外した部屋の区画は「天井なし」の下に 0 セルで残る（戻せば復活）／壁の無い開放側の縁はセル境界（通り芯）のまま、壁側は壁の帯で止まる。
- 既知の限界: 検討案の平面は直上階が無いので下屋の行は出ない／N+2 以上の屋根は扱わない／仕上げ N+1 で編集した値は、天伏 N に戻ると peek の取り直しで反映されるが、解決までの間は前の値が見える。

## 受容（ユーザー裁定 2026-10-10）
とりあえず許容した点（直さない。必要になったら別課題）。
- 階段区画の初期値（基準高＝対の部屋の CH・平均勾配）は、上側だけの区画だと勾配の位置に来ない。
- ドームは積型放物面。非矩形の区画では頂点が区画の外に出る。
- 天井芯は前方互換なし（旧版で開くと中心線）。天井芯の削除・結合・中心線にまたがれたとき、区画のセルは部屋の CH に戻る。
- 仕上げ表の CH 欄は区画のレンジを出さない。展開図の自室の天井線は平面の区画に追従する（E1 済み）。遠側の天井（開放スパン・家族の破線・cellsAlong）も平面の区画には追従する（C2 済み）。自室の傾斜（区画・部屋形状）も追従する（E3a-2 済み。体裁が斜線を引く）。遠側の傾斜は開放スパン・cellsAlong（E3b-1）と家族の破線（E3b-2）が済み。cellsAlong を面で割ること（E3b-3）も済み。自室の円弧・ドームは E4 で済み（3点を通る円弧。遠側の円弧・ドームは部屋のCHのまま）。階段帯の天井は続きの木造階段（U字系）の裏面に追従する（E5-1b 済み。直進系は E5-2・遠側は E5-3 で未対応）。

- 展開図の階段帯の天井は、続きのある木造階段（U字系）の裏面に追従する（E5-1b。設計は `.claude/elevation-model.md`「天井高さの解決」）。直進系（E5-2）・隣室から見える裏面（E5-3）は未対応。レーン間のあきでは天井線が上階天井まで切り欠く（受容）。裏面の最高点が上階天井（chUpperAbsMm）を超える復路の到達側は、頭打ちせず広げる（裁定 Q2）。

## 天井高の点問い合わせ（E0。展開図が区画・形状に追従するための足場）
- `ceiling/ceilingHeightField.js`。平面上の点から層 FL 基準（床段差込み）の天井面の高さを引く。**見上げの天井立体（`planSolids`）と同じ材料から引き、高さの式を二重定義しない**（一致はテストで固定）。面に無い点（天井を持たない部屋・階段所属で区画に入らないセル）は null＝呼び元が `roomCeilingHeight` に落とす約束。
- 共有辺の上は面の順の先勝ちなので、呼び元はセル中央など内部の点で問い合わせる。STAIR_VOID の平らな面も返るが、展開図で使うかは裁定待ち。
- 展開図側の消費: 平面（flat）の区画は E1、自室の傾斜（区画・部屋形状）は E3a-2 で済み（傾斜の golden 差分は ceiling-zone-test〔far-test も同じ 2 階の廊下・子ども1 を含む〕の 2 階の 廊下・子ども1 と、傾斜の部屋を覗く階段帯。E3b-4 で列の幅の最大に）。実装は `elevation/space/zoneCeiling.js`、設計は elevation-model.md「天井高さの解決」。遠側の傾斜は E3b-1 で開放スパン・cellsAlong、E3b-2 で家族の破線が済み（cellsAlong を面で割る E3b-3 も済み。隣室の帯〔階段帯〕の段は E3b-4 で層スタックが列の幅での最大に〔階段帯の傾斜の斜線は未対応〕）、自室の円弧・ドーム（E4。2階の 納戸〔arc〕・予備室〔dome〕の帯だけが差分）は済み、階段帯の傾斜の斜線と遠側の円弧・ドームは以降（遠側の天井の平面区画は C2 で済み）。基準の展開図 golden（ceiling-zone-test／far-test／slope-far-test は E3b-4 の姿＝階段帯は列の幅の最大）は `scripts/probe/golden-elev-ceiling/ceiling-zone-test`（`--regen`。生成は `makeCeilingZoneTestDoc.mjs`）＝自室の区画。遠側（親が子の区画を見る）は `golden-elev-ceiling/ceiling-zone-far-test`（1階 売場の子・2階 収納に区画。生成は `makeCeilingZoneFarTestDoc.mjs`。C1 との差は親の帯＝売場・予備室だけ）。far-test の golden が検出するのは開放スパンの経路（売場・予備室）だけ。家族の破線・cellsAlong は単体テストが守る。第3の検証文書 `golden-elev-ceiling/ceiling-zone-slope-far-test`（`makeCeilingZoneSlopeFarTestDoc.mjs`。far-test の 2 つの子の区画を傾斜 rise 300 へ差し替え。1階 売場の一部＝奥行き方向〔奥の壁へ下がる向き 270〕・2階 収納＝走り方向〔0〕。選んだ向きは面の幾何から表で出す）は遠側の傾斜（E3b-1）の基準で、採取は E3b-1 の前の姿。(C)＝1階 売場の西（売場上段の西 2 セルの子）に天井芯 x=3200 と視線方向に並ぶ平面の区画 手前 3000・奥 2300（親の CH 2400。面 D1 の先で境界は壁の仕上げ面から 382.5mm 奥（芯からは 440mm）＝見えがかりの上限 800mm 以内）を足してあり、E3b-3（cellsAlong が面で割れる）の検出力。golden は (C) 追加後・E3b-3 前の姿。

## 検証データ（S13d）
- `scripts/probe/makeCeilingSteelStairTestDoc.mjs`（既定＝鉄骨 `ceiling-steel-stair-test.stq`、`--wood`＝木造 `ceiling-wood-stair-test.stq`。D:/tatsuya/Download）。3階建て、1F・2F に同じ足元の折返し階段（13.stq の 1F と外形・値は同じ。セルは 1 つ）、3F は STAIR_VOID。実データに無い「鉄骨で続きのある階段」の見上げの確認用。
- 見るべき点: 1F の天伏＝鉄骨は上階の階段の踏面線が全段（裏面の傾斜天井は出ない）、木造は傾斜天井で踏面線なし／2F の天伏＝足元に上階の階段吹抜けの一点鎖線の×／3F の天伏＝吹抜けの足元が平らな天井面。スクリプト自身が往復テストと上記の数値検査を行う（NG で exit 1）。

- 展開図の golden（`scripts/probe/golden-elev-ceiling/`。`dumpElevFigure.mjs --regen` で採取）: E5-1b で 1階の階段帯だけが変わる——`ceiling-wood-stair-test`（往路 2400→4158.27・踊り場 4158.27・復路 4158.27→5658.27）・`moku4-3`（回転部 3740.81/4490.81・復路 5115.81・最高 5615.81）・`ceiling-zone-test`／`-far-test`／`-slope-far-test`（1階の階段〔蹴上 300〕も続きの木造階段を持つ。最高 5531.39）。`ceiling-steel-stair-test`（鉄骨）・moku1-6・stair-ports-test1〜5 は一致。

## 今後（裁定待ち）
- 区画を持つときは「同じ高さ・同じ材は1面」へ寄せるのが筋（下の見切り線の後処理はその暫定）。
- 部屋ごとの切断高の違いを示す注記（未裁定）。
