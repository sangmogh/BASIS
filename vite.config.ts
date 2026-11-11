import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import fs from "node:fs"
import path from "node:path"

// 로컬 개발 서버(npm run dev)에서도 Vercel 함수(api/*.ts)를 같은 주소 · 메서드로 돌린다
function localApi(): Plugin {
  let dev: ViteDevServer | null = null
  return {
    name: "basis-local-api",
    configureServer(server) {
      dev = server
      server.middlewares.use("/api", async (req, res, next) => {
        const [route, query = ""] = (req.url ?? "").replace(/^\//, "").split("?")
        if (!/^[a-z-]+$/.test(route) || !fs.existsSync(path.resolve(import.meta.dirname, "api", `${route}.ts`))) return next()
        const method = req.method ?? "GET"
        const handler = ((await dev!.ssrLoadModule(`/api/${route}.ts`)) as Record<string, unknown>)[method]
        if (typeof handler !== "function") {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks: Buffer[] = []
        if (method !== "GET" && method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer)
        const headers = new Headers()
        Object.entries(req.headers).forEach(([k, v]) => typeof v === "string" && headers.set(k, v))
        const response: Response = await handler(
          new Request(`http://localhost/api/${route}${query ? `?${query}` : ""}`, {
            method,
            headers,
            body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
          }),
        )
        res.statusCode = response.status
        res.setHeader("content-type", response.headers.get("content-type") ?? "application/json; charset=utf-8")
        res.end(await response.text())
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // AI 인증 정보는 서버 쪽 process.env로만 넘긴다 (VITE_ 접두어가 없어 브라우저 번들에는 들어가지 않는다)
  // Gemini: GEMINI_API_KEY (있으면 이걸 쓴다) / Anthropic 직접: ANTHROPIC_API_KEY / 학교 BAZE 게이트웨이: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
  const env = loadEnv(mode, process.cwd(), "")
  for (const name of ["GEMINI_API_KEY", "GEMINI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_MODEL", "BASIS_EVENTS_TOKEN"])
    if (env[name] && !process.env[name]) process.env[name] = env[name]
  return {
    plugins: [react(), tailwindcss(), localApi()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
  }
})
