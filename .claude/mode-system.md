# モードシステムの設計意図

各モードの状態フィールド一覧は`modes/*.js`を読めば分かるため省略する。

## なぜReact hooksではなくMobX observableクラスか
Reactフックはコンポーネント外の`import()`非同期ロードと組み合わせられない。MobXクラスは`dispose()`で確実にreactionを解放できる。

## modeRef（同期）とmode（observer用）の二重参照
イベントハンドラ（同期処理）は`modeRef.current`、JSX描画は`mode`（MobX state、observerが追跡）を使う。同じインスタンスを指すが用途で使い分ける。

## モード切替時はsetMode(null)を同期的に呼ぶこと
`handleModeChange`等のイベントハンドラ内で状態更新前に`setMode(null)`を呼ばないと、切替直後の1レンダリングで旧モードのインスタンス（古いgraphを抱えたまま）がモード固有パネルに渡り、型不一致でクラッシュする（例: finishパネルが旧FloorplanModeStateを受け取る）。

## モード間で共有しない状態はApp.jsx側のref/stateに置く
ジェスチャー追跡用の一時ref（drawDownRef, gutterCLRef等）はモードモジュールに入れない。モード固有の永続的な状態のみモードクラスに置く。ポインタ配線のカスタムフック`interaction/usePointerInteraction.js`も同じ理由でApp.jsx側に含める（modes/には置かない）。

## ガター操作とキャンバス操作は完全に分離する
ガター内の`pointerDown`は通常の`longPress`を呼ばず`gutterLongPress`を使う。ガター内ではスナップも無効。新しいガター操作を追加する際もこの分離を維持する。天伏モードはガター内がパンだけで、描画エリアはセルのドラッグ選択と汎用`longPress`（天井芯のメニュー）を共有する（成立で`onFire`がドラッグ選択を捨てる。`moveState`中は汎用のCL移動へ落とす）。

## フロア切替直後の古いgraph参照に注意
`switchFloor`はasync。完了直後は`project.activeGraph`を直接読み直すこと。イベントハンドラのローカル変数`graph`（render時点のクロージャ）は古いフロアを指す。詳細は`.claude/floor-design.md`参照。

## モード境界処理はレジストリ（App.jsxのmodeBoundaries）に登録する
モードの突入（enter）・脱出（exit）境界処理は、モード切替（handleModeChange）・モード維持階切替（switchFloorKeepingMode）・平面帰着切替（handleFloorSwitch）が共通に参照する表に登録する。新モードへ境界処理を追加するときは、ハンドラごとのif分岐や個別実装ではなく必ずこの表へ登録すること——経路ごとに適用漏れが起きると「境界確定されないままデータが取り残される」バグ（例: 他階の伏図に構造部材が入らない）が再発する。

## モード境界でgraphを変える処理は必ずundoエントリを積む
履歴ナビゲーション（またぎundo）はモード切替を「素の切替」で再現し、`handleModeChange`の境界同期を再実行しない。境界処理にgraph変更を追加するときはundoエントリが必須（`.claude/undo-redo.md`）。

## 壁の鮮度リフレッシュは階切替に足さず、3境界（仕上げ脱出・構造脱出・読込み）で全階を回す
`wallRefresh.js`の`refreshWallsAllFloors`（壁の再生成をFinishModeStateから独立させる計画）は、仕上げモード脱出・構造モード脱出・文書読込み（`store.js`の`bootReady`）の3つの境界からだけ呼ぶ。階ごとのフック（階切替の`reflectOtherFloors:false`経路等）には足さない——階切替は履歴ナビの「素の切替」（上記）と衝突し、切替のたびに全階の鍵不一致を検出・再生成すると、素の切替のはずが裏で壁を書き換える予期しない副作用になる。

階切替（`switchFloorKeepingMode`）が仕上げ脱出へ渡すのは「省く判定」（`floorSwitch: true`のときだけ省略の印を渡す。ユーザー裁定2026-10-05）だけで、この方針は変えていない。省く条件・保守上の注意は`.claude/data-model.md`「内周壁は鮮度キーが…」節。

## 仕上げ脱出は他階を処理する前にアクティブ階を IDB へ書く（構造脱出と同じ）
仕上げ脱出（`runFinishExitBoundary`）は、自階の壁再生成と undo 登録のあと、上階の階段内装同期・構造反映・他階の壁 sweep より前に、再生成直後の自階を floors ストアへ書く（App.jsx の `finish.exit` が `saveActiveFloorFn: saveFloor` を渡す。構造脱出の `runStructuralExitBoundary` と同じ serializeGraph→saveFloor）。理由: 他階の処理はいずれも自階を `floorSwapManager.peek`（IDB）で読む一方、アクティブ階の auto-save は dirty 印だけで IDB へは書かない。書かないと階段指定前の古い自階を読んで他階の壁（直下階の階段の下り口など）を誤って作り、その鮮度キーが新値で保存されて後から直らない。無編集で省く脱出（stamps）は書かない（IDB と一致しているはず）。

## モード内部の非同期initに個別の関門は不要
モードの突入境界（`modeBoundaries[x].enter`）は`handleModeChange`/`switchFloorKeepingMode`の`runBusy`本体から呼ばれる内部関数。階切替とdeferでない突入（finish・elevation等）は関門の中で完了まで待つ。`deferEnterOnModeChange`を持つ突入（構造・建具の**モード切替**のみ。App.jsx≈736/751）は画面切替を先行させるため意図的に関門の外で完了する（`entered.catch(console.error)`——背景処理＝層1として扱い、衝突する層2の入口は`structuralSync.whenIdle()`で待つ）。新しい非同期UI入口をApp.jsxに足すと分類テスト（`uiBusyClassification.test.js`）が赤になり分類を強制する——詳細は`.claude/floor-design.md`「入力の関門（uiBusy）」。

