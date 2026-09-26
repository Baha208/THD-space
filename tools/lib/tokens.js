/* Reads brand colours from engine/tokens.css, the single source of truth. Plain Node (no
   packages), so scripts that don't need sharp can use it too. */
"use strict";

const path = require("path");
const fs = require("fs");

const TOKENS = path.join(__dirname, "..", "..", "engine", "tokens.css");

// "--ink" → "#231F20" (as written in tokens.css). Only plain 6-digit hex tokens.
function readToken(name) {
  const css = fs.readFileSync(TOKENS, "utf8");
  const m = css.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})"));
  if (!m) throw new Error("--" + name + " not found in engine/tokens.css");
  return m[1];
}

module.exports = { readToken };
