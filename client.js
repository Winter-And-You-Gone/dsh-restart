// dsh-restart: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。
//
// 功能：会话头部加一个无边框的纯线条「重启」图标按钮（无文字，悬停有 tooltip），
// 让整个桌面应用一键重启：
//   1. 第一次点击进入确认态（图标变琥珀色，3 秒未再点自动复位，防误触）；
//   2. 再点一次 → POST /dsh-revive（host 先拉起脱离的复活进程，再请求宿主退出，
//      桌面应用随之退出并被复活进程重新拉起）；当前会话会断开，属预期。
//      发起后图标呼吸闪烁表示"重启中"。
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

		// ---- 注入样式 ----
		// 无边框图标按钮：静止时只有线条图标、完全跟随文字色（无自带颜色）；
		// 悬停淡显底色提示可点；armed 琥珀色 = 待确认；重启中呼吸闪烁；error 红色 = 重启失败。
		var CSS_ID = "dsh-restart/style";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-restart";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dsr-revive{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:background .12s ease,color .12s ease}",
				".dsr-revive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#e5e7eb)}",
				".dsr-revive:disabled{opacity:.5;cursor:default}",
				".dsr-revive[data-armed]{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
				".dsr-revive[data-error]{color:var(--dsw-alias-state-critical-primary,#ef4444)}",
				".dsr-revive[data-restarting] svg{animation:dsr-revive-pulse 1s ease-in-out infinite}",
				"@keyframes dsr-revive-pulse{from{opacity:1}50%{opacity:.3}to{opacity:1}}"
			].join("\n");
			document.head.appendChild(tag);
		}

		// ---- 纯线条重启图标：电源符号（圆环+竖线，开关机隐喻，不会被误读成循环） ----
		// stroke 跟随 currentColor，无填充无自带颜色。
		function RestartIcon() {
			return react.createElement(
				"svg",
				{
					width: 15,
					height: 15,
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

		// ---- 一键复活按钮（会话头部 actions 槽） ----
		// 无文字，仅图标；悬停 tooltip 说明用途。
		// 第一次点击进入确认态（图标变琥珀色，3 秒未再点自动复位），第二次点击真正执行：
		// POST /dsh-revive → host 先拉起脱离的复活进程，再请求宿主退出，
		// 桌面应用随之退出并被复活进程重新拉起。当前会话会断开，属预期。
		function ReviveButton(props) {
			var sessionId = props && props.sessionId;
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
					"data-armed": armed ? "true" : undefined,
					"data-error": error ? "true" : undefined,
					"data-restarting": restarting ? "true" : undefined,
					onClick: onClick
				},
				react.createElement(RestartIcon, null)
			);
		}

		// ---- 空白（新）会话的头部引导位按钮 ----
		// 仅当主视图没有会话、或主视图会话全部是 blank（还没有消息）时显示——
		// 此时框架对 session header 传 hideChrome、actions 槽不渲染，由这里补位。
		// 复用 ReviveButton（不给 sessionId：空白会话没有运行中的回合，无需续跑标记）。
		// useSessions 是框架注入的全局 standard prop（会话列表 + 主视图保留信息）。
		function LeadingReviveButton(props) {
			var useSessions = props && props.useSessions;
			if (typeof useSessions !== "function") return react.createElement(ReviveButton, null);
			var show = useSessions(function (state) {
				var mains = [];
				for (var id in state.byId) {
					var row = state.byId[id];
					if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) mains.push(row);
				}
				if (mains.length === 0) return true;
				for (var i = 0; i < mains.length; i++) {
					if (mains[i].blank !== true) return false;
				}
				return true;
			});
			if (!show) return null;
			return react.createElement(ReviveButton, null);
		}

		// ---- Cordis 插件入口 ----
		// 双挂载点：
		//   1) conversation.session.header.actions —— 活跃会话的标题行动作区（带 sessionId，
		//      重启时可写续跑标记）。注意：全新空白会话（blank，还没有消息）时框架对头部
		//      传 hideChrome，整个 actions 槽不渲染，图标会消失；
		//   2) conversation.header.leading —— 头部引导位（root 作用域、始终渲染），
		//      仅当主视图没有会话、或主视图会话全部是空白会话时显示（此时 actions 行必然
		//      隐藏，不会出现双图标）。空白会话没有运行中的回合，不需要续跑标记。
		exports.inject = ["slots"];
		exports.apply = function (ctx) {
			ctx.inject(["slots"], function (scope) {
				scope.slots.inject("conversation.session.header.actions", function () {
					return scope.slots.register({
						name: "conversation.session.header.actions",
						id: "dsh-revive",
						order: 90,
						locale: "conversation"
					}, ReviveButton);
				});
				scope.slots.inject("conversation.header.leading", function () {
					return scope.slots.register({
						name: "conversation.header.leading"
					}, LeadingReviveButton);
				});
			});
		};

		return module.exports;
	}
});
}
