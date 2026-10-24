export function average(nums) {
  if (nums.length === 0) {
    throw new RangeError('average of empty array');
  }
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

export function median(nums) {
  if (nums.length === 0) {
    throw new RangeError('median of empty array');
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
