/* ===== THD Space server — web app manifest for a served project =====
   The same manifest engine/generate-manifest.js writes to a project folder (webManifest there),
   built on request from project.json's title and --ink in engine/tokens.css. */

const ICON_SIZES = [48, 72, 96, 128, 144, 152, 180, 192, 384, 512];
const MASKABLE_SIZES = [192, 512];

export function inkFromTokens(css) {
  const m = String(css).match(/--ink:\s*([^;]+);/);
  if (!m) throw new Error("--ink not found in engine/tokens.css");
  return m[1].trim();
}

export function webManifest(project, ink, engineRel = "../../engine") {
  const icon = (size, purpose) => Object.assign(
    { src: `${engineRel}/images/icons/icon-${purpose === "maskable" ? "maskable-" : ""}${size}.png`, sizes: `${size}x${size}`, type: "image/png" },
    purpose ? { purpose } : {}
  );
  const icons = [];
  for (const size of ICON_SIZES) {
    icons.push(icon(size, MASKABLE_SIZES.includes(size) ? "any" : undefined));
    if (MASKABLE_SIZES.includes(size)) icons.push(icon(size, "maskable"));
  }
  return {
    name: `${project.title} — THD Studio`,
    short_name: "THD Studio",
    start_url: ".",
    scope: ".",
    display: "standalone",
    background_color: ink,
    theme_color: ink,
    icons
  };
}
