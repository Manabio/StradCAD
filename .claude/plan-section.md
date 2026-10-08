# 平面の断面解決（立体＋水平切断）

平面図を「立体を高さ範囲つきで持ち、水平切断で分類する」考え方で描く移行計画。段階 S1〜S7。

## S1: 階の属性「平面の切断高」
- 切断高は **Plane の属性**（`planCutHeightMm`、FL+mm、既定 1500）。建物一律の定数ではなく階ごとに持つ（ユーザー裁定 2026-10-08 (b)）。既定値は従来の `finish/kneeDropWall.js PLAN_CUT_HEIGHT` と同値で、S1 は動作変化なし。
- 読み口は **`planCutHeightMmOf(plane)` 唯一**。0・負・非数・欠落は既定へ倒す。新規コードは Plane のフィールドを直接読まず、`PLAN_CUT_HEIGHT` も使わない（後者は既定値の別名として残すだけ）。
- 旧データ（FBS にフィールドが無い）は既定値。FBS は 0 を「未設定」として省略するので、読み側の `|| 既定` と対になる。
- 階追加時は**複製**する（途中階挿入・下階追加は表示中の階、検討案の作成・案コピーは複製元の平面の値。屋根専用平面は構造モード専用で切断高を読まないため既定のまま）。
- 変更は階チップのメニュー「切断高」から。undo は Plane メタの書き戻し（`floorOps.setPlanCutHeightMm` → `applyPlaneMetas`）で、`planCutHeightMm` が undefined のメタは値を触らない。Plane メタは自動 dirty 追跡の対象外なので変更時に `markDirty()` を明示する。
- 腰壁・垂れ壁の天板輪郭の判定（`resolveKneeDropOverlays`）は階の値を読む。graphComputed 経由でも Plane は observable のため再計算される。

## S2: 立体モデル（`plan/planSolids.js`）
- 平面に関わる全実体の「占有形＋高さ範囲」の**単一の情報源**。層スタック（展開図の `buildBandLayers` と同型）を受け取り、組み立てはしない。描画・切断の分類は持たない（S3 以降）。
- footprint は2形（矩形の和＋穴／単純多角形）。z は自階 FL=0 の絶対 mm。梁は FL+levelOffset が天端、柱は FL〜天井、壁は FL〜天井、床は zLo=zHi=FL。勾配のある立体（下屋）だけ `zAt` を持つ。
- 床は `floorSolidOf` の**1か所**で作る。当面は建物範囲のセル矩形から床開口のセル矩形（`slabOpening.js floorOpeningCellRects`）を穴として引く（裁定 c）。**スラブ実体の実装後はこの関数の中身だけを差し替える**。破れ先が穴になるのは下階に同じ階段があるときだけ（`stairFilterFor` を共有）。
- 梁の除外役割は基礎梁・土台・小屋梁だけ。隔て梁・踊り場受け梁は**含める**——展開図の寄与（`structuralContribution`）は壁に隠れる梁や隔て梁を先に落とすが、平面では「実在の部材で隠れるか」を立体の重なり（S3）が決めるため、ここで先回りして落とさない。成は `beamDepthMm` を展開図と共有。
- 壁の上端は**壁ごとに1つ**（両側の部屋の天井高の min、片側なら其方、解決できなければ層の天井。層が `ceilZMm` を持てばそれ）。区間ごとに決めると、隅の取り合いで壁端がレコード端の外へはみ出した細片だけ別の天井になり、展開図（全高の壁にも帯の天井を使う）ともずれる。腰壁・垂れ壁・アキの z 範囲は展開図と同じ `sectionHits.kneeDropZRangesAt` を共有する（規則を複製しない）。レコードの端で壁を区間に割り、同じ高さの隣り合う区間は結合する。隔て壁の斜めの天端（wallTop）は S7 まで扱わない。
- 下屋の高さは軒先＝層の FL（**設計上の仮定**。ASSUMED。S5 で訂正: 当初は最高点＝FL）。T の最大は格子点＋中点の評価で近似するので、非対称な L 字の谷では数 mm ずれうる。主屋根は常に切断面より上なので立体にしない（拡張点は `roofSolids`）。
- 階段の段（kind `stairTread`）は予約だけで生成しない。純粋な踏面幾何が無く、S7 の前に `stairTreadSolids` が要る。
- 汎用立体は `opts.extraSolids` で受け、不正（高さ逆・非有限・空の footprint）は黙って捨てる。出力順は層のFL降順→kind表→id で決定的（層・配列の入力順に依らない）。
- S3 への申し送り: 実データでは自階の梁の天端が FL ちょうどで床面と同じ高さになる。梁の天端は床面と同じ高さになるため、重なりの同点規則は S3 で床が勝つ。

## S3: 解決器（`plan/planSectionFigure.js`）
- 立体と切断高から**線だけ**を解く純関数（多角形演算なし。描画の接続は S4 以降）。分類は3区分——`zHi<=cutZ+EPS` 見えがかり（細線）／`zLo>=cutZ-EPS` 非表示／それ以外 切断（太線）。EPS=0.5mm。腰壁の天端がちょうど切断高なら見えがかり。
- 遮蔽は輪郭線を遮蔽物の輪郭との交点で区間に切り、区間の中点が遮蔽物の**厳密な内側**かで決める。**単独の立体の境界の上は隠さない**（壁の面に接する梁の辺が残る）。ただし点 p の斜め4点（±0.001）がそれぞれ何らかの遮蔽物の厳密内部で、その遮蔽物が下の規則で p を隠すなら、**遮蔽物の和の内部**として隠す（隣り合う壁・矩形群の継ぎ目の上の線が消える。和の外縁は外へ出る斜め点があるので残る。矩形群の共有辺の特例はこの一般判定へ吸収）。隠すのは (i) 相手の上端が高い (ii) 相手が面材（床・屋根。S5 で屋根を加えた）で上端が同じ以上（**面材が同点で勝つ**——梁の天端は床面・屋根面と同点）(iii) 双方が切断（同じ高さで隠し合い和の輪郭だけが残る）。
- 切断同士で線が相手の境界の上にあるときは、面を接する側（柱と壁・隣の壁）は共有面なので隠し、同じ側に重なる外周は片方（canonical 順の先）だけが描く。`isInsideFootprint` は穴の縁の上を内側と数えるので、解決器側で縁の上は外にする。
- 層: 自階はどこでも見える。下階は**自階の床の穴の和の中だけ**（窓）で、途中の階の床・下階自身の床が更に隠す。自階に床が無ければ下階は出ない。上階は切断高が階高より低い限り全部非表示で 0 件。
- 勾配のある立体（`zAt`）は区間を `slopeSampleMm`（100）ごとに調べ、可視が変わる所を二分探索（精度0.5mm。サンプルは区間の両端の内側にも置く）で切る。切断面をまたぐ勾配立体は `zAt<cutZ` の部分の輪郭だけを細線にし、**等高線は出さない**（受容する限界）。
- 線種の対応は `PLAN_LINE_STYLE` の**1か所**（cut=thick・below=thin。`weight` は `viewport.lineWeightsPx` のキー）。`dash` は汎用立体の `style.dash` だけが付ける。出力順は cls→kind 表→層FL降順→id→座標で決定的（入力順に依らない）。
- 実データ（moku1-6 の2階＋1階: 立体304件→線319本・約20ms、13 の2階＋1階: 163件→245本・約6ms）。ドラッグ中の再描画に使うので、S4 で `graphComputed` のキャッシュを前提にする。

## S4: 新レイヤ（`renderer/PlanSolidsLayer.jsx`）
- **描くのは梁と汎用立体だけ（S5 で下屋＝屋根を追加）**（`plan/planSolidsLayerFilter.js S4_DRAWN_KINDS`、唯一の場所）。柱・壁・床は既存レイヤ（ShapesLayer）が描くので、解決器には全立体を渡して**遮蔽物としてだけ**参加させ、出力のうち `source.kind` が集合に入るものだけを描く。S6（吹抜け）で既存レイヤを寄せるときにこの集合を広げる。
- 表示するモードは `shouldShowPlanFigure`（構造モードの伏図は対象外）。層は**自階＋直下の採用階だけ**（上階は渡さない＝切断高が階高より低い限り 0 件で費用だけ掛かる）。直下階の peek は App.jsx の上階ビュー用の既存 effect が同じ peek から `belowPlanPeek` として持つ（新しい peek を増やさない）。
- キャッシュは `graphComputed`。**置き場は直下階 peek の graph（無ければ自階）、鍵は自階×切断高×直下階**——置き場を自階に固定すると、階を切り替えて下階の peek が替わっても古い peek 基準の結果を握り続ける（StructuralLayer の床開口の×と同じ。`renderer/graphDerived.planSection.test.js`）。`belowPlanPeek.activePlaneId` が自階と違うものは使わない（階切替直後の1フレーム）。
- 通り芯・中心線のドラッグ中（どれかの `pendingDelta` が 0 でない）は、`graphComputed` が毎フレーム全再計算になる（moku1-6 の2階で 50〜105ms）ので、**前回の線を描き続ける**（ref に保持。ドラッグ終了で1回だけ再計算）。`belowPlanPeek` は3状態（undefined＝未解決〔階切替直後〕は**自階だけの層で解決して描く**＝鍵は `pending`、置き場は自階。下屋・自階の梁が切替のたびに消えないため〔S5 で「描かない」から変更〕。peek が届くと通常の鍵で再計算され下階の線だけが後から現れる／null＝下階なし／オブジェクト）。判断は純関数 `planSolidsLayerResolve`、置き場・鍵は `planSolidsLayerCacheSpec` の1か所。
- 受容する限界: 同じ階・同じモードのまま直下階の中身や階高が変わっても peek は作り直さない（`upperStairEntries` と同じ）。
- 実データでは梁の天端が FL と同点のため、自階の梁は床の無い所（吹抜け・建物外）か天端が FL より高いときだけ出る。これは S3 の規則（床が同点で勝つ）どおりで、不具合ではない。
- 柱の立体化は `finish/columnWrap.js columnWrapSolids`（壁集合を1回作る）を使う。柱ごとに作り直していた旧実装は moku1-6 の `planSolids` の約64%を占めた。
- 検証用: `scripts/probe/makePlanSolidsTestDoc.mjs`（moku4 の2階に手動梁2本。細線の帯と太線の帯）、`scripts/probe/dumpPlanSolids.mjs`（文書・階ごとの線と件数）。

## S5: 下屋を解決器へ寄せる（`RoofPlanLayer` → `PlanSolidsLayer`）
- 下屋の線・傾斜ラベルは屋根立体（`planSolids.js roofSolids`）＋解決器が出し、`PlanSolidsLayer` が描く（`S4_DRAWN_KINDS` に `'roof'`）。`SceneLayers` から `RoofPlanLayer` は外した。旧 `roofPlanFigure`・`RoofPlanLayer.jsx`・`roofPlanWallTrim.js` は**比較の基準として残す**（削除は目視 OK 後）。比較の道具は `plan/roofPlanCompare.js` と `scripts/probe/dumpRoofPlanCompare.mjs`（roof-test1〜10・moku1-6 で旧と新の線が一致、ラベルは座標・文字まで一致）。
- **線は壁で切る前のまま `innerLines` に入れる**（外形線 `exposedPaths`・棟木・隅木・谷木。線の作り方は `roofPlanFigure.js roofPlanRegionFigure` の1か所で、旧 `roofPlanFigure` も同じ関数を呼んでから端を止める）。**外壁面どまりは壁立体（切断）の遮蔽が導く**——壁の厚みは `wallConcealRange`（材∪下地）で、旧の `outerWallFaceNear` と同じ定義。閉じた外形線は先頭の点を末尾へ足す（解決器は閉じる辺を作らない）。
- **footprint は遮蔽専用**（Solid の `drawEdges:false`）。屋内に接する出幅0の辺を描かない裁定は壁の無い階でも効き、幾何だけでは再現できないため、輪郭は描かず `innerLines` だけ描く。複数の閉路は閉路ごとに1件で、線とラベルは part 0 だけに付ける。
- **屋根の高さ**: 軒先と軒の出が層の FL、最高点が FL + k·tMax（S2 の「最高点＝FL」を訂正。「軒先＝FL」は設計上の仮定）。面材（`SURFACE_KINDS`＝床・屋根）は同じ高さでも下の線に勝つ——下屋の下の梁（天端 FL）は屋根に隠れる（moku1-6 の2階で梁の線 80→26）。
- **ラベルは `marks`**（`{anchor, prims}`）。基準点が線の点と同じ可視判定で見えるときだけ prims を出す（新規則なし）。出力は細線・below・`detailOnly:true`、線は `detailOnly:false`。LOD の絞りは memo の外・層側（`visiblePlanPrimitives`）。
- 限界: L1 壁の無い階（またはその区間）では端が通り芯まで（旧と同じ）。L2 穴を持つ outline（屋内を囲む環状の下屋）は穴の閉路も屋根面として塗り、屋内側の線を隠しうる（実データに 0 件。出たら対応）。L3 k·tMax ≥ 切断高の下屋は勾配が切断面をまたぎ、上の線が消える。L4 梁の levelOffset が正で屋根より高ければ屋根の上に出る。壁が下屋の軒先の線を横切る所（隣の建物の壁など）は線が途切れる（旧は引き続けた。設計 D1 の帰結としてユーザー側で受容した許す差分 (a)）。伏図だけの規則（胴差の勝ちと延長）は平面の対象外。
- 受容した限界（ユーザー裁定）: 階切替・モード切替のたびに自階だけの計算（pending）が1回増える（moku1-6 2階 86ms・roof-test9 67ms・moku4-1 79ms）。graphComputed は keepAlive でないため pending の結果は再利用されない。通り芯ドラッグ中は下屋の線も前回の線のまま追従しない（旧 RoofPlanLayer は毎フレーム追従。moku1-6 2階で 28 本中 7 本の CL で出力が変わる）。

## S6: 吹抜けの注記（`plan/planHoleMarks.js`。S6a＝純モジュール、S6b＝`PlanSolidsLayer` へ配線・旧 `VoidLayer`／`voidGeometry` 削除）
- 自階の×と直下階の上階吹抜け破線は、解決器の線ではなく**穴に付く注記**。穴の単位は `slabOpening.js floorOpeningGroups`（吹抜け＝室ごと、昇降路＝器具行ごと〔行が無ければ室ごと〕、階段吹抜け・破れ先＝×なし）。
- **×の端点＝グループのセル集合の `faceRect`（`innerRect`）**。階段の描画幅・`openingParts` の上階クリップと同じ供給源で、切断の遮蔽物から導き直さない（部分壁・吹抜け縁の腰壁・対称壁の backingRange・張り出す柱で結果が変わるため）。矩形でない・faceRect が解決できないグループは×なし。
- 注記は**切断面上で遮蔽しない**（吹抜け内の柱の上にも重なる。伏図の×が梁で分割されるのとは違う）。上階破線は上階の床の穴の縁を示す表示記号で、穴の遮蔽規則 (a) とは別。上階の void・shaft の `cellRect` が自階の void・shaft のセル矩形の和（`selfVoidHoleRects`。`floorOpeningCellRects` の `sources` で畳む前に絞る）に覆われれば出さない。ラベルは VOID だけ。
- 旧経路（`voidGeometry.js`）との差は、**穴が無ければ×も無い**ことの帰結だけ: 孤児器具行（室が無い／昇降路でない室を指す行）と、室のセルが解決できない昇降路には×を出さない（実データでは該当 0 件）。
- **配線（S6b）**: `PlanSolidsLayer` が Group `plan-hole-marks` で描く。**自階の×はドラッグ追従のため memo の外**（`planHoleMarksOf` を毎レンダーで呼ぶ。解決器の「ドラッグ中は前回のまま」に入れない——旧 VoidLayer の×はドラッグに追従していた）。**上階の穴は peek した graph に memo**（`graphComputed(abovePeek.graph, 'planHoleGroups', …)`。peek の graph はドラッグで変わらない）。`abovePlanPeek` は App.jsx の上階 peek の既存 effect が持つ3状態（undefined＝未解決／null＝上階なし／`{graph, activePlaneId}`）で、`activePlaneId` が自階と違う peek は使わない。描画への写像は純関数 `planHoleMarkPrimitives`（太線1本分の内側・対角2本・外形・ラベル位置。dashKind→破線の写像は `HOLE_MARK_DASH` の1か所）で、LOD SCHEMATIC はラベルだけ落とす。
- 描画順は「梁・下屋 → 注記」（旧は注記が先）。受容する限界: 同じ階のままモード切替・floorSyncTick で上部吹抜けの破線が peek 完了まで一瞬消える（旧は前回値を出し続けたが、階切替直後に前の階の破線が残る不良があった）。
- 回帰の関門は `scripts/probe/dumpVoidCompare.mjs`（`golden-void/` と比較。golden は S6a 時点で旧経路と新経路が一致していた出力を採取、20文書55階。意図した変更のときだけ `--write`）。
- 下階の層を全種別で描くのは S6c（別コミット・目視後）。

## 注意
- 切断面に関わる他の箇所は、S2 以降で立体モデルへ寄せる際に階の値（`planCutHeightMmOf`）を読む形へ揃える。
