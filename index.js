/**
 * dsh-inline-image —— 宿主半边
 *
 * 只干一件事：把「没有真实路径的图片字节」落盘，并告诉客户端落在哪。
 *
 * 为什么必须有这一半：浏览器里粘进来的截图/位图（clipboard bitmap）没有 OS 路径，
 * 官方只能走附件上传；要把它变成 `@路径` 引用，就得先有磁盘上的文件。
 * 客户端的 Remote 通道（workspaceFiles）是只读的，所以落盘只能走自建 HTTP 路由。
 *
 * ── 落点：`%TEMP%\dsh-inline-image\<sha 前 2 位>\<名字>-<sha 前 16 位>.<ext>` ──
 *
 *   照 WorkBuddy 那套（它的目录叫 `workbuddy-image-chip-preview`）：不往项目里写，
 *   落在系统临时区；文件名带内容 sha256 前缀 ⇒ 同图重复粘贴只占一份；每次保存顺手
 *   清掉超过 24 小时没人碰的旧图。DSH 的 fs 沙箱对「读」不设限、对「写」允许
 *   工作区与平台临时根，所以模型按 `@路径` 读这张图是合法的。
 *
 * 协议：`POST /dsh-inline-image/save?name=<文件名>&sessionId=<会话 id>`，
 * 请求体是**文件原始字节**（不 base64、不 JSON），响应 `{ ok, value: { path, name, originalName, dir } }`。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const name = 'dsh-inline-image-ref'

/** 本包声明的 Host 服务。 */
export const inject = ['webServer']

/** 临时目录名（与 WorkBuddy 的 `workbuddy-image-chip-preview` 同思路，换成自己的名字）。 */
const DIR_NAME = 'dsh-inline-image'
/** 单文件上限：再大就不接了。 */
const MAX_BYTES = 32 * 1024 * 1024
/** 多久没人碰就清掉（与 WorkBuddy 一致的 24 小时）。 */
const TTL_MS = 24 * 60 * 60 * 1000
/** 文件名里不能出现的字符。 */
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/g
/** 名字段最长多少字符（hash 后缀另算）。 */
const MAX_STEM = 60

/** 临时根：`%TEMP%\dsh-inline-image`。 */
function tempRoot() {
  return join(tmpdir(), DIR_NAME)
}

/** 取最后一段、去非法字符；空名退回 file。 */
function cleanName(raw) {
  let text = raw === undefined || raw === null ? '' : String(raw)
  while (text.length > 0) {
    const code = text.charCodeAt(text.length - 1)
    if (code === 47 || code === 92) text = text.slice(0, -1)
    else break
  }
  const parts = text.split(/[/\\]/u)
  const last = parts[parts.length - 1] || ''
  const safe = last.replace(BAD_CHARS, '_').trim()
  return safe === '' ? 'file' : safe
}

/** 名字段：去掉扩展名后再洗一遍，别太长。 */
function sanitizeStem(name) {
  const stem = basename(name, extname(name)).replace(BAD_CHARS, '_').trim()
  const trimmed = stem === '' ? 'image' : stem
  return trimmed.length > MAX_STEM ? trimmed.slice(0, MAX_STEM) : trimmed
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 读请求体（带上限）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BYTES) {
      const error = new Error('超过 32MB 上限')
      error.oversized = true
      throw error
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/**
 * 内容寻址写盘：同内容必然同一路径（已存在就只刷新 mtime，让清理器别误删）。
 * @param bytes - 文件字节。
 * @param rawName - 原始文件名（只用来取扩展名与名字段）。
 * @returns 绝对路径。
 */
async function materialize(bytes, rawName) {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const ext = extname(cleanName(rawName))
  const dir = join(tempRoot(), hash.slice(0, 2))
  const target = join(dir, `${sanitizeStem(rawName)}-${hash.slice(0, 16)}${ext}`)
  await mkdir(dir, { recursive: true })
  try {
    await stat(target)
    const now = new Date()
    await utimes(target, now, now)
    return target
  } catch (error) {
    /* 不存在（或 stat 失败）→ 往下写 */
  }
  try {
    await writeFile(target, bytes, { flag: 'wx' })
  } catch (error) {
    if (error === null || error === undefined || error.code !== 'EEXIST') throw error
  }
  return target
}

/**
 * 清掉超过 TTL 的旧图（与 WorkBuddy 同款：每次保存顺手扫一遍，失败只管吞掉）。
 * @returns 删除个数。
 */
async function cleanupExpired() {
  const root = tempRoot()
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return 0
  }
  const now = Date.now()
  let removed = 0
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = join(root, entry.name)
        let files = []
        try {
          files = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          return
        }
        await Promise.all(
          files
            .filter((file) => file.isFile())
            .map(async (file) => {
              const target = join(dir, file.name)
              try {
                const info = await stat(target)
                if (now - info.mtimeMs > TTL_MS) {
                  await unlink(target)
                  removed += 1
                }
              } catch (error) {
                /* 并发删除/占位失败都无所谓 */
              }
            })
        )
      })
  )
  return removed
}

export function apply(ctx) {
  const webserver = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webserver === undefined || typeof webserver.register !== 'function') return
  webserver.register({
    kind: 'prefix',
    path: '/dsh-inline-image',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method !== 'POST' || url.pathname !== '/dsh-inline-image/save') {
        json(res, { ok: false, error: 'unknown route' }, 404)
        return
      }
      const rawName = url.searchParams.get('name') ?? ''
      let bytes
      try {
        bytes = await readBody(req)
      } catch (error) {
        const oversized = error !== null && error !== undefined && error.oversized === true
        json(res, { ok: false, error: error instanceof Error ? error.message : '读取请求体失败' }, oversized ? 413 : 400)
        return
      }
      if (bytes.length === 0) {
        json(res, { ok: false, error: '空文件' }, 400)
        return
      }
      try {
        const path = await materialize(bytes, rawName)
        cleanupExpired().catch(() => undefined)
        json(res, { ok: true, value: { path, name: basename(path), originalName: cleanName(rawName), dir: dirname(path) } })
      } catch (error) {
        json(res, { ok: false, error: error instanceof Error ? error.message : '保存失败' }, 500)
      }
    }
  })
  console.log('[dsh-inline-image] host route ready: POST /dsh-inline-image/save → ' + tempRoot())
}
