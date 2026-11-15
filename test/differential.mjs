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
const BT = String.fromCharCode(96) // 反引号：模板字符串测试用

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
  // 字符串与数组：独立函数没有调用点，用 //! types 标注参数类型
  '//! types: text:string',
  'function strLen(text) { return text.length; }',
  'function greet(n) { return "n=" + n; }',
  '//! types: nums:f64[]',
  'function sumArr(nums) { let s = 0; for (let i = 0; i < nums.length; i++) { s += nums[i]; } return s; }',
  'function buildAndCount(n) { let a = []; for (let i = 0; i < n; i++) { a.push(i * 2); } return a.length; }',
  // 模板字符串与 export：模板会被转成 format!，插值支持任意可 Display 的值
  'export function tpl(n) { return ' + BT + 'value: ${n}' + BT + '; }',
  'function tplMixed(a, b) { return ' + BT + '${a}+${b}=' + BT + ' + (a + b); }',
  // 对象字面量：结构体映射，字段只支持 number/boolean/string
  'function objScore(n) { const r = { a: n, b: n > 0, s: "x" + n }; return r.a + (r.b ? 1 : 0) + r.s.length; }',
  'function objMutate(n) { const r = { v: n }; r.v = r.v * 3; return r.v; }',
  // 对象展开：{ ...base, k: v }，后写字段覆盖前写
  'function spreadScore(n) { const base = { a: n, b: 1 }; const merged = { ...base, c: n * 2 }; return merged.a + merged.b + merged.c; }',
  'function spreadOverride(n) { const base = { a: n, b: 1 }; const merged = { ...base, a: 100 }; return merged.a + merged.b; }',
  // class：构造器 this.x 赋值 -> 结构体，方法 -> impl
  'class Counter { constructor(start) { this.value = start; this.step = 1; } bump() { this.value = this.value + this.step; return this.value; } scaled(k) { return this.value * k; } }',
  'function classRun(start, times) { const c = new Counter(start); let acc = 0; for (let i = 0; i < times; i++) { acc = acc + c.bump(); } return acc + c.scaled(2); }',
  '//! types: s:string',
    // 正则：极小引擎（字面量/./*/+/ ?/[]/^/$/\\d 等），不支持分组与交替,
    function reDigits(s) { return /^[0-9]+$/.test(s); },
    function reWord(s) { return /[a-z]+/.test(s) ? 1 : 0; },
    function reUpper(s) { return /^[A-Z][a-z]*$/.test(s); },
    function reSpace(s) { return /\\s+/.test(s); },
  // switch：转成 if/else if 链（尾部 break 剥离，拒绝 fallthrough）
  'function swGrade(n) { switch (n) { case 1: return 1; case 2: return 2; default: return 0; } }',
  'function swAssign(n) { let r = 0; switch (n) { case 0: r = 10; break; default: r = 20; } return r; }',
  // 数字分隔符
  'function sepSum() { return 1_000 + 2_500; }',
] .join('\n')

/** 生成带 main 的 Rust 源码，按 argv 分派调用。 */
function withHarness(rust, signatures) {
  const arms = signatures.map((signature) => {
    const parse = signature.params.map((type, index) => {
      const raw = 'args[' + (index + 2) + ']'
      if (type === 'bool') return raw + ' == "true"'
      if (type === 'string') return raw + '.clone()'
      if (type === 'f64[]') return raw + '.split(\',\').filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().unwrap()).collect::<Vec<f64>>()'
      return raw + '.parse::<f64>().unwrap()'
    })
    const call = signature.name + '(' + parse.join(', ') + ')'
    // 无返回值（unit）不能用 println! 打印；数组用 Debug 打印
    const printer = (signature.returns === 'f64[]' || String(signature.returns).startsWith('obj:')) ? 'println!("{:?}", ' : 'println!("{}", '
    const body = signature.returns === null ? call + ';' : printer + call + ')'
    return '        "' + signature.name + '" => { ' + body + ' }'
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
  { name: 'strLen', inputs: [['hello'], ['']] },
  { name: 'greet', inputs: [[7], [3.5]] },
  { name: 'sumArr', inputs: [['1,2,3'], ['10'], ['']] },
  { name: 'buildAndCount', inputs: [[5]] },
  { name: 'tpl', inputs: [[42], [3.5]] },
  { name: 'tplMixed', inputs: [[3, 4], [0, 0]] },
  { name: 'objScore', inputs: [[5], [-3], [0]] },
  { name: 'objMutate', inputs: [[4], [-2]] },
  { name: 'spreadScore', inputs: [[3], [-2]] },
  { name: 'spreadOverride', inputs: [[3], [7]] },
  { name: 'classRun', inputs: [[1, 3], [0, 2], [5, 0]] },
  { name: 'reDigits', inputs: [['123'], ['12a'], ['']] },
  { name: 'reWord', inputs: [['ab1'], ['123'], ['']] },
  { name: 'reUpper', inputs: [['Hello'], ['hello']] },
  { name: 'reSpace', inputs: [['a b'], ['ab']] },
  { name: 'swGrade', inputs: [[1], [2], [9]] },
  { name: 'swAssign', inputs: [[0], [3]] },
  { name: 'sepSum', inputs: [[]] },
]

test('差分：转译后的 Rust 与 Node 执行结果逐项一致', async () => {
  const { rust, signatures } = transpile(SOURCE)
  const { exePath, rustc } = await compileRust(withHarness(rust, signatures), { name: 'diff' })
  const js = {}
  for (const signature of signatures) {
    // JS 侧用 Function 求值，export 关键字在函数体内非法，先剥掉
    js[signature.name] = new Function(SOURCE.replace(/export /g, '') + '\nreturn ' + signature.name + ';')()
  }

  let checked = 0
  for (const item of CASES) {
    const fn = js[item.name]
    assert.equal(typeof fn, 'function', 'JS 侧缺少函数 ' + item.name)
    const signature = signatures.find((entry) => entry.name === item.name)
    for (const args of item.inputs) {
      // argv 只能传字符串，JS 侧要按声明的参数类型还原成真正的值
      const jsArgs = args.map((value, index) => {
        const type = signature.params[index]
        if (type === 'f64[]') return String(value).split(',').filter((part) => part !== '').map(Number)
        if (type === 'string') return String(value)
        return Number(value)
      })
      const expected = fn(...jsArgs)
      const { stdout } = await run(exePath, [item.name, ...args.map(String)], { timeout: 30000 })
      const actual = typeof expected === 'boolean'
        ? stdout.trim() === 'true'
        : typeof expected === 'string'
          ? stdout.trim()
          : Number(stdout.trim())
      assert.equal(actual, expected, item.name + '(' + args.join(', ') + ') 期望 ' + expected + ' 实际 ' + actual)
      checked += 1
    }
  }
  assert.ok(checked >= 20, '至少比对 20 组输入，实际 ' + checked)
  globalThis.__jsRustInfo = { rustc, exePath, checked }
})
