((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasAmountFormat = api;
})(globalThis, () => {
  const formatters = new Map();
  const digits = value => Number.isInteger(value) && value >= 0 && value <= 8 ? value : 4;
  function format(value, places) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    const precision = digits(places);
    if (!formatters.has(precision)) formatters.set(precision, new Intl.NumberFormat('ko-KR', {maximumFractionDigits: precision}));
    const text = formatters.get(precision).format(value);
    return text === '-0' ? '0' : text;
  }
  return {format, digits};
});
