/* ===== THD Space — admin panel =====
   Projects and templates, over the admin API (functions/admin/api/). Everything a designer
   needs to put a presentation online without a terminal:
     #/projects           every project (published, drafts, trash) and "New project"
     #/projects/<slug>    the editor: details, floors (plan + rooms + renders), drawings,
                          preview, publish / unpublish, trash / restore
     #/templates          the starting shapes a new project can be made from
   Edits save themselves (debounced) and every upload saves the project as soon as it lands, so
   nothing is lost if the tab is closed. Images are resized in the browser before upload, the way
   tools/make-medium-renders.js does it on disk: the original capped at 3000 px, a 1500 px medium
   copy for the gallery. Failures are shown where they happen, with the file name.
   Internal tool: modern browsers only (no ES5 here, unlike the engine and the hub). */
(function () {
  "use strict";

  const API = "api/";
  const ORIGINAL_EDGE = 3000;
  const ORIGINAL_QUALITY = 0.85;
  const MEDIUM_EDGE = 1500;
  const MEDIUM_MIN_SOURCE = 1600; // originals this small get no medium copy (as on disk)
  const MEDIUM_QUALITY = 0.8;
  const UPLOAD_PARALLEL = 3;
  const SAVE_DELAY_MS = 800;

  const CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  const state = { user: null, view: null, projects: [], templates: null, project: null };

  const $ = (id) => document.getElementById(id);
  const main = () => $("adm-main");

  // ===================== DOM HELPERS =====================

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      else if (key === "checked" || key === "disabled" || key === "hidden" || key === "required" || key === "multiple") node[key] = !!value;
      else node.setAttribute(key, value === true ? "" : value);
    });
    (children || []).forEach((child) => {
      if (child == null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  const pad = (n) => (n < 10 ? "0" : "") + n;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // Ports of the server's text helpers (server/text.js), so labels and names match.
  const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const camelCase = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
  function uniqueId(base, taken, fallback) {
    const root = base || fallback;
    let id = root;
    for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
    return id;
  }
  function uploadName(originalName, ext) {
    const base = slugify(String(originalName).replace(/\.[^.]+$/, "")) || "file";
    return `${base.slice(0, 60)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  }
  function documentLabel(file) {
    return String(file).split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
      .map((w) => (/^[A-Z0-9]+$/.test(w) && /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  const assetUrl = (slug, path) => `../projects/${encodeURIComponent(slug)}/` + path.split("/").map(encodeURIComponent).join("/");

  // ===================== API =====================

  class ApiError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details || null;
    }
  }

  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(API + path, init);
    } catch (err) {
      throw new ApiError(0, "No connection to the server");
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `HTTP ${res.status}${text && !data ? ": " + text.slice(0, 200) : ""}`, data && data.details);
    return data;
  }

  // Raw file upload with progress (fetch has no upload progress).
  function putFile(slug, path, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${API}projects/${encodeURIComponent(slug)}/files?path=${encodeURIComponent(path)}`);
      xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        let message = `HTTP ${xhr.status}`;
        try { message = JSON.parse(xhr.responseText).error || message; } catch (e) {}
        reject(new ApiError(xhr.status, message));
      };
      xhr.onerror = () => reject(new ApiError(0, "Upload failed: no connection"));
      xhr.send(blob);
    });
  }

  function deleteFiles(slug, paths) {
    if (!paths.length) return Promise.resolve();
    return api("DELETE", `projects/${encodeURIComponent(slug)}/files`, { paths }).catch((err) => {
      console.error("Could not delete files:", paths, err);
    });
  }

  // ===================== TOAST =====================

  let toastTimer = null;
  function toast(message, isError) {
    const el = $("adm-toast");
    el.textContent = message;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 3500);
  }

  function errorMessage(err) {
    if (err instanceof ApiError && err.details && err.details.length) return `${err.message}: ${err.details.join("; ")}`;
    return err && err.message ? err.message : String(err);
  }

  // ===================== ROUTER =====================

  function route() {
    const hash = location.hash.replace(/^#\/?/, "");
    const parts = hash.split("/").filter(Boolean);
    if (parts[0] === "templates") return { view: "templates" };
    if (parts[0] === "projects" && parts[1]) return { view: "editor", slug: decodeURIComponent(parts[1]) };
    return { view: "projects" };
  }

  function setChrome(title, subtitle, tab) {
    $("adm-title").textContent = title;
    $("adm-subtitle").textContent = subtitle || "";
    document.title = `${title} — THD Space admin`;
    document.querySelectorAll(".adm-tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === tab ? "true" : "false"));
  }

  async function render() {
    const r = route();
    if (state.view === "editor" && (r.view !== "editor" || r.slug !== state.project?.slug)) await flushSave();
    state.view = r.view;
    main().replaceChildren(h("p", { class: "adm-status", text: "Loading" }));
    window.scrollTo(0, 0);
    try {
      if (r.view === "projects") await renderProjects();
      else if (r.view === "editor") await renderEditor(r.slug);
      else await renderTemplates();
    } catch (err) {
      console.error(err);
      main().replaceChildren(h("p", { class: "adm-status is-error", role: "alert", text: "Could not load this page: " + errorMessage(err) }));
    }
  }

  // ===================== PROJECTS LIST =====================

  function projectRow(p, i) {
    const c = p.counts || {};
    const meta = [plural(c.floors || 0, "floor"), plural(c.rooms || 0, "room"), plural(c.images || 0, "render"), plural(c.documents || 0, "drawing")].join(" · ");
    return h("a", { class: "row", href: `#/projects/${encodeURIComponent(p.slug)}` }, [
      h("span", { class: "row-index", text: pad(i + 1) }),
      h("span", { class: "row-text" }, [
        h("span", { class: "row-title", text: p.title }),
        h("span", { class: "row-meta", text: `${p.client} · ${meta}` })
      ]),
      statusBadge(p.status),
      h("span", { class: "row-chevron", html: CHEVRON })
    ]);
  }

  function statusBadge(status) {
    const label = status === "published" ? "Published" : status === "deleted" ? "In trash" : "Draft";
    return h("span", { class: `badge badge-${status}`, text: label });
  }

  async function renderProjects() {
    setChrome("Projects", "", "projects");
    const data = await api("GET", "projects");
    state.projects = data.projects;
    const groups = [
      ["Published", state.projects.filter((p) => p.status === "published")],
      ["Drafts", state.projects.filter((p) => p.status === "draft")],
      ["Trash", state.projects.filter((p) => p.status === "deleted")]
    ];
    const nodes = [
      h("div", { class: "toolbar" }, [
        h("p", { class: "hint", text: `${plural(state.projects.length, "project")} in the bucket` }),
        h("span", { class: "spacer" }),
        h("button", { class: "btn btn-primary", onclick: openNewDialog, text: "New project" })
      ])
    ];
    groups.forEach(([name, list]) => {
      if (!list.length && name === "Trash") return;
      nodes.push(h("div", { class: "section-head" }, [h("h2", { class: "section-title", text: name })]));
      nodes.push(list.length
        ? h("div", { class: "stack" }, list.map(projectRow))
        : h("p", { class: "empty", text: name === "Published" ? "Nothing published yet" : "No drafts" }));
    });
    main().replaceChildren(...nodes);
  }

  // ----- New project dialog -----

  async function ensureTemplates() {
    if (!state.templates) state.templates = (await api("GET", "templates")).templates;
    return state.templates;
  }

  async function openNewDialog() {
    const dlg = $("dlg-new");
    const form = $("frm-new");
    form.reset();
    $("new-error").hidden = true;
    let templates = [];
    try {
      templates = await ensureTemplates();
    } catch (err) {
      return toast("Could not load templates: " + errorMessage(err), true);
    }
    const list = $("new-templates");
    list.replaceChildren(...templates.map((t, i) => h("label", { class: "choice" }, [
      h("input", { type: "radio", name: "templateId", value: t.id, checked: i === 0 }),
      h("span", {}, [
        h("span", { class: "choice-name", text: t.name }),
        h("span", { class: "choice-desc", text: (t.description ? t.description + " · " : "") + t.floors.map((f) => `${f.label} (${f.rooms.length})`).join(", ") })
      ])
    ])));
    dlg.showModal();
    form.elements.client.focus();
  }

  function bindNewDialog() {
    const dlg = $("dlg-new");
    const form = $("frm-new");
    let slugTouched = false;
    form.elements.title.addEventListener("input", () => {
      if (!slugTouched) form.elements.slug.value = slugify(form.elements.title.value);
      $("new-slug-hint").textContent = form.elements.slug.value ? `…/projects/${form.elements.slug.value}/` : "";
    });
    form.elements.slug.addEventListener("input", () => {
      slugTouched = form.elements.slug.value !== "";
      $("new-slug-hint").textContent = form.elements.slug.value ? `…/projects/${form.elements.slug.value}/` : "";
    });
    $("new-cancel").addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { slugTouched = false; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        client: form.elements.client.value,
        title: form.elements.title.value,
        slug: form.elements.slug.value || slugify(form.elements.title.value),
        templateId: form.elements.templateId.value
      };
      $("new-submit").disabled = true;
      try {
        const data = await api("POST", "projects", body);
        dlg.close();
        toast(`Created "${data.project.title}" as a draft`);
        location.hash = `#/projects/${encodeURIComponent(data.project.slug)}`;
      } catch (err) {
        const el = $("new-error");
        el.textContent = errorMessage(err);
        el.hidden = false;
      } finally {
        $("new-submit").disabled = false;
      }
    });
  }

  // ===================== EDITOR =====================

  const editor = { project: null, dirty: false, saveTimer: null, saving: null, lastError: null, uploads: new Map() };

  function setSaveState(text, isError) {
    const el = $("save-state");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  // Debounced save of the whole project; a second change while a save runs queues one more.
  function saveSoon() {
    editor.dirty = true;
    setSaveState("Unsaved changes");
    clearTimeout(editor.saveTimer);
    editor.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function saveNow() {
    clearTimeout(editor.saveTimer);
    if (editor.saving) return editor.saving.then(() => (editor.dirty ? saveNow() : undefined));
    if (!editor.dirty || !editor.project) return Promise.resolve();
    editor.dirty = false;
    setSaveState("Saving…");
    const project = editor.project;
    editor.saving = api("PUT", `projects/${encodeURIComponent(project.slug)}`, { project }).then((data) => {
      if (editor.project === project) {
        project.updatedAt = data.project.updatedAt;
        project.status = data.project.status;
      }
      setSaveState(editor.dirty ? "Unsaved changes" : "All changes saved");
      editor.lastError = null;
    }).catch((err) => {
      editor.dirty = true;
      editor.lastError = err;
      setSaveState("Not saved: " + errorMessage(err), true);
      toast("Could not save: " + errorMessage(err), true);
    }).finally(() => {
      editor.saving = null;
    });
    return editor.saving;
  }

  async function flushSave() {
    if (!editor.project) return;
    clearTimeout(editor.saveTimer);
    if (editor.dirty) await saveNow();
    if (editor.saving) await editor.saving;
  }

  function bindField(input, get, set) {
    input.value = get() || "";
    input.addEventListener("input", () => {
      set(input.value);
      saveSoon();
    });
    return input;
  }

  async function renderEditor(slug) {
    const data = await api("GET", `projects/${encodeURIComponent(slug)}`);
    editor.project = data.project;
    editor.dirty = false;
    editor.lastError = null;
    editor.uploads = new Map();
    const p = editor.project;
    setChrome(p.title, p.client, "projects");

    main().replaceChildren(
      h("div", { class: "card editor-bar", id: "editor-bar" }),
      h("div", { class: "section-head" }, [h("h2", { class: "section-title", text: "Details" })]),
      h("div", { class: "card" }, [
        h("div", { class: "field-row" }, [
          h("label", { class: "field" }, [h("span", { class: "label", text: "Client" }), bindField(h("input", { class: "input" }), () => p.client, (v) => { p.client = v; })]),
          h("label", { class: "field" }, [h("span", { class: "label", text: "Title" }), bindField(h("input", { class: "input" }), () => p.title, (v) => { p.title = v; $("adm-title").textContent = v || "Untitled"; })])
        ]),
        h("p", { class: "hint", text: `Address: …/projects/${p.slug}/ · created ${fmtDate(p.createdAt)} · last change ${fmtDate(p.updatedAt)}` })
      ]),
      h("div", { class: "section-head" }, [h("h2", { class: "section-title", text: "Floors" }), h("button", { class: "btn btn-small", onclick: addFloor, text: "Add floor" })]),
      h("div", { id: "floors" }),
      h("div", { class: "section-head" }, [h("h2", { class: "section-title", text: "Drawings" })]),
      h("div", { class: "card", id: "drawings" })
    );
    renderEditorBar();
    renderFloors();
    renderDrawings();
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function renderEditorBar() {
    const p = editor.project;
    const bar = $("editor-bar");
    if (!bar) return;
    const busy = h("span", { class: "save-state", id: "save-state", text: editor.dirty ? "Unsaved changes" : "All changes saved" });
    const items = [
      statusBadge(p.status),
      h("a", { class: "btn", href: `../projects/${encodeURIComponent(p.slug)}/`, target: "_blank", rel: "noopener", text: "Preview" }),
    ];
    if (p.status === "deleted") {
      items.push(h("button", { class: "btn", onclick: () => setStatus("draft"), text: "Restore from trash" }));
    } else if (p.status === "published") {
      items.push(h("button", { class: "btn", onclick: () => setStatus("draft"), text: "Unpublish" }));
    } else {
      items.push(h("button", { class: "btn btn-primary", onclick: () => setStatus("published"), text: "Publish" }));
    }
    items.push(h("span", { class: "spacer" }), busy);
    if (p.status !== "deleted") items.push(h("button", { class: "btn btn-danger btn-small", onclick: trashProject, text: "Move to trash" }));
    bar.replaceChildren(...items);
    $("adm-subtitle").textContent = p.client;
  }

  async function setStatus(status) {
    const p = editor.project;
    await flushSave();
    if (editor.lastError) return toast("Fix the save error first", true);
    try {
      const data = await api("POST", `projects/${encodeURIComponent(p.slug)}/status`, { status });
      p.status = data.project.status;
      renderEditorBar();
      toast(status === "published" ? `"${p.title}" is published: it now appears in the hub` : status === "draft" && data.project.status === "draft" ? "Now a draft (not listed in the hub)" : "Updated");
    } catch (err) {
      if (err.details && err.details.length) {
        showPublishErrors(err.details);
        toast("Not ready to publish: see the list at the top", true);
      } else {
        toast(errorMessage(err), true);
      }
    }
  }

  function showPublishErrors(details) {
    const bar = $("editor-bar");
    const old = bar.querySelector(".inline-error");
    if (old) old.remove();
    bar.appendChild(h("div", { class: "inline-error", role: "alert", style: "flex-basis:100%" }, [
      "Before publishing:",
      h("ul", {}, details.map((d) => h("li", { text: d })))
    ]));
  }

  async function trashProject() {
    const p = editor.project;
    if (!confirm(`Move "${p.title}" to the trash? It disappears from the hub and its address stops working. Files are kept and it can be restored.`)) return;
    await flushSave();
    try {
      const data = await api("DELETE", `projects/${encodeURIComponent(p.slug)}`);
      p.status = data.project.status;
      renderEditorBar();
      toast("Moved to the trash");
    } catch (err) {
      toast(errorMessage(err), true);
    }
  }

  // ----- Floors -----

  function floorIds() { return new Set(editor.project.floors.map((f) => f.id)); }

  function addFloor() {
    const p = editor.project;
    const label = `Floor ${p.floors.length + 1}`;
    p.floors.push({ id: uniqueId(slugify(label), floorIds(), "floor"), label, plan: null, rooms: [] });
    saveSoon();
    renderFloors();
  }

  function move(list, index, delta) {
    const target = index + delta;
    if (target < 0 || target >= list.length) return false;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    return true;
  }

  function roomPaths(room) {
    return room.images.concat((room.medium || []).filter(Boolean));
  }

  function floorPaths(floor) {
    return (floor.plan ? [floor.plan] : []).concat(...floor.rooms.map(roomPaths));
  }

  function renderFloors() {
    const p = editor.project;
    const host = $("floors");
    if (!host) return;
    if (!p.floors.length) {
      host.replaceChildren(h("p", { class: "empty", text: "No floors yet" }));
      return;
    }
    host.replaceChildren(...p.floors.map((floor, fi) => {
      const card = h("div", { class: "card", "data-floor": floor.id });
      card.append(
        h("div", { class: "floor-head" }, [
          h("label", { class: "field" }, [h("span", { class: "label", text: `Floor ${pad(fi + 1)} · label` }), bindField(h("input", { class: "input" }), () => floor.label, (v) => { floor.label = v; })]),
          h("label", { class: "field narrow" }, [h("span", { class: "label", text: "Tab (short)" }), bindField(h("input", { class: "input", placeholder: "one word" }), () => floor.tabLabel, (v) => { if (v.trim()) floor.tabLabel = v; else delete floor.tabLabel; })]),
          h("div", { class: "head-actions" }, [
            h("button", { class: "btn-icon", title: "Move up", "aria-label": "Move floor up", disabled: fi === 0, onclick: () => { if (move(p.floors, fi, -1)) { saveSoon(); renderFloors(); } }, text: "↑" }),
            h("button", { class: "btn-icon", title: "Move down", "aria-label": "Move floor down", disabled: fi === p.floors.length - 1, onclick: () => { if (move(p.floors, fi, 1)) { saveSoon(); renderFloors(); } }, text: "↓" }),
            h("button", { class: "btn-icon", title: "Remove floor", "aria-label": "Remove floor", onclick: () => removeFloor(fi), text: "×" })
          ])
        ]),
        renderPlan(floor),
        h("div", { class: "rooms" }, [
          h("div", { class: "section-head" }, [h("h3", { class: "section-title", text: "Rooms" }), h("button", { class: "btn btn-small", onclick: () => addRoom(floor), text: "Add room" })]),
          h("div", { class: "stack", "data-rooms": floor.id }, floor.rooms.length ? floor.rooms.map((room, ri) => renderRoom(floor, room, ri)) : [h("p", { class: "hint", text: "No rooms yet" })])
        ])
      );
      return card;
    }));
  }

  function removeFloor(fi) {
    const p = editor.project;
    const floor = p.floors[fi];
    const n = floorPaths(floor).length;
    if (!confirm(`Remove "${floor.label}"${n ? ` and its ${plural(n, "file")}` : ""}? This cannot be undone.`)) return;
    const paths = floorPaths(floor);
    p.floors.splice(fi, 1);
    saveSoon();
    renderFloors();
    deleteFiles(p.slug, paths);
  }

  function renderPlan(floor) {
    const p = editor.project;
    const box = h("div", { class: "plan-box" });
    box.append(floor.plan
      ? h("img", { class: "plan-thumb", src: assetUrl(p.slug, floor.plan), alt: `${floor.label} plan` })
      : h("div", { class: "plan-empty", text: "No floor plan" }));
    const input = h("input", { type: "file", accept: "image/*", hidden: true, onchange: () => { if (input.files[0]) uploadPlan(floor, input.files[0]); input.value = ""; } });
    box.append(
      h("div", {}, [
        h("p", { class: "label", text: "Floor plan" }),
        h("p", { class: "hint", text: floor.plan ? floor.plan.split("/").pop() : "One image; shown above the room list" }),
        h("div", { class: "toolbar", style: "margin-top:8px" }, [
          h("button", { class: "btn btn-small", onclick: () => input.click(), text: floor.plan ? "Replace plan" : "Upload plan" }),
          floor.plan ? h("button", { class: "btn btn-small btn-danger", onclick: () => removePlan(floor), text: "Remove" }) : null
        ]),
        h("div", { class: "progress", "data-progress": "plan:" + floor.id, hidden: true }),
        input
      ])
    );
    return box;
  }

  async function uploadPlan(floor, file) {
    const p = editor.project;
    const progress = document.querySelector(`[data-progress="plan:${floor.id}"]`);
    try {
      showProgress(progress, `Preparing ${file.name}`, 0);
      const img = await prepareImage(file, ORIGINAL_EDGE, ORIGINAL_QUALITY);
      const path = `floors/${floor.id}/plan-${uploadName(file.name, img.ext)}`;
      await putFile(p.slug, path, img.blob, (r) => showProgress(progress, `Uploading ${file.name}`, r));
      const old = floor.plan;
      floor.plan = path;
      saveSoon();
      renderFloors();
      if (old) deleteFiles(p.slug, [old]);
    } catch (err) {
      showProgress(progress, `${file.name}: ${errorMessage(err)}`, null, true);
      toast(`Floor plan upload failed: ${errorMessage(err)}`, true);
    }
  }

  function removePlan(floor) {
    if (!confirm(`Remove the floor plan of "${floor.label}"?`)) return;
    const old = floor.plan;
    floor.plan = null;
    saveSoon();
    renderFloors();
    deleteFiles(editor.project.slug, [old]);
  }

  // ----- Rooms -----

  function addRoom(floor) {
    const label = `Room ${floor.rooms.length + 1}`;
    floor.rooms.push({ id: uniqueId(camelCase(label), new Set(floor.rooms.map((r) => r.id)), "room"), label, images: [], medium: [] });
    saveSoon();
    renderFloors();
  }

  function renderRoom(floor, room, ri) {
    const p = editor.project;
    const card = h("div", { class: "card-sub", "data-room": room.id });
    const input = h("input", { type: "file", accept: "image/*", multiple: true, onchange: () => { if (input.files.length) uploadRenders(floor, room, Array.from(input.files)); input.value = ""; } });
    const drop = h("div", { class: "dropzone" }, [
      "Drop renders here or ",
      h("button", { class: "btn btn-small", onclick: () => input.click(), text: "Choose files" }),
      input
    ]);
    bindDrop(drop, (files) => uploadRenders(floor, room, files));
    // (append() would turn a null child into the text "null": only real nodes go in)
    const parts = [
      h("div", { class: "room-head" }, [
        h("label", { class: "field" }, [h("span", { class: "label", text: `Room ${pad(ri + 1)} · label` }), bindField(h("input", { class: "input" }), () => room.label, (v) => { room.label = v; })]),
        h("div", { class: "head-actions" }, [
          h("button", { class: "btn-icon", title: "Move up", "aria-label": "Move room up", disabled: ri === 0, onclick: () => { if (move(floor.rooms, ri, -1)) { saveSoon(); renderFloors(); } }, text: "↑" }),
          h("button", { class: "btn-icon", title: "Move down", "aria-label": "Move room down", disabled: ri === floor.rooms.length - 1, onclick: () => { if (move(floor.rooms, ri, 1)) { saveSoon(); renderFloors(); } }, text: "↓" }),
          h("button", { class: "btn-icon", title: "Remove room", "aria-label": "Remove room", onclick: () => removeRoom(floor, ri), text: "×" })
        ])
      ]),
      h("div", { class: "thumbs", "data-thumbs": room.id }, room.images.map((img, i) => renderThumb(floor, room, i))),
      room.images.length ? null : h("p", { class: "hint", style: "margin:10px 0 0", text: "No renders yet" }),
      drop,
      h("div", { class: "progress", "data-progress": "room:" + floor.id + ":" + room.id, hidden: true })
    ];
    card.append(...parts.filter(Boolean));
    return card;
  }

  function renderThumb(floor, room, i) {
    const p = editor.project;
    const src = assetUrl(p.slug, room.medium[i] || room.images[i]);
    return h("div", { class: "thumb" }, [
      h("img", { src, alt: `${room.label} ${i + 1}`, loading: "lazy" }),
      h("span", { class: "thumb-index", text: pad(i + 1) }),
      h("button", { class: "thumb-remove", title: "Remove render", "aria-label": `Remove render ${i + 1}`, onclick: () => removeRender(floor, room, i), text: "×" })
    ]);
  }

  function refreshThumbs(floor, room) {
    const host = document.querySelector(`[data-thumbs="${room.id}"]`);
    if (!host || !host.closest(`[data-floor="${floor.id}"]`)) return renderFloors();
    host.replaceChildren(...room.images.map((img, i) => renderThumb(floor, room, i)));
  }

  function removeRender(floor, room, i) {
    const paths = [room.images[i], room.medium[i]].filter(Boolean);
    room.images.splice(i, 1);
    room.medium.splice(i, 1);
    saveSoon();
    renderFloors();
    deleteFiles(editor.project.slug, paths);
  }

  function removeRoom(floor, ri) {
    const room = floor.rooms[ri];
    const n = room.images.length;
    if (!confirm(`Remove "${room.label}"${n ? ` and its ${plural(n, "render")}` : ""}? This cannot be undone.`)) return;
    const paths = roomPaths(room);
    floor.rooms.splice(ri, 1);
    saveSoon();
    renderFloors();
    deleteFiles(editor.project.slug, paths);
  }

  function bindDrop(zone, onFiles) {
    ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove("is-over"); }));
    zone.addEventListener("drop", (e) => {
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) onFiles(files);
    });
  }

  function showProgress(el, text, ratio, isError) {
    if (!el) return;
    el.hidden = false;
    // (replaceChildren() would turn a null into the text "null": build the list without it)
    const parts = [h("span", { class: isError ? "inline-error" : null, text })];
    if (ratio != null) parts.push(h("div", { class: "progress-track" }, [h("div", { class: "progress-fill", style: `width:${Math.round(ratio * 100)}%` })]));
    el.replaceChildren(...parts);
  }

  // Renders: sorted like the generator sorts files (natural order), resized in the browser,
  // uploaded a few at a time; each one is listed in the project and saved as soon as it lands.
  async function uploadRenders(floor, room, files) {
    const p = editor.project;
    const progressKey = "room:" + floor.id + ":" + room.id;
    const progress = () => document.querySelector(`[data-progress="${progressKey}"]`);
    const list = files.filter((f) => /^image\//.test(f.type) || /\.(webp|avif|jpe?g|png)$/i.test(f.name)).sort((a, b) => collator.compare(a.name, b.name));
    const skipped = files.length - list.length;
    if (!list.length) return toast("No image files in that selection", true);
    const failures = [];
    let done = 0;
    const queue = list.slice();
    showProgress(progress(), `Uploading 0 of ${list.length}`, 0);

    async function worker() {
      while (queue.length) {
        const file = queue.shift();
        try {
          const full = await prepareImage(file, ORIGINAL_EDGE, ORIGINAL_QUALITY);
          const name = uploadName(file.name, full.ext);
          const fullPath = `floors/${floor.id}/${room.id}/${name}`;
          let mediumPath = null;
          if (Math.max(full.sourceWidth, full.sourceHeight) > MEDIUM_MIN_SOURCE) {
            const medium = await prepareImage(file, MEDIUM_EDGE, MEDIUM_QUALITY, true);
            mediumPath = `floors/${floor.id}/${room.id}/medium/${name.replace(/\.[^.]+$/, "." + medium.ext)}`;
            await putFile(p.slug, mediumPath, medium.blob);
          }
          await putFile(p.slug, fullPath, full.blob);
          if (editor.project !== p) return; // editor left meanwhile: the files stay, the save is lost
          room.images.push(fullPath);
          room.medium.push(mediumPath);
          saveSoon();
        } catch (err) {
          failures.push(`${file.name}: ${errorMessage(err)}`);
        }
        done++;
        showProgress(progress(), `Uploading ${done} of ${list.length}${failures.length ? ` (${failures.length} failed)` : ""}`, done / list.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, list.length) }, worker));
    if (editor.project !== p) return;
    refreshThumbs(floor, room);
    const summary = `${list.length - failures.length} of ${list.length} renders added to ${room.label}${skipped ? `, ${skipped} non-image file(s) skipped` : ""}`;
    if (failures.length) showProgress(progress(), summary + ". Failed: " + failures.join("; "), null, true);
    else showProgress(progress(), summary, null);
    toast(summary, failures.length > 0);
    renderFloors();
    await saveNow();
  }

  // ----- Image preparation (browser-side resize, mirrors tools/make-medium-renders.js) -----

  const canEncodeWebp = (() => {
    try {
      return document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp");
    } catch (e) {
      return false;
    }
  })();

  // Returns { blob, ext, width, height, sourceWidth, sourceHeight }. A JPEG/WebP that already
  // fits the cap is uploaded as it is (no re-encoding); everything else becomes WebP (or JPEG
  // where the browser cannot encode WebP). `force` always re-encodes (for the medium copy).
  async function prepareImage(file, maxEdge, quality, force) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (err) {
      throw new Error("not a readable image");
    }
    const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const keep = !force && scale === 1 && (file.type === "image/webp" || file.type === "image/jpeg");
    if (keep) {
      bitmap.close();
      return { blob: file, ext: file.type === "image/webp" ? "webp" : "jpg", width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight };
    }
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const type = canEncodeWebp ? "image/webp" : "image/jpeg";
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error("could not encode the image");
    return { blob, ext: type === "image/webp" ? "webp" : "jpg", width, height, sourceWidth, sourceHeight };
  }

  // ----- Drawings -----

  function renderDrawings() {
    const p = editor.project;
    const host = $("drawings");
    if (!host) return;
    const files = p.documents.files;
    const input = h("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, onchange: () => { if (input.files.length) uploadDocuments(Array.from(input.files)); input.value = ""; } });
    const drop = h("div", { class: "dropzone" }, ["Drop PDFs here or ", h("button", { class: "btn btn-small", onclick: () => input.click(), text: "Choose files" }), input]);
    bindDrop(drop, uploadDocuments);
    host.replaceChildren(
      files.length
        ? h("div", { class: "stack" }, files.map((doc, di) => h("div", { class: "card-sub doc-row" }, [
          h("span", { class: "kind", text: "PDF" }),
          h("label", { class: "field" }, [h("span", { class: "label", text: `Drawing ${pad(di + 1)} · label` }), bindField(h("input", { class: "input" }), () => doc.label, (v) => { doc.label = v; })]),
          h("span", { class: "doc-file", text: doc.file.split("/").pop() }),
          h("div", { class: "head-actions" }, [
            h("button", { class: "btn-icon", title: "Move up", "aria-label": "Move drawing up", disabled: di === 0, onclick: () => { if (move(files, di, -1)) { saveSoon(); renderDrawings(); } }, text: "↑" }),
            h("button", { class: "btn-icon", title: "Move down", "aria-label": "Move drawing down", disabled: di === files.length - 1, onclick: () => { if (move(files, di, 1)) { saveSoon(); renderDrawings(); } }, text: "↓" }),
            h("button", { class: "btn-icon", title: "Remove drawing", "aria-label": "Remove drawing", onclick: () => removeDocument(di), text: "×" })
          ])
        ])))
        : h("p", { class: "hint", text: "No drawings yet: the presentation's Drawings tab says so" }),
      drop,
      h("div", { class: "progress", "data-progress": "docs", hidden: true })
    );
  }

  async function uploadDocuments(files) {
    const p = editor.project;
    const progress = () => document.querySelector('[data-progress="docs"]');
    const list = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)).sort((a, b) => collator.compare(a.name, b.name));
    if (!list.length) return toast("Only PDF files can be added as drawings", true);
    const failures = [];
    let done = 0;
    for (const file of list) {
      try {
        const path = `documents/${uploadName(file.name, "pdf")}`;
        await putFile(p.slug, path, file, (r) => showProgress(progress(), `Uploading ${file.name} (${done + 1} of ${list.length})`, (done + r) / list.length));
        if (editor.project !== p) return;
        p.documents.files.push({ file: path, label: documentLabel(file.name) });
        saveSoon();
      } catch (err) {
        failures.push(`${file.name}: ${errorMessage(err)}`);
      }
      done++;
    }
    if (editor.project !== p) return;
    renderDrawings();
    const summary = `${list.length - failures.length} of ${plural(list.length, "PDF")} added`;
    if (failures.length) showProgress(progress(), summary + ". Failed: " + failures.join("; "), null, true);
    toast(summary, failures.length > 0);
    await saveNow();
  }

  function removeDocument(di) {
    const p = editor.project;
    const doc = p.documents.files[di];
    if (!confirm(`Remove "${doc.label}"? This cannot be undone.`)) return;
    p.documents.files.splice(di, 1);
    saveSoon();
    renderDrawings();
    deleteFiles(p.slug, [doc.file]);
  }

  // ===================== TEMPLATES =====================

  const tpl = { list: null, dirty: false, timer: null, saving: null };

  function tplSaveSoon() {
    tpl.dirty = true;
    setTplState("Unsaved changes");
    clearTimeout(tpl.timer);
    tpl.timer = setTimeout(tplSaveNow, SAVE_DELAY_MS);
  }

  function setTplState(text, isError) {
    const el = $("tpl-state");
    if (el) { el.textContent = text; el.classList.toggle("is-error", !!isError); }
  }

  function tplSaveNow() {
    clearTimeout(tpl.timer);
    if (tpl.saving) return tpl.saving.then(() => (tpl.dirty ? tplSaveNow() : undefined));
    if (!tpl.dirty) return Promise.resolve();
    tpl.dirty = false;
    setTplState("Saving…");
    const templates = tpl.list.map((t) => ({
      id: t.id, name: t.name, description: t.description || "",
      floors: t.floors.map((f) => ({ label: f.label, tabLabel: f.tabLabel || undefined, rooms: f.roomsText.split("\n").map((s) => s.trim()).filter(Boolean) }))
    }));
    tpl.saving = api("PUT", "templates", { templates }).then((data) => {
      state.templates = data.templates;
      setTplState(tpl.dirty ? "Unsaved changes" : "All changes saved");
    }).catch((err) => {
      tpl.dirty = true;
      setTplState("Not saved: " + errorMessage(err), true);
    }).finally(() => { tpl.saving = null; });
    return tpl.saving;
  }

  async function renderTemplates() {
    setChrome("Templates", "The starting shape of a new project: floors and their rooms", "templates");
    state.templates = (await api("GET", "templates")).templates;
    tpl.list = state.templates.map((t) => ({
      id: t.id, name: t.name, description: t.description || "",
      floors: t.floors.map((f) => ({ label: f.label, tabLabel: f.tabLabel || "", roomsText: f.rooms.join("\n") }))
    }));
    tpl.dirty = false;
    main().replaceChildren(
      h("div", { class: "toolbar" }, [
        h("p", { class: "hint", text: "One room per line. Changing a template never changes projects already made from it." }),
        h("span", { class: "spacer" }),
        h("span", { class: "save-state", id: "tpl-state", text: "All changes saved" }),
        h("button", { class: "btn btn-primary", onclick: addTemplate, text: "New template" })
      ]),
      h("div", { id: "tpl-list", class: "stack", style: "margin-top:16px" })
    );
    renderTemplateList();
  }

  function addTemplate() {
    const name = `Template ${tpl.list.length + 1}`;
    tpl.list.push({ id: uniqueId(slugify(name), new Set(tpl.list.map((t) => t.id)), "template"), name, description: "", floors: [{ label: "Ground Floor", tabLabel: "Ground", roomsText: "" }] });
    tplSaveSoon();
    renderTemplateList();
  }

  function tplField(obj, key, input) {
    input.value = obj[key] || "";
    input.addEventListener("input", () => { obj[key] = input.value; tplSaveSoon(); });
    return input;
  }

  function renderTemplateList() {
    const host = $("tpl-list");
    if (!host) return;
    host.replaceChildren(...tpl.list.map((t, ti) => h("div", { class: "card" }, [
      h("div", { class: "floor-head" }, [
        h("label", { class: "field" }, [h("span", { class: "label", text: `Template ${pad(ti + 1)} · name` }), tplField(t, "name", h("input", { class: "input" }))]),
        h("label", { class: "field" }, [h("span", { class: "label", text: "Description" }), tplField(t, "description", h("input", { class: "input", placeholder: "optional" }))]),
        h("div", { class: "head-actions" }, [
          h("button", { class: "btn-icon", title: "Move up", "aria-label": "Move template up", disabled: ti === 0, onclick: () => { if (move(tpl.list, ti, -1)) { tplSaveSoon(); renderTemplateList(); } }, text: "↑" }),
          h("button", { class: "btn-icon", title: "Move down", "aria-label": "Move template down", disabled: ti === tpl.list.length - 1, onclick: () => { if (move(tpl.list, ti, 1)) { tplSaveSoon(); renderTemplateList(); } }, text: "↓" }),
          h("button", { class: "btn-icon", title: "Delete template", "aria-label": "Delete template", onclick: () => { if (confirm(`Delete the template "${t.name}"?`)) { tpl.list.splice(ti, 1); tplSaveSoon(); renderTemplateList(); } }, text: "×" })
        ])
      ]),
      h("p", { class: "hint", style: "margin:8px 0 0", text: `id: ${t.id}` }),
      h("div", { class: "rooms" }, [
        h("div", { class: "section-head" }, [h("h3", { class: "section-title", text: "Floors" }), h("button", { class: "btn btn-small", onclick: () => { t.floors.push({ label: `Floor ${t.floors.length + 1}`, tabLabel: "", roomsText: "" }); tplSaveSoon(); renderTemplateList(); }, text: "Add floor" })]),
        h("div", { class: "stack" }, t.floors.map((f, fi) => h("div", { class: "card-sub" }, [
          h("div", { class: "floor-head" }, [
            h("label", { class: "field" }, [h("span", { class: "label", text: `Floor ${pad(fi + 1)} · label` }), tplField(f, "label", h("input", { class: "input" }))]),
            h("label", { class: "field narrow" }, [h("span", { class: "label", text: "Tab (short)" }), tplField(f, "tabLabel", h("input", { class: "input", placeholder: "one word" }))]),
            h("div", { class: "head-actions" }, [
              h("button", { class: "btn-icon", title: "Move up", "aria-label": "Move floor up", disabled: fi === 0, onclick: () => { if (move(t.floors, fi, -1)) { tplSaveSoon(); renderTemplateList(); } }, text: "↑" }),
              h("button", { class: "btn-icon", title: "Move down", "aria-label": "Move floor down", disabled: fi === t.floors.length - 1, onclick: () => { if (move(t.floors, fi, 1)) { tplSaveSoon(); renderTemplateList(); } }, text: "↓" }),
              h("button", { class: "btn-icon", title: "Remove floor", "aria-label": "Remove floor", disabled: t.floors.length === 1, onclick: () => { t.floors.splice(fi, 1); tplSaveSoon(); renderTemplateList(); }, text: "×" })
            ])
          ]),
          h("label", { class: "field", style: "margin-top:10px" }, [h("span", { class: "label", text: "Rooms, one per line" }), tplField(f, "roomsText", h("textarea", { class: "textarea", placeholder: "Reception\nKitchen\n…" }))])
        ])))
      ])
    ])));
  }

  // ===================== START =====================

  async function start() {
    if (!location.pathname.endsWith("/")) return location.replace(location.pathname + "/" + location.search + location.hash);
    bindNewDialog();
    window.addEventListener("hashchange", render);
    window.addEventListener("beforeunload", (e) => {
      if ((editor.project && editor.dirty) || tpl.dirty) { e.preventDefault(); e.returnValue = ""; }
    });
    try {
      const me = await api("GET", "me");
      state.user = me.user;
      $("adm-user").textContent = me.user.mode === "access" ? `Signed in as ${me.user.email}` : "Local development · no sign-in required";
    } catch (err) {
      $("adm-user").textContent = "Could not reach the admin API: " + errorMessage(err);
    }
    render();
  }

  start();
})();
