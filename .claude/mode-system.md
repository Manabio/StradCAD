# モードシステムの設計意図

各モードの状態フィールド一覧は`modes/*.js`を読めば分かるため省略する。

## なぜReact hooksではなくMobX observableクラスか
Reactフックはコンポーネント外の`import()`非同期ロードと組み合わせられない。MobXクラスは`dispose()`で確実にreactionを解放できる。

## modeRef（同期）とmode（observer用）の二重参照
イベントハンドラ（同期処理）は`modeRef.current`、JSX描画は`mode`（MobX state、observerが追跡）を使う。同じインスタンスを指すが用途で使い分ける。

## モード切替時はsetMode(null)を同期的に呼ぶこと
`handleModeChange`等のイベントハンドラ内で状態更新前に`setMode(null)`を呼ばないと、切替直後の1レンダリングで旧モードのインスタンス（古いgraphを抱えたまま）がモード固有パネルに渡り、型不一致でクラッシュする（例: finishパネルが旧FloorplanModeStateを受け取る）。

## モード間で共有しない状態はApp.jsx側のref/stateに置く
ジェスチャー追跡用の一時ref（drawDownRef, stretchDownRef, gutterCLRef等）はモードモジュールに入れない。モード固有の永続的な状態のみモードクラスに置く。ポインタ配線のカスタムフック`interaction/usePointerInteraction.js`も同じ理由でApp.jsx側に含める（modes/には置かない）。

## ガター操作とキャンバス操作は完全に分離する
ガター内の`pointerDown`は通常の`longPress`を呼ばず`gutterLongPress`を使う。ガター内ではスナップも無効。新しいガター操作を追加する際もこの分離を維持する。

## フロア切替直後の古いgraph参照に注意
`switchFloor`はasync。完了直後は`project.activeGraph`を直接読み直すこと。イベントハンドラのローカル変数`graph`（render時点のクロージャ）は古いフロアを指す。詳細は`.claude/floor-design.md`参照。

## モード境界処理はレジストリ（App.jsxのmodeBoundaries）に登録する
モードの突入（enter）・脱出（exit）境界処理は、モード切替（handleModeChange）・モード維持階切替（switchFloorKeepingMode）・平面帰着切替（handleFloorSwitch）が共通に参照する表に登録する。新モードへ境界処理を追加するときは、ハンドラごとのif分岐や個別実装ではなく必ずこの表へ登録すること——経路ごとに適用漏れが起きると「境界確定されないままデータが取り残される」バグ（例: 他階の伏図に構造部材が入らない）が再発する。

## モード境界でgraphを変える処理は必ずundoエントリを積む
履歴ナビゲーション（またぎundo）はモード切替を「素の切替」で再現し、`handleModeChange`の境界同期を再実行しない。境界処理にgraph変更を追加するときはundoエントリが必須（`.claude/undo-redo.md`）。
