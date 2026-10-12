// Read-only WebMCP helpers for browser agents on the JSN docs site.
// WebMCP is an early-preview browser API. The docs remain fully usable without it.
(() => {
  const modelContext = document.modelContext;
  if (!modelContext?.registerTool) return;

  const textFrom = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, nav, footer, [aria-hidden='true']").forEach((el) => el.remove());
    return (doc.querySelector("main") || doc.body).innerText.replace(/\s+/g, " ").trim();
  };

  const safeUrl = (value) => {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith("/")) {
      throw new Error("Only pages on the JSN documentation site can be opened.");
    }
    return url;
  };

  modelContext.registerTool({
    name: "jsn_docs_search",
    description: "Search the public JSN documentation pages. Returns matching page titles, URLs, and short excerpts. Read-only.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to find in JSN docs." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ query }) => {
      const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      if (!terms.length) return "Enter a search query.";
      const response = await fetch("/sitemap.xml", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not load the JSN docs sitemap.");
      const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
      const urls = [...xml.querySelectorAll("loc")].map((node) => {
        const sitemapUrl = new URL(node.textContent, location.origin);
        return safeUrl(`${sitemapUrl.pathname}${sitemapUrl.search}`).href;
      }).slice(0, 80);
      const pages = await Promise.all(urls.map(async (url) => {
        try {
          const page = await fetch(url, { credentials: "same-origin" });
          if (!page.ok) return null;
          const html = await page.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          const title = doc.querySelector("h1")?.innerText || doc.title || url;
          const body = textFrom(html);
          const haystack = `${title} ${body}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (haystack.split(term).length - 1), 0);
          if (!score) return null;
          const at = Math.max(0, body.toLowerCase().indexOf(terms[0]));
          return { title, url, excerpt: body.slice(Math.max(0, at - 100), at + 240), score };
        } catch { return null; }
      }));
      const results = pages.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);
      return results.length ? JSON.stringify(results) : "No matching JSN documentation pages found.";
    },
  });

  modelContext.registerTool({
    name: "jsn_docs_read_page",
    description: "Read the visible content of a JSN docs page. Only same-site URLs are allowed. Read-only.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "A JSN docs URL or path." } },
      required: ["url"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async ({ url }) => {
      const target = safeUrl(url);
      const response = await fetch(target.href, { credentials: "same-origin" });
      if (!response.ok) return `Page returned HTTP ${response.status}.`;
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const title = doc.querySelector("h1")?.innerText || doc.title || target.pathname;
      return `${title}\n\n${textFrom(html).slice(0, 12000)}`;
    },
  });
})();
