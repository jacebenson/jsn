// Eleventy config for the jsn docs site.
// docs/ is its own standalone npm project (docs/package.json) so the docs build
// never installs the CLI's runtime deps (better-sqlite3 needs node-gyp + Python,
// which Nixpacks' Node image doesn't have — that's what broke the Coolify build).
// All paths below are relative to the docs/ project root (where eleventy runs).
// Run from repo root:  npm run docs        (build)
//                      npm run docs:serve  (dev server)
// Or from docs/:       npm run build / npm run serve
export default function (eleventyConfig) {
  // Static assets copied to the output as-is.
  // Paths are relative to this file's project root (docs/).
  eleventyConfig.addPassthroughCopy("css");
  eleventyConfig.addPassthroughCopy("assets");

  // Render a verdict object as a table cell.
  // v: { v: yes|no|partial|unknown|na|info, note?: string }
  eleventyConfig.addFilter("verdictCell", (v) => {
    const map = {
      yes: ["ok", "✅"],
      no: ["no", "❌"],
      partial: ["part", "⚠️"],
      unknown: ["unk", "?"],
      na: ["no", "—"],
      info: ["inst", ""],
    };
    const [cls, glyph] = (v && map[v.v]) || ["unk", "?"];
    const note = v && v.note ? ` <span class="inst">${v.note}</span>` : "";
    return `<td class="${cls}">${glyph}${note}</td>`;
  });

  // Break long commands onto multiple lines with backslash continuations,
  // splitting before each --flag. Short commands stay on one line.
  eleventyConfig.addFilter("wrapCmd", (cmd) => {
    if (typeof cmd !== "string" || cmd.length <= 64) return cmd;
    const parts = cmd.split(/\s+(?=--)/);
    if (parts.length <= 1) return cmd;
    return parts.join(" \\\n    ");
  });

  // Short label for the terminal title bar: first three tokens.
  eleventyConfig.addFilter("cmdName", (cmd) => {
    if (typeof cmd !== "string") return "";
    return cmd.split(/\s+/).slice(0, 3).join(" ");
  });

  return {
    dir: {
      input: ".",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
  };
}
