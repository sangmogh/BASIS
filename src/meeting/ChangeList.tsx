// 설계변경 목록 (메뉴 2): 새 엔진(/api/datasets)의 변경 건. 누르면 회의 화면(MeetingView)
//   행마다 변경 · 변경 내용 · 결정 기한(지연 시 영향) · 상태만. 결정 기한이 있는 건이 위로
import { useEffect, useState } from "react"
import { api } from "../auth/session"
import { offsetFrom, shiftView } from "./clock"
import "./meeting.css"

type IfMissed = { days: number; extraLocalDelay: number; extraDeliveryDelay: number; extraOverrun: number; extraYardCost: number }
type Row = { id: string; title: string; status: string; oneLine: string | null; deadline: { date: string; dday: number; badge: boolean; ifMissed: IfMissed | null } | null; recommended: string | null; decided: string | null; designOnly: boolean; allOverrun: boolean; error: string | null }
type Dataset = { id: string; name: string; asOf: string; changes: Row[]; error: string | null }

const md = (d?: string | null) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : "-")
const ddayText = (n: number) => (n === 0 ? "D-0" : n > 0 ? `D-${n}` : `D+${-n}`)
const firstLoss = (m: IfMissed | null) =>
  !m ? null : m.extraOverrun ? `계약 납기 ${m.extraOverrun}일 초과` : m.extraDeliveryDelay ? `인도 ${m.extraDeliveryDelay}일 지연` : m.extraLocalDelay ? `공정 ${m.extraLocalDelay}일 지연` : null

// 한 번 본 목록은 기억해 두고 다시 열 때 바로 보여 준 뒤 새로 받아 바꾼다
const cache = new Map<string, Dataset>()

export default function ChangeList({ dataset, open, create }: { dataset: string; open: (id: string) => void; create?: () => void }) {
  const [data, setData] = useState<Dataset | null>(() => cache.get(dataset) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api(`/api/datasets?id=${dataset}`)
      .then((r) => r.json())
      .then((j: { datasets?: Dataset[]; error?: string }) => {
        const found = j.datasets?.find((x) => x.id === dataset)
        // 날짜는 데이터셋 기준일(as_of)을 오늘로 옮겨 보인다
        const d = found ? shiftView(found, offsetFrom(found.asOf)) : null
        if (d) {
          cache.set(dataset, d)
          setData(d)
        }
        else setError(j.error ?? `데이터셋 없음: ${dataset}`)
      })
      .catch((e) => setError(String(e)))
  }, [dataset])
  if (error) return <div className="card mt-empty">{error}</div>
  if (!data)
    return (
      <div className="mt">
        <div className="page-title">
          <div>
            <h1>설계변경</h1>
            <p className="mt-skel-line" />
          </div>
        </div>
        <div className="card mt-list mt-skel">
          <div className="card-head">
            <h2>설계변경 목록</h2>
          </div>
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="mt-skel-row"><i /><i /><i /><i /></div>)}
        </div>
      </div>
    )
  const rank = (c: Row) => (c.deadline && !c.decided ? 0 : c.decided ? 1 : c.status === "철회" ? 3 : 2)
  const rows = [...data.changes].sort((a, b) => rank(a) - rank(b) || (a.deadline?.date ?? "").localeCompare(b.deadline?.date ?? "") || a.id.localeCompare(b.id))
  const waiting = rows.filter((c) => c.deadline && !c.decided).length
  return (
    <div className="mt">
      <div className="page-title">
        <div>
          <h1>설계변경</h1>
          <p>
            {data.name.replace(/\s*\([^)]*\)\s*$/, "")} · 결정 대기 <b>{waiting}건</b>
          </p>
        </div>
        {/* PLM 밖에서 온 요청 직접 입력 (기능명세 2장) */}
        {create && (
          <button className="primary-button" onClick={create}>
            + 변경 등록
          </button>
        )}
      </div>
      <div className="card mt-list">
        <div className="card-head">
          <h2>설계변경 목록</h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>변경</th>
              <th>변경 내용</th>
              <th>결정 기한</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const loss = c.deadline?.badge ? firstLoss(c.deadline.ifMissed) : null
              const off = c.status === "철회" || !c.oneLine
              return (
                <tr key={c.id} className={off ? "off" : ""} onClick={() => !off && open(c.id)}>
                  <td>
                    <strong className="numeric mt-list-code">{c.id}</strong>
                    <span className="mt-list-title">{c.title}</span>
                  </td>
                  <td className="mt-list-line">{c.oneLine ?? (c.status === "철회" ? "철회" : "-")}</td>
                  <td>
                    {c.deadline && !c.decided ? (
                      <div className="mt-list-deadline">
                        <span className={`mt-pill ${c.deadline.dday <= 3 ? "danger" : "neutral"}`}>{ddayText(c.deadline.dday)}</span>
                        <span className="numeric">{md(c.deadline.date)}</span>
                        {loss && <small>{c.deadline.ifMissed?.days}일 지연 시 {loss}</small>}
                      </div>
                    ) : (
                      <span className="mt-faint">-</span>
                    )}
                  </td>
                  <td>
                    {c.error ? (
                      <span className="status-pill danger">계산 오류</span>
                    ) : c.decided ? (
                      <span className="status-pill success">결정 완료 · {c.decided.replace(/\s*\(.*\)$/, "")}</span>
                    ) : c.recommended ? (
                      <span className="status-pill primary">추천 {c.recommended}</span>
                    ) : c.designOnly ? (
                      <span className="status-pill neutral">도면 변경</span>
                    ) : (
                      <span className="status-pill neutral">{c.status}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
