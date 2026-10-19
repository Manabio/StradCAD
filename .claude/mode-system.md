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
ガター内の`pointerDown`は通常の`longPress`を呼ばず`gutterLongPress`を使う。ガター内ではスナップも無効。新しいガター操作を追加する際もこの分離を維持する。天伏モードはガター内がパンだけで、描画エリアは下の押下ジェスチャーの見分けと汎用`longPress`（天井芯のメニュー）を共有する（`moveState`中は汎用のCL移動へ落とす）。

## 描画エリアの押下ジェスチャーは全モード共通に見分ける（2026-10-19）
図面内の任意の点で画面移動できるよう、描画エリアの押下は**クリック／ロングタップ／ドラッグ**の3つに見分け、ドラッグは全モードでパンにする（ユーザー指示 2026-10-19「平面モード以外でも図面内の任意の点で画面移動できる」）。規則は`interaction/holdGesture.js`（純。`TAP_MOVE_PX`=8・`releaseGesture`・`ceilingHoldAction`）にあり、配線は`usePointerInteraction.js`。
- **ドラッグ**＝長押し成立（500ms）前に8px超動いた（`longPress.move`がtrueを返す）→パン。**ロングタップ**＝500ms静止（`onFire`）。**クリック**＝成立前に動かず離した。離したときの見分けは`releaseGesture({fired, panned})`（成立が最優先→パン→クリック）。
- 平面・建具・構造は従来どおり（ロングタップ＝メニュー）。敷地は描画エリアのドラッグがサブモードによらずパン（三斜・その他はタップで線分の入力）。展開は帯のスクロールが画面移動（変更なし）。
- **仕上げ・天伏のセルのなぞり（複数セルの指定）はロングタップ後の移動へ移した**。押下の時点では`startDrag`しない——階段・昇降機・屋根の選択や命名ダイアログを閉じる副作用が、パンのつもりの押下で起きないため。クリックは離したときに押下点のセルで`startDrag`→`commitDrag({tap:true})`（従来の「押してそのまま離す」と同じ処理・同じ結果）。ロングタップ成立で`startDrag`し、動かさず離しても`commitDrag({tap:true})`でクリックと同じ。成立後に`dragState`が無い（階段などを選択済み・選べないセル）なら、動けばパン（反応の無い押下にしない。QA指摘 2026-10-19）。
- **パンの直後の Konva の click は無視する**。Konva は押した図形と離した図形が同じなら移動量によらず click を出すので、パン（図面が指に追従する）の終了直後に階段（`StairLayer`の`onSelectStair`）・敷地線（`SiteLinesLayer`の`onSelectLine`）の選択が走る。パンは`panTo`（`usePointerInteraction.js`。4経路共通）に一本化して移動量を積み（長押し閾値超でパンを始める経路は押下点から既に8px超動いているので積算を`TAP_MOVE_PX`から始める）、`pointerUp`で`TAP_MOVE_PX`以上なら`didPanEnd()`が真。既知の限界: ピンチ（2本指）は`panTo`を通らず積まない（旧来どおり）。`SceneLayers.jsx`の両 click はそれを見て無視する（建具の記号丸の`didOpeningDragEnd`と同じ作り）。
- **天伏はロングタップを全部メニュー（天井芯の追加・移動・削除・延長）に使う**（ユーザー裁定 2026-10-19「選択中の群の上のロングタップは天井芯追加にしたい」）ので、なぞり（区画の作成）は**ドラッグの動き出しの速さ**でパンと見分ける: 押下点から8px超で判定窓（`CEILING_DECIDE_MS`=80ms）を開き、窓の中で`CEILING_PAN_PX`=16pxを超えればパン、超えずに窓が閉じればなぞり（タイマーで`startCeilingTrace`＝押下点のセルから`startDrag`。以後の移動は`updateDrag`）。判定は入口の1回だけで、パンに入った後はどんな速さでも追従する。なぞりができない押下点（選択中の群の外・何も選択していない。押下時に`startDrag`の`intent`で判定して`dragState`はすぐ捨てる＝プレビューを出さない）は8px超で即パン。8px超動いて窓が閉じる前に離したら何もしない。数値は暫定（実機で合わせる）。規則は`ceilingDragStart`。
- 不採用: 「選べるセルから始めたドラッグは選択、それ以外はパン」——「任意の点で画面移動」を満たさない。長押しの輪（`pressPos`）は仕上げ・天伏でも出て、なぞりの開始の合図になる。

## フロア切替直後の古いgraph参照に注意
`switchFloor`はasync。完了直後は`project.activeGraph`を直接読み直すこと。イベントハンドラのローカル変数`graph`（render時点のクロージャ）は古いフロアを指す。詳細は`.claude/floor-design.md`参照。

## モード境界処理はレジストリ（App.jsxのmodeBoundaries）に登録する
モードの突入（enter）・脱出（exit）境界処理は、モード切替（handleModeChange）・モード維持階切替（switchFloorKeepingMode）・平面帰着切替（handleFloorSwitch）が共通に参照する表に登録する。新モードへ境界処理を追加するときは、ハンドラごとのif分岐や個別実装ではなく必ずこの表へ登録すること——経路ごとに適用漏れが起きると「境界確定されないままデータが取り残される」バグ（例: 他階の伏図に構造部材が入らない）が再発する。

## モード境界でgraphを変える処理は必ずundoエントリを積む
履歴ナビゲーション（またぎundo）はモード切替を「素の切替」で再現し、`handleModeChange`の境界同期を再実行しない。境界処理にgraph変更を追加するときはundoエントリが必須（`.claude/undo-redo.md`）。

## 壁の鮮度リフレッシュは平面モードの階切替に足さず、3境界（仕上げ脱出・構造脱出・読込み）で全階を回す。展開・天伏の突入だけは自階と直上・直下を回す
展開・天伏の突入（モード切替・モード維持の階切替とも。`modeBoundaries`の`elevation`/`ceiling`の`enter`）は`refreshWallsForViewEntry`で自階と直上・直下の階だけ鍵を比較し、不一致の階だけ再生成する。平面モードで通り芯・階段・部屋を編集した直後に入ると、断面エンジンが新しい入力と古い壁（隔て壁・階段下部屋2a・柱巻き）を同じ断面で切ってしまうため。2026-09-15の裁定（階切替に足さない）との関係: モード切替は境界を通りundoエントリを積める経路であり、履歴ナビの「素の切替」とは衝突しない。平面モードの階切替・履歴ナビ（素の切替）に足さない方針は不変。自階は無条件に他階のpeekより前にIDBへ書く（仕上げ脱出と同じ理由）。履歴ナビで展開・天伏へ戻るときは境界が走らない（`.claude/undo-redo.md`）。`switchFloorKeepingMode`は`switchFloor`後の`enter`を`try/finally`で包み、`setActiveFloorId`・`afterFloorSwitch`・リセットは`enter`の成否によらず行う（失敗は再throw。2026-10-13）。失敗時に`activePlaneId`だけ新階で`activeFloorId`が旧階（旧Stateが空graphを表示し続け、同階は早期returnで復旧不能）となる不一致を防ぐ。構造モードの`enter`の同型も同時に解消。

`wallRefresh.js`の`refreshWallsAllFloors`（壁の再生成をFinishModeStateから独立させる計画）は、仕上げモード脱出・構造モード脱出・文書読込み（`store.js`の`bootReady`）の3つの境界から全階に対して呼ぶ（展開・天伏の突入は上記のとおり`planeIds`で自階と直上・直下に絞った別入口）。階ごとのフック（階切替の`reflectOtherFloors:false`経路等）には足さない——階切替は履歴ナビの「素の切替」（上記）と衝突し、切替のたびに全階の鍵不一致を検出・再生成すると、素の切替のはずが裏で壁を書き換える予期しない副作用になる。

階切替（`switchFloorKeepingMode`）が仕上げ脱出へ渡すのは「省く判定」（`floorSwitch: true`のときだけ省略の印を渡す。ユーザー裁定2026-10-05）だけで、この方針は変えていない。省く条件・保守上の注意は`.claude/data-model.md`「内周壁は鮮度キーが…」節。

## 仕上げ脱出は他階を処理する前にアクティブ階を IDB へ書く（構造脱出と同じ）
仕上げ脱出（`runFinishExitBoundary`）は、自階の壁再生成と undo 登録のあと、上階の階段内装同期・構造反映・他階の壁 sweep より前に、再生成直後の自階を floors ストアへ書く（App.jsx の `finish.exit` が `saveActiveFloorFn: saveFloor` を渡す。構造脱出の `runStructuralExitBoundary` と同じ serializeGraph→saveFloor）。理由: 他階の処理はいずれも自階を `floorSwapManager.peek`（IDB）で読む一方、アクティブ階の auto-save は dirty 印だけで IDB へは書かない。書かないと階段指定前の古い自階を読んで他階の壁（直下階の階段の下り口など）を誤って作り、その鮮度キーが新値で保存されて後から直らない。無編集で省く脱出（stamps）は書かない（IDB と一致しているはず）。

## モード内部の非同期initに個別の関門は不要
モードの突入境界（`modeBoundaries[x].enter`）は`handleModeChange`/`switchFloorKeepingMode`の`runBusy`本体から呼ばれる内部関数。階切替とdeferでない突入（finish・elevation等）は関門の中で完了まで待つ。`deferEnterOnModeChange`を持つ突入（構造・建具の**モード切替**のみ。App.jsx≈736/751）は画面切替を先行させるため意図的に関門の外で完了する（`entered.catch(console.error)`——背景処理＝層1として扱い、衝突する層2の入口は`structuralSync.whenIdle()`で待つ）。新しい非同期UI入口をApp.jsxに足すと分類テスト（`uiBusyClassification.test.js`）が赤になり分類を強制する——詳細は`.claude/floor-design.md`「入力の関門（uiBusy）」。

