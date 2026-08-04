# Action policy

A crawl drives a real browser against a real app. Whether an action may be performed is decided in
Node (`scripts/model.mjs`), never in the page — page script is evidence, not authority.

## The guarantee

**An action is executed only when it is positively recognized as safe.** The policy is one-directional
on purpose: being unable to prove an action harmless is not the same as proving it harmful, and both
lead to the same default — do not press it.

| Class | Executed by default | Executed with `--allow-mutating` |
| --- | --- | --- |
| `safe` | yes | yes |
| `mutating` | no | yes |
| `destructive` | no | **no** |

Nothing promotes an action into `safe` except the rules below and an explicit `actionPolicy.allow`
entry. There is no flag that makes `destructive` run.

`actionPolicy.allow` is a reclassification decision, not a crawler convenience. It exists for a
user to identify one exact action key that the heuristics misjudged. The agent must never insert an
allow entry on the user's behalf merely to reach more screens; without that pre-existing user
decision, destructive-pattern matches remain destructive.

## Order of decision

1. `actionPolicy.deny` contains the action key → `destructive`.
2. `actionPolicy.allow` contains the action key → `safe`.
3. The element has a `download` attribute → `destructive`. A download leaves the browser's control.
4. The accessible name matches the **destructive lexicon** → `destructive`.
5. The element is an off-origin link → `safe` to record, but the crawler marks it
   `blocked: external-origin` and never follows it.
6. The element is a same-origin link with an `href` → `safe`. Navigation is the one action whose
   effect is legible from the markup alone.
7. The element submits a non-GET form → `mutating`.
8. The element sits inside a `nav` / `role="navigation"` landmark → `safe`.
9. The accessible name matches the **safe lexicon** → `safe`.
10. `role="tab"` → `safe`.
11. Anything else → `unknownActionClass`, default `mutating`.

Step 4 runs before step 9 so that "전체 삭제" is destructive even though "전체" reads as safe.

Step 8 exists because single-page apps navigate with buttons as often as with links: a folder rail
or sidebar is a nav landmark full of `<button>`s that only change the view. Landmark membership is
structural evidence, not a guess about wording. It is checked after steps 4 and 7, so a logout
button inside a nav is still refused and a form submit inside a nav is still `mutating`.

Logging out is in the destructive lexicon. It loses no user data, but it destroys the crawl's own
session, and every observation after it would be a lie.

## Why unknown defaults to `mutating` rather than `destructive`

Both defaults are identical where it matters: an unrecognized button is not pressed during a normal
crawl. They differ only under `--allow-mutating`, which the user turns on for a disposable
environment precisely to reach the screens behind ordinary buttons. Defaulting unknown actions to
`destructive` would make that flag do almost nothing while adding no safety, because genuinely
dangerous labels are already caught at step 4.

Set `"unknownActionClass": "destructive"` when the environment is only *mostly* disposable and you
want `--allow-mutating` restricted to form submits.

## Lexicons

Matching is substring, case-insensitive, against the accessible name. Both lists are replaceable via
`actionPolicy.destructivePatterns` and `actionPolicy.safePatterns`.

**Destructive** — 삭제, 제거, 지우기, 비우기, 폐기, 탈퇴, 초기화, 발송, 보내기, 전송, 결제, 구매,
주문하기, 환불, 입금, 출금, 송금, 승인, 반려, 거절, 차단, 정지, 해지, 취소하기, 배포, 게시, 로그아웃,
로그 아웃, 세션 종료, logout, log out, sign out, signout, delete, remove, destroy, purge, drop,
erase, wipe, send, dispatch, publish, deploy, release, pay, purchase, checkout, refund, charge,
withdraw, transfer, approve, reject, ban, suspend, terminate, deactivate, unsubscribe.

**Safe** — 닫기, 취소, 뒤로, 이전, 다음, 더보기, 접기, 펼치기, 필터, 검색, 정렬, 보기, 상세, 목록,
홈, 새로고침, 전체, 메뉴, 탭, 선택, close, cancel, back, previous, next, more, less, expand,
collapse, filter, search, sort, view, details, detail, list, home, refresh, reload, all, open menu,
menu, skip.

The lexicons are heuristics and will misjudge a name eventually. That is why an unrecognized name
falls to a class that does not run, and why every classification is recorded in the map as
`classifiedBy` so a wrong call is visible rather than silent.

## What is recorded but never done

A blocked action still becomes an edge, with `status: "unexplored"` and a `blockedReason`. "The
delete button is at the top right of the detail screen and it was not pressed" is information the
next agent needs. Failing closed narrows what the crawl *does*, not what the map *says*.

## Other hard limits

- Off-origin top-level navigation is blocked before the document request leaves the browser; the
  crawler returns to the source screen.
- New tabs and `window.open` are neutralized, and stray popup targets are closed.
- Downloads are denied at the browser level.
- JavaScript dialogs are cancelled automatically (`beforeunload` is accepted so navigation cannot
  wedge). Every dialog seen is recorded in `run.dialogs`.
- Credential and payment fields are never filled. Only the configured auth recipe types anything,
  and its values come from environment variables.
