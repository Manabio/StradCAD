# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に描く専用モード。平面・通り芯・寸法は出さず、
`viewport.scaleX/offsetX`（ズーム）には触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）だけで完結し、
平面へ戻ると元のビューが保たれる不変条件。純モジュールは`app/src/elevation/`に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`
（DOM依存）を静的importしない（node:test単体実行のため。校正値は`viewport.js`から取るか呼び出し側=`App.jsx`が渡す）。

突入時の帯の一括構築（`_buildBands`。自階＋直上階／直下階のgraph）は`withGraphReadScope`で囲む——graphを一切変更しない
読み取り専用処理であり、囲まないとMobXのcomputedが観測者ゼロで毎回再計算され突入に十数秒かかる
（実機12室で14.2秒→0.52秒。`.claude/implementation-policy.md` 方針8）。

縦横スクロールは**クランプ方式**（循環しない・画面に収まる帯もminXへクランプし中央寄せしない——全帯を左三角の位置で揃えるため）で
**書き込み時にクランプする**（読み出し側だけだと過剰ドラッグ分がスラックとして蓄積しデッドゾーンになる）。横スクロールの既定位置は
左三角(`band.leftAnchorX`)から`LEFT_MARGIN_SCREEN_MM`（2パス換算）ぶん手前——`clampFaceOffset`の下限だけを`minX-marginMm`へ広げて実現する
（上限はminXのまま）。

## A/B/C/D の向きと不変条件
**展開記号は「その断面が見ている面」の幾何で決まる（ユーザー明示指示2026-08その11）**: 展開図の作成は
「手順1: 必要な展開断面を抽出／手順2: 抽出した断面を階段の上り方向に応じて並べかえる」の2段階で、
**向きは絶対・順番は後**。したがって各cutの`face`は必ず**その切断が視線の先に見ている平面**でなければ
ならない——`switchbackCuts`のseq2は往路レーンの中を切って`towardS1`（往復レーンの境界＝実機の「中心1」）を
見るので面も中心1、seq4は`towardS0`（往路外側）を見るので面は`wOut1`になる。旧実装はseq2に`wOut1`
（＝視線の**背後**の壁）を、seq4に`wOut2`を結び付けており、図の向き（D＝西向き）と面の幾何（東向きの壁）が
食い違っていた。その結果、面由来の寸法・向こう側判定が反対側を向き、実機「6」D1が「向こうに壁の無い
はずの面」で1500+2000に割れていた。**面の選択はcuts表（`switchbackCuts.js`）が唯一の情報源**とし、
`elevationStairSequence.js`は`cutOf(seqNo).face`をそのまま使う（独自に`wOut1`/`wOut2`を選び直さない
——ここが「抽出と順番決めがごっちゃになっていた」箇所）。中心1の面は実壁が無くても作る（同位置の
中心線を軸に、`hasRealWall:false`で）。不変条件: 全cutで`letterOf(isVertical, face.inward)`が
`letterOf(line.isVertical, -cut.viewSign)`と一致する。

A＝平面の上側（北）を室内から見た面、B=右、C=下、D=左。時計回りA→B→C→D。隣接する面同士は同じ隅を世界座標で共有する（`buildRoomFaces`の
最重要不変条件——letterでグループ化してから連結すると、L字部屋の隅で世界座標が一致しなくなる。外周を実際に1周する順で組み立てラベルは
出現順に振る）。外周エッジは`computeExternalEdgeParams`の結果を**axisCLIdごとに分けてから**`mergeSegments`する
（一括だと別letterの面同士が誤ってマージされる）。

## プリミティブ語彙とスクリーン固定サイズ要素
既存の「図」語彙に`weight`を追加しただけ。建具記号丸（`tag`）・留め三角（`miterTriangle`。輪郭線のみ）はスクリーン固定サイズが必要なため、
mm座標に焼き込まずアンカー点だけを持つ専用プリミティブにし、pxはレンダラ側で校正値（`screenPxPerMm`）を掛けて算出する
（焼き込むとscale変化で見た目サイズが狂う）。

## 面の配置・注記帯
面配置・壁芯間寸法は`face.lo/hi`（仕上げ面）ではなく`faceBoundaryLocalX`（壁中心線）基準（壁面線=CUTのみ仕上げ面基準）。
`buildRoomBand`/`buildStairBand`の面配置ループ・帯確定処理は`elevationBand.js`の`layoutBandFaces`/`finalizeBand`へ一本化済み（2026-08リファクタ）
——共有先を`elevationPrimitives.js`にしないのは、同ファイルが`elevationFigure.js`からimportされており`buildFaceFigure`を使う帯レイヤを置くと循環importになるため。
**実画面mm指定の量（面間ギャップ・部屋名枠余白・留め三角アンカー・注記帯の各段位置・左スクロール余白）は倍率換算に2パス構築を要する**
（1パス目=仮値で帯の高さ→倍率を確定、2パス目=`screenMmToModelMm`で実値換算。倍率決定が先でないと循環参照）。

水平寸法は寸法線足を出さず、壁中心線・通り芯自体の一点鎖線を寸法線位置まで下ろし交点に塗り丸(`dim.dot`)を置く（CH寸法の足のみ残す）。
**CH寸法の足はCLに触れず、CLから実画面3mm（`DIM_FOOT_GAP_SCREEN_MM`。他の実画面mm量と同じ2パス換算）
手前で止める**（ユーザー明示指示2026-08その13。展開図で統一）——足の終点は必ず**その寸法自身の側**の
CLの手前になるため、「階段展開図で反対側のCLまで伸ばさない」も同じ1規則で満たされる。旧実装は左CH寸法が
`foot:0`（＝面のローカル原点。面を横断して反対側のCL位置まで伸びる）だった。足の長さは
`CH_DIM_OFFSET_MM − 隙間`で図全体に統一される。
寸法値は寸法線の**上側**。床線から下へ①tag②寸法の鎖③通り芯丸+面ラベル(同じ段)の順。
**寸法は1行だけ**（ユーザー明示指示2026-08「展開図に寸法2段書きは不要」）——旧ROW2（通り芯間寸法の
独立行）は廃止し、通り芯を鎖の分割点（S5）として統合した。「壁幅が通り芯をまたぐ場合は通り芯から」も、
両端＝壁中心線・内部の分割点＝通り芯というこの鎖1本で満たす。丸の段は1行ぶん繰り上がる
（`gridCircleRowY = dimRow1Y + gridRowGapMm`。行間の定数自体は変えない）。通り芯・壁中心線は天井線より上へも
`GRID_LINE_ABOVE_CH_MM`突き出す。通り芯丸は背景色(`CANVAS_BG_COLOR`。定義は`renderer/canvasStyle.js`——展開モード以外からも参照する
汎用値のためrenderer/配下に置き、`elevationStyle.js`はre-export。index.cssの`#root`と2箇所手動同期)で塗り一点鎖線の上に描く
（`tag`は背景透明のまま対象外）。CH寸法値だけ寸法線の左側で反時計回り90°回転する。

**面に乗る通り芯の判定範囲は`face.lo/hi`ではなく面の両端の壁中心線（boundary）**（不良修正2026-08
「通り芯の丸ナンバーが描画されない場合がある」）——`face.lo/hi`は直交壁の**室内側仕上げ面**へ詰めた端
（`snapFaceEndsToCorners`）のため、面端の通り芯（必ず壁中心線に乗る）は半壁厚＋仕上げ厚ぶん外側にあり
常に除外されていた。実グラフの単純な矩形部屋で全4面とも丸0個・ROW2寸法0本になることを検証済み。
ROW1側に既にある「通り芯と同位置の一点鎖線は重複させない」判定（marksに`boundary.lo/hi`を含む）が、
元々この範囲を意図していた証拠。範囲は`face.lo/hi`とboundaryの和集合**ちょうど**（開放スパンでfaceが
外へ延びるケースを落とさないための和集合。それ以上は広げない——「面端の壁の半厚ぶん外も拾う」拡張を
一度入れたが、根拠にした実機報告が指示ミスで実際は正しく描けていたため撤去した）。

**中心線は寸法の鎖を割らない**（ユーザー実機指摘2026-08。旧S3を撤去）——階段室「6」Bで、あるべき
「2500」が中心線1本で「1500+1000」へ割れた。中心線は壁を伴わない作図補助であり、分割を担うのは
実体（段差CL・面へ到達する直交壁・開放スパン境界）と通り芯だけ。**旧S3は本番で一度も発火していなかった**
（下記の述語不整合のため）ので、これは「死んでいた分岐を生かしたら実機で不要と判明したので畳んだ」経緯。

**「通り芯か」の判定は`isGridCenterLine`（`core/centerLine.js`）に一本化する**（不良修正2026-08）——
`cl.labeled`だけで判定してはいけない。UI経路（`transform/centerLineOps.js`の`addCenterLineAt`。
kind='center'）で作られる**中心線も`labeled:true`**（`CenterLine`コンストラクタの既定値）になるため、
`labeled`単独では中心線まで通り芯扱いになる。実際この誤りでROW1のS3（面に届く非通り芯中心線での分割）は
`if (cl.labeled) continue`が中心線ごと弾き、**本番で一度も発火しない死んだ分岐**だった（既存テストと
Round Fフィクスチャが中心線を明示的に`labeled:false`で作っていたため長く検出されなかった）。
`core/clQuery.js`の**系統A（`_labeledCLs`＝discipline不問。`gridXs`/`gridYs`＝交点を張るグリッド軸）と
系統B（`_isLabeledStructCL`＝通り芯）は別物**という既存の区別が、この一本化の根拠。

**注記帯の全ての段位置はスクリーンmm基準の独立定数**（tag行/ROW1/ROW1〜ROW2〜丸行の3つ。tag・通り芯丸のスクリーン固定半径ぶん、
モデルmm固定だと縮尺次第で床線・寸法行・寸法値テキストに重なるため）。3つは互いに独立に調整する——一方をもう一方の倍数として式で導出すると
値が機械的に動き、承認済みの見た目を踏み外す。面ラベルと通り芯丸が同じ段で近いと重なるため、`avoidGridCollisionX`が「通り芯＋面境界の並びで
最も広い区間の中点」へ面ラベルを退避させる（1回の走査で決定的。旧・一段固定シフト方式は密な通り芯で別の丸に重なり直す不具合があった）。

帯の描画範囲の上端には`BAND_TOP_MARGIN_MM`の余白を確保する。`layoutBands`の`placement.topMm`は`band.bounds.minY`（帯の実描画範囲の上端）に
対応する（`bandContentOriginMm`。取り違えると天井線がはみ出す）。

## FL高さ（floorOffset）: bounds は floorOffset=0 のときの描画範囲
`Room.floorLevel`由来の`floorOffset`は帯内の全プリミティブをy方向へ平行移動するが、**bounds は floorOffset 適用前の描画範囲を表す**
（シフト後の座標から計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカーする仕組み=`bandContentOriginMm`が一様シフトを
打ち消してしまい見た目に一切効かなくなる、という過去の不具合があったため）。

そのぶん隣接帯との実すき間はfloorOffset差だけ縮む。boundsは動かせないため、積み上げ専用の`heightMm`/`topMarginMm`（`layoutBands`消費）で
対処する——両者は排他（floorOffsetの符号で片方にしかせり出さない）なので`heightMm`に`Math.max(0,-floorOffset)`、`topMarginMm`に
`Math.max(0,floorOffset)`を加える（両方に一律`Math.abs`を加えると使わない側が過剰予約になる）。段差高さ自体の寸法線は描かない
（この`floorOffset`は部屋帯全体の階基準ズレで、次節の壁際の段差とは別物）。

## 床の段差プロファイル（部分指定）
**`selectElevationRooms`は部分指定（`referenceRoomIds`非空）を対象から除外する**（QA修正）——部分指定は独自の展開図帯を持たず、
親の帯の中で下記の段差プロファイルとして表現されるため。除外しないと親・部分指定の両方に同じ壁面が重複して展開されてしまう。

部分指定Room（`referenceRoomIds`で親を参照。`.claude/glossary.md`）が親の壁際セルの一部を占め`floorLevel`が異なる場合、床線は段差付きの
階段状polylineになる。`elevationFloorProfile.js`の`wallAdjacentFloorSegments(face, parentRoom, graph)`が、面に接する親自身のセル
（`finish/gridCells.js`の`refreshCells`/`cellBoundsFromKey`を再利用）を壁沿いに拾い、部分指定のセル集合に含まれていればその
`effectiveFloorLevel`差分、含まれなければ0を割り当てて区間配列にする（同値の隣接区間は結合）。**極小(<`GAP_EPS`=1e-6mm)幅の区間は
floorDeltaMmが前後と異なっていても前（無ければ次）の区間へ強制的に吸収してから、通常のdelta一致マージへ進む**（QA修正）——CLの昇格/降格・
再スナップ等で「同じ位置のはずの別CL」を参照するようになると、隣接セルの境界に極小の誤差が生じ、それが独立区間として残ってしまい
「子→親(極小)→子」という見た目上の1往復（段差の抽出不良）になる。gap-fill（隙間埋め）・末尾判定の側にも同様のepsilonを持たせる案が
あったが、そこで生成される極小区間は結局この吸収処理で必ず除去されるため冗長と判明し撤去した——epsilonはこの吸収処理1箇所に一本化した。
`buildRoomBand`/`buildStairBand`が`ctx.floorSegments`として渡し（未指定時はフラット1区間）、床線は区間ごとの
水平線＋段差の縦線（すべてCUT。寸法は描かない）になる。両端の出隅縦線（次節）もこの区間配列の先頭/末尾(`segs[0]`/`segs[末尾]`)から実際の
床・天井高さを読むため、抽出が正しいことが出隅縦線の高さの正しさに直結する。段差がある面(`segs.length>1`)
は図の右側にも左のCH寸法と同じ様式（縦書き値・端部塗り丸）でCH寸法を追加する（値=右端区間の実際の床〜天井距離=そのエリアの解決済みCH）。
**直前の面の右端区間と次の面の左端区間で床・天井の起点が変わる継ぎ目では、次の面の左側にもCH寸法を描く**
（ユーザー明示指示2026-08その4改「B1右=+100→C1左=+0、床の起点高さが変わるのでC1の左側に天井高さの寸法線が必要。次のA2も同様」。
`segEndProfile`＋`layoutBandFaces`の持ち回り比較。段差見付け面は持ち回りを更新しない＝実質隣接で比較）。
**端区間は素の（描かれるまま）の先頭/末尾区間を読む**（問題修正2026-08その6: 入隅に挟まる半壁厚程度のgap-fill区間も
実際に床として描かれる——実機の「B1の右側の床は1FL+100」はまさにその区間で、次の面の左端との不一致こそが継ぎ目。
一時導入した幅閾値の読み飛ばし方式は実機挙動と逆で撤回）。**段差見付け面も継ぎ目判定に参加する**（床=`baseFloorDeltaMm`・
天井=`ceilAbsMm`。実機の「C1」は見付け面であり、これを除外していたのがC1の左CH寸法が出なかった根本原因）。
壁面同士の継ぎ目は隅のセルを共有し床が連続するため通常発火せず、発火する典型は見付け面の前後。これにより右へ
`CH_DIM_OFFSET_MM`ぶん描画範囲が伸びるため、隣接面の間隔(`gapModelMm`)は壁中心線間ではなく「前の面の右CH寸法込みの右端」〜「次の面自身の
boundary.lo」で確保する（`buildRoomBand`/`buildStairBand`の`prevRightExtent`。左側は帯先頭面にしか左CH寸法が付かないため対象外）。

## 天井高さの解決（フォールバック・部分指定の段差調整）と区間別天井断面線
`finish/roomMetrics.js`の`roomCeilingHeight(graph, room)`が仕上げ表・展開図共通の唯一の情報源。数値化できない自由入力
（傾斜天井のレンジ表記）は`graph.defaultCeilingHeight`で作図しラベルは原文。部分指定が自身のCH指定
（レンジ表記のような非数値の明示指定も含む）を持たない場合、天井の絶対高さを親と揃えるようCHを段差ぶん増減する
（部分指定CH = 親CH − (部分FL − 親FL)。**FLが親と同一でも親CHへ揃える**——問題修正2026-08: 旧実装はFL差がある場合しか調整せず、
FL同一の部分指定（床材違いエリア等）がdefaultCeilingHeightへ落ちて親と異なるCHになり偽の天井段差の原因になった。
親を再帰的に解決、循環ガードあり。自身の明示指定は常に優先＝既存のcustomOverrides/master優先の
慣習をそのまま適用）。**計算結果が0以下（子FLが親CH以上）なら物理的に不可能な値としてgraph.defaultCeilingHeightへフォールバックする**
（isFallback:true）。

**天井断面線は区間（エリア）ごとに「その区間の床断面からその区間のCHの距離」に描く（問題修正2026-08）**。
`wallAdjacentFloorSegments`のsegsが床(`floorDeltaMm`)と対で`chMm`（区間所有Roomの解決済みCH）を持ち、区間結合もfloorDelta+chMmの
両方一致が条件。CLをまたいで天井の絶対高さ(FL+CH)が異なる境界は縦線（CUT）になり、描画xは「低い方からみてCLの向こう側」＝
天井が高い側へ半壁厚ずらした位置（`drawnCeilingRiserX`。床の`drawnRiserX`=低い側へ、と対になる規約）。自CH指定なしの部分指定は
上記の調整で天井絶対高さが親と揃うため水平1本のまま＝天井段差は明示CH指定時のみ現れる。端の縦線・開放スパンのアキ上端／境界縦線・
右CH寸法・左CH寸法（帯先頭面。左端区間が帯自身のときのみレンジ表記等の原文ラベルを保つ）・袖壁断面の高さ・注記一点鎖線の
突き出し上端（面内最高天井基準）も同じ区間別天井に追従する。`chMm`未指定のsegs（単体テスト等）は帯CHの水平天井へフォールバック。
開放スパンのアキ上端は開口のfloorDyAtと同じ「span中点の区間」の天井を採る。
**床断面下・天井断面上の破線（向こう側の断面）は「壁の向こう側に部分指定関係のある部屋がある展開図（またぐ面）のみ」**
（ユーザー明示指示2026-08その5。「C1の天井断面上+100に3'の天井を表す破線。A1/B1/D2には不要——壁の向こう側に部分指定関係の
ある部屋はない」）——`familyCeilingSegments`は**面のaxisCLのfar側を区間ごとにworldToCellプローブ**し、部屋ファミリー
（親＋部分指定の子）が所有するセルがある区間だけを返す（`ctx.beyondCeilings`）。**旧・全セルrun軸投影方式は撤回**（同その5:
部屋内の別エリアがrun座標上で重なるだけで、向こう側にファミリーが無い外周面A1/B1/D2にも破線が出た。さらに前の「帯CHと
区間CHの比較だけで面全域に中線実線」も同様に撤回済み）。描画は論理区間（segs）の天井断面と比較し、断面より上のみ細線の破線
——比較を描画済みrun範囲（±半壁厚オフセット後）にすると論理境界一致面で半壁厚の偽スリバーが生じる。開放スパン区間は
**同じ高さの**far天井線の管轄のため差し引く（QA H3）。bcごとの断片は接する区間をマージして1本で積む（QA H2: 破線位相の
分割防止）。断面と同高・断面より下のエリアは描かない（類似規則への拡張は明示指示がある場合のみの既存方針）。
far天井線・far床線自体の端xは論理span境界のまま（天井段差の±半壁厚オフセットとは半壁厚ぶんずれる。床側と同一の既知挙動）。
defer: 天井高さが異なる内部境界（壁の無い部屋内部）の
見付け面（段差見付け面は床のみ。**その上部アキの上端も帯CH基準のまま**＝両側の実天井へのクランプは未対応）・
垂れ壁アキ(`kneeDropGapsOnFace`)・壁2段書きの縦中心(-CH/2)・階段帯の上階クリップ縦線は帯CH基準のまま。

## 開口（建具）の展開図表現
開口は`openings/openingElevationFigure.js`の`buildOpeningElevation`（建具モード編集用姿図と同一の純関数）を
`includeDims:false, includeMotionArrows:false, includeLevelLine:false`で再利用し、枠・吊元表示・機構表現・レバーハンドルだけ残す
（両モジュールともFL=y0・上方向負で座標系が一致するため配置は`(x,0)`平行移動のみ）。建具記号丸は開口の中心ではなく姿が見える図の下（tag行）へ。
**`openingsOnFace`は`wallSide`で絞らない**——開口は物理的にその場所の壁すべてを貫通するため、共有壁の建具は両側の部屋の面に出る
（旧仕様「配置時にクリックした側の面にのみ表示」は、反対側の部屋の展開図に建具が一切出ない実機不具合の原因だったため撤回。
`findOpeningsOnWall`と同じ考え方）。**姿図の正準向きは「世界座標昇順＝図のx昇順」**（吊元`hingeSide<0`＝`coord1`側＝図のx=0。
平面記号`OpeningsLayer.jsx swingSymbol`の`hingeAlong`と同じ世界アンカー）のため、世界順とローカル順が反転する面
（`dirSign<0`。裏側から見る面もここに含まれる）では`mirrorPrimitiveX`（`elevationPrimitives.js`）で左右反転してから置く——
反転しないと吊元・親子扉の子・レバーハンドル等の非対称要素が逆端に描かれる。
**床に高低差がある面（部分指定の段差＝`floorSegments`）では、建具・直交壁の建具断面ともその位置の実際の床に乗せる**——
姿図はFL=y0（帯の親FL）基準のため、開口中心位置（断面は隅x=0/run）の区間の床yへ平行移動する（`floorDyAt`）。
親FL基準のまま置くと段差区間の建具が床から浮く／めり込む。段差をまたぐ開口は開口中心位置の区間の床を採る。
窓の`sillHeight`もこのシフトにより「その区間の床からの高さ」になる。
直交壁（隣・次の面）の建具が切断位置（面端）にかかる場合、`openingsReachingCorner`（隣接面自身の隅=0/runに開口スパンが届くかで判定）で
対象を選び、`openingSectionPrimitives`が[枠(CUT)][扉(SILHOUETTE)][枠(CUT)]の3rectを面の両端の帯に描く
（`buildRoomBand`/`buildStairBand`が`faces[(i∓1+n)%n]`をprevFace/nextFaceとしてctxに渡す）。

## 腰壁の天端・端部の見えがかり（`kneeCapMarksOnFace`。仕様2026-08）
天端は壁の上端から下への帯（`.claude/data-model.md`参照）なので、面自身が腰壁のときは
**上端＝天端を中線・下端を細線**の水平2本で描く。ただし**見付は実厚（`CAP_THICKNESS`=30）
ではなく`KNEE_CAP_FACE_MM`（=50。`elevationStyle.js`）**——実厚のままだと2本線が縮尺で
潰れて読めないため作図上だけ広げる（ユーザー明示指示）。モデルの寸法は実厚のまま。
端部（端部抑え）も同じ帯の見え方なので端に縦の中線＋内側`KNEE_CAP_FACE_MM`の縦細線を
描く。天端の出（`CAP_OVERHANG`）は厚み方向だけで長さ方向には出ないため、端部の中線は
壁端そのものに立つ。**次の2つの端には描かない**——
面端でクランプされた端（直交壁との取り合い。腰壁は相手の壁表面まで行って終わり、その位置の
縦線は既存の`hasWallAtLocal0/Run`が描く）と、同じ軸上に壁が続く端（連続する壁は同じ偏芯・
同じ厚みで同面のため。上の「腰壁の上に縦線を出さない」と同じ判断）。直交する腰壁が断面枠
（`partitionCutAtLocal0/Run`）として出る側では、枠の上辺が天端そのものなので**帯の下端の
細線だけ**を足す。天井まで届く袖壁（`topHeightMm=null`）には天端が無いので足さない。

**断面エンジン側にも同じ天端が要る**（`sectionEmit.js`の`kneeCapUnderline`）。`buildFaceFigure`
は帯の持ち主の階のグラフしか見ないため、下階の帯へ多層書きされた**上階の腰壁**は
`kneeCapMarksOnFace`に掛からない（実機2026-08: 1階「5」A・「6」Cの真上にある2階の腰壁。
診断で`レコード計0`＝その面に渡るグラフに腰壁レコードが無い、と確定）。断面エンジンは世界座標で
上階の壁を拾い`isKneeDrop`で天端の露出を既に判定しているので、**天端の水平線を描く3経路
（`cut`の`cutWallTopEdges`／`cutAlong`の上端／`wall`の上端）それぞれに帯の下端の細線を足す**。
条件は「その上端を実際に描いたとき」かつ「上端が天井より下＝天端が露出」——垂れ壁は下端側が
露出するので上端は天井に一致し、この条件で自然に外れる。

## 腰壁の上に縦線を出さない（ユーザー明示指示2026-08その17。再発の根本対策）
「「6」D1・B: 腰壁上のエッジは不要」。手前の腰壁（`cut`帯）に遮られて**その列だけ下端が持ち上がった**
見えがかり壁の帯は、隣接列では1本の大きな帯（あるいは別の見え方）になる——同じ壁の続きであって
「そこで壁が終わった」わけではないので、側縁の縦線を描いてはいけない。`emitColumns`の凹み側面線・
端の縦線は`trimmedByCutWall(col, band.z0)`が真なら描かない。

**なぜ再発したか**: 同じ症状（左CL上のz3800..5400の縦線）に対し過去は`isRecessAgainst`へ
`layerRole`の一致判定を足して塞いだが、それは「隣接列に壁帯はあるが層が入れ替わっただけ」という
別ケースの対策だった。実機では隣接列に壁帯そのものが無く（`slab`等に化ける）、`matchingBand`が
nullを返して「壁が終わる」と判定されるため素通りしていた。水平線側は同じ理由で既に
`trimmedByCutWall`で抑止済みで、**縦線だけが取り残されていた**のが根本。線種（水平/垂直）で
別々に判定していたことが原因なので、同じ述語を両方に適用する形に揃えた。

## 壁の無い辺は展開図の面にしない（ユーザー実機指摘2026-08「「5」A2：ここに壁はない」）
面は部屋の輪郭の辺から作られるため、**壁が1本も生成されていない辺**（階段の上り口・下り口のように
`generateRoomWallsFromOutline`が`stairOpenings`でスキップした辺）にも面ができる。判定自体は既に
できていて、`buildRoomFaces`の`innerWallFaceAt`がnullを返した面は`hasRealWall=false`（`faceValue`は
CL芯へフォールバック）になる——足りなかったのは**それを面リストから落とすこと**だけだった。
`composeRoomFaces`の最後（隅のスナップ・開放スパンの延長・袖壁分割をすべて済ませた後。残る面の端の
情報を変えないため）で落とす。

例外は階段帯のみ（`keepWallLessFaces:true`）: 上り口の面はレーン範囲の算出（`switchbackCuts`のwEntry）に
使うため、落とすと切断表が組めなくなる——描画のためではなく幾何の入力として要る面である。**幾何の入力と
描画の面リストは分ける**こと（`buildStairBand`の`composedFaces`／`drawableFaces`）。フォールバック経路で
`composedFaces`をそのまま描くと、同じ「壁の無い辺を描く」不具合が階段帯側で再発する。

### 不変条件: 部屋の展開図の面は必ず平面の実壁に対応する
「ここに壁面がある」と主張する面の生成箇所は次の4つだけで、部屋帯（通常・吹抜け・多層書き）へ流れるのは
上2つ。新しい生成経路を足すときはこの表に追記し、平面照合の根拠を明示すること。

| 生成箇所 | 照合根拠 | 部屋帯へ流れるか |
|---|---|---|
| `buildRoomFaces`（部屋の輪郭の辺） | `innerWallFaceAt`が実壁を見つけたか＝`hasRealWall` | ○（falseは落とす） |
| `insertStepFaces`（段差見付け面） | 部分指定Room間の床レベル差（壁ではなく床の段差そのもの） | ○（`kind:'step'`として別扱い） |
| `buildMidWallFace`（階段の往復間） | `hasRealWall:!!wall`。壁が無ければ**レーン境界の切断面**であって壁面ではない | ×（階段帯のみ） |
| `faceFromCut`（断面エンジン） | 主対象壁が無ければ`hasRealWall:false`＝見返り・到達端の切断面。設計上、壁でない面を切る | ×（階段帯のみ） |

下2つは「壁ではない切断面を意図的に切る」階段固有の概念で、部屋帯には流れない。部屋帯の面が実壁と
対応しない状態になったら、それは不具合である。

## 2層帯は「下階にも同じ壁がある」と暗黙に仮定してはいけない（ユーザー実機指摘2026-08その17）
階段帯・吹抜け帯は2層（設置階＋上下いずれか）にまたがる。どちらも「上の層の見え方をそのまま
下へ延ばす」実装に寄りやすく、**下階／上階に同じ壁が無い区間**で実在しない輪郭を描く同型の不具合を
起こしていた。2層帯を触るときは常に「その層に実際にその壁があるか」を層ごとに引き直すこと。

- 階段帯（section層）: 隣接列との連続判定を`matchingBand`（重なる帯が1つでもあれば連続）で
  band全体に一括適用していたため、隣接列の壁が途中までしか無い場合に側縁が丸ごと消えていた
  （「6」D2: 上が吹抜けで壁が全高続く列の隣が1F天井までしか壁が無く、その差分が壁面の実際の
  終端なのに縦線が出ない）。z区間ごとの被覆（`uncoveredZRanges`）で判定する。被覆とみなすのは
  「同層・同距離＝そのまま続く壁」と「別層＝見えている壁が入れ替わっただけ」の2通りで、
  残る「同層・別距離」だけが凹みの側面として縦線になる。
  さらに**同じ壁面がキャップ（天井高さ・上階セルの有無）の違いだけで高さを変える境界には
  縦線を描かない**（ユーザー明示指示2026-08「セル境界は描画対象としない」）——キャップは
  セルの切り替わりで決まるため、この線は必ずCL（一点鎖線）に重なる。壁オブジェクトはCL位置で
  分割されるので「同じ壁面」は参照一致ではなく軸CL＋材の面位置で判定する。腰壁・垂れ壁で
  実体の高さが制限された帯（isKneeDrop）は本物の高さ差なので対象外。
- 吹抜け帯（面の引き伸ばし方式）: 下階に同じ軸CL・同じ向きの壁が実在する区間だけを下へ延ばす。
  壁の無い区間は設置階の床のまま残し、境界は既存の段差床線の仕組みで縦の折れとして出る
  （＝「下階はこの面では壁が無い」の表現）。CLは階ごとに別オブジェクトのため、idではなく
  世界座標で突き合わせる（section層の視線判定と同じ規約）。

## 見えがかりのレイキャスト: 手前のささらによる遮蔽（ユーザー明示指示2026-08その16）
「「6」D1: 復路ささら下、踊り場側は、往路ささら上まで／復路ささらは、往路ささらより奥にある」。
seq2の切断は**往路レーンの中**を通るため、視線の手前には往路レーンのささら（レーン境界側）がある。
その**上端より下**は、ささら本体（せい300の帯）と、その先に続く踊り場桁枠に隠れて、奥の復路のささらは
見えない。遮蔽の外形は「往路ささらの上端線」1本で表せる——その端から先（踊り場側）は端点の高さで
水平に延長すればよく、往路ささらの上端はミトレで踊り場桁枠の上端へ揃えてあるので、その水平延長が
そのまま桁枠の上端の外形になる。`secondaryFlights`のささら輪郭を`clipPolylineAboveOccluder`で
この外形の上側だけへ切る。

旧実装は`isBlockedByWall`（往復間の壁の有無）**しか**見ておらず、手前のささら自身による遮蔽を
判定していなかったため、復路のささら下端が往路ささらを突き抜けて踊り場まで描かれていた。

## 直進部ささらと踊り場ささらの取り合い（ユーザー明示指示2026-08その14）
「ささら上同士、ささら下同士トリム／300の線は不要」——**トリム結合する端では、ささらの上端と下端を
結ぶ端の線（せい=300）を描かない**。上端は踊り場桁枠の上端（踊り場床+巾木）へ、下端は
`mitreTo`で桁枠の下端の高さへ寄せてあり、両方が桁枠側へ継がるため、端を閉じると線が1本余る。
`stringerPrimitives`はクリップ後の閉リングからその辺だけを落とし、開いたパスとして描く
（両端をトリムした場合は上端・下端の2本に分かれる）。

**取り合い部に踊り場桁枠の断面は描かない（ユーザー明示指示2026-08その15。「6」D1・Bで確認）**:
`landingFramePrimitives`のend-on（見返り）分岐で`kind==='front'`の辺（＝踊り場が直進部と取り合う辺）は
断面矩形（12mm厚×せい300のCUT）を描かない——折返し階段の内側の踊り場ささらは往路・復路の間（100）
だけにあり、直進部のささらが来るこの位置には踊り場側のささらが存在しない。取り合いは直進部のささら
自身の輪郭が表す。back辺（壁側）の断面は従来どおり描く。

**トリム端の上端は踊り場桁枠の上端まで伸ばす**: `landingMitreOpts`が`mitreStartTopY`/`mitreEndTopY`
（＝-(踊り場z+巾木)）を渡し、`stringerBandGeometry`が上端を勾配に沿ってそこまで移動する。復路は
最初の段鼻が踊り場より1リザー上にあるため、段鼻列だけで帯を作ると桁枠に届かない（実機「6」D1の
復路見えがかりで確認）。**下端はミトレで「上端+せい」へ寄る**ので、上端を合わせれば下端も自動的に
踊り場ささらの下端へ揃う。

**z範囲のクリップはトリム端で緩める**: 側面視のささらはflightのz範囲（`baseZ`〜`baseZ+steps×riser`）で
クリップされるが、トリム端ではささらが占めるy区間 `[上端, 上端+ミトレ深さ]` がその範囲の外へ出る
（往路側は上端が巾木ぶん上・復路側は下端がミトレぶん下）。緩めないと端が切られ、切り口が
「ささら上下を結ぶ線」として残る（実機「6」D1で確認）。**FL側のクリップは従来どおり厳格**に残す
——法線オフセットぶんの突き出し（実機フィードバック第3弾B）はFL側で起きるため。回帰テストの
許容差も踊り場側の端にだけ与える。復路の見えがかり（`secondaryFlights`）も同じ経路を通る。

## 階段の高さ寸法（CH寸法）の記入ルール（ユーザー明示指示2026-08その12）
規則は2つだけ: **(1)寸法は「床断面・踊り場断面・天井断面のいずれかから、いずれかまで」を1本とする**
**(2)帯の左から端を順に見て、前の端と高さが変わったときだけ記入する**（先頭の端は必ず記入）。
面の左右の端ごとに断面プロファイルが決まる——**踊り場スラブが切れる端**は`[1FL→踊り場][踊り場→上階天井]`
（階段下に部屋があるときは踊り場より下が別室で帯の床が踊り場になるため`[踊り場→2FL][2FL→2F天井]`）、
**切れない端**は壁の向こうの通常断面`[1FL→1F天井][2FL→2F天井]`。踊り場側がどちらの端かは
歩行順で決まる（幅方向に横断するseq1/seq3は両端とも踊り場側、走行方向のseq2/2.5/5は右端・
seq4/4.5は左端＝seq2の鏡像）。実機「6」ではC左・D1左・D1右・B右・D2右の5箇所×2本＝10本になる。

判断は`elevationStairSequence.js`の`stairChDimChains`が**一括で持つ**（面の床・天井の継ぎ目だけでは
決まらない——踊り場スラブ・壁の向こうの部屋の断面が要るため、帯レイアウト側では判定できない）。
`layoutBandFaces`は`faceOverride.chDimChains`（{left,right}）を受け取ったら**それだけを描き**、
既定の「先頭面の左CH寸法」「継ぎ目のhasLeftChDim」は使わない。`buildFaceFigure`も`ctx.chDimChains`が
あれば面ごとの右CH寸法（段差の有無で決まる従来のもの）を描かない——二重に出る。

## 階をまたぐ2層帯（階段・吹抜け。問題修正2026-08その7）
**共通基盤**: 多層帯は`finalizeBand`の`heightUnits`（既定1）で宣言し、`normalizeBandHeightUnits`（`elevationLayout.js`）が
帯スロット高さを「全帯中の最大unitHeightMm×整数」へ切り上げる——**1層帯（heightUnits<2）は一切動かさない**（リード裁定:
天井高の異なる階で1層帯まで最大帯高へ引き上がる副作用を実害と判定）。`chooseElevationScale`の予算基準は`unitHeightMm ?? heightMm`
（2層帯が混ざっても縮尺は1層基準のまま）。boundsには触れない（QA A2の打ち消し問題再発防止）。
`layoutBandFaces`の`ctx.faceOverride(face,i,defaults)`はfaceCtxへの差し込みフックで、**`hasLeftChDim`の継ぎ目判定より前に
適用する**（後だと階段帯の面ごとCH寸法が出ない）。`buildFaceFigure`の`ctx.ceilingProfile`（区分線形`[[localX,ceilAbsMm],..]`）は
天井解決を`ceilAbsAtX`に集約して勾配天井をCUTのpolyline1本で描く（天井追従4箇所=端縦線上端・袖壁断面・アキ上端・注記突き出しも
追従）。範囲外のxは端点値へクランプし、カバレッジ条件は持たない（QA修正: 旧「描画範囲を覆わなければフォールバック」契約は、
壁のない端部の延長で描画範囲が広がるだけで勾配天井が本番設定で常にフラット化するバグの原因だった）。**レンダラのpolyline分岐はdash非対応のため、破線が要る線は必ずlineプリミティブで出す**（レンダラは改修しない）。

**吹抜け帯**（`elevationVoid.js`の`buildVoidBand`。`selectElevationRooms`がfeature=VOIDを採用）: 「設置階下階のFLから設置階の
天井高さまで」を、**自階の面を下へ延長する**方式で描く（下階の面リストを積まない——吹抜けの壁は下階FL〜設置階天井まで連続し
設置階FL位置に床断面は現れないため）。faceOverrideでsegsを`floorDeltaMm-=drop, chMm+=drop`（drop=`floorHeightBelow`＋下階
対応RoomのFL差）と変換すると`ceilAbs=floorDelta+chMm`不変で床だけ下がり、端縦線・左CH寸法・建具床合わせが既存機構のまま
自動追従する。世界座標は全階共通のためCLは自動的に揃う。`lowerGraph`/`floorHeightBelow`（`stairDimensions.js`。
`_peekBelowGraph`は`_peekAboveGraph`の鏡像）が無ければ1層フォールバック（例外を投げない）。

**どの階の展開図に載せるか**（ユーザー明示指示2026-08「吹抜けの展開は、床断面のある階の展開に描画する」「上部吹抜けが落ちて
いる部屋の展開と一緒に多層書き」）: 吹抜けRoomは床の無い上階に置かれるが、帯の下端のCUT床線＝床断面は**直下階のFL**にある。
そこで独立した帯にはせず、**直下階の「吹抜けが落ちている部屋」の帯へ多層書きする**（`buildRoomBandWithVoidAbove`）。
落ちる先が見つからない／その部屋が帯として出ない場合だけ、従来どおり独立した2層帯（`buildVoidBand`）へ回す。

**多層書きの組み立て**: 面の対応は「軸CLの世界座標＋見る向き」で取る——走り方向の範囲が下階の面と食い違っていても同一面なら
1枚に統合する（ユーザー明示指示: 吹抜けA面の下に1階壁は無いがX2の左に同一面が続くので一緒に描画。D面も同様）。統合で走り範囲を
広げたら**端のCLも引き直す**こと: `faceBoundaryLocalX`は`startCLId`/`endCLId`から帯のパネル幅を決めるため、上階のCL idのままだと
下階graphで引けずフォールバックし、パネルが隣と重なる。start/endのどちらがlo側かは元の面によってまちまちなので値の近さで選ぶ。
区間ごとの高さは`faceOverride`の`floorSegments`で表す。ここで効くのが**吹抜けには天井断面まで水平断面が無い**（ユーザー明示指示
2026-08。見えがかりは存在する）という解釈: 吹抜けの範囲でも床断面は下階のFLのまま1本で通り、上階の床位置に断面線は立たない。
よって区間は「吹抜けの範囲外＝下階の床〜天井」「吹抜けの範囲＝下階の床〜上階の天井」の2通りだけで、**下階にその面の壁があるか
どうかは断面の有無を左右しない**（吹抜け側だけ床を2FLへ上げると1F床断面が面の端まで届かず、端の壁断面と取り合わなくなる）。

**壁断面・見えがかりは階段展開と同じ2.5D断面エンジンを共有する**（ユーザー明示指示2026-08「処理共有のこと」）: 吹抜けを持つ面
ごとにSectionCutを1本立て、階段帯と同じ`buildColumns`→`emitColumns`を通す（層は self=下階・above=上階、zRangeは下階FL〜上階天井、
視線は`viewSign = -face.inward`）。これで1階天井の見えがかり・上階の壁（腰壁・垂れ壁）の断面が階段帯と同じ規則で出る。床線・
天井線・端の縦線・幅木・建具は従来どおり`buildFaceFigure`の責務（役割分担も階段帯と同じ）。
落とし穴: **直交壁は面の壁に突き当たって室内側の面で終わる**ためCL上の切断線には届かず、素の`isCutWall`では腰壁等の断面が丸ごと
落ちる。`line.buttToleranceMm`（面の壁の半厚）で「その厚みの中で終わる壁は切断線を横切る」とみなす。階段帯は未指定＝0のため
従来と完全同値。

**階段帯（2.5D断面エンジン方式）**: 階段帯の面コンテンツは「切断定義（薄い表）＋タイプ非依存の断面エンジン」の3層構成
（`app/src/elevation/section/`）で組み立てる。`elevationStair.js`/`elevationBand.js`はエンジン導入で変わらない
（`elevationStair.js`の`faceOverride`が各entryを`layoutBandFaces`へ差し込むだけ。後述のfloorSpanXフックのみ例外）。
描画範囲は設置階FL(y=0)〜上階天井`-(floorHeight+CH_upper)`。CH_upperの解決優先順=
(a)`stairPortEdges(['arrival'])`辺中点のfar側`worldToCell`所有Roomの`roomCeilingHeight` (b)重なるVOID/STAIR_VOID Room
(c)`upperGraph.defaultCeilingHeight`。

1. **第1層 切断定義（`section/cuts/`）**: タイプ別に「どこを・どちらを向いて・どう切るか」の表だけを持つ。
   `switchbackCuts.js`（SWITCHBACK。往路・復路の2レーン＋踊り場）・`straightCuts.js`（STRAIGHT/STRAIGHT_LANDING。
   単一レーン＋任意の踊り場）・`fanCuts.js`（WINDING/L_TURN/FLARED/OPEN_WELL。扇形レーン・回り段・矩折コーナーは
   第3層Flightの区分線形モデルで表現できないため常にnull）。返り値は`SectionCut[]`（切断線・視線方向・図のx昇順
   対応・高さ範囲・第3層Flight/Landingへの参照）。往復間の壁・踊り場壁のような「区間を横断する実壁」は
   `graph.walls`をレーン間/踊り場位置のCL座標で直読みして検出し、実在しなければ該当seqを挿入しない（合成面
   `kind:'stairMid'`。壁厚は`wall.materialRange`から求め、ハードコードしない）。往復間の壁は2F（`opts.upperGraph`。
   純モジュール不変条件維持のためoptsで素通しする。未指定時は設置階`graph`へフォールバック）の壁を見る。
   `SWITCHBACK以外・stair.cellsが空・floorHeight未確定・面分類不能`はnullを返し、呼び出し側
   （`elevationStair.js`の`buildStairBand`）は従来の`composeRoomFaces`+`rotateFacesToStart`面順＋2層枠へ
   フォールバックする（フォールバック契約自体は不変。対象外タイプが増えただけ）。
2. **第2層 断面エンジン（`sectionProbe.js`/`sectionEmit.js`/`sectionEngine.js`）**: SectionCutを受けて、run方向に
   レイキャスト列（`collectCutBreaks`→`probeColumn`）を作り、各列のz区間を「切断壁(cut)／同一直線上に縦断された
   壁(cutAlong)／見えがかり壁面(wall)／アキ(open)／床スラブ(slab・非描画)」へオクルージョン優先順位
   （cut/cutAlong＝最前面 > wallは距離最小 > 無ければ視線先の床天井位置でslab/openを判定）で分類する。
   `isRoomWall`（部屋の外周壁）はcutAlong判定から除外する——cutAlongは「往復間の壁」のような自立した内部間仕切りが
   対象で、面自身の壁までcutAlong扱いにすると`isSightlineShape`の意図的な自壁除外（面の向こうに空間が無いと
   誤判定される）が壊れるため。線種は`sectionEmit.js`の表が唯一の情報源（切断壁の縁=open側CUT/塞がれ側
   SILHOUETTE、cutAlongは天井際CUT水平線＋両端CUT縦線の3線＝塗り無しの輪郭のみ、アキのXはbaseFloorZより
   上=一点鎖線・床断面より下=破線）。**「断面より下・向こう側は細破線」への最終降格は`emitLine`1箇所だけで適用する**
   （各所に個別の破線判定を持たせない）。開口は描画を貫通させないが、そのz範囲だけ`ZBand.openingPassThrough`として
   アキの連結性判定にのみ参加する——開口が上階のアキ等へ連続する場合、分割された複数のXではなく対角頂点を結ぶ
   1つの大きなXになる。
**踏面ピッチは「区間長 ÷ (段数−1)」**（`stairRunProfile`。ユーザー実機検算2026-08「3500左CLの上が
1段目踏面、右へ2500いったところが踊り場高さ、かつ11段目」＝10ピッチ×250）——区間長は「1段目の位置〜
次区間（踊り場・上階床）の床の位置」で、その間に現れる踏面は**steps−1枚**（最終段の踏面は次区間の床が
兼ねる、という本関数の元々の仕様）。旧実装は`runLengthMm / steps`で割り、踏面が1枚ぶん細いうえ最終段の
踏面まで描いていた。`endX = startX + dir*区間長`は不変なので呼び出し側の配置には影響しない。

3. **第3層 階段幾何（`sectionStair.js`）**: 階段の3D的な寄与を、タイプ非依存の区分線形モデル
   （Flight[]＝直進区間・Landing[]＝踊り場。h(t)を関数で持たず区間ごとの直線で表す）で表す。第1層がどの区間を
   渡すかを決め、第2層は「切断線がレーンを縦断＝段鼻のジグザグ」「レーンを横切る＝正面視の梯子」「踊り場を縦断＝
   床のCUT水平線」を切断線とFlight/Landingの幾何関係だけから導出する（タイプに一切依存しない）。

**鉄骨階段のささら（ささら桁。`structure===STEEL`限定）**: 出典
[鉄骨階段のささら解説](http://kentiku-kouzou.jp/struc-sasara.html)。段板（踏み板）を両側から支える斜め梁で、
一般的にプレート（最低12mm厚・せい250〜300mm程度）を使う。この記事のとおり寸法を展開図へ反映した:
- **寸法**: 板厚`STEEL_STRINGER_THICKNESS_MM=12`mm・せい`STEEL_STRINGER_DEPTH_MM=300`mm（250〜300の上限を採用。
  Stairモデルに桁成フィールドは無いため作図既定値。`elevationStairSection.js`）。
- **上端線は段鼻の勾配線＋巾木高さ**（ユーザー実機指摘2026-08「ささらの上端は、踏面先端で巾木同寸」）
  ——最後の段鼻の高さは踊り場床(`landing.z`)そのものなので、上端が踊り場桁枠side辺の上端
  （`landing.z + baseboardHeightMm`）と**踊り場の縁でちょうど一致**する＝「直進部の斜めささらと
  踊り場ささらが取り合う」の上端側が幾何的に自動成立する。
- **下端側はミトレでトリム結合する**（同指摘「（上下共）トリム結合して取り合う」）——斜めささらの
  下端は勾配の法線オフセット・踊り場桁枠の下端は鉛直せいのため交差角が付く。`stringerBandGeometry`が
  踊り場に接する端の下端の角を「上端のその端＋桁成」の水平線との交点へ移し（`mitreStart/mitreEnd`。
  どちらの端が踊り場かは`flight.baseZ`／`baseZ+steps*riser`と`landing.z`の一致で決める）、
  **桁枠側の下端もその交点から描き始める**（`landingSideMitreX`。手前は斜めささらの下端が外形なので、
  そこへ桁枠の下端も引くと帯の内側に線が1本余る）。交点は`stringerBandGeometry`という**同じ関数**から
  両者が取る——別々に計算すると1本の取り合いが2つの位置に分裂する。
- **蹴込**（`Stair.nosing`。`core/stair.js`の既定20mm。ユーザー指示2026-08で30→20）:
  **蹴上は蹴込ぶん傾いた「斜めの断面」1本**——足元(段鼻+蹴込)から段鼻へ斜線で上がる
  （ユーザー実機指摘2026-08「蹴上、踏面に加え、蹴込を20で描画」「踊り場への上り、最後の蹴上面も
  蹴込つけて斜め断面に」）。**最終段（踊り場への上り）も同じループで処理する**ので例外扱いは無い。
  踏面は段鼻から次の蹴上の足元まで＝踏面ピッチ＋蹴込。蹴込は踏面でクランプする（超えると蹴上の
  足元が前段の段鼻より手前へ回り込み輪郭が自己交差する）。**蹴上を斜線1本にしたことで点列の刻みは
  蹴込の有無に依らず一定**（段鼻＝奇数index）になり、`stringerPrimitives`の段鼻抽出も従来のまま
  成立する——`stairRunProfile`は`noses`も明示的に返す（推測に頼らないための単一情報源。
  一度「垂直な蹴上＋水平な蹴込」で実装して刻みが1段2点→3点に変わり、この抽出を壊した経緯）。

**切断線の位置（ユーザー実機フィードバック2026-08-23で全面訂正）**: SWITCHBACKのseq2/2.5/4/4.5の
切断線は「往復間のレーン境界（100mmあきの中）」ではなく**往路レーンの中央**（`acrossCoordAt(0.25)`）、
seq5は**復路レーンの中央**（`acrossCoordAt(0.75)`）——実機で「往路と復路の間に壁が無ければ復路直進部の
ささらが見える」ため、切断線はレーンの中を通り視線はもう一方のレーン側へ向く、という指摘に基づく
（`switchbackCuts.js`の`outboundLaneLine`/`inboundLaneLine`・`towardS1`/`towardS0`）。seq2/2.5は
視線が復路側（`towardS1`）、seq4/4.5は視線が往路の外側（`towardS0`）——4つとも同じ`outboundLaneLine`を
共有し向きだけが逆になる。この結果、往復間の壁（実在すれば）は「切断線と同一直線上＝cutAlong」では
なく通常の見えがかり壁（`wall`。距離のある側面。SILHOUETTE=中線）として検出されるようになった
（旧仕様はcutAlongの3線輪郭＝CUT太線だった。腰壁のz範囲キャップ自体はcutAlong/wall共通のため維持）。

- **側面視（切断面が実際にFlightの中を縦断する）**: 段部の踏面はその切断線で文字通り切られているため、
  段鼻のジグザグ自体をCUT（太線）で描く（DWD立面図でも踏板は断面として描かれている）。手前側
  （切断面と視線の間）のささらは切り取られるため描かず、**切断面の向こう側にある自レーン自身の
  ささら**の輪郭（段鼻を結ぶ勾配線から`STEEL_STRINGER_DEPTH_MM`ぶん下げた`stringerPrimitives`）を
  DETAIL（細線）で重ねて描く（ユーザー指示「ささらの見えかがりは細線、断面は太線」は維持）。
  さらに視線前方にもう一方のレーン（他レーン）があり、往復間に見えがかり壁（cutAlong/wall）が
  無ければ、その**他レーンの近い側（こちら向き）のささら**も同じDETAILの輪郭で重ねて描く
  （`contribution.secondaryFlights`。seq2のみ設定——seq4は視線が外壁側で他レーンを見ないため
  不要）。壁があれば`isBlockedByWall`（`columns`のband種別と切断線からの距離で判定）が遮り描かない。
- **正面視（切断面がFlightに直交＝レーンを横切る）**: ささら自体が切断されるため、両側（acrossLo側・
  acrossHi側。LANE_GAPが往路・復路間にあれば内側のみ半分ぶん詰める＝梯子と同じ幅を使う）に
  `STEEL_STRINGER_THICKNESS_MM`×`STEEL_STRINGER_DEPTH_MM`の断面矩形（`flightStringerFrontPrimitives`）を
  CUT（太線）で描く（ユーザー指示「断面は太線」）。z位置はcut位置での勾配線上の高さ
  （`flightElevationAt`。継続的な直線補間）で、`baseFloorZ`より下に出る部分は`emitLine`の§5.6最終フィルタで
  自動的にDETAIL＋破線へ降格する（他の要素と同じ機構）。
- 木造（`structure!==STEEL`）は変化なし（ささら無し・段部のジグザグをそのまま描く）。

**踊り場回りのささらの連続表現（ユーザー実機フィードバック2026-08-23）**: 踊り場桁枠のうちside辺
（走行軸に平行＝直進部のささらと同じ位置関係で連続する辺）は、`landing.z`基準の帯ではなく
「踊り場床断面線+巾木高さ」を上端、そこから`landingFrameDepthMm`(300)下げた線を下端とする帯で描く
（`RoomFinish.baseboardHeight`を`parseBaseboardHeightMm`で解釈。未設定・解釈不能ならASSUMED既定値
`DEFAULT_BASEBOARD_HEIGHT`='h=60'＝60mmへフォールバック）。flight（直進部）側の端には縦の閉じ線を
描かない——直進部のささら自身がその位置に輪郭を持つため、続けて描くことで見た目上連続した1本の帯に
見える。踊り場床断面線（CUT。`landingCutPrimitives`）自体は変更しない（上下に細線の水平線が加わる形）。
front/back辺（走行軸に直交）の帯は`landing.z`基準のまま変更しない。

**1層＝1溶接ユニット（StairUnit）**: 鉄骨階段は「両側ささら＋踊り場周囲の桁枠＋上下FLでの躯体取り合い」を1つの溶接ユニットとして扱う（実機の納まり）。`stairContribution`が返す`unit`（板厚12mm・ささら成300mm・踊り場桁枠成300mm＝ささらと同値・`anchorZs`＝躯体と取り合う高さ`[0, floorHeight]+踊り場z`の単一情報源）を`landingFramePrimitives`/`clipStringerToAnchors`が共有する。ささらの点列（段鼻ジグザグ由来）は`clipStringerToAnchors`で始端・終端のyを`anchorZs`（登り口FL・下り口FL）ちょうどへ強制する——ジグザグ生成側の実装詳細に依存せず「ささらは必ずFLで水平に終わる」契約を独立に守る。**踊り場桁枠**（`landing.frame.edges`。front=レーンに接する側／back=反対／side=走行軸に平行な残り2辺）は鉄骨・RC造階段（`hasLandingFrame`）が対象——RC階段はプレート状のささらは持たないが受け梁のコンクリート桁枠は持つため、桁枠だけささらと独立にSTEEL/RC両方が対象になる。側面視・正面視のどちら向きで見るか（broadside=帯輪郭／end-on=断面矩形）は「cut.lineの向きが辺の向きと一致=lengthwise、不一致=crosses」という第2層の一般規則をそのまま踊り場全体に適用して決める（§3.2表）。

**階段下に部屋があるか・ないかで踊り場下の表現が変わる**（ユーザー実機指摘2026-08「階段・踊り場下の
描画方法は、下に部屋がある・なしで異なる。現時点の描画は下に部屋がある場合」）: `switchbackCuts`が
`underFloorZ`（＝部屋あり:`landingAbs` / 部屋なし:0）を1箇所で決め、**cutの`baseFloorZ`と帯の
floorSegmentsの床**の両方がこれを使う。この2つを同じ値にするだけで、実機指示の
「1FL断面線を描画」（z=0が基準床になり§5.6の破線降格が起きなくなる）と「左右の壁断面線を1FLまで
延長」（`buildFaceFigure`の面端縦線は区間の床から立つ）が自動的に満たされる——専用の描画分岐は持たない。
踊り場自体の線は階段寄与（`landingCutPrimitives`等）が描くため床を下げても失われない。
判定は`cellsBeyondBreak`×`stairUnderRoomsOf`（仕上げモードの階段下壁生成と同じ単一情報源）へ委譲し、
**判定不能なら「部屋あり」へ倒す**——U字構造として認識できない構成等で、判定できないだけの階段まで
描画が変わるのを避けるため。

**構造梁の加算レイヤ（`section/sectionStructure.js`。WP-C）**: 踊り場受け梁（`structural-model.md`「踊り場受け梁」節）を含む構造梁を、第3層（階段幾何）と並ぶ別の寄与源として展開図へ足す。`cut.layers`（自階・上階のgraph参照＋floorZMm）の各`graph.beams`をそのまま拾い、`topZ=floorZMm+beam.levelOffset`で高さを決める——構造梁は「その梁が実際に立つ階のgraph」に帰属するため、伏図と同じ帰属をそのまま展開図の高さへ投影するだけで正しい階の梁が正しい高さに出る。切断線と直交＝断面矩形（CUT太線）、平行かつ幅の帯内＝上端・下端・両端縦線（DETAIL細線）——階段のささら・踊り場桁枠と同じ「cut.lineとの向き関係」の一般規則。**遮蔽はしない**（純粋な加算レイヤ。レイキャストの塞ぎ判定には参加しない。defer）。baseFloorZより下・天井より上は`emitLine`の既存フィルタで自動的に細破線へ降格する（新規の破線判定は持たない）。`elevationStairSequence.js`の`contentForCut`から`stairPrimitivesForCut`と並べて1回呼ぶだけで配線される——`sectionEngine.js`の`buildSectionFigure`（STRAIGHT/STRAIGHT_LANDING系）には配線していない（スコープ外）。

**ゴールデンゲート**: 通常部屋帯（`buildRoomBand`）・吹抜け帯（`buildVoidBand`）はエンジン導入の影響を一切受けない
（`elevationSectionGolden.test.js`が出力プリミティブの正規化JSON完全一致で固定・常に緑必須）。階段帯は一般規則を
優先し、手書き出力との一致度は問わない——ただしユーザーが実機で確認した意味論（歩行順1〜5・見返りの梯子破線・
往復間の壁の断面・アキXの配置・B/D面の鏡像関係・2FLの中線・CH寸法の2FL分割・踊り場床CUT線など）は
`elevationStairSequence.test.js`の意味論アサーション（座標の逐一一致ではなく「〜な線が存在する」「順序関係」）が
保存する——落ちたときにユーザーが実機で見て困る変化かどうかが仕分けの基準。

**帯の縦CH寸法線を2FLで分割**: `layoutBandFaces`（`elevationBand.js`）のi===0（帯先頭面）ブロックに`faceOverride`
経由の`chDimSplitAbsYs?:number[]`（分割する絶対高さの配列。床基準・正=床上）フックがある。未指定時（既定）は
現行どおり1本のまま。SWITCHBACKのseq1（歩行順シーケンスの先頭=帯先頭面）は`chDimSplitAbsYs:[floorHeight]`
（=2FL）を設定し、結果として左CH寸法が「踊り場床→2FL」「2FL→2F天井」の2本になる。

**腰壁越しに向こう側の床・天井断面線を壁位置で打ち切るフック（defer解決・§7 D2）**: `buildFaceFigure`に
`ctx.floorSpanX?:{lo,hi}`（既定=現行の`drawnX0`/`drawnXRun`。未指定時は出力不変＝ゴールデンゲートで担保）を
追加した。往復間の壁・踊り場壁が腰壁のときseq2/4系へ値を供給する配線は実機確認前提のため今回は未接続
（フック自体は`elevationStair.js`の`faceOverride`が透過する準備済み）。

**dirSignは部屋のコンパス向きではなく階段自身の歩行方向から導出する（`reorientFace`。QA実機フィードバック修正）**:
`classifyFaces`が返す`wEntry`/`wLanding`/`wOut1`/`wOut2`（延いては`cut.dirSign`）は素のままだと`composeRoomFaces`の
A/B/C/D向き（部屋の絶対的な世界座標の向き）で決まり、「上り口→踊り場が図の左→右」という階段の歩行方向とは
無関係——部屋の向き次第で一致も不一致もありうる（テスト用の矩形室では偶然一致し不具合が長らく検出されなかった）。
`switchbackCuts.js`/`straightCuts.js`は`reorientFace(face, desiredDirSign)`で全ての面をこの歩行方向基準へ
明示的に再正規化してから使う——`desiredDirSign`はwEntry/wLanding=幅方向(s=0→s=1)、wOut1(seq2)=走行方向
(上り口t=0→踊り場t=tRun)、wOut2(seq4)=SWITCHBACKはseq2の鏡像・STRAIGHTはseq2と同一、から独立に導出する。
floorSegments/ceilingProfile（face基準）とcontent（cut.dirSign基準）の両方が同じ基準になるよう、必ず両方に
同じ`desiredDirSign`を使うこと（片方だけ直すと左右が食い違う）。
**階段帯の展開記号は`cut.viewSign`（視線の向き）だけで決まる**（`letterOf(cut.line.isVertical, -cut.viewSign)`。
`viewSign`は視線が向く世界方向＝`isSightlineShape`の契約「見えがかり候補はlineから+viewSign側」なので、
面の規約`letterOf(isVertical, inward)`へは符号を反転して渡す）。ユーザー実機指摘2026-08:
「「6」B2：Dが正解。先のDは往路階段で切断して…このDは、復路階段で切断して、「5」D1と同面の壁を見ている」。
**dirSignから引いてはいけない**——dirSignは歩行方向で決まる**作図順**であって視線ではなく、
seq2とseq5は同じ`towardS1`（同じ向きを見る）なのにdirSignが違うため別記号になっていた
（seq4だけが`towardS0`＝逆向きでB）。一度dirSign基準（`letterForDirSign`）で実装して実機で否定された経緯。
**階段の展開記号が階段ごとに変わるのはこの逆引きの結果であり、例外規則ではない**（「のぼり方で作図順が
決まる」）。labelは`stairFaceSequence`の末尾で`labelFaces`により**歩行順**に採番し直す——部屋のコンパス順で
採番済みのlabel（B1/B2…）を持ち込むとreorient後のletterと食い違う。合成面（`buildMidWallFace`）にも
letter/labelを持たせる（旧実装はundefinedで、その帯だけ展開記号が出なかった）。SWITCHBACKのseq4は往路(outbound)の鏡像
（`stairCut`は`flights[0]`）であり復路(inbound)ではない——踊り場側が低く上り口側が高くなる復路をそのまま
描くと「左から右へ下る」という実機の見え方と矛盾するため。

**stairContributionのacrossLo/acrossHiもflipを反映する（QA実機フィードバック修正R2）**: `sectionStair.js`の
`stairContribution`は往路(outbound)・復路(inbound)のacrossLo/acrossHiを`stair.flip`を無視して
`roomBounds`から直接求めていたため（`makeFrame`の`acrossAt(s)`はflip===trueでs反転(ss=1-s)するが、旧実装は
それを反映しない別経路だった）、flip===trueの実機データでは往路の梯子・ジグザグが幅方向で逆側に描かれた。
`f.pt(0,s)`（switchbackCuts.jsの`acrossCoordAt`と同じ導出）でs=0/s=1の世界座標を直接求めてから
outbound/inboundのacrossLo/acrossHiを組み立てる——`reorientFace`と同種の「向きに関する値は必ずmakeFrame
経由で導出し、部屋のbounds等から直接計算しない」という不変条件を明文化する。

**階段の断面ジグザグの向こうに見える壁の輪郭線は後処理で除去する（QA実機フィードバック修正R2）**:
レイキャスト（`probeColumn`/`emitColumns`）は壁・開口の位置しか知らず、階段自体（段板・ささら）の占有形状を
知らないため、壁が無い（またはレーンの延長上に部屋自身の壁がある）実機構成では、seq2/seq4のレーン区間で
「階段の向こうに見える壁」のz=0(設置階FL)の輪郭線が、断面ジグザグと無関係に全幅で描かれてしまう。
`elevationStairSequence.js`の`contentForCut`が`clipWallFloorEdgeUnderZigzag`で、断面ジグザグ
（`stairPrimitivesForCut`が返すpolylineのx範囲）と重なるz=0の壁縁線を後処理として取り除く——
レイキャスト自体を階段形状で塞ぐ一般化（本質的な解決）ではなく、既知の症状（z=0の水平線）に限定した
対症療法である点に注意（蹴上に面材がある場合の遮蔽全般はモデル拡張が必要・別途defer）。

**意図的差分（設計判断として保持）**: 往復間の壁・踊り場壁の断面表現は塗り矩形(rect)から3線（天井際CUT水平線＋
両端CUT縦線の輪郭のみ）へ変更した。SWITCHBACKのseq1/seq3は同一の踊り場前縁切断線W(tRun,0→1)を共有する
（wLandingを「距離のある見えがかり候補」として一般規則から自然に検出させるため）。seq1の壁2縁の線種（旧手書き仕様「wallZone側=太・
ladderZone側=中」という位置基準）は一般規則（§5.6: 縁が接する側がopenならCUT・塞がれていればSILHOUETTE）に
置換した——実機構成（往路・復路レーン上に2F床が無く、往復間の壁の向こう側が2F吹抜け＝open）では一般規則から
同じ見た目（開いた側の縁=CUT）が自動再現される。対称に両側とも塞がれた構成（2F側に床がある）では両縁とも
SILHOUETTEになる。

**修正済み**: `buildMidWallFace`（合成面）の`lo/hi`は`loWorld/hiWorld`の大小関係に関わらず（呼び出し側は歩行方向の
都合で渡すため`travelSign<0`だと`loWorld>hiWorld`になりうる）、`elevationFaceList.js`の断片化レシピと同じ
`Math.min/max`で正規化する（対応するCLId=`startCLId/endCLId`も入れ替える）。旧実装は未ソートのまま代入しており
`run`が負値になるバグがあった。

巾木初期値（`木製出幅木`/`h=60`）は**ユーザーがRoomを新規作成する経路でのみ**適用する（`applyDefaultBaseboard`）。
`RoomFinish`コンストラクタでは設定しない——復元経路は「新しいRoomを作ってから空でないフィールドだけ上書きする」実装のため、
既定値を非空にするとクリア済み`''`が復元のたびに巻き戻る。展開側は`parseBaseboardHeightMm`が`"h=<数値>"`表記だけ解釈し、
解釈不能なら非描画。床まで達する開口の区間は巾木線を途切れさせる。**巾木は床の段差にも追従する**——床断面線（区間水平線＋段差縦線）を
hだけ上へそのまま平行移動した連続ポリラインとして描く（水平方向にはオフセットしない。段差縦線を開口がまたぐ場合は床側同様に途切れさせる）。

**実機フィードバック第3弾（鉄骨階段）の一連の修正**: いずれも`.claude/elevation-model.md`本節の
2.5D断面エンジン（`app/src/elevation/section/`）を対象とする。根本原因はA2（他は全てA2の周辺・派生）。

- **A2（根本原因）: 見えがかり壁のz上限は「上階に実Roomがあるか」で決める**。`sectionProbe.js`の
  `probeColumn`が`kind:'wall'`候補のz上限を、常に自層（self）の視線方向所有RoomのCHで無条件に
  切っていたため、上が吹抜け（上階に実Room=VOID/STAIR_VOID以外が無い）でも1F天井高さの水平
  キャップ線が誤って出ていた。`resolveWallCapZ`が、selfレイヤーの壁候補についてのみ、壁の実位置
  （axisCL.effectiveValue×worldMid。probeOwnerRoomと同じ`-viewSign*PROBE_EPS_MM`オフセットで
  境界セルの不安定性を回避）でabove層を1点プローブし、実Room（`isRealRoom`。VOID/STAIR_VOID以外）
  があれば従来どおり自層CHでキャップ、無ければabove層の天井（無ければ`cut.zRange.hiZ`）まで
  拡張する。above/belowレイヤー自身の壁候補・cutAlong/cut（切断壁）は対象外（壁自身のkneeDrop/
  実存在範囲のまま）。この拡張により同一の壁がabove層のfloorZ/ceilZ由来の余分なzBreaksで
  内部分割されることがあるため、`mergeAdjacentZBands`（z方向の隣接band併合。x方向の
  `mergeColumns`と対）で実体（kind/wall参照/distMm/layerRole等）が同じ隣接band同士を1本へ戻す
  ——ただし`cut.baseFloorZ`の境界だけは併合しない（emitLineの§5.6最終フィルタが
  「band全体がbaseFloorZ以下か」で降格を決めるため、そこを併合すると「下側だけ破線」が
  再現できなくなる）。
- **B: ささらのオフセット後多角形をFLでクリップ**。`stringerPrimitives`（elevationStairSection.js）の
  段鼻を結ぶ直線からのオフセットは、flightがz=baseZ(登り口FL)始まりの場合、オフセット先の頂点が
  FLを超えて突き出すことがある（法線が下方向＝FL側を向くため）。`zBounds:{yLo,yHi}`（省略時は
  挙動不変）を追加し、Sutherland–Hodgman法の単純な半平面クリップ（`clipPolygonToYRange`/
  `clipHalfPlaneY`）でz=baseZ・z=baseZ+steps×riserの水平面を超えないよう切る。呼び出し側
  （`sectionStair.js`）は`flightZBounds(flight)`（`clipStringerToAnchors`と共有する単一情報源）を
  各stringerPrimitives呼び出しへ渡す。
- **C: emitLineにneverDowngradeオプションを追加（リード裁定で契約変更を承認）**。
  `emitLine(cut,x1,z1,x2,z2,role,{neverDowngrade})`——既定false（既存呼び出しは無変更）。trueは
  §5.6最終フィルタ（baseFloorZ以下/天井断面より上→DETAIL+dashedへ強制降格）を丸ごと無効化し、
  渡されたrole・dashをそのまま使う。**CUT断面**（ささら12×300矩形=`stringerRectLines`・踊り場床
  CUT線=`landingCutPrimitives`・踊り場桁の見返り矩形=`landingFramePrimitives`のend-on分岐）は
  neverDowngrade:trueでbaseFloorZより下でも太線実線のまま。**ささらの見えがかり帯**
  （`landingFramePrimitives`のbroadside分岐＝踊り場桁枠のside/front/back帯）も同様に
  neverDowngrade:trueで細線実線のまま（`stringerPrimitives`自体は元々rawなpolylineでemitLineを
  経由しないため元から降格対象外）。**降格が残るのは踏面梯子（正面視。`flightLadderPrimitives`が
  `flight.baseZ<cut.baseFloorZ`のとき明示的にdash指定）と壁断面の見えがかり（一般規則の
  'wall'/'cut'/'cutAlong'。sectionEmit.js）だけ**、という裁定。
- **D: ささらの外側(壁側)〜壁の空きにアキX**。`stairWallGapZones`（sectionStair.js。新規export）が、
  crossesFlightする各flightについて、ladderAcross（LANE_GAP調整済み。isSteel=falseはflight自身の
  境界をそのまま使う）の「室の真の外縁trueAcrossLo/Hiに一致する側」だけをcut.line.lo/hi（壁）と
  比較し、`WALL_GAP_MIN_MM`（=150。ASSUMED既定値）を明確に上回る差があれば空き区間を返す
  ——`stairContribution`のroomBounds由来acrossLo/Hi（生のCL境界）とcut.line.lo/hi（壁仕上げ面へ
  スナップ済み）は階段が室の全幅を占める通常構成でも半壁厚ぶんズレるため（既存の
  `computeFlightZigzagPoints`コメント参照）、閾値未満は無視する。`elevationStairSequence.js`の
  `wallGapXMarks`が、seq1エントリでこのゾーンへ`cut.baseFloorZ`で上下分割したアキX
  （上=一点鎖線dash:'center'・下=破線。emitOpenGapMarksと同じ様式）を明示的に合成する
  （ceilLowAbs=1F天井はsectionStair.js側では未知の値のためelevationStairSequence.js側で受け取る）。
- **E: 踊り場より下まで達するレーンにささらの端面（縦の細破線）**。`sectionStair.js`の
  `stringerEndCapPrimitives`は、`crossesFlight`かつ`flight.baseZ<cut.baseFloorZ`（このレーンが
  見返りの基準床=踊り場より下まで達する）の場合、そのレーンのacrossLo/acrossHi
  （LANE_GAP調整済みladderAcross）にz=flight.baseZ〜min(cut.baseFloorZ, flight.baseZ+steps×riser)の
  縦線を追加する——emitLineの通常の§5.6最終フィルタで両端ともbaseFloorZ以下になるため自動的に
  DETAIL+dashedになる（neverDowngrade指定は不要）。STEEL限定。seq1では往路(outbound.baseZ=0)は
  該当・復路(inbound.baseZ=landingAbs=cut.baseFloorZ)は非該当になり、「往路梯子限定」という
  実機指示をこの条件だけで自然に満たす。
- **F: 2F腰壁（往復間の壁がkneeDrop.knee指定）はseq1で上端水平線のみ・両端縦線なし**。
  一般規則（'cut'kind＝両端の縦線2本のみ描く。水平の上端線は無し）を、seq1に限り
  `kneeWallCapContent`（elevationStairSequence.js。post-hocでcontentを書き換える）が専用表現へ
  差し替える: z=floorHeight〜floorHeight+topHeightちょうどの縦線2本（'cut'kindの両端縁）を検出・
  除去し、その上端(topZ)にCUT水平線を1本足す。腰壁の上（topZ〜2F天井）と横（腰壁の無い側）の
  L字アキは、既存のアキX（dash:'center'の対角線ペア）のうちz範囲がtopZ〜ceilTopAbsと重なり
  x範囲が壁のどちらかの辺に隣接するものを探して1組の大きなXへ合成する（無ければ壁自身の
  x範囲だけで1組描く。ASSUMED: raw columns情報はcontentForCutの外へ出てこないため、生のbands
  同士の厳密な連結成分計算ではなく、生成済みプリミティブ同士のpost-hoc吸収で実装した）。
- **G: 2FL水平線（above層の床端=slab/open境界）は上階に実Roomが無ければ描かない**。
  `sectionProbe.js`の`probeColumn`は「self天井より上でabove層に所有Roomがあるか」を
  `above.room`の有無だけで判定していたため、above.roomがVOID/STAIR_VOID（実床の無いRoom）でも
  'slab'（非描画の実床構造）とみなし、emitColumnsの「slab⇄openの境界=2FL水平線
  （SILHOUETTE）」規則が誤って発火していた。A2の`resolveWallCapZ`と同じ判定基準を
  `isRealRoom(room)`（VOID/STAIR_VOID以外）として共有ヘルパ化し、`above.room`の判定にも適用する
  ——above.roomがVOID/STAIR_VOIDなら'open'（アキX判定の対象）として扱う。

## 展開図では断面の中は描画しない（ユーザー明示指示2026-08）
描けるのは**床断面線と天井断面線に挟まれた範囲**だけで、天井の向こう（天井裏・上階の躯体）には
何も描かない。実機「5」A面の左3200エリア（1階天井断面・2階X2壁断面・2階天井断面で区切られる外）に
2階の壁断面や天井裏の見えがかりが出ていた根本原因は、**断面エンジンが`ceilZ`を帯に1つ（帯の天井）
しか持たず、列ごとに打ち切っていなかったこと**——天井断面の高さは区間ごとに違う（吹抜けの区間だけ
上階天井まで上がる）。

**唯一の例外: 天端または下端が露出した切断壁（腰壁・垂れ壁。`isKneeDrop`）は打ち切らない**
（ユーザー承認2026-08・案A）——露出した縁は吹抜け側の空間に面していて実際に見えるため、天井の
向こうにあっても断面を描く（実機「5」D1の「2階Y1から2000＝2FL+800の腰壁断面」が消えていた）。
判定は`sectionProbe.js`の`isKneeDropRange`（その壁のz範囲が層の床天井いっぱいでないか）で、
腰壁（天端が露出）と垂れ壁（下端が露出）を1つの規則で覆う。**見えがかり（'wall'）には例外を
適用しない**——腰壁でも天井の向こうにあれば見えない。**床側には打ち切り自体が無い**ため同じ問題は
起きない（区間の床＝`floorDeltaMm`より下を落とす仕組みは未実装。入れると「床断面下の細破線＝
またぐ面」の確定仕様と衝突するため、指示があるまで入れない）。

**天井の有無をエンジン側で推測してはいけない**（層の実Room有無から導くと階段帯の見え方まで変わる）。
**天井断面線を実際に引いている値そのもの**を`cut.ceilProfile`（区間ごとの`{loX,hiX,ceilZ}`）として
呼び出し側から受け取り、`buildColumns`が列を打ち切る。区間の境界は必ず列の境界にする
（またぐ列は中点で1つの天井しか持てず片側が誤って切られる）。`ceilProfile`未指定の呼び出し側
（階段帯）は従来どおり打ち切らない。`emitColumns`のFL/CH判定も`col.ceilZ`を優先する。

## 線種は「断面か／どの奥行きか」だけで決まる（ユーザー明示指示2026-08）
**切断壁の縁は常に太線（CUT）。降格しない。** 旧規則「縁が接する側がアキならCUT・塞がれていれば
SILHOUETTE」（AMBIGUITY B）は撤回した——断面は隣に何が見えていようと断面であり、線種が隣接列の
状態で変わってはいけない。**その他の見えがかりは奥行きで2段**: その切断で最も手前＝直近が中線
（SILHOUETTE）、それより奥は細線（DETAIL）。「直近」は列ごとではなく**その切断（＝その1枚の図）
全体**で決める（`nearestSightlineDistMm`）——列ごとに最小を取ると、奥まった凹みもその列では最前面
なので中線になり、面の中で奥行きの表現が失われる。

**見えがかり線が存在するのは「仮想断面からの距離が変わるところ」だけ**（同指摘）——同じ距離が
続く境界は1枚の連続面で線は無い。距離が変わる境界は**手前の面がその輪郭を持つ**（`ownsBoundary`。
両方が描くと同じ位置に線種の違う線が2本出る）。相手がアキ・床スラブ・範囲外なら、その面の輪郭として
こちらが描く。**天井から上階FLまで（天井裏）にある面も「壁」扱いする**（同指摘の点4。
`resolveSightlineTopZ`が見えがかり壁の上限を自層の天井ではなく**上階のFL**にする）——これで
「CHの上が天井裏なら同じ壁が同じ距離で続く」ため、上の一般規則だけで**CHに見えがかり線が立たない**
（＝断面線のみ）が導かれ、CH専用の例外を持たずに済む。逆に「CH下がアキ・上が壁」は距離が変わるので
見えがかり線が出る。**FLと帯自身のCHには見えがかりの水平線を描かない**（同指摘）——床・天井はその位置に断面線
（太線）を持っており、壁がそこに接する線を重ねると同じ場所に2本出る。FLは層の属性なので
「帯自身のFL・各層のFL・床スラブのFL」を集めるが、**CHは帯自身が描く天井（`emitCtx.ceilZ`）だけ**
——帯の上端より上はモデルに無いため一般規則が使えず、ここだけは明示的に落とす。区間ごとの天井は
点4の「天井裏も壁」で自動的に処理されるので、CHを層スタックから集める必要は無い。

落とし穴: **切断壁の手前にある境界へ見えがかりの凹み側面線を重ねない**。壁は切断壁の裏へ続いており
凹んでいないので、境界の縦線は切断壁自身の断面縁が描く（水平線側は`trimmedByCutWall`が同じ理由で
既に抑止していた）。従来この重複は**線種が同じゆえに`dedupeLines`で消えていた**だけで、線種を
分けた瞬間に表面化した——偶然の重複除去に頼らず「描かない理由」の側で決めること。

## 仮想断面線をどこへ置くか（`section/sectionCutPlane.js`。ユーザー明示指示2026-08）
**規則: 描画対象の面の壁の中心線から、室内側（`face.inward`方向）へ下がる。** 下がる量は
「その面の壁の中心線→壁仕上げ面」「その面に現れる柱型の室内側への出」「面の前の造作家具の出
（ドメインモデル未実装＝defer。フックのみ）」の最大値を1mm単位で切り上げ。**多層帯は全ての層に
ついて同じ評価を行い最大を採る**（「6」A: 2階のX2/X3と1階のX2左3200/X3の両方を見る）——層ごとに
面の走り範囲も壁厚も違うため、自階だけ見ると上階の柱型に切断面が食い込む。

**これが「「6」は正しく「5」は誤った出力」の根本原因だった**: 階段帯は切断線をレーン位置＝室の中に
置く一方、吹抜けの多層帯は面自身の壁芯ちょうどに置いていた。切断面が壁の中を通ると
(a)見えがかり候補が全て室外の壁になり`withinViewRoom`に落ち、(b)所有Roomの1点プローブが室の外へ
落ちて`room=null`になり床スラブ・天井懐の分類ごと消える——面が丸ごと`open`（何も抽出されない）に
なる。`sectionCutPlaneExtraction.test.js`が offset=0 と正規のオフセットを並べてこの症状を凍結する。

`faceCutLine`は`lo/hi/dirSign`を動かさない（断面ローカルxと面ローカルxが同値である
`sectionTypes.js`の不変条件を保つ）。面の軸CLは`line.faceAxisValue`として別に残す——切断線が面の軸から
離れると「その面の壁と接続した柱か」のような**面の軸との照合**（`sectionStructure.js`）が
`line.axisValue`では成り立たなくなるため。視線の符号は`faceViewSign`（=-inward）が唯一の定義
（過去に経路ごとに符号が食い違った）。

## 切断1本→contentの共通経路（`section/sectionContent.js`）
階段帯と吹抜けの多層帯は「切断を1本立てて断面エンジンへ渡す」同じ処理なのに別々に手で組み立てて
いたため、**階段帯にはあるものが吹抜け帯には無い**という差が静かに溜まっていた（探査延長・端の
凹み側面線の抑制・アキのバツが吹抜け帯には丸ごと無かった）。`buildCutContent`を唯一の入口にし、
**ここへ足した修正は階段にも吹抜けにも同時に効く**状態を不変条件とする。タイプ固有の処理
（階段のささら・遮蔽、構造材の加算レイヤ）は返り値の部品に対して呼び出し側が後段で行う——
共通経路にタイプ固有の分岐を持ち込まない、が境界。

## 層スタックの一般規則（`section/sectionLayerStack.js`。多層化2026-08）
断面エンジンの`SectionCut.layers`は「どの階のgraphを絶対zのどこへ置くか」の並びでしかないのに、
`sectionProbe.js`は長らくそれをrole名（'self'/'above'/'below'）と**配列順**で引いていた
（`find(role==='above')`／`find(role!=='self' && floorZMm<=z)`／固定のROLE_ORDER表）。2層固定なら
偶然正しく、3層以上で静かに壊れる——「多層の展開図で固定条件のままでは希望どおりに出ない・修正が
他の図面にも効くのか判定できない」の構造的な原因。**層に関する問いは`sectionLayerStack.js`の
4つの一般規則（所有層`layerOwningZ`／帯自身の階`baseLayerOf`／上位層`layersAboveOf`／優先順位
`compareLayerPriority`）だけで答え、role文字列は`ZBand.layerRole`（`sectionEmit.js`が隣接列の
同一性判定に使う識別子）としてのみ残す**——意味を持つのは並び（floorZMm）であって名前ではない。

帯自身の階を「role==='self'」ではなく**z原点に最も近い層**として定義できるのは、`sectionTypes.js`の
契約「高さは絶対z・設置階FL=0基準」があるため（この契約を崩すとbaseLayerOfの定義も崩れる）。
見えがかり壁のz上限（実機フィードバック第3弾A2）も、**層の役割にも段数にも依存しない規則**
「実Roomに出会うまで上へ登り、その手前の層の天井を上限にする」（`resolveSightlineTopZ`）へ一般化した。

**「修正が他の図面にも効くか」は個別の期待値ではなく不変条件で担保する**
（`sectionProbeMultiLayer.test.js`）: (INV1)bandsはzRangeを隙間・重なりなく覆う、
(INV2)**`cut.layers`の並び順を変えても結果が完全に一致する**、(INV3)同じ入力の再プローブは同じ結果。
INV2は「役割名にも配列順にも依存していない」ことの実行可能な証明であり、層まわりの新しい分岐を
入れた瞬間に落ちる——層の判断をここへ足すときは、まずこの3本を通すこと。

## 2.5D立体の加算レイヤ（全展開図共通。`elevationSolids.js`。追加仕様2026-08）
「2.5D展開を階段・吹抜けだけでなく全ての展開図へ」への回答は、**`buildFaceFigure`を断面エンジン
（`section/sectionEngine.js`）へ置き換えることではなく、階段帯で確立済みの「純粋な加算レイヤ」
（`sectionStructure.js`。遮蔽判定に参加せずレイキャストを持たない）を通常面へ広げること**とした
——`buildFaceFigure`は段差プロファイル・開放スパン・注記帯・巾木・建具姿図・壁2段書き等の確定仕様の
集積であり`elevationSectionGolden.test.js`で凍結されている。目的（柱・梁型・作り付け家具の断面）は
加算レイヤだけで満たせるため、置き換えのリスクを負う理由が無い。**吹抜け帯・階段帯はこれまでどおり
2.5D非対応でも2.5Dでもない専用経路**（吹抜け=自階の面を下へ延長／階段=断面エンジン）である点は不変。

`faceSectionCut`が face を SectionCut へ写す（`(isVertical, axisCL.value, lo, hi)`がCutLineと同型・
`cutOriginWorld`が`face.originWorld`と一致するため、断面ローカルxと面ローカルxが同値になる＝面の
座標系のまま合成できる）。高さ基準は帯そのもの（baseFloorZ=0・zRange=0..CH）で、layersは自階
（floorZMm=0）＋上階（floorZMm=階高）。**帯のz範囲へクリップすることが「梁型だけが出る」という
建築的に正しい挙動をそのまま与える**——自階graphの床梁（天端=自FL）は床より下で全消し、上階graphの
梁は天端=階高のため梁成が「階高−CH」を超えて天井から降りる分だけ残る。副次的に、床より下の細破線が
注記帯（tag行・ROW1/ROW2・通り芯丸）へ被る問題も原理的に起きない。x方向は`[0, run]`へクランプする
（構造材はCL間の実スパンを持ち、面間ギャップはこの加算レイヤ分を見込んでいないため）。

**柱型**（`structuralColumnPrimitivesForCut`）は見付け幅の両端縦線2本（CUT）だけを描き、上下端の
水平線は持たない——`StructuralColumn.topLevel`は既定0のまま実データでは未編集（高さの信頼できる
情報源が無い）一方、柱は床から天井まで通しで立つのが常態のため、z範囲はcut.zRangeそのものを使う。
線種・向きの判定は梁と同じ一般規則（切断線と直交=断面CUT／平行かつ幅の帯内=輪郭DETAIL）に従う。

**柱は仕上げ材で覆った外形で描く**（追加仕様2026-08。幾何は`finish/columnWrap.js`＝**展開図の柱型と
平面図の柱が共有する単一の情報源**。構造と仕上げの境界にある値のためどちらか片方の層に埋めない
——別々に算出すると同じ柱が図面ごとに違う太さになる。平面は`ColumnsLayer`の`finishWrap`で包み外形を
細線で重ねる。構造モードの伏図には渡さない＝躯体の図に仕上げは載せない）。柱の外形は
①カタログ断面 ②鋼管柱のダイヤフラム出（`diaphragmProjection`。構造モードの平面描画・断面図・梁端の
停止位置と**同一実装を共有**する。出寸法の調整口は`sectionCatalog.js`の`DIAPHRAGM_PROJECTION_MM`
1箇所）③仕上げの包み、の3層。包みは**4面それぞれ独立**に決まる（柱と壁の位置関係は面ごとに違うため
対称ではない）——ユーザー指示2026-08の3規約:
1. **柱は原則、仕上げ材で覆う**（壁と干渉する柱に限らない）。厚みはその面に**向き合う**壁の
   「下地材＋壁仕上げ材」。**壁自身の`backingRange`/`wallFinish`から取り、部屋の内装マスターを
   `materialMap`から引き直さない**（実装方針6。壁はその部屋のマスターから生成された結果なので、
   引き直すと同じ厚みに二系統の情報源ができる。寸法を持たない手動壁は0＝覆わない）。
   **⚠仕上げのみの薄壁（`backingRange===null`）は、同じ軸CL上でスパンが重なるオーナー壁から下地厚を
   採る**（`wallBackingMm`。実機フィードバック修正2026-08「柱周りに壁下地材がない」）——部屋境界の壁は
   下地オーナー壁＋仕上げ薄壁のペアで下地はオーナー側だけが持ち（`wallGeneration.js`「下地オーナー
   解決」）、柱に面するのは薄壁の側。薄壁だけを見ると下地0になり包みが仕上げ12.5mmへ潰れる。
2. **覆った柱の表面と内壁仕上げの隙間が`TRIM_GAP_MM`(150)以下ならそこでトリム**＝包みを壁の仕上げ面
   まで伸ばして揃える（狭い隙間は塞いで壁と一体に納める）。この面は壁と**接続した**ものとして扱い、
   展開図はその壁の面に柱型を出す。150を超えて離れた面は接続しない＝その面には柱型を出さない。
3. **壁内は下地材・壁仕上げ材ともになし**＝柱の面が壁の材厚の中にあるなら、その面は覆わない。

壁埋まり判定（前掲）は**包む前**の外形で行う＝壁に完全に納まる柱は覆いも描画もしない。
ASSUMED: 共有壁の両側で内装マスターが違う場合、その面に最も近い壁の層構成を採る。

**平面図の柱と壁の取り合い**（ユーザー指示2026-08）: 柱断面は太線（`ColumnsLayer`の`finishWrap`が
輪郭を`thick`にする）。柱壁は外形（仕上げ面）＋仕上げ／下地の境界線の2層で、**壁と同じ線の太さ**
（medium）で描く（層順は柱＝フランジ含む→下地材→仕上げ材。`finishes`＝面ごとの仕上げ厚、残りが下地）。
**トリムで壁に接続した辺は、外形・境界線とも柱側で描かない**——その位置には壁の同じ層の線が続いており、
描くと重なるうえ境界線が柱を一周して見える（ユーザー実機指摘2026-08「壁仕上げ線2本の内、柱側の1本が
柱を一周している」）。**壁側は`columnWallCuts`が返す区間を落とす**（`ShapesLayer`が既存のT字取り合い
`finishCuts`と同じ`subtractIntervals`へ合流させる＝切り欠きの仕組みを二系統にしない）。
**⚠区間は層ごとに違う**——仕上げ面線は柱壁の**外形幅**、仕上げ境界線と下地（間柱）は**内側境界の幅**
（外形−仕上げ厚×2）。同じ区間で両方を切ると、壁のfin線の端が柱側の境界線の端と食い違う。
この対応で「壁の面線→柱壁の外形」「壁のfin線→柱壁の内側境界」がそれぞれ1本に連続する。
**⚠下地の削除だけは「その下地に乗る仕上げ材が他に残っていないこと」を条件にする**（`canRemoveBacking`。
ユーザー指示2026-08）——オーナー壁の下地帯は**両側の部屋の仕上げ材**が乗る共有の下地で、柱は壁の
片側にしか出っ張らない。柱側の仕上げだけを柱壁が置き換えても反対側の部屋の仕上げは残るため、下地を
消すとその壁が宙に浮く。同じ軸CL上でスパンが重なる仕上げ材が1枚でも柱に接していなければ残す
（判定は壁単位。区間単位まで細かくしない割り切り）。

**⚠柱がどの面に現れるかは「接続した壁の軸CL（`wallAxes`）と面の軸CLの照合」で決める。柱の断面が
切断線（面の壁芯CL）をまたぐかで判定してはいけない**（実機フィードバック修正2026-08「平面で柱芯を
動かしても展開に表れない」の根本原因）——実データの壁は下地オーナー壁＋仕上げ薄壁方式のため
**材厚が壁芯から数十mm室内側にある**（実機ログ: 面の壁芯 -7000 に対し壁の材厚[-6955,-6942.5]）。
さらに柱芯オフセット（ラーメン系では常態）で柱は壁からわずかに離れて立つ（同ログ: 隙間42.5mm）。
この2つが重なると、壁のすぐ内側に立つ柱＝まさに覆う対象が**一本残らず描画から落ちる**（実機8本
すべて）。**壁と接続している柱はその壁の面に現れる**——これが柱と面を結ぶ本来の関係で、壁芯を跨ぐかは
実データでは成り立たない代理条件だった。接続＝上記規約2のトリム（150以下）または壁への食い込み。
壁を持たない位置の柱は従来どおり断面が切断線をまたぐかで拾う（フォールバック）。`wallAxes`は覆い厚0の
壁（寸法の判らない手動壁）でも積む——描くかどうかは「接続しているか」で決まり、覆えるかとは独立。
どちらも成り立たない柱は描かない（面より手前に立つ独立柱の見えがかりは defer のまま）。
**線種は中線**（SILHOUETTE。ユーザー指示2026-08）——柱型は切断面ではなく「室内へ出っ張った仕上げ面の
見えがかり」であり、床線・天井線と同じ太線では強すぎる。

**壁の材厚に埋まる梁・柱は描かない**（ユーザー実機指摘2026-08「2階床の構造材梁断面は、壁の中なら
描画しない」。**柱も同じ規則**——通り芯の交点には自動補完で柱が立つため、外壁に納まる管柱まで
柱型にすると連続した壁面の途中に実在しない縦線2本が出る＝実機「C2のX2上のエッジ線」の正体。
壁より太い柱は室内へ出るので従来どおり柱型として描く）。厚み方向は完全に収まることを要求し（壁より太い梁は室内へ現れるため隠さない）、
**スパン方向は壁厚ぶんの食い違いを許容する**——梁はCL間を張るのに対し壁は隅で`chamferWalls`が
半壁厚ほど詰めるため、完全被覆を要求するとこの規則が実データで一度も発動しない（実際そう作り込んで
検出した）。それを大きく超えて伸びる梁は端が見えるので隠さない。

**基礎・基礎梁・杭は描かない**（追加仕様2026-08）。`structuralContribution`/
`structuralColumnContribution`が`role==='foundation'`を除外する唯一の情報源——1平面に基礎伏図＋
1階伏図の2スロットが乗る（`App.jsx`）ため1階のgraph.beamsには基礎梁と1階梁が同居しており、除外
しないと室内展開図の床下に基礎梁が細破線で出る。基礎・柱脚（footingMap）・べた基礎（slab
role:'mat_foundation'）は本レイヤが`graph.beams`/`graph.columns`しか読まないため元から対象外。

**有効化は`ctx.solids`の明示指定のみ**（`ElevationModeState`→`buildRoomBand`だけが渡す。既定=未指定で
出力完全不変＝ゴールデンゲートで担保）。**階段帯には渡さない**——階段帯は`contentForCut`経由で既に
同じ`sectionStructure.js`から構造梁を描いており、重ねると二重描画になる。吹抜け帯も対象外（帯FLと
断面の床が一致しない特殊な高さ基準のため）。defer: 作り付け家具（ドメインモデル自体が未実装）・
独立柱／面より手前の立体の見えがかり・遮蔽（加算レイヤの原則どおり取らない）・斜め回転柱の見付け幅。

## 面端の不変条件・壁2段書き
面端の縦線（見えがかりエッジ）は`x=0`/`run`（`face.lo/hi`＝直交壁の仕上げ面。`snapFaceEndsToCorners`の隅詰め結果）に描く——
壁中心線（`faceBoundaryLocalX`の`boundary.lo/hi`。ROW1壁芯間寸法・通り芯一点鎖線が使う別の基準）とは異なる、既に正しい基準
（QA調査で再確認・回帰テストで固定）。面端は「壁のない端部」と「出隅」を区別する。**壁のない端部**（`snapFaceEndsToCorners`が付与する
`hasWallAtLocal0`/`hasWallAtLocalRun`がfalse）は「続きがある」建築表現として床線・天井線を`WALL_LESS_END_EXTEND_SCREEN_MM`（2パス換算）
ぶん図の外側へ延長し、縦線は描かない。
**この延長は図形側（`buildFaceFigure`の`drawnX0`/`drawnXRun`）だけでなくcontent（2.5D断面のレイキャスト）側にも効く**
（ユーザー実機指摘2026-08「6」D「2FL床断面まで下りる、再度3500左CLの外へ延長して終わる」）。
**方式はユーザー裁定でA案＝「出来上がった線を後から引き伸ばす」のではなく「探査範囲そのものを外へ広げる」**。
階段帯は`buildStairBand`→`stairFaceSequence`が`wallLessEndExtendModelMm`（図形側へ渡すのと同じ`ctx`の値。倍率決定の
1パス目は`DEFAULT_WALL_LESS_END_EXTEND_MM`）を`withProbeExtension`へ流し、`hasWallAtLocal0`/`Run`がfalseの側だけ
`cut.line.probeExtendLoMm`/`probeExtendHiMm`（**world側の**lo/hi。ローカルx=0がどちらのworld端かは`dirSign`で決まる）を立てる。
`collectCutBreaks`はその広げた範囲で断点を集め、**面の端（`line.lo`/`line.hi`）自体も列境界として必ず残す**（面の内と外が
1列に融合しないため）。`cut.line.lo/hi`は変えない＝`cutOriginWorld`（x=0の起点）が動かないので既存のローカルx座標はずれない。
`emitColumns`側には延長処理を**置かない**（両方やると二重に伸びる。回帰ガードは`sectionEmit.test.js`の「【裁定A案】」）。
線を後から引き伸ばす旧案を採らなかった理由: 面の外は探査されていないため、腰壁の**外側面の位置（＝壁厚）**が
そもそも分からず、指摘どおりのZ字プロファイル（1F天井→立上り→天端→壁厚ぶん外→2FL床→外へ延長）を組めなかった
（列ダンプで`cut[z3000..3800]`が`x0..57.5`＝内側半分にクリップされていることを確認済み）。A案適用後は同じ帯が
`x-57.5..57.5`＝全幅115で出て、隣室の`slab[z2400..3000]`（＝1F天井断面線・2FL床断面線）も実データとして現れる。

**壁のない端部の2層取り合い**（実機「6」D。左CL上に腰壁が載り、上階の床スラブがそのCLで終わる構成）は
以下の3規則で「1F天井→腰壁の立上り→天端→壁厚ぶん外→2FL床→外へ延長」というZ字プロファイルになる:
- **上階床スラブの端に切断壁（袖壁・腰壁）が載っている取り合い**は`slabEdgeCutWallJunction`が組む。
  スラブは吹抜けの開口縁（CL）で終わるが、袖壁はそのCLに芯を合わせて左右へ張り出す。作図は
  「下階天井(`slab.z0`) → **袖壁の向こう側＝階段側の面** → そこを**上へ立ち上げて**上階床(`slab.z1`)へ」
  とつなぎ、袖壁の断面線と交点で取り合わせる。**この立上りが要**（ユーザー指摘「1FL天井から2FL床までの
  上へ向かう線分がないことを指摘している」）——無いと天井線が壁の面で宙に終わり、「トリムされていない」
  状態になる。
- **背景側の水平線は手前の切断壁の断面線でトリムする**（`trimmedByCutWall`）。その列に`cut`帯があり、
  水平線が**その壁の天端以下**なら列ごとの縁は描かない（上の取り合い線が代わりに1本で通す）。天端より上
  （袖壁の上を通る上階天井など）は壁に遮られないので対象外。上階床側（`slab.z1`＝2FL床）はこのトリムが
  効いて壁の手前で止まる——指摘の「2FL床断面まで下りる、再度CLの外へ延長して終わる」どおり壁の下は通らない。
  *試して却下した案2つ*: ①「壁の向こう側の面まで伸ばすだけ」（立上りを描かない）→ 線が宙で終わり
  「トリムされていない」と指摘された。②「手前の面で止める」→ 今度は「CLの外で止まっている」と指摘された。
  正解は**向こう側の面まで進めた上で、そこに立上りを描いて接合する**。
- **切断壁の天端は`cut`帯からCUT水平線を「壁ごとに1本」描く**（`cutWallTopEdges`。見えている天井より下で
  終わる壁＝腰壁・袖壁が対象。列は壁と無関係な断点でも割れるので列ごとに描くと複数本になる）。これに伴い
  `kneeWallCapContent`（seq1の往復間の壁）から天端の描画を**移管**した——両方で描くと2本になる。
  なお実機の袖壁は**Wallオブジェクト2枚**（壁は片面ずつのプレーンとして持つデータモデル）で構成されるため、
  天端も2本の線分が突き合わさった形で出る（見た目は1本）。
- **凹み側面線は同じ層(`layerRole`)の壁どうしでしか成立しない**。距離が変わっても層が違えば、1枚の壁面が
  凹んだのではなく**見えている壁が別の層のものへ入れ替わった**だけ（実機症状: 左CL上の`z3800..5400`に縦線）。

**切断壁（`cut`帯）の縦線は「同じ壁が隣接列に続くなら描かない」**（`band.wall`参照で同一性を判定。`cutAlong`の
端部縦線と同じパターン）。列は壁とは無関係な断点（CL・開口端・他層の壁）でも分割されるため、旧実装のように
列境界ごとに両縁を描くと**1枚の壁の断面の内部に分割線が出る**（実機「6」Dで腰壁の`x=0`・`x=45`に縦線が出ていた）。
両側に`wall`参照が載っている場合だけ抑止する（手書き列の単体テスト等は従来どおり）。
**出隅**（hasWallAtLocal0/hasWallAtLocalRunがtrue＝壁がある通常の面端。部屋の凸角で、視線方向に壁が折れて向こうへ続く角）は縦線を
SILHOUETTE（中線）で描く——切断面ではなく壁が折れて隣の面へ続くだけの見えがかりの角のため、CUT（太）は使わない（QA修正。床線・天井線・
段差の縦線・直交壁建具断面の枠は部屋の輪郭そのもの／明示指示に基づくためCUTのまま）。
**壁のない端部の判定基準は「隅に直交面が存在するか」ではなく「**その隅に**実壁(`graph.walls`)があり、かつその壁がこの面の切断面
（faceValueの平面）を室内側へ横切っているか」**（`realWallAtCorner`＋`perpWallCrossesFacePlane`。QA修正——閉じた部屋の
面ループでは隅に直交面自体は必ず存在するため、面の有無だけでは常にtrueになり発動しない）。
**実壁の有無は「隅の局所プローブ」で見る**（ユーザー実機指摘2026-08「比較的単純なプローブに思う。判定方法をよく確認してみて」）
——旧実装は直交面の**面全体**のフラグ（`hasRealWall`＝`innerWallFaceAt`が面のスパン全域で壁を1本でも見つけたか）を隅の判定に
流用しており、直交面の遠い側にだけ壁がある構成で「何も無い隅」に線が描かれていた（実機症状: 連続する外壁面がC1/C2に分かれ、
その継ぎ目に無いはずの縦線が出る）。`innerWallFaceAt`へ渡すスパンを**面の仕上げ面を挟む±100mmの窓**へ絞るだけでよい
（壁の同定・inward判定は既存関数のまま＝判定の二重管理を増やさない）。**窓は面の両側に取る**——「実壁が向こう側へ折れて続く角」
（見えがかりエッジ）を落とさないため。室内へ横切るか否かの区別は`perpWallCrossesFacePlane`の担当で、役割を混ぜない
（室内側だけの片側窓にすると確認済みのRound Fの3箇所がエッジごと消える。実装して回帰テストで検出した）。**横切り判定はユーザー明示指示2026-08**——実壁があっても、その壁が面の向こう側
だけにある端（L字の凹み角・上端短縮されたCLの壁が視点側の帯に無い等）は図の端部に壁断面が現れないため壁のない端部
（床・天井線を図の外側（実画面5mm）まで延長＝続きがある表現）として扱う。ただしこの端は**見えがかりエッジ**（`edgeAtLocal0/Run`）
——実壁が向こう側へ折れて続く角のエッジ自体は見えるため、延長に加えて端の縦線（中線=SILHOUETTE）も描く（直交面や実壁自体が無い端＝
階段上り口等は従来どおり縦線なし・延長のみ）。端座標は壁あり・エッジとも直交面のfaceValue（＝この面の壁の実端）へ詰める
（ユーザー確認2026-08: エッジ縦線・延長の起点は中心線位置ではなく壁の実端。これにより「隣接面は同じ隅を共有」の不変条件は
凹み角でも保たれる）。開放スパンの延長端（`elevationOpenSpan.js`の`resolveEnd`）も同じ規則で判定する。壁生成スキップで発動する
典型例は階段の上り口辺・下り口辺——`generateRoomWallsFromOutline`の`stairOpenings`引数（`finishBoundary.js`が`stairPortEdges`を渡す）で
その辺の壁生成自体がスキップされる。

**`buildRoomFaces`の隅マッチングは「同じaxisCLIdを持つ複数面」を区別する**（QA修正・根本原因）。張り出し（アルコーブ等）で1本の壁面が
開口を挟み2区間以上に分かれると、両区間とも同じaxisCLId（壁の通り位置そのもの）を持つ——単純な`Map<axisCLId,Face>`は後勝ちで片方が
消え、その面がchainに一切現れない「抽出漏れ」になる（張り出し脇の短い返し壁で典型的に発生）。`groupByAxisCLId`+`findCornerNeighbor`
（`elevationFaces.js`）が「同じ壁通りの複数区間」から、隅を実際に共有する1件（候補のstartCLId/endCLIdが自分自身のaxisCLIdと一致する
もの）だけを選ぶ。

壁2段書き（壁材・壁仕上げ材の2行）は表示専用に`formatMaterialLabel`で言い換える（「せっこうボード」→「PB」、`t=<数値>`→`ア)<数値>`。
材マスター自体は変更しない）。位置は原則、面の壁中心線区間の中心・天井高の中央(`-CH/2`)。開口・アキ・段差縦線と重なる場合は
`avoidObstacleRangesX`（`avoidGridCollisionX`と同系の最広ギャップ方式。障害物が区間を持つ点だけが違う）で最も広い空き区間へ退避する
（巾木は面のほぼ全幅を覆うため対象外）。壁中心線間の描画長さがラベル幅の概算×2未満なら描画自体を省略する（倍率決定用の1パス目は
scale未確定のため省略判定を行わない）。**テキスト幅概算は文字クラス別**（`estimateWallLabelWidthPx`。半角ASCII=0.5×fontSize・
全角(CJK等)=1.0×fontSize）——変換後ラベルは半角主体になるため、全角一律の概算だと幅を過大評価し通常サイズの面でも過剰に省略される
（QA G1）。

隣接面の間隔（`gapModelMm`）は、右CH寸法（前述）に加え、面自身の壁のない端（`hasWallAtLocal0/hasWallAtLocalRun`）の延長ぶんも
加味する（`faceWallLessExtents`。`buildRoomBand`/`buildStairBand`が共有する純関数）——延長された床線・天井線が隣の面と実間隔を
詰めないようにするため（QA G2）。

## ビュー位置の階別記憶・建具パネル連携
`ElevationModeState`はモジュールレベルの`Map<floorId, {...}>`（セッション内のみ。IDB永続化なし）で階ごとのscrollY・faceScroll・
表示中の部屋を記憶し、同じ階への再突入（`dispose()`→`init()`）で復元する。記憶した部屋が消滅していれば、記憶時点で1つ前だった部屋
（`graph.rooms`順）の帯位置へフォールバックする。floorIdは構築時（`project.activePlane.id`）に一度だけキャプチャする——dispose()時点
では`project.activePlane`が既に次の階を指している場合があるため。

展開図の建具記号丸（`tag`プリミティブの`openingId`）はクリック可能——`ElevationModeState.selectedOpeningId`/`selectOpening()`は
`OpeningModeState`と同じAPI名にしてあり、建具モードの`OpeningPanel.jsx`をそのままelevationモード中（appModeは切り替えない）でも
再利用する。**パネル表示中も展開図のドラッグ・ホイールスクロールは自由に行える**（規制は一度入れたが撤廃した。QA修正）。
パネルでの編集はMobX reactionで`graph.openings`の各Openingの表示に効くフィールド（committed値。CLのようなpending/committed分離を
持たないため確定のたびに1回だけ発火）を監視し、変更があれば帯を全再構築して即時反映する。クリック対象は建具記号丸のみ
（姿図は現状複数の生プリミティブへ分解済みで個別の建具IDを持たないため対象外。defer）。

**面の描画範囲の外には断面を出さない**（`sectionTypes.js`の`cutDrawRange`が単一情報源。`cut.line.lo..hi`＋
壁のない端部の探査延長`probeExtendLo/HiMm`）。構造梁（`structuralPrimitivesForCut`。許容は梁の半幅＋
`halfWallThicknessMm`——梁はCLからCLまで張るのに切断線の範囲は仕上げ面基準で半壁厚内側に詰まっているため）と、
階段のCUT断面矩形（`stringerRectLines`＝ささら正面視・踊り場桁枠。完全に範囲外のときだけ落とす）の両方に効かせる。
実機症状: 面が`0..2885`なのに梁が`x=-6882.5`（約7m先の別スパン）、ささら・桁枠が`x=-57.5..-45.5`・
`x=2942.5..2954.5`（半壁厚ぶん外）に出ていた。梁側は元からdocコメントが「梁の位置が切断線の範囲内」を
契約としており、**実装だけが抜けていた**。

**アキのバツ**（`emitOpenGapMarks`）:
- **4点は空き面の実際の隅**（ユーザー実機指摘2026-08「6」C「バツの４点は、空き面の最も大きい対角を
  頂点とする」「2Fのアキ・バツ左下点は、左側壁断面と腰壁上端の交点へ移動」）。連結成分の外接矩形の
  隅は、成分がL字（腰壁が食い込む等）だとアキでない場所に落ちる——左右それぞれの端にあるセルの
  z範囲から、その端での実際の上下を取る（矩形なら外接矩形と一致＝挙動不変）。
- **腰壁と交差する区間はクリップ**（`obstructionRects`＋`subtractRectsFromLine`）。下の
  「腰壁（`isKneeDrop`）を単一の判別軸にする」参照。
- **手前に実体がある区間は破線**（`splitGapMarksByStair`＋`stairOccluderRects`）。**破線範囲は
  何かの基準線の左右では決まらない**（同指摘の撤回・再指示「想定したバツに対して描画面+所定距離まで
  レイキャストして、隠れた部分を破線にする」）——矩形は手前に実体がある範囲そのもので、対角線との
  重なりを取るだけ。*却下した規則*: 「内側のささらより右（z全域）」を対角線ごとに割り当てる案
  （ユーザーが撤回）。深さ方向の限定（「描画面+所定距離まで」）は、階段のflightが帯自身の部屋の
  中にしか存在せず描画面より手前であることが構成上保証されるため追加判定を持たない（ASSUMED）。

`stairOccluderRects`＝**階段の見付けシルエット**（flightの正面視bbox＋各landingの桁枠の帯）。
アキのバツ（`splitGapMarksByStair`）と見えがかり水平線（`dashHorizontalsBehindStair`）で同じ集合を使う。

**階段の断面プロファイルとの取り合い**（`joinToStairProfile`。ユーザー実機指摘2026-08「6」D2）:
下階天井の断面線は**階段断面と交わるxで終える**（旧はスラブ帯が切れる列境界で止まり、階段の手前で
宙に終わっていた）。上り切り（z=`floorHeight`）の点からは**上階床の断面線を近い側の描画端まで張り出す**。
どちらもプロファイルの実座標から求める（面やレーンの幾何を作図側で再構成しない）。
**下ささらの見えがかりは下階天井〜上階床の帯でカットする**（`clipStairDetailInSlabBand`）——その帯は
床構造の中で室内側から見えないため。**上ささらは見えるので残す**: ささらは上端・下端の2本1組で出るので、
x範囲が重なる相手より平均zが低い方だけを対象にする（同じ高さ＝重複出力は両方残す）。

**上階床スラブの断面線はスラブ自身から描く**（`slabEdgeCutWallJunction`。同指摘「6」D1「2F腰壁断面が
2FLまで下りたあと、左を向いて2FL床断面線はりだし」）。旧は「スラブの上に立つ遠い壁の下端縁」に頼って
おり、その壁が帯の部屋の外（d7250）で探索対象から外れた途端に線ごと消えた。

**踊り場桁枠のミトレ結合の下端は「交点から見て階段と反対側」を描く**（同指摘「6」B「踊り場の下ささら
見えがかりが描画されていない」）。旧は常に`[mitreX, hiX]`を描いており、階段がhi側にある構成では踊り場の
ほぼ全長が消えていた——交点は階段側の端の近くに来るので、`mitreX`がどちらの端に近いかで描く側を決める。
**踊り場桁枠の帯の基準は「踊り場面＋巾木」（`sideTop`）で統一する**（同指摘「6」A「上下にささらの
見えがかり（横線2本）」）。front/back辺だけ`landing.z`基準で、side辺と基準が割れていた。踊り場床の
断面線（CUT）は`landingCutPrimitives`が別に描くので重複しない。
**桁枠side辺のend-on断面矩形は面の内側へ寄せる**（同指摘「その左右壁との取り合いにささら断面」）——
辺は部屋の通り芯上にあり面の端より外へ出るため、そのままでは描画範囲チェックで丸ごと消えていた。

**構造材の断面形状は指定構造材に合わせる**（`sectionOutline`。同指摘「6」）。H形鋼はフランジ・ウェブの
実形状（12辺）、角形／丸形鋼管は外形＋肉厚ぶん内側の輪郭、矩形（木角材・RC）は外形4辺。RC丸柱は
プリミティブに円弧が無いため外接矩形のまま（既知の単純化。defer）。
**梁が「壁の中」かは切断位置の一点で判定する**（`isBeamInWallAt`）——実機の床梁は建物を貫いて走るため、
全スパンを1枚の壁が覆うことを要求する`isInsideWall`は一度も発動しない。断面は切断線と交わる一点で
描かれるのだから、判定もその位置で行う。
**室内を空中で横断する梁は天地2本をSILHOUETTE（中線）で描く**（同指摘「6」A「材が空中に横断している
ので、『A』に中線で鋼材の天地に線を描画」）。切断線と平行だが芯が離れている梁は、旧`parallel`判定
（切断線が梁の幅の帯を通ることを要求）に入らず一切描かれなかった。輪郭の縦線は持たせない。

**seq3（踊り場の壁）にも踊り場の寄与を渡す**（`landingOnly`。同指摘「6」A）。§6.1表の「階段寄与: なし」は
**段**の重ね描きの話で、踊り場の床断面線・桁枠は必要だった。あわせて`stairPrimitivesForCut`の
`stairIsVertical`は**flightsが空でも踊り場のside辺から取る**——切断線自身の向きへフォールバックすると
lengthwise/crossingの判定が反転し、踊り場の断面がほとんど出なくなる。
**seq5（D2）の面はwOut2の全長**（踊り場ぶんを含む）で、向きはseq2側（踊り場が右）、寄与は復路＋踊り場。
旧はレーン区間だけに切り詰めた面を使っており「Y2が3500の右」「踊場断面は図の右側・階段断面は左側」の
構図にならなかった。

**帯のRoomの包絡矩形は自階graphで一度だけ求めて全レイヤーで使う**（`cut.bandRoomBounds`）。層ごとの
graphで引き直すと上階レイヤーでは自階Roomのセルキーが解決できずbounds不定＝制限なしになる。

**「内側」の定義**（同指摘3）: 平面で折返し階段を見たときの内側＝**梯子状の壁断面が無い方の端**。
判定は`innerAcrossWorld`——部屋の実外縁(`trueAcrossLo/Hi`)と一致しない側が内側で、`ladderAcrossRange`が
LANE_GAPを片側だけ詰めるのと同じ基準（単一情報源）。**内側のささらの見えがかり**は正面視では一定xの
縦線1本で、往路は1FL〜踊り場、復路は踊り場〜2FL（＝`baseZ`〜`baseZ+steps*riserMm`）。既存の
`stringerEndCapPrimitives`（第3弾E）は「踊り場より下まで達するレーン」限定で両端に端面を描くもので
踊り場より上の復路には出なかったため、その契約は変えず`innerStringerSilhouette`で対象外レーンを補う。

**踊り場の床断面線は正面視でもCUT**（`landingCutPrimitives`。ユーザー実機指摘2026-08「6」C
「踊り場断面線を太線に」）。旧実装はレーン縦断のときしか描かず、正面視では踊り場桁枠front/back辺の
帯の上端（DETAIL細線）が踊り場床の高さに見えているだけだった。x範囲は走行方向ではなく
**across（壁から壁までの全幅）**（同指摘「踊場床断面と壁との取り合い…幅」）。桁枠front/back辺の
上端はこれと重複するので描かない（side辺と同じ扱い）。
**ささら正面視の断面矩形の上端は段鼻＋巾木高さ**（同指摘「両側のささら断面上端高さは、踊り場面+巾木」）
——側面視の裁定「ささらの上端は踏面先端で巾木同寸」と同じ基準に揃えた。

**往復間の壁の芯の一点鎖線**（`ctx.extraCenterLineXs`。ユーザー実機指摘2026-08「6」C「1500の一点鎖線が
出ていない」）。一点鎖線の源は「寸法の鎖の分割点」と「通り芯」の2つだけで、往復間の壁は切断線から見て
**面の裏側**へ伸びるため`collectRow1SplitPoints`の直交壁検出（面の仕上げ面へ到達し**室内側**へ
`PERP_MIN_PROJECTION_MM`以上突出する袖壁が対象）に掛からず、どちらの源にも現れなかった。
`stairFaceSequence`が`cutTable.wall`の芯を面に直交する面だけに載せ（面と平行なB/D側には出さない）、
`buildFaceFigure`が**一点鎖線だけを描く——寸法の鎖は分割しない**（以前「1500と1000の間のCLはどこから
きたのか」と指摘された寸法鎖への副作用を避けるため。線だけという明示指示に従う）。

**見えがかり壁の探索は帯自身の部屋の広がりまで**（`sectionProbe.js`の`withinViewRoom`。`cut.bandRoom`の
`roomBounds`包絡矩形に壁の手前側の面が入るか）。範囲外の壁は候補から落ち、その区間は`open`帯になるので
`emitOpenGapMarks`がアキ（一点鎖線のバツ）を描く。実機症状「6」C: 1F部分(z0..2400)が6m先の別室の壁(d6000)を
拾って見えがかり壁になり、ユーザー指摘の「3500の面を表す…四角にアキ・バツ」が出ていなかった。
*却下した判定2つ*: ①壁の手前の1点プローブで所有Roomが同一か→階段室から「階段下」室を見通すのは正常なので
全て消え、確認済みテストが落ちた。②視線方向の所有Roomの矩形→列ごとに部屋が入れ替わり狭い方で切ってしまう。
**帯のRoomは列によらず一定でなければならない**、が要点。

defer（未実装）: 傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・印刷/PDF・
SWITCHBACK以外の階段断面（WINDING/L_TURN/FLARED/OPEN_WELL）・展開図の建具「姿」クリックでのパネル連携（記号丸のみ対応）・
他階の建具の2層帯への描画（吹抜け帯の下階建具・階段帯の上階建具）。

**廃止した仕様: 最上階キャップ（`upperCeilCapped`）**。「上階が最上階（`floorHeightAbove`がnull）かつ上階Roomの
CHが非明示（`isFallback`）なら往路上の天井を1F天井高さ（`ceilLowAbs`）で水平にキャップする」という分岐を
`elevationStair.js`／`switchbackCuts.js`／`elevationStairSequence.js`から**完全に削除した**（ユーザー実機指摘2026-08
「6」D「2FL天井断面線は、3500左CLの外へ延長して終わる」）。成立条件が弱い推測（元から設計メモにASSUMEDと明記）で、
実機（floorHeight=3000／chLower=2400／chUpper絶対5400）ではキャップが発動して1F天井が階段室の上まで貫通し、
**同じ面のcontent（レイキャストが描く2F天井5400）と食い違っていた**。天井は常に`chUpperAbsMm`に揃える
（他の描画も既に`chUpperAbsMm`基準で、そちらと一貫する）。回帰テストは`elevationStair.test.js`の
「【最上階キャップ廃止】」——旧キャップの発動条件そのもの（3階目なしのproject＋CH未指定のVOID Room）で
天井が`chUpperAbs`まで上がることを確認する。

**レーン面の天井は「上階に実床があるか」の実測が唯一の情報源**（`buildLaneFloorAndCeiling`＋`aboveRoomSegmentsOnFace`）。
`aboveLayer`があれば面に沿って区間ごとに上階のRoom（VOID/STAIR_VOIDは実床無しとして除外）を1点プローブし、
**床あり＝1F天井高さ`ceilLowAbs`／床なし（吹抜け）＝上階天井`ceilTopAbs`**を割り当てて`stepCeilingProfile`で段にする。
呼び出し側が渡す勾配天井リテラル（上り口側`ceilLowAbs`→踊り場側`ceilTopAbs`へ斜めに開く表現）は
**`aboveLayer`が無く判定できないときだけ**のフォールバック。
旧実装は「実Room有無がface全体で一様なら実測を捨ててフォールバックへ戻す」短絡も持っていたが
（コード上も「挙動不変のASSUMED判断」と明記）、ユーザー実機指摘2026-08「6」D／B1で誤りと判明したため削除した——
実機の階段室は往路面の全長にわたって上階に床が無く（列ダンプでseq2の全列が`wall`/`cut`のみ、`slab`無し）
「一様」と判定されるため、測れているのに勾配になり、上階天井の断面線が壁のない端まで届かなかった
（`PL[-285,2400 → 0,2400 → 2442.5,5400 → 3442.5,5400]`）。一様でも実測どおり水平に割り当てるのが正しい。

## 面リストの合成（composeRoomFaces）・段差見付け面・ROW1寸法のCL分割
`buildRoomFaces`（壁面ループ・隅共有不変条件）は変更せず、その上に新レイヤ`elevationFaceList.js`の`composeRoomFaces()`を
面リストの唯一の供給源として重ねる（`buildRoomBand`/`buildStairBand`は`buildRoomFaces`ではなくこちらを呼ぶ）。合成順は
「袖壁・腰壁の面分割 → 段差見付け面の挿入 → `labelFaces`再採番」で固定——段差見付け面の挿入位置判定は分割済みの面配列を
前提にする。段差見付け面（`kind:'step'`）を挟んでも実質的な隣接関係は変わらないため、`prevFace`/`nextFace`の取得は
`neighborWallFace(faces, i, dir)`（`kind!=='step'`の最初の面を返す）を使う。

**段差見付け面（`elevationStepFace.js`）**: 部分指定の子Roomが親の壁際に接する箇所（`wallAdjacentFloorSegments`が担当）とは別に、
**壁の無い部屋内部**の境界でFLが異なる区間には「段差の見えがかり（見付け）」を専用の面として挿入する。`stepRiserSegments`が
親Room自身の未指定セル＋各部分指定の子をFLごとにグループ化し（`refreshCells`→owner索引）、各グループの外形
（`finish/gridCells.js`の`cellBoundsList`→`outlineSegments`）から「自分より低い隣に接する区間」だけを抽出する
（相手FL>=自分のFLは重複排除で捨てる＝低い側からは生成しない）。`buildStepFaces`が通常面と同じ`letterOf`/`DIR_SIGN`規則で
面オブジェクト化し（`lo`/`hi`は両端の直交壁面の`faceValue`へ詰める。届かなければCL値のまま）、`insertStepFaces`が
「見付け面の始点を含む壁面Wの直後」へ挿入する（Wが無ければ末尾）。`buildFaceFigure`は`kind==='step'`を早期分岐し、
低い側床線・両端縦線（壁断面）・天井線をCUTで、高い側床線（見付け上端。段差の向こうの床の見えがかり）を
SILHOUETTE（中線）で描き（**問題修正2026-08その6: 天井断面は帯CHではなく低い側エリア自身の天井=`ceilAbsMm`
（低い側FL＋低い側の解決済みCH。`stepRiserSegments`が`lowOwnerRoom`を持ち回る）**——見付け面は低い側エリアを
見込む展開図（実機の「C1」=3の展開図）のため。高い側エリアの天井`beyondCeilAbsMm`が断面より上なら細線の破線で
重ねる=「C1の天井断面上+100に3'の天井を表す破線」。`ceilAbsMm`未指定の合成faceは帯CHへフォールバック）（QA修正・ユーザー明示指示2026-08: 両端縦線は実際に切断される壁の断面のためCUT、
見付け上端は見えがかりの線のため中線——旧実装は誤って全部CUTにしていた）、見付け上端〜天井には常に
アキ（`appendGapMark`。x=0..run・y=-CH..topY。腰壁・垂れ壁の穴と共用）を乗せる（QA修正・
ユーザー明示指示2026-08その4: 段差見付け面を新設したコミット5f8ec62の時点から、腰壁・垂れ壁の
明示指定がある軸だけ`kneeDropGapsOnFace`経由でアキを描く実装しか無く、指定の無い通常の段差
見付け面ではアキが一切描かれない欠落があった——本節冒頭の説明どおり「上部にアキを乗せる」が
実装に反映されていなかった、後続のどのラウンドの変更にも起因しない当初からの欠落）。
開口・巾木・壁2段書きはスキップし、注記帯（ROW1/ROW2/面ラベル）は
`appendAnnotationRows`で通常面と共通合流する。両端縦線は`floorY`（低い側床）から天井(`-CH`)まで
描く（QA修正・ユーザー明示指示2026-08その3: 旧実装は`topY`＝見付け上端で止めていたため天井まで
届かない縦線になっていた——見付け上端はあくまで見えがかり線で、壁自体は天井まで続くため）。

**ROW1寸法のCL分割（`elevationDimSplit.js`）**: ROW1（壁芯間寸法）は`boundary.lo`〜`hi`を1本で通すのではなく、
`collectRow1SplitPoints`が集める3源（段差CL=`floorSegments[i].hiCLId`／面へ到達する直交壁=`perpendicularWallsOnFace(face,graph,'far')`
のaxisCL／面に届く非通り芯中心線）で分割した「寸法の鎖」にする。通り芯（labeled）はROW2と二重になるため対象外。
分割点は`boundary.lo/hi`ちょうど（±`SPLIT_MERGE_EPS_MM`=1）を除外し、通り芯と同位置の一点鎖線は重複させない。

**段差位置のCLオフセット（`elevationFloorProfile.js`）**: `wallAdjacentFloorSegments`のsegsは境界CLの実id
（`loCLId`/`hiCLId`。ローカルx反転時は入れ替えて引き継ぐ）を持つ。段差の**描画位置**（区間水平床線の端x・段差縦線x・巾木・
壁2段書きの障害物区間の4箇所）は、寸法・CL一点鎖線が使う`segs[i].hiX`（オフセット前）そのものではなく、`drawnRiserX(segs,i,halfWallMm)`
が返す「床が低い側へ半壁厚(`halfWallThicknessMm(face)`)だけずらした位置」を使う——寸法線・CL一点鎖線と段差の実描画位置を
意図的に別の値として持つ設計（両者が同じ線に重なって見づらくなるのを避ける）。

**袖壁・腰壁の面分割（`elevationFaceList.js`の`splitFacesAtPartitionWalls(faces, room, graph)`）実装済み**——
`perpendicularWallsOnFace(face, graph, 'near')`が返す袖壁を面のローカルx（昇順・`SPLIT_MERGE_EPS_MM`以内は併合）で並べ、
面を断片化する（`kind:'step'`の見付け面は対象外のまま素通り）。各断片は元面のフィールドを継承しつつ、分割端だけ
`startCLId/endCLId`=袖壁CLのid（隣接断片が同じCLを参照する＝`faceBoundaryLocalX`基準の境界が厳密に一致）・
`lo/hi`=袖壁の仕上げ面（`Wall.materialRange`の該当端。断片は自分自身の`originWorld`を`dirSign>0?lo:hi`で持ち直す＝
各断片が独立したローカル座標系(x=0起点)を持つ点に注意）・`hasWallAtLocal0/Run`=false（既存の「壁のない端部」処理＝
床天井延長＋端の縦線なしをそのまま流用）・`partitionCutAtLocal0/Run`={thicknessMm, topHeightMm|null}
（`kneeDropRecordFor`。`graph.kneeDropWalls`をaxisCLId一致＋スパン重なりで直読み。腰壁指定が無ければnull=天井まで）
へ差し替える。`buildFaceFigure`は`partitionCutAtLocal0/Run`があれば分割端に`thicknessMm`幅・`0..-(topHeightMm??CH)`の
CUT枠rectを重ねる。

Round Fフィクスチャ（`.claude`配下の設計メモ・引き継ぎ参照）は`generateRoomWallsFromOutline`由来の外周壁24本のみで
自立壁（`isRoomWall`/`isExteriorWall`とも false の袖壁候補）を1本も含まないため、本仕様の効果は確認できていない
（`splitFacesAtPartitionWalls`自体は専用の実壁フィクスチャ（`elevationFaceList.test.js`）で分割・境界一致・幅合計不変・
腰壁高さ・失敗系（未到達・突出不足）を検証済み）。

## 開放スパン（elevationOpenSpan.js）— 完成・配線済み
面の範囲を「壁のあるアウトラインエッジ」から「同一axisCL平面上でnear側に自室セルが連続する最大区間」へ拡張する仕組み
（D1/B1のような「壁区間＋壁のない開放区間を1枚の連続面として描く」表現）。`composeRoomFaces`に配線済み
（順序: `buildRoomFaces`→`extendFacesWithOpenSpans`→`splitFacesAtPartitionWalls`＋`clipSpans`→`insertStepFaces`→
`filter(run>=MIN_FACE_RUN_MM)`→`labelFaces`）。

**座標系（意図的な混在。統一しない）**: 既存の二重管理規約（描画x=仕上げ面基準、寸法x=CL基準。仕様4参照）をそのまま
適用する——**描画**（床線・あき・エッジ縦線の位置）は実壁の隅=仕上げ面スナップ・壁のない内部境界=生CL値、
**寸法（ROW1）**はboundary（面の壁芯間）とS4分割点（`spans[i].hiCLX`=CL位置）で構成する。このためD1の描画run
（実測1285=342.5+942.5）とROW1の合計（1000+400=1400）は一致しない——これは既存仕様どおりの意図的な差である。

**抽出**（`extendFaceWithOpenSpans`/`extendFacesWithOpenSpans`/`clipSpans`）: room自身の登録セル（`refreshCells`。
extent解決は`worldToCell`に委譲し再実装しない）のうち面のnear側に接するもの全件を列挙し、各セルのfar側を1点
プローブしてwall/open分類する（**微小刻みでface.lo/hiの外側へプローブする方式は、直交壁の厚み帯の内側を誤って
「壁あり」と拾い続けるため採用しない**——実際にこの不具合を作り込み・発見・破棄した）。面自身の「既知区間」
（face.lo/hi。実壁の隅で確定済み）を含む連続クラスタだけを採用し、延長した端だけ`perpFaceAt`で隅スナップする。
延長していない端は元のhasWallAtLocal0/Runをそのまま引き継ぐ（stairOpenings等、開放スパンと無関係な理由で元々
falseだった面を誤ってtrueへ書き換えない）。**QA修正**: `dirSign<0`の面はworld順とlocal順が反転するため、
`spans[i].hiCLId`（内部境界のCL id）・「末尾（面端そのもの）はhiCLId=null」の判定は、ソート後のlocal順配列で
行う必要がある（world順のまま判定すると誤った区間にhiCLIdが付き、ROW1に余計な分割点が出る不具合を実際に
作り込み・発見・修正した）。

**QA修正（実機不具合。room2/room3が同時に成立しない不具合）**: 3件の根本原因を特定・修正した。
1. **他室区間を挟んだ延長の誤爆**: `collectNearCellSegments`はroom自身が所有するセル区間だけを列挙するため、
   他室が間に挟まる箇所は配列上の要素そのものが欠落する（隣接インデックスでも値としては不連続）。従来は
   「配列上ownIdxの前後を無条件に取り込む」実装だったため、他室領域を飛び越えて延長し、spansに他室領域ぶんの
   穴（他室区間ぶんのopen/wallどちらの分類も付かない欠落区間）が空いていた。修正: `runHi===次のrunLo`で実際に
   連続している範囲だけを延長対象にする（不連続ならそこで止める）。
2. **見付け面の残差**: `subtractOpenSpanCoverage`のriserはセル輪郭の生CL値基準、matchingFacesの`lo/hi`は実壁の
   隅で仕上げ面基準にスナップされた値——両者は壁厚みぶん（数十mm）ズレることがあり、riserがmatchingFacesの
   描画範囲を壁厚み分はみ出す残差（対応する面がそもそも描かれない位置）がopen区間の外側にごく僅かな幅の
   見付け面として残っていた。修正: 差し引き前にriserをmatchingFacesの合計描画範囲（lo/hiの和集合）へ丸める。
3. **粗いセル境界での1点プローブ誤分類**: `collectNearCellSegments`は自室の登録セル1件につきfar側を1点だけ
   プローブする。自室側のセル境界がfar側の部屋境界より粗い場合（例: extentLo/Hiで範囲制限されたCLが自室側の
   行では有効域外にあり分割されない。Round Fの中心2＝室内側の行では無効・far側の行では有効、という構成）、
   1点プローブでは区間全体（複数の他室にまたがりうる）を1つのkindへ丸ごと誤分類してしまう。修正:
   `elevationStepFace.js`の`collectAxisBreaks`と同じ考え方でrunの伸びる方向のCLで刻み、区間ごとに個別
   プローブする（`collectRunBreaks`/`findRunCLAt`）。
これら3件は独立した規則の誤りだが、いずれも「開放スパンの区間境界の同定」という同じ土台の不備に由来し、
room2/room3のどちらか一方だけを直すと他方が壊れる対症療法にはならない（3件とも同定ロジック自体の修正のため）。

**描画**（`buildFaceFigure`のspans処理）: 通常面の床線・天井線・両端縦線の直後にopen区間ごと処理する。
1. 遠側床線: `nearDeltaAt(x)`（floorSegmentsからxを含む区間のfloorDeltaMmを返す共通ヘルパ）で求めた近側の
   床yと、`farFloorDeltaMm`が異なる場合だけSILHOUETTE水平線を追加する——Phase1の`wallAdjacentFloorSegments`
   near側修正により、多くの場合floorSegments自体が既にopen区間と同じ高さのCUT線を描いているため、この分岐は
   「floorSegmentsが（何らかの理由で）追従できていない場合の保険」として働く（重複描画は起きない）。
2. 上部あき: `appendGapMark`（腰壁＋垂れ壁のアキと共用）で天井から近側床（見上げ方向は遠側床）
   までの矩形を描く。**ただし開放スパンが「壁のない端部」に接している場合は描かない**
   （ユーザー実機指摘2026-08「5」C2）——その端は床線・天井線の延長で既に「続きがある」ことを
   表しており、同じ場所へアキを重ねると二重表現になる。加えて`appendGapMark`は矩形（中線の輪郭）も
   積むため、その辺が面端ちょうどに縦線として現れ、実機では「通り芯上のエッジ線」に見えていた
   ——**エッジ線とアキ・バツは別々の不具合ではなく、この1個のアキ標記が正体だった**
   （見えがかりエッジでも柱型でもない。全面の診断ログで`e0/eR=F`・`solid=0`かつ`rect=med[x0w400]`と
   確定させた。以後この種の切り分けは推測ではなく`elevationDiag.js`で行うこと）。
   反対側が壁で閉じている開放スパン（室が自分自身へ回り込む内部の抜け等）は従来どおり描く
   ——実機の他の全ての開放スパンはこちらで、アキが壁のない端部に接するのは指摘のあった1面だけだった——見下ろし方向で遠側床まで伸ばすと、矩形外形の実線が床断面下の細破線
   （遠側床線・床下縦線）と同座標で重なり覆ってしまうため近側床でクランプする（QA指摘）。
   （QA修正・ユーザー差し戻し2026-08: 一度「アキ表現は開放スパンに不要」として全廃したが、
   指示範囲外の拡大解釈だったとして復元——アキ廃止は今後、明示指示がある場合のみ行う）。
3. 境界エッジ: open区間の両端のうち隣がwall側（区間 or 面端）ならSILHOUETTE縦線を引く。
**内部境界の描画xは「壁厚×1/2だけ開放側」**（`drawnSpanRanges`/`drawnSpanBoundaryX`。ユーザー実機
指摘2026-08の5例——5/C2の400CL=左・10/D1の400CL=右・10/C2の800CL=左・10/B2の1000CL=左・
11'/A2の1600の両側=外——はすべてこの1規則で説明できた）: 境界に立つ壁は中心線に対して厚みを持つため
**実際の抜けは壁の面から始まる**（CLで切ると開口を半壁厚ぶん広く描く）。「当該壁厚・偏芯を加味する」
ため決め打ちの半壁厚ではなく`innerWallFaceAt`で実壁の面（`Wall.axisValue`＝偏芯込み）を引き、
**境界に実壁が無ければオフセットしない**（決め打ちでフォールバックすると壁の無い境界まで一律に
ずれる。実装して既存テストで検出した）。**面端はずらさない**——`snapFaceEndsToCorners`が既に直交壁の
仕上げ面へ詰め済みで二重になる。床段差の`drawnRiserX`と同じ「描画位置と寸法位置を別に持つ」規約で、
寸法・CL一点鎖線はオフセット前の`spans[i].hiCLX`のまま。描画側とテストは`drawnSpanRanges`を共有する。
4. 巾木・壁2段書き障害物にopen区間を追加。`extendedAtLocal0/Run`端では隣接面由来の建具断面を描かない。

**見下ろし方向は破線（QA修正・ユーザー明示指示2026-08）**: 開放先(far側)の床がnear側より低い
（`farFloorDeltaMm < nearDelta`。見下ろす方向）場合、遠側床線・境界エッジの縦線を`dash:'dashed'`
にする（見上げる方向・同じ高さは従来通り実線）。ユーザーが特定の面（room3 A2）で明示指示した
形をそのまま一般規則化したもの——類似の他規則（面端の「壁のない端部」延長等）への拡張は
明示指示が無い限り行わない。
**床断面より下・天井断面より上の向こう側の断面は細線の破線（ユーザー明示指示2026-08その2）**:
床断面（near床線）より下に見える遠側床線は破線かつ**細線**（DETAIL。床〜天井の間に見える
見上げ方向の遠側床線は従来どおり中線の実線）。あわせて床断面〜far床の**端部の縦線**（境界エッジの
床下部分）も同じ細線の破線で継ぎ足し、端点をfar床線と厳密に一致させて破線同士の角が必ず交点で
接続するようにする（room3 A2の1200区間＝g領域の床断面下で明示指示）。天井断面より上の向こう側の
断面も同規則の対象——spansの`farCeilAbsMm`（開放先の天井絶対高さ。問題修正2026-08その2で実装）が
near天井断面より高ければ細線の破線＋端部縦線（near天井〜far天井。角=far天井側を始点）、低ければ
床〜天井の間の見えがかりとしてSILHOUETTE実線（中線）。アキ矩形の上端もfar天井が低い場合はそこまで
クランプする（床側の近側床クランプと対の規約）。

**段差床の抽出（`wallAdjacentFloorSegments`）欠測区間の誤フォールバック修正（QA修正・項目6）**:
自室セルの境界がface側で粗い（extent制限されたCLが該当行では無効域にあり分割されない）場合、
touching配列に欠測（cursor〜次のtouching.runLoの隙間）が生じる。従来はこの欠測区間を無条件で
「親扱い（floorDeltaMm:0）」にフォールバックしていたが、実際には部分指定の子が所有する区間まで
親扱いに丸めてしまい、本来存在しない極小の段差（子→親(極小)→子）が生まれていた
（elevationOpenSpan.jsのcollectNearCellSegmentsで既に修正済みの「粗いセル境界での1点プローブ
誤分類」と同根）。`probeGapOwners`（`collectRunBreaks`/`findRunCLAt`と共にelevationOpenSpan.jsから
elevationFloorProfile.jsへ統合・re-export）が欠測区間をrunの伸びる方向のCLで刻んで個別に
`worldToCell`プローブし、実際の所有Roomを求める——所有者が見つからない区間だけ従来通り親扱い。

**段差見付け面のROW1境界退化バグ修正（`elevationStepFace.js`のbuildStepFaces。QA修正・項目4）**:
`startCLId`/`endCLId`へ段差自身のaxisCL.id（面に直交する軸＝両端で同じ値）を両端とも詰めていたため、
`faceBoundaryLocalX`（startCLId/endCLIdの位置差でROW1境界を求める）が同一CLの差=0という
退化した幅0の境界を返していた。通常面と同じ規約（startCLIdは世界座標loを・endCLIdは世界座標hiを
決めるCLのid）に合わせ、両端の直交壁面（`perpFaceAt`で求めたloFace/hiFace）自身のaxisCL.idを使う。

**段差見付け面との相互排除**（`elevationStepFace.js`の`subtractOpenSpanCoverage`）: `stepRiserSegments`の候補
から、同一`(isVertical, axisCL.value, inward)`の面のopenスパンが覆う区間を差し引く。差し引いた残りが
`MIN_FACE_RUN_MM`未満なら捨てる。D1/B1のような「面平面上の段差」はopenスパン側が表現を担い、独立した段差見付け面
（重複表現）にはならない。面平面の外（同一軸の面が存在しない内部段差）は従来どおり独立した見付け面のまま。

**延長する端の取捨（問題修正2026-08その8/その9。ユーザー期待図「2階22」・明示指示「A案＝出口側の隅だけが担う。
情報を全く持っていないところ（アキ・バツだけ）が描画延長の1/4を超えたら延長しない」）**: `extendFaceWithOpenSpans`は
連続する区間を貪欲に取り込んだあと、**端の区間**を次の順で取捨する。落とした端は従来どおり「壁断面のない端部」
（床・天井線を図の外へ延長して続きを示す表現）で終わる。
1. `informative`な区間は常に残す——`collectNearCellSegments`がnear/far双方の所有Roomの実効FL・解決済みCHを比べて
   立てるフラグで、差があれば遠側床線・遠側天井線という**実体**が現れる（差が無ければ描かれるのはアキだけ）。
   この例外が無いとRound Fの2 C2（b側+50）・3 A2（g側-100。「1200」開放区間の明示指示）まで消える。
2. 情報ゼロでも、**出口側の隅**（ローカルrun端＝chainで次の面へ渡る隅。`dirSign>0`ならworld hi・`dirSign<0`なら
   world lo＝`originWorld`定義の裏返し）を越える延長で、かつ近側セルが軸に**接している**なら残す。入隅は必ず2面で
   共有されるため、見通しそのものは出口側の面だけが担えば過不足がない（実機「2階22」のD2）。
3. それ以外（入口側 or 跨ぎ由来）は、区間長が図全体の**1/4以下**のときだけ残す。

**比は「実際に描かれる長さ」で採る**——延長した端は`resolveEnd`が直交壁の仕上げ面へ詰めるため、生のセル区間長とは
桁違いになりうる（実機1階5/C2は生3400に対し描かれるアキは400。生で判定するとユーザー確認済みの開放スパンまで落ちる）。
そのため端の確定を取捨ループの**内側**に置き、詰め後の値で比を採る。

**近側セルは「軸に接する」ものに加え「軸を跨ぐ」ものも拾う**（`cellStraddlesFace`。`cellNearSideOnFace`と対の述語）
——面のCLがその位置まで延長されていない帯では自室のセルが割れず1枚のまま面を跨ぐ。跨ぎを拾わないとその帯の抜けが
開放区間として描かれない（実機「2階22」A1のX3..X4）。跨ぎ由来は`straddle`で区別し、**`mergeSameKind`の結合キーに
含める**——接する側由来の正当な小区間と融合させないため（融合すると小さな開放区間が巨大な空白と一体で取捨判定され
丸ごと落ちる。実機1階5/C2で確認）。床の段差プロファイルは「軸に接する辺」の高さを問う処理のため跨ぎは対象外。

**同値・別延長のCLと隅の同定（`finish/wallGeneration.js`の`externalSubIntervals`。問題修正2026-08その9）**:
外周エッジの端点idは、セルキー由来（端点・隣接スパン＝実際にセルを画しているCL）が**権威**であり、
「自部屋のセルには現れない区切りCL」を足す`dividerCLsBetween`で**上書きしてはならない**。値が同じで延長だけ違うCLが
2本あると、隅が「その位置に届いていない方」のidを指し、`buildRoomFaces`のチェーン探索（`findCornerNeighbor`はCLの
**id**で隣の面へ辿る）が繋がらず、面が1枚も残らない（実機2階の室22で展開図が「Aのみ」になった）。同値の候補が
複数あるときは、その辺の軸位置まで延長が届いているCL（`isActiveAcrossRange`。隅は端点ちょうどで接するため±1mmの窓）を
優先する。

**寸法の分割源S2「面の向こう側に立つ壁」（`perpendicularWallsOnFace(face, graph, 'far')`。問題修正2026-08その9）**:
`isRoomWall`（部屋の外周から自動生成された壁）の扱いは`side`で分ける。`near`（袖壁＝面を分割する
自立壁）では従来どおり除外するが、**`far`では除外しない**——面の向こう側に立つ壁は定義上どこかの
部屋の外周生成壁であり、一律に除外するとこの源が常に空になる（実データは全ての壁が`isRoomWall`で、
S2は一度も機能していなかった。ユーザー実機指摘: 「22」Bは向こう側の壁で3500+3500・「22」C2は
2600+2400が正）。自室の壁が混ざらないのは`reach`/`project`判定が担う——自室の壁は面の位置で終わり
向こう側へ`PERP_MIN_PROJECTION_MM`以上突き出さないため落ちる。

**巾木の途切れ区間は描画基準（`drawnSpanRanges`）**: 巾木は描画要素のため、開放区間の範囲もCL基準
（`spans`）ではなく描画基準（境界に立つ実壁の「開放側の面」）を使う——CL基準だとCLと壁面の間
（半壁厚）に巾木の無い隙間ができる（ユーザー実機指摘2026-08その9「A1のX3の巾木はCL右側の壁まで」
「D2の2000の巾木は2000CL右側の壁まで」）。寸法・一点鎖線は従来どおりCL基準のまま（描画位置と
寸法位置を別に持つ既存規約）。

**通り芯の縦線は寸法行で2本に分ける（ユーザー明示指示2026-08その10）**: 上（天井上〜寸法行）は
一点鎖線・下（寸法行〜丸番号）は**実線**。1本の一点鎖線で丸まで通すと、(a)寸法行が破線のすき間に
当たって交点が消える (b)丸の手前で破線が切れて「構造芯ラベルの丸とCLが離れて見える」の2つが起きる。
**丸の位置（`gridCircleRowY`）は変えず線分の描き方だけで解決する**——丸は背景色で塗って線の上に
重なるため、実線を丸の中心まで引けば丸の縁にぴたりと接する。

**一点鎖線の位相（`renderer/dashPhase.js`。ユーザー明示指示2026-08その9）**: canvas/Konvaの破線は
線の**始点から**位相が始まるため、端や交点がすき間に当たると「寸法線と交点が取れていない」ように
見える。プリミティブに`dashAnchor`（線の伸びる軸上の座標＝展開図では寸法行のy）を持たせ、レンダラが
その点を**長い破線の中央**へ合わせる`dashOffset`を計算する。これで(1)基準点に必ずインクが乗り交点が
取れる (2)同じ寸法行を共有する線同士の位相が揃う（図面内で統一）の両方を満たす。純関数は
`dashPhase.js`（react-konva非依存）に置き単体テストする。

**ROW1のS4**（`collectRow1SplitPoints`）: `spans[i].hiCLId`が非nullの内部境界を`spans[i].hiCLX`で分割点に追加
する（S1と同形。既存の併合・端除外がそのまま効く）。

**Round Fフィクスチャでの検証結果**: D1（room2）は`spans=[wall(400), open(-50)]`・ROW1=400+1000（中心1..中心3..
中心7）が完全一致。B1（room3）はspans構造・farFloorDeltaMm(+100)は一致するが、ROW1は`[400,600,3000]`の3分割に
なる——中心7（y=3400）がextent無制限のためS3（面に届く非通り芯中心線）の「reaches」判定に無条件で該当してしまう
**既存・別件の仕様**（本ラウンドの変更対象外。中心7はB1の軸位置とは無関係だが、S3はCLの位置的近さではなく
extentの有無だけで判定するため）。
