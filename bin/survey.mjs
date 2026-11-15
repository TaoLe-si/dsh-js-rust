/**
 * 覆盖率扫描：对目录下所有 .js/.mjs 尝试转译，按**首个失败原因**归类。
 *
 * 这不是性能工具，是可行性度量：它回答「按当前子集，真实代码里能转多少」。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { transpile } from '../lib/transpile.mjs'

async function walk(dir, out, depth) {
  if (depth > 12) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await walk(full, out, depth + 1)
      continue
    }
    if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
}

/** 把错误消息归一到稳定桶名，便于统计。 */
function bucket(message) {
  if (/字符串字面量/.test(message)) return 'string literal'
  if (/顶层只允许 function 声明|只允许顶层/.test(message)) return 'module syntax (import/export/class)'
  const charMatch = /子集外的字符 (.*)$/.exec(message)
  if (charMatch) return 'unsupported char ' + charMatch[1]
  if (/数组字面量/.test(message)) return 'array literal'
  if (/对象字面量/.test(message)) return 'object literal'
  if (/未声明的标识符|期望|无法解析|未闭合/.test(message)) return 'parse error'
  return message.slice(0, 40)
}

const root = process.argv[2]
if (!root) { console.error('用法: node bin/survey.mjs <目录>'); process.exit(2) }
const files = []
await walk(root, files, 0)

const tally = new Map()
let passed = 0
const passedFiles = []
for (const file of files) {
  const info = await stat(file)
  if (info.size > 2 * 1024 * 1024) continue
  let source
  try { source = await readFile(file, 'utf8') } catch { continue }
  try {
    transpile(source)
    passed += 1
    passedFiles.push(relative(root, file))
  } catch (error) {
    const key = bucket(String(error && error.message ? error.message : error))
    tally.set(key, (tally.get(key) || 0) + 1)
  }
}

const total = [...tally.values()].reduce((a, b) => a + b, 0) + passed
console.log('扫描目录 :', root)
console.log('JS 文件  :', total)
console.log('可转译   :', passed, '(' + (total ? ((passed / total) * 100).toFixed(2) : '0') + '%)')
console.log('')
console.log('失败分布（按首个阻断原因）:')
for (const [key, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((count / total) * 100).toFixed(1)
  console.log('  ' + key.padEnd(34) + String(count).padStart(6) + '  ' + pct + '%')
}
if (passedFiles.length > 0) {
  console.log('')
  console.log('通过的文件（最多列 10 个）:')
  for (const file of passedFiles.slice(0, 10)) console.log('  ' + file)
}
