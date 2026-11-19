// The ONLY place this job talks to X. One endpoint, one verb, app-only Bearer Token.
// No posting, replying, following, liking, messaging or DM reading; no user-context (OAuth 1.0a / OAuth 2 user) token.
// scripts/x-search.test.mjs fails if this file gains another endpoint, another verb, or any signing code.

const SEARCH_URL = 'https://api.x.com/2/tweets/search/recent'

export function xSearch(token, fetchFn = fetch) {
  return async ({ query, maxResults, sinceId }) => {
    const u = new URL(SEARCH_URL)
    const params = {
      query, max_results: String(maxResults), expansions: 'author_id',
      'tweet.fields': 'created_at,author_id,referenced_tweets', 'user.fields': 'username',
    }
    if (sinceId) params.since_id = String(sinceId)
    u.search = new URLSearchParams(params)
    const res = await fetchFn(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      let detail = ''
      try { const b = await res.json(); detail = [b.title, b.detail].filter(Boolean).join(' | ').slice(0, 200) } catch { /* not JSON */ }
      throw new Error(`X search answered ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    return res.json()
  }
}
