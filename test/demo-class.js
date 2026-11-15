class Counter {
  constructor(start) {
    this.value = start;
    this.step = 1;
  }
  bump() {
    this.value = this.value + this.step;
    return this.value;
  }
  scaled(k) {
    return this.value * k;
  }
}

function runCounter(start, times) {
  const c = new Counter(start);
  let acc = 0;
  for (let i = 0; i < times; i++) {
    acc = acc + c.bump();
  }
  return acc + c.scaled(2);
}
