export function words(text) {
  if (typeof text !== 'string') {
    throw new TypeError('words expects a string');
  }
  return text.split(/\s+/).filter(Boolean);
}

export function wordCount(text) {
  return words(text).length;
}

export function excerpt(text, n) {
  if (typeof text !== 'string') {
    throw new TypeError('excerpt expects a string');
  }
  if (n <= 0) {
    return '';
  }
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

export function chunk(text, size) {
  if (typeof text !== 'string') {
    throw new TypeError('chunk expects a string');
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError('chunk expects a positive integer size');
  }
  const parts = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

export function initials(fullName) {
  if (typeof fullName !== 'string') {
    throw new TypeError('initials expects a string');
  }
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    throw new TypeError('initials expects a non-empty string');
  }
  return words.map((word) => word[0].toUpperCase()).join('');
}