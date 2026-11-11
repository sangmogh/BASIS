import { useMemo, useState } from "react"
import { analysisLabel } from "./ai/analysis"
import { caseData, projectData } from "./data"
import type { Actual, CaseRecord, Change } from "./data/types"
import { METRICS, benchmarkSamples, formatShort } from "./engine"
import { useAnalysis, useStore } from "./store"

export function RecommendationCards({ change, openCase }: { change: Change; openCase: (code: string) => void }) {
  const { cases } = useStore()
  const findCase = (code: string) => cases.find((record) => record.code === code)
  const { analysis, loading } = useAnalysis(change)
  if (!analysis)
    return <div className="case-shortage">{loading ? "AI가 비슷한 사례를 찾고 있어요…" : "비슷한 사례를 아직 찾지 않았어요"}</div>
  const recommendations = analysis.similar
    .map((s) => ({ record: findCase(s.code), chips: s.why, lesson: s.takeaway }))
    .filter((r): r is { record: CaseRecord; chips: string[]; lesson: string } => Boolean(r.record))
  return (
    <>
      {recommendations.length <= 1 && (
        <div className="case-shortage">
          <strong>사례 부족</strong> · {recommendations.length ? "비슷한 사례가 1건뿐이에요. 참고만 하세요" : "비슷한 사례가 없어요"}
        </div>
      )}
      <div className="recommendation-grid">
        {recommendations.map(({ record, chips, lesson }) => (
          <button className="recommendation-card" key={record.code} onClick={() => openCase(record.code)}>
            <span className="case-card-code numeric">{record.code}</span>
            <strong>{record.title}</strong>
            <small>{record.currentSeries ? "이번 시리즈" : `이전 시리즈 ${record.vessel.split(" ")[0]}`}</small>
            <span className="similarity-chips">
              {chips.map((chip) => (
                <i key={chip}>{chip}</i>
              ))}
            </span>
            <span className="case-result">
              결과: {record.result} · 최대 지연 {record.maxDelay}일
            </span>
            <span className="case-takeaway">
              <b>이번에 참고할 점</b> · {lesson}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

export function SimilarCasesCard({
  change,
  openCase,
  openAll,
  folded = false,
}: {
  change: Change
  openCase: (code: string) => void
  openAll: () => void
  folded?: boolean
}) {
  const { analysis } = useAnalysis(change)
  const [open, setOpen] = useState(!folded)
  return (
    <section className="card similar-cases-card">
      <div className="card-head">
        <div>
          <h2>
            <span className="ai-chip">{analysisLabel(analysis)}</span> 비슷한 과거 사례
          </h2>
        </div>
        <span className="source-pair">
          {folded && (
            <button className="fold-button" onClick={() => setOpen(!open)}>
              {open ? "접기" : "사례 펼치기"}
            </button>
          )}
          <button className="ghost-button" onClick={openAll}>
            사례 전체 보기 →
          </button>
        </span>
      </div>
      {open && (
        <div className="similar-cases-body">
          <RecommendationCards change={change} openCase={openCase} />
        </div>
      )}
    </section>
  )
}

const unique = (values: string[]) => [...new Set(values)]

export function CasesPage({ openCase, openChange }: { openCase: (code: string) => void; openChange: (code: string) => void }) {
  const { state, cases } = useStore()
  const open = state.changes.filter((c) => c.status === "review" && c.boundary === "production")
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState({ trade: "", type: "", area: "", reason: "", timing: "" })
  const filtered = useMemo(
    () =>
      cases.filter((item) => {
        const text = `${item.code} ${item.title} ${item.member} ${item.problem} ${item.lesson}`.toLowerCase()
        return (
          (!search || text.includes(search.toLowerCase())) &&
          (!filters.trade || item.trade === filters.trade) &&
          (!filters.type || item.types.includes(filters.type)) &&
          (!filters.area || item.area === filters.area) &&
          (!filters.reason || item.reason === filters.reason) &&
          (!filters.timing || item.timing === filters.timing)
        )
      }),
    [cases, search, filters],
  )
  const reset = () => {
    setSearch("")
    setFilters({ trade: "", type: "", area: "", reason: "", timing: "" })
  }
  const options = [
    ["trade", "공종", unique(cases.map((c) => c.trade))],
    ["type", "변경 유형", unique(cases.flatMap((c) => c.types))],
    ["area", "구역", unique(cases.map((c) => c.area))],
    ["reason", "사유", unique(cases.map((c) => c.reason))],
    ["timing", "시점", ["생산 전", "블록 제작 중", "블록 완성", "탑재 후"]],
  ] as const
  return (
    <>
      <div className="page-title">
        <div>
          <h1>사례</h1>
          <p>과거 설계변경 한 건 한 건의 기록이에요. 비슷한 일이 전에 어떻게 처리됐는지 찾아봐요.</p>
        </div>
      </div>
      <section className="card current-recommendations">
        <div className="card-head">
          <div>
            <h2>
              <span className="ai-chip">AI 추천</span> 지금 열린 변경과 비슷한 사례
            </h2>
          </div>
        </div>
        {open.map((change) => (
          <div className="change-case-group" key={change.code}>
            <button onClick={() => openChange(change.code)}>
              <span>{change.code}</span>
              <strong>{change.title}</strong>
              <i>회의 화면 →</i>
            </button>
            <RecommendationCards change={change} openCase={openCase} />
          </div>
        ))}
        {!open.length && <div className="case-shortage">지금 열린 설계변경이 없어요.</div>}
      </section>
      <section className="card all-cases-card">
        <div className="card-head">
          <div>
            <h2>전체 사례</h2>
          </div>
        </div>
        <div className="case-filter-bar">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="부재, 문제, 교훈 검색" />
          {options.map(([key, label, values]) => (
            <select key={key} value={filters[key]} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}>
              <option value="">{label} 전체</option>
              {values.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ))}
          <span>
            <b>{filtered.length}</b> / {cases.length}건
          </span>
          <button className="ghost-button" onClick={reset}>
            초기화
          </button>
        </div>
        <div className="case-table-wrap">
          <table className="case-table">
            <colgroup>
              <col style={{ width: "8%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "22%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>사례</th>
                <th>무엇을</th>
                <th>시점</th>
                <th>사유</th>
                <th>처리 결과</th>
                <th>최대 지연</th>
                <th>교훈</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.code} onClick={() => openCase(item.code)}>
                  <td>
                    <strong className="numeric">{item.code}</strong>
                    {state.learned.some((x) => x.code === item.code) && <small className="learned-mark">진행 보드에서 쌓임</small>}
                  </td>
                  <td>
                    <strong>{item.title}</strong>
                    <small>
                      {item.member} · {item.types.join(", ")} · {item.currentSeries ? "이번 시리즈" : "이전 시리즈"}
                    </small>
                  </td>
                  <td>
                    <span className="status-pill neutral">{item.timing}</span>
                  </td>
                  <td>{item.reason}</td>
                  <td>{item.result}</td>
                  <td>
                    <strong className={item.maxDelay > 6 ? "danger-text" : "numeric"}>{item.maxDelay}일</strong>
                  </td>
                  <td>{item.lesson}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Benchmarks actuals={state.actuals} />
    </>
  )
}

// 실적 기준값: 사례의 실적 기록에 진행 보드에서 완료하며 적은 실제 일수를 더해 계산한다 (처리별은 호선 결과, 승인 · 조달 · 협의는 부서별 실적)
function Benchmarks({ actuals }: { actuals: Actual[] }) {
  const { ctx } = useStore()
  const samples = benchmarkSamples(caseData, actuals)
  const recent = actuals.slice(-3).reverse()
  const label = Object.fromEntries(METRICS.map(({ metric, label }) => [metric, label]))
  return (
    <section className="card benchmarks">
      <div className="card-head">
        <div>
          <h2>실적 기준값</h2>
        </div>
        <span>
          사례 {caseData.length}건의 실적 기록{actuals.length ? `과 진행 보드의 실제 일수 ${actuals.length}건` : ""}에서 계산해 시뮬레이션에 쓰는 값이에요
        </span>
      </div>
      <div className="benchmark-grid">
        {METRICS.map(({ metric, label }) => {
          const added = actuals.filter((a) => a.metric === metric).length
          return (
            <span key={metric}>
              <small>{label}</small>
              <strong>{ctx.benchmarks[metric]}일</strong>
              <em>
                기록 {samples[metric].length}건{added ? ` · 진행 보드 +${added}` : ""}
              </em>
            </span>
          )
        })}
      </div>
      {recent.length > 0 && (
        <div className="benchmark-recent">
          <strong>최근 쌓인 실제 일수</strong>
          {recent.map((a: Actual) => (
            <span key={`${a.code}-${a.taskId}`}>
              <i className="numeric">{formatShort(a.date)}</i> {a.code} · {a.task} · 실제 <b>{a.actual}일</b> (계획 {a.planned}일)
              {a.metric ? ` → ${label[a.metric]} 기준값` : " → 사례 기록"}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

const STATUS_LABEL: Record<Change["status"], string> = { review: "검토 중", decided: "결정 후", notified: "알림만", withdrawn: "철회" }

export function CaseDetail({ code, back, openChange }: { code: string; back: () => void; openChange: (code: string) => void }) {
  const { state, cases } = useStore()
  const item = cases.find((record) => record.code === code) ?? cases[0]
  // 이 사례를 근거로 추천받은 설계변경
  const usedBy = state.changes.flatMap((change) => {
    const rec = state.analyses[change.code]?.similar.find((s) => s.code === item.code)
    return rec && change.status !== "withdrawn" ? [{ change, rec }] : []
  })
  return (
    <>
      <div className="change-detail-title">
        <button className="back-link" onClick={back}>
          ← 사례 목록
        </button>
        <h1>
          <span className="numeric">{item.code}</span> {item.title}
        </h1>
        <div className="change-detail-meta">
          <span>{item.currentSeries ? "이번 시리즈" : `이전 시리즈 · ${projectData.previousSeries}`}</span>
          <i />
          <span>{item.vessel}</span>
          <i />
          <span>{item.reason}</span>
          <i />
          <span>반영 시점 {item.timing}</span>
        </div>
      </div>
      <section className="card case-detail-summary">
        <div>
          <small>무엇을</small>
          <strong>
            {item.member} · {item.trade}
          </strong>
        </div>
        <div>
          <small>어떻게</small>
          <strong>{item.types.join(", ")}</strong>
        </div>
        <div>
          <small>어디서</small>
          <strong>{item.area}</strong>
        </div>
        <div>
          <small>설계</small>
          <span>
            <s>{item.v1}</s> → <b>{item.v2}</b>
          </span>
        </div>
      </section>
      <div className="case-lesson">
        <strong>교훈 · {item.lesson}</strong>
        <span>문제: {item.problem}</span>
      </div>
      <div className="case-detail-columns">
        <section className="card">
          <div className="card-head">
            <h2>호선별 처리</h2>
          </div>
          <table>
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "28%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "32%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>호선</th>
                <th>처리</th>
                <th>실제 일수</th>
                <th>메모</th>
              </tr>
            </thead>
            <tbody>
              {item.treatments.map((row) => (
                <tr key={row.vessel}>
                  <td>
                    <strong>{row.vessel}</strong>
                  </td>
                  <td>
                    <span
                      className={`handling-pill ${
                        row.handling.includes("바로") ? "success" : row.handling.includes("중단") ? "warning" : "danger"
                      }`}
                    >
                      {row.handling}
                    </span>
                  </td>
                  <td>{row.days}일</td>
                  <td>{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>부서별 수행 기록</h2>
          </div>
          <table>
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "58%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>부서</th>
                <th>할 일</th>
                <th>일수</th>
              </tr>
            </thead>
            <tbody>
              {item.execution.map((row, index) => (
                <tr key={`${row.task}-${index}`}>
                  <td>
                    <span
                      className={`dept-pill ${
                        row.dept === "설계" ? "design" : row.dept === "구매" ? "purchase" : row.dept === "생산" ? "production" : "external"
                      }`}
                    >
                      {row.dept}
                    </span>
                  </td>
                  <td>{row.task}</td>
                  <td>{row.days}일</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <section className="card used-by">
        <div className="card-head">
          <h2>이 사례가 쓰이는 곳</h2>
        </div>
        <div>
          {usedBy.length ? (
            usedBy.map(({ change, rec }) => (
              <button key={change.code} onClick={() => openChange(change.code)}>
                <strong>{change.code}</strong>
                <span>{change.title}</span>
                <small>비슷한 점: {rec.why.join(" · ")}</small>
                <i className={`status-pill ${change.status === "decided" ? "success" : "primary"}`}>{STATUS_LABEL[change.status]}</i>
              </button>
            ))
          ) : (
            <span className="empty-cell">현재 추천 중인 변경이 없어요.</span>
          )}
        </div>
      </section>
    </>
  )
}
