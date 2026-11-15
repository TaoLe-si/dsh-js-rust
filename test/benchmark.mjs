/**
 * 基准：同一份 JS 函数，Node 执行 vs 转译后 Rust 执行。
 *
 * 注意口径：Rust 侧的计时包含进程启动（约 10–30ms），所以迭代次数要足够大，
 * 否则测的主要是进程启动而不是计算。
 */

import { performance } from 'node:perf_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { transpile } from '../lib/transpile.mjs'
import { compileRust } from '../lib/compile.mjs'

const run = promisify(execFile)

const SOURCE = 'function fib(n) { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }'
const N = 30
const ITERATIONS = 40

function withLoop(rust) {
  return rust + '\nfn main() {\n' +
    '    let start = std::time::Instant::now();\n' +
    '    let mut acc = 0.0f64;\n' +
    '    for _ in 0..' + ITERATIONS + ' { acc += fib(' + N + '.0); }\n' +
    '    println!("{} {}", acc, start.elapsed().as_secs_f64() * 1000.0);\n}'
}

const { rust } = transpile(SOURCE)
const { exePath, rustc } = await compileRust(withLoop(rust), { name: 'bench' })

const fib = new Function(SOURCE + '\nreturn fib;')()
const jsStart = performance.now()
let acc = 0
for (let i = 0; i < ITERATIONS; i += 1) acc += fib(N)
const jsMs = performance.now() - jsStart

const { stdout } = await run(exePath, [])
const [rustAcc, rustMs] = stdout.trim().split(' ').map(Number)

console.log('rustc        : ' + rustc)
console.log('函数         : fib(' + N + ') × ' + ITERATIONS + ' 次')
console.log('Node (JS)    : ' + jsMs.toFixed(1) + ' ms')
console.log('Rust (-O)    : ' + rustMs.toFixed(1) + ' ms   (含进程启动)')
console.log('加速比       : ' + (jsMs / rustMs).toFixed(1) + 'x')
console.log('结果一致     : ' + (Math.abs(acc - rustAcc) < 0.5 ? '是 (' + acc + ')' : '否! JS=' + acc + ' Rust=' + rustAcc))
