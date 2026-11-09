# dsh-inline-image-ref

拖进输入框的图片，按**文件引用**处理：不弹附件栏，而是在光标处插一颗 `@路径` 胶囊；鼠标悬停胶囊可以看原图。

## 行为

| 入口 | 带真实 OS 路径的图片 | 没有路径的图片（剪贴板截图 / 位图） | 普通文件 |
| --- | --- | --- | --- |
| 拖入 | → `@路径` 引用胶囊（光标处） | → **落盘**到 `%TEMP%\dsh-inline-image\` 后插 `@绝对路径` | 原生 `@路径` 引用（不变） |
| `Ctrl+V` 粘贴 | → `@路径` 引用胶囊（光标处） | → 同上（**截图也能变文件**） | 不变（带文字时交回原生） |
| 📎 文件选择器 | → `@路径` 引用胶囊（光标处） | → 同上 | 不变 |

悬停引用胶囊：浮层显示原图（读不到时给出说明），`pointer-events:none`，不挡点击。

**发出去的消息里也能悬停**：用户消息里的图片引用是蓝色链接（DOM 上只有 `@路径` 文本，或 `title` 是路径）。命中不看类名（CSS Module 哈希会变），只看三样：`title` 命中我们记过的名字 / `title` 本身是路径 / 节点文本本身就是一个 `@路径`。范围限在输入框与聊天转录（`[data-composer-card]`、`[data-composer-input]`、`[data-chat-turn]`、`[data-chat-flow]`）内；整段必须就是一个引用，夹在句子里的片段不触发。

**复制草稿再粘回来不退化**：官方把胶囊复制成 `clipboardText`（就是 `@"路径"` 那段文字），粘回来只是一段文字 —— 胶囊会变成路径符号。本插件在 `paste` 的 capture 阶段认出「带图片扩展名的 `@路径`」，自己按原顺序把文字与胶囊拼回去（文字走 `insertText`，胶囊走 `insertReference`，两条 API 插入后光标都落在后面，所以逐段重取 caret 即可）。只在这类粘贴上接管：普通文字、`@notes.txt` 这种非图片引用都照旧交给官方。

> 代价：这类粘贴走的是纯文本重建，富文本格式（加粗等）不会保留 —— 前提是这一段里真有图片引用。

## 两条路

**① 有真实路径（桌面端拖入 / 选择器）** —— 不改官方代码，只把 File 的 MIME「降级」：

官方 `dsh-client-ui-conversation` 里这条判断决定分流：

```js
if (path === "" || !directory && isImageMediaType(file.type)) uploads.push(file)
```

而引用分支最后落在 `insertFileReferences()`，**插在实时选区（光标）之后**。所以只要在 `drop`/`paste`/`change` 的 capture 阶段把这个 File 的 `type` 抹成 `application/octet-stream`，官方自己就走引用分支 —— 光标定位、前导空格、撤销历史、忙碌态拒绝、`@路径` 格式化全是官方那份实现。

**② 没有真实路径（剪贴板里的截图/位图）** —— 得先有文件。客户端 Remote 通道（`workspaceFiles`）只读，所以本插件带一个 Host 半：

```http
POST /dsh-inline-image/save?name=<文件名>&sessionId=<会话 id>   ← 请求体就是文件字节
→ { ok: true, value: { path, name, originalName, dir } }
```

落点照 WorkBuddy 那套（它的目录叫 `workbuddy-image-chip-preview`）：

```
%TEMP%\dsh-inline-image\<sha256 前 2 位>\<名字>-<sha256 前 16 位>.<ext>
```

- **内容寻址**：同图重复粘贴必然同一路径，只刷新 mtime，不多占磁盘；
- **24 小时 TTL**：每次保存顺手扫一遍，超期的旧图删掉（与 WorkBuddy 的 `TEMP_IMAGE_TTL_MS = 864e5` 同款）；
- 不往项目里写任何东西；单文件上限 32MB。

然后客户端用输入机的 `caretSpan()` + `insertReference()` 在光标处插 `@<绝对路径>` 胶囊（标签仍显示原始文件名）。落盘或插入失败时退回原生附件管线，不丢用户的文件。

DSH 的 fs 沙箱对**读**不设限、对**写**允许工作区与平台临时根，所以模型按这个路径读图是合法的。

取缩略图字节用 `remote.workspaceFiles.readBytes(sessionId, 绝对路径)`，不另建读路由。

> 代价：临时文件 24 小时后会被清掉 —— 隔天再让模型"看下那张图"就会报文件不存在。需要长期可变现的图，请把它拖进工作区再从资源管理器拖入（那条走 `@原路径`，不受 TTL 影响）。

## 安装

`~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "dsh-inline-image-ref": "link:D:/Plugins/dsh-inline-image-ref" },
  "dsh": { "profile": { "bundles": [ "…", "dsh-inline-image-ref" ] } }
}
```

并在 `node_modules` 建同目录 Junction。**改完要重启宿主**（客户端 bundle 在启动时聚合，只有 Client 半的插件也一样）。

## 已知限制

- **文件名 → 绝对路径**靠插件插入时记下的表（`localStorage["dsh-inline-image/labels/v1"]`，最多 300 条）。不同目录下的同名图片会互相覆盖，只有最后一张能预览。
- 引用胶囊 DOM 上没有路径（Lexical 装饰节点只带 `title`），所以**本插件没经手的** `@图片`（例如手打路径、或由别的插件插入）不会预览。
- 预览要图片还在原地：`%TEMP%` 那份 24 小时后会被清，工作区/原路径那份不受影响；文件没了只显示「读不到这张图」。
- 图片交给模型的仍然是「路径引用」而不是图片字节：文本模型要自己读，多模态模型也不会自动把图塞进上下文 —— 这是「按文件处理」的代价。

## 回归

```powershell
node tests/inline-image/run.cjs   # 50 条（客户端，需要 playwright/chromium）
node tests/host-route.test.cjs      # 14 条（宿主路由）
node _publish-smoke.mjs              # 19 条（发布自检，纯 node）
```

21 条断言：拖放/粘贴的 MIME 降级（含「无路径保持原样」「普通文件不动」）、记忆表、悬停浮层的生成与收起、输入框外/非图片不触发、缺 Remote 时 fail-open、卸载无残留。
