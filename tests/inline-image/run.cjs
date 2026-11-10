/**
 * 离线回归：dsh-inline-image 的两件事
 *   ① 拖入带真实路径的图片 → 把它的 MIME 降级成二进制（官方那条判断就会走 @路径 引用分支）
 *   ② 悬停引用胶囊 → 用 remote.workspaceFiles.readBytes 取字节，浮层里显示原图
 *
 * 跑法：node tests/inline-image/run.cjs
 * 说明：这里不复制 DSH 的 React/Lexical，只复制**判断所依赖的那几条事实**：
 *       官方的 upload 分支条件是 `path === "" || isImageMediaType(file.type)`；
 *       胶囊 DOM 是 `<span class="…_chip" title="文件名">`；输入框在 `[data-composer-card]` 里。
 */
const path = require("path");
const os = require("os");
const fs = require("fs");

/** playwright：先认本机已装的，再翻 npx 缓存。 */
function resolvePlaywright() {
  const candidates = [process.env.MODEL_CARDS_PLAYWRIGHT, process.env.INLINE_IMAGE_PLAYWRIGHT, "playwright"];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    try {
      return require(candidate);
    } catch (error) {
      /* 试下一个 */
    }
  }
  const cache = path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx");
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      const direct = path.join(cache, entry, "node_modules", "playwright");
      if (fs.existsSync(direct)) return require(direct);
    }
  }
  throw new Error("找不到 playwright，可设 INLINE_IMAGE_PLAYWRIGHT=<playwright 包目录>");
}

/** 本机 ms-playwright 里的 chromium 可执行文件。 */
function resolveChromium() {
  if (process.env.INLINE_IMAGE_CHROMIUM) return process.env.INLINE_IMAGE_CHROMIUM;
  const root = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((name) => name.indexOf("chromium-") === 0).sort().reverse();
  for (const dir of dirs) {
    for (const sub of ["chrome-win64", "chrome-win"]) {
      const exe = path.join(root, dir, sub, "chrome.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const REPO = path.resolve(__dirname, "..", "..");
const HARNESS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-inline-image-"));
fs.copyFileSync(path.join(REPO, "client.js"), path.join(HARNESS_DIR, "client.js"));
fs.copyFileSync(path.join(__dirname, "harness.html"), path.join(HARNESS_DIR, "index.html"));
const HARNESS = "file:///" + path.join(HARNESS_DIR, "index.html").replace(/\\/g, "/");

const { chromium } = resolvePlaywright();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-inline-image-profile-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: resolveChromium(),
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text());
  });

  await page.goto(HARNESS);
  await page.evaluate(() => window.localStorage.clear());
  await page.evaluate(() => window.__mountBridge("session-1"));

  console.log("[1] 注册面");
  const registered = await page.evaluate(() => window.__slots.map((entry) => entry.spec && entry.spec.name));
  check("dock 槽注册上了（拿 sessionId 用）", registered.includes("conversation.input.dock"), registered);

  console.log("[2] 拖入：带路径的图 + 普通文件 → 只降级，官方接手");
  const drop = await page.evaluate(() =>
    window.__drop([
      { name: "a.png", type: "image/png", path: "D:\\pics\\a.png" },
      { name: "note.txt", type: "text/plain", path: "D:\\pics\\note.txt" }
    ])
  );
  const byName = new Map(drop.seen.map((item) => [item.name, item]));
  check(
    "带路径的图片被降级成二进制 MIME（官方会走 @路径 引用）",
    byName.get("a.png").type === "application/octet-stream",
    byName.get("a.png")
  );
  check("普通文件完全不动", byName.get("note.txt").type === "text/plain", byName.get("note.txt"));
  check("事件没有被吞掉（可取消性未变）", drop.prevented !== true, drop.readBackSame);

  console.log("[3] 文件名 → 路径 已记下");
  const labels = await page.evaluate(() => window.__labels());
  check("记忆里记的是绝对路径", labels !== null && labels["a.png"] === "D:\\pics\\a.png", labels);

  console.log("[3b] 粘贴：带路径的图片 → 只降级，交给官方插引用");
  await page.evaluate(() => window.__resetCalls());
  const pasteWithPath = await page.evaluate(() => window.__paste([{ name: "c.png", type: "image/png", path: "D:\\pics\\c.png" }]));
  check(
    "粘贴带路径的图片被降级",
    pasteWithPath.seen[0] && pasteWithPath.seen[0].type === "application/octet-stream",
    pasteWithPath.seen[0]
  );
  check("这条路径不接管事件（官方自己插）", pasteWithPath.prevented !== true, pasteWithPath.prevented);
  check("没去落盘", (await page.evaluate(() => window.__calls.saves.length)) === 0);

  console.log("[3c] 粘贴：没有路径的截图 → 接管 + 落盘 + 光标处插 @路径");
  await page.evaluate(() => window.__resetCalls());
  const pasteBitmap = await page.evaluate(() =>
    window.__paste([{ name: "image.png", type: "image/png" }])
  );
  await page.waitForTimeout(400);
  const saves = await page.evaluate(() => window.__calls.saves);
  const chips = await page.evaluate(() => window.__calls.chips);
  check("接管了粘贴事件", pasteBitmap.prevented === true, pasteBitmap.prevented);
  check("POST 到了宿主落盘路由", saves.length === 1 && saves[0].url.indexOf("/dsh-inline-image/save") >= 0, saves);
  check("请求体带着真实字节", saves.length === 1 && saves[0].bytes > 0, saves[0] && saves[0].bytes);
  check("插了一颗引用胶囊", chips.length === 1, chips.length);
  check(
    "引用指向 %TEMP% 下落盘的那份（绝对路径）",
    chips.length === 1 && /^@C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-inline-image\\ab\\pasted-.+-abcdef0123456789\.png$/u.test(chips[0].ref.ref),
    chips[0] && chips[0].ref.ref
  );
  check(
    "胶囊 label = 原始文件名（不带 hash），appearance=file",
    chips.length === 1 && chips[0].ref.appearance === "file" && /^pasted-\d{8}-\d{6}\.png$/u.test(chips[0].ref.label),
    chips[0] && chips[0].ref
  );
  check("span 带 draftRev（插在光标处的前提）", chips.length === 1 && typeof chips[0].span.draftRev === "number", chips[0] && chips[0].span);
  check("没往附件栏里塞东西", (await page.evaluate(() => window.__calls.attachments.length)) === 0);

  console.log("[3d] 粘贴：文字 + 截图 → 不接管，交回官方");
  await page.evaluate(() => window.__resetCalls());
  const pasteMixedText = await page.evaluate(() => window.__paste([{ name: "image.png", type: "image/png" }], "一段文字"));
  await page.waitForTimeout(250);
  check("带文字时不接管", pasteMixedText.prevented !== true, pasteMixedText.prevented);
  check("也没有落盘/插胶囊", (await page.evaluate(() => window.__calls.saves.length + window.__calls.chips.length)) === 0);

  console.log("[3e] 拖入：带路径 + 无路径混在一批 → 两张都变引用");
  await page.evaluate(() => window.__resetCalls());
  const mixedDrop = await page.evaluate(() =>
    window.__drop([
      { name: "d.png", type: "image/png", path: "D:\\pics\\d.png" },
      { name: "shot.png", type: "image/png" }
    ])
  );
  await page.waitForTimeout(400);
  const mixedChips = await page.evaluate(() => window.__calls.chips);
  check("接管了拖放", mixedDrop.prevented === true, mixedDrop.prevented);
  check("两张都插了胶囊", mixedChips.length === 2, mixedChips.map((c) => c.ref.ref));
  check(
    "第一张按原路径，第二张指向 %TEMP% 下落盘的那份",
    mixedChips.length === 2 &&
      mixedChips[0].ref.ref === "@D:\\pics\\d.png" &&
      /^@C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-inline-image\\ab\\shot-abcdef0123456789\.png$/u.test(mixedChips[1].ref.ref),
    mixedChips.map((c) => c.ref.ref)
  );

  console.log("[3f] 粘贴回自己草稿的文本：@图片路径 要重新拼成胶囊，不能退化成文字");
  await page.evaluate(() => window.__resetCalls());
  const roundTrip = await page.evaluate(() =>
    window.__paste(
      [
        /* 没有文件，只有文本：模拟「全选复制草稿 → 粘回输入框」 */
      ],
      '看这张 @"D:\\pics\\a.png" 和这句'
    )
  );
  await page.waitForTimeout(250);
  const rtChips = await page.evaluate(() => window.__calls.chips);
  const rtTexts = await page.evaluate(() => window.__calls.texts);
  check("接管了这次文本粘贴", roundTrip.prevented === true, roundTrip.prevented);
  check("图片路径被拼回胶囊", rtChips.length === 1 && rtChips[0].ref.ref === '@"D:\\pics\\a.png"', rtChips.map((c) => c.ref.ref));
  check("胶囊 label = 记过的名字（a.png）", rtChips.length === 1 && rtChips[0].ref.label === "a.png", rtChips[0] && rtChips[0].ref.label);
  check("前后文字按原样插回", rtTexts.length === 2 && rtTexts[0].text === "看这张 " && rtTexts[1].text === " 和这句", rtTexts.map((t) => t.text));

  console.log("[3g] 普通文字粘贴不受影响");
  await page.evaluate(() => window.__resetCalls());
  const plain = await page.evaluate(() => window.__paste([], "就是一段普通文字，没有引用"));
  await page.waitForTimeout(150);
  check("不接管", plain.prevented !== true, plain.prevented);
  check("没有插入动作", (await page.evaluate(() => window.__calls.chips.length + window.__calls.texts.length)) === 0);

  console.log("[3h] 非图片引用（@notes.txt）也不接管");
  await page.evaluate(() => window.__resetCalls());
  const nonImage = await page.evaluate(() => window.__paste([], "见 @notes.txt 这份说明"));
  await page.waitForTimeout(150);
  check("不接管", nonImage.prevented !== true, nonImage.prevented);
  check("没有插入动作", (await page.evaluate(() => window.__calls.chips.length)) === 0);

  console.log("[3i] 长文本粘贴（≥4000 字）→ 折成 .md 文件引用，而不是把几千字塞进输入框");
  const longPaste = await page.evaluate(() => {
    window.__resetCalls();
    const text = "长".repeat(4200);
    window.__textFileContent = text;
    const result = window.__paste([], text);
    return { prevented: result.prevented, chars: text.length };
  });
  await page.waitForTimeout(400);
  const folded = await page.evaluate(() => ({ saves: window.__calls.saves, chips: window.__calls.chips, texts: window.__calls.texts }));
  check("接管了这次长文本粘贴", longPaste.prevented === true, longPaste.prevented);
  check("落成一个 .md（名字 pasted-text-1.md）", folded.saves.length === 1 && /name=pasted-text-1\.md/u.test(folded.saves[0].url), folded.saves.map((s) => s.url));
  check("按图片那套插了一颗引用胶囊", folded.chips.length === 1 && String(folded.chips[0].ref.ref).indexOf("pasted-text-1") >= 0, folded.chips.map((c) => c.ref.ref));
  check("输入框里没多出这 4200 字", folded.texts.length === 0, folded.texts.length);

  console.log("[3j] 悬停那颗胶囊 → 显示文件里的文字");
  const foldedLabel = folded.chips.length > 0 ? folded.chips[0].ref.label : "";
  const foldedMention = folded.chips.length > 0 ? folded.chips[0].ref.ref : "";
  await page.evaluate((label) => {
    const input = document.querySelector("[data-composer-input]");
    const chip = document.createElement("span");
    chip.setAttribute("data-composer-chip", "reference");
    chip.className = "_6XhDDa_reference";
    chip.setAttribute("title", label);
    input.appendChild(chip);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  }, foldedLabel);
  await page.waitForTimeout(300);
  const textPreview = await page.evaluate(() => window.__preview());
  check("浮层显示的是文字而不是图", textPreview !== null && textPreview.hasText === true && textPreview.hasImage === false, textPreview && { hasText: textPreview.hasText, hasImage: textPreview.hasImage });
  check("文字内容对得上", textPreview !== null && String(textPreview.text).indexOf("长长长") === 0, textPreview && String(textPreview.text).slice(0, 6));
  check("标题标出总字数", textPreview !== null && /4200 字/u.test(String(textPreview.caption)), textPreview && textPreview.caption);

  console.log("[3k] 点击那颗胶囊 → 把文件内容写回输入框（胶囊消失，回到纯文字）");
  await page.evaluate(() => window.__resetCalls());
  await page.evaluate(
    (payload) => {
      window.__setProjection(
        [{ source: "reference", ref: payload.mention, label: payload.label, offset: 0, length: payload.mention.length }],
        "\uFFFC"
      );
      const chip = document.querySelector('[data-composer-input] span[title="' + payload.label + '"]');
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
    { label: foldedLabel, mention: foldedMention }
  );
  await page.waitForTimeout(300);
  const afterClick = await page.evaluate(() => window.__calls.texts);
  check("点击后把全文写回输入框", afterClick.length === 1 && afterClick[0].text.length === 4200, afterClick.map((t) => t.text.length));
  check("替换范围正好是那颗胶囊那 1 个字符", afterClick.length === 1 && afterClick[0].span.start === 0 && afterClick[0].span.end === 1, afterClick[0] && afterClick[0].span);
  /* 胶囊被整颗换成文字后它再也收不到 mouseout —— 浮层必须由点击自己收掉（否则会挂在那儿关不掉）。 */
  const popoverAfterClick = await page.evaluate(() => window.__preview());
  check("点击展开后浮层自己收掉", popoverAfterClick === null, popoverAfterClick && popoverAfterClick.count);
  await page.waitForTimeout(150);

  console.log("[3l] 回退对话 / 恢复草稿后：裸的 @图片路径要自动变回胶囊");
  await page.evaluate(() => {
    window.__resetCalls();
    /* 模拟 dsh-rewind-plugin 的恢复方式：草稿被写成纯文本（这里直接改官方投影里的 detect 文本） */
    window.__setProjection([], "回退后的草稿：@D:\\pics\\a.png 结尾");
    window.__touchComposer();
  });
  await page.waitForTimeout(800);
  const restoredChips = await page.evaluate(() => window.__calls.chips);
  check("裸路径被换回胶囊", restoredChips.length === 1 && restoredChips[0].ref.ref === "@D:\\pics\\a.png", restoredChips.map((c) => c.ref.ref));
  check(
    "替换范围正好覆盖那段 mention",
    restoredChips.length === 1 && restoredChips[0].span.end - restoredChips[0].span.start === "@D:\\pics\\a.png".length,
    restoredChips[0] && restoredChips[0].span
  );
  check("标签沿用了记过的名字", restoredChips.length === 1 && restoredChips[0].ref.label === "a.png", restoredChips[0] && restoredChips[0].ref.label);

  console.log("[4] 输入框里没有附件栏的迹象（插件不产原生附件）");
  const rails = await page.evaluate(() => document.querySelectorAll("[data-dsh-inline-image-preview]").length);
  check("初始没有浮层", rails === 0, rails);

  console.log("[5] 悬停引用胶囊 → 显示原图");
  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    const inner = chip.querySelector("span") || chip;
    inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(250);
  const preview = await page.evaluate(() => window.__preview());
  check("浮层出现了", preview !== null && preview.count === 1, preview && preview.count);
  check("读字节用的是当前会话 + 绝对路径", (await page.evaluate(() => window.__calls.readBytes))[0].sessionId === "session-1", await page.evaluate(() => window.__calls.readBytes));
  check("浮层里有 <img>（blob URL）", preview !== null && preview.hasImage === true && String(preview.src).indexOf("blob:") === 0, preview && preview.src);
  check("浮层标着文件名", preview !== null && preview.caption === "a.png", preview && preview.caption);

  console.log("[6] 鼠标移开 → 浮层收起");  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    const inner = chip.querySelector("span") || chip;
    inner.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
  await page.waitForTimeout(120);
  check("浮层已移除", (await page.evaluate(() => window.__preview())) === null);

  console.log("[5b] 悬停在胶囊旁边（整行 / 输入框根）不弹 —— 这一行的文字恰好就是胶囊的名字");
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.setAttribute("data-composer-card", "");
    const root = document.createElement("div");
    root.setAttribute("data-composer-input", "");
    const chip = document.createElement("span");
    chip.setAttribute("data-composer-chip", "reference");
    chip.className = "_6XhDDa_reference";
    chip.setAttribute("title", "a.png");
    root.appendChild(chip);
    root.appendChild(document.createTextNode(" "));
    host.appendChild(root);
    document.getElementById("stage").appendChild(host);
    /* 悬停在「输入框根」上：它的 textContent 正好是 "a.png "，旧逻辑会当成命中胶囊 */
    root.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(200);
  const besideChip = await page.evaluate(() => window.__preview());
  check("不在胶囊上就不弹（以前会）", besideChip === null, besideChip && besideChip.count);

  console.log("[6b] 转录区不停自滚时，浮层要跟着走而不是被收掉");
  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    const inner = chip.querySelector("span") || chip;
    inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    /* 模拟流式输出那种「别处一直在滚」：插件不能因此把浮层收掉。 */
    for (let i = 0; i < 3; i += 1) window.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  const afterScroll = await page.evaluate(() => window.__preview());
  check("滚动之后浮层还在", afterScroll !== null && afterScroll.count === 1, afterScroll && afterScroll.count);

  console.log("[6c] 胶囊滚出视口才收");
  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    chip.style.position = "fixed";
    chip.style.top = "-400px";
    window.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  check("胶囊离开视口后浮层收起", (await page.evaluate(() => window.__preview())) === null);
  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    chip.style.position = "";
    chip.style.top = "";
  });

  console.log("[6d] 类名换掉（不同版本哈希）也照样认得出");
  await page.evaluate(() => {
    const input = document.querySelector("[data-composer-input]");
    const chip = document.createElement("span");
    chip.setAttribute("data-composer-chip", "reference");
    chip.className = "totally-different";
    chip.setAttribute("title", "a.png");
    input.appendChild(chip);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(250);
  const byLabel = await page.evaluate(() => window.__preview());
  check("不依赖 CSS Module 类名，只看名字表", byLabel !== null && byLabel.hasImage === true, byLabel && byLabel.src ? "ok" : byLabel);
  await page.evaluate(() => {
    const chip = document.querySelector("[data-composer-input] span[title='a.png'].totally-different");
    if (chip !== null) chip.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    if (chip !== null && chip.parentNode !== null) chip.parentNode.removeChild(chip);
  });
  await page.waitForTimeout(120);

  console.log("[7] 输入框外的同名胶囊不触发");
  await page.evaluate(() => {
    const outside = document.querySelector("#outside span");
    outside.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(150);
  check("输入框外不弹预览", (await page.evaluate(() => window.__preview())) === null);

  console.log("[8] 悬停普通文件名（记事本那种）不弹");
  await page.evaluate(() => {
    const input = document.querySelector("[data-composer-input]");
    const chip = document.createElement("span");
    chip.setAttribute("data-composer-chip", "reference");
    chip.className = "_6XhDDa_reference _1AbCd_chip";
    chip.setAttribute("title", "note.txt");
    input.appendChild(chip);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(150);
  check("非图片引用不弹预览", (await page.evaluate(() => window.__preview())) === null);

  console.log("[9] 发出去的消息里那颗蓝色链接，悬停也要能看图");
  await page.evaluate(async () => {
    window.__resetCalls();
    const link = document.querySelector("[data-chat-flow] .w30fQq_filePath");
    link.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(250);
  const chatShown = await page.evaluate(() => window.__preview());
  check("浮层出图（DOM 上没有 title，只靠 @路径 文本）", chatShown !== null && chatShown.hasImage === true, chatShown && chatShown.src ? "ok" : chatShown);
  check("标题用路径最后一段（a.png）", chatShown !== null && chatShown.caption === "a.png", chatShown && chatShown.caption);

  console.log("[9b] 段落里夹着路径（不是一个完整引用）不弹");
  await page.evaluate(() => {
    const link = document.querySelector("[data-chat-flow] .w30fQq_filePath");
    link.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    const node = document.querySelector("[data-chat-flow] .LOmM4q_bubble .w30fQq_file");
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(200);
  check("夹在句子里的片段不触发", (await page.evaluate(() => window.__preview())) === null);

  console.log("[9c] 消息里只带路径 title 的那种也认（用一张没缓存过的图验证真去读了字节）");
  await page.evaluate(() => {
    const node = document.querySelector('[data-chat-flow] span[title="D:\\\\pics\\\\c.png"]');
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
  });
  await page.waitForTimeout(250);
  const byTitle = await page.evaluate(() => window.__preview());
  const titleReads = await page.evaluate(() => window.__calls.readBytes);
  check("认路径形式的 title", byTitle !== null && byTitle.hasImage === true, byTitle && byTitle.src ? "ok" : byTitle);
  check("读的就是那个路径", JSON.stringify(titleReads[0] && titleReads[0].path) === JSON.stringify("D:\\pics\\c.png"), titleReads);

  console.log("[9d] 把 Remote 通道抽掉：fail-open，只显示读不到");
  const killed = await page.evaluate(async () => {
    window.__killRemote();
    /* 换一张没缓存过的图，否则会命中上一轮的内存缓存，测不到降级路径。 */
    window.__drop([{ name: "b.png", type: "image/png", path: "D:\\pics\\b.png" }]);
    const input = document.querySelector("[data-composer-input]");
    const chip = document.createElement("span");
    chip.setAttribute("data-composer-chip", "reference");
    chip.className = "_6XhDDa_reference _1AbCd_chip";
    chip.setAttribute("title", "b.png");
    input.appendChild(chip);
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    return window.__remoteKilled === true;
  });
  await page.waitForTimeout(250);
  const degraded = await page.evaluate(() => window.__preview());
  check("Remote 真的抽掉了", killed === true);
  check("没有 img，只给出「读不到」的说明", degraded !== null && degraded.hasImage === false && /读不到/.test(String(degraded.caption)), degraded);
  check("抽掉 Remote 后没炸", errors.length === 0, errors.slice(0, 3));

  console.log("[10] 卸载干净");
  const cleaned = await page.evaluate(async () => {
    for (const dispose of window.__disposers) if (typeof dispose === "function") dispose();
    const chip = document.querySelector("[data-composer-input] span[title='a.png']");
    const inner = chip.querySelector("span") || chip;
    inner.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    return document.querySelectorAll("[data-dsh-inline-image-preview]").length;
  });
  check("卸载后再悬停不弹浮层", cleaned === 0, cleaned);

  check("全程无页面报错", errors.length === 0, errors.slice(0, 3));

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(HARNESS_DIR, { recursive: true, force: true });

  const failed = results.filter((item) => !item.ok);
  console.log("\n=== " + (failed.length === 0 ? "全部通过" : "有失败") + "：" + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length > 0) {
    for (const item of failed) console.log(" - " + item.name + " -> " + JSON.stringify(item.detail));
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("harness crashed:", error);
  process.exitCode = 1;
});
