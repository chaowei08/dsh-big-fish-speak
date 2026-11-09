/**
 * dsh-big-fish-speak — browser client face: 顶部栏播报开关按钮。
 *
 * 注册位置：conversation.session.header.actions（会话标题右侧的操作行）。
 * 按钮形态：喇叭图标，默认高亮（自动播报开），点一下变暗静音（关）；
 * 大肥鱼正在念的时候，两条声波弧线做呼吸动画。
 *
 * 兼容性设计：
 *   - 整个 factory 包在 try/catch 里，任何一步失败都静默降级（不注册按钮，不报错）
 *   - require 的模块逐个探测，不存在就跳过整个 client（不影响 Host 端命令行功能）
 *   - slot 注册失败不影响其他插件
 *   - locale 不可用时用硬编码中文兜底
 *   - CSS 颜色全部硬编码，hover 背景有纯色兜底，不依赖任何上游 CSS 变量
 *
 * 状态通过同源 fetch 与 Host 端通信：
 *   GET  /plugins/dsh-big-fish-speak/status → { ok, auto, busy }
 *   POST /plugins/dsh-big-fish-speak/auto    → body { auto: bool } → { ok, auto }
 */
(function () {
  // 最外层 try/catch：任何错误都不能让 DSH 主界面崩
  try {
    if (typeof window === "undefined" || !window.__ModuleLoader__) return;

    window.__ModuleLoader__.load({
      id: "dsh-big-fish-speak",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        // ── 逐步 require，缺模块就静默退出 ──────────────────────────────
        var react;
        try {
          react = require("react");
        } catch {
          // react 模块找不到，整个 client 不注册
          return module.exports;
        }
        var h = react.createElement;

        // ── 样式：全部硬编码，零上游变量依赖 ──────────────────────────
        var css = [
          ".dsh-bigfish-speechBtn{flex:none;width:28px;height:28px;cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex;color:#8e8e93;transition:color .15s,background .15s}",
          ".dsh-bigfish-speechBtn:hover:not(:disabled){background:rgba(0,0,0,.06)}",
          ".dsh-bigfish-speechBtn[data-state=\"on\"]{color:#007aff}",
          ".dsh-bigfish-speechBtn[data-state=\"off\"]{color:#ff3b30}",
          ".dsh-bigfish-speechBtn svg{width:18px;height:18px;display:block}",
          ".dsh-bigfish-speechBtn[data-busy=\"true\"] .wave{animation:dsh-bigfish-wave 1.1s ease-in-out infinite;transform-origin:center}",
          ".dsh-bigfish-speechBtn[data-busy=\"true\"] .wave-2{animation-delay:.25s}",
          "@keyframes dsh-bigfish-wave{0%,100%{opacity:.25;transform:scaleY(.55)}50%{opacity:1;transform:scaleY(1)}}"
        ].join("");
        try {
          var cssTagId = "dsh-big-fish-speak/SpeechBtn.module.css";
          if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + cssTagId + '"]') === null) {
            var tag = document.createElement("style");
            tag.dataset.plugin = "dsh-big-fish-speak";
            tag.dataset.pluginCss = cssTagId;
            tag.textContent = css;
            document.head.appendChild(tag);
          }
        } catch {
          // CSS 注入失败也不影响功能（按钮样式丑一点而已）
        }

        // ── 文案：locale 不可用时的硬编码兜底 ──────────────────────────
        var fallbackDict = {
          "title.on": "自动播报已开启（点击关闭）",
          "title.off": "自动播报已关闭（点击开启）",
          "aria.on": "大肥鱼自动播报：开",
          "aria.off": "大肥鱼自动播报：关",
          "aria.speaking": "正在播报中"
        };

        // ── 喇叭图标 ──────────────────────────────────────────────────
        function SpeakerIcon({ state }) {
          if (state === "off") {
            return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
              h("path", { d: "M11 5L6 9H2v6h4l5 4V5z" }),
              h("line", { x1: "23", y1: "9", x2: "17", y2: "15" }),
              h("line", { x1: "17", y1: "9", x2: "23", y2: "15" })
            );
          }
          return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
            h("path", { d: "M11 5L6 9H2v6h4l5 4V5z" }),
            h("path", { className: "wave wave-1", d: "M15.54 8.46a5 5 0 0 1 0 7.07" }),
            h("path", { className: "wave wave-2", d: "M19.07 4.93a10 10 0 0 1 0 14.14" })
          );
        }

        // ── 开关按钮组件 ───────────────────────────────────────────────
        function SpeechToggle(props) {
          // t 函数可能不存在（locale 服务没注册成功），用兜底
          var t = (props && typeof props.t === "function")
            ? props.t
            : function (key) { return fallbackDict[key] || key; };

          var stateHook = react.useState({ auto: true, busy: false, loaded: false });
          var state = stateHook[0];
          var setState = stateHook[1];

          var fetchStatus = react.useCallback(async function () {
            try {
              var res = await fetch("/plugins/dsh-big-fish-speak/status");
              var data = await res.json();
              if (data && data.ok) {
                setState({ auto: data.auto === true, busy: data.busy === true, loaded: true });
              }
            } catch {
              // 静默失败：Host 端没起 web 路由时不报错
            }
          }, []);

          react.useEffect(function () {
            fetchStatus();
            var timer = setInterval(fetchStatus, 5000);
            var onVisible = function () {
              if (typeof document !== "undefined" && document.visibilityState === "visible") fetchStatus();
            };
            if (typeof document !== "undefined") {
              document.addEventListener("visibilitychange", onVisible);
            }
            return function () {
              clearInterval(timer);
              if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisible);
              }
            };
          }, [fetchStatus]);

          var handleClick = react.useCallback(async function () {
            var nextAuto = !state.auto;
            setState(function (prev) { return Object.assign({}, prev, { auto: nextAuto }); });
            try {
              await fetch("/plugins/dsh-big-fish-speak/auto", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ auto: nextAuto })
              });
            } catch {
              // 失败回滚到真实状态
              fetchStatus();
            }
          }, [state.auto, fetchStatus]);

          var stateName = "on";
          var speaking = state.busy;
          var title = "大肥鱼播报状态";

          return h("button", {
            type: "button",
            className: "dsh-bigfish-speechBtn",
            "data-state": stateName,
            "data-busy": speaking ? "true" : "false",
            title: title,
            "aria-label": title
          }, h(SpeakerIcon, { state: stateName }));
        }

        // ── apply：每一步都做存在性检查，失败就跳过 ─────────────────────
        var inject = ["slots", "locale"];

        function apply(ctx) {
          // locale 注册：失败不影响按钮显示（用兜底文案）
          try {
            if (ctx.locale && typeof ctx.locale.register === "function") {
              ctx.locale.register("bigfish", { zh: fallbackDict, en: fallbackDict });
            }
          } catch { /* 忽略 */ }

          // slot 注册：失败就不显示按钮，不报错
          try {
            if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
            ctx.slots.inject("conversation.session.header.actions", function () {
              try {
                return ctx.slots.register({
                  name: "conversation.session.header.actions",
                  id: "bigfish-speech-toggle",
                  order: 90,
                  locale: "bigfish"
                }, SpeechToggle);
              } catch {
                // 单个 slot 注册失败不影响其他
              }
            });
          } catch {
            // slot 路径改名了，静默退出
          }
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
      }
    });
  } catch {
    // 最外层兜底：任何加载错误都不能让 DSH 主界面崩
  }
})();
