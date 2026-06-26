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
import { resolveDefaultMaterialType, alignToOuterFace, autoFillColumnSizes, autoFillColumnBaseSizes, isRigidFrameStructure } from './structuralAutoFill.js';
import { SECTION_CATALOG, findSectionEntry, SectionShape } from './sectionCatalog.js';
import { renumberMembers } from './memberNumbering.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import { LayerRole } from '../figure/figureTypes.js';
import { AutoScaledFigure } from './sectionFigure/AutoScaledFigure.jsx';
import { memberFigure } from './sectionFigure/memberFigures.js';
import { structureShowsMap } from './structureMemberMatrix.js';

// 図上で直接編集する寸法のフィールドキー（断面図の editable dim が担う）。
// これらはカード下部のフォームからは除外し、重複入力を避ける（断面=sectionDefId はカタログ選択のため対象外）。
const FIGURE_DIM_KEYS = new Set(['beamWidth', 'beamDepth', 'thickness', 'widthX', 'widthY', 'pedestalDepth']);

// entity と map から、断面図ジェネレータへ渡す ctx（柱芯オフセット・偏芯・レベルラベル）を組む。
function buildFigureCtx(entity, mapName, graph, project) {
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
    return {
      axisOffset: off(entity.axisCL?.id),
      axisClId: entity.axisCL?.id,
      ecc: typeof entity.eccentricity === 'number' ? entity.eccentricity : 0,
      flLabel: 'FL',
      glLabel: 'GL（FL）',
    };
  }
  if (mapName === 'wallMap') {
    return { axisOffset: off(entity.axisCL?.id), axisClId: entity.axisCL?.id };
  }
  return { flLabel: 'FL' };
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
        // 構造種別が持たない部材分類は隠す（問題.md「構造と部材有無リスト」＝structureMemberMatrix）。
        // ただし既存データがある場合は隠さない（データ消失の誤解を避ける。空グループのみ抑制）。
        const effectiveStructure = g.structureOverride ?? project.structuralInfo?.mainStructure;
        if (!structureShowsMap(effectiveStructure, group.mapName) && g[group.mapName].size === 0) return null;
        // 参照のみ（REFERENCE）レイヤの部材は閲覧可・編集不可。現定義は primary/secondaryEdit のみ＝常に false。
        const readOnly = composition.roleForCategory(group.mapName) === LayerRole.REFERENCE;
        return (
          <MemberGroupSection
            key={group.mapName}
            group={group}
            graph={g}
            composition={composition}
            project={project}
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

// 1分類分のグループ（外部タブの GroupedExteriorTable と同じ「部位ごとの小テーブル」の発想）。
// 同一形状＝同一タグ（部材番号）であるため、リストはタグ（ラベル）単位で1行のみ表示する
// （同じラベルの部材は複数あっても重複表示しない。件数はカード見出しに表示）。
const MemberGroupSection = observer(({ group, graph, composition, project, readOnly, expandedKey, onToggle, onRequestDelete, focusRequest }) => {
  const entities = [...graph[group.mapName].values()];
  const byTag = new Map();
  for (const e of entities) {
    const tag = e.memberNo ?? '(未採番)';
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(e);
  }
  const tagGroups = [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 13, fontWeight: 700, color: '#374151',
        padding: '6px 10px', background: '#f1f5f9',
      }}>
        {group.label}（{tagGroups.length}）
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
      {!readOnly && <NewMemberSelector group={group} graph={graph} project={project} />}
    </div>
  );
});

// タグ（ラベル）1件分のアコーディオンカード（finish/FinishTable.jsx の RoomCard と同型）。
// members は同一タグを共有する全部材（同一形状のため、フィールド編集は全員に伝播する）。
const MemberCard = observer(({ members, group, graph, composition, project, readOnly, isExpanded, onToggle, onDelete, focusRequest }) => {
  const representative = members[0];
  // 図上で編集する寸法フィールドはフォームから除外（断面図の editable dim と二重入力になるため）。
  const allFields = (FIELD_DEFS_BY_CATEGORY[group.category] ?? [])
    .filter(f => f.key in representative && !FIGURE_DIM_KEYS.has(f.key));
  // 「断面」は部材番号の直下（図の上）に置く。残りは図の下に並べる。
  const sectionField = allFields.find(f => f.kind === 'section');
  const fields = allFields.filter(f => f.kind !== 'section');
  const isFocusTarget = isExpanded && focusRequest?.mapName === group.mapName && focusRequest?.tag === representative.memberNo;

  // 断面図ジオメトリ（observableを読むので、フィールド変更時にこのobserverが再render→再描画される）。
  const figure = isExpanded
    ? memberFigure(representative, group.mapName, buildFigureCtx(representative, group.mapName, graph, project))
    : null;
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
                    members={members} fieldDef={sectionField} graph={graph} group={group}
                    readOnly={readOnly}
                  />
                </div>
              </div>
            </div>
          )}
          {/* 断面形状表示（寸法線付き・パネル幅に自動縮尺）。図上の[寸法]クリックで直接編集。
              表示枠は部材分類ごとに異なる（FIGURE_FRAME_BY_MAP、柱は密集するため広め）。 */}
          {figure && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0', overflowX: 'auto' }}>
              <AutoScaledFigure
                primitives={figure.primitives}
                {...(FIGURE_FRAME_BY_MAP[group.mapName] ?? DEFAULT_FIGURE_FRAME)}
                onEditDim={handleEditDim}
              />
            </div>
          )}
          {fields.map(fieldDef => (
            <div key={fieldDef.key} style={cardRowStyle}>
              <div style={cardFieldStyle}>
                <span style={cardLabelStyle}>{fieldDef.label}：</span>
                <div style={cardInputWrapStyle}>
                  <MemberFieldInput
                    members={members} fieldDef={fieldDef} graph={graph} group={group}
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

const MemberFieldInput = observer(({ members, fieldDef, graph, group, readOnly, autoFocus, focusToken }) => {
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
    function handleSectionChange(newId) {
      const defaultMap = group.mapName === 'columnMap' ? DEFAULT_COLUMN_SECTION_BY_MATERIAL : DEFAULT_BEAM_SECTION_BY_MATERIAL;
      const refWidth = findSectionEntry(defaultMap[members[0].materialType])?.width ?? 0;
      const newWidth = findSectionEntry(newId)?.width ?? refWidth;
      for (const m of members) {
        m.setField('sectionDefId', newId);
        m.setDimensionStatus('locked');
        if (!refWidth || newWidth === refWidth) continue;
        if (group.mapName === 'beamMap') {
          const off = graph.columnAxisOffsets.get(m.axisCL.id) ?? 0;
          if (off !== 0) m.setField('eccentricity', alignToOuterFace(m.eccentricity, newWidth, refWidth, Math.sign(off)));
        } else if (group.mapName === 'columnMap') {
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
const NewMemberSelector = observer(({ group, graph, project }) => {
  if (group.mapName === 'columnMap' || group.mapName === 'footingMap') {
    return <NewIntersectionMemberSelector group={group} graph={graph} project={project} />;
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

const NewIntersectionMemberSelector = observer(({ group, graph, project }) => {
  const [vId, setVId] = useState('');
  const [hId, setHId] = useState('');
  const [footingKind, setFootingKind] = useState('independent'); // 'independent'=独立基礎 | 'base'=柱脚

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
          <option value="base">柱脚</option>
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
