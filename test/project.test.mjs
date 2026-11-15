import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { transpileProject, projectHarness } from '../lib/project.mjs'
import { compileRust } from '../lib/compile.mjs'

const run = promisify(execFile)
const ENTRY = new URL('./project/app.js', import.meta.url).pathname.replace(/^\//, '')

test('project 模式：跨模块函数与常量转译后结果与 Node 一致', async () => {
  const project = await transpileProject(ENTRY)
  assert.equal(project.entry, 'app')
  assert.deepEqual(project.modules.map((m) => m.name).sort(), ['app', 'math'])

  const { exePath } = await compileRust(projectHarness(project), { name: 'project' })

  // Node 侧用同样的源码求值
  const mathSource = await readFile(new URL('./project/math.js', import.meta.url), 'utf8')
  const appSource = await readFile(new URL('./project/app.js', import.meta.url), 'utf8')
  const math = new Function(mathSource.replace(/export /g, '') + '\nreturn { add, square, SCALE };')()
  const app = new Function('add', 'square', 'SCALE', appSource.replace(/import[^;]+;/g, '').replace(/export /g, '') + '\nreturn { twice, norm };')(math.add, math.square, math.SCALE)

  for (const [name, inputs] of [['twice', [[3], [5]]], ['norm', [[3, 4], [1, 2]]]]) {
    for (const args of inputs) {
      const expected = app[name](...args)
      const { stdout } = await run(exePath, [name, ...args.map(String)])
      assert.equal(Number(stdout.trim()), expected, name + '(' + args.join(',') + ')')
    }
  }
})
