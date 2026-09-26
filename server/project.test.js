import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newProject, normalizeProject, validateProject, isSafePath, buildIndex, summarize, referencedPaths, validateTemplates, cleanTemplates } from "./project.js";
import { DEFAULT_TEMPLATES } from "./templates-default.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const villaFile = path.join(here, "..", "projects", "inas-el-baily-villa", "project.json");

test("the villa's generated project.json passes the publish checks", { skip: !fs.existsSync(villaFile) && "villa not checked out" }, () => {
  const p = normalizeProject(JSON.parse(fs.readFileSync(villaFile, "utf8")));
  p.status = "published";
  assert.deepEqual(validateProject(p, { forPublish: true }), []);
  const counts = summarize(p);
  assert.equal(counts.floors, 3);
  assert.ok(counts.images > 100);
  // one medium copy per render, except originals of 1600 px or less (tools/make-medium-renders.js)
  const mediums = p.floors.reduce((n, f) => n + f.rooms.reduce((m, r) => m + r.medium.filter(Boolean).length, 0), 0);
  assert.ok(mediums > 0 && mediums <= counts.images);
  assert.equal(referencedPaths(p).length, counts.plans + counts.images + mediums + counts.documents);
});

test("newProject from the villa template has unique ids and no images", () => {
  const p = newProject({ client: " Client ", title: "Test Villa", slug: "test-villa", template: DEFAULT_TEMPLATES[0] });
  assert.equal(p.client, "Client");
  assert.equal(p.status, "draft");
  assert.deepEqual(validateProject(p), []);
  assert.deepEqual(p.floors.map((f) => f.id), ["ground-floor", "first-floor", "roof-floor"]);
  assert.equal(p.floors[0].tabLabel, "Ground");
  assert.equal(p.floors[0].rooms[0].id, "reception");
  assert.ok(p.floors.every((f) => f.plan === null && f.rooms.every((r) => r.images.length === 0)));
  // not publishable yet: no plans, no renders
  const errors = validateProject(p, { forPublish: true });
  assert.ok(errors.some((e) => /no floor plan yet/.test(e)));
  assert.ok(errors.some((e) => /no renders yet/.test(e)));
});

test("duplicate room labels on one floor get distinct ids", () => {
  const p = newProject({ client: "c", title: "t", slug: "t", template: { id: "x", floors: [{ label: "L", rooms: ["Bathroom", "bathroom", "Bathroom"] }] } });
  assert.deepEqual(p.floors[0].rooms.map((r) => r.id), ["bathroom", "bathroom-2", "bathroom-3"]);
});

test("validateProject catches the generator's error cases", () => {
  const p = newProject({ client: "c", title: "t", slug: "Bad Slug", template: DEFAULT_TEMPLATES[1] });
  p.floors.push(Object.assign({}, p.floors[0]));
  p.floors[0].rooms[0].images = ["../escape.webp", "floors/x/ok.webp"];
  p.floors[0].rooms[0].medium = [null];
  p.documents.files.push({ file: "documents/plan.txt", label: "" });
  const errors = validateProject(p);
  assert.ok(errors.some((e) => /slug/.test(e)));
  assert.ok(errors.some((e) => /duplicate floor id/.test(e)));
  assert.ok(errors.some((e) => /escape\.webp/.test(e)));
  assert.ok(errors.some((e) => /medium must list one entry/.test(e)));
  assert.ok(errors.some((e) => /not a valid PDF path/.test(e)));
  assert.ok(errors.some((e) => /label is empty/.test(e)));
});

test("isSafePath", () => {
  assert.ok(isSafePath("3d views & working documents/ground floor level/floor plan/Ground floor plan.webp"));
  assert.ok(isSafePath("floors/ground/plan-ab12cd.webp"));
  for (const bad of ["", "/abs.webp", "a/../b.webp", "./a.webp", "a//b.webp", "a\\b.webp", "project.json", "sw.js", " lead.webp", "x\u0000.webp"]) {
    assert.equal(isSafePath(bad), false, bad);
  }
});

test("buildIndex lists published projects sorted by title", () => {
  const index = buildIndex([
    { slug: "b", client: "B", title: "Villa 10", status: "published" },
    { slug: "a", client: "A", title: "Villa 2", status: "published" },
    { slug: "c", client: "C", title: "Draft", status: "draft" },
    { slug: "d", client: "D", title: "Gone", status: "deleted" }
  ]);
  assert.deepEqual(index, { projects: [{ slug: "a", client: "A", title: "Villa 2" }, { slug: "b", client: "B", title: "Villa 10" }] });
});

test("normalizeProject fills medium and documents", () => {
  const p = normalizeProject({ slug: "x", client: "c", title: "t", floors: [{ id: "f", label: "F", rooms: [{ id: "r", label: "R", images: ["a.webp", "b.webp"], medium: ["a-m.webp"] }] }], documents: { files: ["docs/x.pdf"] } });
  assert.equal(p.status, "draft");
  assert.deepEqual(p.floors[0].rooms[0].medium, ["a-m.webp", null]);
  assert.deepEqual(p.documents.files, [{ file: "docs/x.pdf", label: "x.pdf" }]);
});

test("templates validate and clean", () => {
  assert.deepEqual(validateTemplates(DEFAULT_TEMPLATES), []);
  const errors = validateTemplates([{ id: "Bad", name: "", floors: [] }, { id: "a", name: "A", floors: [{ label: "L", rooms: ["", "Ok"] }] }, { id: "a", name: "Dup", floors: [{ label: "L", rooms: [] }] }]);
  assert.ok(errors.length >= 4);
  const cleaned = cleanTemplates([{ id: " a ", name: " A ", floors: [{ label: " L ", tabLabel: "", rooms: [" R ", { label: "S" }] }] }]);
  assert.deepEqual(cleaned, [{ id: "a", name: "A", description: "", floors: [{ label: "L", rooms: ["R", "S"] }] }]);
});
