// Vercel 함수: AI 설명 (RAG의 G) — POST /api/explain { dataset, change, events?, decide?, priority?, conditions?, confirmations?, ai? }
//   서버가 엔진으로 다시 계산한 결과와 찾은 사례만 AI에게 준다 (화면이 보낸 숫자를 믿지 않는다)
//   → { explanation: { source: "ai" | "rule", provider, note, summary, options, cases }, cached }
//   미리 만든 설명(db/ai/<dataset>.json, npm run explain:eval -- --save)이 있으면 그걸 쓰고,
//   AI 키가 없거나 실패하면 정해진 틀 문장(source = "rule")을 준다 → 화면은 늘 설명을 받는다
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadOntology, reviewChange } from "../server/engine/index.js"
import { BadRequest, fromQuery, parseReviewRequest } from "../server/engine/request.js"
import { loadDataset } from "../server/records.js"
import { aiConfigured, explain, explainFacts, explainKey, type Explanation } from "../server/explain.js"
import { countAi, overQuota } from "../server/quota.js"

export const maxDuration = 60
const memory = new Map<string, Explanation>()

function precomputed(dataset: string, key: string): Explanation | null {
  const file = join(process.cwd(), "db", "ai", `${dataset}.json`)
  if (!existsSync(file)) return null
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, Explanation>
  return all[key] ?? null
}

async function handle(request: Request, raw: Record<string, unknown>): Promise<Response> {
  const req = parseReviewRequest(raw)
  let ds
  try {
    ds = await loadDataset(req.dataset)
  } catch {
    return Response.json({ error: `데이터셋이 없어요: ${req.dataset}` }, { status: 404 })
  }
  const w = ds.world(req.events) // 저장된 기록(팀 확인 · 결정 · 갱신하기)까지 합친 상태로 설명
  if (!w.change.has(req.change)) return Response.json({ error: `변경이 없거나 아직 알려지지 않았어요: ${req.change}` }, { status: 404 })
  const review = reviewChange(w, req.change, { decisionDay: req.decide, priority: req.priority, conditions: req.conditions, confirmations: req.confirmations, ontology: loadOntology(req.dataset) })
  const key = explainKey(explainFacts(review))
  const saved = memory.get(key) ?? precomputed(req.dataset, key)
  if (saved) return Response.json({ explanation: saved, cached: true })
  const useAi = raw.ai !== false && raw.ai !== "0" && aiConfigured()
  if (useAi) {
    const over = await overQuota(request)
    if (over) return Response.json({ explanation: await explain(review, { useAi: false }), cached: false, note: "AI 요청이 너무 많아 정해진 틀로 설명해요" })
  }
  const explanation = await explain(review, { useAi })
  if (explanation.source === "ai") {
    memory.set(key, explanation)
    await countAi(request)
  }
  return Response.json({ explanation, cached: false })
}

async function guarded(request: Request, read: () => Promise<unknown> | unknown) {
  try {
    return await handle(request, ((await read()) ?? {}) as Record<string, unknown>)
  } catch (error) {
    if (error instanceof BadRequest || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 })
    return Response.json({ error: error instanceof Error ? error.message : "설명하지 못했어요" }, { status: 500 })
  }
}

export const GET = (request: Request) => guarded(request, () => fromQuery(new URL(request.url).searchParams))
export const POST = (request: Request) => guarded(request, () => request.json())
