// 検討チップ（フロアドラム横の「採用/検討」チップ）関連の純関数群。App.jsx から抽出。

// ---- フロアメニュー項目の生成（検討チップのロングタップ・メニュー用）----
// 検討追加（add-alt）は検討チップの短タップが担うため、ここには含めない。
// 並替（move-up/move-down）・階管理・検討操作をすべてここに集約する。
export function buildFloorMenuItems(project, plane) {
  if (plane.isAlternative) {
    const alts = [...project.planeMap.values()]
      .filter(p => p.isAlternative && p.referenceId === plane.referenceId)
      .sort((a, b) => a.altIndex - b.altIndex);
    const i = alts.findIndex(p => p.id === plane.id);
    const items = [];
    if (i > 0)                 items.push({ id: 'move-down', label: '◀ 前の案へ' });
    if (i < alts.length - 1)   items.push({ id: 'move-up',   label: '次の案へ ▶' });
    items.push({ id: 'promote',    label: '採用' });
    items.push({ id: 'copy-alt',   label: '案コピー' });
    items.push({ id: 'delete-alt', label: '削除', danger: true });
    return items;
  }
  const adopted   = project.planes;
  const i         = adopted.findIndex(p => p.id === plane.id);
  const isLowest  = i === 0;
  const isHighest = i === adopted.length - 1;
  const items = [];
  if (isLowest || isLowest === isHighest) items.push({ id: 'floor-change', label: '階変更' });
  if (i >= 2)                items.push({ id: 'move-down', label: '▼ 下の階へ' });
  if (!isHighest && i >= 1)  items.push({ id: 'move-up',   label: '▲ 上の階へ' });
  if (!isLowest && !isHighest) items.push({ id: 'mezzanine', label: '中間階に' });
  if (!isLowest) items.push({ id: 'delete', label: '削除', danger: true });
  return items;
}

// ---- 検討チップの表示派生値（現在の階の採用＋検討案）----
export function buildFloorChipModel(project, floorName) {
  const chipActivePlane = project.activePlane;
  const chipRefId  = chipActivePlane?.isAlternative ? chipActivePlane.referenceId : chipActivePlane?.id;
  const chipAdopted = chipRefId != null ? project.planeMap.get(chipRefId) : null;
  const chipAlts = chipRefId != null
    ? [...project.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === chipRefId)
        .sort((a, b) => a.altIndex - b.altIndex)
    : [];
  const chipVariants = chipAdopted
    ? [{ id: chipAdopted.id, label: '採用', isActive: project.activePlaneId === chipAdopted.id },
       ...chipAlts.map(p => ({ id: p.id, label: p.name, isActive: project.activePlaneId === p.id }))]
    : [];
  const chipText = chipActivePlane
    ? (chipActivePlane.isAlternative ? chipActivePlane.name : `${chipAdopted?.name ?? floorName}：採用`)
    : floorName;
  const chipManagementItems = chipActivePlane ? buildFloorMenuItems(project, chipActivePlane) : [];
  return { chipActivePlane, chipVariants, chipText, chipManagementItems };
}
