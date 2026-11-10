#!/usr/bin/env node
/**
 * 一条命令发版：npm（走 CI 的 Trusted Publishing）+ 市场（awesome-dsh-plugin 的 PR）。
 *
 *   node scripts/release.mjs patch          # 0.5.0 → 0.5.1
 *   node scripts/release.mjs minor
 *   node scripts/release.mjs 1.2.0          # 直接指定
 *   node scripts/release.mjs patch --npm-only
 *   node scripts/release.mjs patch --market-only
 *
 * 做四件事：
 *   1. 把 package.json 版本升级、写进 git、打 tag、push（CI 收到 tag 就用 OIDC 发 npm）
 *   2. 轮询 registry，确认新版本真的上线（拿到 dist-tags.latest 才算成功）
 *   3. 把市场条目 data/plugins/<owner>__<repo>.yml 更新到新版本（fork → 分支 → contents API → PR）
 *   4. 打印一份结果表
 *
 * 前置：本机已有 GitHub 凭据（git credential fill 能拿到）；repo 已配置 npm Trusted Publisher。
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ───────────── 配置（换插件只改这一段） ───────────── */
const OWNER = "Da0Mine";
const REPO = "dsh-inline-image-ref";
const MARKET_UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const MARKET_BRANCH_BASE = "main";
const CATEGORY = "ui";
const DESCRIPTION_EN =
  "DSH plugin: images dropped or pasted into the composer become @path reference chips at the caret, with a hover preview.";
const DESCRIPTION_ZH =
  "把拖入/粘贴进输入框的图片当文件处理：光标处插 @路径 胶囊、不占附件栏，输入框与已发送消息里都能悬停看原图。";
/* ──────────────────────────────────────────────── */

const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--")) || "patch";
const npmOnly = args.includes("--npm-only");
const marketOnly = args.includes("--market-only");

const sh = (cmd, options = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: options.quiet ? "pipe" : "inherit", ...options }).trim();
const shOut = (cmd) => execSync(cmd, { encoding: "utf8", stdio: "pipe" }).trim();

function githubToken() {
  const out = execSync("git credential fill", {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const map = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) map[line.slice(0, at)] = line.slice(at + 1);
  }
  if (!map.password) throw new Error("拿不到 GitHub 凭据（git credential fill 为空）");
  return map.password;
}

function api(method, path, body) {
  const dir = mkdtempSync(join(tmpdir(), "rel-api-"));
  const argsList = ["-s", "-S", "--max-time", "60", "-x", "http://127.0.0.1:7899", "-w", "|||%{http_code}"];
  argsList.push("-H", "Authorization: Bearer " + githubToken());
  argsList.push("-H", "Accept: application/vnd.github+json");
  argsList.push("-H", "User-Agent: dsh-release");
  if (method !== "GET") argsList.push("-X", method);
  if (body !== undefined) {
    const file = join(dir, "body.json");
    writeFileSync(file, JSON.stringify(body), "utf8");
    argsList.push("-H", "Content-Type: application/json", "--data-binary", "@" + file);
  }
  argsList.push(path.startsWith("http") ? path : "https://api.github.com" + path);
  const cmdLine = ["curl.exe", ...argsList].map((a) => '"' + String(a).replace(/"/g, '\\"') + '"').join(" ");
  if (process.env.REL_DEBUG) console.log("DEBUG " + cmdLine.replace(/Bearer [^"]+/u, "Bearer ***"));
  const out = execSync(cmdLine, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const cut = out.lastIndexOf("|||");
  const status = Number(out.slice(cut + 3).trim());
  let parsed;
  try {
    parsed = JSON.parse(out.slice(0, cut) || "null");
  } catch {
    parsed = out.slice(0, cut);
  }
  return { status, body: parsed };
}

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
  const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
  if (bump === "major") return major + 1 + ".0.0";
  if (bump === "minor") return major + "." + (minor + 1) + ".0";
  return major + "." + minor + "." + (patch + 1);
}

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log((ok ? "  OK   " : "  FAIL ") + name + (detail ? "  -> " + detail : ""));
}

/* ───────────── 1. 版本 + 本地发 npm + push ───────────── */

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = marketOnly ? pkg.version : nextVersion(pkg.version, bump);
const tag = "v" + version;

if (!marketOnly) {
  console.log("[1] 发 " + pkg.name + "@" + version);

  const dirty = shOut("git status --porcelain");
  if (dirty !== "") {
    record("工作区干净", false, "先提交或清理未跟踪改动：\n" + dirty);
    process.exit(1);
  }
  record("工作区干净", true);

  console.log("  · 自检");
  sh("node _publish-smoke.mjs", { quiet: true });
  record("_publish-smoke 通过", true);

  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  /* 两条通道：
     默认（OIDC）：只推 tag，让 publish.yml 用 Trusted Publishing 发 —— 无 token、不会过期。
     --local    ：本机直接 npm publish（token 在 .npmrc），网络不便时用。 */
  const useLocal = args.includes("--local");
  if (useLocal) {
    const env = {
      ...process.env,
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_proxy: "http://127.0.0.1:7899",
      npm_config_https_proxy: "http://127.0.0.1:7899"
    };
    try {
      execSync("npm publish --access public", { stdio: "inherit", env });
      record("npm publish（本地 token）", true);
    } catch {
      record("npm publish（本地 token）", false, "看上面 npm 的报错");
      process.exitCode = 1;
    }
  }

  sh("git add package.json", { quiet: true });
  sh('git commit -m "release ' + tag + '" --no-verify', { quiet: true });
  /* 必须是 annotated tag + 显式推 refs/tags：轻量 tag 配 --follow-tags 不会推到远端，
     CI 收不到 push 事件，等于「发了版但没人发」（2026-11-09 踩过）。 */
  sh('git tag -a ' + tag + ' -m "release ' + tag + '"', { quiet: true });
  try {
    sh("git -c protocol.version=0 push origin HEAD", { quiet: true });
    sh("git -c protocol.version=0 push origin refs/tags/" + tag, { quiet: true });
    record("已 push " + tag + (useLocal ? "" : "（CI 开始发版）"), true);
  } catch (error) {
    record("已 push " + tag, false, "git 直连要走 protocol.version=0；可稍后手动 push");
  }

  console.log("[2] 等 registry 翻牌" + (useLocal ? "" : "（CI 大约 1-2 分钟）"));
  let live = false;
  for (let i = 0; i < 30; i += 1) {
    try {
      const meta = JSON.parse(
        shOut('curl.exe -s --max-time 30 -x http://127.0.0.1:7899 "https://registry.npmjs.org/' + pkg.name + "/" + version + '"') || "{}"
      );
      if (meta.version === version) {
        live = true;
        break;
      }
    } catch {
      /* 还没上线，继续等 */
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  record("npm 上已有 " + version, live, live ? "" : "5 分钟内没翻牌，去 registry 手动确认");
  if (!live) process.exitCode = 1;
}

/* ───────────── 2. 市场条目 + PR ───────────── */

if (!npmOnly) {
  console.log("[3] 市场条目");
  /* 文件名必须与 url 的 owner/repo 大小写一致（市场校验器硬性要求） */
  const ymlPath = "data/plugins/" + OWNER + "__" + REPO + ".yml";
  const branch = "add/" + REPO + "-v" + version.replace(/\./g, "");
  const yaml = [
    "url: https://github.com/" + OWNER + "/" + REPO,
    "name: " + OWNER + "/" + REPO,
    "category: " + CATEGORY,
    "description:",
    '  en: "' + DESCRIPTION_EN.replace(/"/g, '\\"') + '"',
    "  zh: " + DESCRIPTION_ZH,
    ""
  ].join("\n");

  /* 市场条目本身不分版本（只有 url/name/category/description）：内容没变就别开 PR。
     每周目都提一次空 PR 只会骚扰维护者。 */
  const changed = api("GET", "/repos/" + MARKET_UPSTREAM + "/contents/" + encodeURIComponent(ymlPath));
  if (changed.status === 200 && changed.body?.content) {
    const current = Buffer.from(changed.body.content, "base64").toString("utf8");
    const normalize = (text) => text.replace(/\r\n/g, "\n").trim();
    if (normalize(current) === normalize(yaml)) {
      record("市场条目无变化，跳过 PR", true, ymlPath);
      if (!marketOnly) {
        /* 条目没变，剩下只有 npm 那半，已经做完了 */
      }
      console.log("\n=== 结果 ===");
      for (const step of steps) console.log((step.ok ? "✔" : "✘") + " " + step.name + (step.detail ? "  " + step.detail : ""));
      process.exit(process.exitCode ?? 0);
    }
  }

  /* fork（幂等）：分支与提交都要落在自己的 fork 上，PR 的 head 才能写 Da0Mine:<branch> */
  const FORK = OWNER + "/" + MARKET_UPSTREAM.split("/")[1];
  const fork = api("POST", "/repos/" + MARKET_UPSTREAM + "/forks", {});
  let ready = fork.status === 202 || fork.status === 200 || fork.status === 422;
  /* 202 是异步建仓：等它真能读 */
  for (let i = 0; i < 20 && ready; i += 1) {
    const probe = api("GET", "/repos/" + FORK);
    if (probe.status === 200) {
      ready = true;
      break;
    }
    ready = false;
    await new Promise((r) => setTimeout(r, 3000));
  }
  record("fork 就绪", ready, FORK);

  /* 先看有没有我们自己还没合并的投稿 PR：有就更新它那条分支，别再开一个。
     市场条目本身不分版本，每次发版都新开 PR 只会堆重复（2026-11-10 踩过两次：#13925、#13931）。
     注意：这仓库一天几十个 PR，只看第一页会漏掉自己昨天提的那个，所以翻 4 页。 */
  let targetBranch = branch;
  let reusePr = null;
  for (let page = 1; page <= 4 && reusePr === null; page += 1) {
    const openPrs = api("GET", "/repos/" + MARKET_UPSTREAM + "/pulls?state=open&per_page=100&page=" + page);
    if (!Array.isArray(openPrs.body) || openPrs.body.length === 0) break;
    for (const pr of openPrs.body) {
      const label = typeof pr.head?.label === "string" ? pr.head.label : "";
      if (!label.startsWith(OWNER + ":")) continue;
      const files = api("GET", "/repos/" + MARKET_UPSTREAM + "/pulls/" + pr.number + "/files?per_page=100");
      if (Array.isArray(files.body) && files.body.some((f) => f.filename === ymlPath)) {
        reusePr = pr;
        targetBranch = pr.head.ref;
        break;
      }
    }
  }
  if (reusePr !== null) record("复用既有投稿 PR", true, "#" + reusePr.number + " → " + targetBranch);

  /* 分支：从 upstream 的 ref 直接建（别 merge，unrelated histories） */
  const upstreamMain = api("GET", "/repos/" + MARKET_UPSTREAM + "/git/ref/heads/" + MARKET_BRANCH_BASE);
  const sha = upstreamMain.body?.object?.sha;
  record("读到 upstream head", Boolean(sha), sha ? sha.slice(0, 8) : "HTTP " + upstreamMain.status);

  if (ready && sha) {
    if (reusePr === null) {
      /* 分支不存在才建；已存在（重新发版）就复用 */
      const hasBranch = api("GET", "/repos/" + FORK + "/git/ref/heads/" + targetBranch);
      if (hasBranch.status !== 200) {
        const made = api("POST", "/repos/" + FORK + "/git/refs", { ref: "refs/heads/" + targetBranch, sha });
        record("分支已建", made.status === 201 || made.status === 200 || made.status === 422, targetBranch + " ← " + (made.status === 422 ? "已存在" : "ok"));
      } else {
        record("分支已存在", true, targetBranch);
      }
    } else {
      record("分支沿用", true, targetBranch);
    }

    const putBody = {
      message: "add " + OWNER + "/" + REPO + " v" + version,
      content: Buffer.from(yaml, "utf8").toString("base64"),
      branch: targetBranch
    };
    let put = api("PUT", "/repos/" + FORK + "/contents/" + ymlPath, putBody);
    if (put.status === 422) {
      /* 该分支上文件已存在：带 sha 再 PUT */
      const existing = api("GET", "/repos/" + FORK + "/contents/" + ymlPath + "?ref=" + targetBranch);
      if (existing.status === 200) {
        put = api("PUT", "/repos/" + FORK + "/contents/" + ymlPath, { ...putBody, sha: existing.body?.sha });
      }
    }
    record("市场条目已提交", put.status === 200 || put.status === 201, "HTTP " + put.status + " " + ymlPath);

    if (reusePr !== null) {
      record("PR 已更新（未新建）", true, reusePr.html_url);
    } else {
      const pr = api("POST", "/repos/" + MARKET_UPSTREAM + "/pulls", {
        head: OWNER + ":" + targetBranch,
        base: MARKET_BRANCH_BASE,
        title: "Add " + OWNER + "/" + REPO + " (" + pkg.name + " v" + version + ")",
        body:
          "投稿 " + OWNER + "/" + REPO + "\n\n" +
          "- npm: `" + pkg.name + "@" + version + "`\n" +
          "- 插件类型：client 半边（composer 交互）+ host 半边（落盘路由）\n" +
          "- " + DESCRIPTION_ZH + "\n"
      });
      record(
        "PR",
        pr.status === 201 || pr.status === 200,
        pr.body?.html_url || "HTTP " + pr.status + " " + JSON.stringify(pr.body).slice(0, 200)
      );
    }
  }
}

console.log("\n=== 结果 ===");
for (const step of steps) console.log((step.ok ? "✔" : "✘") + " " + step.name + (step.detail ? "  " + step.detail : ""));
const bad = steps.filter((s) => !s.ok);
if (bad.length > 0) process.exitCode = 1;
