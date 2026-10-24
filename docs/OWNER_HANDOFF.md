# Owner's Handoff Guide: gtm-ai-cli

This guide is for the engineer who now owns this repository. It explains what the tool does, how the code fits together, and what to watch out for. Every claim points to the file it comes from, so you can check it yourself.

> This repo (`zachstoia10/gtm-ai-cli`) is a fork of `Zoominfo/gtm-ai-cli`. Open pull requests against **`zachstoia10/gtm-ai-cli`, branch `main`**. GitHub often picks the upstream repo as a fork's default PR target, so check the base repo every time.

---

## 1. What the tool does

`gtm-ai-cli` is a command-line tool, published as `@zoominfo/gtm-ai-cli` (`package.json`), for working with ZoomInfo's go-to-market (GTM) data from a terminal. Users can:

- search and enrich companies and contacts, and find similar ones (`src/commands/companies.ts`, `src/commands/contacts.ts`)
- see buyer intent, scoops (business events), and per-company signals (`src/commands/intent.ts`, `src/commands/scoops.ts`, `src/commands/signals.ts`)
- browse meetings and emails and ask questions about calls (`src/commands/engagements.ts`)
- manage GTM Studio audiences, which are list-building workbooks (`src/commands/audiences.ts`)
- read and update their company's GTM context: offerings, ideal customer profiles, personas, competitors (`src/commands/gtm.ts`)
- run natural-language account and contact research (`src/commands/research.ts`)
- clean, segment, and score their own records (`src/commands/data-quality.ts`, alias `dq`)
- send records to a connected system such as a CRM (`src/commands/exports.ts`)
- look up valid filter values (`src/commands/lookup.ts`), send feedback (`src/commands/feedback.ts`), and call any server tool by name (`src/commands/raw.ts`)
- log in and out (`src/commands/auth.ts`)

The tool installs two command names, `gtm` and an alias `zoominfo`, that do the same thing (`package.json` `bin`; `resolveProgramName` in `src/utils.ts`). Output defaults to JSON. It can also print JSONL, CSV, YAML, or a table (`src/output.ts`). Most data commands accept `--select` to keep only some fields (`SELECT_OPTION` in `src/output.ts`).

The tool doesn't store any GTM data itself. Every real command calls ZoomInfo's servers on behalf of a logged-in ZoomInfo customer.

`AGENTS.md` gives a one-page map of the layout. `.claude/skills/gtm-ai-cli/SKILL.md` is the usage guide for AI agents.

---

## 2. How a request flows through the code

Take `gtm companies search --name Acme -f table`:

1. **Startup: `src/index.ts`.** The program first removes `--debug` / `-d` from the arguments and sets `GTM_DEBUG=1` instead (lines 6-10). It then builds a Commander program and registers every command group (`registerAudiences`, `registerAuth`, ... `registerSignals`).
2. **Command handler: `src/commands/companies.ts`.** Each command file has a `registerX(program)` function that declares its flags. The flags go into a pure "builder" function, for example `buildCompaniesSearchArgs`, which turns them into the arguments the server expects (`--name` becomes `companyName`, `--industry` becomes `industryList`, and so on). These builders are exported so the unit tests can check them without a network.
3. **Input checks: `src/utils.ts`.** These helpers check input before anything is sent: `parseInteger`, `parseId`, `splitList`, `requireSearchFilters`, `normalizeEnrichEntries` (rejects unknown keys in an enrich `--file`), and `readJsonArray` / `readJsonObject`. A bad `--format` is rejected while the flags are parsed, before any call is made (`parseFormat` in `src/output.ts`).
4. **Network call.** The handler calls either `mcpCall(toolName, args)` in `src/mcp.ts` or `apiCall(path, {...})` in `src/api.ts`. See section 3.
5. **Session: `src/credentials.ts`.** Both clients wrap their request in `withSession`, which loads a valid token and, if needed, refreshes it. See section 4.
6. **Output: `src/output.ts`.** `print(data, format, select)` finds the records inside the response, applies `--select`, and prints the chosen format.
7. **Shutdown and errors: `src/index.ts`.** Errors that reach the top are printed as `Error: ...` and the process exits with code 1 (lines 76-79). On exit, the MCP connection is closed (`process.on('beforeExit', ...)`, line 74).

Debug logging: `--debug` or `GTM_DEBUG=1` prints each call and response to stderr, cut off at 2,000 characters (`src/debug.ts`).

---

## 3. The two ways the tool talks to ZoomInfo, and what they share

| | MCP client | REST client |
|---|---|---|
| File | `src/mcp.ts` | `src/api.ts` |
| Entry point | `mcpCall(name, args)`, plus `listMcpTools()` | `apiCall(path, { method, query, body })` |
| Server | `https://mcp.zoominfo.com/mcp` (`MCP_URL`, line 9) | `https://api.zoominfo.com/gtm` (`API_URL`, line 8) |
| Protocol | Model Context Protocol over streamable HTTP, using `@modelcontextprotocol/sdk` | Plain `fetch` with JSON:API (`application/vnd.api+json`) |
| Used by | Every command except the two in the next column | Only `data-quality` (`src/commands/data-quality.ts`) and `exports` (`src/commands/exports.ts`) |

**MCP client (`src/mcp.ts`).** It opens one MCP connection per process and reuses it (`cached`, line 15). Tool calls may run for up to 5 minutes (`TOOL_CALL_TIMEOUT_MS`, line 13), because research-style tools can take longer than the SDK's 60-second default. `unwrap` and `tryParseJson` turn the server's reply into plain JSON; they handle replies with text before the JSON and JSON that has been encoded twice. When the server reports a tool error, `friendlyError` (line 135) strips the wrapper text and adds a hint, such as "Run `gtm lookup --field industries`". `mcpCall` then prints that message and exits the process (line 178).

**REST client (`src/api.ts`).** This is for GTM features the MCP server doesn't offer. If the server answers 429 (rate limited), it retries up to 3 times (`MAX_RATE_LIMIT_RETRIES`, line 13). It waits as long as the `Retry-After` header says, up to 30 seconds, or else backs off exponentially (lines 74-75). It doesn't retry any other failure, so a non-repeatable request (such as a POST) is never sent twice; `src/api.test.ts` checks this. `apiErrorMessage` turns JSON:API error bodies into readable messages. `listQuery` maps `--name/--sort/--page/--page-size` to JSON:API query parameters.

**What they share:**
- **One login.** Both get their token from `withSession` in `src/credentials.ts`, so a single `gtm auth login` works for both.
- **One "token rejected" rule.** Each client turns an HTTP 401 into `SessionRejected`: `isUnauthorized` and `withClient` in `src/mcp.ts`, and line 32 of `src/api.ts`. `withSession` then refreshes once and retries once. The MCP client also drops its cached connection, so the retry reconnects with the new token.
- **The same `User-Agent`** (`gtm-ai-cli/<version>`, from `src/pkg.ts`), the same debug logger (`src/debug.ts`), and the same output formatter (`src/output.ts`).

---

## 4. How login and token refresh work

**Login (`gtm auth login`, `src/commands/auth.ts`, then `oauthLogin` in `src/oauth.ts`).** It uses OAuth 2.0 with PKCE, which lets the CLI log in without a client secret.
1. **Client ID.** The tool reuses the client ID saved in `~/.config/gtm-ai/client_id`. If there isn't one, it registers itself as a new client at `https://mcp.zoominfo.com/oauth/register` (`registerClient`; `loadSavedClientId() ?? await registerClient()`, line 138).
2. **Browser sign-in.** It creates a PKCE verifier and challenge plus a random `state` value. It then starts a small local web server on `127.0.0.1:9876` (`REDIRECT_PORT`, line 16) and opens the browser at `https://mcp.zoominfo.com/oauth/authorize`. It asks for these scopes: `openid offline_access api:data:mcp zi_mcp profile email` (line 23).
3. **Callback.** The local server only answers `GET /callback`. It rejects the login if the returned `state` doesn't match (line 190). It gives up after 5 minutes (`REDIRECT_SERVER_TIMEOUT_MS`).
4. **Token exchange.** The code is swapped for tokens at Okta (`https://okta-login.zoominfo.com/oauth2/default/v1/token`, `exchangeCode`).
5. **Save.** `saveOAuthCredentials` in `src/credentials.ts` writes `~/.config/gtm-ai/credentials` with the access token, refresh token, client ID, and `expires_at`. `expires_at` is a timestamp in **milliseconds**: `Date.now() + expires_in * 1000`, because the server sends `expires_in` in seconds. Files are written to a temp file and then renamed, with mode `0600` (`writeFileAtomic`, line 26).

**Using and refreshing the token (`src/credentials.ts`).**
- `getValidCredentials` loads the saved file. If the token expires within the next 60 seconds (`TOKEN_EXPIRY_BUFFER_MS`, line 7; `isExpired`), it refreshes the token first.
- `refreshCredentials` (line 85) calls `refreshAccessToken` in `src/oauth.ts` and saves the new tokens. If the refresh fails, it reads the file again. Another `gtm` process running at the same time may already have refreshed and rotated the token, so it uses what that process saved (line 98). Only if that doesn't help does it tell the user to run `gtm auth login`.
- `withSession` (line 110) runs the request. If the server rejects the token (`SessionRejected`), it refreshes once and tries again. A second rejection gives "Your session is no longer valid. Run: gtm auth login".
- A missing or corrupt credentials file counts as logged out (`loadCredentials`).

**Other auth commands (`src/commands/auth.ts`).** `logout` revokes both tokens at Okta and deletes the credentials file; it keeps `client_id`. `whoami` decodes the access token, which is a JWT, to show the user's name. It only decodes the token and doesn't verify it.

**History worth knowing.** A recent bug saved `expires_at` without the `* 1000`. That made every command refresh, and parallel commands then logged users out. The fix is commit `8673664` (PR #2). The tests `records a refreshed token as valid for its full lifetime`, `does not refresh again on the next command after a refresh`, and `keeps parallel commands logged in when the server rotates the refresh token` in `src/credentials.test.ts` (lines 86-128) guard against it coming back. Keep them passing.

---

## 5. How to run the tests

Use Node 24, as pinned in `.nvmrc`:

```bash
source ~/.nvm/nvm.sh && nvm install 24
npm ci              # install exactly what package-lock.json lists
npm test            # unit tests (Vitest), about 1 second, no network
npm run typecheck   # tsc --noEmit
npm run build       # bundles src/index.ts to dist/index.js with Bun (bun is a devDependency)
```

- **Unit suite (`npm test`, `vitest.config.ts`).** It runs `src/**/*.test.ts` and leaves out `src/live/**`. All network calls are mocked, so it needs no ZoomInfo account. On the current `main` it runs **16 test files and 151 tests, all passing** on Node 24.22.1. What it covers:
  - the flag-to-request builders, one test file per command group in `src/commands/*.test.ts`
  - session and refresh rules (`src/credentials.test.ts`)
  - REST retries and errors (`src/api.test.ts`)
  - MCP session handling and the 5-minute timeout (`src/mcp-session.test.ts`)
  - reply parsing (`src/mcp.test.ts`)
  - output formats (`src/output.test.ts`)
  - input helpers (`src/utils.test.ts`)
- **Live suite (`npm run test:live`, `vitest.config.live.ts`, `src/live/`).** Don't run it unless you have a ZoomInfo customer login and permission to use credits. It runs the real CLI against ZoomInfo's real servers using your `gtm auth login` tokens. If you aren't logged in, it skips its tests (`src/live/helpers.ts`). Setting `GTM_LIVE_WRITES=1` turns on tests that change real data and **use credits** (`src/live/README.md`). The suite is meant to run only on a developer's machine, never in CI.
- **CI (`.github/workflows/test.yml`).** On every pull request and every push to `main`, it runs `npm ci`, `npm run typecheck`, and `npm test`. It uses **Node 20**, not 24; see section 7.

---

## 6. How releases happen

Releases come from ZoomInfo's upstream setup and need ZoomInfo's secrets. There are two steps:

1. **Version and publish: `.github/workflows/semantic-release.yml`.** It only runs when someone starts it by hand (`workflow_dispatch`). It runs `semantic-release` on Node 24, configured in the `release` block of `package.json` for branch `main`:
   - It reads Conventional Commit messages (`feat:`, `fix:`, ...) to choose the next version. It also has a custom rule: a `docs(README)` commit makes a patch release.
   - `@semantic-release/npm` publishes the npm package.
   - `@semantic-release/git` commits the version bump as `chore(release): X.Y.Z [skip ci]`; you can see these commits in `git log`, for example `40bb553 chore(release): 2.2.0`.
   - semantic-release also creates the `vX.Y.Z` git tag.
   - It logs in with a ZoomInfo GitHub App token (`vars.HOMEBREW_CLIENT_ID`, `secrets.HOMEBREW_PRIVATE_KEY`) and has `id-token: write` permission.
2. **Binaries and Homebrew: `.github/workflows/release.yml`.** It runs when a `v*` tag is pushed, or by hand. It:
   - runs `bun install` and `bun run build:all`, which builds macOS arm64/x64, Linux x64, and Windows x64 binaries (`package.json` `build:all`)
   - signs each binary with GPG (`secrets.GPG_PRIVATE_KEY`, `secrets.GPG_PASSPHRASE`)
   - creates a GitHub Release with the binaries
   - updates the formula in `Zoominfo/homebrew-gtm-ai`

Neither release workflow runs the tests. The version number lives in `package.json` (currently `2.2.0`) and is read at runtime by `src/pkg.ts`.

**In this fork:** don't start either release workflow. The secrets they need belong to ZoomInfo, and they would try to publish `@zoominfo/gtm-ai-cli` and push to ZoomInfo's Homebrew tap.

---

## 7. Known risks and unfinished items

1. **The MCP server address hasn't been confirmed.** `src/mcp.ts` line 8 says `// TODO(phase-1-discovery): confirm the MCP endpoint URL.` and the address is hard-coded as `https://mcp.zoominfo.com/mcp`. The OAuth addresses in `src/oauth.ts` (lines 10-14) are hard-coded too. There's no setting or environment variable to point the tool at a test server.
2. **CODEOWNERS is unfinished.** `.github/CODEOWNERS` still has the auto-generated header (`## TODO: Review and edit the following auto suggested code owners (when done, remove this comment).`) and a single rule, `* @dorg-fshaw`. So reviews are requested from someone who may not own the repo any more. Add the new owner(s) and remove the TODO line.
3. **The release workflows only work upstream** (section 6). They depend on ZoomInfo's secrets and repos, and they run no tests before shipping.
4. **Node versions don't match.** `.nvmrc` says 24 and the semantic-release workflow uses `24.x`. But `.github/workflows/test.yml` uses Node 20, and README "From source" says "Node 18+". `package.json` has no `engines` field. Pick one version and use it everywhere.
5. **`bun.lock` is out of date.** `bun install --frozen-lockfile` fails with "lockfile had changes, but lockfile is frozen". `release.yml` runs `bun install` without that flag, so release builds may resolve different dependency versions from the ones in `package-lock.json`, which CI tests with `npm ci`.
6. **Some README paths are wrong.** README's Development section uses `node dist/js/index.js`, and the comment on line 16 of `src/live/helpers.ts` does too. It also says `npm run build` creates `dist/gtm`. In fact `npm run build` writes `dist/index.js`, which is what `package.json` `bin` points to.
7. **Errors from MCP tools end the process.** In `mcpCall` (`src/mcp.ts`, line 178), `process.exit(1)` runs when a tool returns an error. Code that calls `mcpCall` can't catch that error. Watch for this if you add commands that make several calls in a row.
8. **The login port is fixed.** Login always uses `localhost:9876` (`src/oauth.ts`, line 16). If something else is using that port, login fails.
9. **Package details point upstream.** `package.json` `repository` and `homepage`, the README install steps, and the skill URL in README "Agent integration" all point to `Zoominfo/gtm-ai-cli`.
10. **The MCP SDK is on major version 1.** `package.json` has `"@modelcontextprotocol/sdk": "^1.0.0"`. Upgrading to a newer major version may change how HTTP errors are reported. `isUnauthorized` in `src/mcp.ts` relies on `StreamableHTTPError.code === 401`, and `src/mcp-session.test.ts` covers this.

---

## 8. First-week checklist

- [ ] Clone `zachstoia10/gtm-ai-cli`, switch to Node 24 (`nvm install 24`), and run `npm ci && npm test && npm run typecheck && npm run build`. Expect 151 passing tests.
- [ ] Read `AGENTS.md`, then `src/index.ts`, one command file (`src/commands/companies.ts` with `src/commands/companies.test.ts`), `src/mcp.ts`, `src/api.ts`, and `src/credentials.ts`.
- [ ] Read `src/credentials.test.ts` from start to end. It is the clearest description of how sessions behave.
- [ ] In GitHub settings, check that pull requests default to this fork (`zachstoia10/gtm-ai-cli`, `main`), not `Zoominfo/gtm-ai-cli`.
- [ ] Fix `.github/CODEOWNERS`: add the real owner(s) and remove the TODO line.
- [ ] Decide on one Node version (section 7, item 4) and update `.github/workflows/test.yml` and README to match.
- [ ] Decide what to do with the release workflows in this fork: disable them, or rewire them to secrets you control. Until then, don't start them.
- [ ] Find out who at ZoomInfo can confirm the MCP endpoint (the TODO in `src/mcp.ts`), and record the answer.
- [ ] Decide whether to update `bun.lock` or stop using Bun for installs in `release.yml`.
- [ ] Fix the `dist/js/index.js` and `dist/gtm` paths in README and `src/live/helpers.ts`.
- [ ] Only if you have a ZoomInfo test login and permission to use credits: run `npm run test:live` once (read-only tier) to see the live suite work. Never turn on `GTM_LIVE_WRITES=1` against a real customer account.
- [ ] Watch the next few pull requests and check that the CI "Tests" workflow runs and passes on each one.
