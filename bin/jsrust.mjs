#!/usr/bin/env node
/** 命令行：transpile / compile / run / bench */

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { transpile } from '../lib/transpile.mjs'
import { transpileProject, projectHarness } from '../lib/project.mjs'
import { compileRust, findRustc } from '../lib/compile.mjs'

const run = promisify(execFile)

async function main(argv) {
  const [command, file, ...rest] = argv
  if (!command || command === 'help') {
    console.log('用法:')
    console.log('  jsrust transpile <file.js>        打印生成的 Rust 源码')
    console.log('  jsrust compile <file.js>          编译成可执行文件并打印路径')
    console.log('  jsrust run <file.js> <fn> [args]  编译后直接调用一个函数')
    console.log('  jsrust doctor                     检查 Rust 工具链')
    return 0
  }
  if (command === 'doctor') {
    const rustc = await findRustc()
    const { stdout } = await run(rustc, ['--version'])
    console.log('rustc: ' + rustc)
    console.log(stdout.trim())
    return 0
  }
  if (!file) { console.error('缺少输入文件'); return 2 }
  // project 分支必须早于单文件 transpile：带 import 的文件单文件模式会直接报错
  if (command === 'project') {
    // 整个模块图 -> 单个 crate（嵌套 mod），并编译成可执行文件
    const project = await transpileProject(file)
    const { exePath, cached } = await compileRust(projectHarness(project), { name: 'project' })
    console.log('入口模块: ' + project.entry)
    console.log('模块数  : ' + project.modules.length + ' (' + project.modules.map((item) => item.name).join(', ') + ')')
    console.log('产物    : ' + exePath + (cached ? ' (缓存命中)' : ' (新编译)'))
    const entry = project.modules.find((item) => item.name === project.entry)
    console.log('导出函数: ' + entry.signatures.map((item) => item.name).join(', '))
    return 0
  }
  const source = await readFile(file, 'utf8')
  const { rust, signatures } = transpile(source)
  if (command === 'transpile') { process.stdout.write(rust); return 0 }
  if (command !== 'compile' && command !== 'run') {
    console.error('未知命令: ' + command)
    return 2
  }
  // 编译产物必须是可执行文件，所以统一套上按 argv 分派的最小 main。
  const { exePath, cached } = await compileRust(withHarness(rust, signatures), { name: 'cli' })
  if (command === 'compile') {
    console.log(exePath + (cached ? ' (缓存命中)' : ' (新编译)'))
    const names = signatures.map((item) => item.name)
    console.log('导出函数: ' + names.join(', '))
    return 0
  }
  const [fn, ...args] = rest
  if (!fn) { console.error('缺少函数名'); return 2 }
  const { stdout } = await run(exePath, [fn, ...args])
  process.stdout.write(stdout)
  return 0
  console.error('未知命令: ' + command)
  return 2
}

/** 加一个按 argv 分派的最小 main，用于直接跑单个函数。 */
export function withHarness(rust, signatures) {
  const arms = signatures.map((signature) => {
    const parsed = signature.params.map((type, index) => {
      const raw = 'args[' + (index + 2) + ']'
      if (type === 'bool') return raw + ' == "true"'
      if (type === 'string') return raw + '.clone()'
      if (type === 'f64[]') return raw + '.split(\',\').filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().unwrap()).collect::<Vec<f64>>()'
      return raw + '.parse::<f64>().unwrap()'
    })
    const call = signature.name + '(' + parsed.join(', ') + ')'
    // 无返回值（unit）不能用 println! 打印；数组用 Debug 打印
    const printer = signature.returns === 'f64[]' ? 'println!("{:?}", ' : 'println!("{}", '
    const body = signature.returns === null ? call + ';' : printer + call + ')'
    return '        "' + signature.name + '" => { ' + body + ' }'
  }).join('\n')
  return rust + '\nfn main() {\n' +
    '    let args: Vec<String> = std::env::args().collect();\n' +
    '    match args[1].as_str() {\n' + arms + '\n' +
    '        _ => { eprintln!("unknown function"); std::process::exit(2); }\n' +
    '    }\n}'
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  console.error(error && error.message ? error.message : error)
  process.exit(1)
})
