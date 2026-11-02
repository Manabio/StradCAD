# 部分詳細図の設計意図

部分詳細図（建具の枠・部屋の取り合い・屋根・器具の姿図を、寸法に合わせて各図へ重ねる図）の登録と反映。純モジュールは `detail/`、登録画面は `ui/DetailHelperPanel.jsx`（判断は `ui/detailHelperForm.js`）、割当ては保守パネルの建具記号タブ。用語は `glossary.md`。MVP は三方枠（WF/SF/SSF）の方立（平面）と上枠（展開）だけ。

## 置き場
- 新カタログ種別 `detailFigure`（7 種別目）。三層（本体＞ライブラリ＞同梱）の照合・差分通知・上書き印がそのまま効く（`catalog-model.md`）。本体は組込みの巾木 出 10（`df-builtin-baseboard-10`）と天板 厚 20（`df-builtin-kneecap-20`）だけ（`detail/detailBuiltins.js`）。
- 同梱するのは**使用中だけ**（建具記号の `detailFigures` から推移展開で届く図）。読み込んだ DXF・PDF とその由来の図（`provenance.source` が `'dxf'` か `'pdf'`）は同梱しない（R10。S7a・S7b で実装済み＝`usedEntries.js` の `isImportedFigure` が推移展開と回復後の再展開で除く）。割当てだけが文書に残り、図を持たない環境では既定の描きに戻る。
- 参照の担い手は建具記号エントリの任意項目 `detailFigures:{jamb,head}`。三方枠の断面形の選び先 `profile` が既に建具記号にある前例に揃え、FBS を触らずに通す。建具個別の上書き（`opening.detailRefs`）は S6a で永続化（FBS 末尾 28・29、undo は建具編集の EDITABLE、読み替えは walker の rewrite）。建具エディタの select（方立・上枠の 2 つ。先頭は「記号の設定を使う」）と、R16 の明示ボタン「図の寸法を建具へ」（解決後の方立の図の param 束縛 mm を見付・出幅へ写す。undo あり・自動の書き戻しなし）。判断は `openings/openingDetailRefsEdit.js`。

## 図の表現
- **ペン命令列（上下左右に指定距離進む一筆書き）をソースに保存**し、点列は描くたびに導出する。寸法をはめ直すには「どの区間が伸縮し、どの頂点が基準に載るか」の意味が要り、プリミティブ保存では失われる。
- 位置は名前付き基準（Datum。壁仕上面・開口端など）と、各ストロークの頂点をそれに載せる Anchor で決める。軸ごとに origin はちょうど 1 つ、Anchor はストロークごと・軸ごとに origin の基準へ 1 つ必須（s・t の 2 つ）。
- 伸縮区間（stretch）は、end の基準に載るストロークでは**軸ごとにちょうど 1 本**。end が無いストロークは持たない（あれば `STRETCH_WITHOUT_END`）。目標との差分を 1 本に吸わせるので結果が決定的になる。`mm` の負・0 と stretch の本数・範囲は登録時に、固定の和が目標以上（伸縮が `DETAIL_FIT_EPS_MM` 未満）と param・material の解決値が 0 以下は fit 時（試し込みの表示と init の通知）に検出する。均等配分・比例は採らなかった。
- `LenSpec.mm` はプレビューと試し込み専用。本番の fit で param／material が解決できなければ `{error}`（固定値で代用しない）。
- 斜め `'V'` はデータ形に最初から持つ（符号項目 ss/st）。UI は上下左右から。closed は閉じ辺を描画側が補い、始点へ戻る手は書かせない。

## 分類と取り付け先
- 分類は category × view × subject の組合せ表（`core/constants.js DETAIL_VIEW_COMBOS`）。取り付け先の枠名 `DetailSlot` と許す組合せの対応 `DETAIL_SLOT_TARGETS` も同じ葉に置く（検証と割当ての選択肢が同じ表を引く）。
- 解決順は **`opening.detailRefs` ＞ 記号の `detailFigures` ＞ 既定 profile**。slot が先で、上枠は head ＞ jamb の順で方立の図を流用できる（detailRefs.head ＞ 記号.head ＞ detailRefs.jamb ＞ 記号.jamb。R9。現行の上枠＝方立と同じ形に揃えるため）。`detailRefs` がその slot を null で持つときは「なし」で、記号側の同じ slot を候補にしない（プレビューの明示 null。キー無し・undefined は記号へ進む）。
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
- 天井の段差（8b-4a・`ceilingStep`）は低い側の天井面の持ち主（区画なら区画・残りなら部屋）が持つ。区画から部屋へは継承しない。s は空気側＝高い側が正、t の伸縮で段差高を吸う。持ち主は保存せず、描くときに縦線側の端の近くで引く（区間中点は同じ高さの隣区間と連結されて誤る）。区画の形状を平面以外にすると割当ては落ちる。差し替えないもの: 傾斜・円弧・上階の天井、境界の CL 上の壁（腰壁だけの壁は壁とみなさない。垂れ壁の管轄）、階段裏面の合成区間。既知の限界: 通知の段差高は上記の境界上の壁・合成区間を見ない（描画との厳密な一致は先送り）。見付け面の新設と派生線は 8b-4b。
- 実測の注意: 現行エンジンは P の隅が腰壁でも端の縦線を床〜天井の全高で引く（F の壁の端の線）ので、差し替えるのは天端側 [天端−厚, 天端] の割れ目と輪郭だけで、天端より上の縦線は残る（F の壁の端面）。天端の CUT 水平線・向こう側の縦線は帯の外にあり実データでは出ないため、差し引きは出れば消す扱い。既知の限界（受容）: はねだしと向こう側の縦線は帯の範囲外（面と面の隙間）へ出るので、向こう側の出が大きいと天井高寸法線・隣の面と交差する。
- 既知の限界（8b-3 以降）: 他階の層の腰壁・cutAlong の垂れ壁の下端・吹抜け上部帯・階段帯・平面・天伏には出ない／片側が fit できない場合は差し替えない（両側は同じ図の fit と鏡像なので実際は両方成立か両方失敗）／隅の壁の継ぎ目が別の記録に乗るときは F の部屋の側 2 mm の点の記録を採る／床の段差・天井の段差は 8b-3・8b-4。

## 照合と重複禁止
- 図の参照は書換え先が無い種別（rewrite が null）なので alias を作らない。規則と dedupe の同値不変条件は `catalog-model.md`「読込み時の照合と未解決」「三層の重ね合わせ」を参照。

## ヘルパーはモードでない・undo に積まない
- グラフ・階・モード境界を持たず、APP_MODES の追加コストに見合わない。カタログ保守と同じ全画面パネル＋動的 import＋`runBusy`。別タブはセッションロックで開けない。
- 下書きの 1 手戻しはパネル内に持つ。グラフを変えないので `undoManager` に積まない。保存・削除は既存のカタログ編集の共通経路（`applyCatalogEditPlan`）。

## モジュール境界
- `detail/` は葉（graph・カタログ・store を読まない）。`openings/` と `elevation/`（`elevationJunction.js` だけ）が引けるのは `detailPlacement.js` だけ、`catalog/` が静的に引けるのは `detailModel.js` だけ（それ自身が constants だけを引く。本体の一覧 `detailBuiltins.js` は `loadBuiltin` の動的 import）。`ui/detailHelperForm.js` は純（node:test から単体 import 可）。`detail/`（`detail/importGraph.test.js`）・`catalog/`（`catalogImports.test.js`）・`ui/detailHelperForm.js`（`detailHelperImportGraph.test.js`）、`openings/` は `openings/importGraph.test.js` で固定。

## DXF 読込み（S7a。`detail/dxf/`・純）
- 意図: メーカー配布の ASCII DXF から輪郭を拾い、ペン命令列（ストローク）の新規下書きへ写す。**原本のバイト列は保持しない**（`sha256` だけ出所に残す）ので再解析・再生成の保証は要らず、9 段パイプライン・レイヤ辞書・LOD 事前生成は採らない。出所は `provenance={source:'dxf', fileName, sha256, maker, series, licenseNote}`（ライセンス未記入は警告 LICENSE_UNKNOWN で、保存は止めない）。
- 流れ: decode（UTF-8／Shift_JIS の置換文字が少ない方・バイナリは拒否）→ tokenize → parse（INSERT は深さ・循環で打ち切り、スケール・回転・ミラーを座標へ焼き込む。円・円弧・bulge は全部「楕円弧 c+u·cosθ+v·sinθ」で持つので非一様スケールも同じ式）→ entities（単位換算・弦分割・y 反転）→ `dxfToStrokes`（端点スナップ→連結成分→一筆書き→共線の間引き）。入口は `dxfImport.js`（例外は握って `{ok:false, error}`）。値は `core/constants.js`（`DXF_*`）、文言は `error.js`。
- 成分の順序は最初の線分の現れ順。分岐する成分は複数の一筆書き（ストローク）になり CONTOUR_OPEN（＝閉じた輪郭 1 周ではない）。自己交差は間引き前の節点で見る。`'V'` の dx/dy は正の大きさ、向きは ss（s 軸）／st（t 軸＝下向き正）。円は角度 0（+x）から始め、最後の点は最初の点と同座標。
- 画面: DXF／PDF 共通の左ペインのタブ「図面読込み（DXF／PDF）」（下記 PDF 節の画面の行）。連結成分を一覧（頂点数・閉／開・警告）から選び（ヒット判定なし）、「下書きへ写す」で選んだ成分をまとめて新規下書き 1 つへ（成分ごとに 1 本以上のストローク。未保存の下書きは破棄の確認を通す。分類・基準・stretch は後から指定。全 LenSpec は fixed）。単位が不明なら係数を指定し直せる。
- 同梱しない（DXF・PDF 由来とも）: 保存した図はライブラリ（user 層）にだけ残る。ヘルパー・保守パネルは出所と「この図は保存ファイルに入りません」を表示する。図を持たない環境の未解決行は文言（`ERR_DETAIL_FIGURE_NOT_FOUND`）で伝える。除外は同梱（`saveCatalogDocument`、`excludeImported`）だけで、使用中の判定（削除確認・使用中バッジ）は除かない。使用中の DXF・PDF 由来の図を削除しても文書の同梱へは写さず、確認文（`MSG_IMPORTED_DELETE_IN_USE`）で「現在の文書は既定の描き方に戻る」と告げる。
- 次数 3 以上の節点（T 字・十字）は間引きで消さない。自己交差は間引き前の節点で判定し、上限（`DXF_SELFINT_*`）を超えたら省いて SELF_INTERSECT_UNCHECKED。digest（sha256）が失敗しても読込みは続け、sha256 は空・警告 NO_DIGEST。
- 先送り: SPLINE／ELLIPSE・押し出し方向（210/220/230）・INSERT の配列・ペーパー空間・ズーム／パン・RDP 等の間引き（トポロジー保存版が要る）・キャンバスでのクリック選択。

## PDF 読込み（S7b。`detail/pdf/`・純。pdfjs は `ui/pdfLoader.js` だけ）
- 意図: メーカーのカタログ PDF（納まり参考図）から、ページ→範囲を選んで線（パス）を拾い、DXF と同じ連結成分の選択→新規下書きへ写す。**原本は保持しない**（`sha256`・ページ・範囲・縮尺だけ出所へ）。出所は `provenance={source:'pdf', fileName, sha256, page, clip:{x,y,w,h}（ページ座標 pt）, scaleDenominator, maker, series, licenseNote}`。同梱しない（R10。DXF と同じ）。
- 境界: pdfjs-dist（固定版 6.4.299）は `ui/pdfLoader.js` だけが静的 import し、`DetailHelperPanel` が初回の PDF を開くときだけ `import()`（独立チャンク約 485 kB＋worker 約 1.32 MB。legacy 版〔古い iOS Safari 対応〕。worker は `?url` で同梱）。純モジュール（`pdfOps`・`pdfClip`・`pdfUnits`・`pdfProvenance`・`pdfImport`）は「ページの演算子列（fnArray／argsArray）と pdfjs の OPS の名前→番号表」を入力に取るので node:test で合成の演算子列を渡せる。import は `detail/importGraph.test.js`（pdfjs 禁止）と `ui/detailHelperImportGraph.test.js` で固定。
- 流れ: constructPath だけを読み（経路は pdfjs 6.4 の符号つき平らな数列 `PdfDrawOp`。CTM は transform・save／restore・paintFormXObject で追う）→ 範囲に線分が 1 本でも掛かる経路を**丸ごと**採る（切り取らない）→ pt × 25.4/72 × 縮尺分母 N で mm → **`dxfToComponents`（S7a と共用）**。入口は `pdfImport.js`（例外は握って `{ok:false, error}`）。
- 塗り・開閉: stroke／fill は区別せず輪郭。塗り系は開いた部分経路を始点へ閉じ、stroke だけなら閉じない。**塗りだけで色が白の経路はページ背景・白抜きとして捨てる**（塗り色は setFillRGBColor だけ追う＝他の色空間は捨てない。サンプル PDF〔70 ページ〕では 1 ページ目の全面の塗りは灰で残り、白塗りで捨てられるのは p2〜p70 の端のインデックスタブ。「p.118」は印刷ページ番号で PDF の 3 ページ目）。
- 文字・画像は読まず件数を警告。上限は `PDF_MAX_PAGES`・`PDF_MAX_BYTES`（読み込まない。SIZE_LIMIT）・`PDF_MAX_PATH_OPS`・線分数 `DXF_MAX_SEGMENTS`（超えたら PATH_LIMIT）。縮尺は必須で既定なし（未入力は抽出も写しも無効）。ページ・範囲・縮尺を変えると抽出結果と選択は捨てる。
- 破棄は `loadingTask.destroy()`（`PDFDocumentProxy` に destroy は無い）。`ui/pdfLoader.js` の `closePdf` が担い、0 ページ・読込み直し・パネル閉じで呼ぶ。版を上げたら `detail/pdf/pdfjsPin.test.js` が落ちる。
- 画面: 左ペインのタブは「図面読込み（DXF／PDF）」（隠し input は accept なし。内容の先頭 1024 バイトに `%PDF-` があれば PDF、なければ DXF）。ページ番号（NumPad・前後）→ ページ画像（canvas。表示専用・回転 0 固定）の上で矩形を 1 回ドラッグ（`pointToPage`／`clipFromDrag`。図形のヒット判定はなし）＝数値欄（x・y・幅・高さ。ページ左上が原点）と同期 → 縮尺（NumPad）→「抽出」→ 連結成分の一覧（DXF と同じ）→ 出所欄 →「下書きへ写す」。読込み・抽出は `runBusy('図面読込み')` の中。pdfjs の文書は React の状態でなく ref。判断は `ui/detailHelperPdf.js`（純）。
- 先送り・既知の限界: 灰などの全面の塗り（白以外）は地として捨てず残るので、どの範囲にも掛かる（成分の選択で外す）／既知寸法による縮尺の補正（縮尺は印字の 1/N を手入力）／文字・画像の読取り／回転ページ（`/Rotate` は無視し、ユーザー空間のまま向きが横倒しのことがある）／利用者パスワード付きの PDF（開けず LOAD_FAILED。所有者パスワードだけなら開ける）／クリップ（W）・グラデーション・パターンの塗り・破線の線種／文字（寸法値）の位置合わせ／ベクタが画像化された PDF（線がない）／ハッチ・寸法線・引出線も線として入る（成分の選択で外す。p.3（印刷 p.118）で約 2 万・最大ページで約 6 万線分〔弦公差 0.1pt〕・数千成分になる＝一覧は長い）／paintFormXObject 以外の入れ子（Type3 フォント内のパス）。

## 既知の限界・先送り
- 三方枠以外へ種別を変えても `opening.detailRefs` は残す（`frameFaceWidth` と同じ規約。UI からは見えず、使用中として同梱され続ける。リード裁定）。
- 同梱の図が propose・pick（部分一致）になり、その図を指す同梱の記号が先にライブラリへ写されると、承認後もライブラリ側の記号は旧キーを指したまま（読み替えは同梱の記号だけ＝「ライブラリ層は触らない」規約の帰結。その記号を使う別文書では not-found 行になる）。
- 線種（dash／weightRole）は無視（平面は枠の太さ・展開は断面の太線）／斜め寸法線なし／寸法は 1 手単位（複数手にまたがる寸法は表せない）／mm 判定の closed は param・material・stretch で閉じ辺 0 になるケースを登録時に検出しない／同じ図を参照する別記号の失敗は 1 行にまとまる／使用中の印は開いたとき 1 回。
- 姿図の差替えの限界（S6b）: 線種は weightRole（極太は切断線へ寄せる）と dash だけ読み、破線は線分ごとの line・実線は polyline（Konva は polyline の dash を描かず、閉じた polyline を塗るため閉じ辺は始点を足した開いた折れ線にする）。レバーハンドルの取付高さの寸法（編集用）は図を置換しても残る。FL を origin にした図は窓台の分だけ伸縮する（SILL と別の挙動）。建具モード init の通知は kind が fixtureSymbol の行に載る（主語は建具種別キーで、区分 fitting/window は付かない）。ヘルパーの試し込みは分類が姿図なら幅・高さ・窓台（既定は代表の建具種別 singleSwing の既定幅・高さと窓台 0）、既定の基準は t の origin＝SILL・end＝HEAD。
- 先送り: 要素付きの part の残り（8b-2b 袖壁の分割端・8b-4 天井の段差）・屋根の軒先けらば（S9）・器具の配置（S10）・図を部品に組み合わせる作図・整理課題＝`dxfToStrokes`／`dxfToComponents`（PDF も共用）と `describeDxfWarning`・`DxfWarning.LICENSE_UNKNOWN`／`NO_DIGEST`・`DXF_PROVENANCE_FIELDS`・`draftFromDxf` の名前の一般化・`useCatalogEditActions` の共有化・`rewriteDocSymbolDetailFigures` の改名（建具種別も読み替えるため。整理課題）。

## 暗黙の既定（S8c）
- 巾木と腰壁の天板は他の部分詳細と同じ定義・ロジックで描く（ユーザー裁定 2026-11-02「現在の展開と同じ結果」）。解決規則は 1 箇所ずつ: floorWall＝`finish/roomDetailJunction.js resolveRoomDetailFigure`（割当て無しでも部屋に巾木高さ `h=<mm>` があれば組込み巾木・無ければ null＝描かない）／kneeTop＝`finish/partDetail.js resolveKneeDropDetailFigure`（腰壁があれば組込み天板。dropBottom に既定は無い）。結果の `source`＝`explicit`／`default`（`DetailFigureSource`）。
- **通知は explicit だけ**: 既定の fit 失敗は従来の線へ黙って戻る（線が出るので利用者は困らない）。参照切れ・fit 失敗の通知（`collect*Failures`）は default を飛ばす。
- **従来経路はフォールバックに降格**: `appendBaseboard` は junction の floorWall が fit できなかった面だけ、`kneeCapUnderline` は kneeTop が解決しない帯だけ（`appendKneeDropPartLines` が解決＝true を返す。fit が成れば段差 0 本でも図が担う）。明示の割当てでも同じ（8b-1 の「両方引く」は廃止）。`kneeCapUnderline` は切断壁の天端（`cutWallTopEdges`。壁の断面が帯のとき）には派生線の経路が無いので従来のまま。腰壁の端面（`appendKneeCapEndFaces`）は部位図の派生線ではないので従来どおり。
- 巾木高さは `DetailParam.BASEBOARD_HEIGHT`（`junctionTargets` の `baseboardHeightMm`。呼び出し側が部屋の h を渡し、無ければ param 未解決）。メモの鍵に高さが入る。ヘルパーの試し込みは、図が巾木高さ param を使うときだけ欄（既定 60＝`DEFAULT_BASEBOARD_HEIGHT`）が出る。
- 既知の差（従来の展開との）: (1) 巾木の派生線は最小描画幅を通る＝h<50 の巾木は分母 100 で 50 に、分母 >120 では 60 が引き上がる（従来の線は調整しなかった）。(2) 巾木の途切れは junction の述語（窓台より巾木が高ければ窓の幅で切れる。従来は床まで達する建具だけ）。(3) 天端下の細線は最小描画幅だけで決まり、実画面の 1px 保証（`kneeCapFaceMm` の scale 依存）は派生線に掛からない。実データ（golden 22 枚）は `source` を除いて全一致（`elevGoldenGate.mjs --ignore-source`）。
- 一般解（派生線の途切れ・2026-11-03 裁定）: 巾木・廻り縁の派生線を切ってよい理由は「面の壁体が無い区間（wallLessRuns）」と「線の高さを含む建具の開口」の 2 つだけ。腰壁・垂れ壁の記録は同じ壁体の上下端の修飾で壁体の有無を変えない（従来の巾木と同じ）。8a の「腰壁・垂れ壁が覆わない区間を除く」は撤回。開放部の描き方は断面エンジンの担当。

## 履歴
- 2026-10-31 S1 `5f396eb2` 純モジュール／S2 `0f256ee1` カタログ種別と同梱往復／S3 `8047121a` 三方枠への反映（裁定 R1〜R21 は推奨案で確定）。
- 2026-11-01 S7b の文書破棄を `loadingTask.destroy()` へ訂正（`doc.destroy` は無かった）。
- 2026-11-01 S7b（コミット前）PDF 読込み（pdfjs-dist 6.4.299 を新規依存に）。S7a（コミット前）DXF 読込み。S6b（コミット前）姿図の差替え。S4 `c4c658c3` ヘルパー画面。S5（コミット前）建具記号タブの割当て UI・プレビューの `detailRefs` 経路・閲覧タブの使用中印・本文書。
