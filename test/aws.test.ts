import { describe, expect, it } from "vitest";
import { amplify, apigateway, dynamodb, lambda } from "../src/providers/aws";
import table from "./fixtures/dynamodb-table.json";
import functionUrl from "./fixtures/lambda-function-url.json";
import fn from "./fixtures/lambda-function.json";
import { mockFetch, routes, testEnv } from "./helpers";

const env = {
  ...testEnv,
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
  AWS_REGION: "us-east-1",
};

describe("lambda", () => {
  it("reads state and last modified with a signed GetFunction", async () => {
    const calls = mockFetch(() => Response.json(fn));
    expect(await lambda.check("resize-images", env)).toEqual({
      status: "Up",
      lastDeploy: "2026-10-29T16:20:05.123Z",
      deployState: "Active, last update Successful",
    });
    expect(calls[0]?.url).toBe(
      "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/resize-images",
    );
    expect(calls[0]?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/,
    );
  });

  it("uses the function URL as Domain when one is configured", async () => {
    mockFetch(routes({ "/url": functionUrl, "/functions/resize-images": fn }));
    expect(await lambda.check("resize-images", env)).toMatchObject({
      domain: "https://abc123.lambda-url.us-east-1.on.aws/",
    });
  });

  it("takes the region from an ARN", async () => {
    const calls = mockFetch(() => Response.json(fn));
    await lambda.check("arn:aws:lambda:eu-west-1:123456789012:function:resize-images", {
      ...env,
      AWS_REGION: undefined,
    });
    expect(new URL(calls[0]?.url ?? "").hostname).toBe("lambda.eu-west-1.amazonaws.com");
  });

  it("is Down when the last update failed", async () => {
    const failed = { Configuration: { ...fn.Configuration, LastUpdateStatus: "Failed" } };
    mockFetch(() => Response.json(failed));
    expect((await lambda.check("resize-images", env)).status).toBe("Down");
  });

  it("links to where to create keys when they are missing", async () => {
    expect(await lambda.check("resize-images", testEnv)).toEqual({
      status: "Unknown",
      error: "AWS_ACCESS_KEY_ID is not set.",
      errorLink: "https://console.aws.amazon.com/iam/home#/users",
    });
  });
});

describe("dynamodb", () => {
  it("reads TableStatus with a signed DescribeTable", async () => {
    const calls = mockFetch(() => Response.json(table));
    expect(await dynamodb.check("orders", env)).toEqual({ status: "Up", deployState: "ACTIVE" });
    expect(calls[0]?.headers.get("x-amz-target")).toBe("DynamoDB_20120810.DescribeTable");
    expect(await calls[0]?.json()).toEqual({ TableName: "orders" });
  });

  it("is Degraded while the table updates", async () => {
    mockFetch(() => Response.json({ Table: { ...table.Table, TableStatus: "UPDATING" } }));
    expect((await dynamodb.check("orders", env)).status).toBe("Degraded");
  });
});

describe("apigateway", () => {
  const httpApis = {
    items: [
      {
        apiId: "h1",
        name: "creative-preview",
        apiEndpoint: "https://h1.execute-api.us-east-1.amazonaws.com",
      },
    ],
  };
  const restApis = { item: [{ id: "r1", name: "legacy" }] };

  it("finds an HTTP API by name and reads its newest stage", async () => {
    const calls = mockFetch(
      routes({
        "/v2/apis": httpApis,
        "/restapis": restApis,
        "/v2/apis/h1/stages": {
          items: [
            { stageName: "dev", lastUpdatedDate: "2026-10-01T00:00:00Z" },
            { stageName: "$default", lastUpdatedDate: "2026-11-02T08:00:00Z" },
          ],
        },
      }),
    );
    expect(await apigateway.check("creative-preview", env)).toMatchObject({
      status: "Up",
      lastDeploy: "2026-11-02T08:00:00.000Z",
      deployState: "HTTP API, stage $default",
      domain: "https://h1.execute-api.us-east-1.amazonaws.com",
    });
    expect(calls[0]?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/,
    );
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });

  it("finds a REST API by id, with epoch-second stage dates and a stage path in Domain", async () => {
    mockFetch(
      routes({
        "/v2/apis": { items: [] },
        "/restapis": restApis,
        "/restapis/r1/stages": { item: [{ stageName: "prod", lastUpdatedDate: 1793606400 }] },
      }),
    );
    expect(await apigateway.check("r1", env)).toMatchObject({
      status: "Up",
      lastDeploy: "2026-11-02T08:00:00.000Z",
      domain: "https://r1.execute-api.us-east-1.amazonaws.com/prod",
    });
  });

  it("is Degraded with no stages and Down when the name is unknown", async () => {
    mockFetch(routes({ "/v2/apis": httpApis, "/restapis": restApis, "/stages": { items: [] } }));
    expect(await apigateway.check("creative-preview", env)).toMatchObject({
      status: "Degraded",
      deployState: "No stages deployed",
    });
    expect(await apigateway.check("missing", env)).toEqual({
      status: "Down",
      error: "No API named missing in us-east-1.",
    });
  });
});

describe("amplify", () => {
  const app = (status?: string) => ({
    apps: [
      {
        appId: "d1abc",
        name: "creative-preview",
        defaultDomain: "d1abc.amplifyapp.com",
        productionBranch: status
          ? { branchName: "main", status, lastDeployTime: 1793606400 }
          : undefined,
      },
    ],
  });

  it("reads the production branch in one call", async () => {
    const calls = mockFetch(() => Response.json(app("SUCCEED")));
    expect(await amplify.check("creative-preview", env)).toMatchObject({
      status: "Up",
      lastDeploy: "2026-11-02T08:00:00.000Z",
      deployState: "main: SUCCEED",
      domain: "https://main.d1abc.amplifyapp.com",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://amplify.us-east-1.amazonaws.com/apps?maxResults=100");
  });

  it("maps failed, running and missing branches", async () => {
    mockFetch(() => Response.json(app("FAILED")));
    expect((await amplify.check("d1abc", env)).status).toBe("Down");
    mockFetch(() => Response.json(app("RUNNING")));
    expect((await amplify.check("d1abc", env)).status).toBe("Degraded");
    mockFetch(() => Response.json(app()));
    expect(await amplify.check("d1abc", env)).toEqual({
      status: "Degraded",
      deployState: "No production branch",
    });
    expect(await amplify.check("other", env)).toEqual({
      status: "Down",
      error: "No Amplify app named other in us-east-1.",
    });
  });
});
