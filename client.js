// dsh-restart: DeepSeek Harness 前端插件（纯插件，不改 DSH 源码）。
//
// 功能：会话头部加「🔄 重启 DSH」按钮，让整个桌面应用一键重启：
//   1. 第一次点击进入「确认重启？」（3 秒未再点自动复位，防误触）；
//   2. 再点一次 → POST /dsh-revive（host 先拉起脱离的复活进程，再请求宿主退出，
//      桌面应用随之退出并被复活进程重新拉起）；当前会话会断开，属预期。
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
		var CSS_ID = "dsh-restart/style";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-restart";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dsr-revive{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}",
				".dsr-revive:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#e5e7eb)}",
				".dsr-revive:disabled{opacity:.6;cursor:default}",
				".dsr-revive[data-armed]{border-color:var(--dsw-alias-state-warning-primary,#f59e0b);color:var(--dsw-alias-state-warning-primary,#f59e0b)}"
			].join("\n");
			document.head.appendChild(tag);
		}

		// ---- 一键复活按钮（会话头部 actions 槽） ----
		// 第一次点击进入"确认重启？"（3 秒未再点自动复位），第二次点击真正执行：
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
			var timerRef = useRef(null);
			var onClick = function () {
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
				}).catch(function () {
					setRestarting(false);
				});
			};
			return react.createElement(
				"button",
				{
					type: "button",
					className: "dsr-revive",
					title: "重启 DSH（应用插件改动后需要重启）",
					disabled: restarting,
					"data-armed": armed ? "true" : undefined,
					onClick: onClick
				},
				restarting ? "重启中…" : armed ? "确认重启？" : "🔄 重启 DSH"
			);
		}

		// ---- Cordis 插件入口 ----
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
			});
		};

		return module.exports;
	}
});
}
