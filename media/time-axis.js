((scope, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else scope.usageAtlasTimeAxis = api;
})(globalThis, () => {
  const hour = 3600000, weekdays = ['일', '월', '화', '수', '목', '금', '토'];
  const key = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const midnight = time => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date; };
  const nextDay = date => { const next = new Date(date); next.setDate(next.getDate() + 1); return next; };
  const label = (date, month = false, year = false) => `${year ? `${date.getFullYear()}년 ` : ''}${month ? `${date.getMonth() + 1}월 ` : ''}${date.getDate()}일(${weekdays[date.getDay()]})`;

  function layout(domain, width, measure = text => text.length * 8) {
    const [start, end] = domain, span = end - start;
    if (!Number.isFinite(span) || span <= 0 || width <= 0) return {dates: [], hours: [], dayTicks: [], hourTicks: []};
    const x = time => (time - start) / span * width, days = [], dayTicks = [], hourTicks = [];
    // 달력 날짜를 증가시켜 서머타임에도 일 경계를 유지한다.
    for (let date = midnight(start); +date < end; date = nextDay(date)) {
      const next = nextDay(date), a = Math.max(start, +date), b = Math.min(end, +next);
      if (x(b) - x(a) >= 1) days.push({date, key: key(date), time: +date, x: x(a), context: +date < start});
      if (+date >= start && (!dayTicks.length || x(+date) - dayTicks.at(-1) >= 2)) dayTicks.push(x(+date));
    }
    if (+midnight(end) === end) {
      const date = midnight(end);
      dayTicks.push(width); days.push({date, key: key(date), time: end, x: width, context: false});
    }
    const hourlyPixels = width * hour / span;
    if (hourlyPixels >= 2) {
      const first = new Date(start); first.setMinutes(0, 0, 0);
      for (let time = +first < start ? +first + hour : +first; time <= end; time += hour) {
        const date = new Date(time);
        if (date.getHours() !== 0 || date.getMinutes() !== 0) hourTicks.push(x(time));
      }
    }
    const overlaps = (a, b) => a.left < b.right + 8 && a.right + 8 > b.left;
    const choose = (candidates, extraRow = false) => {
      const selected = [];
      for (const candidate of candidates.sort((a, b) => b.priority - a.priority || a.x - b.x)) {
        let placed;
        for (let row = 0; row <= (extraRow && candidate.priority >= 3 ? 1 : 0) && !placed; row++) {
          for (const text of candidate.texts) {
            const size = measure(text);
            for (const anchor of new Set(candidate.context ? ['start'] : [candidate.anchor, 'end', 'start', 'middle'])) {
              const left = candidate.x - (anchor === 'end' ? size : anchor === 'middle' ? size / 2 : 0);
              const item = {...candidate, text, anchor, left, right: left + size, row};
              // 눈금의 x는 이동시키지 않고 글자의 정렬 방향만 바꾼다.
              if (left >= 0 && item.right <= width && !selected.some(other => other.row === row && overlaps(other, item))) {placed = item; break;}
            }
            if (placed) break;
          }
        }
        if (placed) selected.push(placed);
      }
      return selected.sort((a, b) => a.x - b.x);
    };
    const boundaries = new Map();
    for (let i = 1; i < days.length; i++) {
      const before = days[i - 1], after = days[i];
      if (before.date.getMonth() === after.date.getMonth() && before.date.getFullYear() === after.date.getFullYear()) continue;
      const year = before.date.getFullYear() !== after.date.getFullYear();
      boundaries.set(before.key, {year, priority: 3}); boundaries.set(after.key, {year, priority: 4});
    }
    const candidates = days.map(day => {
      const boundary = boundaries.get(day.key);
      const texts = [label(day.date, !!boundary, boundary?.year)];
      if (boundary) texts.push(`${boundary.year ? `${day.date.getFullYear()}/` : ''}${day.date.getMonth() + 1}/${day.date.getDate()}(${weekdays[day.date.getDay()]})`);
      return {...day, texts, keys: [day.key], anchor: 'start', priority: boundary?.priority ?? (day.context ? 1 : 2)};
    });
    const hours = [];
    if (hourlyPixels * 24 >= 140) {
      const stride = [1, 2, 3, 6, 12, 24].find(step => step * hourlyPixels >= 50) || 24;
      const first = new Date(start); first.setMinutes(0, 0, 0);
      for (let time = +first < start ? +first + hour : +first; time <= end; time += hour) {
        const date = new Date(time);
        if (date.getHours() % stride === 0) hours.push({texts: [`${String(date.getHours()).padStart(2, '0')}시`], x: x(time), time, keys: [], anchor: 'middle', priority: 0});
      }
      if (!hours.length) hours.push({texts: [`${String(first.getHours()).padStart(2, '0')}시`], x: 0, time: +first, keys: [], anchor: 'start', priority: 0, context: true});
    }
    return {dates: choose(candidates, true), hours: choose(hours), dayTicks, hourTicks};
  }
  return {layout};
});
