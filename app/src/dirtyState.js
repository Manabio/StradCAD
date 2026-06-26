let _dirty = false;

export const isDirty  = () => _dirty;
export const markDirty  = () => { _dirty = true; };
export const clearDirty = () => { _dirty = false; };
