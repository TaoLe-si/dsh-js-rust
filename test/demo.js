//! types: name:string
export function label(n, name) {
  return 'hello ' + name + ', n=' + n;
}

export function tpl(n) {
  return `value: ${n}`;
}

function tpl2(a, b) {
  return `${a}+${b}=` + (a + b);
}
