import { readFileSync } from "node:fs";

export default JSON.parse(
  readFileSync(new URL("./seo-features.json", import.meta.url), "utf8")
);
