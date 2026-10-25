function isPalindrome(text) {
  if (typeof text !== 'string') {
    throw new TypeError('isPalindrome expects a string');
  }
  const cleaned = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleaned.length <= 1) return true;
  for (let i = 0; i < cleaned.length / 2; i++) {
    if (cleaned[i] !== cleaned[cleaned.length - 1 - i]) {
      return false;
    }
  }
  return true;
}

export function capitalize(s) {
  if (typeof s !== 'string') {
    throw new TypeError('capitalize expects a string');
  }
  if (s.length === 0) return '';
  return s[0].toUpperCase() + s.slice(1);
}

export function reverseWords(s) {
  if (typeof s !== 'string') {
    throw new TypeError('reverseWords expects a string');
  }
  return s.trim().split(/\s+/).filter(Boolean).reverse().join(' ');
}

export function countVowels(s) {
  if (typeof s !== 'string') {
    throw new TypeError('countVowels expects a string');
  }
  return (s.match(/[aeiou]/gi) || []).length;
}

export function repeatText(s, n) {
  if (typeof s !== 'string') {
    throw new TypeError('repeatText expects a string');
  }
  if (n <= 0) return '';
  return s.repeat(n);
}

export { isPalindrome };