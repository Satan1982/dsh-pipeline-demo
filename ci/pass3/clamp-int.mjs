// Integer clamp: truncate toward zero first, then clamp into [min, max].
export function clampInt(x, min, max) {
  for (const [name, value] of [['x', x], ['min', min], ['max', max]]) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`clampInt: ${name} must be a finite number`);
    }
  }

  const truncated = Math.trunc(x);
  return Math.min(max, Math.max(min, truncated));
}
