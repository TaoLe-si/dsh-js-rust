function spreadScore(n) {
  const base = { a: n, b: 1 };
  const merged = { ...base, c: n * 2 };
  return merged.a + merged.b + merged.c;
}

function spreadOverride(n) {
  const base = { a: n, b: 1 };
  const merged = { ...base, a: 100 };
  return merged.a + merged.b;
}
