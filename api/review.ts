// Vercel 함수: 설계변경 1건 검토 (새 엔진 · 데이터 계약 DB)
//   GET  /api/review?dataset=lng10&change=DC-021[&events=MES-001,ERP-001][&priority=cost,schedule][&decide=YYYY-MM-DD]
//   POST /api/review { dataset, change, events?, decide?, priority?, conditions?, confirmations?, before? }
//        before를 같이 보내면 그 입력으로 계산한 결과와 비교한 '달라진 것'(changes)도 준다 (갱신하기 · 팀 확인 · 조건 바꾸기 공통)
//   저장된 기록(팀 확인 · 결정 · 위임 · 갱신하기, /api/records)은 서버가 알아서 합친다. 요청의 events · confirmations는 그 위에 얹는 '만약에'
import { diffReviews, loadOntology, reviewChange } from "../server/engine/index.js"
import { BadRequest, fromQuery, parseReviewRequest, type ReviewRequest, type ReviewState } from "../server/engine/request.js"
import { loadDataset } from "../server/records.js"

export const maxDuration = 30

async function handle(req: ReviewRequest): Promise<Response> {
  let ds
  try {
    ds = await loadDataset(req.dataset)
  } catch {
    return Response.json({ error: `데이터셋이 없어요: ${req.dataset}` }, { status: 404 })
  }
  const ontology = loadOntology(req.dataset) // 비슷한 사례 · 연결 경로 · 공통/호선마다는 온톨로지로
  const run = (s: ReviewState) => {
    const w = ds.world(s.events)
    if (!w.change.has(req.change)) return null
    return reviewChange(w, req.change, { decisionDay: s.decide, priority: s.priority, conditions: s.conditions, confirmations: s.confirmations, ontology })
  }
  const review = run(req)
  if (!review) return Response.json({ error: `변경이 없거나 아직 알려지지 않았어요: ${req.change} (회의 중 들어오는 변경이면 events에 등록 이벤트를 넣어요)` }, { status: 404 })
  const before = req.before ? run(req.before) : null
  return Response.json({ review, changes: before ? diffReviews(before, review) : [], records: ds.records })
}

async function guarded(read: () => Promise<unknown> | unknown) {
  try {
    return await handle(parseReviewRequest(await read()))
  } catch (error) {
    if (error instanceof BadRequest || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 })
    return Response.json({ error: error instanceof Error ? error.message : "계산하지 못했어요" }, { status: 500 })
  }
}

export const GET = (request: Request) => guarded(() => fromQuery(new URL(request.url).searchParams))
export const POST = (request: Request) => guarded(() => request.json())
