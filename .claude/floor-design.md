# 階・Plane設計の意図

Planeのフィールド一覧・floorNumber.jsの関数シグネチャは`core/plane.js`/`floorNumber.js`を読めば分かるため省略する。

## データ帰属の境界線
通り芯（labeled struct CL）のみ全階共通（`projects` IDBストア）。中心線・補助線・寸法線・壁・図形・部屋は階固有（`floors`/`savedFloors` IDBストア）。Planeメタデータ（startFloor/stories/name/isRoofPlane等）一覧は`projects`ストアの別レコード（`graphSnapshot.js`のserializePlanes/decodePlanes）として明示保存（保存メニュー）時のみ永続化され、起動時に`floorOps.js`のreconcilePlanesで復元される——保存していないplaneの追加・削除・改名はリロードで失われる。

## elevation昇順 = startFloor昇順は不変条件
採用フロアは常にこの対応が成立するよう、追加・削除・並び替え・階変更のたびに連鎖再計算する。崩れるとFloorTabsの表示順と階数表記が食い違う。

## 屋根専用平面（isRoofPlane）はproject.planes/orderedTabsから除外される
構造モード専用の合成平面で、`project.roofPlane`から個別にアクセスする。フロアプラン・仕上げモードのタブには現れない。最上階の実体平面のidが変わるとデータは作り直しになる（古い屋根平面は削除される）が、この作り直しは階操作では行わず次の構造モード突入の`syncRoofPlane`に任せる——屋根平面はPlaneメタ・バイト列どちらのundo記録の対象外のため、階操作の時点で作り直すとundoで旧屋根平面が戻らない（`.claude/undo-redo.md`「undo対象外」節）。idが同じまま振り直しで高さ・階番号・階数だけ動いたときだけ、`floorOrderFollowers`の`roofPlaneHeight`（`followRoofPlaneToTop`）が既存の屋根平面の値を書き換える（下記「階の並びを変える操作が他の階へ波及する処理」節）。

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

不変条件: (1)最初のawaitより前に同期で`runBusy`へ入る、(2)`beginUiTransition()`は`runBusy`より前——例外は理由付きで分類表の`noBeginUiTransition`に記録する（階操作のundo/redoクロージャ・`FloorplanModeState.startMove`。いずれも呼ぶと今の操作/準備中の移動を壊す）。`withFloorOpUndo`の全5呼び出し箇所では、呼び出し元が直前に`beginUiTransition()`を呼ぶ（横断テストで固定）、(3)`structuralSync.whenIdle()`は関門の中で待つ、(4)失敗の表示は`guardUi`層に一本化——固有の文言を持つ入口（performUndo/Redo・handleModeChange・handleSaveConfirm・runDocumentImport）だけ自前catch、(5)関門の中でユーザーの回答を待たない、(6)App.jsxの全async入口を分類（分類テスト`uiBusyClassification.test.js`。`FloorplanModeState.startMove`と`CatalogMaintenancePanel`内部は各自のwiringテストで固定）（入力規制ステップ1〜7・2026-09-28）。

`store.js`の`switchFloor`は関門の中で`FloorSwapManager.swap`を呼ぶ。`swap`の不変条件は3つ:
- **中間状態を観測者に見せない**——次階の復元・現階のクリア・アクティブ切替を1つの`runInAction`で同期確定する。「アクティブ階だけ切り替わって中身がまだ空」「中身は復元済みだがアクティブ階が古いまま」のどちらも一度も観測されてはならない（崩れると`renderer/gutterLabelHits.js`のようにフロア切替中の一瞬だけ空データを描画する箇所が事故る）。
- **失敗時は現階を巻き込まない**——保存・読込みの失敗／安定しない／復元先の壊れたバイト列のいずれも、現階を元の内容のまま・アクティブも変えずauto-saveを再開してrethrowする。
- **次階への横からの書込みを世代で検知する**——`floorWriteGeneration`で次階の読込み内容が最新かどうかを確認し、割り込みがあれば読み直す。

## 階の並びを変える操作が他の階へ波及する処理
階の並びを変える操作（上階追加・途中階への挿入・下階追加・削除・並替・階変更）は必ず「振り直し（`floorOps.js`の`renumberPlanesFrom`1つ。最下階を基準に上を3000×階数で決め直す）→`floorOrderChange.js`の`applyFloorOrderChange`」の1経路を通る。App.jsxは振り直しループも追従処理の列挙も持たない（`startFloor`／`elevation`／`stories`への直接代入が無いことを配線テストで固定）。ただし地階（表示中の階の`startFloor < 0`）での上階追加だけは例外で、`computeFloorInsert`が`renumberPlanesFrom`を使わず表示中の階とそれより下の採用階だけをnずらす（地上階の番号・高さは動かさない。ユーザー裁定2026-10-01）。

追従処理（`floorOrderFollowers`。登録順＝実行順、`before`＝並び変更前、`run`＝後、`run`が`false`を返すと以降を止める）は登録制のレジストリにまとめる（`modeBoundaries`と同型）。既定の登録順は屋根平面の高さ（`roofPlaneHeight`。最上階idが同じときだけ書き換え、idが変わる作り直しは行わない）→階段の上階同期→直下階の階段削除→昇降機の複製→外壁内側の部屋→主屋根の引き継ぎ（`mainRoofCarry`。INSERTのみ。上に階を追加して最上階が入れ替わったとき旧最上階の主屋根の値を新しい最上階へ写す。設計意図は`.claude/roof-model.md`）→新階への切替→全階の構造反映（`structuralReflect`）→昇降機の再採番。挿入・削除で元々違っていた順序は`appliesTo`（各followerがどの`FLOOR_ORDER_KIND`に効くか）の違いで同じ配列に両立させている。屋根平面の高さ追従を先頭に置く理由は、構造反映が屋根平面を読む前に高さを合わせる必要があるため。削除・並替・階変更にも構造反映を伴わせる理由は、1つ下の階の壁に依存する梁芯・部材番号の階表記が変わるため。階段や昇降機の同期仕様が今後変わっても、登録先のfollowerだけ直せば挿入・下階追加・削除・ドラッグ移動・階変更の全経路に効く。
