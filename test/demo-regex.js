function isDigits(s) {
  return /^[0-9]+$/.test(s);
}

function hasWord(s) {
  return /[a-z]+/.test(s) ? 1 : 0;
}

function startsUpper(s) {
  return /^[A-Z][a-z]*$/.test(s);
}
