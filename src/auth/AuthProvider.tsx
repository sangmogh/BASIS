// 로그인 상태 (useAuth): 누가 들어왔는지, 시연 계정 목록, 로그인 · 로그아웃
//   주소에 ?as=E071 을 붙여 열면 이 탭만 그 사람으로 들어간다 (시연: 사람마다 링크 하나)
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { api, getToken, setToken } from "./session"

export type Account = { employeeId: string; name: string; department: string; title: string; role: string; roleLabel: string; isHead: boolean }
type AuthState = {
  user: Account | null
  accounts: Account[]
  loading: boolean
  error: string | null
  login: (employeeId: string) => Promise<void>
  loginWithPassword: (loginId: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const v = useContext(AuthContext)
  if (!v) throw new Error("AuthProvider 안에서만 쓸 수 있어요")
  return v
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Account | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 사번 + 비밀번호 { loginId, password } 또는 시연 계정 { employeeId }
  const enter = useCallback(async (payload: Record<string, string>) => {
    setError(null)
    try {
      const res = await api("/api/auth", { method: "POST", body: JSON.stringify(payload) })
      const body = (await res.json()) as { token?: string; user?: Account; error?: string }
      if (!res.ok || !body.token || !body.user) {
        setError(body.error ?? "로그인하지 못했어요")
        return false
      }
      setToken(body.token)
      setUser(body.user)
      return true
    } catch {
      setError("서버에 연결하지 못했어요")
      return false
    }
  }, [])
  const login = useCallback(async (employeeId: string) => {
    await enter({ employeeId })
  }, [enter])
  const loginWithPassword = useCallback((loginId: string, password: string) => enter({ loginId, password }), [enter])

  const logout = useCallback(async () => {
    await api("/api/auth", { method: "DELETE" }).catch(() => undefined)
    setToken(null)
    setUser(null)
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api("/api/auth")
        const body = (await res.json()) as { user: Account | null; accounts: Account[]; error?: string }
        if (!alive) return
        if (!res.ok) throw new Error(body.error ?? "계정 목록을 불러오지 못했어요")
        setAccounts(body.accounts ?? [])
        if (body.user) setUser(body.user)
        else if (getToken()) setToken(null) // 만료된 토큰은 지운다
        // ?as=E071 → 이 탭만 그 사람으로
        const params = new URLSearchParams(window.location.search)
        const as = params.get("as")
        if (as && (!body.user || body.user.employeeId !== as)) {
          params.delete("as")
          const rest = params.toString()
          window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`)
          await login(as)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [login])

  return <AuthContext.Provider value={{ user, accounts, loading, error, login, loginWithPassword, logout }}>{children}</AuthContext.Provider>
}
