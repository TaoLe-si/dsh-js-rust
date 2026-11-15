/**
 * 差分测试：同一份 JS 分别用 Node 执行与转译后用 rustc 执行，逐项比对结果。
 * 这是唯一能证明「转译没有静默改语义」的手段，所以它是这个项目的核心测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { transpile } from '../lib/transpile.mjs'
import { compileRust } from '../lib/compile.mjs'

const run = promisify(execFile)

const SOURCE = [
  'function fib(n) { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }',
  'function gcd(a, b) { while (b != 0) { let t = b; b = a % b; a = t; } return a; }',
  'function sumTo(n) { let s = 0; let i = 1; while (i <= n) { s = s + i; i++; } return s; }',
  'function sumFor(n) { let s = 0; for (let i = 1; i <= n; i++) { s += i; } return s; }',
  'function isEven(n) { return n % 2 == 0; }',
  'function collatz(n) { let steps = 0; while (n > 1) { if (n % 2 == 0) { n = n / 2; } else { n = 3 * n + 1; } steps++; } return steps; }',
  'function tri(n) { return n > 0 ? 1 : -1; }',
  // Node 垫片：Math.* 必须与 JS 语义一致（round/sign/min/max 的边界是重点）
  'function jsRound(x) { return Math.round(x); }',
  'function jsSign(x) { return Math.sign(x); }',
  'function jsMin(a, b, c) { return Math.min(a, b, c); }',
  'function jsMax(a, b) { return Math.max(a, b); }',
  'function geo(x) { return Math.sqrt(Math.abs(x)) + Math.floor(x) + Math.ceil(x) + Math.trunc(x); }',
  'function powered(a, b) { return Math.pow(a, b); }',
  'function circleArea(r) { return Math.PI * r * r; }',
] .join('\n')

/** 生成带 main 的 Rust 源码，按 argv 分派调用。 */
function withHarness(rust, signatures) {
  const arms = signatures.map((signature) => {
    const parse = signature.params.map((type, index) => {
      const raw = 'args[' + (index + 2) + ']'
      return type === 'bool' ? raw + ' == "true"' : raw + '.parse::<f64>().unwrap()'
    })
    const call = signature.name + '(' + parse.join(', ') + ')'
    const print = signature.returns === 'bool' ? 'println!("{}", ' + call + ');' : 'println!("{}", ' + call + ');'
    return '        "' + signature.name + '" => { ' + print + ' }'
  }).join('\n')
  return rust + '\nfn main() {\n' +
    '    let args: Vec<String> = std::env::args().collect();\n' +
    '    let choice = args[1].as_str();\n' +
    '    match choice {\n' + arms + '\n' +
    '        _ => { eprintln!("unknown function"); std::process::exit(2); }\n' +
    '    }\n}'
}

const CASES = [
  { name: 'fib', inputs: [[0], [1], [10], [20]] },
  { name: 'gcd', inputs: [[12, 18], [17, 5], [100, 75]] },
  { name: 'sumTo', inputs: [[0], [1], [100], [10000]] },
  { name: 'sumFor', inputs: [[1], [10], [1000]] },
  { name: 'isEven', inputs: [[0], [7], [42]] },
  { name: 'collatz', inputs: [[6], [27], [97]] },
  { name: 'tri', inputs: [[5], [-3], [0]] },
  // .5 与负数边界：JS round 向 +∞ 取整，Rust round 远离零，是最容易静默算错的地方
  { name: 'jsRound', inputs: [[0.5], [1.5], [-0.5], [-2.5], [2.4], [-2.6]] },
  // 注意：-0 无法通过 argv 字符串往返（String(-0) === "0"），所以这里不放 -0 输入；
  // -0 的「输出」语义由下面 jsRound(-0.5) 覆盖（Rust 打印 -0，Number("-0") 得到 -0）。
  { name: 'jsSign', inputs: [[0], [3.5], [-7.25]] },
  { name: 'jsMin', inputs: [[3, 1, 2], [-1, -2, -3]] },
  { name: 'jsMax', inputs: [[3, 1], [-1, -2]] },
  { name: 'geo', inputs: [[16.7], [-4.2]] },
  { name: 'powered', inputs: [[2, 10], [9, 0.5]] },
  { name: 'circleArea', inputs: [[1], [2.5]] },
]

test('差分：转译后的 Rust 与 Node 执行结果逐项一致', async () => {
  const { rust, signatures } = transpile(SOURCE)
  const { exePath, rustc } = await compileRust(withHarness(rust, signatures), { name: 'diff' })
  const js = {}
  for (const signature of signatures) {
    js[signature.name] = new Function(SOURCE + '\nreturn ' + signature.name + ';')()
  }

  let checked = 0
  for (const item of CASES) {
    const fn = js[item.name]
    assert.equal(typeof fn, 'function', 'JS 侧缺少函数 ' + item.name)
    for (const args of item.inputs) {
      const expected = fn(...args)
      const { stdout } = await run(exePath, [item.name, ...args.map(String)], { timeout: 30000 })
      const actual = typeof expected === 'boolean' ? stdout.trim() === 'true' : Number(stdout.trim())
      assert.equal(actual, expected, item.name + '(' + args.join(', ') + ') 期望 ' + expected + ' 实际 ' + actual)
      checked += 1
    }
  }
  assert.ok(checked >= 20, '至少比对 20 组输入，实际 ' + checked)
  globalThis.__jsRustInfo = { rustc, exePath, checked }
})
