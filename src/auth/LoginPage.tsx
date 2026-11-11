// 로그인 화면: 아이디 + 비밀번호로 로그인하고, 시연 계정은 아래 토글 안에 접어 둔다
//   실제 운영은 사내 SSO와 연동한다 (기능명세 1장). 시연 계정은 협의에서 맡는 자리별로 묶는다
//   화면 문구는 사무용 명사형 (안내 멘트 없음)
import { useState, type FormEvent } from "react"
import { BrandMark, Wordmark } from "../brand"
import { useAuth, type Account } from "./AuthProvider"
import "./login.css"

const GROUPS: { title: string; note: string; match: (a: Account) => boolean }[] = [
  { title: "회의 주관 · 결정", note: "생산관리 (시리즈 담당)", match: (a) => a.role === "control" },
  { title: "선주 협의 · 결재", note: "계약관리 · 계약 납기 초과 · 조선소 실부담 초과 · 선주 동의 건 결재", match: (a) => a.role === "pm" },
  { title: "부서별 업무 담당", note: "변경 건별 담당 업무 검토 · 가능 / 불가 회신", match: () => true },
]

export default function LoginPage() {
  const { accounts, login, loginWithPassword, error } = useAuth()
  const [loginId, setLoginId] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [showDemo, setShowDemo] = useState(() => new URLSearchParams(window.location.search).get("demo") === "1")

  const used = new Set<string>()
  const groups = GROUPS.map((g) => {
    const list = accounts.filter((a) => !used.has(a.employeeId) && g.match(a))
    list.forEach((a) => used.add(a.employeeId))
    return { ...g, list }
  }).filter((g) => g.list.length)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!loginId.trim() || !password) return
    setSubmitting(true)
    const ok = await loginWithPassword(loginId, password)
    setSubmitting(false)
    if (!ok) setPassword("")
  }
  const enter = async (id: string) => {
    setBusy(id)
    await login(id)
    setBusy(null)
  }

  return (
    <div className="login-page">
      <main className="login-main">
        <section className="card login-box">
          <div className="login-brand">
            <BrandMark />
            <Wordmark />
          </div>
          <form className="login-form" onSubmit={submit}>
            <label>
              아이디
              <input value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="예: E002" autoComplete="username" autoFocus />
            </label>
            <label>
              비밀번호
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button className="primary-button" type="submit" disabled={submitting || !loginId.trim() || !password}>
              {submitting ? "로그인 중…" : "로그인"}
            </button>
          </form>
        </section>

        <div className="login-demo">
          <button className="fold-button" onClick={() => setShowDemo(!showDemo)} aria-expanded={showDemo}>
            {showDemo ? "시연 계정 ▴" : "시연 계정 ▾"}
          </button>
          {showDemo && (
            <div className="login-demo-body">
              {groups.map((g) => (
                <section key={g.title} className="login-group">
                  <div className="login-group-head">
                    <h2>{g.title}</h2>
                    <span>{g.note}</span>
                  </div>
                  <div className="login-accounts">
                    {g.list.map((a) => (
                      <button key={a.employeeId} className="card login-account" onClick={() => enter(a.employeeId)} disabled={!!busy}>
                        <span className="login-account-top">
                          <strong>{a.name}</strong>
                          <span className="status-pill neutral">{a.roleLabel}</span>
                        </span>
                        <span className="login-account-dept">
                          {a.department} · {a.title}
                        </span>
                        <span className="login-account-id numeric">{busy === a.employeeId ? "로그인 중…" : a.employeeId}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              <p className="login-hint">
                탭별 개별 로그인 · 주소에 <code>?as=아이디</code> 추가 시 해당 계정으로 접속 (예: <code>?as=E071</code>)
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
