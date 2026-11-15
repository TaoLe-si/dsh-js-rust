/** 调用 rustc 编译生成的 Rust 源码，并按内容哈希缓存产物。 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 找到 rustc：优先环境变量，其次 PATH，最后是 rustup 默认安装位置。
 * @returns {Promise<string>} rustc 可执行文件路径。
 */
export async function findRustc() {
  const candidates = [
    process.env.RUSTC,
    'rustc',
    join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const { stdout } = await run(candidate, ['--version'], { timeout: 15000 })
      if (/rustc\s+\d+\./.test(stdout)) return candidate
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error('找不到 rustc：请安装 Rust 工具链，或把 install 目录加入 PATH（详见 README）')
}

/**
 * 编译 Rust 源码成可执行文件（内容哈希缓存，重复编译秒回）。
 * @param {string} rustSource Rust 源码。
 * @param {{ name?: string, outDir?: string }} [options] 选项。
 * @returns {Promise<{ exePath: string, cached: boolean, rustc: string }>} 产物信息。
 */
export async function compileRust(rustSource, options = {}) {
  const rustc = await findRustc()
  const hash = createHash('sha256').update(rustSource).digest('hex').slice(0, 16)
  const outDir = options.outDir || join(tmpdir(), 'dsh-js-rust')
  await mkdir(outDir, { recursive: true })
  const stem = (options.name || 'mod') + '-' + hash
  const sourcePath = join(outDir, stem + '.rs')
  const exePath = join(outDir, stem + (process.platform === 'win32' ? '.exe' : ''))

  try {
    await access(exePath, constants.X_OK)
    return { exePath, cached: true, rustc }
  } catch {
    // 未命中缓存，继续编译
  }

  await writeFile(sourcePath, rustSource, 'utf8')
  await run(rustc, ['-O', sourcePath, '-o', exePath], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  return { exePath, cached: false, rustc }
}
