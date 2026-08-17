// Global data: feature showcases for the hero + per-feature pages.
// Merges showcase metadata with captured demo output text.
import { readFileSync } from "node:fs";

const raw = JSON.parse(
  readFileSync(new URL("./showcase-data.json", import.meta.url), "utf8")
);

export default raw.map((s) => ({
  ...s,
  demoText: s.demo
    ? readFileSync(new URL(`./demos/${s.demo}.txt`, import.meta.url), "utf8")
    : "",
}));
