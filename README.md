# PARA

PARA is the automation layer for a Notion second brain built on the PARA method: Projects, Areas, Resources, Archive.
It runs as a Cloudflare Worker you deploy to your own account, so your tokens stay with you.

Today it ships one module, the Infra monitor, which turns a Notion database of cloud services into a live status board.
A Cloudflare Worker runs every 15 minutes, reads the rows you mark for monitoring, asks each provider's API how the service is doing, and writes status, last deploy and errors back onto those rows.

You keep curating the database by hand.
PARA only touches the properties it owns, and only on rows with Monitor ticked and both Provider and Resource ID set.

![Screenshot of a Notion board grouped by Status](docs/screenshot.png)

## Providers

| Provider          | Resource ID                                          | What it reads                                                         |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `http`            | a URL such as `https://example.com`                  | GET with a 10 s timeout; 2xx under 2 s is Up, slow or 3xx is Degraded |
| `github`          | `owner/repo`                                         | latest completed workflow run on the default branch, latest release   |
| `cloudflare`      | a Worker script name, or `pages:<project>`           | latest Worker deployment, or latest Pages production deployment       |
| `vercel`          | a project id such as `prj_...`                       | latest production deployment state                                    |
| `render`          | a service id such as `srv-...`                       | suspended flag and latest deploy status                               |
| `neon`            | a project name or id                                 | project found, compute endpoint state; idle computes count as Up      |
| `lambda`          | a function name or ARN                               | GetFunction state and last update; Inactive counts as Up              |
| `dynamodb`        | a table name or ARN                                  | DescribeTable status                                                  |
| `mistral`         | anything, such as the project name                   | the API key lists models                                              |
| `googlegemini`    | anything, such as the project name                   | the API key lists models                                              |
| `googleanalytics` | a GA4 property id or display name                    | events recorded since yesterday; none is Down                         |
| `googlecloud`     | a Cloud Run service as `service` or `region/service` | the service's ready condition, latest revision and URL                |

AWS resources without an ARN use `AWS_REGION`, and Cloud Run services without a region use `GCP_REGION`, or `us-central1` when that is unset.
A missing token turns the row Unknown, and its Error column links to where to create the token.

## Notion properties

You own Name, Provider, Resource ID and Monitor (checkbox).
Provider and Resource ID can be select or text columns, or text formulas, for example derived from a relation.

PARA owns these and fills every one on each write, so none stays empty:

| Property     | Type                                             | When there is nothing to report                                                 |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Status       | status, with options Up, Degraded, Down, Unknown | Unknown                                                                         |
| Deployment   | url                                              | the latest deploy's page, or the console page when the provider has no deploys  |
| Domain       | url                                              | the public address: production domain, service or function URL, or the API host |
| Last deploy  | date                                             | copies Last checked                                                             |
| Deploy state | text                                             | No deploys                                                                      |
| Last checked | date                                             | always set, at most once an hour per row                                        |
| Error        | text                                             | None                                                                            |

`pnpm setup:notion` creates every PARA column except Status, because the Notion API cannot create status properties.
Create Status by hand with the four options above.

## Setup

1. Create a Notion internal connection with read and update content, and share your services database with it, plus any database its Provider or Resource ID formulas read through relations.
2. Clone this repo and run `pnpm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and fill in `NOTION_TOKEN`, `INFRA_DATA_SOURCE_ID`, optionally `REPOS_DATA_SOURCE_ID` and `TASKS_DATA_SOURCE_ID`, and the provider tokens you use. See [SECURITY.md](SECURITY.md) for scopes.
4. Run `pnpm setup:notion` to add the PARA-owned properties to the data source.
5. Log in to Cloudflare with `pnpm wrangler login`.
6. Run `pnpm wrangler kv namespace create PARA_STATE` and put its id in `wrangler.jsonc` when you fork this repo.
7. Set each secret with `pnpm wrangler secret put NOTION_TOKEN`, and repeat for every other value in `.dev.vars`.
8. Try one run locally: start `pnpm dev`, then `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`.
9. Deploy with `pnpm deploy`, or push to `main` and let CI deploy, then watch a run with `pnpm wrangler tail`.

Set `ALERT_URL` to an ntfy topic URL to get one push notification per status change.
Pick a long random topic name, because anyone who knows it can read the topic.

## GitHub repo sync

Set `REPOS_DATA_SOURCE_ID` to turn it on, and `TASKS_DATA_SOURCE_ID` to also mirror pull requests.
It runs at minutes 7 and 37 of every hour, apart from the Infra cron, and needs `GITHUB_TOKEN` with the scopes in [SECURITY.md](SECURITY.md).

Repos rows are keyed by Key, written as `owner/repo`:

- Every repo you own, private ones included, gets a row, created with Status Discovered.
- Rows whose Key names a repo you do not own are updated too, so you can track open-source projects.
- A repo that disappears, or that GitHub archives, gets Status Deprecated. Rows are never deleted.
- Sync writes Description, GitHub, Domain, Topics, Language, Visibility, Stars, Fork count, Open PRs, Open issues, Default branch, Last commit, Commit message, Latest release, Released, Forked from and Last synced. Name, Origin, Status and your relations stay yours after the row exists.
- Only the latest commit on the default branch is kept.
- A row is written only when one of its synced values changed, so Last synced is the last time something changed.

Tasks rows are keyed by Key, written as `owner/repo#number`:

- Your open pull requests become tasks In progress, and pull requests waiting on your review become tasks To do, linked to their repo.
- When a pull request merges, or your review is in, its task turns Done. When it closes unmerged, its task turns Cancelled.

The repo sync needs these columns on Repos: Key and Description (text), GitHub and Domain (url), Topics (multi-select), Language and Visibility (select), Stars, Fork count, Open PRs and Open issues (number), Default branch, Commit message and Latest release (text), Last commit, Released and Last synced (date), Status (status, with Discovered and Deprecated options), Origin (select) and Forked from (relation to Repos).
Tasks needs Key (text), Issue (url), Status (status, with To do, In progress, Done and Cancelled options) and Repo (relation to Repos).

## Sync a row now

`POST /sync` syncs one row right away instead of waiting for its cron turn.
An Infra row is checked on its own; a Repos or Tasks row runs the whole repo sync, which costs about the same.
It stays off until you set the `SYNC_SECRET` Worker secret to a long random string.

Every request needs the header `x-para-key: <SYNC_SECRET>` and a JSON body that is either a Notion button webhook or `{ "page_id": "<page id>" }`.
It answers 202 at once and updates the row a few seconds later.
It refuses pages outside your Infra, Repos and Tasks data sources, and Infra rows without Monitor ticked.

To add a sync button in Notion:

1. Add a property of type Button named `Sync`.
2. Add the action Send webhook, with URL `https://para.<subdomain>.workers.dev/sync`.
3. Add the custom header `x-para-key` with your `SYNC_SECRET` value.
4. Leave the page properties out of the body; PARA reads the row itself.

From a terminal:

```sh
curl -X POST https://para.<subdomain>.workers.dev/sync \
  -H "x-para-key: $SYNC_SECRET" \
  -H "content-type: application/json" \
  -d '{"page_id":"<page id>"}'
```

## Limits

- The repo sync writes at most 35 rows per run, pull request tasks first, so a first import of 100 repos fills in over about 3 runs.
  It reads up to 300 owned repos, 100 tracked repos, 100 open pull request tasks and 50 pull requests per list.
- Workers Free allows 50 subrequests per run.
  Each run takes providers in round-robin order until their rows would cost more than 40, counting each row as its provider's calls plus one Notion write.
  A Google Analytics row costs 5, a GitHub row 4, an http, Cloudflare, Vercel, Render, Neon, Lambda or Cloud Run row 3, every other row 2.
  A provider with more rows than the budget still gets a whole run to itself, so keep under about 12 GitHub rows.
- New cron triggers can take about 15 minutes to start firing after a deploy.
- Workers Free allows 10 ms of CPU per run; time spent waiting on `fetch` does not count.
- Notion writes are spaced to 3 per second, and Last checked is written at most once an hour per row.
- KV is written once per run for the round-robin cursor and once per checked provider when its snapshot changes, well under the Free daily write cap.
- PARA is a board, not a pager.
  Keep UptimeRobot or a similar service for real time downtime alerts.

## Development

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm format
```

Tests run inside the Workers runtime with `@cloudflare/vitest-plugin` and answer every provider call from JSON fixtures in `test/fixtures`.

## License

[MIT](LICENSE)
