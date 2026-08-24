# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に描く専用モード。平面・通り芯・寸法は出さず、
`viewport.scaleX/offsetX`（ズーム）には触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）だけで完結し、
平面へ戻ると元のビューが保たれる不変条件。純モジュールは`app/src/elevation/`に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`
（DOM依存）を静的importしない（node:test単体実行のため。校正値は`viewport.js`から取るか呼び出し側=`App.jsx`が渡す）。

縦横スクロールは**クランプ方式**（循環しない・画面に収まる帯もminXへクランプし中央寄せしない——全帯を左三角の位置で揃えるため）で
**書き込み時にクランプする**（読み出し側だけだと過剰ドラッグ分がスラックとして蓄積しデッドゾーンになる）。横スクロールの既定位置は
左三角(`band.leftAnchorX`)から`LEFT_MARGIN_SCREEN_MM`（2パス換算）ぶん手前——`clampFaceOffset`の下限だけを`minX-marginMm`へ広げて実現する
（上限はminXのまま）。

## A/B/C/D の向きと不変条件
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
寸法値は寸法線の**上側**。床線から下へ①tag②ROW1(壁芯間)③ROW2(通り芯間)④通り芯丸+面ラベル(同じ段)の順。通り芯・壁中心線は天井線より上へも
`GRID_LINE_ABOVE_CH_MM`突き出す。通り芯丸は背景色(`CANVAS_BG_COLOR`。定義は`renderer/canvasStyle.js`——展開モード以外からも参照する
汎用値のためrenderer/配下に置き、`elevationStyle.js`はre-export。index.cssの`#root`と2箇所手動同期)で塗り一点鎖線の上に描く
（`tag`は背景透明のまま対象外）。CH寸法値だけ寸法線の左側で反時計回り90°回転する。

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
3. **第3層 階段幾何（`sectionStair.js`）**: 階段の3D的な寄与を、タイプ非依存の区分線形モデル
   （Flight[]＝直進区間・Landing[]＝踊り場。h(t)を関数で持たず区間ごとの直線で表す）で表す。第1層がどの区間を
   渡すかを決め、第2層は「切断線がレーンを縦断＝段鼻のジグザグ」「レーンを横切る＝正面視の梯子」「踊り場を縦断＝
   床のCUT水平線」を切断線とFlight/Landingの幾何関係だけから導出する（タイプに一切依存しない）。

**鉄骨階段のささら（ささら桁。`structure===STEEL`限定）**: 出典
[鉄骨階段のささら解説](http://kentiku-kouzou.jp/struc-sasara.html)。段板（踏み板）を両側から支える斜め梁で、
一般的にプレート（最低12mm厚・せい250〜300mm程度）を使う。この記事のとおり寸法を展開図へ反映した:
- **寸法**: 板厚`STEEL_STRINGER_THICKNESS_MM=12`mm・せい`STEEL_STRINGER_DEPTH_MM=300`mm（250〜300の上限を採用。
  Stairモデルに桁成フィールドは無いため作図既定値。`elevationStairSection.js`）。

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
同じ`desiredDirSign`を使うこと（片方だけ直すと左右が食い違う）。SWITCHBACKのseq4は往路(outbound)の鏡像
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
（wLandingを「距離のある見えがかり候補」として一般規則から自然に検出させるため）。最上階かつ上階CHが非明示
（`isFallback`）なら往路上の天井を水平キャップするが、その境界の縦線は描かない（面が独立してクリップされる
ため——実機フィードバックの解釈で報告済みの逸脱）。seq1の壁2縁の線種（旧手書き仕様「wallZone側=太・
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

## 面端の不変条件・壁2段書き
面端の縦線（見えがかりエッジ）は`x=0`/`run`（`face.lo/hi`＝直交壁の仕上げ面。`snapFaceEndsToCorners`の隅詰め結果）に描く——
壁中心線（`faceBoundaryLocalX`の`boundary.lo/hi`。ROW1壁芯間寸法・通り芯一点鎖線が使う別の基準）とは異なる、既に正しい基準
（QA調査で再確認・回帰テストで固定）。面端は「壁のない端部」と「出隅」を区別する。**壁のない端部**（`snapFaceEndsToCorners`が付与する
`hasWallAtLocal0`/`hasWallAtLocalRun`がfalse）は「続きがある」建築表現として床線・天井線を`WALL_LESS_END_EXTEND_SCREEN_MM`（2パス換算）
ぶん図の外側へ延長し、縦線は描かない。
**出隅**（hasWallAtLocal0/hasWallAtLocalRunがtrue＝壁がある通常の面端。部屋の凸角で、視線方向に壁が折れて向こうへ続く角）は縦線を
SILHOUETTE（中線）で描く——切断面ではなく壁が折れて隣の面へ続くだけの見えがかりの角のため、CUT（太）は使わない（QA修正。床線・天井線・
段差の縦線・直交壁建具断面の枠は部屋の輪郭そのもの／明示指示に基づくためCUTのまま）。
**壁のない端部の判定基準は「隅に直交面が存在するか」ではなく「その直交面に実壁(`graph.walls`)があり、かつその壁がこの面の切断面
（faceValueの平面）を室内側へ横切っているか」**（`buildRoomFaces`の`hasRealWall`＋`perpWallCrossesFacePlane`。QA修正——閉じた部屋の
面ループでは隅に直交面自体は必ず存在するため、面の有無だけでは常にtrueになり発動しない。実壁の有無は`innerWallFaceAt`のnull
フォールバック＝faceValueがCL芯になったかで判定する）。**横切り判定はユーザー明示指示2026-08**——実壁があっても、その壁が面の向こう側
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

defer（未実装）: 傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・印刷/PDF・
SWITCHBACK以外の階段断面（WINDING/L_TURN/FLARED/OPEN_WELL）・展開図の建具「姿」クリックでのパネル連携（記号丸のみ対応）・
他階の建具の2層帯への描画（吹抜け帯の下階建具・階段帯の上階建具）・最上階キャップ時の天井境界CUT縦線。

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
   までの矩形を描く——見下ろし方向で遠側床まで伸ばすと、矩形外形の実線が床断面下の細破線
   （遠側床線・床下縦線）と同座標で重なり覆ってしまうため近側床でクランプする（QA指摘）。
   （QA修正・ユーザー差し戻し2026-08: 一度「アキ表現は開放スパンに不要」として全廃したが、
   指示範囲外の拡大解釈だったとして復元——アキ廃止は今後、明示指示がある場合のみ行う）。
3. 境界エッジ: open区間の両端のうち隣がwall側（区間 or 面端）ならSILHOUETTE縦線を引く。
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

**ROW1のS4**（`collectRow1SplitPoints`）: `spans[i].hiCLId`が非nullの内部境界を`spans[i].hiCLX`で分割点に追加
する（S1と同形。既存の併合・端除外がそのまま効く）。

**Round Fフィクスチャでの検証結果**: D1（room2）は`spans=[wall(400), open(-50)]`・ROW1=400+1000（中心1..中心3..
中心7）が完全一致。B1（room3）はspans構造・farFloorDeltaMm(+100)は一致するが、ROW1は`[400,600,3000]`の3分割に
なる——中心7（y=3400）がextent無制限のためS3（面に届く非通り芯中心線）の「reaches」判定に無条件で該当してしまう
**既存・別件の仕様**（本ラウンドの変更対象外。中心7はB1の軸位置とは無関係だが、S3はCLの位置的近さではなく
extentの有無だけで判定するため）。
