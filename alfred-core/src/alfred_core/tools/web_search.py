"""Web search tool, wired to Tavily.

Tavily was chosen over Brave / SerpAPI / scraping DuckDuckGo because its
free tier (1k searches/month) is generous enough for a personal
assistant, the API returns ranked, deduplicated, LLM-friendly snippets
out of the box, and it doesn't require a business email to sign up.

This module is intentionally thin — it just wraps the HTTP call. The
"should I search?" decision and the "feed results back to the LLM" loop
both live in the chat handler, where the existing tool-use machinery
already sits.

Failure modes we surface explicitly:
- ``WebSearchUnconfiguredError``: the user hasn't set the API key. The
  caller should turn this into a graceful "I don't have search wired up
  yet" reply rather than a 500.
- ``WebSearchError``: Tavily returned an error or HTTP failed. Caller
  should fold this into the visible reply ("I tried to look that up but
  couldn't reach the search service — apologies, sir.") rather than
  pretending the search succeeded with stale info.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from alfred_core.config import Settings

_TAVILY_ENDPOINT = "https://api.tavily.com/search"
# Hard cap on result count returned to the LLM. Five is plenty: Llama's
# 8 k context fills up fast, and an answer-grade summary almost always
# falls out of the top three results anyway.
_MAX_RESULTS = 5
# Network timeout for the search call. Search APIs are usually quick;
# anything longer than this and we'd rather bail and tell the user
# than block the chat turn.
_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class SearchResult:
    """A single web result, in the shape both the LLM and the UI want."""

    title: str
    url: str
    snippet: str


class WebSearchUnconfiguredError(RuntimeError):
    """Raised when web search is invoked but no API key is set."""


class WebSearchError(RuntimeError):
    """Raised when the search backend returned an error or was unreachable."""


async def web_search(query: str, settings: Settings) -> list[SearchResult]:
    """Run a single search against Tavily and return ranked results.

    The function is async so the chat handler doesn't have to spin a
    thread for every tool call — Tavily is over the network, ``httpx``
    is fine here.
    """
    cleaned = query.strip()
    if not cleaned:
        return []

    if not settings.has_tavily:
        raise WebSearchUnconfiguredError(
            "Web search isn't configured. Set ALFRED_TAVILY_API_KEY in "
            ".env (free tier at https://tavily.com) and restart the "
            "containers to enable it."
        )

    payload = {
        "api_key": settings.alfred_tavily_api_key,
        "query": cleaned,
        # ``basic`` covers personal-assistant queries and is far cheaper
        # against the monthly quota than ``advanced``. ``include_answer``
        # nets us Tavily's own summarised answer, which we forward to
        # the LLM verbatim — that single sentence often saves a follow-
        # up search.
        "search_depth": "basic",
        "include_answer": True,
        "max_results": _MAX_RESULTS,
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(_TAVILY_ENDPOINT, json=payload)
    except httpx.HTTPError as exc:
        raise WebSearchError(f"couldn't reach the search service ({exc})") from exc

    if response.status_code == 401:
        # Treat an auth failure as misconfiguration rather than a generic
        # transient error — the user needs to fix their key, no amount
        # of retrying will help.
        raise WebSearchUnconfiguredError(
            "The configured Tavily API key was rejected. Double-check "
            "ALFRED_TAVILY_API_KEY in .env."
        )
    if response.status_code >= 400:
        raise WebSearchError(
            f"search service returned HTTP {response.status_code}: "
            f"{response.text[:200]}"
        )

    body = response.json()
    raw_results = body.get("results") or []
    results: list[SearchResult] = []

    # Tavily's own one-sentence answer comes back outside the per-result
    # list. We slot it as a synthetic "Tavily summary" entry at the top
    # so Alfred can read it first; if there's no answer we just skip it.
    answer = body.get("answer")
    if isinstance(answer, str) and answer.strip():
        results.append(
            SearchResult(
                title="Search summary",
                url="",
                snippet=answer.strip(),
            )
        )

    for item in raw_results[:_MAX_RESULTS]:
        title = (item.get("title") or "").strip()
        url = (item.get("url") or "").strip()
        # Tavily uses "content" for the snippet text. Keep snippets
        # short — the LLM has a finite context window and 200 chars is
        # enough to ground a question without ballooning the prompt.
        snippet = (item.get("content") or "").strip()
        if len(snippet) > 400:
            snippet = snippet[:397].rstrip() + "…"
        if not (title or url):
            continue
        results.append(SearchResult(title=title, url=url, snippet=snippet))

    return results


def format_for_prompt(query: str, results: list[SearchResult]) -> str:
    """Render results as a single block we hand back to the LLM.

    The LLM sees this as a user-role message; instructing the model to
    treat ``[SEARCH_RESULTS]`` as authoritative live-web data lives in
    the persona prompt.
    """
    if not results:
        return (
            f"[SEARCH_RESULTS for {query!r}]\n"
            "No usable results came back. Tell him plainly that you "
            "couldn't find anything relevant on this one.\n"
            "[/SEARCH_RESULTS]"
        )

    lines = [f"[SEARCH_RESULTS for {query!r}]"]
    for i, r in enumerate(results, start=1):
        if r.url:
            lines.append(f"{i}. {r.title} — {r.url}")
        else:
            lines.append(f"{i}. {r.title}")
        if r.snippet:
            lines.append(f"   {r.snippet}")
    lines.append("[/SEARCH_RESULTS]")
    return "\n".join(lines)
