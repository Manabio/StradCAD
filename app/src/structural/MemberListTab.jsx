import { observer } from 'mobx-react-lite';
import { runInAction } from 'mobx';
import { useState, useEffect, useRef } from 'react';
import { StructuralMaterialType } from '../core.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.jsx';
import {
  cardContainerStyle, cardHeaderStyle, cardBodyStyle,
  cardRowStyle, cardFieldStyle, cardLabelStyle, cardInputWrapStyle,
  deleteButtonStyle, cellInputStyle,
} from '../ui/cardStyles.js';
import {
  MEMBER_GROUPS, REMOVE_FN_BY_MAP, FIELD_DEFS_BY_CATEGORY,
  materialLabel, sectionAspectRatio, sectionIconShape, memberSymbol, memberSignature, memberSizeKey,
  DEFAULT_SECTION_BY_MATERIAL, DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL,
  FIGURE_FRAME_BY_MAP, DEFAULT_FIGURE_FRAME,
} from './memberCatalog.js';
import { resolveDefaultMaterialType, alignToOuterFace, autoFillColumnSizes, autoFillColumnBaseSizes, isRigidFrameStructure,
  autoFillBeamEccentricity, autoBeamEccentricity, faceGapForEccentricity, autoFillColumnAxisOffsets, axisExteriorSign, resolveLowestGraph } from './structuralAutoFill.js';
import { buildExteriorSide } from './wallGate.js';
import { SECTION_CATALOG, findSectionEntry, SectionShape } from './sectionCatalog.js';
import { renumberMembers, floorRankOf, previewSplitTag, floorSpanLabel, assignNumbers } from './memberNumbering.js';
import { splitGroup, releaseFromGroup, mergeGroups, getGroupManualTag, setGroupManualTag, clearGroupManualTag, snapshotLedger, restoreLedger, allManualTags } from './memberGroups.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { makeFloorName } from '../floorNumber.js';
import { MergeGroupsDialog } from '../ui/MergeGroupsDialog.jsx';
import { LayerRole } from '../figure/figureTypes.js';
import { AutoScaledFigure } from './sectionFigure/AutoScaledFigure.jsx';
import { memberFigure } from './sectionFigure/memberFigures.js';
import { MemberLayoutStudy } from './sectionFigure/MemberLayoutStudy.jsx';
import { isStudyEnabled, layoutScopeFor, getLayoutOverrides, applyLayoutOverrides } from './sectionFigure/layoutStudy.js';
import { isFoundationPlane } from './drawingDesignation.js';
import { structureHasMemberKind, memberKindOf, MEMBER_KIND, FIGURE_TYPE } from './structuralClassification.js';
import { foundationOptionsFor, isWoodStructure } from '../ui/StructuralInfoDialog.jsx';

// この map グループが、その階・主構造で構造リストに出し得る部材種別（空グループの表示可否判定用）。
// 梁グループだけは自階が基礎面か否かで「基礎梁」⇄「梁」に分かれる（自階＝床下材の供給グラフで判定）。
function groupMemberKinds(mapName, graph, project) {
  switch (mapName) {
    case 'columnMap':  return [MEMBER_KIND.COLUMN];
    case 'footingMap': return [MEMBER_KIND.INDEPENDENT_FOOTING, MEMBER_KIND.COLUMN_BASE];
    case 'beamMap':    return [isFoundationPlane(graph.plane, project) ? MEMBER_KIND.FOUNDATION_BEAM : MEMBER_KIND.BEAM];
    case 'slabMap':    return [MEMBER_KIND.SLAB];
    case 'wallMap':    return [MEMBER_KIND.WALL];
    default:           return [];
  }
}

// 図上で直接編集する寸法のフィールドキー（断面図の editable dim が担う）。
// これらはカード下部のフォームからは除外し、重複入力を避ける（断面=sectionDefId はカタログ選択のため対象外）。
const FIGURE_DIM_KEYS = new Set(['beamWidth', 'beamDepth', 'thickness', 'widthX', 'widthY', 'pedestalDepth']);

// entity と map から、断面図ジェネレータへ渡す ctx（柱芯オフセット・偏芯・レベルラベル）を組む。
// isRoof=R階伏図（屋根伏図）か。梁の図に限り FL を RFL に切り替える（他カテゴリ・他階は FL のまま）。
function buildFigureCtx(entity, mapName, graph, project, isRoof = false) {
  const offsets = graph?.columnAxisOffsets;
  const off = id => (id != null ? (offsets?.get(id) ?? 0) : 0);
  // 柱芯（変位量）はラーメン系のみ編集可（木造・壁式は通り芯と一致＝変位の概念なし）。
  const rigid = isRigidFrameStructure(graph?.structureOverride ?? project?.structuralInfo?.mainStructure);
  if (mapName === 'columnMap' || mapName === 'footingMap') {
    // 外側方向の符号（内側が＋方向=+1／−方向=−1／内部=0）。柱外面（出幅）寸法を「真の外側」に描くために使う。
    // offX の符号は出幅>柱半幅で反転するため使えない——フットプリント由来の符号を権威とする。
    const exterior = rigid ? buildExteriorSide(graph) : null;
    return {
      rigid,
      axisOffsetX: off(entity.verticalCL?.id),
      axisOffsetY: off(entity.horizontalCL?.id),
      axisClIdX: entity.verticalCL?.id,   // 変位量の編集対象CL（X系）
      axisClIdY: entity.horizontalCL?.id, // 同（Y系）
      exteriorSignX: exterior && entity.verticalCL ? axisExteriorSign(exterior, graph, entity.verticalCL, true) : 0,
      exteriorSignY: exterior && entity.horizontalCL ? axisExteriorSign(exterior, graph, entity.horizontalCL, false) : 0,
      eccX: entity.eccentricity?.x ?? 0,
      eccY: entity.eccentricity?.y ?? 0,
      glLabel: 'GL',
    };
  }
  if (mapName === 'beamMap') {
    const structure = graph?.structureOverride ?? project?.structuralInfo?.mainStructure;
    return {
      rigid, // ラーメン系のみ柱芯⇄材芯の偏芯量を編集可（木造・壁式は通り芯と一致＝偏芯の概念なし）
      axisOffset: off(entity.axisCL?.id),
      axisClId: entity.axisCL?.id,
      ecc: typeof entity.eccentricity === 'number' ? entity.eccentricity : 0,
      flLabel: isRoof ? 'RFL' : 'FL', // R階伏図の梁の図のみ RFL（他階は FL）
      glLabel: 'GL（FL）',
      // 木造基礎梁の断面図は基礎種別ごとのベース／べた基礎の合成を反映する（問題.md）。
      // foundationType は 'ベタ基礎' が木造・RC共通表記のため、woodFoundation（木造の基礎梁か）と併用して分岐する。
      foundationType: project?.structuralInfo?.foundationType,
      woodFoundation: entity.role === 'foundation' && typeof structure === 'string' && structure.startsWith('木造'),
    };
  }
  if (mapName === 'wallMap') {
    return { axisOffset: off(entity.axisCL?.id), axisClId: entity.axisCL?.id };
  }
  // スラブ（既定分岐）。R階伏図ではスラブの図も FL→RFL（梁と揃える）。
  return { flLabel: isRoof ? 'RFL' : 'FL' };
}

// グラフ全体のスナップショットでUndoを記録する（CL削除等の既存パターンと同じ手法）。
function pushGraphUndo(graph, before) {
  const after = serializeGraph(graph);
  undoManager.push(
    () => restoreGraph(graph, before),
    () => restoreGraph(graph, after),
  );
}

// 部材1件分の主要寸法サマリー（カード折りたたみ時の1行表示用）
function summaryDims(entity, mapName) {
  switch (mapName) {
    case 'wallMap':    return `t=${entity.thickness}mm`;
    case 'slabMap':    return `t=${entity.thickness}mm`;
    case 'footingMap': return `${entity.widthX}×${entity.widthY}mm`;
    case 'beamMap':    return entity.role === 'foundation' ? `b=${entity.beamWidth}×D=${entity.beamDepth}mm` : (entity.sectionDefId ?? '断面未設定');
    default:           return entity.sectionDefId ?? '断面未設定';
  }
}

// 「この部材」スコープの対象位置ラベル（例 "X2-Y3"）。柱・基礎/柱脚は交点CL、梁・耐力壁は軸+区間の
// CLラベルから組む（表現できる範囲でよい。スラブ等セル定義の部材は id をそのまま示す）。
function memberPositionLabel(entity, mapName) {
  if (mapName === 'columnMap' || mapName === 'footingMap') {
    return `${entity.verticalCL?.label ?? '?'}-${entity.horizontalCL?.label ?? '?'}`;
  }
  if (mapName === 'beamMap' || mapName === 'wallMap') {
    return `${entity.axisCL?.label ?? '?'} ${entity.clStart?.label ?? '?'}~${entity.clEnd?.label ?? '?'}`;
  }
  return entity.id;
}

// 部材番号の記号の定義順（design-member-numbering-ui.md 1.4 規則1・memberCatalog.memberSymbol と同じ列挙）。
// カード並び順（記号の定義順→番号数値昇順→階rank昇順）のプライマリキーに使う。
const SYMBOL_ORDER = ['C', 'PIL', 'CB', 'F', 'G', 'B', 'FG', 'EG', 'RF', 'PR', 'S', 'MF', 'RS', 'W'];

// タグ文字列から並び替えキー [記号順位, 番号数値, 階rank] を作る（localeCompare だと "C10" が "C2" より
// 前に来てしまう不具合の修正。番号は tags の末尾の連続数字、記号は entity から直接引く——文字列パースの
// 曖昧さ（"RG1"＝屋根プレフィックスR+記号Gか、記号"RG"か）を避けるため memberSymbol() を権威にする）。
function tagSortTuple(tag, members, group, project) {
  const rep = members[0];
  const symbol = memberSymbol(rep, group.mapName);
  const symbolRank = SYMBOL_ORDER.indexOf(symbol);
  const num = tag === '(未採番)' ? Infinity : Number(tag.match(/(\d+)$/)?.[1] ?? Infinity);
  const groupKey = rep.numberGroupId ?? memberSignature(rep, group.mapName);
  const idxEntry = project.memberNumberIndex.get(groupKey);
  const floorRank = idxEntry?.floorRanks.size ? Math.min(...idxEntry.floorRanks) : Infinity;
  return [symbolRank < 0 ? 999 : symbolRank, num, floorRank];
}

// group.mapName の実体を、構造種別で取捨した上でタグ（部材番号）単位にまとめる（同一形状＝同一タグ）。
// MemberGroupSection（表示用）と MemberListTab（統合バー・統合ダイアログ用にアクティブなセクション分だけ
// 再計算する）の両方から呼ぶ共通ロジック（二重実装を避ける）。
function computeTagGroups(group, graph, project, structure, figureType) {
  const allEntities = [...graph[group.mapName].values()].filter(group.filter ?? (() => true));
  const entities = structure == null ? allEntities : allEntities.filter(e => structureHasMemberKind(memberKindOf(group.mapName, e), structure, figureType));
  const byTag = new Map();
  for (const e of entities) {
    const tag = e.memberNo ?? '(未採番)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(e);
  }
  return [...byTag.entries()].sort((a, b) => {
    const ta = tagSortTuple(a[0], a[1], group, project);
    const tb = tagSortTuple(b[0], b[1], group, project);
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return ta[i] - tb[i];
    return a[0].localeCompare(b[0]); // 完全同着時の最終防衛（安定化のみ）
  });
}

// 適用範囲セグメントの1ボタン（タップ領域36px以上・ホバー非依存）。
const ScopeButton = observer(({ active, disabled, onClick, children }) => {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        fontSize: 11, padding: '6px 10px', minHeight: 36, flex: '1 1 auto',
        border: active ? '1px solid #2563eb' : '1px solid #cbd5e1',
        borderRadius: 4,
        background: disabled ? '#f1f5f9' : (active ? '#eff6ff' : '#fff'),
        color: disabled ? '#cbd5e1' : (active ? '#2563eb' : '#334155'),
        fontWeight: active ? 700 : 400,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
});

// 分類固定の簡易記号アイコン（柱状=□／ロッド=帯／面材=面／壁状=縦帯）。縦横比だけ実寸断面比に合わせる。
// 柱・梁は sectionDefId（断面マスター）が実在する場合、形状種別に応じた実形状を描く。
const SectionIcon = observer(({ entity, mapName, iconShape }) => {
  const ratio = sectionAspectRatio(entity, mapName) || 1;
  const size = 16;
  let w = size, h = size;
  if (iconShape === 'band')  { w = size; h = size * 0.4; }
  if (iconShape === 'plane') { w = size; h = size * 0.7; }
  if (iconShape === 'wall')  { w = size * 0.3; h = size; }
  if (iconShape === 'box' || iconShape === 'square') {
    if (ratio >= 1) { w = size; h = size / ratio; } else { w = size * ratio; h = size; }
  }
  const shape = sectionIconShape(entity);
  const cx = 10, cy = 10;
  return (
    <svg width={20} height={20} style={{ flexShrink: 0 }}>
      {shape === SectionShape.SQUARE_PIPE && (
        <>
          <rect x={(20 - w) / 2} y={(20 - h) / 2} width={w} height={h} fill="none" stroke="#475569" strokeWidth={1.5} />
          <rect x={(20 - w) / 2 + 3} y={(20 - h) / 2 + 3} width={Math.max(w - 6, 1)} height={Math.max(h - 6, 1)} fill="none" stroke="#475569" strokeWidth={1} />
        </>
      )}
      {(shape === SectionShape.ROUND_PIPE || shape === SectionShape.ROUND) && (
        <circle cx={cx} cy={cy} r={Math.min(w, h) / 2}
          fill={shape === SectionShape.ROUND ? '#475569' : 'none'} stroke="#475569" strokeWidth={1.5} />
      )}
      {shape === SectionShape.H_SECTION && (
        <>
          <rect x={(20 - w) / 2} y={(20 - h) / 2} width={w} height={Math.max(h * 0.18, 2)} fill="#475569" />
          <rect x={(20 - w) / 2} y={(20 + h) / 2 - Math.max(h * 0.18, 2)} width={w} height={Math.max(h * 0.18, 2)} fill="#475569" />
          <rect x={cx - 1} y={(20 - h) / 2} width={2} height={h} fill="#475569" />
        </>
      )}
      {(shape === SectionShape.RECT || shape == null) && (
        <rect
          x={(20 - w) / 2} y={(20 - h) / 2} width={w} height={h}
          fill={shape === SectionShape.RECT ? '#475569' : 'none'} stroke="#475569" strokeWidth={1.5}
        />
      )}
    </svg>
  );
});

// 統合選択モードの下端固定バー（design-member-numbering-ui.md 3.2）。MemberListTab のスクロール領域の
// 外（flex兄弟）に置くことで、ModePanel（横長・パネル下端固定）・BottomSheet（縦長・sticky bottom）の
// どちらでも同一実装で「常時可視」を満たす（両者ともパネル自身がflex縦積みでこの兄弟要素を押し出さない）。
const MergeBar = observer(({ group, graph, project, structure, figureType, selectedTags, onCancel, onConfirm }) => {
  const tagGroups = computeTagGroups(group, graph, project, structure, figureType);
  const totalCount = tagGroups
    .filter(([tag]) => selectedTags.has(tag))
    .reduce((n, [, members]) => n + members.length, 0);
  const canConfirm = selectedTags.size > 1;
  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      padding: '10px 12px', borderTop: '1px solid #e2e8f0', background: '#fff',
      boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
    }}>
      <span style={{ fontSize: 12, color: '#374151' }}>{selectedTags.size}グループ・{totalCount}本を選択中</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button" onClick={onCancel}
          style={{ fontSize: 12, padding: '8px 14px', minHeight: 36, border: '1px solid #cbd5e1', borderRadius: 4, background: '#fff', color: '#475569', cursor: 'pointer' }}
        >
          キャンセル
        </button>
        <button
          type="button" onClick={onConfirm} disabled={!canConfirm}
          style={{
            fontSize: 12, padding: '8px 14px', minHeight: 36, border: 'none', borderRadius: 4,
            background: canConfirm ? '#2563eb' : '#cbd5e1', color: '#fff', cursor: canConfirm ? 'pointer' : 'not-allowed',
          }}
        >
          統合する
        </button>
      </div>
    </div>
  );
});

export const MemberListTab = observer(({ composition, project, focusRequest, onToast }) => {
  const [expandedKey, setExpandedKey] = useState(null); // `${mapName}:${タグ}` | null
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { mapName, ids, label } | null
  // 統合選択モード（design-member-numbering-ui.md セクション3）。対象は同一セクション（mapName+group.key）内のみ
  // ＝有効な group/graph/structure/figureType を [統合…] 押下時点のコンテキストのまま保持する
  // （MemberGroupSection が既に解決済みの値をそのまま渡す。ここで再解決はしない）。
  const [mergeState, setMergeState] = useState(null); // { group, graph, structure, figureType, anchorTag, anchorMaterialType, selectedTags: Set<string> } | null
  const [mergeDialogState, setMergeDialogState] = useState(null); // { group, graph, groups: [{tag, members}] } | null

  // 各カテゴリの一覧・編集対象グラフを図面合成（composition）から解決する（描画対象＝編集対象を一致させる）。
  // 柱＝1つ下の階・床下材＝自階の帰属は FigureDef が決め、ここは委ねるだけ（StructuralLayer.jsx と同一の解決）。
  // 該当レイヤが無い（基礎伏図の柱など）ときは null＝そのグループを出さない。
  const graphForMap = mapName => composition?.graphForCategory(mapName) ?? null;
  // R階伏図（屋根スラブ伏図）は全部材をR階ルールで取捨する（柱・梁・スラブのみ表示、壁・基礎系はカテゴリ非表示）。
  // 平面が単一図面種別に属するため、所属図面ルール（GOVERNING_FIGURE）を figureType=ROOF で上書きする。
  const isRoofFigure = composition?.subjectPlane?.isRoofPlane ?? false;
  const figureType = isRoofFigure ? FIGURE_TYPE.ROOF : null;

  // 描画エリアの部材タグクリック（focusRequest）が来たら、該当部材のカードを開く。
  useEffect(() => {
    if (focusRequest?.mapName && focusRequest.tag) {
      setExpandedKey(`${focusRequest.mapName}:${focusRequest.tag}`);
    }
  }, [focusRequest]);

  // フロア切替・図面合成の組み直し（composition参照が変わる）で統合選択モードを強制終了する。
  // mergeState は特定の graph インスタンス（[統合…]押下時点のもの）を握ったままなので、
  // 切替後に古い graph のまま統合を確定すると別階の部材を操作してしまう。展開カードも道連れで閉じる。
  useEffect(() => {
    setMergeState(null);
    setMergeDialogState(null);
    setExpandedKey(null);
  }, [composition]);

  // 統合選択モード中は Esc で通常表示へ復帰する（design-member-numbering-ui.md 3.2）。
  useEffect(() => {
    if (!mergeState) return;
    function onKeyDown(e) { if (e.key === 'Escape') setMergeState(null); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mergeState]);

  function toggleMergeTag(tag) {
    setMergeState(s => {
      if (!s || tag === s.anchorTag) return s; // 統合先（起点）は解除不可
      const next = new Set(s.selectedTags);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return { ...s, selectedTags: next };
    });
  }

  // 下端固定バーの [統合する] → 材寸採用ダイアログを開く（この時点ではまだ何も変更しない）。
  function openMergeDialog() {
    if (!mergeState) return;
    const tagGroups = computeTagGroups(mergeState.group, mergeState.graph, project, mergeState.structure, mergeState.figureType);
    const groups = tagGroups.filter(([tag]) => mergeState.selectedTags.has(tag)).map(([tag, members]) => ({ tag, members }));
    setMergeDialogState({ group: mergeState.group, graph: mergeState.graph, groups });
  }

  // 材寸採用ダイアログの確定 → mergeGroups（memberGroups.js）→ 再採番 → 1 Undoエントリ（graph+台帳）→ トースト。
  function handleConfirmMerge(chosenIndex) {
    if (!mergeDialogState) return;
    const { graph, group, groups } = mergeDialogState;
    const before = serializeGraph(graph);
    const ledgerBefore = snapshotLedger(project);
    const gid = runInAction(() => mergeGroups(project, group.mapName, groups, chosenIndex));
    if (gid) {
      runInAction(() => renumberMembers(graph, project, group.mapName));
      const after = serializeGraph(graph);
      const ledgerAfter = snapshotLedger(project);
      undoManager.push(
        () => {
          restoreLedger(project, ledgerBefore);
          restoreGraph(graph, before);
        },
        () => {
          restoreLedger(project, ledgerAfter);
          restoreGraph(graph, after);
        },
      );
      const totalCount = groups.reduce((n, g) => n + g.members.length, 0);
      const newTag = groups[chosenIndex].members[0]?.memberNo ?? gid;
      onToast?.(`「${newTag}」に統合しました（${totalCount}本）`);
    }
    setMergeDialogState(null);
    setMergeState(null);
  }

  return (
    // 下端固定バー（MergeBar）をスクロール領域の外（flex兄弟）に置くため、ルートをflex縦積みにする。
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {MEMBER_GROUPS.map(group => {
          const g = graphForMap(group.mapName);
          if (!g) return null; // 下階が無い（基礎伏図）場合は柱グループを非表示
          // 構造種別が持たない部材分類はカテゴリごと隠す（問題.md「×はカテゴリ自体表示しない」＝structuralClassification）。
          // 構造変更で「×」化した自動部材は recomputeStructuralForGraph が削除済みのため、空グループ＝非表示で齟齬は出ない。
          // R階伏図は figureType=ROOF で取捨（壁・基礎系はカテゴリ非表示。柱・梁・スラブのみ）。
          const effectiveStructure = g.structureOverride ?? project.structuralInfo?.mainStructure;
          if (effectiveStructure != null && !groupMemberKinds(group.mapName, g, project).some(k => structureHasMemberKind(k, effectiveStructure, figureType))) return null;
          // 参照のみ（REFERENCE）レイヤの部材は閲覧可・編集不可。現定義は primary/secondaryEdit のみ＝常に false。
          const readOnly = composition.roleForCategory(group.mapName) === LayerRole.REFERENCE;
          const isMergingHere = mergeState?.group === group; // MEMBER_GROUPS は module定数なので参照比較でよい
          return (
            <MemberGroupSection
              key={group.key}
              group={group}
              graph={g}
              composition={composition}
              project={project}
              structure={effectiveStructure}
              figureType={figureType}
              readOnly={readOnly}
              expandedKey={expandedKey}
              onToggle={key => setExpandedKey(key === expandedKey ? null : key)}
              onRequestDelete={(ids, label) => setDeleteConfirm({ mapName: group.mapName, ids, label })}
              focusRequest={focusRequest}
              onToast={onToast}
              mergeModeActiveAnywhere={!!mergeState}
              mergeActive={isMergingHere}
              mergeAnchorTag={isMergingHere ? mergeState.anchorTag : null}
              mergeAnchorMaterialType={isMergingHere ? mergeState.anchorMaterialType : null}
              mergeSelectedTags={isMergingHere ? mergeState.selectedTags : null}
              onStartMerge={(tag, materialType) => setMergeState({ group, graph: g, structure: effectiveStructure, figureType, anchorTag: tag, anchorMaterialType: materialType, selectedTags: new Set([tag]) })}
              onToggleMergeTag={toggleMergeTag}
            />
          );
        })}
      </div>
      {mergeState && (
        <MergeBar
          group={mergeState.group}
          graph={mergeState.graph}
          project={project}
          structure={mergeState.structure}
          figureType={mergeState.figureType}
          selectedTags={mergeState.selectedTags}
          onCancel={() => setMergeState(null)}
          onConfirm={openMergeDialog}
        />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          message={`「${deleteConfirm.label}」を削除しますか？`}
          buttons={[
            { label: 'キャンセル', value: 'cancel' },
            { label: '削除', value: 'ok', danger: true },
          ]}
          onSelect={value => {
            if (value === 'ok') {
              const g = graphForMap(deleteConfirm.mapName);
              const before = serializeGraph(g);
              const removeFn = REMOVE_FN_BY_MAP[deleteConfirm.mapName];
              for (const id of deleteConfirm.ids) g[removeFn](id);
              pushGraphUndo(g, before);
            }
            setDeleteConfirm(null);
          }}
        />
      )}
      {mergeDialogState && (
        <MergeGroupsDialog
          groups={mergeDialogState.groups}
          mapName={mergeDialogState.group.mapName}
          categoryLabel={mergeDialogState.group.label}
          specLabel={summaryDims}
          project={project}
          onCancel={() => setMergeDialogState(null)}
          onConfirm={handleConfirmMerge}
        />
      )}
    </div>
  );
});

// 梁グループ見出しに置く基礎種別セレクト（木造系のみ）。値は建物全体設定で、共通タブの基礎種別と同一実体。
// 階別構造オーバーライドが木造でも建物 foundationType が非木造値のまま残り得るため、選択肢に無い現在値も
// 暫定オプションとして残す（select が空表示になるのを防ぐ）。
const FoundationTypeSelect = observer(({ project, structure }) => {
  const info = project.structuralInfo;
  const options = foundationOptionsFor(structure);
  return (
    <select
      value={info.foundationType ?? ''}
      onChange={e => info.setField('foundationType', e.target.value)}
      style={{ ...selectStyle, cursor: 'pointer' }}
    >
      {!options.includes(info.foundationType) && <option value={info.foundationType ?? ''}>{info.foundationType ?? '未設定'}</option>}
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  );
});

// 1分類分のグループ（外部タブの GroupedExteriorTable と同じ「部位ごとの小テーブル」の発想）。
// 同一形状＝同一タグ（部材番号）であるため、リストはタグ（ラベル）単位で1行のみ表示する
// （同じラベルの部材は複数あっても重複表示しない。件数はカード見出しに表示）。
const MemberGroupSection = observer(({
  group, graph, composition, project, structure, figureType, readOnly, expandedKey, onToggle, onRequestDelete, focusRequest, onToast,
  mergeModeActiveAnywhere, mergeActive, mergeAnchorTag, mergeAnchorMaterialType, mergeSelectedTags, onStartMerge, onToggleMergeTag,
}) => {
  // 構造種別が持たない部材種別（×）の個体は一覧から除外する（footing→ベース/柱脚、beam→梁/基礎梁を role で割る）。
  // structure=null（主構造未設定）は素通し。memberKindOf が null を返す表外部材（軒桁・杭）は structureHasMemberKind=true で残る。
  // R階伏図は figureType=ROOF で個体も取捨する（軒桁＝null は表外で残るが、梁グループ自体が梁ルールで取捨される）。
  const tagGroups = computeTagGroups(group, graph, project, structure, figureType);
  // hideWhenEmpty:true のグループ（小梁）は0件時セクション自体を出さない（基礎伏図・R階伏図等）。
  if (group.hideWhenEmpty && tagGroups.length === 0) return null;

  // 木造系の基礎伏図の梁＝土台基礎。見出しを「土台基礎」に改め、基礎種別（なし/ベタ基礎/土間コン）を右横に置く。
  // 基礎種別は基礎梁の断面に効く建物全体設定（project.structuralInfo.foundationType）を直接編集する。
  const isWoodFoundationBeamGroup = group.mapName === 'beamMap' && group.key === 'beam'
    && isWoodStructure(structure) && isFoundationPlane(graph.plane, project);
  const groupLabel = isWoodFoundationBeamGroup ? '土台基礎' : group.label;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        fontSize: 13, fontWeight: 700, color: '#374151',
        padding: '6px 10px', background: '#f1f5f9',
      }}>
        <span>{groupLabel}（{tagGroups.length}）</span>
        {mergeActive && <span style={{ fontSize: 11, fontWeight: 700, color: '#2563eb' }}>〔統合するグループを選択〕</span>}
        {isWoodFoundationBeamGroup && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 400 }}>
            <span style={{ fontSize: 12, color: '#64748b' }}>基礎種別</span>
            <FoundationTypeSelect project={project} structure={structure} />
          </label>
        )}
      </div>
      {tagGroups.length === 0 && (
        <div style={{ textAlign: 'center', color: '#94a3b8', padding: 12, fontSize: 12 }}>
          登録されていません
        </div>
      )}
      {tagGroups.map(([tag, members]) => {
        const key = `${group.mapName}:${tag}`;
        return (
          <MemberCard
            key={key}
            members={members}
            group={group}
            graph={graph}
            composition={composition}
            project={project}
            readOnly={readOnly}
            isExpanded={key === expandedKey}
            onToggle={() => onToggle(key)}
            onDelete={() => onRequestDelete(members.map(m => m.id), `${tag} ${group.label}（${members.length}件）`)}
            focusRequest={focusRequest}
            onToast={onToast}
            mergeModeActiveAnywhere={mergeModeActiveAnywhere}
            mergeActive={mergeActive}
            isMergeAnchor={mergeActive && tag === mergeAnchorTag}
            isMergeSelected={mergeActive && (mergeSelectedTags?.has(tag) ?? false)}
            mergeAnchorMaterialType={mergeAnchorMaterialType}
            onToggleMerge={() => onToggleMergeTag(tag)}
            onStartMerge={() => onStartMerge(tag, members[0].materialType)}
          />
        );
      })}
      {!readOnly && !mergeActive && group.allowManualAdd !== false && <NewMemberSelector group={group} graph={graph} project={project} structure={structure} />}
    </div>
  );
});

// タグ（ラベル）1件分のアコーディオンカード（finish/FinishTable.jsx の RoomCard と同型）。
// members は同一タグを共有する全部材（同一形状のため、フィールド編集は全員に伝播する）。
const MemberCard = observer(({
  members, group, graph, composition, project, readOnly, isExpanded, onToggle, onDelete, focusRequest, onToast,
  mergeModeActiveAnywhere, mergeActive, isMergeAnchor, isMergeSelected, mergeAnchorMaterialType, onToggleMerge, onStartMerge,
}) => {
  // 梁は同一ラベルに内部梁・両外周梁が混在する。図には偏芯量を編集できる外周梁（柱芯オフセット≠0）を
  // 代表に選ぶ（無ければ先頭）。同一形状＝同一断面のため、断面・材質・番号の表示はどの代表でも一致する。
  const representative = (group.mapName === 'beamMap'
    ? members.find(m => (graph.columnAxisOffsets.get(m.axisCL?.id) ?? 0) !== 0)
    : null) ?? members[0];
  // 図上で編集する寸法フィールドはフォームから除外（断面図の editable dim と二重入力になるため）。
  const allFields = (FIELD_DEFS_BY_CATEGORY[group.category] ?? [])
    .filter(f => f.key in representative && !FIGURE_DIM_KEYS.has(f.key));
  // 木造の基礎梁は断面が構造算定（b×D・常にRC）で決まり、断面マスター選択は意味を持たないため「断面」を隠す（問題.md）。
  const structure = graph?.structureOverride ?? project?.structuralInfo?.mainStructure;
  const isWoodFoundationBeam = group.mapName === 'beamMap' && representative.role === 'foundation'
    && typeof structure === 'string' && structure.startsWith('木造');
  // 「断面」は部材番号の直下（図の上）に置く。残りは図の下に並べる。
  const sectionField = isWoodFoundationBeam ? null : allFields.find(f => f.kind === 'section');
  const fields = allFields.filter(f => f.kind !== 'section');
  const isFocusTarget = isExpanded && focusRequest?.mapName === group.mapName && focusRequest?.tag === representative.memberNo;
  // 統合選択モード中はこのセクションのアコーディオン展開を無効化する（タップ＝チェック切替に一本化。
  // design-member-numbering-ui.md 3.2）。isExpanded state 自体は保持するが、本文の描画だけ抑止する。
  const showBody = isExpanded && !mergeActive;
  // 材料（materialType）が異なるグループは統合できない（統合先＝anchorの材料と一致するカードのみ選択可能。
  // mergeGroups側にも同じ防御があるが、UIでは選択自体をさせない——チェックボックス非表示＋トグル無効）。
  const isMergeSelectable = !mergeActive || isMergeAnchor || representative.materialType === mergeAnchorMaterialType;

  // ---- 適用範囲（分割UI。design-member-numbering-ui.md セクション2）----
  // スコープは sticky にしない: カード展開のたびに（＝isExpanded false→true）、
  // またフォーカス変更（新しいタップ、focusRequestの参照が変わる）のたびに「全体」へ戻す。
  const [scope, setScope] = useState('all'); // 'all' | 'floor' | 'entity'
  useEffect(() => {
    if (isExpanded) setScope('all');
  }, [isExpanded, focusRequest]);

  const floorLabel = makeFloorName(graph.plane.startFloor, graph.plane.stories ?? 1);
  // このグループが複数階にまたがるか（project.memberNumberIndex の派生キャッシュを読む。
  // モード境界の収集フェーズで再構築されるため、未収集時は「単一階」として扱う＝安全側のフォールバック）。
  const groupKeyForIndex = representative.numberGroupId ?? memberSignature(representative, group.mapName);
  const idxEntry = project.memberNumberIndex.get(groupKeyForIndex);
  const isMultiFloor = idxEntry ? (idxEntry.floorRanks.size + (idxEntry.hasRoof ? 1 : 0)) > 1 : false;
  // カードヘッダの広がりバッジ（例 "2~3F・計12本"）。design-member-numbering-ui.md 5節。
  const groupSpanBadge = idxEntry ? floorSpanLabel(idxEntry, project) : null;
  // 手動タグ（台帳 grp.no）。numberGroupId が無い（純自動グループ）場合は手動タグを持ちえない。
  const manualTag = representative.numberGroupId ? getGroupManualTag(project.memberGroupLedger, representative.numberGroupId) : null;
  useEffect(() => {
    if (scope === 'floor' && !isMultiFloor) setScope('all');
  }, [scope, isMultiFloor]);
  // 図面上で部材タグをタップして開いた場合のみ「この部材」の対象が定まる（entityId が来る）。
  const focusedMember = focusRequest?.entityId ? members.find(m => m.id === focusRequest.entityId) ?? null : null;

  const [splitConfirm, setSplitConfirm] = useState(null); // { message, onConfirm } | null

  // 現在のスコープでの分割対象部材（'all'は分割系ではないため空配列を返す＝呼び出し側は使わない）。
  function resolveSplitTargets() {
    return scope === 'entity' ? (focusedMember ? [focusedMember] : []) : members;
  }
  // 予定タグの dry-run（assignNumbers を汚さない使い捨てビュー。memberNumbering.previewSplitTag）。
  function computeSplitPreview(targetMembers) {
    if (!targetMembers.length) return null;
    const remainderGroupKey = representative.numberGroupId ?? memberSignature(representative, group.mapName);
    // 「この階」は自階の対象が全部移動＝自階分は0本残る。「この部材」はこの階に他に残りが無い場合のみ0本。
    const removeFromRemainder = scope === 'floor' || (scope === 'entity' && members.length === 1);
    const floorInfo = floorRankOf(graph.plane, project);
    const tag = previewSplitTag(
      project, group.mapName, memberSymbol(targetMembers[0], group.mapName),
      memberSizeKey(targetMembers[0], group.mapName), memberSignature(targetMembers[0], group.mapName),
      floorInfo, { remainderGroupKey, removeFromRemainder },
    );
    return { count: targetMembers.length, tag };
  }
  const splitPreview = (!readOnly && scope !== 'all') ? computeSplitPreview(resolveSplitTargets()) : null;

  // 全てのフィールド編集入口（setField/断面変更/図上寸法編集）が通る単一の分岐点。
  // scope==='all' は現行どおり members 全員へ即時ミューテート（分割なし）。
  // scope!=='all' は対象部材にだけ値を先に適用してから ConfirmDialog を出す——
  // キャンセル時は serializeGraph の before スナップショットへ復元し、編集自体を破棄する
  // （スコープ選択は維持。design-member-numbering-ui.md 2.5「キャンセル時は編集自体を破棄しスコープは維持」）。
  function commitScopedEdit(mutateFn) {
    if (readOnly) return;
    if (scope === 'all') { mutateFn(members); return; }
    const targetMembers = resolveSplitTargets();
    if (!targetMembers.length) return;
    const before = serializeGraph(graph);
    const ledgerBefore = snapshotLedger(project);
    mutateFn(targetMembers);
    const preview = computeSplitPreview(targetMembers);
    const scopeLabel = scope === 'entity' ? 'この部材' : floorLabel;
    const oldTag = representative.memberNo ?? '(未採番)';
    setSplitConfirm({
      message: (
        <>
          「{oldTag}」を分割します。<br />
          {scopeLabel}の{targetMembers.length}本が新しい番号（{preview?.tag ?? '?'} 予定）になります。
        </>
      ),
      onConfirm: () => {
        runInAction(() => {
          splitGroup(project, group.mapName, targetMembers);
          renumberMembers(graph, project, group.mapName);
        });
        const after = serializeGraph(graph);
        const ledgerAfter = snapshotLedger(project);
        undoManager.push(
          () => {
            restoreLedger(project, ledgerBefore);
            restoreGraph(graph, before);
          },
          () => {
            restoreLedger(project, ledgerAfter);
            restoreGraph(graph, after);
          },
        );
        onToast?.(`「${targetMembers[0].memberNo}」として分割しました（${targetMembers.length}本）`);
        setSplitConfirm(null);
      },
      onCancel: () => {
        restoreGraph(graph, before);
        setSplitConfirm(null);
      },
    });
  }

  // 「グループに戻す」: 自階分の numberGroupId だけ外して再採番する。台帳（grp.spec/grp.join）は
  // 削除しない——他階に同じ gid の部材が残っている可能性があり、次のモード境界の conformToLedger が
  // 引き続きそれらを同じ gid で扱う設計のため（memberGroups.releaseFromGroup 参照）。
  function handleUngroup() {
    const before = serializeGraph(graph);
    runInAction(() => {
      releaseFromGroup(members);
      renumberMembers(graph, project, group.mapName);
    });
    pushGraphUndo(graph, before);
  }

  // 部材番号欄の手動入力。ローカル下書き state（manualDraft）＋blur/Enterで確定する（1文字打つたびに
  // materialize＝恒久分割してしまうのを防ぐ。以前は onChange で毎キー確定していた）。
  // 手動タグは部材単位ではなくグループ単位（台帳 grp.no:<gid>）に一本化する（memberNoLocked は廃止済み。
  // .claude/structural-model.md 参照）。gid未付与のグループ（純自動）は確定時に初めて materialize する。
  const [manualDraft, setManualDraft] = useState(null); // null=非編集中（表示はrepresentative.memberNoに従う）
  const [manualDuplicate, setManualDuplicate] = useState(false); // 同一セクション内の重複タグを弾いた警告表示
  const hadGidBeforeEditRef = useRef(false); // 今回の編集セッション開始時点でgidを持っていたか（空confirm時の巻き戻し判定）

  function handleManualFocus() {
    hadGidBeforeEditRef.current = !!representative.numberGroupId;
    setManualDraft(representative.memberNo ?? '');
    setManualDuplicate(false);
  }
  function handleManualDraftChange(value) {
    setManualDraft(value);
    if (manualDuplicate) setManualDuplicate(false);
  }
  // 建物全体でこのタグが既に使われていないか（このカードのグループ自身は除く）。自階の走査ではなく
  // 「タグ空間の一意性」を assignNumbers の衝突回避（memberNumbering.js）と同じ土台で判定する:
  //   (1) 現在収集済みの全階グループの完成タグ（assignNumbers の結果）
  //   (2) 台帳の grp.no 全値（他階にしか実体が無い＝まだ収集されていないグループの手動タグも拾う）
  function isManualTagUsedElsewhere(tag) {
    const ownGid = representative.numberGroupId;
    const ownGroupKey = ownGid ?? memberSignature(representative, group.mapName);
    for (const [groupKey, t] of assignNumbers(project)) {
      if (groupKey !== ownGroupKey && t === tag) return true;
    }
    for (const [gid, manualTag] of allManualTags(project.memberGroupLedger)) {
      if (gid !== ownGid && manualTag === tag) return true;
    }
    return false;
  }
  function commitManualNumber() {
    if (manualDraft == null) return;
    const value = manualDraft;
    if (value === (representative.memberNo ?? '')) { setManualDraft(null); return; } // 無変更
    if (value === '') {
      // 空confirm＝自動へ戻す。今回の編集で materialize した（元々gid無しだった）場合は
      // グループ構造自体も巻き戻す（無駄な分割グループを残さない）。
      runInAction(() => {
        if (representative.numberGroupId) {
          clearGroupManualTag(project.memberGroupLedger, representative.numberGroupId);
          if (!hadGidBeforeEditRef.current) releaseFromGroup(members);
        }
        renumberMembers(graph, project, group.mapName);
      });
      setManualDraft(null);
      return;
    }
    if (isManualTagUsedElsewhere(value)) {
      setManualDuplicate(true); // 確定しない（draftは保持し再編集させる）
      return;
    }
    runInAction(() => {
      let gid = representative.numberGroupId;
      if (!gid) gid = splitGroup(project, group.mapName, members);
      setGroupManualTag(project.memberGroupLedger, gid, value);
      renumberMembers(graph, project, group.mapName);
    });
    setManualDraft(null);
  }

  // 「自動に戻す」: 手動タグ（grp.no）だけを外す。グループ構造（numberGroupId）自体はそのまま
  // （分割・統合で得た明示グループなら〔分割〕バッジへ戻るのが正しい。グループ構造まで外すのは
  // 別ボタン「グループに戻す」の役目）。
  function handleAutoRevert() {
    runInAction(() => {
      if (representative.numberGroupId) clearGroupManualTag(project.memberGroupLedger, representative.numberGroupId);
      renumberMembers(graph, project, group.mapName);
    });
  }

  // 断面図ジオメトリ（observableを読むので、フィールド変更時にこのobserverが再render→再描画される）。
  // frame を渡すと memberFigure が形状基準で縮尺を決め、注記の隙間を px 一定にした図＋その縮尺を返す
  //（スクリーン空間注記。縮尺は下の AutoScaledFigure へそのまま渡す）。
  const figureFrame = FIGURE_FRAME_BY_MAP[group.mapName] ?? DEFAULT_FIGURE_FRAME;
  const isRoof = composition?.subjectPlane?.isRoofPlane ?? false; // R階伏図なら梁の図の FL を RFL にする
  const figure = showBody
    ? memberFigure(representative, group.mapName, { ...buildFigureCtx(representative, group.mapName, graph, project, isRoof), frame: figureFrame })
    : null;
  // 図の各要素の配置オフセット（layoutStudy）を本番図へ適用する。getLayoutOverrides を読むことで、
  // 配置検討UIの移動・MEMBER_LAYOUT_OVERRIDES の編集が即この図へ反映される。
  const layoutScope = layoutScopeFor(group.mapName, representative);
  const displayPrimitives = figure
    ? applyLayoutOverrides(figure.primitives, layoutScope ? getLayoutOverrides(layoutScope) : {})
    : null;
  const [studyOpen, setStudyOpen] = useState(false);
  // 図上の寸法確定。
  // ・通り芯⇄柱芯の変位量（target='axisOffset'）はCL単位の柱芯オフセットを更新する
  //   → 柱・梁の実位置computedが追従し、描画エリアが即リドローされる（MobX）。
  // ・厚指定（厚み）等は同一タグの全部材へ伝播。構造算定サイズは read-only のためここには来ない。
  const handleEditDim = readOnly ? undefined : async (dim, value) => {
    if (dim.target === 'faceProjection') {
      // 出幅は「1構造×1通り芯」の建物全体値（project.structuralInfo.setColumnFaceProjection）であり、
      // 部材個体ではなく通り芯に属する——分割スコープ（グループ単位の材寸分岐）の対象にならないため、
      // scope に関わらず常に「全体」相当（既存どおり全通り芯へ一括適用）で処理する。
      // 出幅（柱面⇄通り芯の距離）は1構造×1通り芯。構造リスト柱の図は「その構造の代表断面1本」を示すため、
      // 編集値はこのタグ群の全柱が乗る当該軸の全通り芯へ一括適用する（X編集→members の全 verticalCL、
      // Y編集→全 horizontalCL）。代表1本のCLだけに書くと、L字外周の他通り芯（X2/X3/Y1/Y2…）の出幅が
      // 0のまま取り残され、柱芯が初期偏芯（出幅0）から動かない不具合になる。1通り芯ごとの微調整は描画エリアの
      // 柱芯ラベルのロングタップ（commitAxisEdit）が担う。柱芯オフセットは出幅＋自階柱幅から各階で派生するため、
      // 更新後 composition 内の全階グラフで columnAxisOffsets を再構築する（柱・梁・軸線・寸法を一致して再描画）。
      // 符号権威＝最下階フットプリント（resolveLowestGraph）——R階伏図など部屋の無い主題階を権威にすると
      // 矩形縮退でL字ノッチ中通りの偏芯が0へ崩れるため、再計算と同じ単一権威に揃える。
      const axisCLs = [...new Map(
        members.map(m => dim.axis === 'Y' ? m.horizontalCL : m.verticalCL)
          .filter(Boolean).map(c => [c.id, c]),
      ).values()];
      const graphs = composition?.bindings?.map(b => b.graph) ?? [graph];
      const lowest = await resolveLowestGraph(project, graph);
      // 出幅（柱面⇄通り芯）は外周軸のみ意味を持つ。内部軸の柱芯は描画エリアの柱芯ラベル（符号付き入力）で
      // 制御するため、ここで abs 値に上書きしない（符号付き指定が潰れるのを防ぐ）。符号権威は最下階フットプリント。
      const ex = buildExteriorSide(lowest);
      const isVertical = dim.axis !== 'Y';
      for (const c of axisCLs) {
        if (axisExteriorSign(ex, lowest, c, isVertical) === 0) continue;
        project.structuralInfo.setColumnFaceProjection(structure, c, Math.abs(value));
      }
      for (const gg of graphs) {
        autoFillColumnAxisOffsets(gg, project, lowest);
        autoFillBeamEccentricity(gg, project); // 柱芯オフセット変更に梁の柱外面合わせを追従させる
      }
      return;
    }
    if (dim.target === 'eccentricity') {
      // 図の偏芯量寸法は絶対値表示。代表梁の現在の向き（無ければ柱外面合わせ＝面一の既定向き）を保って符号付けし、
      // faceGap（柱外面と梁縁のギャップ）を逆算して同一ラベルの全梁に保存する。eccentricity 自体は faceGap から
      // 再算出するため、外周の向きに応じて符号が自動付与され（対辺は逆符号・内部は0）、柱寸法・梁寸法変更にも追従する。
      const def = autoBeamEccentricity(graph, project, representative, 0); // faceGap=0（面一）の既定偏芯
      const sign = representative.eccentricity !== 0 ? Math.sign(representative.eccentricity) : (def !== 0 ? Math.sign(def) : 1);
      const faceGap = faceGapForEccentricity(graph, project, representative, sign * Math.abs(value));
      commitScopedEdit(targets => {
        for (const m of targets) m.setField('faceGap', faceGap);
        autoFillBeamEccentricity(graph, project);
      });
      return;
    }
    if (dim.target === 'foundationSection') {
      // 木造基礎の断面詳細寸法（ベース・べた基礎・地中部）。foundationSection オブジェクトの該当キーを差し替える
      //（MobX再描画のためオブジェクトごと置換）。同一ラベルの全基礎梁へ伝播（scope='all'時）。
      commitScopedEdit(targets => {
        for (const m of targets) m.setField('foundationSection', { ...(m.foundationSection ?? {}), [dim.fieldKey]: value });
      });
      return;
    }
    if (dim.target === 'riseAboveGL') {
      // 立ち上がり（GL上）の編集は 成D を rise+地中 に保つ（地中部は維持）。
      commitScopedEdit(targets => {
        for (const m of targets) {
          const embed = (m.foundationSection ?? {}).embedDepth ?? 250;
          m.setField('beamDepth', value + embed);
          m.setDimensionStatus('locked');
        }
      });
      return;
    }
    commitScopedEdit(targets => {
      for (const m of targets) {
        m.setField(dim.fieldKey, value);
        m.setDimensionStatus('locked');
      }
    });
  };
  // 統合選択モード（このセクションのみ）: 起点カードはチェック固定（解除不可）、他カードはタップでチェック切替。
  // アコーディオン展開は無効化（誤爆防止。design-member-numbering-ui.md 3.2）。材料が異なるカードは
  // チェックボックス自体を出さず、タップも無効化する（isMergeSelectable=false。統合できない組み合わせのため）。
  const mergeChecked = isMergeAnchor || isMergeSelected;
  const headerOnClick = mergeActive ? ((isMergeAnchor || !isMergeSelectable) ? undefined : onToggleMerge) : onToggle;
  return (
    <div
      style={{
        ...cardContainerStyle,
        outline: mergeActive
          ? (isMergeAnchor ? '2px solid #2563eb' : 'none')
          : (isExpanded && scope !== 'all') ? '2px solid #fb923c' : (isExpanded ? '2px solid #2563eb' : 'none'),
        outlineOffset: -2,
        opacity: mergeActive && !isMergeSelectable ? 0.45 : 1,
      }}
    >
      <div
        style={{
          ...cardHeaderStyle, padding: mergeActive ? '12px 10px' : cardHeaderStyle.padding,
          cursor: mergeActive && (isMergeAnchor || !isMergeSelectable) ? 'default' : 'pointer',
        }}
        onClick={headerOnClick}
      >
        {mergeActive && isMergeSelectable && (
          // チェックボックス（タップ領域は行全体＝44px以上。design-member-numbering-ui.md 3.2）。
          // 起点カードはチェック固定・淡色（解除不可であることを示す）。
          <span
            aria-hidden="true"
            style={{
              width: 20, height: 20, flexShrink: 0, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${mergeChecked ? '#2563eb' : '#cbd5e1'}`,
              background: mergeChecked ? '#2563eb' : '#fff',
              color: '#fff', fontSize: 13, lineHeight: 1,
              opacity: isMergeAnchor ? 0.6 : 1,
            }}
          >
            {mergeChecked ? '✓' : ''}
          </span>
        )}
        <SectionIcon entity={representative} mapName={group.mapName} iconShape={group.iconShape} />
        <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{representative.memberNo ?? '(未採番)'}</span>
        <span style={{ fontSize: 12, color: '#64748b' }}>{materialLabel(representative.materialType)}</span>
        <span style={{ flex: 1, fontSize: 12, color: '#64748b' }}>{summaryDims(representative, group.mapName)}</span>
        {isFocusTarget && focusedMember && (
          <span style={{ fontSize: 11, color: '#2563eb' }}>対象: {memberPositionLabel(focusedMember, group.mapName)}</span>
        )}
        <span style={{ fontSize: 11, color: '#94a3b8' }}>×{members.length}</span>
        {/* グループの広がりバッジ（例 "2~3F・計12本"）。project.memberNumberIndex から建物全体の集計を示す
            （×N はこの階の本数、こちらはグループ全体の本数。design-member-numbering-ui.md 5節）。 */}
        {groupSpanBadge && (
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#f1f5f9', color: '#64748b' }}>{groupSpanBadge}</span>
        )}
        {mergeActive && isMergeAnchor && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: '#dbeafe', color: '#1d4ed8' }}>統合先</span>
        )}
        {!mergeActive && <span style={{ color: '#94a3b8', fontSize: 11 }}>{isExpanded ? '▼' : '◀'}</span>}
      </div>
      {showBody && (
        <div style={cardBodyStyle}>
          {/* 適用範囲（分割UI）。ボディ最上段に置く（design-member-numbering-ui.md 2.1）。 */}
          {!readOnly && (
            <div style={{ margin: '6px 0' }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>適用範囲</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <ScopeButton active={scope === 'all'} onClick={() => setScope('all')}>全体</ScopeButton>
                {isMultiFloor && (
                  <ScopeButton active={scope === 'floor'} onClick={() => setScope('floor')}>{`この階（${floorLabel}）`}</ScopeButton>
                )}
                <ScopeButton active={scope === 'entity'} disabled={!focusedMember} onClick={() => setScope('entity')}>この部材</ScopeButton>
              </div>
              {scope === 'entity' && !focusedMember && (
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>図面上で部材をタップして選択してください</div>
              )}
              {scope !== 'all' && (
                <div style={{ background: '#fff7ed', border: '1px solid #fb923c', borderRadius: 4, padding: '6px 8px', marginTop: 6, fontSize: 12, color: '#9a3412' }}>
                  ⚠ この編集は番号を分割します<br />
                  {splitPreview
                    ? `${scope === 'entity' ? 'この部材' : floorLabel}の${splitPreview.count}本 → 新番号「${splitPreview.tag ?? '?'}」（予定）`
                    : '対象を選択してください'}
                </div>
              )}
            </div>
          )}
          <div style={cardRowStyle}>
            <div style={cardFieldStyle}>
              <span style={cardLabelStyle}>部材番号：</span>
              <div style={cardInputWrapStyle}>
                {/* 手動タグはグループ単位（台帳 grp.no）。ローカル下書き＋blur/Enterで確定する。
                    空にして確定すると自動導出へ戻る（「自動に戻す」と同義）。 */}
                <input
                  value={manualDraft ?? (representative.memberNo ?? '')}
                  onChange={e => handleManualDraftChange(e.target.value)}
                  onFocus={handleManualFocus}
                  onBlur={commitManualNumber}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  disabled={readOnly}
                  style={cellInputStyle}
                />
                {manualDuplicate && (
                  <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2 }}>
                    同じ番号の部材が他にあります。別の番号を入力してください。
                  </div>
                )}
                {/* バッジは〔手動〕〔分割〕のいずれか一方のみ（design-member-numbering-ui.md 5節）。
                    手動タグがあれば分割由来かどうかに関わらず〔手動〕を優先する。 */}
                {manualTag ? (
                  <>
                    <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#fef3c7', color: '#92400e' }}>手動</span>
                    {!readOnly && (
                      <button type="button" onClick={handleAutoRevert} style={{ marginLeft: 6, fontSize: 11, cursor: 'pointer' }}>
                        自動に戻す
                      </button>
                    )}
                  </>
                ) : representative.numberGroupId && (
                  <>
                    <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 3, background: '#e0e7ff', color: '#3730a3' }}>分割</span>
                    {!readOnly && (
                      <button type="button" onClick={handleUngroup} style={{ marginLeft: 6, fontSize: 11, cursor: 'pointer' }}>
                        グループに戻す
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          {/* 「断面」（H/□/RC等の選択）は部材番号の直下・図の上に置く。 */}
          {sectionField && (
            <div style={cardRowStyle}>
              <div style={cardFieldStyle}>
                <span style={cardLabelStyle}>{sectionField.label}：</span>
                <div style={cardInputWrapStyle}>
                  <MemberFieldInput
                    members={members} fieldDef={sectionField} graph={graph} group={group} project={project}
                    readOnly={readOnly} onCommit={commitScopedEdit}
                  />
                </div>
              </div>
            </div>
          )}
          {/* 断面形状表示（寸法線付き・パネル幅に自動縮尺）。図上の[寸法]クリックで直接編集。
              表示枠は部材分類ごとに異なる（FIGURE_FRAME_BY_MAP、柱は密集するため広め）。 */}
          {figure && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', overflowX: 'auto', position: 'relative' }}>
              <AutoScaledFigure
                primitives={displayPrimitives}
                boundsPrimitives={figure.primitives}
                {...figureFrame}
                scale={figure.scale}
                onEditDim={handleEditDim}
              />
              {isStudyEnabled(layoutScope) && (
                <button
                  type="button"
                  onClick={() => setStudyOpen(true)}
                  title="部材リスト配置検討モード"
                  style={{ position: 'absolute', top: 4, right: 4, fontSize: 11, padding: '2px 8px',
                           border: '1px solid #93c5fd', borderRadius: 4, background: '#eff6ff', color: '#2563eb', cursor: 'pointer' }}
                >
                  配置検討
                </button>
              )}
            </div>
          )}
          {studyOpen && figure && layoutScope && (
            <MemberLayoutStudy
              primitives={figure.primitives}
              scope={layoutScope}
              title={`${representative.memberNo ?? group.label}`}
              onClose={() => setStudyOpen(false)}
            />
          )}
          {fields.map(fieldDef => (
            <div key={fieldDef.key} style={cardRowStyle}>
              <div style={cardFieldStyle}>
                <span style={cardLabelStyle}>{fieldDef.label}：</span>
                <div style={cardInputWrapStyle}>
                  <MemberFieldInput
                    members={members} fieldDef={fieldDef} graph={graph} group={group} project={project}
                    readOnly={readOnly} onCommit={commitScopedEdit}
                    autoFocus={isFocusTarget && focusRequest?.fieldKey === fieldDef.key}
                    focusToken={focusRequest}
                  />
                </div>
              </div>
            </div>
          ))}
          {!readOnly && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              {!mergeModeActiveAnywhere && (
                <button
                  type="button"
                  onClick={onStartMerge}
                  style={{ fontSize: 12, color: '#2563eb', background: 'none', border: '1px solid #93c5fd', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
                >
                  統合…
                </button>
              )}
              <button onClick={onDelete} style={deleteButtonStyle}>削除（{members.length}件）</button>
            </div>
          )}
        </div>
      )}
      {splitConfirm && (
        <ConfirmDialog
          message={splitConfirm.message}
          buttons={[
            { label: 'キャンセル', value: 'cancel' },
            { label: '分割する', value: 'ok', primary: true },
          ]}
          onSelect={value => (value === 'ok' ? splitConfirm.onConfirm() : splitConfirm.onCancel())}
        />
      )}
    </div>
  );
});

const MemberFieldInput = observer(({ members, fieldDef, graph, group, project, readOnly, autoFocus, focusToken, onCommit }) => {
  const value = members[0][fieldDef.key];
  const inputRef = useRef(null);
  // 描画エリアの部材タグクリック（focusRequest）でこのフィールドが対象になったらフォーカス・全選択する。
  // focusTokenはクリックごとに新しいオブジェクト参照になるため、同じタグへの再クリックでも再フォーカスされる。
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
      inputRef.current?.select?.();
    }
  }, [autoFocus, focusToken]);
  // 数値フィールドの手動書き換えは、構造計算の根拠が無い自動算定値を上書きしたことになるため
  // dimensionStatusを'locked'へ自動遷移させる（プルダウン選択=分類変更では遷移させない）。
  // 実際のミューテートは onCommit（MemberCard.commitScopedEdit）に委ねる——scope='all'なら即時、
  // それ以外は対象部材にだけ先に適用して分割の確認ダイアログを出す（design-member-numbering-ui.md 2.5）。
  function handleChange(v) {
    onCommit(targets => {
      for (const m of targets) {
        m.setField(fieldDef.key, v);
        if (fieldDef.kind === 'number') m.setDimensionStatus('locked');
      }
    });
  }
  if (fieldDef.kind === 'section') {
    const options = SECTION_CATALOG.filter(s => s.materialType === members[0].materialType);
    // 断面変更時、柱芯オフセットが入っている軸については「外側面で揃える」よう個別偏心量を補正する
    // （alignToOuterFace。基準幅=その材料の既定断面幅、補正方向=既存オフセットの符号）。
    // 梁は断面幅が変わるため、faceGap（柱外面と梁縁のギャップ）を保ったまま偏芯量を再算出する。
    function handleSectionChange(newId) {
      const defaultMap = group.mapName === 'columnMap' ? DEFAULT_COLUMN_SECTION_BY_MATERIAL : DEFAULT_BEAM_SECTION_BY_MATERIAL;
      const refWidth = findSectionEntry(defaultMap[members[0].materialType])?.width ?? 0;
      const newWidth = findSectionEntry(newId)?.width ?? refWidth;
      onCommit(targets => {
        for (const m of targets) {
          m.setField('sectionDefId', newId);
          m.setDimensionStatus('locked');
          if (group.mapName === 'beamMap') {
            m.setField('eccentricity', autoBeamEccentricity(graph, project, m, m.faceGap ?? 0)); // 新断面幅 × faceGap で再算出
            continue;
          }
          if (!refWidth || newWidth === refWidth) continue;
          if (group.mapName === 'columnMap') {
            const offX = graph.columnAxisOffsets.get(m.verticalCL.id) ?? 0;
            const offY = graph.columnAxisOffsets.get(m.horizontalCL.id) ?? 0;
            m.setField('eccentricity', {
              x: offX !== 0 ? alignToOuterFace(m.eccentricity.x, newWidth, refWidth, Math.sign(offX)) : m.eccentricity.x,
              y: offY !== 0 ? alignToOuterFace(m.eccentricity.y, newWidth, refWidth, Math.sign(offY)) : m.eccentricity.y,
            });
          }
        }
      });
    }
    return (
      <select
        ref={inputRef}
        value={value ?? ''}
        onChange={e => handleSectionChange(e.target.value)}
        onClick={e => e.stopPropagation()}
        disabled={readOnly}
        style={{ ...cellInputStyle, cursor: 'pointer' }}
      >
        {!options.some(s => s.key === value) && <option value={value ?? ''}>{value || '断面未設定'}</option>}
        {options.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
    );
  }
  if (fieldDef.kind === 'select') {
    return (
      <select
        ref={inputRef}
        value={value ?? ''}
        onChange={e => handleChange(e.target.value)}
        onClick={e => e.stopPropagation()}
        disabled={readOnly}
        style={{ ...cellInputStyle, cursor: 'pointer' }}
      >
        {fieldDef.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }
  // number
  return (
    <input
      ref={inputRef}
      type="number"
      value={value ?? ''}
      onChange={e => handleChange(e.target.value === '' ? null : Number(e.target.value))}
      onClick={e => e.stopPropagation()}
      disabled={readOnly}
      style={cellInputStyle}
    />
  );
});

// 新規追加UI（柱・基礎=交点選択／梁・耐力壁=軸+始端+終端選択）。スラブはセル選択UIが必要なため Phase 1 では見送り。
const NewMemberSelector = observer(({ group, graph, project, structure }) => {
  if (group.mapName === 'columnMap' || group.mapName === 'footingMap') {
    return <NewIntersectionMemberSelector group={group} graph={graph} project={project} structure={structure} />;
  }
  if (group.mapName === 'beamMap' || group.mapName === 'wallMap') {
    return <NewSpanMemberSelector group={group} graph={graph} project={project} />;
  }
  return null;
});

const addButtonStyle = {
  marginTop: 4, fontSize: 12, color: '#2563eb', background: 'none',
  border: '1px dashed #93c5fd', borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
};
const selectStyle = { fontSize: 12, padding: '2px 4px' };

const NewIntersectionMemberSelector = observer(({ group, graph, project, structure }) => {
  const [vId, setVId] = useState('');
  const [hId, setHId] = useState('');
  const [footingKind, setFootingKind] = useState('independent'); // 'independent'=独立基礎 | 'base'=柱脚
  // 柱脚が「×」の構造では追加候補から外す（問題.md「×はカテゴリ自体表示しない」）。
  const allowColumnBase = structureHasMemberKind(MEMBER_KIND.COLUMN_BASE, structure);

  async function handleAdd() {
    const vCL = graph.gridXs.find(cl => cl.id === vId);
    const hCL = graph.gridYs.find(cl => cl.id === hId);
    if (!vCL || !hCL) return;
    // 柱は自階の実効主構造を材質に使う（柱は各階が自階graphに持つ）。基礎・柱脚は常にRC固定（下のelse節）。
    const materialType = resolveDefaultMaterialType(graph, project);
    const before = serializeGraph(graph);
    runInAction(() => {
      if (group.mapName === 'columnMap') {
        graph.addColumn(materialType, DEFAULT_COLUMN_SECTION_BY_MATERIAL[materialType], vCL, hCL, {});
        // 柱が支える階数(N)も自階（graph.plane）基準で算定する。
        autoFillColumnSizes(graph, project, graph.plane);
      } else {
        // 基礎・柱脚は主構造に関わらず常にRC造（structuralAutoFill.js の autoFillFootings と同じ理由）。
        graph.addFooting(footingKind, DEFAULT_SECTION_BY_MATERIAL[StructuralMaterialType.RC], vCL, hCL, { materialType: StructuralMaterialType.RC });
        autoFillColumnBaseSizes(graph, project);
      }
      renumberMembers(graph, project, group.mapName);
    });
    pushGraphUndo(graph, before);
    setVId(''); setHId('');
  }

  return (
    <div style={{ display: 'flex', gap: 6, padding: '4px 10px', alignItems: 'center' }}>
      {group.mapName === 'footingMap' && (
        <select value={footingKind} onChange={e => setFootingKind(e.target.value)} style={selectStyle}>
          <option value="independent">独立基礎</option>
          {allowColumnBase && <option value="base">柱脚</option>}
        </select>
      )}
      <select value={vId} onChange={e => setVId(e.target.value)} style={selectStyle}>
        <option value="">垂直CL...</option>
        {graph.gridXs.map(cl => <option key={cl.id} value={cl.id}>{cl.label}</option>)}
      </select>
      <select value={hId} onChange={e => setHId(e.target.value)} style={selectStyle}>
        <option value="">水平CL...</option>
        {graph.gridYs.map(cl => <option key={cl.id} value={cl.id}>{cl.label}</option>)}
      </select>
      <button disabled={!vId || !hId} onClick={() => handleAdd().catch(console.error)} style={addButtonStyle}>＋ 追加</button>
    </div>
  );
});

const NewSpanMemberSelector = observer(({ group, graph, project }) => {
  const [axisId, setAxisId] = useState('');
  const [startId, setStartId] = useState('');
  const [endId, setEndId] = useState('');

  const isVertical = graph.gridXs.some(cl => cl.id === axisId);
  const crossOptions = !axisId ? [] : (isVertical ? graph.gridYs : graph.gridXs);

  function handleAxisChange(id) {
    setAxisId(id);
    setStartId('');
    setEndId('');
  }

  function handleAdd() {
    const axisCL  = graph.gridXs.find(cl => cl.id === axisId) ?? graph.gridYs.find(cl => cl.id === axisId);
    const clStart = crossOptions.find(cl => cl.id === startId);
    const clEnd   = crossOptions.find(cl => cl.id === endId);
    if (!axisCL || !clStart || !clEnd || clStart.id === clEnd.id) return;
    const before = serializeGraph(graph);
    const materialType = resolveDefaultMaterialType(graph, project);
    runInAction(() => {
      if (group.mapName === 'beamMap') {
        graph.addBeam(materialType, DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, {});
        autoFillBeamEccentricity(graph, project); // 外周梁なら柱外面合わせの偏芯量を初期算出（faceGap=0＝面一）
      } else {
        graph.addBearingWall(materialType, DEFAULT_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, {});
      }
      renumberMembers(graph, project, group.mapName);
    });
    pushGraphUndo(graph, before);
    setAxisId(''); setStartId(''); setEndId('');
  }

  return (
    <div style={{ display: 'flex', gap: 6, padding: '4px 10px', alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={axisId} onChange={e => handleAxisChange(e.target.value)} style={selectStyle}>
        <option value="">軸CL...</option>
        {[...graph.gridXs, ...graph.gridYs].map(cl => <option key={cl.id} value={cl.id}>{cl.label}</option>)}
      </select>
      <select value={startId} onChange={e => setStartId(e.target.value)} style={selectStyle} disabled={!axisId}>
        <option value="">始端CL...</option>
        {crossOptions.map(cl => <option key={cl.id} value={cl.id}>{cl.label}</option>)}
      </select>
      <select value={endId} onChange={e => setEndId(e.target.value)} style={selectStyle} disabled={!axisId}>
        <option value="">終端CL...</option>
        {crossOptions.map(cl => <option key={cl.id} value={cl.id}>{cl.label}</option>)}
      </select>
      <button disabled={!axisId || !startId || !endId} onClick={handleAdd} style={addButtonStyle}>＋ 追加</button>
    </div>
  );
});
