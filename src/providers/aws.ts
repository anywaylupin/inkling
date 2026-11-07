import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import {
  ApiError,
  missingSecret,
  orNotFound,
  type Check,
  type Provider,
  type Status,
} from "./types";

/** Region from an ARN such as `arn:aws:lambda:us-east-1:123:function:name`, else AWS_REGION. */
function regionOf(resourceId: string, env: Env): string | undefined {
  return resourceId.startsWith("arn:") ? resourceId.split(":")[3] : env.AWS_REGION;
}

/** A missing credential or region as a Check, or undefined when everything is set. */
function missingAws(resourceId: string, env: Env): Check | undefined {
  if (!env.AWS_ACCESS_KEY_ID) return missingSecret("AWS_ACCESS_KEY_ID");
  if (!env.AWS_SECRET_ACCESS_KEY) return missingSecret("AWS_SECRET_ACCESS_KEY");
  if (!regionOf(resourceId, env)) return missingSecret("AWS_REGION");
  return undefined;
}

/**
 * Sends a SigV4-signed request and parses the JSON answer.
 *
 * Retries are off because aws4fetch retries 5xx up to 10 times by default, which would burn the run's subrequest budget.
 */
async function awsJson<T>(
  env: Env,
  service: string,
  resourceId: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
    region: regionOf(resourceId, env),
    service,
    retries: 0,
  });
  const res = await aws.fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  return res.json<T>();
}

/** The AWS console page for a resource. */
function consoleUrl(resourceId: string, env: Env, path: string): string {
  const region = regionOf(resourceId, env) ?? "us-east-1";
  return `https://${region}.console.aws.amazon.com/${path.replaceAll("{region}", region)}`;
}

/** The name at the end of an ARN, or the Resource ID itself. */
function nameOf(resourceId: string): string {
  return resourceId.startsWith("arn:")
    ? (resourceId.split(/[:/]/).at(-1) ?? resourceId)
    : resourceId;
}

/** Lambda's `+0000` offset is not ISO 8601, which Notion needs. */
function lambdaDate(value: string): string {
  return new Date(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toISOString();
}

interface LambdaFunction {
  Configuration: { State?: string; LastUpdateStatus?: string; LastModified: string };
}

/**
 * Reads a function name or ARN with GetFunction.
 *
 * Inactive counts as Up because AWS parks unused functions and wakes them on the next call.
 * Domain is the function URL when one is configured; a 404 there just means none.
 */
export const lambda: Provider = {
  id: "lambda",
  cost: 2,
  link: (resourceId, env) =>
    consoleUrl(
      resourceId,
      env,
      `lambda/home?region={region}#/functions/${encodeURIComponent(nameOf(resourceId))}`,
    ),
  async check(resourceId, env) {
    const missing = missingAws(resourceId, env);
    if (missing) return missing;
    const region = regionOf(resourceId, env);
    const name = encodeURIComponent(resourceId);
    const [{ Configuration: config }, functionUrl] = await Promise.all([
      awsJson<LambdaFunction>(
        env,
        "lambda",
        resourceId,
        `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${name}`,
      ),
      awsJson<{ FunctionUrl: string }>(
        env,
        "lambda",
        resourceId,
        `https://lambda.${region}.amazonaws.com/2021-10-31/functions/${name}/url`,
      ).catch(orNotFound),
    ]);
    const state = config.State ?? "Active";
    const update = config.LastUpdateStatus ?? "Successful";
    const status: Status =
      state === "Failed" || update === "Failed"
        ? "Down"
        : state === "Pending" || update === "InProgress"
          ? "Degraded"
          : "Up";
    return {
      status,
      lastDeploy: lambdaDate(config.LastModified),
      deployState: `${state}, last update ${update}`,
      domain: functionUrl?.FunctionUrl,
    };
  },
};

/** Table states that mean the table cannot serve requests. */
const DOWN_TABLE_STATES = [
  "DELETING",
  "INACCESSIBLE_ENCRYPTION_CREDENTIALS",
  "ARCHIVING",
  "ARCHIVED",
];

/** Reads a table name or ARN with DescribeTable; a table has no deploys, so only Status and Deploy state are set. */
export const dynamodb: Provider = {
  id: "dynamodb",
  cost: 1,
  link: (resourceId, env) =>
    consoleUrl(
      resourceId,
      env,
      `dynamodbv2/home?region={region}#table?name=${encodeURIComponent(nameOf(resourceId))}`,
    ),
  domain: (resourceId, env) =>
    `https://dynamodb.${regionOf(resourceId, env) ?? "us-east-1"}.amazonaws.com`,
  async check(resourceId, env) {
    const missing = missingAws(resourceId, env);
    if (missing) return missing;
    const region = regionOf(resourceId, env);
    const { Table: table } = await awsJson<{ Table: { TableStatus: string } }>(
      env,
      "dynamodb",
      resourceId,
      `https://dynamodb.${region}.amazonaws.com/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": "DynamoDB_20120810.DescribeTable",
        },
        body: JSON.stringify({ TableName: resourceId }),
      },
    );
    const state = table.TableStatus;
    return {
      status: state === "ACTIVE" ? "Up" : DOWN_TABLE_STATES.includes(state) ? "Down" : "Degraded",
      deployState: state,
    };
  },
};

/** AWS REST APIs answer timestamps as ISO strings or epoch seconds, depending on the service. */
function awsTime(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Date(typeof value === "number" ? value * 1000 : value).toISOString();
}

interface HttpApi {
  apiId: string;
  name: string;
  apiEndpoint?: string;
}
interface RestApi {
  id: string;
  name: string;
}
interface Stage {
  stageName: string;
  lastUpdatedDate?: string | number;
}

/**
 * Finds an HTTP or REST API by id or name, then reads its stages; the newest stage update is the last deploy.
 *
 * An API with no stages is Degraded because nothing is deployed; an unknown name is Down.
 * shortcut: reads the first page of each API list (500 REST, 100 HTTP); page the lists if an account has more.
 */
export const apigateway: Provider = {
  id: "apigateway",
  cost: 3,
  link: (resourceId, env) => consoleUrl(resourceId, env, "apigateway/main/apis?region={region}"),
  async check(resourceId, env) {
    const missing = missingAws(resourceId, env);
    if (missing) return missing;
    const region = regionOf(resourceId, env);
    const base = `https://apigateway.${region}.amazonaws.com`;
    const want = nameOf(resourceId);
    const [httpApis, restApis] = await Promise.all([
      awsJson<{ items?: HttpApi[] }>(
        env,
        "apigateway",
        resourceId,
        `${base}/v2/apis?maxResults=100`,
      ),
      awsJson<{ item?: RestApi[] }>(env, "apigateway", resourceId, `${base}/restapis?limit=500`),
    ]);
    const http = httpApis.items?.find((a) => a.apiId === want || a.name === want);
    const rest = restApis.item?.find((a) => a.id === want || a.name === want);
    if (!http && !rest) return { status: "Down", error: `No API named ${want} in ${region}.` };

    const id = http?.apiId ?? rest?.id ?? "";
    const { items, item } = await awsJson<{ items?: Stage[]; item?: Stage[] }>(
      env,
      "apigateway",
      resourceId,
      http ? `${base}/v2/apis/${id}/stages` : `${base}/restapis/${id}/stages`,
    );
    const stages = (items ?? item ?? [])
      .map((s) => ({ name: s.stageName, updated: awsTime(s.lastUpdatedDate) }))
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    const latest = stages[0];
    const domain = http?.apiEndpoint ?? `https://${id}.execute-api.${region}.amazonaws.com`;
    return {
      status: latest ? "Up" : "Degraded",
      lastDeploy: latest?.updated,
      deployState: latest
        ? `${http ? "HTTP" : "REST"} API, stage ${latest.name}`
        : "No stages deployed",
      domain: latest && !http?.apiEndpoint ? `${domain}/${latest.name}` : domain,
      deployment: consoleUrl(
        resourceId,
        env,
        `apigateway/main/${http ? `develop/routes?api=${id}` : `apis/${id}/resources`}&region={region}`,
      ),
    };
  },
};

interface AmplifyApp {
  appId: string;
  name: string;
  defaultDomain: string;
  productionBranch?: { branchName?: string; status?: string; lastDeployTime?: string | number };
}

/** Production branch build states that mean the live site did not get the last deploy. */
const DOWN_BUILDS = ["FAILED", "CANCELLED"];

/**
 * Finds an Amplify Hosting app by id or name and reads its production branch from the app list, in one call.
 *
 * SUCCEED is Up, a failed or cancelled build is Down, anything else (running, pending) is Degraded.
 * shortcut: reads the first 100 apps; page the list if an account has more.
 */
export const amplify: Provider = {
  id: "amplify",
  cost: 1,
  link: (resourceId, env) => consoleUrl(resourceId, env, "amplify/apps?region={region}"),
  async check(resourceId, env) {
    const missing = missingAws(resourceId, env);
    if (missing) return missing;
    const region = regionOf(resourceId, env);
    const want = nameOf(resourceId);
    const { apps } = await awsJson<{ apps: AmplifyApp[] }>(
      env,
      "amplify",
      resourceId,
      `https://amplify.${region}.amazonaws.com/apps?maxResults=100`,
    );
    const app = apps.find((a) => a.appId === want || a.name === want);
    if (!app) return { status: "Down", error: `No Amplify app named ${want} in ${region}.` };
    const branch = app.productionBranch;
    if (!branch?.branchName) {
      return { status: "Degraded", deployState: "No production branch" };
    }
    const build = branch.status ?? "UNKNOWN";
    return {
      status: build === "SUCCEED" ? "Up" : DOWN_BUILDS.includes(build) ? "Down" : "Degraded",
      lastDeploy: awsTime(branch.lastDeployTime),
      deployState: `${branch.branchName}: ${build}`,
      domain: `https://${branch.branchName}.${app.defaultDomain}`,
      deployment: consoleUrl(
        resourceId,
        env,
        `amplify/apps/${app.appId}/branches/${encodeURIComponent(branch.branchName)}/deployments?region={region}`,
      ),
    };
  },
};
