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
  const argsList = ["-s", "-S", "--max-time", "60", "-w", "\n%{http_code}"];
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
  const out = execSync(["curl.exe", ...argsList].map((a) => '"' + String(a).replace(/"/g, '\\"') + '"').join(" "), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const cut = out.lastIndexOf("\n");
  const status = Number(out.slice(cut + 1).trim());
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

/* ───────────── 1. 版本 + tag + push ───────────── */

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
  sh("git add package.json", { quiet: true });
  sh('git commit -m "release ' + tag + '" --no-verify', { quiet: true });
  sh("git tag " + tag, { quiet: true });
  sh("git push origin HEAD --follow-tags", { quiet: true });
  record("已 push " + tag, true);

  console.log("[2] 等 registry 翻牌");
  let live = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 15000));
    try {
      const meta = JSON.parse(
        shOut('curl.exe -s --max-time 30 "https://registry.npmjs.org/' + pkg.name + "/" + version + '"') || "{}"
      );
      if (meta.version === version) {
        live = true;
        break;
      }
    } catch {
      /* 还没上线，继续等 */
    }
  }
  record("npm 上已有 " + version, live, live ? "" : "等了 10 分钟还没出现，去 Actions 看日志");
  if (!live) process.exitCode = 1;
}

/* ───────────── 2. 市场条目 + PR ───────────── */

if (!npmOnly) {
  console.log("[3] 市场条目");
  const ymlPath = "data/plugins/" + OWNER.toLowerCase() + "__" + REPO + ".yml";
  const branch = "add/" + REPO + "-v" + version.replace(/\./g, "");
  const yaml = [
    "url: https://github.com/" + OWNER + "/" + REPO,
    "name: " + OWNER + "/" + REPO,
    "category: " + CATEGORY,
    'description.en: "' + DESCRIPTION_EN.replace(/"/g, '\\"') + '"',
    "description.zh: " + DESCRIPTION_ZH,
    ""
  ].join("\n");

  /* fork（幂等） */
  const fork = api("POST", "/repos/" + MARKET_UPSTREAM + "/forks", {});
  record("fork 就绪", fork.status === 202 || fork.status === 200 || fork.status === 422, "HTTP " + fork.status);

  /* 分支：从 upstream 的 ref 直接建（别 merge，unrelated histories） */
  const upstreamMain = api("GET", "/repos/" + MARKET_UPSTREAM + "/git/ref/heads/" + MARKET_BRANCH_BASE);
  const sha = upstreamMain.body?.object?.sha;
  record("读到 upstream head", Boolean(sha), sha ? sha.slice(0, 8) : "HTTP " + upstreamMain.status);

  let putBody = {
    message: "add " + OWNER + "/" + REPO + " v" + version,
    content: Buffer.from(yaml, "utf8").toString("base64"),
    branch
  };
  let put = api("PUT", "/repos/" + MARKET_UPSTREAM + "/contents/" + ymlPath, putBody);
  if (put.status === 404 || put.status === 422) {
    /* 分支还不存在：先建分支 */
    api("POST", "/repos/" + MARKET_UPSTREAM + "/git/refs", { ref: "refs/heads/" + branch, sha });
    put = api("PUT", "/repos/" + MARKET_UPSTREAM + "/contents/" + ymlPath, putBody);
  }
  if (put.status === 422 && String(put.body?.message || "").includes("sha")) {
    /* 文件已存在：带 sha 再 PUT */
    const existing = api("GET", "/repos/" + MARKET_UPSTREAM + "/contents/" + ymlPath + "?ref=" + branch);
    putBody = { ...putBody, sha: existing.body?.sha };
    put = api("PUT", "/repos/" + MARKET_UPSTREAM + "/contents/" + ymlPath, putBody);
  }
  record("市场条目已提交", put.status === 200 || put.status === 201, "HTTP " + put.status + " " + ymlPath);

  const pr = api("POST", "/repos/" + MARKET_UPSTREAM + "/pulls", {
    head: OWNER + ":" + branch,
    base: MARKET_BRANCH_BASE,
    title: "Add " + OWNER + "/" + REPO + " (" + pkg.name + " v" + version + ")",
    body:
      "投稿 " + OWNER + "/" + REPO + "\n\n" +
      "- npm: `" + pkg.name + "@" + version + "`\n" +
      "- 插件类型：client 半边（composer 交互）+ host 半边（落盘路由）\n" +
      "- " + DESCRIPTION_ZH + "\n"
  });
  record("PR", pr.status === 201 || pr.status === 200, pr.body?.html_url || "HTTP " + pr.status + " " + JSON.stringify(pr.body).slice(0, 160));
}

console.log("\n=== 结果 ===");
for (const step of steps) console.log((step.ok ? "✔" : "✘") + " " + step.name + (step.detail ? "  " + step.detail : ""));
const bad = steps.filter((s) => !s.ok);
if (bad.length > 0) process.exitCode = 1;
