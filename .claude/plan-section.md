# 平面の断面解決（立体＋水平切断）

平面図を「立体を高さ範囲つきで持ち、水平切断で分類する」考え方で描く移行計画。段階 S1〜S7。

## S1: 階の属性「平面の切断高」
- 切断高は **Plane の属性**（`planCutHeightMm`、FL+mm、既定 1500）。建物一律の定数ではなく階ごとに持つ（ユーザー裁定 2026-10-08 (b)）。既定値は従来の `finish/kneeDropWall.js PLAN_CUT_HEIGHT` と同値で、S1 は動作変化なし。
- 読み口は **`planCutHeightMmOf(plane)` 唯一**。0・負・非数・欠落は既定へ倒す。新規コードは Plane のフィールドを直接読まず、`PLAN_CUT_HEIGHT` も使わない（後者は既定値の別名として残すだけ）。
- 旧データ（FBS にフィールドが無い）は既定値。FBS は 0 を「未設定」として省略するので、読み側の `|| 既定` と対になる。 階追加時は**複製**する（途中階挿入・下階追加は表示中の階、検討案の作成・案コピーは複製元の平面の値。屋根専用平面は構造モード専用で切断高を読まないため既定のまま）。 変更は階チップのメニュー「切断高」から。undo は Plane メタの書き戻し（`floorOps.setPlanCutHeightMm` → `applyPlaneMetas`）で、`planCutHeightMm` が undefined のメタは値を触らない。Plane メタは自動 dirty 追跡の対象外なので変更時に `markDirty()` を明示する。
- 腰壁・垂れ壁の天板輪郭の判定（`resolveKneeDropOverlays`）は階の値を読む。graphComputed 経由でも Plane は observable のため再計算される。

## S2: 立体モデル（`plan/planSolids.js`）
- 平面に関わる全実体の「占有形＋高さ範囲」の**単一の情報源**。層スタック（展開図の `buildBandLayers` と同型）を受け取り、組み立てはしない。描画・切断の分類は持たない（S3 以降）。
- footprint は2形（矩形の和＋穴／単純多角形）。z は自階 FL=0 の絶対 mm。梁は FL+levelOffset が天端、柱は FL〜天井、壁は FL〜天井、床は zLo=zHi=FL。勾配のある立体（下屋）だけ `zAt` を持つ。
- 床は `floorSolidOf` の**1か所**で作る。当面は建物範囲のセル矩形から床開口のセル矩形（`slabOpening.js floorOpeningCellRects`）を穴として引く（裁定 c）。**スラブ実体の実装後はこの関数の中身だけを差し替える**。破れ先が穴になるのは下階に同じ階段があるときだけ（`stairFilterFor` を共有）。
- 梁の除外役割は基礎梁・土台・小屋梁だけ。隔て梁・踊り場受け梁は**含める**——展開図の寄与（`structuralContribution`）は壁に隠れる梁や隔て梁を先に落とすが、平面では「実在の部材で隠れるか」を立体の重なり（S3）が決めるため、ここで先回りして落とさない。成は `beamDepthMm` を展開図と共有。
- 壁の上端は**壁ごとに1つ**（両側の部屋の天井高の min、片側なら其方、解決できなければ層の天井。層が `ceilZMm` を持てばそれ）。区間ごとに決めると、隅の取り合いで壁端がレコード端の外へはみ出した細片だけ別の天井になり、展開図（全高の壁にも帯の天井を使う）ともずれる。腰壁・垂れ壁・アキの z 範囲は展開図と同じ `sectionHits.kneeDropZRangesAt` を共有する（規則を複製しない）。レコードの端で壁を区間に割り、同じ高さの隣り合う区間は結合する。隔て壁の斜めの天端（wallTop）は S7 まで扱わない。
- 下屋の高さは軒先＝層の FL（**設計上の仮定**。ASSUMED。S5 で訂正: 当初は最高点＝FL）。T の最大は格子点＋中点の評価で近似するので、非対称な L 字の谷では数 mm ずれうる。主屋根は常に切断面より上なので立体にしない（拡張点は `roofSolids`）。
- 階段の段（kind `stairTread`）は S7b で生成する（下記「S7b 段」）。 汎用立体は `opts.extraSolids` で受け、不正（高さ逆・非有限・空の footprint）は黙って捨てる。出力順は層のFL降順→kind表→id で決定的（層・配列の入力順に依らない）。 S3 への申し送り: 実データでは自階の梁の天端が FL ちょうどで床面と同じ高さになる。梁の天端は床面と同じ高さになるため、重なりの同点規則は S3 で床が勝つ。

## S3: 解決器（`plan/planSectionFigure.js`）
- 立体と切断高から**線だけ**を解く純関数（多角形演算なし。描画の接続は S4 以降）。分類は3区分——`zHi<=cutZ+EPS` 見えがかり（細線）／`zLo>=cutZ-EPS` 非表示／それ以外 切断（太線）。EPS=0.5mm。腰壁の天端がちょうど切断高なら見えがかり。
- 遮蔽は輪郭線を遮蔽物の輪郭との交点で区間に切り、区間の中点が遮蔽物の**厳密な内側**かで決める。**単独の立体の境界の上は隠さない**（壁の面に接する梁の辺が残る）。ただし点 p の斜め4点（±0.001）がそれぞれ何らかの遮蔽物の厳密内部で、その遮蔽物が下の規則で p を隠すなら、**遮蔽物の和の内部**として隠す（隣り合う壁・矩形群の継ぎ目の上の線が消える。和の外縁は外へ出る斜め点があるので残る。矩形群の共有辺の特例はこの一般判定へ吸収）。隠すのは (i) 相手の上端が高い (ii) 相手が面材（床・屋根。S5 で屋根を加えた）で上端が同じ以上（**面材が同点で勝つ**——梁の天端は床面・屋根面と同点）(iii) 双方が切断（同じ高さで隠し合い和の輪郭だけが残る）。
- 切断同士で線が相手の境界の上にあるときは、面を接する側（柱と壁・隣の壁）は共有面なので隠し、同じ側に重なる外周は片方（canonical 順の先）だけが描く。`isInsideFootprint` は穴の縁の上を内側と数えるので、解決器側で縁の上は外にする。
- **隙間の規則**（`closeNarrowGaps`。ユーザー裁定 2026-10-08）: 切断（cut）の遮蔽物の間の幅が `PLAN_GAP_CLOSE_MM`（20mm。単一の定数）以下の隙間は、**見えがかり（below）の線**を覗かせない。壁の角の仕上げ厚の切り欠き（12.5mm）から下の梁が短線で覗いていた（全文書で 67 本）のを消す。可視区間が 20mm 以下で、**両側とも**「隣の不可視区間が cut の遮蔽物の内側」か「区間の端点（線自身の端点・長い線の内部端とも）が cut の遮蔽物の輪郭の上・内側」で縁取られているものだけを隠す（内部端は 2026-10-09 追加。壁の結合で外形線が長くなり、端の切り欠きが内部端になったため）。cut の線は対象外（この規則で消えない）。cut に縁取られない短線（below 同士の間など）と、cut でない短線は残す。長さの比較は `<=`（ちょうど 20 は隠し、20.5 は残す）。自階・下階の層とも適用。壁が下階の層でも同じ（下階の壁の 12.5mm の端の蓋は cut に縁取られないので残る＝後述 S6c）。
- 層: 自階はどこでも見える。下階は**自階の床の穴の和の中だけ**（窓）で、途中の階の床・下階自身の床が更に隠す。自階に床が無ければ下階は出ない。上階は切断高が階高より低い限り全部非表示で 0 件。
- 勾配のある立体（`zAt`）は区間を `slopeSampleMm`（100）ごとに調べ、可視が変わる所を二分探索（精度0.5mm。サンプルは区間の両端の内側にも置く）で切る。切断面をまたぐ勾配立体は `zAt<cutZ` の部分の輪郭だけを細線にし、**等高線は出さない**（受容する限界）。
- 線種の対応は `PLAN_LINE_STYLE` の**1か所**（cut=thick・below=thin。`weight` は `viewport.lineWeightsPx` のキー）。`dash` は汎用立体の `style.dash` だけが付ける。出力順は cls→kind 表→層FL降順→id→座標で決定的（入力順に依らない）。 実データ（moku1-6 の2階＋1階: 立体304件→線319本・約20ms、13 の2階＋1階: 163件→245本・約6ms）。ドラッグ中の再描画に使うので、S4 で `graphComputed` のキャッシュを前提にする。

## S4: 新レイヤ（`renderer/PlanSolidsLayer.jsx`）
- **自階で描くのは梁と汎用立体だけ（S5 で下屋＝屋根を追加）**（`plan/planSolidsLayerFilter.js S4_DRAWN_KINDS`、唯一の場所）。自階の柱・壁・床は既存レイヤ（ShapesLayer）が描くので、解決器には全立体を渡して**遮蔽物としてだけ**参加させ、出力のうち `source.kind` が集合に入るものだけを描く。下階の層は S6c から全種別（`BELOW_DRAWN_KINDS`）。
- 表示するモードは `shouldShowPlanFigure`（構造モードの伏図は対象外）。層は**自階＋直下の採用階だけ**（上階は渡さない＝切断高が階高より低い限り 0 件で費用だけ掛かる）。直下階の peek は App.jsx の上階ビュー用の既存 effect が同じ peek から `belowPlanPeek` として持つ（新しい peek を増やさない）。
- キャッシュは `graphComputed`。**置き場は直下階 peek の graph（無ければ自階）、鍵は自階×切断高×直下階**——置き場を自階に固定すると、階を切り替えて下階の peek が替わっても古い peek 基準の結果を握り続ける（StructuralLayer の床開口の×と同じ。`renderer/graphDerived.planSection.test.js`）。`belowPlanPeek.activePlaneId` が自階と違うものは使わない（階切替直後の1フレーム）。
- 通り芯・中心線のドラッグ中（どれかの `pendingDelta` が 0 でない）は、`graphComputed` が毎フレーム全再計算になる（moku1-6 の2階で 50〜105ms）ので、**前回の線を描き続ける**（ref に保持。ドラッグ終了で1回だけ再計算）。`belowPlanPeek` は3状態（undefined＝未解決〔階切替直後〕は**自階だけの層で解決して描く**＝鍵は `pending`、置き場は自階。下屋・自階の梁が切替のたびに消えないため〔S5 で「描かない」から変更〕。peek が届くと通常の鍵で再計算され下階の線だけが後から現れる／null＝下階なし／オブジェクト）。判断は純関数 `planSolidsLayerResolve`、置き場・鍵は `planSolidsLayerCacheSpec` の1か所。
- 受容する限界: 同じ階・同じモードのまま直下階の中身や階高が変わっても peek は作り直さない（`upperStairEntries` と同じ）。 実データでは梁の天端が FL と同点のため、自階の梁は床の無い所（吹抜け・建物外）か天端が FL より高いときだけ出る。これは S3 の規則（床が同点で勝つ）どおりで、不具合ではない。
- 柱の立体化は `finish/columnWrap.js columnWrapSolids`（壁集合を1回作る）を使う。柱ごとに作り直していた旧実装は moku1-6 の `planSolids` の約64%を占めた。
- 検証用: `scripts/probe/makePlanSolidsTestDoc.mjs`（moku4 の2階に手動梁2本。細線の帯と太線の帯）、`scripts/probe/dumpPlanSolids.mjs`（文書・階ごとの線と件数）。

## S5: 下屋を解決器へ寄せる（`RoofPlanLayer` → `PlanSolidsLayer`）
- 下屋の線・傾斜ラベルは屋根立体（`planSolids.js roofSolids`）＋解決器が出し、`PlanSolidsLayer` が描く（`S4_DRAWN_KINDS` に `'roof'`）。`SceneLayers` から `RoofPlanLayer` は外した。旧 `roofPlanFigure`・`RoofPlanLayer.jsx`・`roofPlanWallTrim.js`・`wallFaces.js outerWallFaceNear` は目視 OK 後の **S5b で削除済み**。旧と新は S5 の時点で roof-test1〜10・moku1-6 の全階で線が一致（ラベルは座標・文字まで一致）しており、その出力を **`scripts/probe/golden-roof/`**（下屋のある 18 階。golden は 19 ファイルで、roof-test4 は下屋なしの空）に残して、関門 `scripts/probe/dumpRoofPlanCompare.mjs` が golden と比べる（意図した変更のときだけ `--write`）。比較の道具は `plan/roofPlanCompare.js`（壁で切る前の図形 vs 解決器の線）。
- **線は壁で切る前のまま `innerLines` に入れる**（外形線 `exposedPaths`・棟木・隅木・谷木。線の作り方は `roofPlanFigure.js roofPlanRegionFigure` の1か所）。**外壁面どまりは壁立体（切断）の遮蔽が導く**——壁の厚みは `wallConcealRange`（材∪下地）で、旧 `outerWallFaceNear` と同じ定義だった。閉じた外形線は先頭の点を末尾へ足す（解決器は閉じる辺を作らない）。
- **footprint は遮蔽専用**（Solid の `drawEdges:false`）。屋内に接する出幅0の辺を描かない裁定は壁の無い階でも効き、幾何だけでは再現できないため、輪郭は描かず `innerLines` だけ描く。複数の閉路は閉路ごとに1件で、線とラベルは part 0 だけに付ける。
- **屋根の高さ**: 軒先と軒の出が層の FL、最高点が FL + k·tMax（S2 の「最高点＝FL」を訂正。「軒先＝FL」は設計上の仮定）。面材（`SURFACE_KINDS`＝床・屋根）は同じ高さでも下の線に勝つ——下屋の下の梁（天端 FL）は屋根に隠れる（moku1-6 の2階で梁の線 80→26）。
- **ラベルは `marks`**（`{anchor, prims}`）。基準点が線の点と同じ可視判定で見えるときだけ prims を出す（新規則なし）。出力は細線・below・`detailOnly:true`、線は `detailOnly:false`。LOD の絞りは memo の外・層側（`visiblePlanPrimitives`）。
- 限界: L1 壁の無い階（またはその区間）では端が通り芯まで（旧と同じ）。L2 穴を持つ outline（屋内を囲む環状の下屋）は穴の閉路も屋根面として塗り、屋内側の線を隠しうる（実データに 0 件。出たら対応）。L3 k·tMax ≥ 切断高の下屋は勾配が切断面をまたぎ、上の線が消える。L4 梁の levelOffset が正で屋根より高ければ屋根の上に出る。壁が下屋の軒先の線を横切る所（隣の建物の壁など）は線が途切れる（旧は引き続けた。設計 D1 の帰結としてユーザー側で受容した許す差分 (a)）。伏図だけの規則（胴差の勝ちと延長）は平面の対象外。 受容した限界（ユーザー裁定）: 階切替・モード切替のたびに自階だけの計算（pending）が1回増える（moku1-6 2階 86ms・roof-test9 67ms・moku4-1 79ms）。graphComputed は keepAlive でないため pending の結果は再利用されない。通り芯ドラッグ中は下屋の線も前回の線のまま追従しない（削除した旧 RoofPlanLayer は毎フレーム追従していた。moku1-6 2階で 28 本中 7 本の CL で出力が変わる）。

## S6: 吹抜けの注記（`plan/planHoleMarks.js`。S6a＝純モジュール、S6b＝`PlanSolidsLayer` へ配線・旧 `VoidLayer`／`voidGeometry` 削除）
- 自階の×と直下階の上階吹抜け破線は、解決器の線ではなく**穴に付く注記**。穴の単位は `slabOpening.js floorOpeningGroups`（吹抜け＝室ごと、昇降路＝器具行ごと〔行が無ければ室ごと〕、階段吹抜け・破れ先＝×なし）。
- **×の端点＝グループのセル集合の `faceRect`（`innerRect`）**。階段の描画幅・`openingParts` の上階クリップと同じ供給源で、切断の遮蔽物から導き直さない（部分壁・吹抜け縁の腰壁・対称壁の backingRange・張り出す柱で結果が変わるため）。矩形でない・faceRect が解決できないグループは×なし。
- 注記は**切断面上で遮蔽しない**（吹抜け内の柱の上にも重なる。伏図の×が梁で分割されるのとは違う）。上階破線は上階の床の穴の縁を示す表示記号で、穴の遮蔽規則 (a) とは別。上階の void・shaft の `cellRect` が自階の void・shaft のセル矩形の和（`selfVoidHoleRects`。`floorOpeningCellRects` の `sources` で畳む前に絞る）に覆われれば出さない。ラベルは VOID だけ。
- 旧経路（`voidGeometry.js`）との差は、**穴が無ければ×も無い**ことの帰結だけ: 孤児器具行（室が無い／昇降路でない室を指す行）と、室のセルが解決できない昇降路には×を出さない（実データでは該当 0 件）。
- **配線（S6b）**: `PlanSolidsLayer` が Group `plan-hole-marks` で描く。**自階の×はドラッグ追従のため memo の外**（`planHoleMarksOf` を毎レンダーで呼ぶ。解決器の「ドラッグ中は前回のまま」に入れない——旧 VoidLayer の×はドラッグに追従していた）。**上階の穴は peek した graph に memo**（`graphComputed(abovePeek.graph, 'planHoleGroups', …)`。peek の graph はドラッグで変わらない）。`abovePlanPeek` は App.jsx の上階 peek の既存 effect が持つ3状態（undefined＝未解決／null＝上階なし／`{graph, activePlaneId}`）で、`activePlaneId` が自階と違う peek は使わない。描画への写像は純関数 `planHoleMarkPrimitives`（太線1本分の内側・対角2本・外形・ラベル位置。dashKind→破線の写像は `HOLE_MARK_DASH` の1か所）で、LOD SCHEMATIC はラベルだけ落とす。
- 描画順は「梁・下屋 → 注記」（旧は注記が先）。受容する限界: 同じ階のままモード切替・floorSyncTick で上部吹抜けの破線が peek 完了まで一瞬消える（旧は前回値を出し続けたが、階切替直後に前の階の破線が残る不良があった）。
- 回帰の関門は `scripts/probe/dumpVoidCompare.mjs`（`golden-void/` と比較。golden は S6a 時点で旧経路と新経路が一致していた出力を採取、20文書55階。意図した変更のときだけ `--write`）。

## S6c: 下階の層を全種別で描く
- 下階の層（`layerFloorZ<0`。自階の床の穴の窓越し）は**壁・柱・床・梁・屋根・汎用立体の全種別を細線で描く**（`planSolidsLayerFilter.js BELOW_DRAWN_KINDS='all'`、唯一の場所）。自階は従来どおり `S4_DRAWN_KINDS`（自階の壁・柱・床は既存レイヤが描く）。判定は `isDrawn` の1か所で、層は `source.layerFloorZ` で決まる。下階の立体は全部 below なので細線（cut は出ない。probe の検査で 0）。
- **二重描画（実測。受容）**: 階段吹抜けの穴の中の下階の壁の線は 21 文書で 251 本。このうち `StairLayer` の隔て壁の輪郭（`partitionOutlineOf`）と重なるのは 8 本（moku4-2・wood-void-test）だけで、残り 243 本は StairLayer が描かない壁で、今回はじめて見える線（13 の2階の折返し階段の中央壁など）。この時点では段板が立体でなく、段の下に隠れるはずの下階の壁も描かれた。S7b 以降は段より低い壁の部分だけ消える（消えた長さ 28.3m＝下階の壁の総延長 375.6m の約 7%）。段より高い壁（天端 FL−600 の壁など）は残る。階段吹抜け内の下階の壁は分割で 251→265 本。ユーザー了承済み。2026-10-09 の壁帯の結合（`mergeTouchingWalls`）と隙間の規則 (iii) で、probe 既定の 5 文書（13・moku4・moku1-6・wood-void-test・plan-solids-test）の階段吹抜け内の下階の壁は 75→48 本、下階の層の線は 129→79 本に減った（下地/仕上げの境目と 12.5mm の断片が消えた分）。
- 壁の立体は、同じ芯 CL・同じ高さ範囲で帯（`wallConcealRange`）が接し区間が重なるものを 1 件（`footprint.rects` 複数・`source.mergedIds`）に結合する（`planSolids.js mergeTouchingWalls`。2026-10-09 ユーザー指摘〔隔て板の見下げで下地/仕上げの境目が2本に見える〕）。見下げは帯の外形だけで、下地/仕上げの境目は描かない。遮蔽は同じ矩形の和で不変。
- 窓の中だけに出る（穴の外 0。probe `dumpPlanSolids.mjs` が下階の層の線を穴の和に照らして検査する）。
- 12.5mm の短線（薄壁の端の蓋・厚い壁の辺の断片・下階の2枚の壁の継ぎ目の重複）は、壁帯の結合と隙間の規則の (iii) で 21 文書 145→8 本になった（QA 実測。probe 既定の 5 文書では 41→2 本）。残り 8 本は 10・11・13・14 の同じ入隅で、cut に縁取られないため残る。結合は全壁が対象（隔て板に限らない）。「below 同士の間の隙間は残す」は不変。 隙間の規則の限界（受容）: 勾配のある cut の遮蔽物と隣り合う区間では、外側を探す距離が 0.01mm と短い。

## S7a: 安全網（平面の線の golden。コードは変えない）
- 壁: `scripts/probe/golden-regen/<文書>/`（11・13・14・moku1・moku1-6・moku4 の 6 文書、DETAIL LOD。2026-10-09 再採取＝9/17 以降の階段関連の変更〔階段吹抜け再設計・隔て板〕による差を基準更新）。壁 UUID が毎回変わるのでバイト比較は不可、`diffPlanRegen.mjs <今> <golden>` の mismatch 0 で比べる。更新は `dumpPlanRegen.mjs <出力先> <.stq>` の上書き採取。
- 階段: `golden-stair-plan/`（13・14・moku1-6・moku4・wood-void-test・opening-test・plan-solids-test、上下 peek 込みの StairLayer 相当の線。`dumpStairPlan.mjs`、StairLayer の判断を複製しているので StairLayer を変えたら写像も見直す）。下屋 `golden-roof/`・吹抜け `golden-void/`・解決器 `dumpPlanSolids.mjs`（件数検査）。比較は各 probe を引数なしで実行（差分で exit 1）、更新は `--write`。moku1-6 の golden-stair-plan・golden-regen は 2026-10-09 に回り階段の隔て壁（あき 115・1階に隔て壁）に合わせて再採取。
- 注意: 切断面に関わる他の箇所は、S2 以降で立体モデルへ寄せる際に階の値（`planCutHeightMmOf`）を読む形へ揃える。

## S7b 段（階段の段を遮蔽物にする）
- `finish/stair/stairTreads.js stairTreadFootprints` が、描画と同じエミッタ（`stairGeometry.js` の `collectCells`）のマス多角形＋天端（番号×蹴上、厚み 0）を返し、`planSolids.js` が `stairTread` 立体にする。**遮蔽専用**（`drawEdges:false`・`S4_DRAWN_KINDS` に入れない）——階段の線を描くのは `StairLayer` だけ（二重に出さない）。`SURFACE_KINDS`（面材）に入れ、同点の梁・下階の壁は段に隠れる。
- 蹴上は**層ごとに1本**（`riserForLayer`）: 直上の層があればその階高から（`riserOf`。明示の `stair.riser` 優先）、最上の層（自階）は `opts.riserOf`。下階に自階の蹴上を使うと階高の違う階でずれる。求まらない階段は立体にしない（遮蔽しない）。view は常に `upper`（install は破れ位置で打ち切られる）、insetView は自階 `install`・下階 `upper`。切断面より上の段は解決器が捨てる。SWITCHBACK の踊り場の天端は `landingZ` と一致。
- 実データ（21 文書 59 階）で消えた可視区間 44（下階の壁 43・床 1、自階 0）。可視長が増えた区間 0。本数は段で分割されるため 512→522 に増えうる。限界: 段の厚み 0／取りつき回転部は平面で追従するが展開図は未追従／OPEN_WELL のアーム幅比は固定 0.3／蹴上不明は遮蔽しない／天端が切断高±0.5mm の段は切断の壁・梁を隠しうる（同点で面材が勝つ）。
