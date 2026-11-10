/**
 * dsh-inline-image —— 拖进输入框的图片，按「文件引用」处理（客户端半边）
 *
 * ── 要做的事 ──────────────────────────────────────────────────────────────
 *
 *  DSH 原生行为：桌面端拖入/粘贴带真实路径的**非图片**文件 → 在光标处插一颗
 *  `@相对路径` 引用胶囊；而**图片**一律进附件上传管线，在输入框上方多出一条
 *  附件栏。本插件把这条分叉掰直：带真实路径的图片也按文件走，别的都不变。
 *
 * ── 怎么做到「不改官方代码」────────────────────────────────────────────────
 *
 *  官方那条判断在 `dsh-client-ui-conversation` 的 `addFiles` 里：
 *
 *      if (path === "" || !directory && isImageMediaType(file.type)) uploads.push(file)
 *
 *  也就是「拿不到路径」或「MIME 是图片」→ 上传；否则 → `@路径` 引用，而且
 *  `insertFileReferences` 是**插在实时选区（光标）之后**的，正是我们要的位置。
 *
 *  所以只要在 drop / paste / 文件选择器这三次入口的 **capture 阶段**，把带真实
 *  路径的图片 File 的 `type` 抹成二进制 MIME，官方自己就会走引用分支：
 *  光标定位、前导空格、撤销历史、忙碌态拒绝、路径格式化全都是官方那份代码，
 *  本插件不复制任何一条。取不到真实路径的图（例如剪贴板截图）不动，照旧上传。
 *
 * ── 悬停看图 ──────────────────────────────────────────────────────────────
 *
 *  引用胶囊是 Lexical 的装饰节点，DOM 上只有 `title=文件名`，没有路径。所以
 *  插入前把「文件名 → 绝对路径」记进 localStorage，悬停时用 `title` 反查路径，
 *  再经 `remote.workspaceFiles.readBytes` 取字节、转 blob URL 显示成浮层。
 *  取字节不用自建 HTTP 路由：那条 Remote 通道本来就能读工作区外的绝对路径。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *
 *  1. fail-open：任何一环抛错都只是「没生效」，绝不影响拖放/粘贴本身。
 *  2. 不拦事件：capture 阶段只改 File 的属性，preventDefault/stopPropagation 一概不碰。
 *  3. 不碰官方 DOM：预览浮层是 body 上的独立节点，`pointer-events:none`。
 */
window.__ModuleLoader__.load({
	id: "dsh-inline-image-ref",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/** 只需要槽位（拿当前会话 id）与输入会话服务；Remote 通道懒取，缺了只降级预览。 */
		var inject = ["slots", "conversation", "sessions"];

		/** 「文件名 → 绝对路径」的存储键（JSON 对象，最多留 300 条）。 */
		var LABEL_KEY = "dsh-inline-image/labels/v1";
		/** 预览字节的缓存条数上限（超出按插入顺序淘汰并 revoke）。 */
		var CACHE_LIMIT = 24;
		/** 单张预览位图上限：再大就不读了，免得一次悬停吃掉几十兆。 */
		var MAX_BYTES = 24 * 1024 * 1024;
		/** 预览浮层的最宽/最高（px）。 */
		var PREVIEW_MAX = 320;
		/** 图片扩展名（MIME 为空时兜底判断，例如某些拖放源不给 type）。 */
		var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)$/i;
		/** 浮层节点的标记属性（同时也是 CSS 钩子）。 */
		var PREVIEW_ATTR = "data-dsh-inline-image-preview";
		/** 宿主落盘路由（没有 OS 路径的图片走它：先存成文件，才能变成 @路径 引用）。 */
		var SAVE_URL = "/dsh-inline-image/save";
		/** 长文本粘贴阈值（字符数）：达到就折成 .md 文件引用，而不是把几千字塞进输入框。 */
		var TEXT_FOLD_CHARS = 4000;
		/** 文本预览里最多显示多少字（多了在浮层里滚，别一次渲染几万字）。 */
		var TEXT_PREVIEW_CHARS = 1500;
		/** 文本预览浮层宽度（图片那套是 320）。 */
		var TEXT_PREVIEW_MAX = 460;
		/** 文本预览里 <pre> 的标记属性。 */
		var TEXT_ATTR = "data-dsh-inline-image-text";
		/** 转录里允许「仅凭文字」认出来的行内标签：段落/输入框根不算（它们的 textContent 可能正好是文件名）。 */
		var INLINE_TAGS = { SPAN: true, A: true, B: true, STRONG: true, EM: true, I: true, CODE: true };
		/** 草稿变化后多久检查一次「有没有裸的 @图片路径」——防抖，别每敲一个字都算。 */
		var RESTORE_DEBOUNCE_MS = 400;
		/** 每轮最多查多少个记过的名字（labels 记 300 条，从最近插入的开始倒着查）。 */
		var RESTORE_MAX_CANDIDATES = 50;

		/** 插件级状态：当前会话 id（由 dock 槽的桥组件写入）与宿主 ctx。 */
		var bridge = { ctx: null, sessionId: "" };
		/** 文件名 → 绝对路径。 */
		var labels = new Map();
		/** 绝对路径 → blob URL（预览缓存）。 */
		var urls = new Map();
		/** 当前显示的浮层与它所属的胶囊。 */
		var shown = null;
		/** 预览请求代次：悬停换了目标就丢弃旧结果。 */
		var seq = 0;

		/* ════════════════════════ 「文件名 → 路径」记忆 ════════════════════════ */

		function loadLabels() {
			try {
				var raw = window.localStorage.getItem(LABEL_KEY);
				if (raw === null || raw === "") return;
				var parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return;
				var keys = Object.keys(parsed);
				for (var i = 0; i < keys.length; i += 1) {
					var value = parsed[keys[i]];
					if (typeof value === "string" && value !== "") labels.set(keys[i], value);
				}
			} catch (error) {
				// 存储坏了就当没记忆，功能照常（只是没有悬停预览）
			}
		}

		function saveLabels() {
			try {
				var entries = Array.from(labels.entries());
				var start = Math.max(0, entries.length - 300);
				var plain = {};
				for (var i = start; i < entries.length; i += 1) plain[entries[i][0]] = entries[i][1];
				window.localStorage.setItem(LABEL_KEY, JSON.stringify(plain));
			} catch (error) {
				// 存不下就只在本次会话有效
			}
		}

		function remember(name, path) {
			if (typeof name !== "string" || name === "" || typeof path !== "string" || path === "") return;
			labels.set(name, path);
			saveLabels();
		}

		/* ═══════════════════ 第一件事：图片也走「@路径 引用」 ═══════════════════ */

		/** 桌面壳装的那座桥：`pathFor(file)` → 真实 OS 路径（Electron webUtils）。 */
		function hostPathOf(file) {
			try {
				var host = typeof globalThis !== "undefined" ? globalThis.__DSH_HOST_PATHS__ : void 0;
				if (host === void 0 || host === null || typeof host.pathFor !== "function") return "";
				return host.pathFor(file) || "";
			} catch (error) {
				return "";
			}
		}

		/** 是不是图片：先看 MIME（可信），MIME 空再看扩展名。 */
		function looksLikeImage(file) {
			if (file === null || file === void 0) return false;
			var type = typeof file.type === "string" ? file.type : "";
			if (type !== "") return type.indexOf("image/") === 0;
			return IMAGE_EXT.test(String(file.name || ""));
		}

		/**
		 * 把图片的 MIME 抹成二进制，让官方那条 `isImageMediaType(file.type)` 判断失手。
		 * `type` 是 File 原型上的 getter，实例上盖一个同名自有属性即可遮蔽它。
		 */
		function demoteToFile(file) {
			try {
				Object.defineProperty(file, "type", {
					value: "application/octet-stream",
					configurable: true,
					enumerable: false
				});
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 把这批 File 里「带真实路径的图片」就地降级成普通文件，并记下文件名→路径。
		 * 官方随后的 `addFiles` 就会把它们当普通文件走 `@路径` 引用分支。
		 */
		function demoteBatch(files) {
			if (files === null || files === void 0 || files.length === 0) return 0;
			var taken = 0;
			for (var i = 0; i < files.length; i += 1) {
				var file = files[i];
				if (file === null || file === void 0) continue;
				if (!looksLikeImage(file)) continue;
				var path = hostPathOf(file);
				if (path === "") continue;
				if (!demoteToFile(file)) continue;
				remember(file.name, path);
				taken += 1;
			}
			return taken;
		}

		/* ── 没有路径的图片（截图 / 位图）：落盘，再自己插 @路径 引用 ────────────── */

		/** 当前会话的输入机（插引用、读光标都要它）。拿不到返回 null。 */
		function resolveShell() {
			try {
				var ctx = bridge.ctx;
				if (ctx === null || bridge.sessionId === "") return null;
				var conversation = ctx.get("conversation");
				var actx = ctx.sessions.scope(bridge.sessionId);
				if (conversation === void 0 || conversation === null || actx === void 0) return null;
				if (typeof conversation.input !== "object" || conversation.input === null) return null;
				return conversation.input.for(actx) || null;
			} catch (error) {
				return null;
			}
		}

		/** 会话工作区根（把绝对路径说成相对路径用）。 */
		function sessionCwd() {
			try {
				var ctx = bridge.ctx;
				if (ctx === null) return "";
				var snapshot = ctx.sessions.list.getSnapshot();
				var entry = snapshot && snapshot.byId ? snapshot.byId[bridge.sessionId] : void 0;
				return entry !== void 0 && entry !== null && typeof entry.cwd === "string" ? entry.cwd : "";
			} catch (error) {
				return "";
			}
		}

		/** 工作区内的路径说成相对路径；工作区外原样保留。与官方同义。 */
		function relativize(text, cwd) {
			if (typeof cwd !== "string" || cwd === "") return text;
			var root = cwd.replace(/[/\\]+$/u, "");
			if (text.indexOf(root + "/") === 0 || text.indexOf(root + "\\") === 0) return text.slice(root.length + 1);
			return text;
		}

		/** 官方那套 mention 语法：带空白就加引号；含控制字符/双引号则无法表示。 */
		function mentionOf(relative) {
			if (/[\u0000-\u001f\u007f-\u009f"]/u.test(relative)) return null;
			if (!/\s/u.test(relative)) return "@" + relative;
			return '@"' + relative + '"';
		}

		var EXT_BY_MIME = {
			"image/png": ".png",
			"image/jpeg": ".jpg",
			"image/gif": ".gif",
			"image/webp": ".webp",
			"image/bmp": ".bmp",
			"image/avif": ".avif",
			"image/svg+xml": ".svg"
		};

		/** 粘贴出来的位图往往叫 image.png / blob，换成带时间戳的名字，免得满目录同名。 */
		function stampName(file) {
			var raw = typeof file.name === "string" ? file.name.trim() : "";
			if (raw !== "" && raw !== "blob" && !/^image\.(png|jpe?g|gif|webp)$/iu.test(raw)) return raw;
			var type = typeof file.type === "string" ? file.type : "";
			var ext = EXT_BY_MIME[type] !== void 0 ? EXT_BY_MIME[type] : ".png";
			var now = new Date();
			function pad(value) {
				return value < 10 ? "0" + value : String(value);
			}
			return "pasted-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + ext;
		}

		/** 把一张没有路径的图 POST 给宿主落盘，返回 { path, name } 或 null。 */
		function saveBytes(file) {
			var name = stampName(file);
			var url = SAVE_URL + "?name=" + encodeURIComponent(name) + "&sessionId=" + encodeURIComponent(bridge.sessionId);
			return fetch(url, {
				method: "POST",
				body: file,
				headers: { "content-type": typeof file.type === "string" && file.type !== "" ? file.type : "application/octet-stream" }
			})
				.then(function (response) {
					if (response.ok !== true) return null;
					return response.json();
				})
				.then(function (payload) {
					if (payload === null || payload === void 0 || payload.ok !== true) return null;
					return payload.value || null;
				})
				.catch(function () {
					return null;
				});
		}

		/**
		 * 读当前光标（detect 坐标 + draftRev）。插入前必须现取一次：
		 * 每插一段，草稿版本号就变了，旧 span 会被 CAS 拒绝。
		 */
		function caretSpanOf(shell) {
			try {
				var snap = shell.state !== void 0 && shell.state !== null && typeof shell.state.getSnapshot === "function" ? shell.state.getSnapshot() : shell.snapshot;
				var rev = snap !== void 0 && snap !== null && typeof snap.draftRev === "number" ? snap.draftRev : null;
				if (typeof shell.caretSpan === "function") {
					var caret = shell.caretSpan();
					return { draftRev: rev, start: caret.start, end: caret.end };
				}
				if (snap !== void 0 && snap !== null) {
					var at = typeof snap.draft === "string" ? snap.draft.length : 0;
					return { draftRev: rev, start: at, end: at };
				}
				return null;
			} catch (error) {
				return null;
			}
		}

		/** 在光标处插一颗引用胶囊。 */
		function insertChip(shell, label, mention) {
			try {
				var span = caretSpanOf(shell);
				if (span === null) return false;
				return shell.insertReference({
					source: "reference",
					ref: mention,
					label: label,
					appearance: "file",
					clipboardText: mention
				}, span) === true;
			} catch (error) {
				return false;
			}
		}

		/** 兜底：落盘或插入失败时，别把用户的东西弄丢，退回原生的附件管线。 */
		function attachNatively(files) {
			try {
				var shell = resolveShell();
				var ctx = bridge.ctx;
				if (shell === null || ctx === null) return;
				var conversation = ctx.get("conversation");
				if (conversation === void 0 || conversation === null || typeof conversation.createDrafts !== "function") return;
				var drafts = conversation.createDrafts(bridge.sessionId, files);
				shell.addAttachments(drafts.map(function (draft) {
					return draft.id;
				}));
			} catch (error) {
				/* 兜底也失败就只能算了 */
			}
		}

		/** 一批文件统一走「落盘 → 光标处插 @相对路径」，失败的单独退回原生附件。 */
		function runBatch(entries) {
			var shell = resolveShell();
			if (shell === null) {
				attachNatively(entries.map(function (entry) { return entry.file; }));
				return;
			}
			var cwd = sessionCwd();
			var index = 0;

			function insertOne(absolute, label, file) {
				remember(label, absolute);
				var mention = mentionOf(relativize(absolute, cwd));
				if (mention === null || !insertChip(shell, label, mention)) attachNatively([file]);
			}

			function next() {
				if (index >= entries.length) return;
				var entry = entries[index];
				index += 1;
				if (entry.path !== "") {
					insertOne(entry.path, entry.name !== "" ? entry.name : "file", entry.file);
					next();
					return;
				}
				saveBytes(entry.file).then(function (saved) {
					if (saved === null || typeof saved.path !== "string" || saved.path === "") {
						attachNatively([entry.file]);
					} else {
						var label = typeof saved.originalName === "string" && saved.originalName !== ""
							? saved.originalName
							: typeof saved.name === "string" && saved.name !== "" ? saved.name : entry.name;
						/* 落盘后的真名（带内容 hash）也记一份：悬停时两种标题都认得。 */
						if (typeof saved.name === "string" && saved.name !== "" && saved.name !== label) remember(saved.name, saved.path);
						insertOne(saved.path, label, entry.file);
					}
					next();
				});
			}

			next();
		}

		/* ── 三个入口：拖入 / 粘贴 / 文件选择器 ───────────────────────────────── */

		/** 是否必须我们接管：出现「图片但没有真实路径」才需要（其余交给官方，零改动）。 */
		function needsTakeover(files) {
			for (var i = 0; i < files.length; i += 1) {
				var file = files[i];
				if (file === null || file === void 0) continue;
				if (looksLikeImage(file) && hostPathOf(file) === "") return true;
			}
			return false;
		}

		function entriesOf(files) {
			var entries = [];
			var seen = Object.create(null);
			for (var i = 0; i < files.length; i += 1) {
				var file = files[i];
				if (file === null || file === void 0) continue;
				/* `.files` 与 `items[*].getAsFile()` 可能给出两个对象指向同一份剪贴板数据：
				   按「名字+大小+类型」去重，否则会插出两颗胶囊。 */
				var key = String(file.name || "") + "|" + String(file.size) + "|" + String(file.type || "");
				if (seen[key] === true) continue;
				seen[key] = true;
				entries.push({ file: file, name: typeof file.name === "string" ? file.name : "", path: hostPathOf(file) });
			}
			return entries;
		}

		function onDrop(event) {
			try {
				var transfer = event.dataTransfer;
				if (transfer === null || transfer === void 0) return;
				var files = Array.prototype.slice.call(transfer.files || []);
				if (files.length === 0) return;
				if (!needsTakeover(files)) {
					demoteBatch(files);
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				runBatch(entriesOf(files));
			} catch (error) {
				/* 观察者不许影响拖放 */
			}
		}

		function onPaste(event) {
			try {
				var clipboard = event.clipboardData;
				if (clipboard === null || clipboard === void 0) return;
				var files = Array.prototype.slice.call(clipboard.files || []);
				var items = clipboard.items;
				var itemFiles = [];
				if (items !== null && items !== void 0) {
					for (var i = 0; i < items.length; i += 1) {
						if (items[i].kind !== "file") continue;
						var file = items[i].getAsFile();
						if (file === null || file === void 0) continue;
						itemFiles.push(file);
						if (files.indexOf(file) < 0) files.push(file);
					}
				}
				var text = "";
				try {
					text = clipboard.getData("text/plain") || "";
				} catch (error) {
					text = "";
				}
				if (files.length === 0) {
					/* 纯文字粘贴，两条自己接管的路径：
					   ① 里面带着图片的 @路径（典型场景：「全选复制自己的草稿再粘回来」）→ 自己拼回胶囊；
					   ② 长文本（≥ TEXT_FOLD_CHARS）→ 折成 .md 文件引用，而不是把几千字塞进输入框。 */
					var plan = planTextPaste(text);
					if (plan !== null) {
						var shellForText = resolveShell();
						if (shellForText === null) return;
						event.preventDefault();
						event.stopImmediatePropagation();
						insertParts(shellForText, plan);
						return;
					}
					if (text.length >= TEXT_FOLD_CHARS) {
						var shellForFold = resolveShell();
						if (shellForFold === null) return;
						event.preventDefault();
						event.stopImmediatePropagation();
						foldTextToChip(shellForFold, text);
					}
					return;
				}
				if (!needsTakeover(files)) {
					/* 老路：降级即可，官方会插引用；items 里的对象与 .files 未必同一批，两边都摸。 */
					demoteBatch(files);
					if (itemFiles.length > 0) demoteBatch(itemFiles);
					return;
				}
				/* 剪贴板里同时有文字时不接管：那是「文字 + 图片」的组合粘贴，交回官方最稳。 */
				if (text.trim() !== "") return;
				event.preventDefault();
				event.stopImmediatePropagation();
				runBatch(entriesOf(files));
			} catch (error) {
				/* 同上 */
			}
		}

		/* ── 把「@图片路径」文本重新拼成胶囊（复制草稿再粘回来时不退化） ──────────── */

		/** 粘贴文本里的 @ 引用：带空白的路径是 `@"..."` 形式，其余是 `@path`。 */
		var MENTION_RE = /@(?:"([^"\n\r]*)"|([^\s@]+))/gu;

		/**
		 * 把这个路径对应的显示名找出来：优先用我们记过的名字（落盘名/原文件名），
		 * 否则退回路径最后一段 —— 和官方 chip 的 label 一致。
		 */
		function labelForPath(path) {
			var target = String(path).replace(/\\/gu, "/");
			var found = null;
			labels.forEach(function (known, name) {
				if (found !== null) return;
				var normalized = String(known).replace(/\\/gu, "/");
				if (normalized === target || normalized.slice(-(target.length + 1)) === "/" + target) found = name;
			});
			if (found !== null) return found;
			var parts = target.split("/");
			var last = parts[parts.length - 1];
			return last === "" ? path : last;
		}

		/**
		 * 把粘贴文本切成「文字 / 图片引用」片段；一个图片引用都没有就返回 null（不接管）。
		 * 判定只用扩展名：外观上就是「这段 @ 指向一张图」，不依赖文件是否还在。
		 */
		function planTextPaste(text) {
			if (typeof text !== "string" || text === "" || text.indexOf("@") < 0) return null;
			var parts = [];
			var last = 0;
			var found = false;
			MENTION_RE.lastIndex = 0;
			var match = MENTION_RE.exec(text);
			while (match !== null) {
				var quoted = typeof match[1] === "string";
				var path = quoted ? match[1] : match[2];
				var mention = match[0];
				if (IMAGE_EXT.test(path)) {
					if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
					parts.push({ kind: "chip", mention: mention, label: labelForPath(path) });
					found = true;
					last = match.index + mention.length;
				}
				match = MENTION_RE.exec(text);
			}
			if (!found) return null;
			if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
			return parts;
		}

		/**
		 * 按顺序把片段写进光标处：文字走 insertText，图片引用走 insertReference。
		 * 两个 API 插入后光标都落在插入内容之后，所以每步重取一次 caret 即可。
		 */
		function insertParts(shell, parts) {
			for (var i = 0; i < parts.length; i += 1) {
				var part = parts[i];
				var span = caretSpanOf(shell);
				if (span === null) return;
				if (part.kind === "text") {
					if (part.text === "") continue;
					shell.insertText(part.text, span);
					continue;
				}
				shell.insertReference({
					source: "reference",
					ref: part.mention,
					label: part.label,
					appearance: "file",
					clipboardText: part.mention
				}, span);
			}
		}

		/* ═════════ 第三件事：长文本粘贴 → 折成 .md 文件引用 ═════════
		 *
		 * 与「在输入框上方再画一条 chip」的做法不同：这里真的把这段文字落成文件，
		 * 再按图片那套插一颗 @路径 引用胶囊 —— 于是它和图片走同一条链路：
		 *   · 悬停 → 看里面的文字
		 *   · 点击 → 把文件内容写回输入框，胶囊消失（回到纯文本）
		 */

		/** 折叠文件名（宿主按内容寻址会加 -<sha16>，所以那一段是可选的）。 */
		var FOLDED_NAME_RE = /^pasted-text-\d+(?:-[0-9a-f]{16})?\.(?:md|markdown|txt|log|json|ya?ml|csv)$/iu;
		/** 文本内容缓存（悬停、点击都要用）。 */
		var textCache = new Map();
		/** 显示名 → { mention, path, text }：本会话折出来的那几颗。 */
		var textChips = new Map();
		/** 折叠文件名计数器。 */
		var textSeq = 0;

		/** 是不是我们折出来的那颗（页面重载后 textChips 会空，所以还要认文件名）。 */
		function isFoldedName(label) {
			return FOLDED_NAME_RE.test(String(label === null || label === void 0 ? "" : label));
		}

		function snapshotOf(shell) {
			try {
				return shell.state !== void 0 && shell.state !== null && typeof shell.state.getSnapshot === "function"
					? shell.state.getSnapshot()
					: shell.snapshot;
			} catch (error) {
				return void 0;
			}
		}

		/**
		 * 把一段长文本落成 .md 文件，再在光标处插一颗引用胶囊。
		 * 落盘或插入失败就把原文写回光标处 —— 绝不让用户粘进来的东西消失。
		 */
		function foldTextToChip(shell, text) {
			textSeq += 1;
			var name = "pasted-text-" + textSeq + ".md";
			var file = null;
			try {
				file = new File([text], name, { type: "text/markdown" });
			} catch (error) {
				file = null;
			}
			if (file === null) {
				var direct = caretSpanOf(shell);
				if (direct !== null) shell.insertText(text, direct);
				return;
			}
			saveBytes(file).then(function (saved) {
				var path = saved !== null && saved !== void 0 && typeof saved.path === "string" ? saved.path : null;
				var label = saved !== null && saved !== void 0 && typeof saved.name === "string" && saved.name !== "" ? saved.name : name;
				var span = caretSpanOf(shell);
				if (path === null) {
					if (span !== null) shell.insertText(text, span);
					return;
				}
				remember(label, path);
				textCache.set(path, text);
				var mention = mentionOf(relativize(path, sessionCwd()));
				if (mention === null || !insertChip(shell, label, mention)) {
					var back = caretSpanOf(shell);
					if (back !== null) shell.insertText(text, back);
					return;
				}
				textChips.set(label, { mention: mention, path: path, text: text });
			});
		}

		/** 读文本文件内容：先查缓存，没有再走 Remote 读字节并 UTF-8 解码。 */
		function readTextFor(path) {
			if (textCache.has(path)) return Promise.resolve(textCache.get(path));
			if (bridge.sessionId === "") return Promise.resolve(null);
			var remote = remoteFace();
			if (remote === null) return Promise.resolve(null);
			return Promise.resolve(remote.readBytes(bridge.sessionId, path, {}, void 0))
				.then(function (result) {
					if (result === null || result === void 0 || result.ok !== true) return null;
					var value = result.value || {};
					var data = value.data;
					var bytes = data instanceof Uint8Array ? data : data && data.buffer ? new Uint8Array(data) : null;
					if (bytes === null || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
					var text = new TextDecoder("utf-8").decode(bytes);
					textCache.set(path, text);
					return text;
				})
				.catch(function () {
					return null;
				});
		}

		/** 一颗胶囊对应的折叠条目；认不出（不是我们折的）就返回 null。 */
		function foldedEntryFor(chip) {
			var label = chip.getAttribute("title");
			if (label === null || label === "") label = String(chip.textContent || "").trim();
			if (label === "") return null;
			var known = textChips.get(label);
			if (known !== void 0) return known;
			if (!isFoldedName(label)) return null;
			var path = labels.get(label);
			if (path === void 0) return null;
			return { mention: null, path: path, text: null, label: label };
		}

		/**
		 * 找出那颗胶囊在 detect 坐标里的位置（胶囊在 detect 里只占 1 个字符）。
		 *
		 * 换算依据官方投影：每颗更早的胶囊在 clipboard 投影里占 `length` 个字符、在 detect 里占 1 个，
		 * 所以第 k 颗的 detect 起点 = 它的 clipboard 偏移 − 前面所有胶囊的 (length − 1) 之和。
		 * 用 clipboard 偏移直接当 detect 跨度，是第三方插件踩过的坑（第二颗起就静默失效）。
		 */
		function detectSpanOfEntry(shell, entry) {
			var snap = snapshotOf(shell);
			var rev = snap !== void 0 && snap !== null && typeof snap.draftRev === "number" ? snap.draftRev : null;
			if (rev === null) return null;
			var projection = shell.projection;
			if (projection === null || projection === void 0) return null;
			var occurrences = Array.isArray(projection.occurrences) ? projection.occurrences : null;
			if (occurrences === null) return null;
			var detect = typeof projection.detectText === "string" ? projection.detectText : null;
			var delta = 0;
			for (var i = 0; i < occurrences.length; i += 1) {
				var occurrence = occurrences[i];
				if (occurrence === null || occurrence === void 0) continue;
				var offset = typeof occurrence.offset === "number" ? occurrence.offset : 0;
				var length = typeof occurrence.length === "number" ? occurrence.length : 0;
				var start = offset - delta;
				var hit =
					entry.mention !== null && entry.mention !== void 0
						? occurrence.ref === entry.mention
						: occurrence.label === entry.label;
				if (hit === true) {
					var end = start + 1;
					/* 官方插胶囊时会补一个空格，展开时顺手吃掉，免得留下一颗孤零零的空格。 */
					if (detect !== null && detect.slice(end, end + 1) === " ") end += 1;
					return { draftRev: rev, start: start, end: end };
				}
				delta += Math.max(0, length - 1);
			}
			return null;
		}

		/** 点击折叠胶囊 → 把文件内容写回输入框（胶囊消失，回到纯文本）。 */
		function expandFoldedChip(entry, shell) {
			readTextFor(entry.path).then(function (text) {
				if (typeof text !== "string" || text === "") return;
				var span = detectSpanOfEntry(shell, entry);
				if (span === null) return;
				if (shell.insertText(text, span) !== true) return;
				textChips.delete(entry.label);
				/* 胶囊节点被整颗换掉了，mouseout 再也不会派发到它身上 —— 这里必须自己收浮层。 */
				hidePreview();
			});
		}

		function onClick(event) {
			try {
				var target = event.target;
				if (!(target instanceof Element)) return;
				var chip = target.closest("[data-composer-chip]");
				if (chip === null || chip === void 0) return;
				if (!inPreviewZone(chip)) return;
				var entry = foldedEntryFor(chip);
				if (entry === null) return;
				var shell = resolveShell();
				if (shell === null) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				/* 先收浮层：展开是异步的（要读文件），而胶囊一旦被替换，它自己就再也收不到 mouseout 了。 */
				hidePreview();
				expandFoldedChip(entry, shell);
			} catch (error) {
				/* 点击不许出戏 */
			}
		}

		/** 文本预览浮层：显示这段文字的开头（可滚，标出总字数）。 */
		function showTextPreview(chip, path, label) {
			hidePreview();
			ensureStyle();
			var mine = ++seq;
			var popover = document.createElement("div");
			popover.setAttribute(PREVIEW_ATTR, "");
			popover.setAttribute(TEXT_ATTR, "");
			var caption = document.createElement("div");
			caption.setAttribute("data-dsh-inline-image-caption", "");
			caption.textContent = "载入中… " + label;
			popover.appendChild(caption);
			document.body.appendChild(popover);
			place(popover, chip, TEXT_PREVIEW_MAX);
			shown = { chip: chip, popover: popover, path: path };
			readTextFor(path).then(function (text) {
				if (mine !== seq || shown === null || shown.popover !== popover) return;
				if (typeof text !== "string") {
					caption.textContent = "读不到这段文字：" + label;
					return;
				}
				var pre = document.createElement("pre");
				pre.setAttribute(TEXT_ATTR, "");
				pre.textContent =
					text.length > TEXT_PREVIEW_CHARS ? text.slice(0, TEXT_PREVIEW_CHARS) + "\n…（后面还有 " + (text.length - TEXT_PREVIEW_CHARS) + " 字）" : text;
				popover.insertBefore(pre, caption);
				caption.textContent = label + " · " + text.length + " 字";
				place(popover, chip, TEXT_PREVIEW_MAX);
			});
		}

		/* ═════════ 第四件事：把草稿里「裸的 @图片路径」还原成胶囊 ═════════
		 *
		 * 为什么需要：回退对话（dsh-rewind-plugin）是通过 `setDraft(纯文本)` 把草稿写回去的 ——
		 * 它只恢复文字（的剪贴板投影）和图片附件，**不恢复引用胶囊**。于是回退后那些图就成了
		 * `@路径` 纯文本。
		 *
		 * 判据很干净：胶囊在 detect 投影里只占 1 个字符（U+FFFC），所以「这段 mention 文字出现在
		 * detect 文本里」本身就是「它是裸文本、不是胶囊」的证据。找到就按同一套坐标把那段文字换成胶囊。
		 */

		/** 从 labels 表倒着取最近插入的一批「标签 → mention」候选（重启后也能重建）。 */
		function mentionCandidates() {
			var cwd = sessionCwd();
			var keys = [];
			labels.forEach(function (path, label) {
				keys.push({ label: label, path: path });
			});
			var out = [];
			for (var i = keys.length - 1; i >= 0 && out.length < RESTORE_MAX_CANDIDATES; i -= 1) {
				var entry = keys[i];
				if (!IMAGE_EXT.test(entry.path) && !isFoldedName(entry.label)) continue;
				var mention = mentionOf(relativize(entry.path, cwd));
				if (mention === null) continue;
				out.push({ label: entry.label, mention: mention });
			}
			return out;
		}

		/** 一轮检查：把第一处裸 mention 换成胶囊（改完 rev 会变，下一轮接着处理其它）。 */
		function restoreBareMentions(shell) {
			try {
				var snap = snapshotOf(shell);
				var rev = snap !== void 0 && snap !== null && typeof snap.draftRev === "number" ? snap.draftRev : null;
				if (rev === null) return;
				var projection = shell.projection;
				var detect = projection !== null && projection !== void 0 && typeof projection.detectText === "string" ? projection.detectText : null;
				if (detect === null || detect === "") return;
				var candidates = mentionCandidates();
				for (var i = 0; i < candidates.length; i += 1) {
					var candidate = candidates[i];
					var at = detect.indexOf(candidate.mention);
					if (at < 0) continue;
					/* 必须是完整的 mention token：前后不能还粘着别的路径字符（否则可能只截了一段）。 */
					var before = at === 0 ? "" : detect.charAt(at - 1);
					if (before !== "" && !/[\s(（[【,，、:：]/u.test(before)) continue;
					var after = detect.charAt(at + candidate.mention.length);
					if (after !== "" && !/[\s)）\]】,，。、;；:：]/u.test(after)) continue;
					var applied = shell.insertReference(
						{
							source: "reference",
							ref: candidate.mention,
							label: candidate.label,
							appearance: "file",
							clipboardText: candidate.mention
						},
						{ draftRev: rev, start: at, end: at + candidate.mention.length }
					);
					if (applied === true) return;
				}
			} catch (error) {
				/* 观察者不许影响编辑 */
			}
		}

		/** 草稿一变就（防抖地）检查一次；暂停期间不动，免得跟输入法/播放动画打架。 */
		var restoreTimer = null;
		var restoreObserver = null;

		function scheduleRestore() {
			if (restoreTimer !== null) return;
			restoreTimer = setTimeout(function () {
				restoreTimer = null;
				var shell = resolveShell();
				if (shell !== null) restoreBareMentions(shell);
			}, RESTORE_DEBOUNCE_MS);
		}

		/** 📎 文件选择器：change 也是同一个 addFiles 入口，同样处理。 */
		function onChange(event) {
			try {
				var target = event.target;
				if (target === null || target === void 0) return;
				if (target.tagName !== "INPUT" || target.type !== "file") return;
				var files = Array.prototype.slice.call(target.files || []);
				if (files.length === 0) return;
				if (!needsTakeover(files)) {
					demoteBatch(files);
					return;
				}
				runBatch(entriesOf(files));
			} catch (error) {
				/* 同上 */
			}
		}

		/* ═══════════════════════ 第二件事：悬停看这张图 ═══════════════════════ */

		/** Remote 通道懒取：注入面可能叫三种名字，挨个试。 */
		function remoteFace() {
			var ctx = bridge.ctx;
			if (ctx === null) return null;
			try {
				if (typeof ctx.get === "function") {
					var direct = ctx.get("remote.workspaceFiles");
					if (direct !== void 0 && direct !== null && typeof direct.readBytes === "function") return direct;
					var remote = ctx.get("remote");
					if (remote !== void 0 && remote !== null && remote.workspaceFiles && typeof remote.workspaceFiles.readBytes === "function") {
						return remote.workspaceFiles;
					}
				}
				if (ctx.remote !== void 0 && ctx.remote !== null && ctx.remote.workspaceFiles) {
					var lazy = ctx.remote.workspaceFiles;
					if (lazy && typeof lazy.readBytes === "function") return lazy;
				}
			} catch (error) {
				return null;
			}
			return null;
		}

		function mimeOf(path) {
			var ext = String(path).toLowerCase().replace(/^.*\./u, "");
			if (ext === "png") return "image/png";
			if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
			if (ext === "gif") return "image/gif";
			if (ext === "webp") return "image/webp";
			if (ext === "bmp") return "image/bmp";
			if (ext === "avif") return "image/avif";
			if (ext === "svg") return "image/svg+xml";
			if (ext === "ico") return "image/x-icon";
			if (ext === "tif" || ext === "tiff") return "image/tiff";
			return "application/octet-stream";
		}

		/** 取一张图的 blob URL（带缓存；失败返回 null）。 */
		function blobUrlFor(path) {
			var cached = urls.get(path);
			if (cached !== void 0) return Promise.resolve(cached);
			if (bridge.sessionId === "") return Promise.resolve(null);
			var remote = remoteFace();
			if (remote === null) return Promise.resolve(null);
			return Promise.resolve(remote.readBytes(bridge.sessionId, path, {}, void 0))
				.then(function (result) {
					if (result === null || result === void 0 || result.ok !== true) return null;
					var value = result.value || {};
					var data = value.data;
					var bytes = data instanceof Uint8Array ? data : data && data.buffer ? new Uint8Array(data) : null;
					if (bytes === null || bytes.length === 0 || bytes.length > MAX_BYTES) return null;
					var url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
					if (urls.size >= CACHE_LIMIT) {
						var oldest = urls.keys().next();
						if (oldest.done !== true) {
							var stale = urls.get(oldest.value);
							if (stale !== void 0) URL.revokeObjectURL(stale);
							urls.delete(oldest.value);
						}
					}
					urls.set(path, url);
					return url;
				})
				.catch(function () {
					return null;
				});
		}

		function ensureStyle() {
			if (typeof document === "undefined") return;
			var id = "dsh-inline-image/preview.css";
			if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return;
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-inline-image";
			tag.dataset.pluginCss = id;
			tag.textContent = [
				"[" + PREVIEW_ATTR + "]{",
				"position:fixed;z-index:2147482000;pointer-events:none;box-sizing:border-box;",
				"max-width:" + PREVIEW_MAX + "px;padding:6px;border-radius:10px;",
				"background:var(--dsw-alias-bg-elevated,#26262a);",
				"box-shadow:0 10px 28px rgba(0,0,0,.38);",
				"border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));",
				"font:12px/1.4 system-ui,'Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-secondary,#b8b8c0);",
				"display:flex;flex-direction:column;gap:4px;",
				"}",
				"[" + PREVIEW_ATTR + "] img{display:block;max-width:" + PREVIEW_MAX + "px;max-height:" + PREVIEW_MAX + "px;border-radius:6px;object-fit:contain;}",
				"[" + PREVIEW_ATTR + "][" + TEXT_ATTR + "]{max-width:" + TEXT_PREVIEW_MAX + "px;}",
				"[" + PREVIEW_ATTR + "] pre[" + TEXT_ATTR + "]{margin:0;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;",
				"font:12px/1.5 ui-monospace,Consolas,'Cascadia Mono',monospace;color:var(--dsw-alias-label-primary,#e6e6ea);}",
				"[" + PREVIEW_ATTR + "] [data-dsh-inline-image-caption]{max-width:" + PREVIEW_MAX + "px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}"
			].join("");
			document.head.appendChild(tag);
		}

		function hidePreview() {
			if (shown === null) return;
			if (shown.popover.parentNode !== null) shown.popover.parentNode.removeChild(shown.popover);
			shown = null;
		}

		/** 贴着胶囊放：优先上方，上方空间不够就放下方，左右贴边钳制。 */
		function place(popover, chip, maxWidth) {
			try {
				var rect = chip.getBoundingClientRect();
				var width =
					typeof maxWidth === "number"
						? Math.min(maxWidth + 12, Math.max(160, window.innerWidth - 24))
						: Math.min(PREVIEW_MAX + 12, Math.max(120, rect.width + 24));
				var left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
				popover.style.left = Math.round(left) + "px";
				popover.style.maxWidth = Math.round(width) + "px";
				if (rect.top > 260) {
					popover.style.top = Math.round(rect.top - 8) + "px";
					popover.style.transform = "translateY(-100%)";
				} else {
					popover.style.top = Math.round(rect.bottom + 8) + "px";
					popover.style.transform = "none";
				}
			} catch (error) {
				/* 定位失败就让它待在左上角，看得见就行 */
			}
		}

		function showPreview(chip, path, label) {
			hidePreview();
			ensureStyle();
			var mine = ++seq;
			var popover = document.createElement("div");
			popover.setAttribute(PREVIEW_ATTR, "");
			var caption = document.createElement("div");
			caption.setAttribute("data-dsh-inline-image-caption", "");
			caption.textContent = "载入中… " + label;
			popover.appendChild(caption);
			document.body.appendChild(popover);
			place(popover, chip);
			shown = { chip: chip, popover: popover, path: path };
			blobUrlFor(path).then(function (url) {
				if (mine !== seq || shown === null || shown.popover !== popover) return;
				if (url === null) {
					caption.textContent = "读不到这张图：" + label;
					return;
				}
				var image = document.createElement("img");
				image.setAttribute("alt", label);
				image.addEventListener("load", function () {
					if (shown !== null && shown.popover === popover) place(popover, chip);
				});
				image.src = url;
				popover.insertBefore(image, caption);
				caption.textContent = label;
			});
		}

		/* ── 悬停命中：输入框里的胶囊 + 发出去的消息里那颗蓝色链接 ─────────────── */

		/** 允许弹预览的区域：输入框，以及聊天转录（发出去的消息）。 */
		var ZONE_SELECTOR = "[data-composer-card],[data-composer-input],[data-chat-flow],[data-chat-column],[data-chat-turn]";

		function inPreviewZone(node) {
			try {
				return node.closest(ZONE_SELECTOR) !== null;
			} catch (error) {
				return false;
			}
		}

		/** 整段内容就是一个 @图片路径（`@path` / `@"带空格的 path"`）时返回路径。 */
		function mentionPathOf(text) {
			var trimmed = String(text === null || text === void 0 ? "" : text).trim();
			var match = /^@(?:"([^"\n\r]*)"|([^\s@]+))$/u.exec(trimmed);
			if (match === null) return null;
			var path = typeof match[1] === "string" ? match[1] : match[2];
			return IMAGE_EXT.test(path) ? path : null;
		}

		/**
		 * 不带 `@` 的裸路径（有的引用渲染会把完整路径放进 title）。
		 * 必须带路径分隔符 —— 只是「a.png」这种纯文件名交给名字表处理，免得误判普通文字。
		 */
		function barePathOf(text) {
			var trimmed = String(text === null || text === void 0 ? "" : text).trim();
			if (trimmed === "" || trimmed.length > 400) return null;
			if (trimmed.charAt(0) === "@" || trimmed.indexOf("\n") >= 0) return null;
			if (!/[\\/]/u.test(trimmed)) return null;
			return IMAGE_EXT.test(trimmed) ? trimmed : null;
		}

		/**
		 * 从 DOM 节点身上认出「这指向哪张图」。三条来源，按可信度排：
		 *  1. `title` 命中我们记过的名字 → 输入框里的胶囊就是这种；
		 *  2. `title` 本身就是一个 @路径；
		 *  3. 节点文本本身就是一个 @路径 → 发出去的消息里那颗蓝色链接是这种。
		 */
		function pathOfNode(node) {
			var title = node.getAttribute("title");
			if (title !== null && title !== "") {
				if (labels.has(title)) return { path: labels.get(title), label: title };
				var fromTitle = mentionPathOf(title) || barePathOf(title);
				if (fromTitle !== null) return { path: fromTitle, label: labelForPath(fromTitle) };
			}
			var text = String(node.textContent || "").trim();
			if (text !== "") {
				if (labels.has(text)) return { path: labels.get(text), label: text };
				var fromText = mentionPathOf(text);
				if (fromText !== null) return { path: fromText, label: labelForPath(fromText) };
			}
			return null;
		}

		function onOver(event) {
			try {
				var target = event.target;
				if (!(target instanceof Element)) return;
				var node = target;
				var found = null;
				/* 命中规则收紧过一次（用户反馈：鼠标在图标右边一段距离也会弹浮层）：
				      · 输入框里**只认胶囊自己**（[data-composer-chip] 的宿元素）。以前靠「这段文字正好
				        等于文件名」兜底，于是一整行/整个输入框根（它的 textContent 恰好就是那颗胶囊的
				        名字加个空格）也会命中 —— 悬停在旁边空白处就弹了。
				      · 转录里的蓝色链接没有这个标记，才退回「叶子行内元素 + 整段就是一个 @路径」。 */
				for (var depth = 0; depth < 4 && node !== null && node !== void 0; depth += 1) {
					if (!inPreviewZone(node)) return;
					var chip = node.closest("[data-composer-chip]");
					if (chip !== null && chip !== void 0) {
						found = pathOfNode(chip);
						if (found !== null) {
							node = chip;
							break;
						}
					}
					/* 转录区放宽一点：那边的链接可能是 div/span 包着图标，只要是叶子节点且整段就是一个
					   引用就认（这正是用户要的「发出去的消息里也能看」）。输入框里则只认胶囊标记。 */
					var inTranscript = node.closest("[data-chat-turn],[data-chat-flow]") !== null;
					if (node.childElementCount === 0 && (INLINE_TAGS[node.tagName] === true || inTranscript)) {
						found = pathOfNode(node);
						if (found !== null) break;
					}
					node = node.parentElement;
				}
				if (found === null || node === null || node === void 0) return;
				if (shown !== null && shown.chip === node) return;
				if (IMAGE_EXT.test(found.path)) showPreview(node, found.path, found.label);
				else if (isFoldedName(found.label)) showTextPreview(node, found.path, found.label);
			} catch (error) {
				/* 悬停不许出戏 */
			}
		}

		function onOut(event) {
			try {
				if (shown === null) return;
				var target = event.target;
				if (!(target instanceof Element)) return;
				if (!shown.chip.contains(target)) return;
				var next = event.relatedTarget;
				/* 内部挪动（胶囊里还有 label span）或移到浮层上都不算离开。 */
				if (next instanceof Node && (shown.chip.contains(next) || shown.popover.contains(next))) return;
				hidePreview();
			} catch (error) {
				/* 同上 */
			}
		}

		/**
		 * 滚动时**跟着走**，不要一滚就关：转录区在流式输出时一直在自己滚，
		 * 「一滚就收」等于「永远看不到」（实测过，浮层被瞬间收掉）。
		 * 只有胶囊自己没了或滚出视口才收。
		 */
		function onScroll() {
			try {
				if (shown === null) return;
				var chip = shown.chip;
				if (chip.isConnected !== true) {
					hidePreview();
					return;
				}
				var rect = chip.getBoundingClientRect();
				if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
					hidePreview();
					return;
				}
				place(shown.popover, chip);
			} catch (error) {
				hidePreview();
			}
		}

		/** Esc 收起（别的按键不动，用户可能正要在输入框里打字）。 */
		function onKeydown(event) {
			if (event !== null && event !== void 0 && event.key === "Escape") hidePreview();
		}

		/* ════════════════════════════ 会话桥 ════════════════════════════ */

		/** 挂在输入框 dock 槽上的隐形组件：唯一目的是拿到当前会话 id（预览取字节要用）。 */
		function SessionBridge(props) {
			var sessionId = props && typeof props.sessionId === "string" ? props.sessionId : "";
			react.useEffect(function () {
				bridge.sessionId = sessionId;
				return function () {
					bridge.sessionId = "";
					hidePreview();
				};
			}, [sessionId]);
			return null;
		}

		/* ════════════════════════════ 生命周期 ════════════════════════════ */

		function apply(ctx) {
			bridge.ctx = ctx;
			loadLabels();

			ctx.effect(function () {
				if (typeof document === "undefined") return function () {};
				document.addEventListener("drop", onDrop, true);
				document.addEventListener("paste", onPaste, true);
				document.addEventListener("change", onChange, true);
				document.addEventListener("mouseover", onOver, true);
				document.addEventListener("mouseout", onOut, true);
				document.addEventListener("click", onClick, true);
				window.addEventListener("scroll", onScroll, true);
				document.addEventListener("keydown", onKeydown, true);
				/* 草稿一变就可能出现「裸 @图片路径」（回退对话、恢复草稿的典型结果）：盯 DOM 变动，
				   防抖之后把那处文字换回胶囊。固定间隔触发（不重置计时器），连续打字也不会饿死它。 */
				if (typeof MutationObserver === "function" && typeof document.body !== "undefined" && document.body !== null) {
					restoreObserver = new MutationObserver(scheduleRestore);
					restoreObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
					scheduleRestore();
				}
				return function () {
					document.removeEventListener("drop", onDrop, true);
					document.removeEventListener("paste", onPaste, true);
					document.removeEventListener("change", onChange, true);
					document.removeEventListener("mouseover", onOver, true);
					document.removeEventListener("mouseout", onOut, true);
					document.removeEventListener("click", onClick, true);
					window.removeEventListener("scroll", onScroll, true);
					document.removeEventListener("keydown", onKeydown, true);
					if (restoreObserver !== null) {
						restoreObserver.disconnect();
						restoreObserver = null;
					}
					if (restoreTimer !== null) {
						clearTimeout(restoreTimer);
						restoreTimer = null;
					}
					hidePreview();
					urls.forEach(function (url) {
						try {
							URL.revokeObjectURL(url);
						} catch (error) {
							/* 忽略 */
						}
					});
					urls.clear();
				};
			}, "dsh-inline-image: drop/paste demotion + hover preview");

			ctx.effect(function () {
				return ctx.slots.inject("conversation.input.dock", function () {
					return ctx.slots.register(
						{
							name: "conversation.input.dock",
							id: "dsh-inline-image-bridge",
							order: 900,
							inject: function (sessionId) {
								return typeof sessionId === "string" && sessionId !== "" ? { sessionId: sessionId } : {};
							}
						},
						SessionBridge
					);
				});
			}, "dsh-inline-image: session bridge");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
