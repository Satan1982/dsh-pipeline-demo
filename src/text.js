export function words(text) {
  if (typeof text !== 'string') {
    throw new TypeError('words expects a string');
  }
  return text.split(/\s+/).filter(Boolean);
}

export function wordCount(text) {
  return words(text).length;
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