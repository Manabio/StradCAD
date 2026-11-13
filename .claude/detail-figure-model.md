# 部分詳細図の設計意図

部分詳細図（建具の枠・部屋の取り合い・屋根・器具の姿図を、寸法に合わせて各図へ重ねる図）の登録と反映。純モジュールは `detail/`、登録画面は `ui/DetailHelperPanel.jsx`（判断は `ui/detailHelperForm.js`）、割当ては保守パネルの建具記号タブ。用語は `glossary.md`。方立（平面）・上枠・下枠（展開）の割当ては三方枠（WF/SF/SSF）・片開き戸（方立・上枠）・窓（方立・上枠・下枠。引き違い窓は方立なし）で使う（MVP は三方枠だけ。片開き戸は S8e・窓は S8f）。

## 置き場
- 新カタログ種別 `detailFigure`（7 種別目）。三層（本体＞ライブラリ＞同梱）の照合・差分通知・上書き印がそのまま効く（`catalog-model.md`）。本体は組込みの巾木 出 10（`df-builtin-baseboard-10`）・天板 厚 20（`df-builtin-kneecap-20`）・片開き戸の方立と上枠（`df-builtin-door-jamb-30`・`-head-30`。S8e）・窓の方立 3 種（`df-builtin-window-jamb-25`・`-open-25`・`-notched-25`。S8f-1）・窓の上枠と下枠（`df-builtin-window-head-25`・`-sill-25`。S8f-3b）だけ（`detail/detailBuiltins.js`）。
- 同梱するのは**使用中だけ**（建具記号の `detailFigures` から推移展開で届く図）。下図に使った DXF・PDF の**元ファイルそのものは保存しない**が、そこから選定した図（`provenance.source` が `'dxf'` か `'pdf'`）は手描きと同じく使用中なら同梱する（R10 の訂正。2026-11-13 ユーザー裁定。当初は読み込み由来の図ごと同梱から外していたが、それでは別の端末・後日に図を失うため改めた）。出所は図に付いたまま残る。
- 参照の担い手は建具記号エントリの任意項目 `detailFigures:{jamb,head}`。三方枠の断面形の選び先 `profile` が既に建具記号にある前例に揃え、FBS を触らずに通す。建具個別の上書き（`opening.detailRefs`）は S6a で永続化（FBS 末尾 28・29、undo は建具編集の EDITABLE、読み替えは walker の rewrite）。建具エディタの select（方立・上枠の 2 つ。三方枠と片開き戸だけに出る。先頭は「記号の設定を使う」）と、R16 の明示ボタン（三方枠だけ。片開き戸の見付・出幅は Opening の項目でない＝R5）「図の寸法を建具へ」（解決後の方立の図の param 束縛 mm を見付・出幅へ写す。undo あり・自動の書き戻しなし）。判断は `openings/openingDetailRefsEdit.js`。

## 図の表現
- **ペン命令列（上下左右に指定距離進む一筆書き）をソースに保存**し、点列は描くたびに導出する。寸法をはめ直すには「どの区間が伸縮し、どの頂点が基準に載るか」の意味が要り、プリミティブ保存では失われる。
- 位置は名前付き基準（Datum。壁仕上面・開口端など）と、各ストロークの頂点をそれに載せる Anchor で決める。軸ごとに origin はちょうど 1 つ、Anchor はストロークごと・軸ごとに origin の基準へ 1 つ必須（s・t の 2 つ）。
- **Anchor.offsetMm**（任意・既定 0）: 頂点の位置＝基準の目標＋`Datum.offsetMm`＋`Anchor.offsetMm`。複数の成分を写すとき位置関係を保つために足した（R7）。線を描いて表す案・全層に影響する案を退けた。Anchor を読むのは `detailModel`・`detailFit`・`detailPreview` の 3 つだけなので影響が閉じる。`normalize` はキーを足さない（既存の図のバイト・比較・重複排除を変えない）。検証はキーがあって有限数でなければ `BAD_OFFSET`（新コードは作らない）。明示した undefined は「キー無し」と同じ（JSON 往復で判定が変わらない）、null は `BAD_OFFSET`。
- 伸縮区間（stretch）は、end の基準に載るストロークでは**軸ごとにちょうど 1 本**。end が無いストロークは持たない（あれば `STRETCH_WITHOUT_END`）。目標との差分を 1 本に吸わせるので結果が決定的になる。`mm` の負・0 と stretch の本数・範囲は登録時に、固定の和が目標以上（伸縮が `DETAIL_FIT_EPS_MM` 未満）と param・material の解決値が 0 以下は fit 時（試し込みの表示と init の通知）に検出する。均等配分・比例は採らなかった。
- `LenSpec.mm` はプレビューと試し込み専用。本番の fit で param／material が解決できなければ `{error}`（固定値で代用しない）。
- 斜め `'V'` はデータ形に最初から持つ（符号項目 ss/st）。UI は上下左右から。closed は閉じ辺を描画側が補い、始点へ戻る手は書かせない。

## 分類と取り付け先
- 分類は category × view × subject の組合せ表（`core/constants.js DETAIL_VIEW_COMBOS`）。取り付け先の枠名 `DetailSlot` と許す組合せの対応 `DETAIL_SLOT_TARGETS` も同じ葉に置く（検証と割当ての選択肢が同じ表を引く）。
- 解決順は **`opening.detailRefs` ＞ 建具一式の該当部品 ＞ 記号の `detailFigures` ＞ 既定 profile**（一式の段は「建具一式」節。一式に該当部品が無い slot は次の段へ）。slot が先で、上枠は head ＞ jamb の順で方立の図を流用できる（detailRefs.head ＞ 記号.head ＞ detailRefs.jamb ＞ 記号.jamb。R9。現行の上枠＝方立と同じ形に揃えるため）。`detailRefs` がその slot を null で持つときは「なし」で、記号側の同じ slot を候補にしない（プレビューの明示 null。キー無し・undefined は記号へ進む）。
- 姿図は見る側 `towardViewer===false`（向こうへ開く側から見る）のときだけ `figureBack` ＞ `figure` の順（`resolveDetailElevation`）。`figureBack` が無い・参照切れ・fit 不能なら `figure` へ落ちる（任意の上乗せなので error にしない）。true／null は `figure` だけ。
- 保守パネルのプレビューは未保存の選択を `opening.detailRefs` に載せる（最優先経路は `frameProfile` の上書きと同じ理屈。記号に保存する前の選択はここでしか届かない）。未割当ては null で渡すので、保存済みの割当てを未保存で外した状態も描ける。永続化（S6）は「空なら書かない」ので null は保存されない。

## 反映の口
- 図（描画側）が引ける `detail/` は **`detailPlacement.js` 1 本**（現状の図側の利用者は `openings/` だけ。`openings/importGraph.test.js` で固定。他の図が引くときは同じ形のテストを足す。カタログ・ヘルパーの許可範囲は「モジュール境界」の節）。局所座標（origin の基準＝0）で fit し、frame で図座標へ写す。座標系の差（平面 y 下向き・展開の面ローカル・立面の鏡像）は各図側の frame に閉じ込める。
- 置換するのは建具の枠（paired）と、建具の姿図（figure・S6b）。それ以外は重ね描きで、重ねは遮蔽を受けない。未登録なら 1 プリミティブも変えない（全 golden 不変）。出どころは `source:'detail'`（立面が `kind` を上書きするので kind は使わない）。
- **姿図（slot=figure）**: 参照の担い手は建具種別エントリの `detailFigures.figure`（建具記号ではない。姿図は機構ごとに違うため）と建具個別の `opening.detailRefs.figure`。解決順は `detailRefs` ＞ 建具種別。`buildOpeningElevation` の内部で枠・機構・レバーハンドルの図形を置換し（寸法・FL 線・tag・抑制フラグは従来どおり）、展開・立面・エディタ・プレビューは引数を足さず自動で差し替わる。基準は s＝OPENING_OUTER（origin 0・end 幅）、t＝SILL（窓台上端）または FL（窓台高さぶん下）が origin・HEAD が end。**t は下向き正（ペンの U が t−）**なので図の y＝窓台上端＋t（`ty:+1`）で、HEAD の目標は −高さ。三方枠の展開図のアキ標記（バツ・「ア キ」）は別物で置換しない。立面は fit 失敗・参照切れを入力組み立ての skipped（`DETAIL_FIT_FAILED`）に積み、モードの `materialError` に 1 回出す。
- メモ化は**局所座標の fit だけ**（鍵に世界座標が混ざらない）。placeStrokes は毎回。消費側は独自キャッシュを持たない。
- fit 失敗は既定 profile へ戻して描き、通知は描画時でなく建具モード・展開モードの init で 1 回（`resolveQueue` の場面 `detail-fit-failed`）。平面モードでは通知しない（毎レンダーの純関数に通知経路が無い。R21）。

## 部屋の取り合い（S8a。junction の床と壁・壁と天井）
- 割当ては `Room.detailRefs`（`{floorWall?, wallCeiling?}`・部屋全体・仕上げモードの部屋カード「部分詳細」。仕上げ undo に乗る）。FBS は `RM.DETAIL_KEYS=32`・`DETAIL_VALS=33`、使わない文書は書かず、旧ビルドで保存すると消える片方向（`OP 28/29` と同型）。part（腰壁の天板・段差天井）は要素に付ける別設計（8b）で、ここでは部屋全体の取り合いだけ。
- 基準は部屋が供給する（`finish/roomDetailTargets.js`）: s＝壁の仕上げ面 0〜−壁厚、t＝FL（floorWall）または天井面（wallCeiling）が 0。壁厚は同軸（`sameAxisLine`）で重なる全壁の `wallConcealRange`（materialRange∪backingRange）の合併幅（`roomDetailJunction.js wallAssemblyThicknessMm`）。展開 init の通知は面ごとの壁（`junctionFaceWallsOf`＝隣室が生成した壁を含む）の壁厚でも fit を試す。openings/ のメモ（`fitDetailLocalMemo`）を `targetsOf` 差し込みで共有し、材マップ未ロードの結果はメモしない。通知は仕上げ init（未解決＝`unresolved-code`・fit 失敗＝`detail-fit-failed`）。
- 展開図へは断面そのものを重ねず、**室内側の包絡線**（`detail/detailEnvelope.js`）から水平線を派生する。各高さの最大 s（壁の中 s<0 は見えないので 0 に頭打ち。区切りは端点・辺どうしの交点・s=0 を跨ぐ点）が階段状に変わる所＝段差（>1 mm）、同じ s で辺の向きが変わる所＝折れ（>1°。面取り）が自動の細線、手の印 `Move.edge='air'`（ヘルパーのトグル「空気との境目」）の辺の端点の高さが中線で、同じ高さは中線 1 本。FL・天井面（t≈0）と定義域の外（床より下・天井より上）は引かない。
- 展開への反映（S8a-2）は `elevation/elevationJunction.js` が唯一の口（elevation/ から detail/ を引くのはここだけ・引き先は `detailPlacement.js` だけ。`elevation/importGraph.test.js` で固定）。**派生線**: 面 F は**自分の壁**の厚みで fit し、段差の高さに水平線を引く（床段差・天井の区間高に追従。切るのは壁体の無い区間と線の高さを含む建具の開口だけ。腰壁・垂れ壁では切らない＝S8c で撤回）。段差 t は最小描画幅（`minDrawnMm`＝紙上 0.5 mm×分母）へ調整し、調整後に同じ t へ畳まれる段差は 1 本（air 優先。差し替えの輪郭には適用しない）。floorWall の fit が成った面は巾木線を引かない（図が巾木を担う）。**差し替え**: 倍率が詳細（分母 ≤ `LOD_DETAIL_DENOM`）の 2 パス目だけ、形状差 > 100 mm の slot について帯の両端の単純断面（CUT の縦線・床／天井線の取り合い区間）を差し引き、包絡線の**輪郭だけ**を CUT の polyline で描く（図の内部線は描かない）。端の断面は**隣の面 P の壁の断面**なので fit は P の壁厚・右端は鏡像。
- 展開に拡大縮小は無く、「倍率」は画面の高さに帯が収まる倍率（分母 = 画面 px/mm ÷ scale）で決まる。画面サイズ変更後の再判定はしない。失敗（参照切れ・壁厚に合わない図）は線も差し替えも出さず従来の描き方で、通知は展開 init の 1 回（`collectRoomJunctionFailures`）。
- 組込み: 巾木 出 10（`df-builtin-baseboard-10`・floorWall・高さは param `baseboardHeight`＝部屋の仕上げ設定 h を解析した mm。S8c で固定 60 の `…-10x60` から改名）＝既存の巾木線と同じ出力（`source` 属性だけ違う。`elevation/elevationBuiltinBaseboard.test.js`）。キーは `core/constants.js` の `DETAIL_BUILTIN_*_KEY`（finish/ が組込み層を静的に引かずに済むよう定数だけ constants に置く）。組込み層は `detailPlacement.js` の再輸出 → `openingCatalog.detailFigureCatalog()`（三層合成の唯一の同期口。仕上げ・建具の select・保守パネル・通知が通る）。`catalogKinds.js loadBuiltin` は従来どおり動的 import（静的な再輸出があるので別チャンクには分かれない＝interiorMasters 等と同じ受容）。既知の限界: 仕上げ init の fit 失敗通知は生成壁の壁厚だけ（隣室が生成した壁の面は展開 init でだけ通知）。
- 既知の限界: 差し替えは水平天井の端だけ（勾配・円弧・上階天井の端の wallCeiling は差し替えない）／印は閉じ辺に付けられない／印の辺は包絡線上にあるかを見ず端点の高さに線を出す／包絡線は室内側の最大 s だけで、凹み（欠き込み）の奥は出ない／wallCeiling の派生線は天井の段差の縦線を引かず、円弧・勾配プロファイルの天井では引かない／1 つの面に厚みの違う壁が混ざるときは最も長く重なる壁の厚みで fit／派生線は差し替えた輪郭の下にも細く残る（太線が覆う）／差し替えは吹抜け上部・階段・吹抜け帯と平面・天伏に出ない。

## 要素付きの部位（S8b-1。腰壁の天端・垂れ壁の下端）
- part は部屋全体でなく**要素**に付ける。割当ては腰壁・垂れ壁の記録（`graph.kneeDropWalls` の値）の `detailRefs`（`{kneeTop?, dropBottom?}`。腰壁／垂れ壁の値を外せば対応する slot も落ちる。正規化は `core/kneeDropRecord.js`）と**表の側** `frontSide`（`roomNeg`／`roomPos`。既定は roomNeg でキーを持たない）。図の s 原点＝表の側の仕上げ面で、反対の面から見るときは壁の中心で鏡像（`partDetail.js mirrorStrokesAcrossWall`）。入口は腰壁・垂れ壁ダイアログ（値のある側の select と表の側の切替。undo は記録丸ごとの before/after）。FBS は `KDW 5/6/7`（`serialization-fbs.md`）。
- 基準は `partTargets`（s は junction と同じ、t は `WALL_TOP`＝腰壁の天端・`WALL_BOTTOM`＝垂れ壁の下端が 0）。包絡線の定義域は kneeTop＝t>0（天端より下）・dropBottom＝t<0。派生線は断面エンジンが**帯ごと**に引く（`emitCtx.kneeDropPartStepsOf`。エンジンは detail/ を引かず段差の t を受けるだけ。組み立ては `elevationJunction.js kneeDropPartStepsOf`）。遮蔽・破線への降格は帯の既存判定を共有し、**既存の天端の下の細線（`kneeCapUnderline`＝`max(天板厚 20, 最小描画幅)`。分母未指定の 1/100 想定で 50）は残す＝両方引く**（厚 20 の天板は 1/100 で 50 に調整され既存線と重なり 1 本に見える）。
- 組込み「天板 厚 20×（12＋壁厚＋12）」（`df-builtin-kneecap-20`）は幅を壁厚の param で吸う（end の基準・伸縮は置かない＝検証規則で stretch が 1 本要るため）。垂れ壁の `bottomHeight` は**天井から**の寸法（8a はこれを床高に換算して派生線の覆いを判定していたが、S8c で判定そのものを撤去＝下の一般解）。
- 断面形の差し替え（8b-2）: junction が飛ばす端（隣の面の隅が腰壁・垂れ壁の区間に掛かる端）だけ、kneeTop／dropBottom の割当てがあれば両側の包絡線を連ねた 1 本の輪郭に差し替える（junction と二重化しない）。隅の判定は位置の判定で、面の部屋の側へ少し入った点と隅の CL に掛かる記録だけを見る（同じ壁の離れた区間の腰壁に引きずられない）。向こう側の出は帯の外へはねだして描く。形状差は両側の大きい方が 100 超のときだけ＝組込み天板（出 12）は差し替わらず、カウンター天板等だけ。垂れ壁は水平天井の端だけ。袖壁の分割端は 8b-2b。
- 床の段差（8b-3・`floorStep`）は高い側の部屋が持つ（junction の部屋の割当てとは別系統＝fit と通知を混ぜない）。s は立ち上がり面、t は高い側の床が原点で段差高を伸縮が吸う。派生線は段差見付け面に高い側の床から t の水平線、差し替えは壁面上の床段差の縦線を輪郭へ。持ち主は描くときに riser から高い側へ少し入った点で引く（区間は持ち主を持たず、同じ床高の区間は連結されるので中点は誤る）。定義域は低い側の床まで（それより下の線は形状差・輪郭に入れない）。出（鼻）がある図は高い側の床面を鼻の先まで延ばす。限界: 最小描画幅へ調整後の t が段差高以上になる派生線は引かない。
- 天井の段差（8b-4a・`ceilingStep`）は低い側の天井面の持ち主（区画なら区画・残りなら部屋）が持つ。区画から部屋へは継承しない。s は空気側＝高い側が正、t の伸縮で段差高を吸う。持ち主は保存せず、描くときに縦線側の端の近くで引く（区間中点は同じ高さの隣区間と連結されて誤る）。区画の形状を平面以外にすると割当ては落ちる。差し替えないもの: 傾斜・円弧・上階の天井、境界の CL 上の壁（腰壁だけの壁は壁とみなさない。垂れ壁の管轄）、階段裏面の合成区間。既知の限界: 通知の段差高は上記の境界上の壁・合成区間を見ない（描画との厳密な一致は先送り）。見付け面の新設・描画は 8b-4b-1、派生線は 8b-4b-2（いずれも実装済み。elevation-model.md「天井の段差見付け面」）。派生線（8b-4b-2）は見付け面の `ceilingSteps` の区間ごとに、低い側の持ち主（`lowSurface`。区画があれば区画・無ければ部屋。継承なし）の割当てから引く。床の面へ合流した面は床の派生線と両方。割当て無し・参照切れ・fit 失敗は空（8b-4b-1 と同じ出力）。限界: 階段帯・隣室との差・傾斜／円弧の区画は面が無いので線も無い。
- 実測の注意: 現行エンジンは P の隅が腰壁でも端の縦線を床〜天井の全高で引く（F の壁の端の線）ので、差し替えるのは天端側 [天端−厚, 天端] の割れ目と輪郭だけで、天端より上の縦線は残る（F の壁の端面）。天端の CUT 水平線・向こう側の縦線は帯の外にあり実データでは出ないため、差し引きは出れば消す扱い。既知の限界（受容）: はねだしと向こう側の縦線は帯の範囲外（面と面の隙間）へ出るので、向こう側の出が大きいと天井高寸法線・隣の面と交差する。
- 既知の限界（8b-3 以降）: 他階の層の腰壁・cutAlong の垂れ壁の下端・吹抜け上部帯・階段帯・平面・天伏には出ない／片側が fit できない場合は差し替えない（両側は同じ図の fit と鏡像なので実際は両方成立か両方失敗）／隅の壁の継ぎ目が別の記録に乗るときは F の部屋の側 2 mm の点の記録を採る／床の段差・天井の段差は 8b-3・8b-4。

## 天伏への反映（天井の段差の「出」）
- 意図: 展開は見切りの出を描くが、見上げは区画境界（CL）の線だけだと見切りの縁が出た位置に見えない。低い側の持ち主（区画＞部屋・継承なし）の `ceilingStep` を段差高で fit し、**下から見た包絡線**（s ごとに最も低い材の t。`detail/detailEnvelope.js computeUnderside`。定義域は低い側の天井 t=0〜高い側 t=−段差高）が跳ぶ s・折れる s に線を引く。展開の包絡線（室内側の最大 s・形状差の閾値）とは別物で、展開の形状差閾値（100 mm）は使わない。
- 見える線: 面一の見切り（s=0 に線が無い）は CL の線を隠し、引っ込み・面取りは CL が残る。部位図なし・参照切れ・fit 失敗・線 0 本は従来の CL の線だけ（解決は `finish/partDetail.js ceilingStepUnderside` が null を返す）。破線ストロークは見ない。細線で、air の印は天伏では使わない。
- 置き場: 線は**高い側の天井面の立体の innerLines**（遮蔽は解決器任せ。軒裏の割付線と同型。高い側の天井面の高さで遮蔽される）、CL の隠しは後処理の `hiddenAtDetail` 印（`plan-section.md`）。純関数は `ceiling/ceilingStepDetailLines.js` に置き、`plan/`・`ceiling/` は `detail/`・`finish/partDetail.js` を直接引かない（`ceiling/importGraph.test.js`・`plan/importGraph.test.js` で固定）。
- 適用: 詳細 LOD だけ（他の LOD は CL の線のまま）。対象は平らな面どうしの段差で、両側が同じ家族の部屋かつ辺の上に全高の壁が無い区間（腰壁だけは可）。壁は辺の両端を半壁厚ぶん残すので、壁に `SPAN_OVERLAP_EPS` 以下で接する片は壁で隔てられた辺として落とす（落とさないと全壁の辺の両端に帯と CL の隠しが出る）。
- 角: 出隅は、端の先の対角の点（低い側へ ε・端の先へ ε）が高い面の内側のときだけ出幅ぶん延ばして四角に回す。入隅は短く止め、壁で止まる端は木口の短い線。「端の先が低い面の内側でない」だけの条件では、低い面の角の片側が壁で高い面だけが先へ続く L 字の角で、線が壁の面を越えてはみ出す。
- 最小描画幅: 紙上 0.5 mm を分母 60（`LOD_DETAIL_DENOM`）固定で換算した 30 mm 未満の出は 30 へ引き上げて併合する（分母を固定するのでキャッシュ鍵が拡大縮小で割れない）。
- 通知しない: 参照切れ・fit 失敗は天伏では通知しない。仕上げ・展開の init が同じ組を通知する。
- キャッシュ鍵: 割当てがあるときだけ、`部分詳細図の overlay の世代`と`材マスタの有無`が鍵に入る（無ければ鍵は従来どおり）。材マスタは天伏モードだけ `CeilingModeState.materialMap` から渡る（見下げは null＝不変）。
- 既知の限界: 傾斜・円弧・ドームとの境・家族でない部屋・部屋をまたぐ段差は CL のまま／材マスタのロード前は CL のまま（ロード後に鍵が変わって反映）／overlay の世代が observable でないので、天伏モード中に保守パネルで図を保存しても再描画されず、モードに入り直すまで反映されない／段差高の間にある下がり梁などが線を隠しうる／高い側の面が出より狭いと線は削られ消える／`narrowOpeningByWalls` で延ばした面には線が延びず手前で止まりうる／鍵が overlay の世代ごとに増える（受容）／天伏からの割当て直後に通知は出ない。
- 目視用の文書: `makeJunctionDetailTestDoc.mjs` が `junction-detail-test.stq` を作る（洋室・小上がり・L 字の 3 箇所。L 字は低い側の角の片側だけが壁の構成）。

## 照合と重複禁止
- 図の参照は書換え先が無い種別（rewrite が null）なので alias を作らない。規則と dedupe の同値不変条件は `catalog-model.md`「読込み時の照合と未解決」「三層の重ね合わせ」を参照。

## ヘルパーはモードでない・undo に積まない
- グラフ・階・モード境界を持たず、APP_MODES の追加コストに見合わない。カタログ保守と同じ全画面パネル＋動的 import＋`runBusy`。別タブはセッションロックで開けない。
- プレビューは origin の基準（s・t）を破線の基準線＋役割名で出す（`datumGuidePrimitives`。下書きは offset の位置、試し込み後は origin の Anchor が載る頂点から Anchor.offsetMm を引いた位置＝基準の位置。`fittedDatums`）。段差系の STEP_EDGE の s=0 は平面・天伏に引かれる段差の線（区画境界）の位置（天伏の詳細 LOD では部位図の出の線が加わり、面一なら CL の線は隠れる）。基準線は寸法編集・頂点番号の対象外（`guide:true`）。
- 下書きの 1 手戻しはパネル内に持つ。グラフを変えないので `undoManager` に積まない。保存・削除は既存のカタログ編集の共通経路（`applyCatalogEditPlan`）。

## モジュール境界
- `detail/` は葉（graph・カタログ・store を読まない）。`openings/` と `elevation/`（`elevationJunction.js` だけ）が引けるのは `detailPlacement.js` だけ、`catalog/` が静的に引けるのは `detailModel.js` だけ（それ自身が constants だけを引く。本体の一覧 `detailBuiltins.js` は `loadBuiltin` の動的 import）。`ui/detailHelperForm.js` は純（node:test から単体 import 可）。`detail/`（`detail/importGraph.test.js`）・`catalog/`（`catalogImports.test.js`）・`ui/detailHelperForm.js`（`detailHelperImportGraph.test.js`）、`openings/` は `openings/importGraph.test.js` で固定。

## DXF 読込み（S7a。`detail/dxf/`・純）
- 意図: メーカー配布の ASCII DXF から輪郭を拾い、ペン命令列（ストローク）の新規下書きへ写す。**原本のバイト列は保持しない**（`sha256` だけ出所に残す）ので再解析・再生成の保証は要らず、9 段パイプライン・レイヤ辞書・LOD 事前生成は採らない。出所は `provenance={source:'dxf', fileName, sha256, maker, series, licenseNote}`（ライセンス未記入は警告 LICENSE_UNKNOWN で、保存は止めない）。
- 流れ: decode（UTF-8／Shift_JIS の置換文字が少ない方・バイナリは拒否）→ tokenize → parse（INSERT は深さ・循環で打ち切り、スケール・回転・ミラーを座標へ焼き込む。円・円弧・bulge は全部「楕円弧 c+u·cosθ+v·sinθ」で持つので非一様スケールも同じ式）→ entities（単位換算・弦分割・y 反転）→ `dxfToStrokes`（端点スナップ→連結成分→一筆書き→共線の間引き）。入口は `dxfImport.js`（例外は握って `{ok:false, error}`）。値は `core/constants.js`（`DXF_*`）、文言は `error.js`。
- 成分の順序は最初の線分の現れ順。分岐する成分は複数の一筆書き（ストローク）になり CONTOUR_OPEN（＝閉じた輪郭 1 周ではない）。自己交差は間引き前の節点で見る。`'V'` の dx/dy は正の大きさ、向きは ss（s 軸）／st（t 軸＝下向き正）。円は角度 0（+x）から始め、最後の点は最初の点と同座標。
- 画面: DXF／PDF 共通の左ペインのタブ「図面読込み（DXF／PDF）」（下記 PDF 節の画面の行）。連結成分を一覧（頂点数・閉／開・警告）から選び（図形のヒット判定なし）、「下書きへ写す」で選んだ成分をまとめて新規下書き 1 つへ（成分ごとに 1 本以上のストローク。未保存の下書きは破棄の確認を通す。分類・基準・stretch は後から指定。全 LenSpec は fixed）。成分どうしの位置関係は `Anchor.offsetMm` で保つ（下記「位置関係を保って写す」）。単位が不明なら係数を指定し直せる。
- 矩形による絞り（DXF・PDF の抽出結果で共通）: プレビュー上の矩形（**長押し後のドラッグ**。素のドラッグはパン。下記「プレビューのズーム・パン」）は**選択の補助**。bbox が矩形に完全に収まる成分（CAD の窓選択・境界含む）で選択を置き換え、一覧もその成分に絞る（件数表示と「矩形を解除」。解除しても選択は残る）。交差で採らないのは図枠や長い線が毎回入るため、成分の分割を変えないのは PDF の「範囲」のような切り取りだと断面の輪郭が開くため（PDF の範囲は抽出前の選別でページ上の矩形に交差で採る＝別の意味）。矩形は引いたときの scene に結び付き、単位変更・PDF の再抽出で自動的に無効になる。タップ（全モード共通の `TAP_MOVE_PX` 未満）は何もしない。ドラッグ中はプレビュー本体を描き直さず（層の中の状態だけ更新）、px↔mm の変換は描画と同じものを `AutoScaledFigure` から受け取る（変換を作り直さない＝不変条件）。ズーム中は矩形に寄せられる（［矩形に寄せる］）。純関数は `ui/detailHelperPick.js`（`detailHelperForm.js` からは引かない＝循環回避）。
- 矩形絞りの限界・先送り: 交差選択・追加選択（Shift）・投げ縄・回転矩形・クリック選択・矩形の数値入力／寸法の引出線が輪郭に接していると同じ成分になり bbox が広がる（大きく囲んで一覧で外す）／ハッチは 1 本ずつ別成分／縮尺 1/500 で頭打ち／単位変更・再抽出で矩形は消え、古い scene の参照は矩形が残る間だけ保持／層の外へドラッグすると枠が図の外へ伸びる／読込み中（busy）の判定は押下時だけ。
- レイヤ: group code 8 を保持し、図面読込みタブでレイヤごとに on/off できる。絞りは線分の段階で行い成分を作り直す（レイヤをまたぐ成分を半端に切らない。切り替えるたびに scene が作り直されるので成分の選択は解除され矩形は無効になる）。ブロック内のレイヤ '0' は INSERT のレイヤを継ぐ。off は scene に結び付き、再読込み・単位変更で全部 on に戻る。レイヤが 1 つ以下なら一覧を出さない。PDF にレイヤは無い。
- レイヤの限界: 名前の大文字小文字は区別する／TEXT など線分にならない要素だけのレイヤは一覧に出ない。
- 目視用: `D:/tatsuya/Download/2D_DXF/姿図・断面図/JJHTH03Z.dxf`（成分 1,600 超。窓の 1 断面を矩形で囲んで絞る）。

### プレビューのズーム・パン（S7d-1/2。図面読込みタブとペン入力タブ共通）
- 意図: 1,600 成分の DXF から窓の 1 断面を選ぶにも、写した下書き（mm 単位の細かい部材が多数）を直すにも、全体表示では指せない（R4）。
- 純関数は `structural/sectionFigure/figureView.js`（import は `sectionGeometry.js` だけ）。view＝`{scale,cx,cy}`、null＝全体。**連続ズーム＋パン＋［全体］［矩形に寄せる］**（R1。縮尺の段に吸着させるとピンチが跳ねる）。上限 20/1（R2。`viewport.js` の `zoomAt` と同値。サッシの 1.2 mm 材が 24 px）、ホイール倍率 1.1（`usePointerInteraction.js` と同値）。＋−ボタンは置かない（R5）。
- 操作は**全モード共通の体系**（R3）: 素のドラッグ＝パン、長押し（500 ms・8 px。`useLongPress`）後のドラッグ＝矩形、2 本指＝ピンチ、ホイール。修飾キー・ツール切替は iPad で使えないため採らない。入口は `DetailHelperPanel.jsx` の `FigureGestureLayer`（`AutoScaledFigure` の `overlay(t, {autoScale, contentBounds})` に差す）。
- 不変条件: ドラッグ中は svg の CSS transform だけを動かし、確定は離したとき 1 回（重い SVG を描き直さない）。押下中に来たホイールは全部捨てる（押下時の変換が古くなり離したとき図が跳ぶ）。ホイールは non-passive のネイティブリスナー＋rAF。全体から最初のズームは `viewOfTransform(t, frame)` に **`AutoScaledFigure` の枠そのもの**を渡す（本番と違う枠だと最初のズームで図が跳ぶ）。
- view は鍵に結び付く（`bindView`／`activeView`）: 図読込みは `viewEpoch`（`loadDxf`・`setDxfUnit` で新しく、レイヤ切替は引き継ぐ。sha256 は空になりうるので鍵にしない）、ペン入力は下書きの key。鍵が変わる・縮尺が全体以下なら全体へ戻り、範囲外は寄せる（`reconcileView`）。
- 既知の限界: パン・ピンチ中は窓の外だった部分が離すまで空白・寸法ラベルは離すまで追従しない／1 以上の縮尺は整数表示／ホイールで図の外の余白を中心にすると寄せが入る／ピンチ仮表示の倍率は確定と同じ範囲に収める（超えると離した瞬間に跳ぶため）。

### プレビューの描画域と寸法線（P1〜P3・P5。2026-11-04）
- 意図: 描画域は 3 ペインの中央ペイン全域、図の範囲の中心が枠の中央（旧: 固定 560×480 の左上寄せで、1,600 成分の DXF や細かい下書きが小さかった）。寸法線は材から離して足を付け、縦の寸法値は縦書きにする。
- **描画域（P1）**: `AutoScaledFigure` の任意 prop `fill`（`view`／配置検討が無いときだけ効く。`fillBounds`＝`viewBounds` を図の中心で）。「全体」は view null のまま（R1。zoom の規約を変えない）・縮尺は `NICE_SCALES` の段のまま＝枠が広がれば段が上がる。枠は中央ペイン（`.dthlp-preview` が残りを全部取る）の内寸を `ResizeObserver` で測り（`previewFrameOf`。測定前・0・余白以下・非有限は既定 `PREVIEW_FRAME_PX` 560×480）、観測の前に layout effect で 1 回同期に測って初回の跳ねを防ぐ。枠が変わっても view は維持し、全体以下は `reconcileView` で全体へ（R2）。fill を渡さない他の利用者（姿図・構造断面・腰壁図・階段・カタログ）は不変。ホイール・ピンチ・ドラッグの基準も同じ枠（`FigureGestureLayer` の `frame`）。
- **寸法線（P2）**: 材から離し、材側に `foot` を付ける。**寸法線はそのストロークの点列の bbox 中心から遠い側（外側）に置く**（R5。従来は常に +s／+t 側で、閉じた矩形の上辺・左辺の寸法線が図の内側に落ち、足を付けると材を横切った。同値は + 側）。基準線（`datumGuidePrimitives`）も同じ gap で延びる。
- **寸法の配置（P5）**: gap を 80 mm 固定にすると画面上の離れ（gap×縮尺）が図の大きさで変わり、大きい図（1,700 mm→1/5）では約 16 px しか離れず値（約 35 px）が重なった。R6 gap＝max(`PREVIEW_DIM_GAP_MM` 80, `PREVIEW_DIM_GAP_RATIO` 0.2×図全体の bbox の長辺)（`previewDimGap`。枠 560 px で寸法線が約 60 px 離れる比。図はそのぶん小さくなる。不正値は既定へ戻し例外にしない。試し込み後の基準線＝`fittedPrimitives` も同じ）。R7 寸法線は**ストロークごと×側**の行にまとめ、行 k の位置＝そのストロークの bbox の辺 ± (gap + k·gap/2)。区間が重なる（端点一致含む）か値の中心間が gap 未満なら次の行（`assignDimRows`。始点で安定ソート・衝突しない最小の k）。行の基準を図全体の辺にしないのは、複数ストロークで足が別のストロークを貫くため。R8 足は材側を gap/2 空けて寸法線まで（`footLen`＝|at−foot|−gap/2 を寸法ごとに渡す。`renderDim` の既定 1/3 比率は他図面のため不変）。R9 同じストローク・同じ側で from・to・label が同じ寸法は 1 本に畳む（櫛形で行が増え続けるのを防ぐ。最初の手の editKey が代表で、値を直すと代表の手だけが変わり、変わった手は別の寸法として現れる。行数の上限は設けない）。座標が非有限の手は寸法を出さない。新しい数値リテラルは 0.2 のみ（gap/2 の 2 は構造値）。
- **縦の寸法値（P3）**: 縦寸法は `labelVertical`＋`labelSide:'left'`。値は寸法線がどちら側でも**常に線の左**で `rotate(-90deg)`（天が左＝下から上へ読む。R4。横の値が常に線の上なのを縦へ写した規則）。編集可（`EditableDimLabel`）と読取り専用（静的 `renderDim`）で位置を揃える（線から 6+8 左）。NumPad は回さない。
- 既知の限界: 1/500 でも収まらない極大図は両端が切れる（ズームで届く）／片軸だけ余白以下でも両軸とも既定の枠へ戻る／ドラッグ中に枠が変わると押下時の枠と不一致／凹んだ形（切欠きの内側の辺）は外側判定でも足が材を横切りうる／短い縦寸法（値 4 桁で約 35 px 未満）は値が足に重なる／回転後の半幅は半高の近似で右端が線から数 px ずれる／配置検討モードの位置計算は回転を考えない（`labelVertical` と `layoutId` を両方持つ寸法は無い）。P5: ストローク間で寸法値が重なりうる（行はストロークごと）／gap は図全体の長辺由来なので、間隔 < gap の近接ストロークや大きな図の中の小さなストロークでは足と寸法線が隣の材を横切る・遠くへ飛ぶ／細かい直交パターン（2×10 の歯 50 本）は横の寸法が畳まれず約 41 行＝図が約 1/8 に縮む（45° ハッチは VECTOR なので寸法を出さない）／基準線は行 0 の寸法線までしか届かない／画面上の gap は `NICE_SCALES` の 1 段ぶん揺れる。

### 位置関係を保って写す（S7d-3/4）
- 背景: origin は軸ごとに 1 つなので、複数成分を写すと各ストロークの頂点 0 が原点に重なり位置関係が失われていた。`Anchor.offsetMm`（「図の表現」）で解く。
- 写し方（`draftFromDxf`）: 既定の基準点 P＝選んだ成分の bbox 合併の**左下**（R8。姿図の t の origin は SILL・取り合いは FL でどちらも下の線）。各ストロークの origin の Anchor に `offsetMm = start − P`（0 でも書く）。`start` は `dxfToStrokes` が各ストロークの頂点 0 の位置として付ける（保存データには入らない）。戻り値の `basePoint` が P。
- `setAnchor` は、古い Anchor が**有限の `offsetMm` を持つときだけ**頂点の付け替えで位置を保つ（R10。持たない手描きの図の「頂点を基準に載せる」意味を変えない）。歩けない（長さ未解決・頂点なし）ときは引き継ぐ。
- ［基準点を指す］（R9。ペン入力タブ。写した後に指す＝手描きの図にも効き、基準線の動きがその場で見える。数値欄は置かない＝R13。位置は図から決まる値で人が打つ値ではない）: トグル。試し込み中・読み取り専用・busy・図なしでは使えず、モードは下書きの key に結び付く（別の下書き・試し込みで解ける）。タップ（`isTapDistance`）で `DETAIL_BASE_SNAP_PX`（20 px。`snap.js` と同値）÷縮尺の半径内にある最も近い頂点（プレビューの guide でない polyline の頂点）を P として `rebaseOrigin` を `edit` 経由で実行（1 手戻しに乗る）。範囲外は文言を出してモード維持。
- **`rebaseOrigin` は origin と end の両方の Anchor に同じ Δ を足す**（R11。Δ＝軸ごとの origin の Datum の offset−P）。origin だけだと end との差＝伸縮長が変わる。Datum の offset がすべて等しい図（DXF の下書き）では字義どおりの結果と同じ。`offsetMm` を持たない Anchor にもキーが付く（rebase を明示した結果）。変化が無ければ同じ form を返す。view の中心も Δ だけ動かし指した点が画面に留まる（view は undo の外）。
- ［90° 回転］（H3。ペン入力タブ・［基準点を指す］の隣。`rotateDraft90`）: 下書きを**基準点（原点の基準の offset）まわりに画面で時計回り 90°**。動機＝メーカー配布の平面図は正面が右を向き、アプリの約束（平面の姿図は正面を図の下へ向ける）と 90° ずれるが、ヘルパーに回す手段が無かった。回すのは手の向きと、頂点を載せる原点の基準の付け替え（s↔t）だけで、**基準（Datum）は動かさない**（プレビューも fit も「軸ごとに、その軸の原点の Anchor の頂点を 基準＋offset に合わせる」ので、これで全頂点が回る）。回せる図＝end の基準が無く・原点が軸ごとにちょうど 1 つの別々の基準で・ストロークが 1 本以上あり・手の向きが既知（斜めの符号は省略か ±1。壊れた図を通る図に変えない）。回せない図は無効にするだけで理由の文は出さない（ユーザー裁定）。可否は［基準点を指す］と同じ条件に「回せる図」を足したもの。`edit` 経由で 1 手戻しに乗り、view の中心も同じ回転で動かす（`rotateDraftView90`。view は undo の外）。鏡像は足さない（左右の取り違えは図の束の表示名の側で解く）。
- 写した直後は拡大した場所のまま下書きを開く（R12。`draftViewOfImport`＝図読込みの view から P を引く）。
- 図面の原点で写す（H1。DXF だけのチェック欄「図面の原点を基準点にする」・既定 off・パネルを開いている間だけ保つ）: メーカー配布の複数の図（平面・正面・側面）は同じ原点で描かれ、その点に頂点が無いと［基準点を指す］では揃えられない。写した下書きは図面の原点を覚えていないので、写すときに選ぶ（`atDrawingOrigin === true` で P＝scene の (0,0)＝`s = x·係数・t = −y·係数` に平行移動が無いため単位・レイヤ・矩形に依らない）。PDF は scene の原点がページ左上×縮尺で製品の基準にならないので欄を出さず、状態に真が来ても無視する。限界: 原点が成分から遠い図面は、基準線が原点に立つため全体表示が広がり図が小さく見える（警告は出さない）。
- 限界: 基準点の候補はプレビューの guide でない polyline の頂点だけ／origin の Anchor を持たないストロークは rebase で動かない／基準を削除→追加し直す・`setAnchor(null)`→再指定で `offsetMm` が消え頂点 0 が基準に集まる（付け替えは［基準点を指す］か role の select で）／`setAnchor` はプレビュー値で歩くので param・material の手を跨ぐと fit でずれる（DXF 由来は全部 fixed＝実害なし）／古いビルドで開くと、`offsetMm` を持つ図（DXF・PDF 由来の図・基準点を指し直した手描きの図）は `offsetMm` が無視されストロークが原点に重なる（受容）。
- 同梱の扱い（DXF・PDF 由来も手描きと同じ。R10 の訂正）: 使用中なら推移展開・保存時の回収（views の先を含む）・ライブラリから消すときの文書への書き写しのすべてで同梱の対象にする。除外の経路は持たない（経路ごとに除外を足すと、展開側だけ直して回収側が外れる型の不整合になる）。ヘルパー・保守パネルは出所（ファイル名・メーカー等）を表示するだけで、保存先の違いは告げない。同梱にも無くライブラリにも無い図（以前の保存・ライブラリから削除された図）の未解決行は文言（`ERR_DETAIL_FIGURE_NOT_FOUND`）で伝える。
- 次数 3 以上の節点（T 字・十字）は間引きで消さない。自己交差は間引き前の節点で判定し、上限（`DXF_SELFINT_*`）を超えたら省いて SELF_INTERSECT_UNCHECKED。digest（sha256）が失敗しても読込みは続け、sha256 は空・警告 NO_DIGEST。
- 先送り: SPLINE／ELLIPSE・押し出し方向（210/220/230）・INSERT の配列・ペーパー空間・RDP 等の間引き（トポロジー保存版が要る）・キャンバスでのクリック選択。

## PDF 読込み（S7b。`detail/pdf/`・純。pdfjs は `ui/pdfLoader.js` だけ）
- 意図: メーカーのカタログ PDF（納まり参考図）から、ページ→範囲を選んで線（パス）を拾い、DXF と同じ連結成分の選択→新規下書きへ写す。**原本は保持しない**（`sha256`・ページ・範囲・縮尺だけ出所へ）。出所は `provenance={source:'pdf', fileName, sha256, page, clip:{x,y,w,h}（ページ座標 pt）, scaleDenominator, maker, series, licenseNote}`。原本は保存しないが、選定した図は使用中なら同梱する（R10 の訂正。DXF と同じ）。
- 境界: pdfjs-dist（固定版 6.4.299）は `ui/pdfLoader.js` だけが静的 import し、`DetailHelperPanel` が初回の PDF を開くときだけ `import()`（独立チャンク約 485 kB＋worker 約 1.32 MB。legacy 版〔古い iOS Safari 対応〕。worker は `?url` で同梱）。純モジュール（`pdfOps`・`pdfClip`・`pdfUnits`・`pdfProvenance`・`pdfImport`）は「ページの演算子列（fnArray／argsArray）と pdfjs の OPS の名前→番号表」を入力に取るので node:test で合成の演算子列を渡せる。import は `detail/importGraph.test.js`（pdfjs 禁止）と `ui/detailHelperImportGraph.test.js` で固定。
- 流れ: constructPath だけを読み（経路は pdfjs 6.4 の符号つき平らな数列 `PdfDrawOp`。CTM は transform・save／restore・paintFormXObject で追う）→ 範囲に線分が 1 本でも掛かる経路を**丸ごと**採る（切り取らない）→ pt × 25.4/72 × 縮尺分母 N で mm → **`dxfToComponents`（S7a と共用）**。入口は `pdfImport.js`（例外は握って `{ok:false, error}`）。
- 塗り・開閉: stroke／fill は区別せず輪郭。塗り系は開いた部分経路を始点へ閉じ、stroke だけなら閉じない。**塗りだけで色が白の経路はページ背景・白抜きとして捨てる**（塗り色は setFillRGBColor だけ追う＝他の色空間は捨てない。サンプル PDF〔70 ページ〕では 1 ページ目の全面の塗りは灰で残り、白塗りで捨てられるのは p2〜p70 の端のインデックスタブ。「p.118」は印刷ページ番号で PDF の 3 ページ目）。
- 文字・画像は読まず件数を警告。上限は `PDF_MAX_PAGES`・`PDF_MAX_BYTES`（読み込まない。SIZE_LIMIT）・`PDF_MAX_PATH_OPS`・線分数 `DXF_MAX_SEGMENTS`（超えたら PATH_LIMIT）。縮尺は必須で既定なし（未入力は抽出も写しも無効）。ページ・範囲・縮尺を変えると抽出結果と選択は捨てる。
- 破棄は `loadingTask.destroy()`（`PDFDocumentProxy` に destroy は無い）。`ui/pdfLoader.js` の `closePdf` が担い、0 ページ・読込み直し・パネル閉じで呼ぶ。版を上げたら `detail/pdf/pdfjsPin.test.js` が落ちる。
- 画面: 左ペインのタブは「図面読込み（DXF／PDF）」（隠し input は accept なし。内容の先頭 1024 バイトに `%PDF-` があれば PDF、なければ DXF）。ページ番号（NumPad・前後）→ ページ画像（canvas。表示専用・回転 0 固定）の上で矩形を 1 回ドラッグ（`pointToPage`／`clipFromDrag`。図形のヒット判定はなし）＝数値欄（x・y・幅・高さ。ページ左上が原点）と同期 → 縮尺（NumPad）→「抽出」→ 連結成分の一覧（DXF と同じ）→ 出所欄 →「下書きへ写す」。抽出結果のプレビューでの成分の矩形絞りは DXF と共通（上記）。読込み・抽出は `runBusy('図面読込み')` の中。pdfjs の文書は React の状態でなく ref。判断は `ui/detailHelperPdf.js`（純）。
- 先送り・既知の限界: 灰などの全面の塗り（白以外）は地として捨てず残るので、どの範囲にも掛かる（成分の選択で外す）／既知寸法による縮尺の補正（縮尺は印字の 1/N を手入力）／文字・画像の読取り／回転ページ（`/Rotate` は無視し、ユーザー空間のまま向きが横倒しのことがある）／利用者パスワード付きの PDF（開けず LOAD_FAILED。所有者パスワードだけなら開ける）／クリップ（W）・グラデーション・パターンの塗り・破線の線種／文字（寸法値）の位置合わせ／ベクタが画像化された PDF（線がない）／ハッチ・寸法線・引出線も線として入る（成分の選択で外す。p.3（印刷 p.118）で約 2 万・最大ページで約 6 万線分〔弦公差 0.1pt〕・数千成分になる＝一覧は長い）／paintFormXObject 以外の入れ子（Type3 フォント内のパス）。

## 既知の限界・先送り
- 三方枠以外へ種別を変えても `opening.detailRefs` は残す（`frameFaceWidth` と同じ規約。UI からは見えず、使用中として同梱され続ける。リード裁定）。
- 同梱の図が propose・pick（部分一致）になり、その図を指す同梱の記号が先にライブラリへ写されると、承認後もライブラリ側の記号は旧キーを指したまま（読み替えは同梱の記号だけ＝「ライブラリ層は触らない」規約の帰結。その記号を使う別文書では not-found 行になる）。
- 線種（dash／weightRole）は無視（平面は枠の太さ・展開は断面の太線）／斜め寸法線なし／寸法は 1 手単位（複数手にまたがる寸法は表せない）／mm 判定の closed は param・material・stretch で閉じ辺 0 になるケースを登録時に検出しない／同じ図を参照する別記号の失敗は 1 行にまとまる／使用中の印は開いたとき 1 回。
- 姿図の差替えの限界（S6b）: 線種は weightRole（極太は切断線へ寄せる。**建具の姿図だけ**。配置した姿図は「姿図の配置」の細線）と dash だけ読み（SWING の扱いは「姿図の内外（T2）」）、破線は線分ごとの line・実線は polyline（Konva は polyline の dash を描かず、閉じた polyline を塗るため閉じ辺は始点を足した開いた折れ線にする）。レバーハンドルの取付高さの寸法（編集用）は図を置換しても残る。FL を origin にした図は窓台の分だけ伸縮する（SILL と別の挙動）。建具モード init の通知は kind が fixtureSymbol の行に載る（主語は建具種別キーで、区分 fitting/window は付かない）。ヘルパーの試し込みは分類が姿図なら幅・高さ・窓台（既定は代表の建具種別 singleSwing の既定幅・高さと窓台 0）、既定の基準は t の origin＝SILL・end＝HEAD。
- 姿図の配置（S10）の限界・先送りは「姿図の配置（S10）」の節の末尾。
- 分類 `electrical`（電気設備）を足したので、これ以前のビルドは電気の図を語彙外として読めない（別の端末の古いビルドで開くと対応外の図になる）。
- 先送り: 8b-2b 袖壁の分割端（手動壁の実装後に再開。現行の壁生成は全部 isRoomWall なので `perpendicularWallsOnFace('near')` が拾う袖壁が生まれず、実機で現れる場面が無い。再開時の要点: 置き場は断面エンジンへの注入点（8b-1 の `kneeDropPartStepsOf` と同型の輪郭版）・記録の探索点は切断線の軸値・切断壁の天端 CUT／天端下細線／側縁の上部を輪郭に置き換える・帯の端（8b-2）とは描く場所が重ならない）・屋根の軒先けらば（S9）・図を部品に組み合わせる作図・整理課題＝`dxfToStrokes`／`dxfToComponents`（PDF も共用）と `describeDxfWarning`・`DxfWarning.LICENSE_UNKNOWN`／`NO_DIGEST`・`DXF_PROVENANCE_FIELDS`・`draftFromDxf` の名前の一般化・`useCatalogEditActions` の共有化・`rewriteDocSymbolDetailFigures` の改名（建具種別も読み替えるため。整理課題）。

## 暗黙の既定（S8c）
- 巾木と腰壁の天板は他の部分詳細と同じ定義・ロジックで描く（ユーザー裁定 2026-11-02「現在の展開と同じ結果」）。解決規則は 1 箇所ずつ: floorWall＝`finish/roomDetailJunction.js resolveRoomDetailFigure`（割当て無しでも部屋に巾木高さ `h=<mm>` があれば組込み巾木・無ければ null＝描かない）／kneeTop＝`finish/partDetail.js resolveKneeDropDetailFigure`（腰壁があれば組込み天板。dropBottom に既定は無い）。結果の `source`＝`explicit`／`default`（`DetailFigureSource`）。
- **通知は explicit だけ**: 既定の fit 失敗は従来の線へ黙って戻る（線が出るので利用者は困らない）。参照切れ・fit 失敗の通知（`collect*Failures`）は default を飛ばす。
- **従来経路はフォールバックに降格**: `appendBaseboard` は junction の floorWall が fit できなかった面だけ、`kneeCapUnderline` は kneeTop が解決しない帯だけ（`appendKneeDropPartLines` が解決＝true を返す。fit が成れば段差 0 本でも図が担う）。明示の割当てでも同じ（8b-1 の「両方引く」は廃止）。`kneeCapUnderline` は切断壁の天端（`cutWallTopEdges`。壁の断面が帯のとき）には派生線の経路が無いので従来のまま。腰壁の端面（`appendKneeCapEndFaces`）は部位図の派生線ではないので従来どおり。
- 巾木高さは `DetailParam.BASEBOARD_HEIGHT`（`junctionTargets` の `baseboardHeightMm`。呼び出し側が部屋の h を渡し、無ければ param 未解決）。メモの鍵に高さが入る。ヘルパーの試し込みは、図が巾木高さ param を使うときだけ欄（既定 60＝`DEFAULT_BASEBOARD_HEIGHT`）が出る。
- 既知の差（従来の展開との）: (1) 巾木の派生線は最小描画幅を通る＝h<50 の巾木は分母 100 で 50 に、分母 >120 では 60 が引き上がる（従来の線は調整しなかった）。(2) 巾木の途切れは junction の述語（窓台より巾木が高ければ窓の幅で切れる。従来は床まで達する建具だけ）。(3) 天端下の細線は最小描画幅だけで決まり、実画面の 1px 保証（`kneeCapFaceMm` の scale 依存）は派生線に掛からない。実データ（golden 22 枚）は `source` を除いて全一致（`elevGoldenGate.mjs --ignore-source`）。
- 一般解（派生線の途切れ・2026-11-03 裁定）: 巾木・廻り縁の派生線を切ってよい理由は「面の壁体が無い区間（wallLessRuns）」と「線の高さを含む建具の開口」の 2 つだけ。腰壁・垂れ壁の記録は同じ壁体の上下端の修飾で壁体の有無を変えない（従来の巾木と同じ）。8a の「腰壁・垂れ壁が覆わない区間を除く」は撤回。開放部の描き方は断面エンジンの担当。

## 片開き戸の方立・上枠の暗黙の既定（S8e-1/2）
- 片開き戸（subType `SWING_LEAF_SUBTYPE`）の平面・詳細 LOD の方立を、割当て無しなら組込み `df-builtin-door-jamb-30` で描く（従来の `swingFramePrimitives` と同じ出力＝フォールバックに降格。参照切れ・fit 失敗・対象外は従来の描き）。解決は三方枠と同じ `resolveDetailFigure` の後に既定を足す `resolveSwingDoorFrame`。同梱は片開き戸があれば方立と上枠（`df-builtin-door-head-30`。展開の断面の上枠。S8e-2）の 2 件（`implicitDetailFigureKeys`。subType の文字列は catalog/ が openings/ を引けないので constants に置く）。
- 図は 1 つで、t は「扉が閉じる側（開く側の面）が正」。開き勝手は取り付け側の t 反転（`placeDetailSides` の `tSign`）で表す。既定が使えるのは従来と同じ前提（R4）のときだけ＝見付が全幅 30（開口幅 60 以上）・見込帯が壁の面±出幅（半外付けでない）。明示の割当ては R4 を見ず壁の面へ fit する。組込みと同じキーの上書き（ライブラリ・同梱。S8d）は既定と同じ扱い＝R4 と丸め寄せの対象（上書きの形で描かれるのは R4 を満たす建具だけ。受容）。
- 図の共線の頂点（t の基準を置くための 2 点）は `withoutCollinearPoints` で除く（従来の六角形と同じ点列にする。三方枠は対象外）。fit・配置の浮動小数の丸め（壁厚 137.7 で 1ULP ずれる実例あり）は、既定の図だけ従来の式の値（面±出幅・面−扉厚）へ寄せる（`DETAIL_FIT_EPS_MM` 以内）。
- select（S8e-3）: 建具エディタは singleSwing にも方立・上枠を出す（R16 は三方枠だけ＝R5）。保守パネルの建具記号タブは方立・上枠の割当て欄を**全記号**に出す（R6。記号は機構を持たず、割当ては三方枠・片開き戸と窓で使い他は無視。窓は方立・上枠・下枠（S8f-1〜3c）で、下枠の欄も全記号に出る。枠断面 `profile` だけ三方枠専用のまま）。記号の `detailFigures` は mechanism によらず保存・検証・同梱される。
- 建具エディタで片開き戸が組込みの既定キー（記号に割当て無しのとき）を選ぶと上書きとして持たず「記号の設定を使う」へ畳む（S8d の「同キーの上書き＝既定扱い」と揃える。`detailRefsAfterSelect`）。
- 限界: 保守パネルの作図プレビューは標準 LOD なので、三方枠でない記号は方立・上枠を割り当てても見た目が変わらない（片開き戸の方立は詳細 LOD のみ）／扉上端・縦線始点は定数のまま／方立と上枠は別々に上書き／一般 LOD・姿図は対象外。

### 上枠の配線・R9・通知（S8e-2）
- 展開の断面（`openingSection.js` の swingLeaf）の上枠だけを図で描く。`resolveSwingDoorFrame` を slot=HEAD で呼ぶ（座標＝coord1 上端・coord2 開口下端・壁の面＝帯の端から出幅ずつ内側・見付 30 固定・tSign＝開く側が帯の奥（atFar）なら +1）。扉の四角と扉のない側の縦線は定数のまま。方立の R4 に当たる除外は無い（断面の帯は常に壁の面±出幅・見付は常に 30）。
- 出力: 4 点の軸平行な閉じた輪郭は従来と同じ型の `rect`（既定の組込み上枠は従来の矩形と同値）、それ以外は閉じた polyline（CUT）。どちらも `source: DETAIL_PRIM_SOURCE`（R3。golden は `--ignore-source` で一致）。割当てが引けない・fit できないときは従来の矩形（source なし）。
- **R9（探索順）**: `resolveDetailFigure` のまま（建具個別の head ＞ 記号の head ＞ 建具個別の jamb ＞ 記号の jamb）で、どれも無いときだけ組込みの上枠。明示の方立の図は上枠にも流用される（同じ戸当たりの断面なので物理的に正しい）が、既定の上枠は従来の矩形のまま（R2。方立の既定を流用すると欠き込みが出る）。
- 丸め寄せ（`snapNear`）の寄せ先は方立の組 1 つで上枠も足りる（上枠の寄せ先＝帯の両端と壁の面は方立の組に含まれる。slot 別に分けても同値は崩れず検出力が無かったので畳んだ）。
- **通知**（`collectDetailFitFailures`）: 片開き戸（`isSwingLeafSection`）も対象。**明示の割当てだけ**（既定は `resolveDetailFigure` が null を返すので構造上来ない）。壁厚は平面と断面で別の値を使うので slot ごとに試す: 方立＝ホスト壁の両仕上げ面の間（`wallFaceRange`）・見付は開口幅の半分で頭打ち、上枠＝展開の帯の経路が 2 つあり壁厚が違う（隅の断面＝同じ通りの実壁の材の範囲の合併 `wallMaterialRangeForOpening`、切断壁の帯＝当該部屋側の壁 1 枚の `materialRange`。片開き戸は `openingWallRange` を持たない）ので**両方の壁厚を試す**（`wallMaterialRangesOf`。重複は除く）・見付 30。どれかに合わなければ上枠の行は 1 件。片方にだけ合わない図は合わない slot の行だけ出る。文言・slot の名前は三方枠と同じ（新しい列挙値なし）。

## 窓の方立の暗黙の既定（S8f-1）
- 窓（category window）の平面・詳細 LOD の方立を、割当て無しなら組込みの図で描く（従来の描き＝見付 25 と同じ出力。フォールバックに降格）。平面の方立は 3 経路あり、経路ごとに図を持つ（R1 窓専用キー。戸の図は共用しない）: 開き系の欠き込み `df-builtin-window-jamb-notched-25`・記号が枠矩形を描く機構のコの字（開いた 1 ストローク）`-jamb-open-25`・それ以外の閉じた矩形 `-jamb-25`。種別は `detailFrameKindOf(mechanism)`、既定キーは `frameDefaultKey(opening, slot, mechanism)`（片開き戸の slot 別もここに集約）。呼び出しは `windowDetailJambPrimitives` が従来の枠生成の前に `??` で挟む。
- 対象外（R2）: 引き違い窓 SLIDE_DOUBLE（既定も明示も効かない）・建具・一般 LOD・姿図。同梱は窓が 1 つでもあれば 3 図すべて（R5）。
- 既定を使う条件は片開き戸の R4 と同型＝見付が全幅 25（開口幅 50 以上）・見込帯が壁の面±出幅（半外付けでない）。欠き込みはさらに回転中心が開く側の面にあること（吊元 0 などで開く向きが無いときは従来）。明示の割当ては条件を見ず壁の面へ fit し、fit に失敗したら従来の描き（通知は S8f-2 で追加）。組込みと同キーの上書きは既定扱い（上書きの形で描かれるのは条件を満たす窓だけ。受容）。
- 出力の形は従来に合わせる（deepEqual で比べるため）: 矩形は `rect`・コの字は closed を渡さない polyline・欠き込みは閉じた polyline。source は付けない。
- 限界・先送り: 保守パネルの作図プレビューは標準 LOD なので見た目が変わらない／矩形・コの字の経路は t を反転しない（組込みは上下対称。非対称な明示の図を割り当てても向きは図のまま）／記号側の内法矩形は `jambWidthFor` 固定なので見付の違う明示の図とはずれる（戸の扉の inset と同型）。

## 窓の方立の割当ての入口（S8f-2）
- 建具エディタの方立の select は slot の配列 `frameDetailSlotsFor(opening, isFrameOnly, mechanism)` で絞る: 三方枠・片開き戸＝方立と上枠、窓＝方立だけ（上枠・下枠は S8f-3c の節）、引き違い窓などは姿図だけ。判断は `frameDefaultKey` に寄せ、機構の集合を複製しない（jsx にも書かない）。機構の分からない窓（種別の参照切れ）と実装外の機構の窓は描画にも方立が出ないので対象外（`frameDefaultKey` が undefined）。
- 「同キーの選択＝既定扱い」の畳み込みの基準は 記号の割当て ?? `frameDefaultKey(opening, slot, mechanism)`。窓は方立の種別ごとの組込みキーなので、形違いの組込みを選ぶと上書きとして残る。
- 通知（`collectDetailFitFailures`）は窓の明示の方立も対象（片開き戸と同じ関数 `collectFrameFailures`）。壁厚はホスト壁の両仕上げ面の間、見付は `jambWidthFor`（窓 25）で、描画と同じ式を共有する。窓の上枠・下枠の通知は S8f-3c。

## 窓の上枠・下枠の暗黙の既定（S8f-3b）
- 展開の窓の断面（`openingSection.js` の `window`）の上枠・下枠を、割当て無しなら組込みの図（`df-builtin-window-head-25`・`-sill-25`。見付 25 の矩形）で描く。出力は 3a の矩形と同値で、差は図から描いた矩形の `source:'detail'` だけ（片開き戸の上枠と同じ関数 `sectionFramePrimitives`。下枠は coord2 側＝窓台の上端から上へ s が伸びる鏡像を使う）。下枠は slot の分類に subject SILL が要るので上枠と別の図。
- 探索順: 上枠は R9（head ＞ jamb の流用）のまま、下枠は **sill だけ**（R5。下枠は水切り・水返しで形が違うので方立・上枠を黙って流用しない）。引き違い窓（SLIDE_DOUBLE）も上枠・下枠の既定が効く（方立だけ対象外）。
- **掃き出し窓（窓台 0）は下枠を描かず既定キーも無い**（R1。判定は `windowHasSill`＝`openingNumbering.js` が唯一の定義。`openingSection.js` と `frameDefaultKey` の循環 import を避けて置いた）。
- 既定を使うのは見付が全幅 25 のときだけ（高さ 50 未満の窓は見付が頭打ちされ、組込みの固定 25 と食い違うので従来の矩形。平面の方立の R4 と同型）。明示の割当ては fw へ fit する。fit できない・参照切れは従来の矩形（source なし）。同梱は窓が 1 つでもあれば方立 3 ＋上枠・下枠 2 の 5 図。
- 限界・先送り: 障子・竪枠の線は定数のまま／fw≠25 の窓は従来の矩形。
- 下枠の t も開く側の面が正（片開き戸の上枠・窓の上枠と同じ）。開く向きの無い窓は帯の奥が正。水切りのような室内外で非対称な下枠の図は屋外側を保証しない＝先送り（断面に屋外の向きを渡す必要）。

## 窓の上枠・下枠の割当ての入口（S8f-3c）
- 建具エディタの select: 三方枠だけ `[方立, 上枠]`、他は `[方立, 上枠, 下枠]` を `frameDefaultKey(opening, slot, mechanism) !== undefined` で絞る 1 規則（`frameDetailSlotsFor`）。下枠は窓台のある窓だけ（掃き出し窓は描画に下枠が無いので欄・通知とも出さない）、引き違い窓は方立なし。select の絞りは `slot === FIGURE || frameSlots.includes(slot)`（下枠が枠でない建具へ漏れない）。
- 保守パネルの建具記号タブは下枠の欄（`detailSill`）も全記号に出す（R6）。記号 JSON の `detailFigures.sill` は `catalogKinds.js` の validate が平らなオブジェクトかだけを見るので FBS・旧ビルドの読込みとも互換。注記は「三方枠・片開き戸（方立・上枠）・窓（方立・上枠・下枠）で使う」（引き違い窓に方立が無いことは本節だけに書く）。
- 通知（`collectDetailFitFailures`）: 窓は `isWindowSection` で方立・上枠・下枠のうち既定の図を持つ slot を試す。上枠・下枠の見付は `sectionFrameFaceWidthFor`（窓 min(25, 高さ/2)・片開き戸 30）で描画と共有、壁厚は断面の帯（合併と壁 1 枚の両方）。片開き戸・三方枠は下枠を試さない。展開 init の slots は `[HEAD, SILL, FIGURE]`（窓の方立の行は出ない）。通知文の slot 名は「下枠」（`error.js`）。

## ヘルパーの組込み層（S8d）
- 一覧は組込み＋ライブラリ（`helperLibraryRows`。出所バッジ 組込み／ライブラリ／上書き。同キーは組込みの位置の上書き 1 行）。組込みは読み取り専用で開き、「編集（上書きを作る）」で同キーのまま解錠→保存が `overridesBuiltin` のライブラリ項目になる（`planSave` が builtinList を渡す。同一内容は「変更なし」）。上書きは開いている文書（保存で同梱を外す）と同梱を持たない文書に効く。保存済みの文書は同梱（組込みの写し）が勝ち、合わせ直すまで従来の形（材と同じ規約）。
- 上書き行の削除は「組込みに戻す」（`planRevert`→`planRevertToBuiltin`。使用中でも戻せる）に置き換え、組込み行は削除不可。
- 暗黙の既定で使う組込みキー（巾木・腰壁天板）も使用キーに数えて同梱する（`usedEntries.implicitDetailFigureKeys`）＝上書きが文書で持ち出せる。alias の書換え対象にはしない。同梱に組込みと同キーの別内容がある行は一覧に「文書」の印（`doc-diff`。保存は止める）。

## 姿図の内外（T2。2026-11-05）
- 意図: 組込みの姿図に入れた「奥に開く＝一点鎖線・手前＝実線」（opening-model.md の towardViewer。ユーザー裁定 2026-11-05）を、部分詳細図に置き換わった姿図（`detailPrimitives` 経路）にも効かせる。開く向きは図の中の線では決まらず見る側で変わるため、線に役割の印を持たせる。
- 規則: 線の役割 `DetailDash.SWING`（開き勝手線）は `detailStrokesToElevationPrimitives` が towardViewer===false なら `ElevationDash.CENTER`、true／null は実線にする。DASHED・SOLID は従来。ヘルパーのプレビューと建具モード（見る側が不明）は実線。`detailEnvelope` は DASHED と同じく SWING を外形から除く（本体の輪郭でない）。
- 解決順: 向こう側から見るときだけ `DetailSlot.FIGURE_BACK`（`DETAIL_SLOT_TARGETS` は FIGURE と同じ組）を先に引く（上の「分類と取り付け先」）。
- UI: ヘルパーのストローク見出しの「線の役割」select（`setDashRole`・`DETAIL_DASH_LABELS`）／建具エディタ（`OPENING_DETAIL_REF_SLOTS`）と保守パネル（`detailFigureBack`）の「姿図（向こう側）」欄／起動時通知 `collectDetailFigureFailures` は figure と figureBack の両方（同じ図を両方に割り当てると 2 件＝方立・上枠と同じ）。建具エディタの「建具種別の設定を使う」は種別に figureBack が無いと「姿図を両側に使う」の意味。schema 変更なし（detailRefs は slot 名の文字列・カタログ束は slot 非依存）。
- 裁定: R1 既存の `figure` は「開く側から見た図」と定義し読み替えない／R2 `figureBack` は任意。無ければ同じ図を両側に使い開き勝手線の線種だけ変わる／R3 プレビュー・建具モードは実線／R4 `figureBack` の組込み既定は作らない。
- 限界: 役割の印が無い既存の詳細図は内外とも同じ見え方／旧ビルドで 'swing' を持つ図は UNKNOWN_DASH で読めない図／`figureBack` の fit 失敗は通知に出るが描画は `figure` に落ちる／FREE・PIVOT の両方向の開き線は未裁定（opening-model.md）。

## 姿図の配置（S10。2026-11-05）
- 名前: 「姿図の配置（`PlacedFigure`）」。「fixture」は建具（`fixtureType`／`fixtureSymbol`）、「器具」は昇降機（`EquipmentRow`）で既に使うため避けた。衛生・家具・空調・電気設備（`DetailSubject.ELECTRICAL`。表示名「電気設備」）の姿図を平面（見下げ）・天伏（見上げ）・展開・立面へ置く実体。天伏（見上げ）に出すのは空調と電気だけ（設計意図＝下から見える設備。衛生・家具は出さない。ユーザー裁定 2026-11-13）。タブ名「衛生・家具・空調」は据え置きで、電気の図も候補に出るのは受容。
- データ（P1）: `core/placedFigure.js` の凍結値クラス（id・figureKey・x・y・rotationDeg・mirror・zMm・note）。回転は `PLACED_FIGURE_ROTATION_STEP_DEG`（90）の整数倍を [0, `FULL_TURN_DEG`) に正規化（−90→270）、mirror は true だけ真。`restorePlacedFigures` が不正を捨て同 id 先勝ち（FBS・plain・仕上げ undo の共用口）。`graph.placedFigures`（`setPlacedFigures`）は階ごとの実体なので壁の鮮度キー・階追加の複製（`floorOrderFollowers`）には入れない（階削除で消え undo で戻る）。FBS は serialization-fbs.md。`codeNormalization.js` の walker（location 'placedFigure'）に載るが、`FinishModeState._missingUsageForKind` は walker を通らない自前ループ。
- 図の束（P2-1）: 平面の配置図（`DetailCategory.FIGURE`・`DetailView.PLAN`・subject ∈ `PLACED_FIGURE_SUBJECTS`。判定 `canHaveDetailViews`）だけが任意項目 `views`（`DETAIL_VIEWS_FIELD`。キー＝`DetailPlacementView` front／back／left／right／ceiling・値＝別の詳細図キー）を持てる。候補は同 subject の立面の姿図（ceiling は `CEILING_PLACED_FIGURE_SUBJECTS`＝空調・電気の平面の姿図）。検証 `BAD_VIEWS` は SUPPORT_BLOCKING でない（図は読めるが fit は INVALID）。同梱の推移展開（`usedEntries.expandUsedDetailFiguresTransitively`）は「詳細図から別の詳細図へは辿らない」の**唯一の例外**として views の値を 1 段だけ足す（参照切れは無視）。保存時の回収（`reexpandTransitiveDetailFigures`）も `viewOrigins` を起点に 1 段。取り込みの読み替え（`incomingReconcile`）は walker の対象外の doc 層の views の値も書き替える。**キーと表示名は左右が入れ替わる**: キー right／left は器具自身の左右（right＝見る人が器具の右手側に立って見る図）、表示名は製図の呼び方（正面図に向かって左から見た図が「左側面図」）。正面を向いた器具の右手側は正面図に向かって左なので、**キー right の表示名が「左側面図」・left が「右側面図」**（メーカー配布の「左側面図」はキー right に割り当てる）。入れ替えは表示名（`DETAIL_PLACEMENT_VIEW_LABEL_TEXT`）だけで、キー・保存形・照合・面の選び方は変えない（表示の並びもキーの並びのまま）。ヘルパーは配置図の新規基準の既定 role を `PLACEMENT_ORIGIN` にし（`defaultRoleFor`）、5 select（`placementViewOptions`／`setPlacementView`）を持つ。保守パネルは閲覧のみ（`formatDetailViews`）。views の先の図が主の図と同じ分類かは、描画と通知では確かめない（ヘルパーの候補だけが同じ分類に絞る。取込み・手編集で来た分類違いの組は受理する）。
- 製品情報（S1。2026-11-13）: 配置図は任意項目 `product`（`DETAIL_PRODUCT_FIELD`。名称・メーカー・型番・色名＝`DetailProductField`、値は文字列）も持てる。**配置（`PlacedFigure`）でなく図の側**に持つのは、扱う姿図が「読み込んだファイルから選定した図形」で、製品の素性は図に付いて回るから（配置ごとに持たせると同じ製品を置くたびに入力が要る・FBS も要る）。持てるのは views と同じ頭の図（`canHaveDetailViews`）だけで、建具一式は持てない（`BAD_PRODUCT`。読める図なので SUPPORT_BLOCKING に入れない。明示 undefined は無し・null は誤り）。**名称は `label`（カタログでの呼称）と別**で、表示は「name が空なら label」（`productDisplayName`）。出所 `provenance.maker`／`series`（ファイルの素性）とも別物で自動では写さない。**色違いは図を複製して色名だけ変える**（1 図＝1 製品）。照合の項目は**末尾**（parts の後ろ。先頭や途中だと照合の段の閾値が変わる）に足し、重複排除にも入れる（入れないと線と label が同じで製品情報だけ違う色違いが重複エラーになる）。結果、色違いの同梱はライブラリの図の alias にならず propose になる。差分は通知する（compare 項目・silent にしない）。ヘルパーは views の select の下に 4 つの text 欄（保存形は前後の空白を除き空を落とす）、保守パネルは閲覧のみ（`formatDetailProduct`）。給排水モードでの表示は後の手順。値は「空白を除いて空でない文字列」・`{}` も誤り（保存形は空を落とし、検証は保存形に対して行うので編集途中の空欄は通る）。既知の限界（受容）: 外から来た同梱の `product:{}`・空の値の図は「読めるが登録できない図」になり、照合では product 無しの同じ図と別物（propose）のまま。
- 基準（P2-2）: `finish/placedFigure/placedFigureTargets.js placedFigureTargets` は role `PLACEMENT_ORIGIN` かつ kind origin の基準だけを 0（配置の原点そのもの）で供給し、他は `UNSUPPORTED_DATUM`、配置図でない分類は `UNSUPPORTED_SLOT`（`roomDetailTargets` の語彙を共有）。
- 平面・天伏（P3）: 純 `renderer/placedFigureDrawPlan.js`＋`renderer/PlacedFiguresLayer.jsx`（`planFigureVisibility.shouldShowPlacedFigures`＝平面図一式と同じ述語。全 LOD）。回転 +90°＝画面時計回り・鏡像は図の局所 s を反転してから回転。見上げは `CEILING_PLACED_FIGURE_SUBJECTS` だけで xy を鏡像にしない（天伏の「向きだけ反転」）。見上げで `views.ceiling` の図が置けて fit できるときだけそれを優先し、無い・参照切れ・分類違い・fit 不能は平面図自身へ落ちる（建具の figureBack と同じ「任意の上乗せ」）。解決できない配置は配置点に画面一定の × （`PLACED_FIGURE_MISSING_MARK_PX`。矩形で代用しない）。renderer が detail/ を引く唯一の口は `detail/detailPlacement.js`。
- UI（P4）: 仕上げモードのタブ「衛生・家具・空調」（`finish/placedFigure/PlacedFigureTab.jsx`）。［配置］で配置待ち（`placingFigureKey`）→ `startDrag` の先頭で押下点を `PLACED_FIGURE_POSITION_STEP_MM`（1）で丸めて置く（dragState を作らない＝mode-system.md のドラッグ＝パン規則を崩さない）。屋根区画の指定（`roofZonePickActive`）とは排他で配置が先。連続配置なし。undo は 1 操作 1 エントリ（`withFinishUndo`）。`zMm`＝部屋の床面（`floorDyAt` 基準）からの高さ。選択は `selectedPlacedFigureId`（部屋・階段・器具・屋根区画の選択と排他）。graph の変更と undo は `finish/placedFigure/placedFigureCommands.js` の命令（`placeFigure`・`updatePlacedFigureWithUndo` ほか。無い id は false で undo を積まない）が担い、モード状態が持つのは選択と配置待ちだけ（`FinishModeState` は命令へ委譲。図面モードの汎用 State が同じ `graph.placedFigures` を同じ命令で編集し、操作を二重に持たないため）。配置の分類は `placedFigureSubjectOf(placed, figureOf)` で図から引く（配置には書き込まない。引けなければ null＝分類不明）。
- 図面モード（給排水。2026-11-13）: 定義表の 1 行 `plumbing`（対象＝衛生）。平面の描画は同じ `placedFigureDrawPlan` に `subjects`（その行の分類）を渡して絞り（キャッシュ鍵にも含める）、タップ選択は `placedFigureHit.js`。配置・移動・回転・削除は仕上げモードと同じ命令（`placedFigureCommands.js`）で、操作の窓口はモードごとに 1 つ（分類の重なり禁止）。パネルは汎用1つ（置く・直す・消す。製品情報は図の `product` を表示するだけ）。設計は mode-system.md。
- 展開（P5）: 純 `finish/placedFigure/placedFigureViews.js`＋`elevation/elevationPlacedFigures.js appendPlacedFigures`。約束＝平面の姿図は正面を図の下（局所 +t）へ向けて描く。見る向き d に対し f＝−d→正面図・f＝d→背面図・見る人が器具の右手側→キー right（表示名は左側面図）・左手側→キー left（表示名は右側面図）（鏡像は left／right を入れ替え全 view で s 反転）。正面・背面が未設定なら描かず、左右は片方が無ければ他方の鏡像で代用（左右対称の前提。設定済みで参照切れ・fit 不能は代用しない）。線は建具の詳細図と同じ `detailStrokesToElevationPrimitives`。詳細は elevation-model.md。
- 立面（P6）: `facade/facadeInputs.js exteriorPlacedFiguresOf`（配置点が屋内部屋に属さない＝屋外）＋`facade/facadePlacedFigures.js`。詳細は facade-model.md。
- 通知（P4）: 参照切れ＝unresolved-code 行（'姿図の配置'）。分類違い・基準失敗・fit 失敗＝detail-fit-failed 行（`placedFigureFitCheck.js collectPlacedFigureFailures`。同じ図は何か所に置いても 1 行・views の ceiling は空調・電気だけ検査）。
- 細線（S4。2026-11-13）: 配置した姿図は図の線の太さの指定（`weightRole`）によらず `PLACED_FIGURE_WEIGHT_ROLE`（＝細線）で平面・天伏・展開・立面とも一律に描く（設備の姿は建築の線より弱く見せる。ユーザー裁定）。掛け所は 2 つ＝平面・天伏は `placedFigureDrawPlan.js` の線の `weight`、展開・立面は両方が通る `placedFigureViews.js placeViewStrokes`（配置専用で、ここで weightRole を置換してから共用の `detailStrokesToElevationPrimitives` へ渡す＝極太→切断線の寄せが働かない）。破線などの `dashRole` は図のまま残す。建具の姿図は `placeViewStrokes` を通らないので従来どおり（共用の変換は変えない）。
- 限界・先送り: 平面のタップ選択（一覧選択のみ。タップは部屋・階段・器具・屋根区画の選択と優先順位を争うので別課題）／展開・立面は遠近・遮蔽なし／左右対称前提／部分指定の子の部屋のセルにある配置は親の帯に出ない／床の段差は原点 1 点／面ごとに fit をやり直す／立面は GL より下も切らずに描く。

## 建具一式（FITTING。2026-11-10〜11・外付け引き戸のために導入）
外付け引き戸は縦枠・扉・端材が壁の穴と欠き込みに対して決まった位置関係を持つ複数の図の集まりで、単一図の枠・姿図の口では表せない。そこで1つの建具を複数の部品図でまとめる分類「建具（一式）」を足した（B案。部品を別の登録物にする案は、三層・差分通知・同梱・照合を全部作り直すので採らなかった）。
- **分類の置き方**: 種別は同じ `detailFigure`（三層・差分通知・上書き印・同梱がそのまま効く）。最上位の strokes/datums/anchors は常に空で、`parts` に**埋め込みの単一図**を役割（13個。枠3＋上枠・下枠＋姿図2＋引き戸の戸先・戸尻内・端材とその見上げ3）ごとに1つ持つ。部品の分類は役割ごとに固定（`FITTING_PART_TARGETS`）。部品は **合成キー「<一式>#<役割>」**で引ける単一図として見せるので、検証・fit・配置・通知は既存の経路がキー文字列を受け渡すだけで効く（`detailFigureEntry`が唯一の口。完全一致が先なので登録された`#`付きの単一図は合成より優先＝受容）。図のキー自体に `#` は使えない（合成キーの形だけ免除）。
- **検証**: 一式は最上位が空・部品1個以上・id と役割が一意・役割が語彙内・部品の分類が表どおり、部品本体は単一図として検証する。ブロッキング（読めない図）は未知の役割と `#` 入りキーだけ。部品の本体にブロッキングがあれば一式全体が読めない図になる。他の誤り（部品なし・重複・分類違い）は「読めるが登録できない」。
- **照合と重複禁止**: 一式の最上位は常に同じ形なので、`parts` を重複排除の項目の**先頭**（これが無いと別物の一式どうしが同一に化ける）、照合の項目の**末尾**に足す（先頭に足すと一式の無い図の閾値が下がり strokes だけ同じ図が add から propose に変わる）。結果、部品違いの一式どうしは propose、部品が同じなら alias。部品は埋め込みで参照でないので、推移展開・読み替えは不要（材コードの走査だけ部品も歩く）。
- **解決順**: slot ごとに 建具個別 `detailRefs[slot]` ＞ 一式（`detailRefs.fitting` ＞ 建具種別の `detailFigures.fitting`）の該当部品 ＞ 記号の slot ＞ 既定。slot が `detailRefs` で明示 null なら一式も飛ばし、`fitting: null` は種別の一式を見ない。上枠が方立を流用する順（R9）は二重ループのまま保たれる。片開き戸・窓・三方枠の既定（S8e/S8f）は単一図のまま据え置き（2系統の並立を受容）。
- **引き戸の組込み一式** `df-builtin-fitting-sliding`: 部品6個＝戸先側（戸先枠＋閉じた扉）・戸尻側の短い縦枠・戸尻の端材＋開けた扉の破線と、その見上げ3個（上レールを持つ）。置き場は戸先端A・短い縦枠＝A＋(DW−50)・端材＝A＋W（引き代の向きへ）、t は走る面を0・壁の中へ正。上枠・下枠・姿図は入れない（引き戸の記号は平面と見上げだけ）。**欠き込みの底の線は図に入れない**（壁の領域が出すので二重線になる）。扉厚・隙間・出幅は図の中身で、出幅・見付・壁厚・DW・穴の幅は param で供給する（寸法はプレビュー値だけで検証すると param の結合ミスが緑のまま残る——別寸法の手計算テストを置く）。暗黙の既定で、subType が `sliding` の建具があれば同梱に1件入る。
- **左右で違う枠**: 一式の `jambHinge`/`jambLatch`（任意。`jamb`より優先）は片開き系（`hingeSideMatters` 真）だけ。窓・両開き・三方枠・引き戸は `jamb` だけ。片側ずつ解決して配置し、**既定の図の検査（R4。見付が全幅30・見込帯が壁面±出幅）は側ごとの出所で評価する**（全体の出所に畳むと、片側だけ一式で他側が既定のとき既定側の検査が外れて枠が重なる）。「fit不能の側→既定の図」と「既定の図でR4不成立→従来の描き」は1本の規則。
- **ヘルパーの一式モード**: `doc.form` は**選んでいる部品の form**のまま（合成した単一図から作る）ので、ペン入力・基準・寸法・基準点指し・試し込み・手戻しが部品へ無変更で効く。`set`（一式の下書き）への書き戻しは部品の切替と保存の時。部品の切替で手戻しは消える（form 単位を維持する受容）。一式への切替は新規の空の下書きに限る（編集中の単一図からの自動移行はしない）。全体プレビュー（部品／全体・平面／見上げ）は各部品を試し込み寸法で置き、同じ描画域に載せる（ズーム・パンの枠を1つにする）。DXF/PDF の写し先は選んでいる部品（分類を役割の分類で上書き）。**R10**: 部品の本体は出所（provenance）を持てないので、読み込んだ出所を持つ部品を1つでも写したら一式の最上位の出所を読み込んだ出所にする（出所の表示・編集のため。手描きは不変。手戻しで戻しても読み込み由来のまま）。同梱の可否は出所によらず、使用中なら一式ごと同梱する。
- **通知**: 一式の部品の fit 失敗・参照切れは既存の枠・姿図と同じ `detail-fit-failed` の行（主語は参照の持ち主＝建具個別の指定／建具種別キー。slot ラベル「建具一式」。暗黙の既定の組込みは対象外）。展開モードでも同じ行が出る（意図どおり）。立面は従来どおり出さない。
- **既知の限界・先送り**: 古いビルドは一式を「対応外の図」として従来描きへ戻る／部品をまたぐ手戻し・並べ替え・単一図→一式の変換なし／全体プレビュー内での編集なし／一式の上枠・下枠・姿図の展開・立面での目視は未（組込みは持たない）／走る面から見た展開の描き分け（F2）／`jambHinge` 等を持つ一式は片開き戸の方立だけが読み、窓の方立・上枠（`openingSection.js`）は読まない。

## 履歴
- 2026-11-13 配置した姿図を全図面で細線に一律（`PLACED_FIGURE_WEIGHT_ROLE`。破線は残す・建具の姿図は不変）の S4（コミット前。ユーザー裁定）。
- 2026-11-13 姿図の配置の命令を `placedFigureCommands.js` へ切り出し（`FinishModeState` は委譲。挙動不変）＋ `placedFigureSubjectOf` を追加した S3（コミット前）。
- 2026-11-13 分類に電気設備（`electrical`）を足し、天伏（見上げ）に出す分類を空調＋電気にした S2（ユーザー裁定。コミット前。電気モード本体・モードの定義表は別）。
- 2026-11-13 製品情報（`product`）を図の側に持たせる S1（名称・メーカー・型番・色名。ユーザー裁定。コミット前）。
- 2026-11-13 R10 の訂正: 元ファイル（DXF・PDF）は保存しない。そこから選定した図は使用中なら同梱する（ユーザー裁定）。同梱の除外の経路・読み込み由来の専用の表示文と確認文は撤去。
- 2026-11-11 建具一式（FITTING）: S1〜S4 `bffe4dc2`〜`fd5bb0b2`・S3c `95f96e69`（幾何は `opening-model.md`）／C1〜C3 `f730b622`〜`a258bbce`／C4 `4c7e327f`／C5 `2c33ad2b`／C6 `82b28f7c`／C7 `e813eeb4`／C8 `61ae2ee7`／S10 `ed0019a8`／S9 `24a7407d`（裁定は Q1〜Q7・R0〜R12・Q-C1〜Q-C6・Q-S8〜Q-S10 を推奨案またはリード裁定で確定）。
- 2026-11-05 S10 姿図の配置: P1 `43778e4c`（データ・FBS）／P2-1 `21985432`（図の束）／P2-2 `c730a737`（基準の供給）／P2-3 `a036a678`（割当て UI）／P3 `0813a83f`（平面・天伏）／P4 `f4218b53`（タブ・通知）／P5 `5f97bca5`（展開）／P6 `10d94924`（立面）／本節＝P7 文書。
- 2026-11-05 T2-1 `4839a7f3`（SWING・FIGURE_BACK の解決）／T2-2 `f62b3295`（線の役割 select・姿図（向こう側）の割当て欄・通知）／本節＝T2-3 文書。
- 2026-10-31 S1 `5f396eb2` 純モジュール／S2 `0f256ee1` カタログ種別と同梱往復／S3 `8047121a` 三方枠への反映（裁定 R1〜R21 は推奨案で確定）。
- 2026-11-04 S7c〜S7d `3d274438`〜`bbd2a719`: 矩形絞り・レイヤ on/off・プレビューのズーム／パン（長押し後の矩形）・`Anchor.offsetMm`・［基準点を指す］（裁定 R1〜R13・L1〜L5 は推奨案で確定）。
- 2026-11-04 P1 `84fe3937` 描画域＝中央ペイン全域／P2＋P3 `331f4ebb` 寸法線の足・gap 80・外側配置（R5）・縦の寸法値（R3〜R5。ユーザー指示は同日）／P5 `52a83737` 寸法の配置（gap の比例・ストロークごとの行・足 gap/2・重複を畳む＝R6〜R9。ユーザー目視指示は同日）。
- 2026-11-01 S7b の文書破棄を `loadingTask.destroy()` へ訂正（`doc.destroy` は無かった）。
- 2026-11-01 S7b（コミット前）PDF 読込み（pdfjs-dist 6.4.299 を新規依存に）。S7a（コミット前）DXF 読込み。S6b（コミット前）姿図の差替え。S4 `c4c658c3` ヘルパー画面。S5（コミット前）建具記号タブの割当て UI・プレビューの `detailRefs` 経路・閲覧タブの使用中印・本文書。
