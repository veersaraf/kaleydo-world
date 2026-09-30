// Math.hypot without the garbage: the engine's own version makes an array (and boxes the result)
// on every call, and the match and the animators call it hundreds of times a frame. These are the
// same arithmetic, step for step (its scaled sum; the compensation term of its Kahan sum is 0
// after the first term and unused after the last), so they return exactly the same numbers: a
// rally plays out identically with either. scripts/hypot-check.ts compares them with Math.hypot.

export function hyp2(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  if (a === Infinity || b === Infinity) return Infinity;
  if (a !== a || b !== b) return NaN;
  const max = a > b ? a : b;
  if (max === 0) return 0;
  const na = a / max;
  const nb = b / max;
  return Math.sqrt(na * na + nb * nb) * max;
}

export function hyp3(a: number, b: number, c: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  c = Math.abs(c);
  if (a === Infinity || b === Infinity || c === Infinity) return Infinity;
  if (a !== a || b !== b || c !== c) return NaN;
  let max = a > b ? a : b;
  if (c > max) max = c;
  if (max === 0) return 0;
  // (the first term leaves nothing to compensate; the second's rounding is carried into the third)
  let n = a / max;
  let sum = n * n;
  let comp = 0;
  n = b / max;
  let summand = n * n - comp;
  let pre = sum + summand;
  comp = pre - sum - summand;
  sum = pre;
  n = c / max;
  summand = n * n - comp;
  sum += summand;
  return Math.sqrt(sum) * max;
}
