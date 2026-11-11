// Vercel 함수: 직접 입력 문장 → 부재 종류 후보 (온톨로지 용어 체계: 이름 · 다른 이름)
//   GET /api/match?dataset=lng10&text=갑판 관통 슬리브를 스테인리스로
//   → { candidates: [{ code, label, group, matched, score, parts: [{ partId, label, places, zone }] }] }
// 고르는 건 사람이다 (후보와 그 부재 종류의 부품 · 놓인 구역을 보여 줄 뿐)
import { loadOntology, matchPartKinds, partsOfKind } from "../server/engine/index.js"

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const dataset = params.get("dataset") ?? ""
  const text = (params.get("text") ?? "").trim()
  if (!/^[a-z0-9_-]{1,40}$/i.test(dataset)) return Response.json({ error: "dataset이 필요해요" }, { status: 400 })
  if (!text || text.length > 500) return Response.json({ error: "text는 1~500자예요" }, { status: 400 })
  try {
    const onto = loadOntology(dataset)
    if (!onto) return Response.json({ error: `온톨로지가 없어요: ${dataset}` }, { status: 404 })
    const candidates = matchPartKinds(onto, text).map((c) => ({ ...c, parts: partsOfKind(onto, c.code) }))
    return Response.json({ text, candidates, source: "온톨로지 용어 체계 (skos:prefLabel · altLabel)" })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "맞추지 못했어요" }, { status: 500 })
  }
}
