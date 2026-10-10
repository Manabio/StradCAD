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
- 階段所属のセル群の区画は対の部屋（`stair.roomId`）の `ceilingZones` に持つ予定。S5 の入力は無効（傾斜と同時に S6）。
- 描画: 部屋は「残り（`zoneId` null）→ 区画の配列順」の面に分かれ（`planSolids` の `source.id` は区画なら `部屋id#区画id`、残りは部屋 id のまま）、同じ高さの境界のグレー化は面のリストを汎用に扱う既存の後処理がそのまま効く。
- undo は仕上げの `withFinishUndo`（`snapshotRoomsState` に区画が入る）。階の複製・検討案コピーは snapshot 全体の線 id 振り直しで区画のセルも新 id になる。
- 既知の限界: CL 削除でセルが併合されると区画の旧キーは解けず、そのセルは部屋の CH に戻る（受容）。階段の上下階同期（`stairFloorSync`）は区画を複写しない。

## 今後（裁定待ち）
- 天井芯は未実装。
- 区画を持つときは「同じ高さ・同じ材は1面」へ寄せるのが筋（下の見切り線の後処理はその暫定）。
- 天井面の高さは部屋の床段差を含む（裁定）が、壁の上端（`planSolids.js wallCeilZ`）は床段差を含めない。両者がずれる部屋（段差のある部屋）では天井と壁の高さが揃わない。
