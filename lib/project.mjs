/**
 * project 模式：解析 ESM 模块图，把整棵依赖树转译成一个 Rust crate（单文件、嵌套 mod）。
 *
 * 支持：相对路径、具名导入、export（function/const/class）、纯转发（export {a} from / export * from）。
 * 限制：default / 命名空间导入明确报错；跨模块返回值类型按 f64 处理。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { tokenize, parse } from './parser.mjs'
import { transpile } from './transpile.mjs'

/**
 * 解析裸包导入（如 @deepseek-ai/dsh-llm）到 node_modules 里的真实文件。
 * DSH 自身的后端代码全是这种导入，所以这是转译整棵依赖树的前置条件。
 * @param {string} fromDir 起始目录。
 * @param {string} specifier 包说明符（可带子路径）。
 * @returns {string} 解析后的绝对路径。
 */
function resolvePackage(fromDir, specifier) {
  const parts = specifier.split('/')
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  const subPath = specifier.slice(packageName.length).replace(/^\//, '')
  let dir = resolve(fromDir)
  for (;;) {
    const candidate = resolve(dir, 'node_modules', packageName)
    if (existsSync(candidate)) {
      const base = subPath.length > 0 ? resolve(candidate, subPath) : resolve(candidate, 'index.js')
      for (const guess of [base, base + '.js', base + '.mjs', resolve(base, 'index.js')]) {
        if (existsSync(guess) && statSync(guess).isFile()) return guess
      }
      return base
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new SyntaxError('解析不到包 ' + specifier + '（从 ' + fromDir + ' 向上查找 node_modules 失败）')
}

/** 补全相对路径的扩展名；裸包交给 resolvePackage。 */
function resolveSpecifier(fromDir, specifier) {
  if (!specifier.startsWith('.')) return resolvePackage(fromDir, specifier)
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
 * 转译整个模块图。
 * @param {string} entryPath 入口文件。
 * @returns {Promise<{ rust: string, modules: Array<object>, entry: string }>}
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
    for (const reExport of parsed.reExports) {
      queue.push(resolveSpecifier(dirname(file), reExport.source))
    }
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

  // 导出索引：模块名 -> 导出名 -> 真实来源（转发会被追到原始模块）
  const exportIndex = new Map()
  for (const item of modules) {
    const map = new Map()
    for (const fn of item.parsed.functions) {
      if (fn.exported) map.set(fn.name, { module: item.name, name: fn.name })
    }
    for (const constant of item.parsed.exportedConsts) {
      map.set(constant.name, { module: item.name, name: constant.name })
    }
    for (const cls of item.parsed.classes) {
      if (cls.exported) map.set(cls.name, { module: item.name, name: cls.name })
    }
    for (const alias of item.parsed.exportedNames) {
      map.set(alias.exported, { module: item.name, name: alias.local })
    }
    exportIndex.set(item.name, map)
  }

  // 转发链可能有多层（A 转 B，B 转 C），迭代到稳定
  for (let round = 0; round < 8; round += 1) {
    let changed = false
    for (const item of modules) {
      const map = exportIndex.get(item.name)
      for (const reExport of item.parsed.reExports) {
        const target = byPath.get(resolveSpecifier(dirname(item.file), reExport.source))
        if (!target) continue
        const targetMap = exportIndex.get(target.name)
        if (reExport.names === null) {
          for (const [name, binding] of targetMap) {
            if (!map.has(name)) { map.set(name, binding); changed = true }
          }
          continue
        }
        for (const alias of reExport.names) {
          const binding = targetMap.get(alias.local)
          if (!binding) continue
          if (!map.has(alias.exported)) { map.set(alias.exported, binding); changed = true }
        }
      }
    }
    if (!changed) break
  }

  const parts = []
  const summary = []
  for (const item of modules) {
    const imports = new Map()
    if (item.parsed.imports !== null) {
      for (const [local, binding] of item.parsed.imports) {
        const target = byPath.get(resolveSpecifier(dirname(item.file), binding.source))
        const resolved = exportIndex.get(target.name).get(binding.imported)
        // 解析不到就退回原样，让转译期给出明确报错
        imports.set(local, resolved || { module: target.name, name: binding.imported })
      }
    }

    let compiled
    try {
      compiled = transpile(item.source, { imports })
    } catch (error) {
      // 带上模块名，否则多模块项目里的报错很难定位
      throw new SyntaxError(item.name + ': ' + (error && error.message ? error.message : String(error)))
    }
    const { rust, signatures } = compiled
    const body = rust.split('\n').map((line) => (line.length > 0 ? '    ' + line : line)).join('\n')
    parts.push('pub mod ' + item.name + ' {\n' + body + '\n}')
    parts.push('')
    summary.push({ name: item.name, file: item.file, signatures })
  }

  return { rust: parts.join('\n'), modules: summary, entry: byPath.get(entry).name }
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
