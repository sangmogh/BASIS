// Vercel 함수: 사례 검색 (메뉴 3)
//   GET /api/cases?dataset=lng10                         → 첫 화면: 예시 질문 · 데이터 범위 · 전체 사례 목록
//   GET /api/cases?dataset=lng10&q=질문[&state=][&reason=][&ai=0]
//        → 알아들은 조건 · 요약 · 찾은 기록(최대 3건) · 좁혀 보기
//        state(installed 등) · reason(owner_request 등)은 '좁혀 보기'로 조건만 바꿔 다시 찾을 때
//   GET /api/cases?dataset=lng10&case=HX-011             → 사례 1건 자세히
// 찾기는 엔진 데이터 + 문장 검색(AI 없음). AI는 질문을 조건으로 바꾸고, 찾은 기록만 설명한다 (server/caseQuery.ts)
// AI 키가 없거나 실패하면 규칙으로 알아듣고 정해진 틀로 설명한다 → 화면은 늘 답을 받는다
import { loadOntology } from "../server/engine/index.js"
import { allCases, caseDetail, isGroupKey, scopeOf } from "../server/caseSearch.js"
import { exampleQuestions, searchKey, searchOnce, type SearchResult } from "../server/caseQuery.js"
import { aiConfigured } from "../server/explain.js"
import { countAi, overQuota } from "../server/quota.js"
import { loadDataset } from "../server/records.js"

export const maxDuration = 60
const memory = new Map<string, SearchResult>()

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const dataset = params.get("dataset") ?? ""
  const caseId = params.get("case")
  const q = (params.get("q") ?? "").trim()
  const state = params.get("state") ?? ""
  const reason = params.get("reason") ?? ""
  if (!/^[a-z0-9_-]{1,40}$/i.test(dataset)) return Response.json({ error: "dataset이 필요해요" }, { status: 400 })
  if (caseId != null && !/^[A-Z0-9_-]{1,20}$/i.test(caseId)) return Response.json({ error: "case 형식이 맞지 않아요" }, { status: 400 })
  if (q.length > 200) return Response.json({ error: "질문은 200자까지예요" }, { status: 400 })
  if (state && !isGroupKey(state)) return Response.json({ error: "state 값이 맞지 않아요" }, { status: 400 })
  if (reason && !/^[a-z_]{1,40}$/.test(reason)) return Response.json({ error: "reason 값이 맞지 않아요" }, { status: 400 })
  let ds
  try {
    ds = await loadDataset(dataset)
  } catch {
    return Response.json({ error: `데이터셋이 없어요: ${dataset}` }, { status: 404 })
  }
  try {
    const w = ds.world() // 저장된 기록(결정 · 갱신하기)까지 합친 상태
    const onto = loadOntology(dataset)
    if (caseId) {
      const detail = caseDetail(w, caseId)
      return detail ? Response.json({ case: detail }) : Response.json({ error: `사례가 없어요: ${caseId}` }, { status: 404 })
    }
    if (!q) return Response.json({ dataset: { id: dataset, name: w.dataset.name }, ai: aiConfigured(), examples: exampleQuestions(w, onto), scope: scopeOf(w), all: allCases(w) })

    const overrides = { state: isGroupKey(state) ? state : undefined, reason: reason || undefined }
    const wantAi = params.get("ai") !== "0" // ai=0이면 캐시에 저장된 AI 답도 쓰지 않는다 (키가 다르다)
    const key = searchKey(dataset, q, overrides, wantAi)
    const saved = memory.get(key)
    if (saved) return Response.json({ ...saved, cached: true })
    let useAi = wantAi && aiConfigured()
    if (useAi && (await overQuota(request))) useAi = false
    const result = await searchOnce(w, onto, q, { useAi, overrides })
    if (result.source === "ai" || result.understood.source === "ai") {
      memory.set(key, result)
      await countAi(request)
    }
    return Response.json({ ...result, cached: false })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "사례를 찾지 못했어요" }, { status: 500 })
  }
}
