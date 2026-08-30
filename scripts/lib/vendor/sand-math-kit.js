/**
 * Math kit for the pinned 0.18 renderer, prepended to the app bundle.
 * Math renders INSIDE the markdown pipeline like official 0.29 - never as DOM
 * post-processing (mutating React-owned nodes loses text on reconciliation).
 * remark-math (singleDollarTextMath disabled, matching 0.29, so "$5 and $6"
 * is never math) parses $$-math; a visitor rewrites math nodes to "sand-math"
 * elements; a components-map entry (injected separately) renders them with
 * KaTeX MathML. pre() converts LLM-style \(...\) and \[...\] to $$-forms
 * before parsing, skipping code fences and inline code.
 */
(() => {
  try {
    var visit = function (node, fn) {
      if (!node) return;
      fn(node);
      var cs = node.children;
      if (cs) for (var i = 0; i < cs.length; i++) visit(cs[i], fn);
    };
    var toElement = function () {
      return function (tree) {
        visit(tree, function (n) {
          if (n.type === "math" || n.type === "inlineMath") {
            n.data = n.data || {};
            n.data.hName = "sand-math";
            n.data.hProperties = { tex: n.value, display: String(n.type === "math") };
            n.data.hChildren = [];
          }
        });
      };
    };
    var FENCE = /(```[\s\S]*?```|`[^`\n]*`)/;
    var DISPLAY = /\\\[([\s\S]+?)\\\]/g;
    var INLINE = /\\\((.+?)\\\)/g;
    var pre = function (t) {
      if (typeof t !== "string") return t;
      var parts = t.split(FENCE);
      for (var i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i]
          .replace(DISPLAY, function (_, x) { return "\n\n$$\n" + x + "\n$$\n\n"; })
          .replace(INLINE, function (_, x) { return "$$" + x + "$$"; });
      }
      return parts.join("");
    };
    var render = function (tex, display) {
      try {
        return self.katex.renderToString(String(tex || ""), { output: "mathml", displayMode: !!display, throwOnError: false });
      } catch (_) {
        var d = document.createElement("span");
        d.textContent = String(tex || "");
        return d.innerHTML;
      }
    };
    // User bubbles are plain text by design (no markdown). mathText splits
    // the RAW text before the app's link-promoting splitter (gpt) runs -
    // gpt returns React elements, so post-processing its output can never
    // find math. Math segments become KaTeX MathML spans; every text
    // segment still goes through gpt so links keep working. A segment that
    // began as \[...\]/block math keeps a leading newline from pre(),
    // which marks it display-mode.
    var mathText = function (text, matcher, key, gpt, jsx) {
      try {
        if (typeof text !== "string") return gpt(text, matcher, key);
        if (text.indexOf("$$") < 0 && text.indexOf("\\(") < 0 && text.indexOf("\\[") < 0) return gpt(text, matcher, key);
        var bits = pre(text).split(/\$\$([\s\S]+?)\$\$/);
        if (bits.length < 3) return gpt(text, matcher, key);
        var out = [];
        for (var j = 0; j < bits.length; j++) {
          if (j % 2 === 0) { if (bits[j]) out.push(gpt(bits[j], matcher, key + "t" + j)); }
          else {
            var display = bits[j].charAt(0) === "\n";
            out.push(jsx("span", { className: "sand-math" + (display ? " sand-math-display" : ""), dangerouslySetInnerHTML: { __html: render(bits[j].trim(), display) } }, key + "m" + j));
          }
        }
        return out;
      } catch (_) { return gpt(text, matcher, key); }
    };
    self.__sandMathKit = {
      pre: pre,
      render: render,
      mathText: mathText,
      remarkPlugins: self.__sandRemarkMath ? [[self.__sandRemarkMath, { singleDollarTextMath: false }], toElement] : [],
    };
  } catch (_) {
    self.__sandMathKit = { pre: function (t) { return t; }, render: function () { return ""; }, remarkPlugins: [] };
  }
})();
