import { runInAction } from 'mobx';
import { ShapeType, CenterLine, HDimensionLine, VDimensionLine, DimensionAnchor, DimensionKind, DimensionSide, Discipline, Room, RoomKind, IndependentFooting } from '@core';
import { encode, decode } from './schema/graphFbs.js';
import { packExtraFields, unpackExtraFields } from './structural/fieldPacking.js';

// ----------------------------------------------------------------
// 共通: 通り芯かどうかの判定
// ----------------------------------------------------------------
function isStructCL(s) {
  return s instanceof CenterLine && s.discipline === Discipline.STRUCT && s.labeled;
}

// ----------------------------------------------------------------
// 共通: ベーススタイルプロパティ
// ----------------------------------------------------------------
function baseProps(s) {
  return { discipline: s.discipline, lineWeight: s.lineWeight, lineType: s.lineType, color: s.color };
}

// ----------------------------------------------------------------
// フロアグラフ → snapshot plain object
//
// _structGraph が設定されている場合は struct CL（全階共通）を除外する。
// struct CL は serializeStructCLs で別途保存する。
// ----------------------------------------------------------------
function buildSnapshot(graph) {
  const gs = graph.generalShapes;

  // shapeMap の CenterLine のみ（通り芯は除外、階固有CLのみ）
  const floorCLs = [...graph.shapeMap.values()]
    .filter(s => s instanceof CenterLine && !isStructCL(s));

  return {
    centerLines: floorCLs.map(cl => ({
      id: cl.id, centerLineType: cl.centerLineType,
      value: cl._value, labeled: cl.labeled, trim: cl.trim,
      refId: cl.refId ?? null, refOffset: cl.refOffset ?? 0,
      extentLoRef: cl.extentLoRef ?? null, extentHiRef: cl.extentHiRef ?? null,
      extentLo: cl._extentLo ?? null, extentHi: cl._extentHi ?? null,
      ...baseProps(cl),
    })),
    points: graph.points.map(p => ({ id: p.id, x: p.x, y: p.y })),
    walls: gs.filter(s => s.type === ShapeType.WALL).map(w => ({
      id: w.id, axisCLId: w.axisCL.id, axisOffset: w.axisOffset, isVertical: w.isVertical,
      clStartId: w.clStart.id, startOffset: w.startOffset,
      clEndId:   w.clEnd.id,   endOffset:   w.endOffset,
      isRoomWall: w.isRoomWall,
      isExteriorWall: w.isExteriorWall,
      wallFinish: w.wallFinish ?? null,
      ...baseProps(w),
    })),
    openings: gs.filter(s => s.type === ShapeType.OPENING).map(o => ({
      id: o.id, axisCLId: o.axisCL.id, wallSide: o.wallSide, isVertical: o.isVertical,
      refCLId: o.refCL.id, refOffset: o.refOffset, width: o.width,
      category: o.category, subType: o.subType,
      hingeSide: o.hingeSide, swingSide: o.swingSide,
      ...baseProps(o),
    })),
    diagonals: gs.filter(s => s.type === ShapeType.DIAGONAL).map(d => ({
      id: d.id, nodeAId: d.nodeA.id, nodeBId: d.nodeB.id, ...baseProps(d),
    })),
    verticalLines: gs.filter(s => s.type === ShapeType.VERTICAL).map(v => ({
      id: v.id, clVerticalId: v.clVertical.id,
      clHStartId: v.clHStart.id, clHEndId: v.clHEnd.id, ...baseProps(v),
    })),
    horizontalLines: gs.filter(s => s.type === ShapeType.HORIZONTAL).map(h => ({
      id: h.id, clHorizontalId: h.clHorizontal.id,
      clVStartId: h.clVStart.id, clVEndId: h.clVEnd.id, ...baseProps(h),
    })),
    arcs: gs.filter(s => s.type === ShapeType.ARC).map(a => ({
      id: a.id, centerId: a.center.id,
      radius: a.radius, startAngle: a.startAngle, includedAngle: a.includedAngle,
      ...baseProps(a),
    })),
    circles: gs.filter(s => s.type === ShapeType.CIRCLE).map(c => ({
      id: c.id, centerId: c.center.id, radius: c.radius, ...baseProps(c),
    })),
    dimensionLines: graph.dimensionLines.map(d => ({
      id: d.id, axis: d.axis, dimensionKind: d.dimensionKind, side: d.side,
      footLength: d.footLength, position: d.position,
      anchors: d.anchors.map(a => ({ clId: a.cl?.id ?? null, offset: a.offset, coord: a.coord })),
      ...baseProps(d),
    })),
    rooms: graph.roomOrder
      .filter(id => graph.roomMap.has(id))
      .map(id => {
        const r = graph.roomMap.get(id);
        return {
          id:               r.id,
          name:             r.name,
          cells:            [...r.cells],
          referenceRoomIds: [...r.referenceRoomIds],
          kind:             r.kind,
          generatedWallIds: [...r.generatedWallIds],
          hasNamePosition:  r.namePosition != null,
          posX:             r.namePosition?.x ?? 0,
          posY:             r.namePosition?.y ?? 0,
          templateKey:      r.templateKey ?? null,
          floorLevel:       r.floorLevel ?? null,
          // 個別上書きポケット（選択された材のみが結果的に永続化される）
          overrides:        [...r.customOverrides].map(([key, value]) => ({ key, value: String(value) })),
          finish: {
            floorMaterial:     r.finish.floorMaterial,
            baseboardMaterial: r.finish.baseboardMaterial,
            baseboardHeight:   r.finish.baseboardHeight,
            dadoMaterial:      r.finish.dadoMaterial,
            dadoHeight:        r.finish.dadoHeight,
            ceilingMaterial:   r.finish.ceilingMaterial,
            cornice:           r.finish.cornice,
            note:              r.finish.note,
          },
        };
      }),
    roomOrder: [...graph.roomOrder],
    interiorWallPanel:   graph.interiorWallPanel,
    exteriorWallBacking: graph.exteriorWallBacking,
    interiorWallBacking: graph.interiorWallBacking,
    ceilingBacking:      graph.ceilingBacking,
    floorBacking:        graph.floorBacking,
    floorDatum:          graph.floorDatum,
    structureOverride:   graph.structureOverride ?? null,
    edges: graph.edges.map(e => ({
      key:        e.key,
      masterType: e.masterType ?? null,
      overrides:  [...e.overrides].map(([key, value]) => ({ key, value: String(value) })),
    })),
    // 構造モード（柱・梁・耐力壁・耐力壁開口・スラブ・基礎・柱脚・貫通孔）
    columns: graph.columns.map(c => {
      const [extraKeys, extraVals] = packExtraFields(c,
        ['pileType', 'pileDiameter', 'columnType', 'woodSpecies', 'basePlateDefId', 'mainBars', 'hoopBars',
          'dimensionStatus', 'memberNoLocked', 'tributaryWidth']);
      return {
        id: c.id, materialType: c.materialType, sectionDefId: c.sectionDefId,
        verticalCLId: c.verticalCL.id, horizontalCLId: c.horizontalCL.id,
        eccX: c.eccentricity.x, eccY: c.eccentricity.y, rotation: c.rotation,
        role: c.role, topLevel: c.topLevel, bottomLevel: c.bottomLevel,
        memberNo: c.memberNo, extraKeys, extraVals,
      };
    }),
    beams: graph.beams.map(bm => {
      const [extraKeys, extraVals] = packExtraFields(bm,
        ['beamType', 'isCambered', 'stiffenerCount', 'topMainBars', 'bottomMainBars', 'stirrupBars', 'dimensionStatus', 'memberNoLocked',
          'beamWidth', 'beamDepth', 'faceGap', 'foundationSection']);
      return {
        id: bm.id, materialType: bm.materialType, sectionDefId: bm.sectionDefId,
        axisCLId: bm.axisCL.id, isVertical: bm.isVertical,
        clStartId: bm.clStart.id, clEndId: bm.clEnd.id,
        eccentricity: bm.eccentricity, jointStart: bm.jointCondition.start, jointEnd: bm.jointCondition.end,
        role: bm.role, levelOffset: bm.levelOffset,
        startLevelOffset: bm.startLevelOffset, endLevelOffset: bm.endLevelOffset,
        memberNo: bm.memberNo, extraKeys, extraVals,
      };
    }),
    structuralWalls: graph.structuralWalls.map(w => {
      const [extraKeys, extraVals] = packExtraFields(w, ['verticalBars', 'horizontalBars', 'dimensionStatus', 'memberNoLocked', 'wallType']);
      return {
        id: w.id, materialType: w.materialType, sectionDefId: w.sectionDefId,
        axisCLId: w.axisCL.id, isVertical: w.isVertical,
        clStartId: w.clStart.id, clEndId: w.clEnd.id,
        eccentricity: w.eccentricity, thickness: w.thickness,
        topLevel: w.topLevel, bottomLevel: w.bottomLevel,
        memberNo: w.memberNo, extraKeys, extraVals,
      };
    }),
    wallOpenings: graph.wallOpenings.map(o => {
      const [extraKeys, extraVals] = packExtraFields(o, ['lintelBars']);
      return {
        id: o.id, wallId: o.wall.id, offset: o.offset, width: o.width,
        height: o.height, sillHeight: o.sillHeight, affectsEffectiveLength: o.affectsEffectiveLength,
        extraKeys, extraVals,
      };
    }),
    slabs: graph.slabs.map(s => {
      const [extraKeys, extraVals] = packExtraFields(s, ['mainBars', 'distributionBars', 'dimensionStatus', 'memberNoLocked', 'slabKind', 'deckDirection']);
      return {
        id: s.id, materialType: s.materialType, sectionDefId: s.sectionDefId,
        cells: [...s.cells], thickness: s.thickness, floorLevel: s.floorLevel,
        role: s.role, levelRef: s.levelRef,
        slopeDirX: s.slopeDirection?.dx ?? null, slopeDirY: s.slopeDirection?.dy ?? null,
        slopeAngle: s.slopeAngle, memberNo: s.memberNo, extraKeys, extraVals,
      };
    }),
    footings: graph.footings.map(f => {
      const [extraKeys, extraVals] = packExtraFields(f,
        ['footingType', 'mainBars', 'supportType', 'baseType', 'basePlateDefId', 'anchorBoltCount', 'anchorBoltSize',
          'dimensionStatus', 'memberNoLocked', 'pedestalDepth']);
      return {
        id: f.id, kind: f instanceof IndependentFooting ? 'independent' : 'base',
        materialType: f.materialType, sectionDefId: f.sectionDefId,
        verticalCLId: f.verticalCL.id, horizontalCLId: f.horizontalCL.id,
        eccX: f.eccentricity.x, eccY: f.eccentricity.y,
        topLevel: f.topLevel, bottomLevel: f.bottomLevel,
        sectionShape: f.sectionShape, widthX: f.widthX, widthY: f.widthY,
        memberNo: f.memberNo, extraKeys, extraVals,
      };
    }),
    sleeves: graph.sleeves.map(s => ({
      id: s.id, hostType: s.hostType,
      hostBeamId: s.hostBeamId ?? null, hostAxisCLId: s.hostAxisCL?.id ?? null,
      hostClStartId: s.hostClStart?.id ?? null, hostClEndId: s.hostClEnd?.id ?? null,
      localPos: s.localPos, heightOffset: s.heightOffset,
      hostSlabId: s.hostSlabId ?? null, hostCellKey: s.hostCellKey ?? null,
      localX: s.localX, localY: s.localY, diameter: s.diameter, hasReinforcement: s.hasReinforcement,
    })),
    excludedColumnSlots:  [...graph.excludedColumnSlots],
    excludedBeamSlots:    [...graph.excludedBeamSlots],
    excludedFootingSlots: [...graph.excludedFootingSlots],
    // 柱芯（ColumnAxis）オフセット。CL id → 通り芯からの偏心量(mm)。
    columnAxisOffsetKeys: [...graph.columnAxisOffsets.keys()],
    columnAxisOffsetVals: [...graph.columnAxisOffsets.values()].map(String),
  };
}

// ----------------------------------------------------------------
// 通り芯専用 snapshot (structGraph 用)
// CenterLine のみ。Shape / Intersection は不要（addCenterLine が再生成）。
// ----------------------------------------------------------------
function buildStructSnapshot(structGraph, structuralInfo, tagRegistry) {
  return {
    centerLines: [...structGraph.shapeMap.values()]
      .filter(s => isStructCL(s))
      .map(cl => ({
        id: cl.id, centerLineType: cl.centerLineType,
        value: cl._value, labeled: cl.labeled, trim: cl.trim,
        refId: cl.refId ?? null, refOffset: cl.refOffset ?? 0,
        extentLoRef: cl.extentLoRef ?? null, extentHiRef: cl.extentHiRef ?? null,
        extentLo: cl._extentLo ?? null, extentHi: cl._extentHi ?? null,
        ...baseProps(cl),
      })),
    // 残フィールドは空（encode が nullable として処理する）
    points: [], walls: [], diagonals: [], verticalLines: [],
    horizontalLines: [], arcs: [], circles: [], dimensionLines: [],
    // 建物全体: 構造情報（project.structuralInfo）。per-floor の snapshot では使用しない
    structuralInfo: {
      mainStructure:      structuralInfo.mainStructure,
      otherStructures:    [...structuralInfo.otherStructures],
      foundationType:     structuralInfo.foundationType,
      designStrength:     structuralInfo.designStrength,
      concreteType:       structuralInfo.concreteType,
      mainBar:            structuralInfo.mainBar,
      hoopBar:            structuralInfo.hoopBar,
      snowArea:           structuralInfo.snowArea,
      basicWindSpeed:     structuralInfo.basicWindSpeed,
      surfaceRoughness:   structuralInfo.surfaceRoughness,
      seismicZoneFactor:  structuralInfo.seismicZoneFactor,
    },
    // 建物全体: 構造部材タグ台帳（project.structuralTagRegistry）。per-floor の snapshot では使用しない
    tagRegistryKeys: tagRegistry ? [...tagRegistry.keys()]   : [],
    tagRegistryVals: tagRegistry ? [...tagRegistry.values()] : [],
  };
}

// ----------------------------------------------------------------
// シリアライズ: フロアグラフ → Uint8Array
// ----------------------------------------------------------------
export function serializeGraph(graph) {
  return encode(buildSnapshot(graph));
}

// ----------------------------------------------------------------
// シリアライズ: 通り芯グラフ → Uint8Array
// ----------------------------------------------------------------
export function serializeStructCLs(structGraph, structuralInfo, tagRegistry) {
  return encode(buildStructSnapshot(structGraph, structuralInfo, tagRegistry));
}

// ----------------------------------------------------------------
// ノード解決ヘルパー
// structGraph の CLId も参照できるよう _structGraph を考慮する
// ----------------------------------------------------------------
function resolveNode(graph, id) {
  if (graph.intersectionMap.has(id)) return graph.intersectionMap.get(id);
  if (graph._structGraph?.intersectionMap.has(id)) return graph._structGraph.intersectionMap.get(id);
  if (graph.pointMap.has(id)) return graph.pointMap.get(id);
  const sep = id.indexOf(':');
  if (sep > 0) {
    const clVId = id.slice(0, sep);
    const clHId = id.slice(sep + 1);
    const clV = graph.shapeMap.get(clVId) ?? graph._structGraph?.shapeMap.get(clVId);
    const clH = graph.shapeMap.get(clHId) ?? graph._structGraph?.shapeMap.get(clHId);
    if (clV && clH) return graph.getOrCreateIntersection(clV, clH);
  }
  return null;
}

// CLId を shapeMap + structGraph.shapeMap の両方から解決するヘルパー
function resolveCL(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id);
}

// ----------------------------------------------------------------
// デシリアライズ: Uint8Array | ArrayBuffer | plain object → フロアグラフ
// ----------------------------------------------------------------
export function restoreGraph(graph, data) {
  let snapshot;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    snapshot = decode(data);
  } else if (typeof data === 'string') {
    snapshot = JSON.parse(data);
  } else {
    snapshot = data;
  }
  applySnapshot(graph, snapshot);
}

// ----------------------------------------------------------------
// デシリアライズ: Uint8Array | plain object → 通り芯グラフ
// ----------------------------------------------------------------
export function restoreStructCLs(structGraph, structuralInfo, data, tagRegistry) {
  let snapshot;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    snapshot = decode(data);
  } else if (typeof data === 'string') {
    snapshot = JSON.parse(data);
  } else {
    snapshot = data;
  }
  runInAction(() => {
    structGraph.clear();
    for (const d of snapshot.centerLines ?? []) {
      structGraph.addCenterLine(d.centerLineType, d.value, {
        labeled: d.labeled, trim: d.trim ?? false, discipline: d.discipline,
        lineWeight: d.lineWeight, lineType: d.lineType, color: d.color,
        extentLoRef: d.extentLoRef ?? null, extentHiRef: d.extentHiRef ?? null,
        extentLo: d.extentLo ?? null, extentHi: d.extentHi ?? null,
        refId: d.refId ?? null, refOffset: d.refOffset ?? 0,
      }, d.id);
    }

    // 建物全体: 構造情報（保存があれば反映。なければ既定値を維持）
    const si = snapshot.structuralInfo;
    if (si) {
      structuralInfo.setField('mainStructure',      si.mainStructure);
      structuralInfo.otherStructures.replace(si.otherStructures ?? []);
      structuralInfo.setField('foundationType',     si.foundationType);
      structuralInfo.setField('designStrength',     si.designStrength);
      structuralInfo.setField('concreteType',       si.concreteType);
      structuralInfo.setField('mainBar',            si.mainBar);
      structuralInfo.setField('hoopBar',             si.hoopBar);
      structuralInfo.setField('snowArea',            si.snowArea);
      structuralInfo.setField('basicWindSpeed',      si.basicWindSpeed);
      structuralInfo.setField('surfaceRoughness',    si.surfaceRoughness);
      structuralInfo.setField('seismicZoneFactor',   si.seismicZoneFactor);
    }

    // 建物全体: 構造部材タグ台帳（project.structuralTagRegistry）
    if (tagRegistry) {
      const keys = snapshot.tagRegistryKeys ?? [];
      const vals = snapshot.tagRegistryVals ?? [];
      for (let i = 0; i < keys.length; i++) tagRegistry.set(keys[i], vals[i]);
    }
  });
}

// ----------------------------------------------------------------
// snapshot → フロアグラフ (runInAction で一括反映)
// ----------------------------------------------------------------
function applySnapshot(graph, snapshot) {
  runInAction(() => {
    graph.clear();

    // 1. 階固有の中心線（center / aux）
    for (const d of snapshot.centerLines) {
      graph.addCenterLine(d.centerLineType, d.value, {
        labeled: d.labeled, trim: d.trim ?? false, discipline: d.discipline,
        lineWeight: d.lineWeight, lineType: d.lineType, color: d.color,
        extentLoRef: d.extentLoRef ?? null, extentHiRef: d.extentHiRef ?? null,
        extentLo: d.extentLo ?? null, extentHi: d.extentHi ?? null,
        refId: d.refId ?? null, refOffset: d.refOffset ?? 0,
      }, d.id);
    }

    // 2. 自由点
    for (const d of snapshot.points) graph.addPoint(d.x, d.y, d.id);

    // 3. 壁（軸CLは structGraph からも解決）
    for (const d of snapshot.walls) {
      const axisCL  = resolveCL(graph, d.axisCLId);
      const clStart = resolveCL(graph, d.clStartId);
      const clEnd   = resolveCL(graph, d.clEndId);
      if (axisCL && clStart && clEnd) {
        graph.addWall(axisCL, d.axisOffset ?? 0, d.isVertical, clStart, d.startOffset, clEnd, d.endOffset,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color, isRoomWall: d.isRoomWall ?? false, isExteriorWall: d.isExteriorWall ?? false, wallFinish: d.wallFinish ?? null }, d.id);
      }
    }
    graph.resolveExtentWallRefs();

    // 3.5. 構造: 柱 → 梁 → 耐力壁 → 耐力壁開口（親壁解決後）→ 基礎・柱脚
    for (const d of snapshot.columns ?? []) {
      const verticalCL   = resolveCL(graph, d.verticalCLId);
      const horizontalCL = resolveCL(graph, d.horizontalCLId);
      if (verticalCL && horizontalCL) {
        const c = graph.addColumn(d.materialType, d.sectionDefId, verticalCL, horizontalCL, {
          eccentricity: { x: d.eccX, y: d.eccY }, rotation: d.rotation,
          role: d.role, topLevel: d.topLevel, bottomLevel: d.bottomLevel,
          ...unpackExtraFields(d.extraKeys, d.extraVals),
        }, d.id);
        if (d.memberNo) c.setMemberNo(d.memberNo);
      }
    }
    for (const d of snapshot.beams ?? []) {
      const axisCL  = resolveCL(graph, d.axisCLId);
      const clStart = resolveCL(graph, d.clStartId);
      const clEnd   = resolveCL(graph, d.clEndId);
      if (axisCL && clStart && clEnd) {
        const bm = graph.addBeam(d.materialType, d.sectionDefId, axisCL, d.isVertical, clStart, clEnd, {
          eccentricity: d.eccentricity, jointCondition: { start: d.jointStart, end: d.jointEnd },
          role: d.role, levelOffset: d.levelOffset,
          startLevelOffset: d.startLevelOffset, endLevelOffset: d.endLevelOffset,
          ...unpackExtraFields(d.extraKeys, d.extraVals),
        }, d.id);
        if (d.memberNo) bm.setMemberNo(d.memberNo);
      }
    }
    for (const d of snapshot.structuralWalls ?? []) {
      const axisCL  = resolveCL(graph, d.axisCLId);
      const clStart = resolveCL(graph, d.clStartId);
      const clEnd   = resolveCL(graph, d.clEndId);
      if (axisCL && clStart && clEnd) {
        const w = graph.addBearingWall(d.materialType, d.sectionDefId, axisCL, d.isVertical, clStart, clEnd, {
          eccentricity: d.eccentricity, thickness: d.thickness,
          topLevel: d.topLevel, bottomLevel: d.bottomLevel,
          ...unpackExtraFields(d.extraKeys, d.extraVals),
        }, d.id);
        if (d.memberNo) w.setMemberNo(d.memberNo);
      }
    }
    for (const d of snapshot.wallOpenings ?? []) {
      const wall = graph.wallMap.get(d.wallId);
      if (wall) {
        graph.addWallOpening(wall, d.offset, d.width, {
          height: d.height, sillHeight: d.sillHeight, affectsEffectiveLength: d.affectsEffectiveLength,
          ...unpackExtraFields(d.extraKeys, d.extraVals),
        }, d.id);
      }
    }
    for (const d of snapshot.footings ?? []) {
      const verticalCL   = resolveCL(graph, d.verticalCLId);
      const horizontalCL = resolveCL(graph, d.horizontalCLId);
      if (verticalCL && horizontalCL) {
        const f = graph.addFooting(d.kind, d.sectionDefId, verticalCL, horizontalCL, {
          materialType: d.materialType, eccentricity: { x: d.eccX, y: d.eccY },
          topLevel: d.topLevel, bottomLevel: d.bottomLevel,
          sectionShape: d.sectionShape, widthX: d.widthX, widthY: d.widthY,
          ...unpackExtraFields(d.extraKeys, d.extraVals),
        }, d.id);
        if (d.memberNo) f.setMemberNo(d.memberNo);
      }
    }

    // 3a. 開口（建具・窓）— axisCL/refCL は壁と同じ resolveCL(structGraph フォールバック込み)で解決。
    // Wall 自体の存在には依存しないため、Wall 復元の直後であれば順序の制約は緩い。
    for (const d of snapshot.openings ?? []) {
      const axisCL = resolveCL(graph, d.axisCLId);
      const refCL  = resolveCL(graph, d.refCLId);
      if (axisCL && refCL) {
        graph.addOpening(axisCL, d.wallSide, d.isVertical, refCL, d.refOffset, d.width, d.category, d.subType,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color,
            hingeSide: d.hingeSide, swingSide: d.swingSide }, d.id);
      }
    }

    // 4. 斜線
    for (const d of snapshot.diagonals) {
      const nodeA = resolveNode(graph, d.nodeAId);
      const nodeB = resolveNode(graph, d.nodeBId);
      if (nodeA && nodeB) {
        graph.addDiagonalLine(nodeA, nodeB,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color }, d.id);
      }
    }

    // 5. 垂直線
    for (const d of snapshot.verticalLines) {
      const clV  = resolveCL(graph, d.clVerticalId);
      const clH1 = resolveCL(graph, d.clHStartId);
      const clH2 = resolveCL(graph, d.clHEndId);
      if (clV && clH1 && clH2) {
        graph.addVerticalLine(clV, clH1, clH2,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color }, d.id);
      }
    }

    // 6. 水平線
    for (const d of snapshot.horizontalLines) {
      const clH  = resolveCL(graph, d.clHorizontalId);
      const clV1 = resolveCL(graph, d.clVStartId);
      const clV2 = resolveCL(graph, d.clVEndId);
      if (clH && clV1 && clV2) {
        graph.addHorizontalLine(clH, clV1, clV2,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color }, d.id);
      }
    }

    // 7. 円弧
    for (const d of snapshot.arcs) {
      const center = resolveNode(graph, d.centerId);
      if (center) {
        graph.addArc(center, d.radius, d.startAngle, d.includedAngle,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color }, d.id);
      }
    }

    // 8. 円
    for (const d of snapshot.circles) {
      const center = resolveNode(graph, d.centerId);
      if (center) {
        graph.addCircle(center, d.radius,
          { discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color }, d.id);
      }
    }

    // 9. 寸法線（アンカーCLは structGraph からも解決）
    for (const d of snapshot.dimensionLines ?? []) {
      const anchors = (d.anchors ?? []).map(a => {
        const cl = a.clId ? (resolveCL(graph, a.clId) ?? null) : null;
        return new DimensionAnchor({ cl, offset: a.offset ?? 0, coord: a.coord ?? null });
      });
      const LineClass = d.axis === 'X' ? HDimensionLine : VDimensionLine;
      graph.addDimensionLine(LineClass, {
        dimensionKind: d.dimensionKind, side: d.side,
        anchors, footLength: d.footLength, position: d.position,
        discipline: d.discipline, lineWeight: d.lineWeight, lineType: d.lineType, color: d.color,
      }, d.id);
    }
    // 9.5. GRID/CENTER の4周（top/bottom/left/right）は store.js が新規フロアに自動生成する前提の
    // 常設行（GutterLayer 等が無条件に存在を仮定する）。CENTER 寸法線の導入(*1)より古い
    // 保存データには無いため、復元後に欠けている行のみ補完する（既存行は上書きしない）。
    // *1 ガター内通り芯線描画コンポーネント追加コミットで導入。
    for (const [dimensionKind, LineClass, side] of [
      [DimensionKind.GRID,   HDimensionLine, DimensionSide.TOP],
      [DimensionKind.GRID,   HDimensionLine, DimensionSide.BOTTOM],
      [DimensionKind.GRID,   VDimensionLine, DimensionSide.LEFT],
      [DimensionKind.GRID,   VDimensionLine, DimensionSide.RIGHT],
      [DimensionKind.CENTER, HDimensionLine, DimensionSide.TOP],
      [DimensionKind.CENTER, HDimensionLine, DimensionSide.BOTTOM],
      [DimensionKind.CENTER, VDimensionLine, DimensionSide.LEFT],
      [DimensionKind.CENTER, VDimensionLine, DimensionSide.RIGHT],
    ]) {
      const exists = graph.dimensionLines.some(d => d.dimensionKind === dimensionKind && d.side === side);
      if (!exists) graph.addDimensionLine(LineClass, { dimensionKind, side });
    }

    // 10. 部屋（仕上げモード）— roomOrder 順で roomMap に登録してから順序を上書き
    for (const d of snapshot.rooms ?? []) {
      const room = new Room(d.id, d.name || '', new Set(d.cells), new Set(d.referenceRoomIds),
        d.kind || RoomKind.INTERIOR, d.templateKey ?? null);
      room.generatedWallIds = new Set(d.generatedWallIds);
      if (d.hasNamePosition) room.setNamePosition(d.posX, d.posY);
      if (d.floorLevel != null) room.setFloorLevel(d.floorLevel);
      for (const [key, val] of Object.entries(d.finish ?? {})) {
        if (val) room.finish.setField(key, val);
      }
      // 個別上書きポケットを verbatim 復元（ceilingHeight は数値へ復元）
      for (const ov of d.overrides ?? []) {
        const value = ov.key === 'ceilingHeight' ? Number(ov.value) : ov.value;
        room.customOverrides.set(ov.key, value);
      }
      graph.roomMap.set(room.id, room);
    }
    const savedOrder = snapshot.roomOrder ?? [];
    graph.roomOrder.replace(savedOrder.filter(id => graph.roomMap.has(id)));

    // 10.5. 構造: スラブ（cellsのみ、CL非依存）→ 貫通孔（ホスト梁/スラブのID参照解決）
    for (const d of snapshot.slabs ?? []) {
      const s = graph.addSlab(d.materialType, d.sectionDefId, new Set(d.cells), {
        thickness: d.thickness, floorLevel: d.floorLevel,
        role: d.role, levelRef: d.levelRef,
        slopeDirection: (d.slopeDirX != null && d.slopeDirY != null) ? { dx: d.slopeDirX, dy: d.slopeDirY } : null,
        slopeAngle: d.slopeAngle,
        ...unpackExtraFields(d.extraKeys, d.extraVals),
      }, d.id);
      if (d.memberNo) s.setMemberNo(d.memberNo);
    }
    for (const d of snapshot.sleeves ?? []) {
      const props = d.hostType === 'beam'
        ? {
            hostBeamId: d.hostBeamId,
            hostAxisCL:  resolveCL(graph, d.hostAxisCLId),
            hostClStart: resolveCL(graph, d.hostClStartId),
            hostClEnd:   resolveCL(graph, d.hostClEndId),
            localPos: d.localPos, heightOffset: d.heightOffset,
            diameter: d.diameter, hasReinforcement: d.hasReinforcement,
          }
        : {
            hostSlabId: d.hostSlabId, hostCellKey: d.hostCellKey,
            localX: d.localX, localY: d.localY,
            diameter: d.diameter, hasReinforcement: d.hasReinforcement,
          };
      graph.addSleeve(d.hostType, props, d.id);
    }

    // 11. per-floor 設定（保存があれば上書き。なければ clear() の既定値を維持）
    if (snapshot.interiorWallPanel)   graph.setInteriorWallPanel(snapshot.interiorWallPanel);
    if (snapshot.exteriorWallBacking) graph.setExteriorWallBacking(snapshot.exteriorWallBacking);
    if (snapshot.interiorWallBacking) graph.setInteriorWallBacking(snapshot.interiorWallBacking);
    if (snapshot.ceilingBacking)      graph.setCeilingBacking(snapshot.ceilingBacking);
    if (snapshot.floorBacking)        graph.setFloorBacking(snapshot.floorBacking);
    if (snapshot.floorDatum != null)  graph.setFloorDatum(snapshot.floorDatum);
    if (snapshot.structureOverride)   graph.setStructureOverride(snapshot.structureOverride);
    for (const k of snapshot.excludedColumnSlots  ?? []) graph.excludedColumnSlots.add(k);
    for (const k of snapshot.excludedBeamSlots    ?? []) graph.excludedBeamSlots.add(k);
    for (const k of snapshot.excludedFootingSlots ?? []) graph.excludedFootingSlots.add(k);
    const axisKeys = snapshot.columnAxisOffsetKeys ?? [];
    const axisVals = snapshot.columnAxisOffsetVals ?? [];
    axisKeys.forEach((clId, i) => graph.columnAxisOffsets.set(clId, Number(axisVals[i])));

    // 12. 境界エッジ（仕上げモード）— overrides は verbatim 復元
    for (const d of snapshot.edges ?? []) {
      graph.addEdge(d.key, d.masterType ?? null, (d.overrides ?? []).map(o => [o.key, o.value]));
    }
  });
}
