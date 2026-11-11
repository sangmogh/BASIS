// 로그인 토큰은 탭마다 따로 (sessionStorage): 한 브라우저에서 주관자 탭 · 생산 반장 탭을 나란히 띄울 수 있다
// 새 화면은 api()로 서버를 부르면 로그인한 사람으로 기록된다 (Authorization: Bearer)
const KEY = "basis.session"

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(KEY, token)
    else sessionStorage.removeItem(KEY)
  } catch {
    // 저장소를 못 쓰면 이 탭에서만 기억한다 (새로고침하면 다시 로그인)
  }
  memoryToken = token
}

let memoryToken: string | null = null

export function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken() ?? memoryToken
  const headers = new Headers(init.headers)
  if (token) headers.set("authorization", `Bearer ${token}`)
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json")
  return fetch(path, { ...init, headers })
}
