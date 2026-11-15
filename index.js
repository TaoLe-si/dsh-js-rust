/**
 * dsh-js-rust — 宿主半插件。
 *
 * 提供两个能力：把受支持的 JS 子集转译成 Rust，以及调用 rustc 编译成可执行文件。
 * 它是工具型插件：DSH 本身仍跑在 Node 上（原因见 README 的「边界」一节）。
 */

import { compileRust, findRustc } from './lib/compile.mjs'
import { transpile } from './lib/transpile.mjs'

export const inject = ['webServer']

const VERSION = '0.3.0'
const ROUTE_PREFIX = '/api/js-rust'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export function apply(ctx) {
  const disposers = []
  const logger = ctx.logger

  function guard(methods, handler) {
    return async (req, res) => {
      if (!methods.includes(req.method)) {
        sendJson(res, 405, { ok: false, error: methods.join('/') + ' only' })
        return
      }
      if (req.headers['x-dsh-plugin'] !== 'js-rust') {
        sendJson(res, 403, { ok: false, error: 'missing x-dsh-plugin header' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/health',
      handler: guard(['GET'], async (_req, res) => {
        let rustc = null
        let error = null
        try {
          rustc = await findRustc()
        } catch (failure) {
          error = String(failure && failure.message ? failure.message : failure)
        }
        sendJson(res, 200, { ok: error === null, version: VERSION, rustc, error })
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/transpile',
      handler: guard(['POST'], async (req, res) => {
        const body = await readBody(req)
        if (typeof body.source !== 'string') {
          sendJson(res, 400, { ok: false, error: 'need { source: string }' })
          return
        }
        const result = transpile(body.source)
        sendJson(res, 200, { ok: true, rust: result.rust, signatures: result.signatures })
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/compile',
      handler: guard(['POST'], async (req, res) => {
        const body = await readBody(req)
        if (typeof body.source !== 'string') {
          sendJson(res, 400, { ok: false, error: 'need { source: string }' })
          return
        }
        const { rust, signatures } = transpile(body.source)
        const { exePath, cached } = await compileRust(rust, { name: 'plugin' })
        sendJson(res, 200, { ok: true, exePath, cached, signatures })
      }),
    },
  ]

  for (const route of routes) disposers.push(ctx.webServer.register(route))

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 卸载失败不影响宿主 */ }
    }
  })

  logger?.info?.('js-rust: mounted v%s at %s', VERSION, ROUTE_PREFIX)
}
