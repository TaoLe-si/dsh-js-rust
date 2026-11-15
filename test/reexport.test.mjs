import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { transpileProject, projectHarness } from '../lib/project.mjs'
import { compileRust } from '../lib/compile.mjs'

const run = promisify(execFile)
const ENTRY = fileURLToPath(new URL('./project2/app.js', import.meta.url))

test('project 模式：export ... from 转发链解析到原始模块', async () => {
  const project = await transpileProject(ENTRY)
  assert.deepEqual(project.modules.map((m) => m.name).sort(), ['app', 'base', 'forward'])
  const { exePath } = await compileRust(projectHarness(project), { name: 'reexport' })
  // quad(3) = double(double(3)) = 12，其中 double 经由 forward.js 转发自 base.js
  const { stdout } = await run(exePath, ['quad', '3'])
  assert.equal(Number(stdout.trim()), 12)
})
