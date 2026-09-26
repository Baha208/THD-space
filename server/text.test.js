import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, camelCase, titleCase, documentLabel, uniqueId, naturalSort, uploadName } from "./text.js";

test("slugify matches the generator", () => {
  assert.equal(slugify("Ground Floor Level"), "ground-floor-level");
  assert.equal(slugify("  Inas El Baily’s Villa "), "inas-el-baily-s-villa");
  assert.equal(slugify("فيلا"), "");
});

test("camelCase and titleCase match the generator", () => {
  assert.equal(camelCase("master bedroom"), "masterBedroom");
  assert.equal(camelCase("First floor lobby"), "firstFloorLobby");
  assert.equal(titleCase("guest toilet"), "Guest Toilet");
});

test("documentLabel keeps all-caps words", () => {
  assert.equal(documentLabel("GF-electrical_layout.pdf"), "GF Electrical Layout");
  assert.equal(documentLabel("Working documents/Testing document.pdf"), "Testing Document");
});

test("uniqueId appends -2, -3", () => {
  const taken = new Set(["bathroom", "bathroom-2"]);
  assert.equal(uniqueId("bathroom", taken), "bathroom-3");
  assert.equal(uniqueId("", new Set(), "room"), "room");
});

test("naturalSort puts 2 before 10", () => {
  assert.deepEqual(naturalSort(["r10.webp", "r2.webp", "r1.webp"]), ["r1.webp", "r2.webp", "r10.webp"]);
});

test("uploadName is url-safe and unique", () => {
  const a = uploadName("Reception View 01.JPG", "webp");
  const b = uploadName("Reception View 01.JPG", "webp");
  assert.match(a, /^reception-view-01-[a-z0-9]{6}\.webp$/);
  assert.notEqual(a, b);
});
