# 部分詳細図の設計意図

部分詳細図（建具の枠・部屋の取り合い・屋根・器具の姿図を、寸法に合わせて各図へ重ねる図）の登録と反映。純モジュールは `detail/`、登録画面は `ui/DetailHelperPanel.jsx`（判断は `ui/detailHelperForm.js`）、割当ては保守パネルの建具記号タブ。用語は `glossary.md`。MVP は三方枠（WF/SF/SSF）の方立（平面）と上枠（展開）だけ。

## 置き場
- 新カタログ種別 `detailFigure`（7 種別目）。三層（本体＞ライブラリ＞同梱）の照合・差分通知・上書き印がそのまま効く（`catalog-model.md`）。本体は空。
- 同梱するのは**使用中だけ**（建具記号の `detailFigures` から推移展開で届く図）。読み込んだ DXF・PDF とその由来の図（`provenance.source==='dxf'`）は同梱しない（R10。DXF は S7a で実装済み＝`usedEntries.js` の推移展開と回復後の再展開が除く。PDF は S7b）。割当てだけが文書に残り、図を持たない環境では既定の描きに戻る。
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

## 照合と重複禁止
- 図の参照は書換え先が無い種別（rewrite が null）なので alias を作らない。規則と dedupe の同値不変条件は `catalog-model.md`「読込み時の照合と未解決」「三層の重ね合わせ」を参照。

## ヘルパーはモードでない・undo に積まない
- グラフ・階・モード境界を持たず、APP_MODES の追加コストに見合わない。カタログ保守と同じ全画面パネル＋動的 import＋`runBusy`。別タブはセッションロックで開けない。
- 下書きの 1 手戻しはパネル内に持つ。グラフを変えないので `undoManager` に積まない。保存・削除は既存のカタログ編集の共通経路（`applyCatalogEditPlan`）。

## モジュール境界
- `detail/` は葉（graph・カタログ・store を読まない）。`openings/` が引けるのは `detailPlacement.js` だけ、`catalog/` が静的に引けるのは `detailModel.js` だけ（それ自身が constants だけを引く。本体の空一覧 `detailBuiltins.js` は `loadBuiltin` の動的 import）。`ui/detailHelperForm.js` は純（node:test から単体 import 可）。`detail/`（`detail/importGraph.test.js`）・`catalog/`（`catalogImports.test.js`）・`ui/detailHelperForm.js`（`detailHelperImportGraph.test.js`）、`openings/` は `openings/importGraph.test.js` で固定。

## DXF 読込み（S7a。`detail/dxf/`・純）
- 意図: メーカー配布の ASCII DXF から輪郭を拾い、ペン命令列（ストローク）の新規下書きへ写す。**原本のバイト列は保持しない**（`sha256` だけ出所に残す）ので再解析・再生成の保証は要らず、9 段パイプライン・レイヤ辞書・LOD 事前生成は採らない。出所は `provenance={source:'dxf', fileName, sha256, maker, series, licenseNote}`（ライセンス未記入は警告 LICENSE_UNKNOWN で、保存は止めない）。
- 流れ: `dxfDecode`（UTF-8／Shift_JIS の置換文字が少ない方・バイナリは拒否）→ `dxfTokenize`（対。不正 code・切れたファイルは `{error}`）→ `dxfParse`（LINE・ARC・CIRCLE・LWPOLYLINE の bulge・POLYLINE/VERTEX・INSERT を line／arc の 2 種へ。INSERT は深さ・循環で打ち切り、スケール・回転・ミラーを座標へ焼き込む。円・円弧・bulge は全部「楕円弧 c+u·cosθ+v·sinθ」で持つので非一様スケールも同じ式）→ `dxfEntities`（単位換算・弦分割・図座標 s 右／t 下向きへ y 反転）→ `dxfToStrokes`（端点スナップ→連結成分→一筆書き→共線の間引き→U/D/L/R／`'V'`）。入口は `dxfImport.js`（`readDxf`／`buildDxfScene`。例外は握って `{ok:false, error}`）。
- 値は `core/constants.js`（`DXF_*`・`DxfWarning`・`DxfReject`）。文言は `error.js`（`WARN_DXF_*`／`ERR_DXF_*`／`MSG_DXF_NOT_IN_FILE`）。
- 成分の順序は最初の線分の現れ順。分岐する成分は複数の一筆書き（ストローク）になり CONTOUR_OPEN（＝閉じた輪郭 1 周ではない）。自己交差は間引き前の節点で見る。`'V'` の dx/dy は正の大きさ、向きは ss（s 軸）／st（t 軸＝下向き正）。円は角度 0（+x）から始め、最後の点は最初の点と同座標。
- 画面: ヘルパーの左ペイン「DXF 読込み」タブ（ファイル選択は accept なし・内容で判定。`runBusy('DXF 読込み')` の中で読む）。連結成分を一覧（頂点数・閉／開・警告）から選び（ヒット判定なし）、「下書きへ写す」で選んだ成分をまとめて新規下書き 1 つへ（成分ごとに 1 本以上のストローク。未保存の下書きは破棄の確認を通す。分類・基準・stretch は後から指定。全 LenSpec は fixed）。単位が不明なら係数を指定し直せる。
- 同梱しない: 保存した図はライブラリ（user 層）にだけ残る。ヘルパー・保守パネルは出所と「この図は保存ファイルに入りません」を表示する。図を持たない環境の未解決行は文言（`ERR_DETAIL_FIGURE_NOT_FOUND`）で伝える。除外は同梱（`saveCatalogDocument`、`excludeDxf`）だけで、使用中の判定（削除確認・使用中バッジ）は除かない。使用中の DXF 由来の図を削除しても文書の同梱へは写さず、確認文（`MSG_DXF_DELETE_IN_USE`）で「現在の文書は既定の描き方に戻る」と告げる。
- 次数 3 以上の節点（T 字・十字の接合点）は共線の間引きで消さない。自己交差は間引き前の節点で判定する。
- digest（sha256）が失敗しても読込みは続け、sha256 は空・警告 NO_DIGEST。
- 線分数（`DXF_SELFINT_MAX_SEGMENTS`）・候補の対（`DXF_SELFINT_MAX_PAIRS`）・格子登録数（`DXF_SELFINT_MAX_CELL_ENTRIES`）の上限を超えたら自己交差の判定を省き、警告 SELF_INTERSECT_UNCHECKED。
- 先送り: PDF（S7b）・SPLINE／ELLIPSE・押し出し方向（210/220/230）・INSERT の配列・ペーパー空間・ズーム／パン・RDP 等の間引き（トポロジー保存版が要る）・キャンバスでのクリック選択。

## 既知の限界・先送り
- 三方枠以外へ種別を変えても `opening.detailRefs` は残す（`frameFaceWidth` と同じ規約。UI からは見えず、使用中として同梱され続ける。リード裁定）。
- 同梱の図が propose・pick（部分一致）になり、その図を指す同梱の記号が先にライブラリへ写されると、承認後もライブラリ側の記号は旧キーを指したまま（読み替えは同梱の記号だけ＝「ライブラリ層は触らない」規約の帰結。その記号を使う別文書では not-found 行になる）。
- 線種（dash／weightRole）は無視（平面は枠の太さ・展開は断面の太線）／斜め寸法線なし／寸法は 1 手単位（複数手にまたがる寸法は表せない）／mm 判定の closed は param・material・stretch で閉じ辺 0 になるケースを登録時に検出しない／同じ図を参照する別記号の失敗は 1 行にまとまる／使用中の印は開いたとき 1 回。
- 姿図の差替えの限界（S6b）: 線種は weightRole（極太は切断線へ寄せる）と dash だけ読み、破線は線分ごとの line・実線は polyline（Konva は polyline の dash を描かず、閉じた polyline を塗るため閉じ辺は始点を足した開いた折れ線にする）。レバーハンドルの取付高さの寸法（編集用）は図を置換しても残る。FL を origin にした図は窓台の分だけ伸縮する（SILL と別の挙動）。建具モード init の通知は kind が fixtureSymbol の行に載る（主語は建具種別キーで、区分 fitting/window は付かない）。ヘルパーの試し込みは分類が姿図なら幅・高さ・窓台（既定は代表の建具種別 singleSwing の既定幅・高さと窓台 0）、既定の基準は t の origin＝SILL・end＝HEAD。
- 先送り: PDF（S7b）・部屋の取り合い（S8）・屋根の軒先けらば（S9）・器具の配置（S10）・PDF・図を部品に組み合わせる作図・`useCatalogEditActions` の共有化・`rewriteDocSymbolDetailFigures` の改名（建具種別も読み替えるため。整理課題）。

## 履歴
- 2026-10-31 S1 `5f396eb2` 純モジュール／S2 `0f256ee1` カタログ種別と同梱往復／S3 `8047121a` 三方枠への反映（裁定 R1〜R21 は推奨案で確定）。
- 2026-11-01 S7a（コミット前）DXF 読込み。S6b（コミット前）姿図の差替え。S4 `c4c658c3` ヘルパー画面。S5（コミット前）建具記号タブの割当て UI・プレビューの `detailRefs` 経路・閲覧タブの使用中印・本文書。
