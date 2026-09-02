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

  var listEl = document.getElementById("sand-col-list");
  var threadEl = document.getElementById("sand-col-thread");
  var titleEl = document.getElementById("sand-col-title");
  var statusEl = document.getElementById("sand-col-status");
  var titleField = document.getElementById("sand-col-title-field");
  var copyButton = document.getElementById("sand-col-copy");
  var exportButton = document.getElementById("sand-col-export");
  var exportMenu = document.getElementById("sand-col-export-menu");
  var deleteButton = document.getElementById("sand-col-delete");
  var importButton = document.getElementById("sand-col-import");

  /* Static inline SVG, the same stroke idiom as the chat's toolbars. A stack of cards for a
     collection, a tray-with-arrow for export and import, a bin for delete. */
  var ICON = {
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    exportOut: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    importIn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14V3"/><path d="M8 7l4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>'
  };
  copyButton.innerHTML = ICON.link;
  exportButton.innerHTML = ICON.exportOut;
  importButton.innerHTML = ICON.importIn;
  deleteButton.innerHTML = ICON.trash;

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
    });
  }

  function renderHeader() {
    var doc = state.document;
    titleEl.textContent = doc ? doc.name : "Collections";
    titleEl.title = doc ? "Double-click to rename" : "";
    titleEl.hidden = false;
    titleField.hidden = true;
    var hasSelection = Boolean(doc);
    copyButton.disabled = !hasSelection;
    exportButton.disabled = !hasSelection;
    deleteButton.disabled = !hasSelection;
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
  });

  // The name is a heading; a double-click turns it into a field. Enter renames, Escape puts
  // the old name back — an always-live input invited an accidental rename on every stray click.
  function beginRename() {
    if (!state.document) return;
    titleField.value = state.document.name;
    titleEl.hidden = true;
    titleField.hidden = false;
    titleField.focus();
    titleField.select();
  }

  function endRename(commit) {
    if (titleField.hidden) return;
    var next = (titleField.value || "").trim();
    titleField.hidden = true;
    titleEl.hidden = false;
    if (!commit || !state.document || next.length === 0 || next === state.document.name) return;
    bridge.rename(state.selectedId, next).then(function () {
      return refreshList(state.selectedId);
    }).catch(function (error) { setStatus(failureText(error)); });
  }

  titleEl.addEventListener("dblclick", beginRename);
  titleField.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); endRename(true); return; }
    if (event.key === "Escape") { event.preventDefault(); endRename(false); }
  });
  titleField.addEventListener("blur", function () { endRename(true); });

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

  // One Export button with a small menu, so a fourth format later costs no more room.
  function closeExportMenu() {
    exportMenu.hidden = true;
    exportButton.setAttribute("aria-expanded", "false");
  }

  exportButton.addEventListener("click", function (event) {
    event.stopPropagation();
    if (!state.selectedId) return;
    var open = exportMenu.hidden;
    exportMenu.hidden = !open;
    exportButton.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", function () { closeExportMenu(); });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeExportMenu(); });
  exportMenu.addEventListener("click", function (event) { event.stopPropagation(); });

  exportMenu.addEventListener("click", function (event) {
    var item = event.target && event.target.closest ? event.target.closest("[data-export]") : null;
    if (!item || !state.selectedId) return;
    var format = item.getAttribute("data-export");
    closeExportMenu();
    setStatus("Exporting…", true);
    var call = format === "json" ? bridge.exportJson(state.selectedId)
      : format === "pdf" ? bridge.exportPdf(state.selectedId, currentTheme())
        : bridge.exportHtml(state.selectedId, currentTheme());
    call.then(function (result) {
      if (!result || !result.saved) { setStatus(result && result.error ? result.error : ""); return; }
      setStatus(result.skipped > 0
        ? "Exported to " + result.path + " (" + result.skipped + " attachment(s) left as placeholders)."
        : "Exported to " + result.path + ".");
    }).catch(function (error) { setStatus(failureText(error)); });
  });

  deleteButton.addEventListener("click", function () {
    if (!state.selectedId || !state.document) return;
    if (!confirm("Delete \u201c" + state.document.name + "\u201d? The original messages stay in their chats.")) return;
    bridge.deleteCollection(state.selectedId).then(function () {
      state.selectedId = null;
      state.document = null;
      setStatus("Collection deleted.");
      return refreshList();
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
