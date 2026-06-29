import { observer } from 'mobx-react-lite';
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
  materialLabel, sectionAspectRatio, sectionIconShape,
  DEFAULT_SECTION_BY_MATERIAL, DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL,
  FIGURE_FRAME_BY_MAP, DEFAULT_FIGURE_FRAME,
} from './memberCatalog.js';
import { resolveDefaultMaterialType, alignToOuterFace, autoFillColumnSizes, autoFillColumnBaseSizes, isRigidFrameStructure,
  autoFillBeamEccentricity, autoBeamEccentricity, faceGapForEccentricity } from './structuralAutoFill.js';
import { buildExteriorSide } from './wallGate.js';
import { SECTION_CATALOG, findSectionEntry, SectionShape } from './sectionCatalog.js';
import { renumberMembers } from './memberNumbering.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
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
    return {
      rigid,
      axisOffsetX: off(entity.verticalCL?.id),
      axisOffsetY: off(entity.horizontalCL?.id),
      axisClIdX: entity.verticalCL?.id,   // 変位量の編集対象CL（X系）
      axisClIdY: entity.horizontalCL?.id, // 同（Y系）
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

export const MemberListTab = observer(({ composition, project, focusRequest }) => {
  const [expandedKey, setExpandedKey] = useState(null); // `${mapName}:${タグ}` | null
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { mapName, ids, label } | null

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

  return (
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
        return (
          <MemberGroupSection
            key={group.mapName}
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
          />
        );
      })}
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
const MemberGroupSection = observer(({ group, graph, composition, project, structure, figureType, readOnly, expandedKey, onToggle, onRequestDelete, focusRequest }) => {
  // 構造種別が持たない部材種別（×）の個体は一覧から除外する（footing→ベース/柱脚、beam→梁/基礎梁を role で割る）。
  // structure=null（主構造未設定）は素通し。memberKindOf が null を返す表外部材（軒桁・杭）は structureHasMemberKind=true で残る。
  // R階伏図は figureType=ROOF で個体も取捨する（軒桁＝null は表外で残るが、梁グループ自体が梁ルールで取捨される）。
  const allEntities = [...graph[group.mapName].values()];
  const entities = structure == null ? allEntities : allEntities.filter(e => structureHasMemberKind(memberKindOf(group.mapName, e), structure, figureType));
  const byTag = new Map();
  for (const e of entities) {
    const tag = e.memberNo ?? '(未採番)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(e);
  }
  const tagGroups = [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // 木造系の基礎伏図の梁＝土台基礎。見出しを「土台基礎」に改め、基礎種別（なし/ベタ基礎/土間コン）を右横に置く。
  // 基礎種別は基礎梁の断面に効く建物全体設定（project.structuralInfo.foundationType）を直接編集する。
  const isWoodFoundationBeamGroup = group.mapName === 'beamMap'
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
          />
        );
      })}
      {!readOnly && <NewMemberSelector group={group} graph={graph} project={project} structure={structure} />}
    </div>
  );
});

// タグ（ラベル）1件分のアコーディオンカード（finish/FinishTable.jsx の RoomCard と同型）。
// members は同一タグを共有する全部材（同一形状のため、フィールド編集は全員に伝播する）。
const MemberCard = observer(({ members, group, graph, composition, project, readOnly, isExpanded, onToggle, onDelete, focusRequest }) => {
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

  // 断面図ジオメトリ（observableを読むので、フィールド変更時にこのobserverが再render→再描画される）。
  // frame を渡すと memberFigure が形状基準で縮尺を決め、注記の隙間を px 一定にした図＋その縮尺を返す
  //（スクリーン空間注記。縮尺は下の AutoScaledFigure へそのまま渡す）。
  const figureFrame = FIGURE_FRAME_BY_MAP[group.mapName] ?? DEFAULT_FIGURE_FRAME;
  const isRoof = composition?.subjectPlane?.isRoofPlane ?? false; // R階伏図なら梁の図の FL を RFL にする
  const figure = isExpanded
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
  const handleEditDim = readOnly ? undefined : (dim, value) => {
    if (dim.target === 'axisOffset') {
      // 柱芯の変位は建物グリッド共通。柱は下階グラフから来るため、編集を下階グラフだけに書くと
      // 表示中の階（subject graph）が描く柱芯の軸線・寸法が動かない。composition内の全階グラフへ
      // 同じCLのオフセットを書き、軸線・部材・寸法を一致して再描画させる。
      if (dim.clId != null) {
        const graphs = composition?.bindings?.map(b => b.graph) ?? [graph];
        for (const gg of graphs) gg.setColumnAxisOffset(dim.clId, value);
        // 柱の偏異量を変更したら、反対側の外周CL（X方向=右端CL／Y方向=下端CL）も符号反転で同時更新し、
        // 両端の柱芯インセットを同量に保つ（autoFillColumnAxisOffsets の「最小側+・最大側−」の慣習に従う）。
        // 編集対象がその外周CL自身のときは二重更新を避けてスキップする。X変位=dim('h')→gridXs、Y変位=dim('v')→gridYs。
        if (group.mapName === 'columnMap') {
          const endAxis = dim.dir === 'h' ? graph.gridXs : graph.gridYs;
          const endCL = endAxis[endAxis.length - 1];
          if (endCL && endCL.id !== dim.clId) {
            for (const gg of graphs) gg.setColumnAxisOffset(endCL.id, -value);
          }
        }
      }
      return;
    }
    if (dim.target === 'eccentricity') {
      // 図の偏芯量寸法は絶対値表示。代表梁の現在の向き（無ければ柱外面合わせ＝面一の既定向き）を保って符号付けし、
      // faceGap（柱外面と梁縁のギャップ）を逆算して同一ラベルの全梁に保存する。eccentricity 自体は faceGap から
      // 再算出するため、外周の向きに応じて符号が自動付与され（対辺は逆符号・内部は0）、柱寸法・梁寸法変更にも追従する。
      const exterior = buildExteriorSide(graph); // 外周モデルを1回構築し、以下の偏芯算出すべてで共有
      const def = autoBeamEccentricity(graph, project, representative, 0, exterior); // faceGap=0（面一）の既定偏芯
      const sign = representative.eccentricity !== 0 ? Math.sign(representative.eccentricity) : (def !== 0 ? Math.sign(def) : 1);
      const faceGap = faceGapForEccentricity(graph, project, representative, sign * Math.abs(value), exterior);
      for (const m of members) m.setField('faceGap', faceGap);
      autoFillBeamEccentricity(graph, project, exterior);
      return;
    }
    if (dim.target === 'foundationSection') {
      // 木造基礎の断面詳細寸法（ベース・べた基礎・地中部）。foundationSection オブジェクトの該当キーを差し替える
      //（MobX再描画のためオブジェクトごと置換）。同一ラベルの全基礎梁へ伝播。
      for (const m of members) m.setField('foundationSection', { ...(m.foundationSection ?? {}), [dim.fieldKey]: value });
      return;
    }
    if (dim.target === 'riseAboveGL') {
      // 立ち上がり（GL上）の編集は 成D を rise+地中 に保つ（地中部は維持）。
      for (const m of members) {
        const embed = (m.foundationSection ?? {}).embedDepth ?? 250;
        m.setField('beamDepth', value + embed);
        m.setDimensionStatus('locked');
      }
      return;
    }
    for (const m of members) {
      m.setField(dim.fieldKey, value);
      m.setDimensionStatus('locked');
    }
  };
  return (
    <div
      style={{
        ...cardContainerStyle,
        outline: isExpanded ? '2px solid #2563eb' : 'none',
        outlineOffset: -2,
      }}
    >
      <div style={cardHeaderStyle} onClick={onToggle}>
        <SectionIcon entity={representative} mapName={group.mapName} iconShape={group.iconShape} />
        <span style={{ fontWeight: 700, fontSize: 13, color: '#1e293b' }}>{representative.memberNo ?? '(未採番)'}</span>
        <span style={{ fontSize: 12, color: '#64748b' }}>{materialLabel(representative.materialType)}</span>
        <span style={{ flex: 1, fontSize: 12, color: '#64748b' }}>{summaryDims(representative, group.mapName)}</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>×{members.length}</span>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>{isExpanded ? '▼' : '◀'}</span>
      </div>
      {isExpanded && (
        <div style={cardBodyStyle}>
          <div style={cardRowStyle}>
            <div style={cardFieldStyle}>
              <span style={cardLabelStyle}>部材番号：</span>
              <div style={cardInputWrapStyle}>
                {/* 手動編集すると memberNoLocked=true になり自動採番で上書きされなくなる。
                    「自動に戻す」でロック解除し即時に荷重バンドからの決定値へ再採番する。 */}
                <input
                  value={representative.memberNo ?? ''}
                  onChange={e => members.forEach(m => { m.setMemberNo(e.target.value); m.setMemberNoLocked(true); })}
                  disabled={readOnly}
                  style={cellInputStyle}
                />
                {!readOnly && representative.memberNoLocked && (
                  <button
                    type="button"
                    onClick={() => {
                      members.forEach(m => m.setMemberNoLocked(false));
                      renumberMembers(graph, project, group.mapName);
                    }}
                    style={{ marginLeft: 6, fontSize: 11, cursor: 'pointer' }}
                  >
                    自動に戻す
                  </button>
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
                    readOnly={readOnly}
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
                    readOnly={readOnly}
                    autoFocus={isFocusTarget && focusRequest?.fieldKey === fieldDef.key}
                    focusToken={focusRequest}
                  />
                </div>
              </div>
            </div>
          ))}
          {!readOnly && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
              <button onClick={onDelete} style={deleteButtonStyle}>削除（{members.length}件）</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const MemberFieldInput = observer(({ members, fieldDef, graph, group, project, readOnly, autoFocus, focusToken }) => {
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
  function handleChange(v) {
    for (const m of members) {
      m.setField(fieldDef.key, v);
      if (fieldDef.kind === 'number') m.setDimensionStatus('locked');
    }
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
      const exterior = group.mapName === 'beamMap' ? buildExteriorSide(graph) : null; // 梁のみ外周モデルを1回構築
      for (const m of members) {
        m.setField('sectionDefId', newId);
        m.setDimensionStatus('locked');
        if (group.mapName === 'beamMap') {
          m.setField('eccentricity', autoBeamEccentricity(graph, project, m, m.faceGap ?? 0, exterior)); // 新断面幅 × faceGap で再算出
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
    if (group.mapName === 'beamMap') {
      graph.addBeam(materialType, DEFAULT_BEAM_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, {});
      autoFillBeamEccentricity(graph, project, buildExteriorSide(graph)); // 外周梁なら柱外面合わせの偏芯量を初期算出（faceGap=0＝面一）
    } else {
      graph.addBearingWall(materialType, DEFAULT_SECTION_BY_MATERIAL[materialType], axisCL, isVertical, clStart, clEnd, {});
    }
    renumberMembers(graph, project, group.mapName);
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
