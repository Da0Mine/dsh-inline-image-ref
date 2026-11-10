/**
 * 发布后的自检（_publish-smoke）：不装 DSH、不开浏览器，直接验这个包装完还能用。
 *
 *   node _publish-smoke.mjs
 *
 * 覆盖：包元数据 → 宿主半的路由与落盘 → 客户端半边能否被 ModuleLoader 接住并挂上监听。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log('  PASS ' + name)
  } catch (error) {
    results.push({ name, ok: false })
    console.log('  FAIL ' + name + '  -> ' + (error instanceof Error ? error.message : String(error)))
  }
}

/* ─────────────────────────── 1. 包元数据 ─────────────────────────── */

console.log('[1] 包元数据')
check('name 是 dsh-inline-image-ref', () => assert.equal(pkg.name, 'dsh-inline-image-ref'))
check('不是 private（能发 npm）', () => assert.notEqual(pkg.private, true))
check('有 license / author', () => {
  assert.equal(pkg.license, 'MIT')
  assert.ok(typeof pkg.author === 'string' && pkg.author.length > 0)
})
check('exports 里有 ./client（DSH 只认这个）', () => assert.equal(pkg.exports['./client'], './client.js'))
check('exports 里的入口文件都真实存在', () => {
  for (const target of [pkg.exports['.'], pkg.exports['./client']]) assert.ok(existsSync(join(here, target)), target)
})
check('cordis.patch.yml 的插件名 = 包名', () => {
  const yml = readFileSync(join(here, pkg.dsh.bundle.patch), 'utf8')
  assert.match(yml, new RegExp('name:\\s*' + pkg.name))
})

/* ─────────────────────────── 2. 宿主半 ─────────────────────────── */

console.log('[2] 宿主半：路由注册 + 落盘')
const host = await import(pathToFileURL(join(here, 'index.js')).href)
check('导出 name / inject / apply', () => {
  assert.equal(host.name, 'dsh-inline-image-ref')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

let handler = null
const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined
    return { register: (options) => { handler = options.handler } }
  }
}
host.apply(ctx)
check('注册了 POST /dsh-inline-image/save', () => assert.equal(typeof handler, 'function'))

function makeReq(url, chunks) {
  return {
    method: 'POST',
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    }
  }
}
function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = String(body ?? '') }
  }
}

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
let res = makeRes()
await handler(makeReq('/dsh-inline-image/save?name=smoke.png&sessionId=smoke', [bytes]), res)
const saved = JSON.parse(res.body)
check('落盘成功并返回绝对路径', () => {
  assert.equal(saved.ok, true)
  assert.ok(saved.value.path.startsWith(tmpdir()))
  assert.ok(existsSync(saved.value.path), saved.value.path)
})
check('字节一致', () => assert.deepEqual([...readFileSync(saved.value.path)], [...bytes]))
check('originalName 回原样名字', () => assert.equal(saved.value.originalName, 'smoke.png'))

res = makeRes()
await handler(makeReq('/dsh-inline-image/save?name=smoke.png&sessionId=smoke', [bytes]), res)
check('同内容再存一次 → 同一个文件（内容寻址）', () => assert.equal(JSON.parse(res.body).value.path, saved.value.path))

res = makeRes()
await handler(makeReq('/dsh-inline-image/save?name=x.png&sessionId=smoke', []), res)
check('空文件 → 400', () => assert.equal(res.status, 400))

rmSync(saved.value.path, { force: true })

/* ─────────────────────────── 3. 客户端半 ─────────────────────────── */

console.log('[3] 客户端半：ModuleLoader 能接住、apply 能挂上监听')
const listeners = new Map()
const style = { style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, appendChild() {} }
const documentStub = {
  addEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? 0) + 1) },
  removeEventListener(type) { listeners.set(type, (listeners.get(type) ?? 0) - 1) },
  querySelector() { return null },
  createElement() { return { style, setAttribute() {}, appendChild() {}, addEventListener() {} } },
  body: { style: { setProperty() {}, removeProperty() {} }, appendChild() {}, querySelector() { return null } },
  head: { appendChild() {} }
}
const sandbox = {
  window: { localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, removeEventListener() {} },
  document: documentStub,
  console,
  URL: { createObjectURL: () => 'blob:smoke', revokeObjectURL() {} },
  Blob: class {},
  setTimeout,
  clearTimeout,
  globalThis: null
}
sandbox.globalThis = sandbox
let captured = null
sandbox.window.__ModuleLoader__ = { load: (mod) => { captured = mod } }
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(here, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' })

check('client.js 调用了 __ModuleLoader__.load', () => assert.ok(captured !== null))
check('注册 id = 包名（否则 DSH 报 loaded without registering）', () => assert.equal(captured.id, pkg.name))
check('是 {id, factory} 形式', () => assert.equal(typeof captured.factory, 'function'))

const moduleExports = captured.factory((spec) => {
  if (spec === 'react') return { useEffect() {}, createElement() { return null } }
  throw new Error('unexpected require: ' + spec)
})
check('factory 返回 apply / inject', () => {
  assert.equal(typeof moduleExports.apply, 'function')
  /* 数组来自另一个 vm 上下文，原型不同：比对内容而不是引用。 */
  assert.equal([...moduleExports.inject].join(','), 'slots,conversation,sessions')
})

const disposers = []
moduleExports.apply({
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
  slots: { inject: (name, register) => register(), register: () => () => {} },
  get() { return undefined }
})
check('挂上了 drop/paste/change/mouseover/mouseout/keydown', () => {
  for (const type of ['drop', 'paste', 'change', 'mouseover', 'mouseout', 'keydown', 'click']) {
    assert.ok((listeners.get(type) ?? 0) > 0, type)
  }
})
for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
check('dispose 之后全部摘干净', () => {
  for (const type of ['drop', 'paste', 'change', 'mouseover', 'mouseout', 'keydown', 'click']) {
    assert.ok((listeners.get(type) ?? 0) === 0, type)
  }
})

const failed = results.filter((item) => !item.ok)
console.log('\n=== ' + (failed.length === 0 ? '全部通过' : '有失败') + '：' + (results.length - failed.length) + '/' + results.length + ' ===')
if (failed.length > 0) process.exitCode = 1
