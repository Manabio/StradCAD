# 階・Plane設計の意図

Planeのフィールド一覧・floorNumber.jsの関数シグネチャは`core/plane.js`/`floorNumber.js`を読めば分かるため省略する。

## データ帰属の境界線
通り芯（labeled struct CL）のみ全階共通（`projects` IDBストア）。中心線・補助線・寸法線・壁・図形・部屋は階固有（`floors`/`savedFloors` IDBストア）。Planeメタデータ（startFloor/stories/name/isRoofPlane等）一覧は`projects`ストアの別レコード（`graphSnapshot.js`のserializePlanes/decodePlanes）として明示保存（保存メニュー）時のみ永続化され、起動時に`floorOps.js`のreconcilePlanesで復元される——保存していないplaneの追加・削除・改名はリロードで失われる。

## elevation昇順 = startFloor昇順は不変条件
採用フロアは常にこの対応が成立するよう、追加・削除・並び替え・階変更のたびに連鎖再計算する。崩れるとFloorTabsの表示順と階数表記が食い違う。

## 屋根専用平面（isRoofPlane）はproject.planes/orderedTabsから除外される
構造モード専用の合成平面で、`project.roofPlane`から個別にアクセスする。フロアプラン・仕上げモードのタブには現れない。屋根専用平面は常に最上階（`project.planes`の末尾）に付く。最上階のidが変わる操作でも**作り直さず**、`floorOrderFollowers`の`roofPlaneHeight`（`followRoofPlaneToTop`）が`roofForPlaneId`を付け替え、高さ・階番号・階数を合わせる（中身は持ち越す。下記「階の並びを変える操作が他の階へ波及する処理」節、規則の詳細は`.claude/structural-model.md`）。階操作のundo記録は平面の新設・削除を記録しないので、作り直すとundoで旧屋根平面が戻らない。付け替えなら同じidのままなので、undo/redoの最後の`followRoofPlaneToTop`が紐づけを並びから戻す（`.claude/undo-redo.md`）。

## 構造モード中のフロア切替はappModeをリセットしない
通常の`handleFloorSwitch`は`appMode`を`'floorplan'`に戻すが、構造モード中にフロアタブ（屋根タブ含む）をクリックした場合は`handleStructuralFloorSwitch`を使い`appMode==='structure'`を維持する。`FloorTabs`の`onSwitch`はappModeで両ハンドラを切り替える。

## フロア切替後はproject.activeGraphを直接読み直す
`switchFloor`はIDBスワップを伴うasync処理。完了直後にイベントハンドラのローカル変数`graph`（render時点のクロージャ）を使うと古いフロアを指してしまう。

## 構造モードの図面呼称はフロアタブのラベル自体を書き換える
別枠のタイトル表示は持たない。`computeStructuralDesignation`の判定木は自階基準（タブ番号と図面呼称の番号を一致させるため）。最下階は視点に関わらず常に基礎伏図。

## 入力の関門（uiBusy）と階切替の先読み＋同期確定
awaitをまたいでgraph／IDBを書くUI入口（層2）は`uiBusy.js`の`runBusy`で包む。同期編集（層0）と背景の構造同期（層1。`structuralSync.js`）は対象外——それぞれ自前のwhenIdle()を持つ。利用者は階切替・モード切替・undo/redo（App.jsxの5経路）に加え、CL削除・入替え・偏芯・出幅編集・移動準備（`FloorplanModeState.startMove`内）（入力規制ステップ3）、保存・読込み・カタログ保守（開く／適用）（ステップ5）、階操作（階追加・検討案の追加/コピー/削除・並替・階変更・階削除）（ステップ6・途中階の上階追加と階移動の振り直し一本化で並替・階変更を追加）。関門自体は排他制御（mutex）を持たない薄い深さカウンタで、入れ子（undo内の`switchHistoryContext`が`switchFloor`を呼ぶ等）は深さで自然に処理する。

階を選ぶドラムロール（`FloorDrum.jsx`。判断は純モジュール`ui/floorDrumLogic.js`）は、選んだ瞬間から切替の決着まで選んだ階を表示の基準にする（保留中の選択）。決着（成功・失敗・関門に無視）で外し、失敗・無視のときだけ実際の階へ戻る。決着待ち中の再入力は無視する。`guardUi`が決着をドラムへ伝えるためPromiseを返す（busyのときは何もしない）。ユーザー裁定2026-10-05「戻る状態は見せず、入力規制が必要なら入れて、UIだけでも即応させて」。

遮断点は4つ: 全画面オーバーレイ（`ui/BusyOverlay.jsx`。400ms遅延でlabelも表示）・キーボードのcapture keydown（`isUiBusy()`で`stopImmediatePropagation`）・`guardUi`（UIコールバック層）・ポインタ入口の`isUiBusy()`ガード（`usePointerInteraction.js`のhandlePointerDown/handleTouchStart本体先頭。オーバーレイに対する二重防御）。関門直前の中断（`resetGestureRefs`）は長押しタイマー（`useLongPress`の`abort()`）の停止を含む——refを戻すだけではsetTimeoutが関門の中で発火してしまう（入力規制ステップ4）。

不変条件: (1)最初のawaitより前に同期で`runBusy`へ入る、(2)`beginUiTransition()`は`runBusy`より前——例外は理由付きで分類表の`noBeginUiTransition`に記録する（階操作のundo/redoクロージャ・`FloorplanModeState.startMove`。いずれも呼ぶと今の操作/準備中の移動を壊す）。`withFloorOpUndo`の全呼び出し箇所（階削除を含む）では、呼び出し元が直前に`beginUiTransition()`を呼ぶ（横断テストで固定）、(3)`structuralSync.whenIdle()`は関門の中で待つ、(4)失敗の表示は`guardUi`層に一本化——固有の文言を持つ入口（performUndo/Redo・handleModeChange・handleSaveConfirm・runDocumentImport）だけ自前catch、(5)関門の中でユーザーの回答を待たない、(6)App.jsxの全async入口を分類（分類テスト`uiBusyClassification.test.js`。`FloorplanModeState.startMove`と`CatalogMaintenancePanel`内部は各自のwiringテストで固定）（入力規制ステップ1〜7・2026-09-28）。モード維持の階切替（`switchFloorKeepingMode`）では、切替後の表示同期（`setActiveFloorId`・`afterFloorSwitch`・リセット）は`enter`の成否によらずfinallyで行う（2026-10-13）。

`store.js`の`switchFloor`は関門の中で`FloorSwapManager.swap`を呼ぶ。`swap`の不変条件は3つ:
- **中間状態を観測者に見せない**——次階の復元・現階のクリア・アクティブ切替を1つの`runInAction`で同期確定する。「アクティブ階だけ切り替わって中身がまだ空」「中身は復元済みだがアクティブ階が古いまま」のどちらも一度も観測されてはならない（崩れると`renderer/gutterLabelHits.js`のようにフロア切替中の一瞬だけ空データを描画する箇所が事故る）。
- **失敗時は現階を巻き込まない**——保存・読込みの失敗／安定しない／復元先の壊れたバイト列のいずれも、現階を元の内容のまま・アクティブも変えずauto-saveを再開してrethrowする。
- **次階への横からの書込みを世代で検知する**——`floorWriteGeneration`で次階の読込み内容が最新かどうかを確認し、割り込みがあれば読み直す。

## 階の並びを変える操作が他の階へ波及する処理
階の並びを変える操作（上階追加・途中階への挿入・下階追加・削除・並替・階変更）は必ず「振り直し（`floorOps.js`の`renumberPlanesFrom`1つ。最下階を基準に上を各階の階高×層数で積み直す）→`floorOrderChange.js`の`applyFloorOrderChange`」の1経路を通る。App.jsxは振り直しループも追従処理の列挙も持たない（`startFloor`／`elevation`／`stories`への直接代入が無いことを配線テストで固定）。ただし地階（表示中の階の`startFloor < 0`）での上階追加だけは例外で、`computeFloorInsert`が`renumberPlanesFrom`を使わず表示中の階とそれより下の採用階だけをnずらす（地上階の番号・高さは動かさない。ユーザー裁定2026-10-01）。その逆で、地階の削除（`computeFloorDeleteReorder`）は削除した階より下の地階だけを上へ詰める（番号＋層数・高さ＋削除した階の高さ。上の階・地上階は動かさず`normalizeFirstFloorZero`も通さない。地上階の削除は従来どおり上を下へ詰める。裁定2026-10-22。全階が地階の並びでも同じ）。

階高は固定の3000ではなく、**操作前の並び**の隣り合う`elevation`差（`floorHeights.js`の`storyHeightsMm`。最上階は`topStoryHeightMm`）から採って各階が自分の階高を保つ（階設定表S3・裁定2026-10-20）。削除後の並びの差には削除した階の分が入るため、削除は削除前の並び（`planesBefore`）から採る。最上階が入れ替わる操作（並替・削除・最上階への挿入）は、新しい最上階の`topStoryHeightMm`に「それまでの自分の階高」を書く（`opts.topHeightMm`＝`resolveTopStoryHeightMm`を渡したときだけ）。挿入の新階は直下階の階高を継ぎ、最上階の上への挿入だけは元の最上階の階高も直下階の階高に置き換わる（直下階が無い1階建ては自分の値を保つ）。下階追加の新階は元の最下階の階高を継ぎ、地階分岐のずらし量も新階の階高×nで、いずれも1FL=0を保つ。`topStoryHeightMm`は最上階だけが読む値なので、最上階でなくなった階に古い値が残っても害はなく、最上階になる操作で必ず上書きされる。並べ替え・削除（地階の削除を除く）・階変更は最後に`normalizeFirstFloorZero`で、振り直し後に`startFloor===1`になる階が`elevation`0になるよう全採用階を同量ずらす（最下階アンカーだと地階を含む並びで1FL=0が外れるため。挿入・下階追加は1階を動かさない経路なので通さない）。壊れたデータで導いた階高が正の有限値でなければ3000に置き換える。階操作のredoは追加階を作り直さず同じインスタンスで戻す（`restoreRemoved`）。記録の無い階だけ`restoreRemovedPlanes`が`addFloor`で作り直し、そのとき`topStoryHeightMm`も渡す。

追従処理（`floorOrderFollowers`。登録順＝実行順、`before`＝並び変更前、`run`＝後、`run`が`false`を返すと以降を止める）は登録制のレジストリにまとめる（`modeBoundaries`と同型）。既定の登録順（追加系）は屋根平面の紐づけと高さ（`roofPlaneHeight`。`followRoofPlaneToTop`で最上階へ付け替え、高さ・階番号・階数を合わせる。作り直しはしない）→昇降機の複製（`elevatorCopy`）→階段の複製（`stairCopy`）→地階の外壁CLの複製（`basementCenterLines`。ADD_LOWERで新階が地階のときだけ）→地階構造の書込み（`basementInit`。同条件）→外壁内側の部屋（`exteriorRoom`。INSERTのみ）→階段吹抜けの整合（`stairVoidReconcile`。全種別。採用階の隣接全ペアを`reconcileStairVoids`で整える。`.claude/stair-model.md`「上階展開のモデル」）→主屋根の引き継ぎ（`mainRoofCarry`。INSERTのみ。上に階を追加して最上階が入れ替わったとき旧最上階の主屋根の値を新しい最上階へ写す。設計意図は`.claude/roof-model.md`）→新階への切替（`switchToAddedFloor`）→全階の構造反映（`structuralReflect`）→昇降機の再採番（`elevatorRenumber`。DELETEのみ）。挿入・下階追加・削除で元々違っていた順序は`appliesTo`（各followerがどの`FLOOR_ORDER_KIND`に効くか）の違いで同じ配列に両立させている。**`stairVoidReconcile`を`stairCopy`・`exteriorRoom`の後ろに置く理由**: 先に整合すると新階の足元へSTAIR_VOIDが付き、写した階段と二重になる／上の階の吹抜けが孤児として未定義化される。`stairCopy`を`exteriorRoom`の前に置く理由は、部屋は割当済みセルを除くので階段の足元から自然に外れるため。`switchToAddedFloor`より前に置く理由は、切替後は`ctx.sourceGraph`が古い束縛になるため。屋根平面の付け替え・高さ追従を先頭に置く理由は、構造反映が屋根平面を読む前に紐づけと高さを合わせる必要があるため。削除・並替・階変更にも構造反映を伴わせる理由は、1つ下の階の壁に依存する梁芯・部材番号の階表記が変わるため。階段や昇降機の同期仕様が今後変わっても、登録先のfollowerだけ直せば挿入・下階追加・削除・ドラッグ移動・階変更の全経路に効く。

追加系のfollowerは`ctx.sourceGraph`（階追加を実行したときの表示階＝**写し元は常に当該階**）と`ctx.addedPlanes`（新しい階すべて。下階追加は`addFloor`をn回呼ぶので複数、INSERTは1つ）を受ける。`sourceGraph`が無いと`stairCopy`などは`throw`する（呼び出し側の渡し忘れを黙って空振りさせない）。検討案には写さない。**階削除は他の階の階段を消さない**: 階段は1階段＝1層分で独立（2026-10-06裁定）なので、かつて直下階の階段を巻き込んで消していた`stairsBelowRemoval`は撤去した。削除後のSTAIR_VOIDは`stairVoidReconcile`が新しい並びに合わせて整える。自動生成した階段・昇降機の行は新階そのものに置くので、新階を削除すれば平面ごと消え、保存形式に「自動生成の印」は要らない。

## 階追加・階削除の入口（[+]・[-]ボタン。2026-10-21）
[+]は検討案の表示中は出さない（グレー表示にしない）。[-]は採用階の表示中だけ出し、最下階（唯一の階を含む）・屋根専用平面・検討案の表示中は出さない（`ui/floorChipModel.js`の`floorDeleteButtonState`が表示条件と確認文言を持つ）。確認文言は検討案があれば「検討案も一緒に削除されます」を足す。削除は表示中の採用階とその検討案を一緒に消す。チップの採用メニューに階削除は置かず、検討案の削除（`delete-alt`）だけを残す——採用階の削除の入口を[-]の1つにするため。

追加の入口は`floorOps.js`の`resolveAddFloorEntry`が決める（Q21案A）。地階の表示中は最下階でもダイアログなしで即時の上階追加（INSERTの地階分岐。「下階」は最下階が地上階のときだけ＝地階の下へさらに足すのは地階での上階追加）。地上階の表示中はダイアログで、**最下階が地上階のときだけ「下階 1階分」**（固定。n階分の入力を出さない）を選べる。下階追加が起きるのは実質「1階から最初の地下1階を足すとき」だけで、n>1の経路はコードに残るがUIからは通らない。階削除はundoできる（`.claude/undo-redo.md`）。

## 階設定表の確定（階高・GL。`FLOOR_ORDER_KIND.HEIGHTS`。階設定表S4・2026-10-20）
確定の計算は`floorHeights.js`の`computeFloorHeightEdit`（純関数）1つ。内部の基準は1FL=0で、nFLの階高を変えると**それより上の地上階だけ**ずれ（下の階・GLは動かない）、地階Bnの階高（BnFL〜直上階FL）を変えるとBnとそれより下の地階だけがずれる（地階は1FLから下へ積む）。最上階の階高は`topStoryHeightMm`にだけ書き、`elevation`は動かない。ずらしは「差分×層数」の累積で足すので、触っていない階の`elevation`には誤差が入らず、旧データの非整数の階高も保たれる（draftには**ユーザーが編集した行だけ**を入れる契約で、入っている値は常に検査し、入っていない行は検査も変更もしない＝型や値の一致で「触った」を推測しない。階高は整数・1450以上・上限なし、GLは整数で負も可。入力テキストは検査前に全角数字・全角マイナスを`halfWidth.js`で半角へ直す）。基準階は`startFloor===1`の階。全階が地階のときは最上の地階を固定して下へずらす（地階の階高を変えたら地階側をずらす、の文言どおり）。

GLは`Project.glBelow1FlMm`でPlaneに属さないため、階操作のundoにはメタ・バイト列と別に`collectProjectLevels`／`applyProjectLevels`で載せ、`diffFloorOpSnapshot`が`levelsChanged`で「変更あり」に数える。追従は`roofPlaneHeight`→`stairRiserFollow`（S8。下の節）→`wallRefresh`→`structuralReflect`の4つだけ（階の並びは不変なので階段の吹抜け・昇降機・主屋根は動かさない）。`wallRefresh`は`refreshWallsAllFloors`で壁の鮮度キーが変わった階（階高を変えた階。キーの`fh`＝`floorHeightAbove`）だけ壁を作り直し、そのとき構造再計算まで済むので`structuralReflect`は省く（二重にしない）。`updates`が空（GLだけ・変化なし）なら両方とも何もしない。自階は他階の処理の前にIDBへ書く（直上階の階段文脈が自階をpeekするため）。仕上げモード中は`skipActiveWalls`で自階の壁再生成を外す（仕上げ脱出の全再生成に任せる）が、直上階の再生成が古い自階をpeekしないよう自階の保存だけは他階の前に行う（仕上げ・構造の脱出境界と同じ保存）。`wallRefresh`が失敗（reject）すると`structuralReflect`は走らず、`elevation`は書かれたまま止まる（巻き戻しは呼び出し側）。蹴上の追従は下の「蹴上の確認・追従と最高の軒の高さ」。

### 階設定表ダイアログ（S5・2026-10-20）
入口は横長フロアドラム（`FloorWheel`）の**長押し**（500ms・移動8px以内・`useLongPress`）。押した位置の階は`indexAtPointer`（ドラム中心からのずれ）で決め、その行を選択状態で開く。S6（裁定2026-10-20）で入口を3つ足した。(1)**マウスの右クリック**（ドラム・ピル上だけ`preventDefault`、押した位置の階で開く。`contextmenu`は直前の`pointerdown`が`mouse`のときだけ開く＝タッチ/ペンの長押しでも来る`contextmenu`と二重にしない。右・中ボタンの`pointerdown`はドラッグも切替も始めない）、(2)**構造モードのスロット**（行idは`slotType:planeId`なので`floorSettingsPlaneIdForSlot`で読み替え。基礎伏図・地中梁図＝最下階、R階伏図・小屋伏図＝最上階〔屋根専用平面idは採用階に無い〕、他は対応する採用階）、(3)**縦長のピル**（`PillButton`。長押し規則は`useFloorLongPress`を横長と共有。成立後のクリックは切替にしない。移動・`pointercancel`・ポインタ離脱で取消し。タッチは`pointerenter`でピルが入れ替わると長押しが成り立たないため展開はタップのみ）。長押しが成立したら離しても`requestSwitch`を呼ばない。ドラッグが始まれば取り消す。**長押しタイマーは`resetGestureRefs`の対象外**なので、`FloorWheel`が自前で止める（`isUiBusy()`の`reaction`で関門開始時に`abort`、切替要求の決着待ちでも`abort`、発火時にも決着待ち・関門を再確認）。ここを外すと関門の中で500ms後にダイアログが開く。

入力中は他の操作を受けない。ダイアログはモーダル（背景の押下は無視。編集中の値を不意に捨てない）で、ダイアログ外にフォーカスがあってもキー入力を`window`のcaptureで止める（Ctrl+Z等を後段へ渡さない。Escapeだけキャンセル）。uiBusyの関門に入るのは**確定（OK）の間だけ**（`guardUi(runFloorHeights)`→`withFloorOpUndo`の`runBusy`）。入力中に関門を開けっぱなしにするとundo・保存・階切替の全入口が塞がるうえ、「関門の中でユーザーの回答を待たない」に反する。表示と検査は`floorSettingsRows`（純）が持ち、図は入力に即時追従（不正な欄は編集前の値扱い）。確定は`computeFloorHeightEdit`で再検査してから反映する。

**図のみ（2026-10-20改訂）**: ダイアログは表を持たず、図（`sectionDiagramModel`＝線と寸法のmm → `layoutFloorSettingsFigure`＝px座標。どちらも`floorHeights.js`の純関数。`floorSettingsRows`の結果から作る）だけで編集する。水平のレベル線（軒桁上端・nFL・GL。ラベルの▽の先端が線に乗る。軒桁上端・GLは長く、FLは短い。線の色・太さは全て同じ・実線〔GLも色を変えず破線にしない〕。**GLの▽とラベルは最高軒高の寸法線より左**に置き、軒桁上端▽・FL▽は中央）、**右の寸法鎖＝各階の階高とGL〜1FLの入力欄**（寸法線の中央に絶対配置。**線が寸法線をまたぐ**＝寸法線は線の右端より少し内側で、線は補助線のように先へ出る。欄は寸法線の右で、線の右端付近に重なるが2本の線の間に収まる。複層の2層目以降は表示のみ）、**左の寸法＝最高軒高**（GL〜軒桁上端の区間。文字はGL▽と重ならないよう値の行をGL線の上に保つ。自動・入力なし。値は`maxEaveHeightMm`の結果1つで、軒高の別行や`nFL (GL+mm)`の列は同じ情報の二重書きになるので持たない）。縦は0.04px/mmの比例だが隣り合う線の間は最小36px（入力欄が入る高さ）。図は1:1pxで描き（viewBoxで縮めない）、階が多いときは図の部分だけ`max-height:60vh`でスクロールする（ボタンは外）。GLと1FLが同じ高さでもGL線は独立に引く（GL欄の位置が要る。GL〜1FLの寸法は「0」）。欄にフォーカスするとNumPadを出す（`inputMode="none"`でOSのキーボードを抑え、物理キーボードは欄が直接受ける。NumPad側のkeyboardは使わない＝二重入力しない）。NumPadの✓は式を計算して閉じるだけで次の欄へは移らず、✕も閉じる。

### 蹴上の確認・追従と最高の軒の高さ（S8・ユーザー裁定2026-10-20）
階段の蹴上は設置階の`floorHeightAbove`（複層は全高）と総段数で決まるので、階高を変えると**確定前後の`floorHeightAbove`が変わる階**（自階の階高に限らず複層・地階の変更でずれる階も）の階段が対象になる（`stairRiserFollow.js`の`stairRiserChanges`が前後を比べて決める）。**蹴上を明示した階段も**展開図に不整合を出さないため、総段数を保ったまま新しい階高÷総段数へ書き換える（推奨の「明示は触らない」とは異なる裁定）。明示の無い階段は`riserOf`が自動で追従するので書かないが、値が変わる階段は全部、確認・トースト・印の対象。OKを押したとき対象があれば**確定の前にダイアログ内で**「階段N（○->△階）: 蹴上 ○→○」を出して確認する（はい→`onConfirm`／いいえ→表に戻る。値を変えると確認はやり直し）。確認を関門（`runBusy`）の外・`onConfirm`の前に済ませるのは「関門の中でユーザーの回答を待たない」ため。確認に使う階段の要約と下屋のある階は、表を開くときに全採用階から集める（`floorSettingsFacts.js`。他階はpeek＝IDB読込みなので`openFloorSettings`が`runBusy`の中で行う。読めない階があれば表を開かない）。書き換えは`stairRiserFollow`が`wallRefresh`より前に行う（蹴上は壁の鮮度キーの入力）。階高が変わった階だけを1階1回のpeek→全変更→1回の保存で処理し、undoは`withFloorOpUndo`の全階バイト列に載る。トーストと、仕上げモードの階段の蹴上欄の印（今の蹴上が更新後の値と一致する間だけ。欄の編集・undoで消える）は`Project.riserAutoUpdated`の一時状態で、保存しない。

最高の軒の高さ（階設定表の図の左の寸法「最高軒高」）は主屋根の軒高と下屋の軒高の最大値（`maxEaveHeightMm`）。下屋の軒高＝GL＋下屋が**覆う階**のFL＋覆う階の階高＝GL＋**屋根セルが付く階のFL**（屋根セルは覆う階の1つ上の階に付く。例: 2階建てで1階だけ張り出す下屋は屋根セルが2階に付くので軒高は2FL。最上階に屋根セルがあっても同じ式で最上階のFL。構造の軒桁は読まない。ユーザー裁定2026-10-20）。屋根セルが付く階は`roofSpec`を持つ屋根の部屋がある階。建築情報ダイアログにはつながない。

`withFloorOpUndo`はGL（levels）を採って undo/redo で戻し、**屋根専用平面（`project.roofPlane`）を最後に`followRoofPlaneToTop`で最上階へ付け替え・追従**させる（紐づけ・高さはスナップショットに記録せず、階の並びから戻す。中身のバイト列は`collectFloorBytes`が採用階と同じく前後で採る）。`rollbackOnError`（HEIGHTS が指定）では`run`が例外を投げたとき、メタ・GL・屋根平面・変わった階のバイト列を操作前へ戻してから投げ直す（`wallRefresh`が途中で失敗しても`elevation`・壁が半端に残らない。他の階操作は従来どおり巻き戻さない。実体は`floorOps.js`の`rollbackFloorOp`で、run の失敗と操作後のバイト列採取の失敗の両方が対象。アクティブ階はメモリと IDB の両方へ、非アクティブ階は IDB へ await して戻す。既知の限界: structGraph は階操作の undo と同じく対象外。屋根専用平面のバイト列は戻る）。ダイアログ外のキーは preventDefault して止め、Tab はダイアログ内で循環させる（外へ出ると Enter/Space で背景のボタンが押せてしまう）。確定後（undo/redo・失敗時の巻き戻しも）は図を作り直す: 平面の断面（上下階のpeek）は`floorSyncTick`、展開・天伏は`catalogReloadKey`でモード状態ごと作り直す（モードに入り直すのと同じ。実行時のモードを`appModeRef`で見る）。
