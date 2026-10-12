import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

const repo = "https://github.com/aditya-vinodh/storage";

// The landing page is public/index.html, served at /. The docs live under /docs/.
export default defineConfig({
  site: "https://storage.example.com",
  integrations: [
    starlight({
      title: "aditya-vinodh/storage",
      description: "File storage for agents and people: versioned, shareable, and safe to hand to an agent.",
      logo: { light: "./src/assets/logo.svg", dark: "./src/assets/logo-dark.svg" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      customCss: ["./src/styles/custom.css"],
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true } },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Instrument+Sans:wght@400;500;600&display=swap",
          },
        },
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
        styleOverrides: { codeFontFamily: "var(--sl-font)", uiFontFamily: "var(--sl-font)" },
      },
      sidebar: [
        { label: "Start here", items: ["docs", "docs/quickstart", "docs/concepts"] },
        {
          label: "Guides",
          items: ["docs/guides/agents", "docs/guides/sharing", "docs/guides/lifecycle", "docs/guides/pull-requests"],
        },
        { label: "Reference", items: ["docs/reference/cli"] },
        {
          label: "Self-hosting",
          items: [
            "docs/self-hosting/run",
            "docs/self-hosting/railway",
            "docs/self-hosting/sign-in",
            "docs/self-hosting/configuration",
          ],
        },
      ],
      plugins: [starlightLlmsTxt({ projectName: "aditya-vinodh/storage" })],
    }),
  ],
});
