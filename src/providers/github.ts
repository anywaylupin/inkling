import { getJson, missingSecret, orNotFound, type Provider, type Status } from "./types";

const API = "https://api.github.com";

interface Run {
  conclusion: string | null;
}

/** Cancelled and similar endings are not failures of the code, so they read as Degraded. */
function runStatus(run: Run | undefined): Status {
  if (!run) return "Unknown";
  if (run.conclusion === "success" || run.conclusion === "skipped") return "Up";
  if (["failure", "timed_out", "startup_failure"].includes(run.conclusion ?? "")) return "Down";
  return "Degraded";
}

/**
 * Reads owner/repo: the latest completed workflow run on the default branch sets Status, the latest release sets Last deploy.
 *
 * Runs are filtered to completed ones so a build in progress never flips the row.
 */
export const github: Provider = {
  id: "github",
  link: (repo) => `https://github.com/${repo}`,
  async check(repo, env) {
    if (!env.GITHUB_TOKEN) return missingSecret("GITHUB_TOKEN");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { status: "Unknown", error: "Resource ID must be owner/repo" };
    }
    const headers = {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "inkling",
    };
    const { default_branch } = await getJson<{ default_branch: string }>(
      `${API}/repos/${repo}`,
      headers,
    );
    const branch = encodeURIComponent(default_branch);
    const [runs, release] = await Promise.all([
      getJson<{ workflow_runs: Run[] }>(
        `${API}/repos/${repo}/actions/runs?branch=${branch}&status=completed&per_page=1`,
        headers,
      ),
      getJson<{ tag_name: string; published_at: string }>(
        `${API}/repos/${repo}/releases/latest`,
        headers,
      ).catch(orNotFound),
    ]);
    return {
      status: runStatus(runs.workflow_runs[0]),
      lastDeploy: release?.published_at,
      deployState: release?.tag_name,
    };
  },
};
