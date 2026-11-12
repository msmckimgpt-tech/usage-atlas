((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasProviderVisibility = api;
})(globalThis, () => {
  function visible(ids, hidden = []) {return ids.filter(id => !hidden.includes(id));}
  function toggle(ids, hidden = [], clicked) {
    if (!ids.includes(clicked)) return [...hidden];
    return hidden.includes(clicked) ? hidden.filter(id => id !== clicked) : [...hidden, clicked];
  }
  function restore(ids, saved) {
    if (saved?.version === 6 && Array.isArray(saved.hiddenProviders)) return [...new Set(saved.hiddenProviders.filter(id => typeof id === 'string' && (ids.includes(id) || valid(id) || id === 'antigravity')))].slice(0, 128);
    if (saved?.version === 5) return ids.includes(saved.focusedProvider) ? ids.filter(id => id !== saved.focusedProvider) : [];
    if (![3, 4].includes(saved?.version)) return [];
    const selected = ids.filter(id => saved[id] === true);
    return selected.length === 1 && ids.every(id => typeof saved[id] === 'boolean') ? ids.filter(id => !selected.includes(id)) : [];
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
  const displaySettings = {
      showCodex: 'display.codex'
    , showClaude: 'display.claude'
    , showAntigravity: 'display.antigravity'
    , showAntigravityGemini: 'display.antigravityGemini'
    , showAntigravityClaudeGpt: 'display.antigravityClaudeGpt'
    , showAntigravityArgon: 'display.antigravityArgon'
  };
  const groupSettings = {
      'antigravity-5d72436256ada538': 'showAntigravityGemini'
    , 'antigravity-70e9d05c2321d220': 'showAntigravityClaudeGpt'
    , 'antigravity-752d865b3431c7da': 'showAntigravityArgon'
  };
  function settings(get) {return Object.fromEntries(Object.entries(displaySettings).map(([key, setting]) => [key, get(setting, true) !== false]));}
  function enabled(id, provider, options = {}) {
    if (id === 'codex') return options.showCodex !== false;
    if (id === 'claude') return options.showClaude !== false;
    if (options.showAntigravity === false) return false;
    if (id === 'antigravity') return ['showAntigravityGemini', 'showAntigravityClaudeGpt', 'showAntigravityArgon'].some(key => options[key] !== false);
    const label = provider?.last?.label;
    const key = groupSettings[id] || ({Gemini: 'showAntigravityGemini', 'Claude/GPT': 'showAntigravityClaudeGpt', Argon: 'showAntigravityArgon'}[label]);
    return !key || options[key] !== false;
  }
  return {visible, toggle, restore, valid, isAntigravity, ids, name, color, displaySettings, settings, enabled};
});
