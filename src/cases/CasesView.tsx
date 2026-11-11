// 사례 (메뉴 3): 지금 고민을 자기 말로 물으면, 실제 과거 기록에서 찾아 설명한다
//   /api/cases → server/caseQuery.ts: 질문 → 조건(AI 또는 규칙, 부재 이름은 온톨로지 용어) → 기록 찾기(AI 없음) → 찾은 기록만 설명
//   무엇을 물을지 모르는 사람을 위해 예시 질문(결정을 기다리는 변경의 부재 · 호선 상태로 만든 것)을 보여 준다
//   채팅이 아니라 검색: 이어서 묻는 대신 '좁혀 보기'로 상태 · 사유만 바꿔 다시 찾는다
//   전체 사례 표는 맨 아래에 접어 둔다 (찾을 것을 아는 사람용)
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { api } from "../auth/session"
import "./cases.css"

type Result = { hull: string; handling: string; days: number | null; cost: number | null; payer: string | null; note: string | null }
type CaseCard = {
  id: string
  title: string
  source: string
  timing: string
  basis: string[]
  differences: string[]
  problem: string | null
  lesson: string | null
  originalText: string | null
  spec: { before: string | null; after: string | null }
  results: Result[]
  synthetic: boolean
}
type Found = CaseCard & { why: string; takeaway: string }
type Understood = { parts: string[]; states: string[]; handlings: string[]; reasons: string[]; changeTypes: string[]; zones: string[]; keywords: string[]; missing: string[]; source: "ai" | "rule" }
type Refine = { label: string; state?: string; reason?: string }
type Answer = { question: string; understood: Understood; summary: string; source: "ai" | "rule"; note: string | null; cases: Found[]; more: number; refine: Refine[] }
type CaseRow = { id: string; title: string; part: string; timing: string; reason: string; handling: string; lesson: string | null }
type Landing = { dataset: { id: string; name: string }; ai: boolean; examples: string[]; scope: { total: number; parts: { label: string; count: number }[] }; all: CaseRow[] }
type Search = { q: string; state?: string; reason?: string }

const won = (n: number | null) => (n == null ? null : n >= 10_000 ? `${Math.round(n / 10_000).toLocaleString()}만 원` : `${n.toLocaleString()}원`)
const resultLine = (rs: Result[]) => {
  if (!rs.length) return "처리 기록 없음"
  const r = rs[0]
  const bits = [r.handling, r.days != null ? `${r.days}일` : null, won(r.cost)].filter(Boolean).join(" · ")
  return rs.length > 1 ? `${bits} 외 ${rs.length - 1}척` : bits
}
const searchUrl = (dataset: string, s: Search) =>
  `/api/cases?dataset=${dataset}&q=${encodeURIComponent(s.q)}${s.state ? `&state=${s.state}` : ""}${s.reason ? `&reason=${s.reason}` : ""}`

// 한 번 받은 첫 화면 · 답은 기억해 두고 다시 열 때 바로 보여 준다
const landingCache = new Map<string, Landing>()
const answerCache = new Map<string, Answer>()

export default function CasesView({ dataset }: { dataset: string }) {
  const [landing, setLanding] = useState<Landing | null>(() => landingCache.get(dataset) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [search, setSearch] = useState<Search | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api(`/api/cases?dataset=${dataset}`)
      .then((r) => r.json())
      .then((j: Landing & { error?: string }) => {
        if (j.error || !j.all) return setError(j.error ?? "사례를 불러오지 못했어요")
        landingCache.set(dataset, j)
        setLanding(j)
      })
      .catch((e) => setError(String(e)))
  }, [dataset])

  useEffect(() => {
    if (!search) return
    const url = searchUrl(dataset, search)
    const hit = answerCache.get(url)
    if (hit) return setAnswer(hit)
    let alive = true
    setBusy(true)
    api(url)
      .then((r) => r.json())
      .then((j: Answer & { error?: string }) => {
        if (!alive) return
        if (j.error) return setError(j.error)
        answerCache.set(url, j)
        setAnswer(j)
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [dataset, search])

  const ask = (q: string) => {
    const t = q.trim()
    if (!t) return
    setText(t)
    setError(null)
    setSearch({ q: t })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(text)
  }

  return (
    <div className="cs">
      <div className="page-title">
        <div>
          <h1>사례</h1>
          <p>지금 고민을 그대로 물어보면, 실제 과거 기록에서 찾아 설명해요.</p>
        </div>
      </div>

      <section className="card cs-search">
        <form onSubmit={submit} className="cs-search-form">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="지금 어떤 문제를 해결하고 싶으세요? 예: 설치된 배관 서포트는 과거에 어떻게 처리했어?" aria-label="사례 검색 질문" maxLength={200} />
          <button type="submit" className="cs-search-go" disabled={!text.trim() || busy}>
            {busy ? "찾는 중…" : "찾기"}
          </button>
        </form>
        {landing && landing.examples.length > 0 && (
          <div className="cs-examples">
            <span>예시</span>
            {landing.examples.map((q) => (
              <button key={q} type="button" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {landing && (
          <p className="cs-scope">
            기록 {landing.scope.total}건 · {landing.scope.parts.map((p) => `${p.label} ${p.count}`).join(" · ")}
            <span className="cs-mode">{landing.ai ? "AI가 질문을 읽고 찾은 기록을 설명해요" : "AI 키가 없어 규칙으로 찾고 정해진 틀로 설명해요"}</span>
          </p>
        )}
      </section>

      {error && <div className="card cs-empty">{error}</div>}
      {busy && !answer && <div className="card cs-loading">기록을 찾는 중이에요…</div>}
      {answer && search && <AnswerView answer={answer} busy={busy} refine={(r) => setSearch({ q: search.q, state: r.state ?? search.state, reason: r.reason ?? search.reason })} />}

      {landing && <AllCases dataset={dataset} rows={landing.all} />}
    </div>
  )
}

function AnswerView({ answer, busy, refine }: { answer: Answer; busy: boolean; refine: (r: Refine) => void }) {
  const u = answer.understood
  const chips = [...u.parts, ...u.states, ...u.handlings, ...u.reasons, ...u.changeTypes, ...u.zones]
  return (
    <section className={`card cs-answer${busy ? " busy" : ""}`}>
      <div className="cs-understood">
        <span className="cs-label">이렇게 찾았어요</span>
        {chips.map((c) => (
          <i key={c}>{c}</i>
        ))}
        {!chips.length && !u.missing.length && <em>찾을 조건을 알아듣지 못했어요</em>}
        {u.missing.map((m) => (
          <i key={m} className="missing">
            {m}: 기록 없음
          </i>
        ))}
        <small>{u.source === "ai" ? "AI가 알아들음" : "규칙으로 알아들음"}</small>
      </div>
      <p className="cs-summary">
        <span className={`cs-tag ${answer.source}`}>{answer.source === "ai" ? "AI 요약" : "요약"}</span>
        {answer.summary}
      </p>
      {answer.note && !answer.note.startsWith("AI 키가 없어") && <p className="cs-note">{answer.note}</p>}
      {answer.cases.length > 0 && (
        <div className="cs-cards">
          {answer.cases.map((c) => (
            <CaseCardView key={c.id} c={c} />
          ))}
        </div>
      )}
      {(answer.refine.length > 0 || answer.more > 0) && (
        <div className="cs-refine">
          {answer.refine.length > 0 && <span className="cs-label">좁혀 보기</span>}
          {answer.refine.map((r) => (
            <button key={r.label} type="button" onClick={() => refine(r)} disabled={busy}>
              {r.label}
            </button>
          ))}
          {answer.more > 0 && <small>같은 조건의 기록 {answer.more}건 더 있어요 · 아래 전체 사례에서 볼 수 있어요</small>}
        </div>
      )}
    </section>
  )
}

function CaseCardView({ c }: { c: Found }) {
  const [open, setOpen] = useState(false)
  return (
    <article className="cs-card">
      <div className="cs-card-top">
        <span className="numeric cs-code">{c.id}</span>
        <span className="cs-timing">{c.timing}</span>
        {c.source && <span className="cs-src">{c.source} 기록</span>}
      </div>
      <strong className="cs-card-title">{c.title}</strong>
      <div className="cs-result">{resultLine(c.results)}</div>
      {c.why && (
        <p className="cs-why">
          <b>왜 이 기록</b> {c.why}
        </p>
      )}
      {c.takeaway && (
        <p className="cs-lesson">
          <b>참고할 점</b> {c.takeaway}
        </p>
      )}
      {c.differences.length > 0 && (
        <ul className="cs-diff">
          {c.differences.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      <button className="cs-open" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "원본 접기" : "원본 보기"}
      </button>
      {open && <CaseBody c={c} />}
    </article>
  )
}

// 원본 기록: 설명 · 사양 · 호선별 처리 (DB 그대로)
function CaseBody({ c }: { c: CaseCard }) {
  return (
    <div className="cs-body">
      {c.originalText && <p>{c.originalText}</p>}
      {c.lesson && <p className="cs-problem">교훈: {c.lesson}</p>}
      {(c.spec.before || c.spec.after) && (
        <p className="cs-spec">
          <s>{c.spec.before ?? "-"}</s> → <b>{c.spec.after ?? "-"}</b>
        </p>
      )}
      {c.problem && <p className="cs-problem">문제: {c.problem}</p>}
      {c.results.length > 0 && (
        <table className="cs-results">
          <thead>
            <tr>
              <th>호선</th>
              <th>처리</th>
              <th>일수</th>
              <th>비용</th>
              <th>부담</th>
            </tr>
          </thead>
          <tbody>
            {c.results.map((r, i) => (
              <tr key={`${r.hull}-${i}`}>
                <td>{r.hull}</td>
                <td>{r.handling}</td>
                <td className="numeric">{r.days != null ? `${r.days}일` : "-"}</td>
                <td className="numeric">{won(r.cost) ?? "-"}</td>
                <td>{r.payer ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {c.synthetic && <small className="cs-synth">합성 데이터로 만든 가상의 기록이에요.</small>}
    </div>
  )
}

function AllCases({ dataset, rows }: { dataset: string; rows: CaseRow[] }) {
  const [query, setQuery] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Record<string, CaseCard | string>>({})
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows.filter((r) => `${r.id} ${r.title} ${r.part} ${r.timing} ${r.reason} ${r.handling} ${r.lesson ?? ""}`.toLowerCase().includes(q)) : rows
  }, [rows, query])
  const toggle = (id: string) => {
    setOpenId(openId === id ? null : id)
    if (detail[id]) return
    api(`/api/cases?dataset=${dataset}&case=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j: { case?: CaseCard; error?: string }) => setDetail((d) => ({ ...d, [id]: j.case ?? j.error ?? "불러오지 못했어요" })))
      .catch((e) => setDetail((d) => ({ ...d, [id]: String(e) })))
  }
  return (
    <details className="card cs-all">
      <summary>
        전체 사례 <b className="numeric">{rows.length}</b>건 보기 <small>찾을 것을 알고 있다면 여기서 직접 찾아요</small>
      </summary>
      <div className="cs-all-bar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="부재, 처리, 교훈으로 찾기 (예: 서포트, 재작업)" aria-label="전체 사례 찾기" />
        <span>
          <b className="numeric">{shown.length}</b> / {rows.length}건
        </span>
      </div>
      <table className="cs-all-table">
        <colgroup>
          <col style={{ width: "9%" }} />
          <col style={{ width: "31%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "32%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>사례</th>
            <th>무엇을</th>
            <th>상태</th>
            <th>처리</th>
            <th>교훈</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const d = detail[r.id]
            return (
              <CaseRowView key={r.id} open={openId === r.id} onToggle={() => toggle(r.id)} row={r}>
                {!d ? <span className="cs-faint">불러오는 중…</span> : typeof d === "string" ? <span className="cs-faint">{d}</span> : <CaseBody c={d} />}
              </CaseRowView>
            )
          })}
        </tbody>
      </table>
    </details>
  )
}

function CaseRowView({ row, open, onToggle, children }: { row: CaseRow; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <>
      <tr className={open ? "on" : ""} onClick={onToggle}>
        <td>
          <strong className="numeric">{row.id}</strong>
        </td>
        <td>
          <strong>{row.title}</strong>
          <small>
            {row.part} · {row.reason}
          </small>
        </td>
        <td>{row.timing}</td>
        <td>{row.handling}</td>
        <td>{row.lesson ?? "-"}</td>
      </tr>
      {open && (
        <tr className="cs-all-detail">
          <td colSpan={5}>{children}</td>
        </tr>
      )}
    </>
  )
}
