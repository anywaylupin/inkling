# inkling

inkling turns a Notion database of cloud services into a live status board.
A Cloudflare Worker runs every 15 minutes, reads the rows you mark for monitoring, asks each provider's API how the service is doing, and writes status, last deploy and errors back onto those rows.

You keep curating the database by hand.
inkling only touches the properties it owns, and only on rows with Monitor ticked and both Provider and Resource ID set.

![Screenshot of a Notion board grouped by Status](docs/screenshot.png)

## Providers

| Provider     | Resource ID                                | What it reads                                                         |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------- |
| `http`       | a URL such as `https://example.com`        | GET with a 10 s timeout; 2xx under 2 s is Up, slow or 3xx is Degraded |
| `github`     | `owner/repo`                               | latest completed workflow run on the default branch, latest release   |
| `cloudflare` | a Worker script name, or `pages:<project>` | latest Worker deployment, or latest Pages production deployment       |
| `vercel`     | a project id such as `prj_...`             | latest production deployment state                                    |
| `render`     | a service id such as `srv-...`             | suspended flag and latest deploy status                               |

## Notion properties

You own Name, Provider, Resource ID and Monitor (checkbox).
Provider and Resource ID can be select or text columns, or text formulas, for example derived from a relation.

inkling owns these and fills every one on each write, so none stays empty:

| Property     | Type                                             | When there is nothing to report                     |
| ------------ | ------------------------------------------------ | --------------------------------------------------- |
| Status       | status, with options Up, Degraded, Down, Unknown | Unknown                                             |
| URL          | url                                              | a dashboard or repo link built from the Resource ID |
| Last deploy  | date                                             | copies Last checked                                 |
| Deploy state | text                                             | No deploys                                          |
| Last checked | date                                             | always set, at most once an hour per row            |
| Error        | text                                             | None                                                |

`pnpm setup:notion` creates every inkling column except Status, because the Notion API cannot create status properties.
Create Status by hand with the four options above.

## Setup

1. Create a Notion internal connection with read and update content, and share your services database with it, plus any database its Provider or Resource ID formulas read through relations.
2. Clone this repo and run `pnpm install`.
3. Copy `.dev.vars.example` to `.dev.vars` and fill in `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID` and the provider tokens you use. See [SECURITY.md](SECURITY.md) for scopes.
4. Run `pnpm setup:notion` to add the inkling-owned properties to the data source.
5. Log in to Cloudflare with `pnpm wrangler login`.
6. Run `pnpm wrangler kv namespace create INKLING_STATE` and put its id in `wrangler.jsonc` when you fork this repo.
7. Set each secret with `pnpm wrangler secret put NOTION_TOKEN`, and repeat for every other value in `.dev.vars`.
8. Try one run locally: start `pnpm dev`, then `curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"`.
9. Deploy with `pnpm deploy`, or push to `main` and let CI deploy, then watch a run with `pnpm wrangler tail`.

Set `ALERT_URL` to an ntfy topic URL to get one push notification per status change.
Pick a long random topic name, because anyone who knows it can read the topic.

## Refresh a row now

`POST /refresh` checks one row right away instead of waiting for its provider's turn.
It stays off until you set the `REFRESH_SECRET` Worker secret to a long random string.

Every request needs the header `x-inkling-key: <REFRESH_SECRET>` and a JSON body that is either a Notion button webhook or `{ "page_id": "<page id>" }`.
It answers 202 at once and updates the row a few seconds later.
It refuses pages outside your data source and rows without Monitor ticked.

To add a refresh button in Notion:

1. Add a property of type Button named `Refresh`.
2. Add the action Send webhook, with URL `https://inkling.<subdomain>.workers.dev/refresh`.
3. Add the custom header `x-inkling-key` with your `REFRESH_SECRET` value.
4. Leave the page properties out of the body; inkling reads the row itself.

From a terminal:

```sh
curl -X POST https://inkling.<subdomain>.workers.dev/refresh \
  -H "x-inkling-key: $REFRESH_SECRET" \
  -H "content-type: application/json" \
  -d '{"page_id":"<page id>"}'
```

## Limits

- One provider per run.
  With all five providers in use, each row refreshes about every 75 minutes.
- New cron triggers can take about 15 minutes to start firing after a deploy.
- Workers Free allows 50 subrequests per run.
  A GitHub row costs 3, a Render row 2, every other row 1, plus one Notion write per changed row, so keep under about 15 GitHub rows.
- Workers Free allows 10 ms of CPU per run; time spent waiting on `fetch` does not count.
- Notion writes are spaced to 3 per second, and Last checked is written at most once an hour per row.
- KV is written once per run for the round-robin cursor and once per provider when a snapshot changes, well under the Free daily write cap.
- inkling is a board, not a pager.
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
