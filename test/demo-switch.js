function grade(score) {
  switch (score) {
    case 1: return 'one';
    case 2: return 'two';
    default: return 'other';
  }
}

function bucket(n) {
  let label = 0;
  switch (n) {
    case 0: label = 100; break;
    case 1: label = 200; break;
    default: label = 300;
  }
  return label;
}

function usingSep() {
  return 1_000 + 2_500;
}
