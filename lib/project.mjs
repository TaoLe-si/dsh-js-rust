/**
 * project 模式：解析 ESM 模块图，把整棵依赖树转译成一个 Rust crate（单文件、嵌套 mod）。
 *
 * v0 限制（README 有写）：只支持相对路径 + 具名导入；跨模块的返回值类型按 f64 处理；
 * default / 命名空间导入明确报错。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { tokenize, parse } from './parser.mjs'
import { transpile } from './transpile.mjs'

/** 补全相对路径的扩展名。 */
function resolveSpecifier(fromDir, specifier) {
  if (!specifier.startsWith('.')) {
    throw new SyntaxError('只支持相对路径导入，实际: ' + specifier)
  }
  const base = resolve(fromDir, specifier)
  if (/\.m?js$/.test(base)) return base
  return base + '.js'
}

/** 由相对路径生成合法且唯一的模块名。 */
function moduleName(root, file) {
  const rel = relative(root, file).replace(/\\/g, '/')
  const name = rel.replace(/\.m?js$/, '').replace(/[^A-Za-z0-9_]/g, '_')
  return name === '' ? 'root' : name
}

/**
 * 给 project 产物加一个按 argv 分派的最小 main（只暴露入口模块的导出函数）。
 * @param {{ rust: string, modules: Array<object>, entry: string }} project transpileProject 的结果。
 * @returns {string} 可直接编译的完整 Rust 源码。
 */
export function projectHarness(project) {
  const entry = project.modules.find((item) => item.name === project.entry)
  const arms = entry.signatures.map((signature) => {
    const parsed = signature.params.map((type, index) => {
      const raw = 'args[' + (index + 2) + ']'
      if (type === 'bool') return raw + ' == "true"'
      if (type === 'string') return raw + '.clone()'
      if (type === 'f64[]') return raw + '.split(\',\').filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().unwrap()).collect::<Vec<f64>>()'
      return raw + '.parse::<f64>().unwrap()'
    })
    const call = 'crate::' + project.entry + '::' + signature.name + '(' + parsed.join(', ') + ')'
    const printer = (signature.returns === 'f64[]' || String(signature.returns).startsWith('obj:')) ? 'println!("{:?}", ' : 'println!("{}", '
    const body = signature.returns === null ? call + ';' : printer + call + ')'
    return '        "' + signature.name + '" => { ' + body + ' }'
  }).join('\n')
  return project.rust + '\nfn main() {\n' +
    '    let args: Vec<String> = std::env::args().collect();\n' +
    '    match args[1].as_str() {\n' + arms + '\n' +
    '        _ => { eprintln!("unknown function"); std::process::exit(2); }\n' +
    '    }\n}\n'
}

/**
 * 转译整个模块图。
 * @param {string} entryPath 入口文件。
 * @returns {Promise<{ rust: string, modules: Array<{ name: string, file: string, signatures: Array<object> }>, entry: string }>}
 */
export async function transpileProject(entryPath) {
  const entry = resolve(entryPath)
  const root = dirname(entry)
  const seen = new Map()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    const source = await readFile(file, 'utf8')
    const parsed = parse(tokenize(source))
    seen.set(file, { file, name: moduleName(root, file), source, parsed })
    if (parsed.imports !== null) {
      for (const [local, binding] of parsed.imports) {
        if (binding.imported === 'default' || binding.imported === '*') {
          throw new SyntaxError(file + ': 暂不支持 default / 命名空间导入（' + local + '）')
        }
        queue.push(resolveSpecifier(dirname(file), binding.source))
      }
    }
  }

  const modules = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  const byPath = new Map(modules.map((item) => [item.file, item]))

  const parts = []
  const summary = []
  for (const item of modules) {
    // 每个模块的 local 名 -> 目标模块与导出名
    const imports = new Map()
    if (item.parsed.imports !== null) {
      for (const [local, binding] of item.parsed.imports) {
        const target = byPath.get(resolveSpecifier(dirname(item.file), binding.source))
        imports.set(local, { module: target.name, name: binding.imported })
      }
    }
    const { rust, signatures } = transpile(item.source, { imports })
    const body = rust.split('\n').map((line) => (line.length > 0 ? '    ' + line : line)).join('\n')
    parts.push('pub mod ' + item.name + ' {\n' + body + '\n}')
    parts.push('')
    summary.push({ name: item.name, file: item.file, signatures })
  }

  return { rust: parts.join('\n'), modules: summary, entry: byPath.get(entry).name }
}
