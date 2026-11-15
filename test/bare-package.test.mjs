import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { transpileProject, projectHarness } from '../lib/project.mjs'
import { compileRust } from '../lib/compile.mjs'

const run = promisify(execFile)
const ENTRY = fileURLToPath(new URL('./project3/app.js', import.meta.url))

test('project 模式：裸包导入解析到 node_modules', async () => {
  const project = await transpileProject(ENTRY)
  assert.equal(project.modules.length, 2)
  assert.ok(project.modules.some((m) => m.name.includes('demo_util')), '应把包模块纳入模块图')
  const { exePath } = await compileRust(projectHarness(project), { name: 'bare-package' })
  // nineTimes(2) = triple(triple(2)) = 18
  const { stdout } = await run(exePath, ['nineTimes', '2'])
  assert.equal(Number(stdout.trim()), 18)
})
