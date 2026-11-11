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
  const isAntigravity = id => typeof id === 'string' && /^antigravity-[a-f0-9]{16}$/.test(id);
  const valid = id => ['codex', 'claude'].includes(id) || isAntigravity(id);
  function ids(records = []) {
    let last;
    for (const row of records) if (isAntigravity(row.provider) && (!last || row.time >= last.time)) last = row;
    const groups = [...new Set(records.filter(row => isAntigravity(row.provider) && row.account === last?.account && row.time === last?.time).map(row => row.provider))].sort().slice(0, 16);
    return ['codex', 'claude', ...groups];
  }
  function name(id, label) {return id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'Antigravity' + (label ? ' · ' + label : '');}
  function color(id, dark = true) {
    if (id === 'codex') return dark ? '#62d0d8' : '#087a86';
    if (id === 'claude') return dark ? '#eeb18c' : '#b05428';
    const hue = [285, 55, 325, 100, 135][(parseInt(String(id).slice(-6), 16) || 0) % 5];
    return 'hsl(' + hue + ' 55% ' + (dark ? 70 : 35) + '%)';
  }
  return {visible, toggle, restore, valid, isAntigravity, ids, name, color};
});
