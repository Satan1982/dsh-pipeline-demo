export function average(nums) {
  if (nums.length === 0) {
    throw new RangeError('average of empty array');
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

export function median(nums) {
  if (nums.length === 0) {
    throw new RangeError('median of empty array');
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}