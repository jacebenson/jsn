// Eleventy config for the jsn docs site.
// Paths resolve from the project root (repo root) — that's where `npm run docs` runs.
// Run from repo root:  npm run docs        (build)
//                      npm run docs:serve  (dev server)
export default function (eleventyConfig) {
  // Static assets copied to the output as-is
  eleventyConfig.addPassthroughCopy("docs/css");
  eleventyConfig.addPassthroughCopy("docs/assets");

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
      input: "docs",
      output: "docs/_site",
      includes: "_includes",
      data: "_data",
    },
  };
}
