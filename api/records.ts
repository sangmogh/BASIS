// Vercel 함수: 서비스 기록 (팀 확인 · 위임 · 결정 · 결재 · 재검토 · 갱신하기) — 설명은 server/records.ts
//   GET    /api/records?dataset=lng10[&since=버전]  → { storage, version, changed, rows, appliedEvents }
//   GET    /api/records?dataset=lng10&form=change  → 변경 등록 화면 재료 { parts, reasons, requesters }
//   POST   action: register { parts: [부품 ID], spec_before?, spec_after, reason, requester_kind: employee|counterparty, requester_id?, original_text, title? }
//          → 직접 입력 변경 1건 등록 (번호는 서버가 정함, 응답의 change)
//          since가 지금 버전과 같으면 { version, changed: false }만 (화면이 몇 초마다 물어봐도 가볍게)
//   POST   /api/records { dataset, action, actor, ... }  → { ok, version, written, review, changes }
//          action: confirm { change, task_code, hull_id?, answer: ok|not_ok, edited_days?, reason?, memo?, spoken_by? }
//                  delegate { change, to, reason? } · decide { change, option, rationale?, priority?, conditions?, decide? }
//                  approve { approval_id, answer: approved|rejected, comment? } · reopen { change, reason }
//                  apply_events { events: [...], change? }
//   DELETE /api/records?dataset=lng10  → 저장된 기록을 비워 DB 초기값으로 (시연 다시 하기)
//   누가 하는지(actor)는 로그인 세션(Authorization: Bearer, /api/auth)으로 정한다. 요청의 actor는 무시
//   배포된 사이트에서는 로그인 없이 쓰기(POST · DELETE)를 막는다(401). 로컬 · 테스트는 요청의 actor도 받는다
import { sessionRequired, sessionUser } from "../server/auth.js"
import { BadRequest } from "../server/engine/request.js"
import { changeFormOptions, clearRecords, Conflict, foldRecords, Forbidden, NoStorage, NotFound, readRecords, recordsVersion, writeRecord } from "../server/records.js"

export const maxDuration = 30

const datasetOf = (request: Request) => {
  const v = new URL(request.url).searchParams.get("dataset")
  return v && /^[a-z0-9_-]{1,40}$/i.test(v) ? v : null
}

function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : "기록하지 못했어요"
  const status =
    error instanceof BadRequest || error instanceof SyntaxError ? 400
    : error instanceof Forbidden ? 403
    : error instanceof NotFound ? 404
    : error instanceof Conflict ? 409
    : error instanceof NoStorage ? 503
    : 500
  return Response.json({ error: message }, { status })
}

export async function GET(request: Request): Promise<Response> {
  const dataset = datasetOf(request)
  if (!dataset) return Response.json({ error: "dataset이 필요해요" }, { status: 400 })
  try {
    // 변경 등록 화면 재료 (부품 · 사유 · 요청자)
    if (new URL(request.url).searchParams.get("form") === "change") return Response.json(await changeFormOptions(dataset))
    const since = new URL(request.url).searchParams.get("since")
    if (since != null) {
      const version = await recordsVersion(dataset)
      if (String(version) === since) return Response.json({ version, changed: false })
    }
    const { storage, version, entries } = await readRecords(dataset)
    const { rows, appliedEvents } = foldRecords(entries)
    return Response.json({ storage, version, changed: true, rows, appliedEvents })
  } catch (error) {
    return failure(error)
  }
}

const needLogin = () => Response.json({ error: "로그인이 필요해요" }, { status: 401 })

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await sessionUser(request)
    if (!user && sessionRequired()) return needLogin()
    const body = (await request.json()) as Record<string, unknown>
    return Response.json(await writeRecord(user ? { ...body, actor: user.employeeId } : body))
  } catch (error) {
    return failure(error)
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const dataset = datasetOf(request)
  if (!dataset) return Response.json({ error: "dataset이 필요해요" }, { status: 400 })
  try {
    if (!(await sessionUser(request)) && sessionRequired()) return needLogin()
    await clearRecords(dataset)
    return Response.json({ ok: true, version: 0 })
  } catch (error) {
    return failure(error)
  }
}
