# 階・Plane設計の意図

Planeのフィールド一覧・floorNumber.jsの関数シグネチャは`core/plane.js`/`floorNumber.js`を読めば分かるため省略する。

## データ帰属の境界線
通り芯（labeled struct CL）のみ全階共通（`projects` IDBストア）。中心線・補助線・寸法線・壁・図形・部屋は階固有（`floors`/`savedFloors` IDBストア）。Planeメタデータ（startFloor/stories/name/isRoofPlane等）一覧は`projects`ストアの別レコード（`graphSnapshot.js`のserializePlanes/decodePlanes）として明示保存（保存メニュー）時のみ永続化され、起動時に`floorOps.js`のreconcilePlanesで復元される——保存していないplaneの追加・削除・改名はリロードで失われる。

## elevation昇順 = startFloor昇順は不変条件
採用フロアは常にこの対応が成立するよう、追加・削除・並び替え・階変更のたびに連鎖再計算する。崩れるとFloorTabsの表示順と階数表記が食い違う。

## 屋根専用平面（isRoofPlane）はproject.planes/orderedTabsから除外される
構造モード専用の合成平面で、`project.roofPlane`から個別にアクセスする。フロアプラン・仕上げモードのタブには現れない。最上階が変わるとデータは作り直しになる（古い屋根平面は削除される）。

## 構造モード中のフロア切替はappModeをリセットしない
通常の`handleFloorSwitch`は`appMode`を`'floorplan'`に戻すが、構造モード中にフロアタブ（屋根タブ含む）をクリックした場合は`handleStructuralFloorSwitch`を使い`appMode==='structure'`を維持する。`FloorTabs`の`onSwitch`はappModeで両ハンドラを切り替える。

## フロア切替後はproject.activeGraphを直接読み直す
`switchFloor`はIDBスワップを伴うasync処理。完了直後にイベントハンドラのローカル変数`graph`（render時点のクロージャ）を使うと古いフロアを指してしまう。

## 構造モードの図面呼称はフロアタブのラベル自体を書き換える
別枠のタイトル表示は持たない。`computeStructuralDesignation`の判定木は自階基準（タブ番号と図面呼称の番号を一致させるため）。最下階は視点に関わらず常に基礎伏図。

## 入力の関門（uiBusy）と階切替の先読み＋同期確定
awaitをまたいでgraph／IDBを書くUI入口（層2）は`uiBusy.js`の`runBusy`で包む。同期編集（層0）と背景の構造同期（層1。`structuralSync.js`）は対象外——それぞれ自前のwhenIdle()を持つ。利用者は階切替・モード切替・undo/redo（App.jsxの5経路）に加え、CL削除・入替え・偏芯・出幅編集・移動準備（`FloorplanModeState.startMove`内）（入力規制ステップ3）、保存・読込み・カタログ保守（開く／適用）（ステップ5）、階操作（階追加・検討案の追加/コピー/削除・階削除）（ステップ6）。関門自体は排他制御（mutex）を持たない薄い深さカウンタで、入れ子（undo内の`switchHistoryContext`が`switchFloor`を呼ぶ等）は深さで自然に処理する。

遮断点は4つ: 全画面オーバーレイ（`ui/BusyOverlay.jsx`。400ms遅延でlabelも表示）・キーボードのcapture keydown（`isUiBusy()`で`stopImmediatePropagation`）・`guardUi`（UIコールバック層）・ポインタ入口の`isUiBusy()`ガード（`usePointerInteraction.js`のhandlePointerDown/handleTouchStart本体先頭。オーバーレイに対する二重防御）。関門直前の中断（`resetGestureRefs`）は長押しタイマー（`useLongPress`の`abort()`）の停止を含む——refを戻すだけではsetTimeoutが関門の中で発火してしまう（入力規制ステップ4）。

不変条件: (1)最初のawaitより前に同期で`runBusy`へ入る、(2)`beginUiTransition()`は`runBusy`より前——例外は理由付きで分類表の`noBeginUiTransition`に記録する（階追加のundo/redoクロージャ・`FloorplanModeState.startMove`。いずれも呼ぶと今の操作/準備中の移動を壊す）、(3)`structuralSync.whenIdle()`は関門の中で待つ、(4)失敗の表示は`guardUi`層に一本化——固有の文言を持つ入口（performUndo/Redo・handleModeChange・handleSaveConfirm・runDocumentImport）だけ自前catch、(5)関門の中でユーザーの回答を待たない、(6)App.jsxの全async入口を分類（分類テスト`uiBusyClassification.test.js`。`FloorplanModeState.startMove`と`CatalogMaintenancePanel`内部は各自のwiringテストで固定）（入力規制ステップ1〜7・2026-09-28）。

`store.js`の`switchFloor`は関門の中で`FloorSwapManager.swap`を呼ぶ。`swap`の不変条件は3つ:
- **中間状態を観測者に見せない**——次階の復元・現階のクリア・アクティブ切替を1つの`runInAction`で同期確定する。「アクティブ階だけ切り替わって中身がまだ空」「中身は復元済みだがアクティブ階が古いまま」のどちらも一度も観測されてはならない（崩れると`renderer/gutterLabelHits.js`のようにフロア切替中の一瞬だけ空データを描画する箇所が事故る）。
- **失敗時は現階を巻き込まない**——保存・読込みの失敗／安定しない／復元先の壊れたバイト列のいずれも、現階を元の内容のまま・アクティブも変えずauto-saveを再開してrethrowする。
- **次階への横からの書込みを世代で検知する**——`floorWriteGeneration`で次階の読込み内容が最新かどうかを確認し、割り込みがあれば読み直す。

## 階の追加・削除が他の階へ波及する処理
階追加（`App.jsx`の`syncNewFloorFromSource`）は、階段同期（`syncUpperFloorsAuto`）→昇降機の複製（`copyElevatorsToNewFloor`）→外壁内側の部屋の自動追加（`addNewFloorRoomFromSource`）の順で行う——階段同期の後にすることで新階にできた階段・階段吹抜けを昇降機の衝突判定の相手にでき、部屋の自動追加の前にすることで昇降路のセルが新階の部屋領域から自然に除外される（部屋は割当済みセルを除いて作るため）。直下階＝採用階だけを`elevation`昇順に見た新階の1つ下（下方向への追加はこの同期を呼ばない）。階追加全体は前後比較で1つのundoエントリに記録する（`.claude/undo-redo.md`「階追加は～」節）ため、複製・自動追加はいずれも個別のundoエントリを持たない。

階削除（`App.jsx`の`runDeleteFloor`）は、削除する階が持っていた昇降機の器具行のidを削除前に読み（`readFloorEquipmentIds`）、`removeFloor`の後、直下階の階段削除（`removeStairsOnFloor`）・右側の採用階の階番号振り直しという既存の後始末をすべて終えてから、最後に全階から消えた器具があれば番号を建物全体で詰め直す（`renumberEquipmentAfterFloorRemoval`）——再採番の失敗が既存の後始末を巻き込まないようにする順序。いずれもundo対象外（現行の階削除の扱いに従う）。器具・昇降路の詳細は`.claude/equipment-model.md`参照。
