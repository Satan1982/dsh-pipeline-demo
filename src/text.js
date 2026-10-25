export function words(text) {
  if (typeof text !== 'string') {
    throw new TypeError('words expects a string');
  }
  return text.split(/\s+/).filter(Boolean);
}

export function wordCount(text) {
  return words(text).length;
}
