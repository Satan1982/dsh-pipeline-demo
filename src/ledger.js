function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= maxDay;
}

function isValidMonth(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function assertEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }
}

export function addEntry(entries, entry) {
  assertEntries(entries);
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError('entry must be an object');
  }
  if (!isValidDate(entry.date)) {
    throw new TypeError('entry.date must be YYYY-MM-DD');
  }
  if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) {
    throw new TypeError('entry.amount must be a finite number');
  }
  return [
    ...entries,
    { date: entry.date, amount: entry.amount, note: entry.note },
  ];
}

export function summarize(entries, ym) {
  assertEntries(entries);
  if (!isValidMonth(ym)) {
    throw new TypeError('ym must be YYYY-MM');
  }
  const prefix = `${ym}-`;
  let income = 0;
  let expense = 0;
  for (const entry of entries) {
    if (typeof entry.date !== 'string' || !entry.date.startsWith(prefix)) {
      continue;
    }
    if (entry.amount > 0) {
      income += entry.amount;
    } else if (entry.amount < 0) {
      expense -= entry.amount;
    }
  }
  return { income, expense, balance: income - expense };
}