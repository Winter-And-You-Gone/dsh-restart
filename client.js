// dsh-restart: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。
//
// 功能：侧栏左下角账户行（用户名右侧、更新按钮出现的位置）加一个无边框的
// 纯线条「重启」图标按钮（无文字，悬停有 tooltip），让整个桌面应用一键重启：
//   1. 第一次点击进入确认态（图标变琥珀色，3 秒未再点自动复位，防误触）；
//   2. 再点一次 → POST /dsh-revive（host 先拉起脱离的复活进程，再请求宿主退出，
//      桌面应用随之退出并被复活进程重新拉起）；当前会话会断开，属预期。
//      发起后图标变成循环箭头并持续旋转表示"重启中"。
//   3. 若当前会话的 agent 正在运行（回合未结束），host 会写入"续跑标记"，
//      重启后自动向该会话发"继续"接着跑。
//
// Bundle 格式遵循 DSH client 模块系统：window.__ModuleLoader__.load({id, factory})。
// 纯浏览器 bundle：仅在 window 存在时注册。host（Node）进程若误导入本文件
// 应静默跳过，而不是抛 ReferenceError 拖垮整个插件树。
if (typeof window !== "undefined" && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
	id: "dsh-restart",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ---- React ----
		var react = require("react");
		var reactDom = require("react-dom");

		// ---- 注入样式 ----
		// 无边框图标按钮：静止时只有线条图标、完全跟随文字色（无自带颜色）；
		// 悬停淡显底色提示可点；armed 琥珀色 = 待确认；重启中换成循环箭头并旋转；error 红色 = 重启失败。
		var CSS_ID = "dsh-restart/style";
		if (typeof document !== "undefined") {
			var cssText = [
				".dsr-revive{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:none;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:background .12s ease,color .12s ease}",
				".dsr-revive[data-compact]{width:36px;height:36px;border-radius:8px}",
				".dsr-revive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#e5e7eb)}",
				".dsr-revive:disabled{opacity:.5;cursor:default}",
				".dsr-revive[data-restarting]{opacity:1;cursor:default;color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
				".dsr-revive[data-armed]{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
				".dsr-revive[data-error]{color:var(--dsw-alias-state-critical-primary,#ef4444)}",
				".dsr-revive[data-restarting] svg{transform-origin:center;animation:dsr-revive-spin .8s linear infinite}",
				"@keyframes dsr-revive-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
				".dsr-account-host{display:contents}"
			].join("\n");
			var existingTag = document.querySelector('style[data-plugin-css="' + CSS_ID + '"]');
			if (existingTag === null) {
				var tag = document.createElement("style");
				tag.dataset.plugin = "dsh-restart";
				tag.dataset.pluginCss = CSS_ID;
				tag.textContent = cssText;
				document.head.appendChild(tag);
			} else {
				// 插件热更新时同步重写样式，避免旧尺寸规则残留。
				existingTag.textContent = cssText;
			}
		}

		// ---- 纯线条重启图标：电源符号（圆环+竖线，开关机隐喻，不会被误读成循环） ----
		// stroke 跟随 currentColor，无填充无自带颜色。按钮 44px 见方，图形本体 20px。
		function RestartIcon(props) {
			var size = props && props.size ? props.size : 24;
			return react.createElement(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				react.createElement("path", { d: "M18.36 6.64a9 9 0 1 1-12.73 0" }),
				react.createElement("line", { x1: "12", y1: "2", x2: "12", y2: "12" })
			);
		}

		// ---- 重启中：单箭头顺时针循环图标（一段圆弧 + 右上箭头，配合 CSS 顺时针旋转） ----
		// 第一次点击只是变琥珀色；第二次点击进入重启后换成这个图标并在原地循环旋转。
		function LoopIcon(props) {
			var size = props && props.size ? props.size : 20;
			return react.createElement(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				react.createElement("polyline", { points: "23 4 23 10 17 10" }),
				react.createElement("path", { d: "M20.49 15a9 9 0 1 1-2.12-9.36L23 10" })
			);
		}

		// ---- 一键复活按钮（左下角账户行，用户名右侧） ----
		// 无文字，仅图标；悬停 tooltip 说明用途。
		// 第一次点击进入确认态（图标变琥珀色，3 秒未再点自动复位），第二次点击真正执行：
		// POST /dsh-revive → host 先拉起脱离的复活进程，再请求宿主退出，
		// 桌面应用随之退出并被复活进程重新拉起。当前会话会断开，属预期。
		function ReviveButton(props) {
			var sessionId = props && props.sessionId;
			var compact = props && props.compact === true;
			var useState = react.useState;
			var useRef = react.useRef;
			var armedState = useState(false);
			var armed = armedState[0];
			var setArmed = armedState[1];
			var restartingState = useState(false);
			var restarting = restartingState[0];
			var setRestarting = restartingState[1];
			var errorState = useState(false);
			var error = errorState[0];
			var setError = errorState[1];
			var timerRef = useRef(null);
			var errorTimerRef = useRef(null);
			// 重启失败：红色提示 4 秒 + 控制台留痕，绝不静默复位。
			var showFailure = function (message) {
				setRestarting(false);
				setError(true);
				if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
				errorTimerRef.current = setTimeout(function () { setError(false); }, 4000);
				if (typeof console !== "undefined" && console.error) console.error("[dsh-restart] " + message);
			};
			var onClick = function () {
				if (restarting) return;
				if (!armed) {
					setArmed(true);
					if (timerRef.current !== null) clearTimeout(timerRef.current);
					timerRef.current = setTimeout(function () { setArmed(false); }, 3000);
					return;
				}
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				setArmed(false);
				setRestarting(true);
				var body = null;
				if (typeof sessionId === "string" && sessionId.length > 0) {
					body = JSON.stringify({ sessionId: sessionId, text: "继续" });
				}
				fetch("/dsh-revive", {
					method: "POST",
					headers: body !== null ? { "content-type": "application/json" } : undefined,
					body: body
				}).then(function (response) {
					if (response.ok) return; // 重启已发起，页面即将随应用退出
					response.text().catch(function () { return ""; }).then(function (detail) {
						// 常见于宿主尚未加载插件（刚装好还没完全重启应用）→ 路由 404。
						showFailure("POST /dsh-revive failed with HTTP " + response.status
							+ (detail ? ": " + detail : "") + "；若刚安装/改动宿主半边，请完全退出并重启一次桌面应用");
					});
				}).catch(function (err) {
					showFailure("POST /dsh-revive failed: " + String(err));
				});
			};
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dsr-revive",
					title: error
						? "重启失败（详情见控制台）；若刚安装插件，请完全退出并重启一次桌面应用"
						: "重启 DSH（应用插件改动后需要重启）",
					"aria-label": "重启 DSH",
					disabled: restarting,
					"data-compact": compact ? "true" : undefined,
					"data-armed": armed ? "true" : undefined,
					"data-error": error ? "true" : undefined,
					"data-restarting": restarting ? "true" : undefined,
					onClick: onClick
				},
				restarting
					? react.createElement(LoopIcon, { size: compact ? 18 : 20 })
					: react.createElement(RestartIcon, { size: compact ? 18 : 20 })
			);
		}

		// ---- 账户行（左下角用户名右侧）里的重启按钮 ----
		// 框架没有给账户行开放插槽，所以用 portal：在侧栏底部挂一个宿主节点，找到
		// settings.launcher 的锚点（账户菜单所在行），把宿主插到用户名右侧、连接/
		// 更新指示器之前——就是有更新时「安装并重启」按钮出现的那一列。
		// 宿主被 React 重渲染挤掉时用 MutationObserver 自动补挂。
		// 侧栏收起成窄条时账户行只有 36px，按钮退回底部动作区，避免挤爆布局。
		function AccountRowRevive(props) {
			var wide = props && props.wide !== false;
			var useSessions = props && props.useSessions;
			var hostRef = react.useRef(null);
			var attachedState = react.useState(false);
			var attached = attachedState[0];
			var setAttached = attachedState[1];
			// 框架在 footer 动作槽里提供 useSessions（会话列表 + 主视图保留信息）；
			// 取主视图当前会话的 id，重启时才能写续跑标记。拿不到就退化为不续跑。
			var readSessions = typeof useSessions === "function"
				? useSessions
				: function (selector) { return selector({ byId: {} }); };
			var sessionId = readSessions(function (state) {
				for (var id in state.byId) {
					var row = state.byId[id];
					if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
				}
				return undefined;
			});
			react.useLayoutEffect(function () {
				var host = document.createElement("span");
				host.className = "dsr-account-host";
				hostRef.current = host;
				var place = function () {
					if (!host.isConnected) {
						var anchor = document.querySelector('[data-slot="settings.launcher"]');
						var row = anchor === null ? null : anchor.parentElement;
						if (row !== null) row.insertBefore(host, anchor.nextSibling);
					}
					var next = host.isConnected;
					setAttached(function (previous) { return previous === next ? previous : next; });
				};
				place();
				var observer = new MutationObserver(function () {
					if (!host.isConnected) place();
				});
				observer.observe(document.body, { childList: true, subtree: true });
				return function () {
					observer.disconnect();
					if (host.parentNode !== null) host.parentNode.removeChild(host);
				};
			}, []);
			var button = react.createElement(ReviveButton, { sessionId: sessionId, compact: !wide });
			if (!wide || !attached || reactDom === null || typeof reactDom.createPortal !== "function") return button;
			return reactDom.createPortal(button, hostRef.current);
		}

		// ---- Cordis 插件入口 ----
		// 挂到侧栏底部的追加动作槽（root 作用域、随侧栏常驻），组件内部再把按钮
		// portal 进账户行：用户名右侧，与「安装并重启」更新按钮同一列。
		exports.inject = ["slots"];
		exports.apply = function (ctx) {
			ctx.inject(["slots"], function (scope) {
				scope.slots.inject("sidebar.footer.action", function () {
					return scope.slots.register({
						name: "sidebar.footer.action",
						id: "dsh-revive",
						order: 90,
						label: "重启 DSH"
					}, AccountRowRevive);
				});
			});
		};

		return module.exports;
	}
});
}
