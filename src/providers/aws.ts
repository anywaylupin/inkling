import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { ApiError, missingSecret, type Check, type Provider, type Status } from "./types";

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
  const res = await aws.fetch(url, init);
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
 */
export const lambda: Provider = {
  id: "lambda",
  cost: 1,
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
    const { Configuration: config } = await awsJson<LambdaFunction>(
      env,
      "lambda",
      resourceId,
      `https://lambda.${region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(resourceId)}`,
    );
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
