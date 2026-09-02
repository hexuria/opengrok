/*
 * Collections page controller.
 *
 * Plain classic script on purpose: the document is loaded from file://, where
 * ES module imports are blocked by Chromium's opaque file origin. The shared
 * renderer arrives as the SandCollectionRender global from the bundle emitted
 * out of source/shared/collections/collection-render.ts, so the page and the
 * HTML exporter paint identical bubbles.
 */

(function () {
  "use strict";

  var render = globalThis.SandCollectionRender;
  var bridge = globalThis.collections;
  var BOOKMARKS_ID = "bookmarks";

  var listEl = document.getElementById("sand-col-list");
  var threadEl = document.getElementById("sand-col-thread");
  var titleEl = document.getElementById("sand-col-title");
  var statusEl = document.getElementById("sand-col-status");
  var copyButton = document.getElementById("sand-col-copy");
  var htmlButton = document.getElementById("sand-col-html");
  var jsonButton = document.getElementById("sand-col-json");
  var deleteButton = document.getElementById("sand-col-delete");
  var importButton = document.getElementById("sand-col-import");

  var state = { collections: [], selectedId: null, document: null };
  var statusTimer = 0;

  var style = document.createElement("style");
  style.textContent = render.COLLECTION_BUBBLE_CSS;
  document.head.appendChild(style);

  var timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  function formatTimestamp(value) {
    return typeof value === "number" && isFinite(value) && value > 0 ? timeFormat.format(new Date(value)) : "";
  }

  function mediaSrc(media) {
    return "sand-media://attachment/" + encodeURIComponent(media.srcPath);
  }

  function collectionLink(id) {
    return "opengrok://app/v1/collection?id=" + encodeURIComponent(id);
  }

  function setStatus(message, isSticky) {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = 0; }
    if (!message) { statusEl.hidden = true; statusEl.textContent = ""; return; }
    statusEl.hidden = false;
    statusEl.textContent = message;
    if (!isSticky) statusTimer = setTimeout(function () { setStatus(""); }, 4000);
  }

  function failureText(error) {
    return error && error.message ? String(error.message).replace(/^Error invoking remote method '[^']*':\s*/, "") : String(error);
  }

  function renderSidebar() {
    listEl.textContent = "";
    state.collections.forEach(function (collection) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "sand-col-row";
      row.setAttribute("data-collection-id", collection.id);
      if (collection.id === state.selectedId) row.setAttribute("aria-current", "true");
      var name = document.createElement("span");
      name.className = "sand-col-row-name";
      name.textContent = collection.name;
      var count = document.createElement("span");
      count.className = "sand-col-row-count";
      count.textContent = String(collection.count || 0);
      row.appendChild(name);
      row.appendChild(count);
      row.addEventListener("click", function () { void select(collection.id); });
      listEl.appendChild(row);
    });
  }

  function renderThread() {
    var doc = state.document;
    if (!doc) { threadEl.textContent = ""; return; }
    if (!doc.messages.length) {
      threadEl.innerHTML = "<p class=\"sand-col-empty\">Nothing here yet. Select messages in a chat and choose Share to Collection or Bookmark.</p>";
      return;
    }
    threadEl.innerHTML = render.renderCollectionMessages(doc.messages, {
      mediaSrc: mediaSrc,
      formatTimestamp: formatTimestamp,
      withActions: true,
      withPromote: state.selectedId !== BOOKMARKS_ID,
    });
  }

  function renderHeader() {
    var doc = state.document;
    var isBookmarks = state.selectedId === BOOKMARKS_ID;
    titleEl.textContent = doc ? doc.name : "Collections";
    titleEl.setAttribute("contenteditable", doc && !isBookmarks ? "true" : "false");
    titleEl.title = doc && !isBookmarks ? "Click to rename" : "";
    var hasSelection = Boolean(doc);
    copyButton.disabled = !hasSelection;
    htmlButton.disabled = !hasSelection;
    jsonButton.disabled = !hasSelection;
    deleteButton.disabled = !hasSelection || isBookmarks;
  }

  function paint() {
    renderSidebar();
    renderHeader();
    renderThread();
  }

  async function refreshList(preferredId) {
    var reply = await bridge.list();
    state.collections = (reply && reply.collections) || [];
    var target = preferredId
      || reply.selected
      || state.selectedId
      || (state.collections[0] && state.collections[0].id)
      || null;
    await select(target, true);
  }

  async function select(collectionId, force) {
    if (!collectionId) { state.selectedId = null; state.document = null; paint(); return; }
    if (!force && collectionId === state.selectedId) return;
    state.selectedId = collectionId;
    try {
      state.document = await bridge.get(collectionId);
    } catch (error) {
      state.document = null;
      setStatus(failureText(error));
    }
    paint();
  }

  async function reloadSelected() {
    if (!state.selectedId) return;
    state.document = await bridge.get(state.selectedId);
    var summary = state.collections.filter(function (item) { return item.id === state.selectedId; })[0];
    if (summary && state.document) summary.count = state.document.messages.length;
    paint();
  }

  threadEl.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-collection-action]") : null;
    if (!button) return;
    var article = button.closest("[data-collection-key]");
    var key = article && article.getAttribute("data-collection-key");
    if (!key || !state.document) return;
    var message = state.document.messages.filter(function (item) { return item.key === key; })[0];
    if (!message) return;
    var action = button.getAttribute("data-collection-action");
    if (action === "remove") {
      bridge.removeMessages(state.selectedId, [key]).then(function () {
        setStatus("Removed from this collection.");
        return reloadSelected();
      }).catch(function (error) { setStatus(failureText(error)); });
      return;
    }
    if (action === "open") {
      bridge.openOriginal(message.agentId, message.entryId).catch(function (error) { setStatus(failureText(error)); });
      return;
    }
    if (action === "bookmark") {
      bridge.promote(state.selectedId, [key]).then(function (result) {
        if (result && result.collections) state.collections = result.collections;
        setStatus(result && result.duplicates > 0 ? "Already in Bookmarks." : "Copied into Bookmarks.");
        renderSidebar();
      }).catch(function (error) { setStatus(failureText(error)); });
    }
  });

  titleEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); titleEl.blur(); return; }
    if (event.key === "Escape") { event.preventDefault(); titleEl.textContent = state.document ? state.document.name : ""; titleEl.blur(); }
  });

  titleEl.addEventListener("blur", function () {
    if (titleEl.getAttribute("contenteditable") !== "true" || !state.document) return;
    var next = (titleEl.textContent || "").trim();
    if (next.length === 0 || next === state.document.name) { titleEl.textContent = state.document.name; return; }
    bridge.rename(state.selectedId, next).then(function () {
      return refreshList(state.selectedId);
    }).catch(function (error) {
      setStatus(failureText(error));
      titleEl.textContent = state.document.name;
    });
  });

  /* The async clipboard API needs a permission the second window may not hold, so a selection copy is the fallback. */
  function copyWithSelection(text) {
    var field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "readonly");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
    document.body.removeChild(field);
    return copied;
  }

  copyButton.addEventListener("click", function () {
    if (!state.selectedId) return;
    var link = collectionLink(state.selectedId);
    var fallback = function () { setStatus(copyWithSelection(link) ? "Link copied: " + link : "Could not copy the link."); };
    if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
    navigator.clipboard.writeText(link).then(function () { setStatus("Link copied: " + link); }, fallback);
  });

  // The file should look like the window it came from, on whatever machine opens it.
  function currentTheme() {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch (_) { return "light"; }
  }

  htmlButton.addEventListener("click", function () {
    if (!state.selectedId) return;
    setStatus("Exporting…", true);
    bridge.exportHtml(state.selectedId, currentTheme()).then(function (result) {
      if (!result || !result.saved) { setStatus(""); return; }
      setStatus(result.skipped > 0
        ? "Exported to " + result.path + " (" + result.skipped + " attachment(s) left as placeholders)."
        : "Exported to " + result.path + ".");
    }).catch(function (error) { setStatus(failureText(error)); });
  });

  jsonButton.addEventListener("click", function () {
    if (!state.selectedId) return;
    setStatus("Exporting…", true);
    bridge.exportJson(state.selectedId).then(function (result) {
      setStatus(result && result.saved ? "Exported to " + result.path + "." : "");
    }).catch(function (error) { setStatus(failureText(error)); });
  });

  deleteButton.addEventListener("click", function () {
    if (!state.selectedId || state.selectedId === BOOKMARKS_ID || !state.document) return;
    if (!confirm("Delete “" + state.document.name + "”? The original messages stay in their chats.")) return;
    bridge.deleteCollection(state.selectedId).then(function () {
      state.selectedId = null;
      state.document = null;
      setStatus("Collection deleted.");
      return refreshList(BOOKMARKS_ID);
    }).catch(function (error) { setStatus(failureText(error)); });
  });

  importButton.addEventListener("click", function () {
    setStatus("Importing…", true);
    bridge.importJson().then(function (result) {
      if (!result || !result.imported) { setStatus(""); return; }
      setStatus("Imported “" + result.collection.name + "”.");
      return refreshList(result.collection.id);
    }).catch(function (error) { setStatus(failureText(error)); });
  });

  bridge.onNavigate(function (payload) {
    var id = payload && payload.collectionId;
    void refreshList(id || undefined);
  });

  refreshList().catch(function (error) { setStatus(failureText(error), true); });
})();
