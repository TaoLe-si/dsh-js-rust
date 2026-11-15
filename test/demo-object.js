//! types: name:string
function makeRecord(n) {
  return { count: n, flag: n > 0, label: 'n=' + n };
}

function recordSum(n) {
  const r = makeRecord(n);
  return r.count + (r.flag ? 1 : 0);
}

function withUpdate(n) {
  const r = makeRecord(n);
  r.count = r.count * 2;
  return r.count;
}
