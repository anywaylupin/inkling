# Security

## Where secrets live

Runtime tokens live only as Cloudflare Worker secrets, set with `pnpm wrangler secret put <NAME>`.
For local runs they live in `.dev.vars`, which is in `.gitignore`.
Nothing secret goes into `wrangler.jsonc`, fixtures, tests or GitHub.

GitHub holds only the two deploy secrets, so a leaked CI log or a malicious pull request cannot read runtime tokens.

inkling never logs tokens, headers or response bodies.
Failed checks log the provider id and an HTTP status code, nothing else.

## Tokens

| Secret                  | Used by      | Narrowest scope                                                                                         | Rotate                                                                                       |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NOTION_TOKEN`          | Worker       | Internal connection with read content and update content only, shared with the services database only   | Notion developer portal, the connection, refresh the secret, then `wrangler secret put`      |
| `NOTION_DATA_SOURCE_ID` | Worker       | Not a credential, kept as a secret so all config lives in one place                                     | Change when you move to another data source                                                  |
| `GITHUB_TOKEN`          | `github`     | Fine-grained token, selected repositories only, read-only Actions, Contents and Metadata, 90 day expiry | Generate a new token, `wrangler secret put GITHUB_TOKEN`, then delete the old one            |
| `CF_API_TOKEN`          | `cloudflare` | Custom token with Account: Workers Scripts Read and Cloudflare Pages Read                               | My Profile, API Tokens, roll the token, then `wrangler secret put CF_API_TOKEN`              |
| `CF_ACCOUNT_ID`         | `cloudflare` | Not a credential                                                                                        | Not needed                                                                                   |
| `VERCEL_TOKEN`          | `vercel`     | Personal account scope, 90 day expiry; Vercel has no read-only tokens                                   | Account Settings, Tokens, create a new one, `wrangler secret put`, then delete the old one   |
| `RENDER_API_KEY`        | `render`     | Full account access; Render has no read-only keys, so rotate it first after any leak                    | Account Settings, API Keys, create a new one, `wrangler secret put`, then revoke the old one |
| `ALERT_URL`             | alerts       | An ntfy topic URL with a long random topic; anyone with the name can read it                            | Pick a new topic, `wrangler secret put ALERT_URL`, resubscribe your devices                  |
| `CLOUDFLARE_API_TOKEN`  | GitHub CI    | Edit Cloudflare Workers template, limited to your account                                               | Roll in the Cloudflare dashboard, then update the GitHub Actions secret                      |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub CI    | Not a credential                                                                                        | Not needed                                                                                   |

## Reporting a vulnerability

Open a private security advisory on the GitHub repository instead of a public issue.
