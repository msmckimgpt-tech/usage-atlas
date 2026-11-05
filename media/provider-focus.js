((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasProviderFocus = api;
})(globalThis, () => {
  const normalize = (ids, value) => ids.includes(value) ? value : null;
  function visible(ids, focused) {const target = normalize(ids, focused); return target === null ? [...ids] : [target];}
  function toggle(ids, focused, clicked) {return ids.includes(clicked) ? normalize(ids, focused) === clicked ? null : clicked : normalize(ids, focused);}
  function restore(ids, saved) {
    if (saved?.version === 5) return normalize(ids, saved.focusedProvider);
    if (![3, 4].includes(saved?.version)) return null;
    const selected = ids.filter(id => saved[id] === true);
    return selected.length === 1 && ids.every(id => typeof saved[id] === 'boolean') ? selected[0] : null;
  }
  return {visible, toggle, restore};
});
