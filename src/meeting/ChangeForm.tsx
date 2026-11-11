// 설계변경 등록 (직접 입력, 기능명세 2장): PLM 밖에서 온 요청 (선주 메일 · 현장 이슈 등)
//   입력: 원문 · 변경 대상 부품 · 바꾸기 전 · 후 사양 · 사유 · 요청자 (+ 제목은 비우면 '부품 사양 변경')
//   원문을 쓰면 온톨로지 용어 체계(/api/match)가 부품 후보를 내고, 사람은 고르기만 한다
//   블록 · 호선 · 상태 · 대응안은 등록 즉시 엔진이 계산 → 등록 뒤 바로 회의 화면(1단계)으로
//   저장: POST /api/records { action: "register" } (번호는 서버가 정함)
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { useAuth } from "../auth/AuthProvider"
import { api } from "../auth/session"
import "./meeting.css"

type Part = { id: string; name: string; kind: string; kindLabel: string; zone: string | null; places: number; spec: string | null }
type Options = { parts: Part[]; reasons: { code: string; label: string }[]; requesters: { kind: "counterparty"; id: string; name: string; kindLabel: string }[] }
type Candidate = { code: string; label: string; parts: { partId: string }[] }

export default function ChangeForm({ dataset, cancel, created }: { dataset: string; cancel: () => void; created: (id: string) => void }) {
  const { user } = useAuth()
  const [options, setOptions] = useState<Options | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [original, setOriginal] = useState("")
  const [parts, setParts] = useState<string[]>([])
  const [specBefore, setSpecBefore] = useState("")
  const [specAfter, setSpecAfter] = useState("")
  const [reason, setReason] = useState<string | null>(null)
  const [requester, setRequester] = useState<string>("self") // 'self' = 사내 (등록자) · 아니면 회사 밖 상대 ID
  const [title, setTitle] = useState("")
  const [suggested, setSuggested] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api(`/api/records?dataset=${dataset}&form=change`)
      .then((r) => r.json())
      .then((j: Options & { error?: string }) => (j.parts ? setOptions(j) : setError(j.error ?? "등록 화면 재료 조회 실패")))
      .catch((e) => setError(String(e)))
  }, [dataset])

  // 원문 → 부품 후보 (입력이 멈추고 0.5초 뒤)
  useEffect(() => {
    const text = original.trim()
    if (text.length < 4) return setSuggested([])
    const t = setTimeout(() => {
      api(`/api/match?dataset=${dataset}&text=${encodeURIComponent(text.slice(0, 500))}`)
        .then((r) => r.json())
        .then((j: { candidates?: Candidate[] }) => setSuggested([...new Set((j.candidates ?? []).slice(0, 2).flatMap((c) => c.parts.map((p) => p.partId)))]))
        .catch(() => setSuggested([]))
    }, 500)
    return () => clearTimeout(t)
  }, [original, dataset])

  const byId = useMemo(() => new Map((options?.parts ?? []).map((p) => [p.id, p])), [options])
  // 후보 순서: 원문에 부품 이름이 그대로 들어 있으면 앞으로
  const flat = (s: string) => s.replace(/\s/g, "")
  const ranked = suggested
    .filter((id) => byId.has(id))
    .sort((a, b) => Number(flat(original).includes(flat(byId.get(b)!.name))) - Number(flat(original).includes(flat(byId.get(a)!.name))))
  const [showAll, setShowAll] = useState(false)
  const listOpen = showAll || !ranked.length || parts.some((p) => !ranked.includes(p))
  const groups = useMemo(() => {
    const m = new Map<string, Part[]>()
    for (const p of options?.parts ?? []) m.set(p.kindLabel, [...(m.get(p.kindLabel) ?? []), p])
    return [...m]
  }, [options])
  const toggle = (id: string) => {
    const next = parts.includes(id) ? parts.filter((x) => x !== id) : [...parts, id]
    setParts(next)
    // 바꾸기 전 사양: 비어 있으면 첫 부품의 지금 사양(PLM 리비전)으로 채운다
    if (!specBefore && next.length) setSpecBefore(byId.get(next[0])?.spec ?? "")
  }
  const autoTitle = parts.length ? `${byId.get(parts[0])?.name ?? parts[0]}${parts.length > 1 ? ` 외 ${parts.length - 1}건` : ""} 사양 변경` : ""
  const ready = !!original.trim() && parts.length > 0 && !!specAfter.trim() && !!reason

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await api("/api/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dataset,
          action: "register",
          actor: user?.employeeId,
          parts,
          spec_before: specBefore.trim() || null,
          spec_after: specAfter.trim(),
          reason,
          requester_kind: requester === "self" ? "employee" : "counterparty",
          requester_id: requester === "self" ? null : requester,
          original_text: original.trim(),
          title: title.trim() || null,
        }),
      })
      const j = (await res.json()) as { change?: string; error?: string }
      if (!res.ok || !j.change) throw new Error(j.error ?? "등록 실패")
      created(j.change)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="mt">
      <div className="page-title">
        <div>
          <button className="back-link" onClick={cancel}>
            ← 설계변경 목록
          </button>
          <h1>설계변경 등록</h1>
          <p>PLM 외 요청 직접 입력</p>
        </div>
      </div>
      <form className="card mt-panel cf" onSubmit={submit}>
        <table className="mt-table cf-table">
          <tbody>
            <tr>
              <th>원문</th>
              <td>
                <textarea value={original} onChange={(e) => setOriginal(e.target.value)} rows={4} maxLength={2000} autoFocus />
              </td>
            </tr>
            <tr>
              <th>변경 대상 부품</th>
              <td>
                {ranked.length > 0 && (
                  <div className="cf-suggest">
                    <span>부품 후보</span>
                    {ranked.map((id) => (
                      <button type="button" key={id} className={`cf-chip ${parts.includes(id) ? "on" : ""}`} onClick={() => toggle(id)}>
                        {byId.get(id)!.name}
                        {byId.get(id)!.zone && <small>{byId.get(id)!.zone}</small>}
                      </button>
                    ))}
                    {!listOpen && (
                      <button type="button" className="cf-more" onClick={() => setShowAll(true)}>
                        전체 부품 ▾
                      </button>
                    )}
                  </div>
                )}
                {listOpen && <div className="cf-parts">
                  {groups.map(([kind, list]) => (
                    <div key={kind} className="cf-part-group">
                      <span>{kind}</span>
                      <div>
                        {list.map((p) => (
                          <button type="button" key={p.id} className={`cf-chip ${parts.includes(p.id) ? "on" : ""}`} onClick={() => toggle(p.id)}>
                            {p.name}
                            {p.zone && <small>{p.zone}</small>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!options && !error && <div className="mt-skel-line" />}
                </div>}
              </td>
            </tr>
            <tr>
              <th>변경 전 사양</th>
              <td>
                <input value={specBefore} onChange={(e) => setSpecBefore(e.target.value)} maxLength={200} />
              </td>
            </tr>
            <tr>
              <th>변경 후 사양</th>
              <td>
                <input value={specAfter} onChange={(e) => setSpecAfter(e.target.value)} maxLength={200} />
              </td>
            </tr>
            <tr>
              <th>변경 원인</th>
              <td>
                <div className="cf-seg">
                  {(options?.reasons ?? []).map((r) => (
                    <button type="button" key={r.code} className={reason === r.code ? "on" : ""} onClick={() => setReason(r.code)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </td>
            </tr>
            <tr>
              <th>요청 주체</th>
              <td>
                <div className="cf-seg">
                  {(options?.requesters ?? []).map((r) => (
                    <button type="button" key={r.id} className={requester === r.id ? "on" : ""} onClick={() => setRequester(r.id)}>
                      {r.name}
                    </button>
                  ))}
                  <button type="button" className={requester === "self" ? "on" : ""} onClick={() => setRequester("self")}>
                    사내 ({user?.name ?? "등록자"})
                  </button>
                </div>
              </td>
            </tr>
            <tr>
              <th>제목</th>
              <td>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle} maxLength={120} />
              </td>
            </tr>
          </tbody>
        </table>
        {error && <p className="cf-error">{error}</p>}
        <div className="mt-panel-foot">
          <button type="button" className="secondary-button" onClick={cancel}>
            취소
          </button>
          <button type="submit" className="primary-button" disabled={!ready || saving}>
            {saving ? "등록 중…" : "등록"}
          </button>
        </div>
      </form>
    </div>
  )
}
