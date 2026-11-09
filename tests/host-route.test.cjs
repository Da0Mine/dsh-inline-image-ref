/**
 * 离线回归（Host 半）：`POST /dsh-inline-image/save` 落盘到
 * `%TEMP%\dsh-inline-image\<sha 前 2 位>\<名字>-<sha 前 16 位>.<ext>`，
 * 同内容去重（只刷新 mtime）、不同内容不串、超 24 小时的旧图被顺手清掉。
 *
 * 跑法：node tests/host-route.test.cjs
 * 不启 DSH：用假 ctx 抓住 webServer 注册的 handler，直接喂假 req/res。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("  PASS " + name);
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    console.log("  FAIL " + name + "  -> " + (error instanceof Error ? error.message : String(error)));
  }
}

function makeReq(url, chunks) {
  return {
    method: "POST",
    url: url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    }
  };
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = typeof body === "string" ? body : String(body ?? "");
    }
  };
}

(async () => {
  const modulePath = path.resolve(__dirname, "..", "index.js");
  const plugin = await import(pathToFileURL(modulePath).href);

  const root = path.join(os.tmpdir(), "dsh-inline-image");
  // 干净起步：只清本包自己的临时目录（别的临时文件一概不碰）。
  fs.rmSync(root, { recursive: true, force: true });

  let handler = null;
  const ctx = {
    get(name) {
      if (name !== "webServer") return undefined;
      return {
        register(options) {
          handler = options.handler;
          assert.equal(options.kind, "prefix");
          assert.equal(options.path, "/dsh-inline-image");
        }
      };
    }
  };

  console.log("[1] 注册");
  plugin.apply(ctx);
  check("注册了 prefix 路由 /dsh-inline-image", () => assert.ok(typeof handler === "function"));

  console.log("[2] 落盘位置在 %TEMP%\\dsh-inline-image 下，内容寻址");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  let res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=shot.png&sessionId=s1", [bytes]), res);
  const first = JSON.parse(res.body);
  check("返回 ok 且路径可读", () => {
    assert.equal(first.ok, true);
    assert.ok(fs.existsSync(first.value.path), first.value.path);
    assert.ok(first.value.path.startsWith(root), first.value.path);
  });
  check("路径形状 = <2 位 hash>/<名字>-<16 位 hash>.png", () => {
    const rel = path.relative(root, first.value.path).split(path.sep);
    assert.equal(rel.length, 2, rel.join("/"));
    assert.match(rel[0], /^[0-9a-f]{2}$/u);
    assert.match(rel[1], /^shot-[0-9a-f]{16}\.png$/u);
  });
  check("字节原样落盘", () => assert.deepEqual([...fs.readFileSync(first.value.path)], [...bytes]));
  check("originalName 回原样名字", () => assert.equal(first.value.originalName, "shot.png"));
  check("没往项目目录里写东西", () => assert.equal(fs.existsSync(path.join(process.cwd(), ".dsh-inline-image")), false));

  console.log("[3] 同内容再贴一次 → 同一个文件（只刷新 mtime）");
  const before = fs.readdirSync(path.dirname(first.value.path)).length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=shot.png&sessionId=s1", [bytes]), res);
  const again = JSON.parse(res.body);
  check("路径完全一致", () => assert.equal(again.value.path, first.value.path));
  check("目录里没多出副本", () => assert.equal(fs.readdirSync(path.dirname(first.value.path)).length, before));

  console.log("[4] 同名但内容不同 → 两个文件（hash 不同）");
  res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=shot.png&sessionId=s1", [Buffer.from([9, 9, 9])]), res);
  const other = JSON.parse(res.body);
  check("落到不同路径", () => {
    assert.equal(other.ok, true);
    assert.notEqual(other.value.path, first.value.path);
    assert.match(path.basename(other.value.path), /^shot-[0-9a-f]{16}\.png$/u);
  });

  console.log("[5] 文件名清洗");
  res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=" + encodeURIComponent("../../evil:name?.png"), [Buffer.from([1])]), res);
  const cleaned = JSON.parse(res.body);
  check("去掉路径与非法字符，仍落在临时根里", () => {
    assert.equal(cleaned.ok, true);
    assert.ok(cleaned.value.path.startsWith(root), cleaned.value.path);
    assert.ok(!/[:?]/u.test(path.basename(cleaned.value.path)), path.basename(cleaned.value.path));
    assert.match(path.basename(cleaned.value.path), /^evil_name_-[0-9a-f]{16}\.png$/u);
  });

  console.log("[6] 过期清理（> 24h 没人碰的旧图）");
  const staleDir = path.join(root, "ff");
  fs.mkdirSync(staleDir, { recursive: true });
  const stale = path.join(staleDir, "old-aaaaaaaaaaaaaaaa.png");
  fs.writeFileSync(stale, Buffer.from([7]));
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=fresh.png&sessionId=s1", [Buffer.from([5, 5])]), res);
  await new Promise((resolve) => setTimeout(resolve, 250)); // 清理是 fire-and-forget
  check("旧图被清掉", () => assert.equal(fs.existsSync(stale), false));
  check("新图还在", () => assert.equal(JSON.parse(res.body).ok, true));

  console.log("[7] 边界");
  res = makeRes();
  await handler(makeReq("/dsh-inline-image/save?name=empty.png&sessionId=s1", []), res);
  check("空文件 → 400", () => {
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  });
  res = makeRes();
  await handler({ method: "POST", url: "/dsh-inline-image/nope" }, res);
  check("未知子路径 → 404", () => assert.equal(res.status, 404));

  fs.rmSync(root, { recursive: true, force: true });

  const failed = results.filter((item) => !item.ok);
  console.log("\n=== " + (failed.length === 0 ? "全部通过" : "有失败") + "：" + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length > 0) process.exitCode = 1;
})().catch((error) => {
  console.error("host route test crashed:", error);
  process.exitCode = 1;
});
