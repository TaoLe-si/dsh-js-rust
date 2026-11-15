//! types: nums:f64[]
function sumOf(nums) {
  let total = 0;
  for (const x of nums) {
    total = total + x;
  }
  return total;
}

function destrUse(n) {
  const point = { x: n, y: n * 2 };
  const { x, y } = point;
  return x + y;
}

//! types: arr:f64[]
function destrArr(arr) {
  const [first, second] = arr;
  return first * second;
}
