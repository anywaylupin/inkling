import { describe, expect, it } from "vitest";
import { dynamodb, lambda } from "../src/providers/aws";
import table from "./fixtures/dynamodb-table.json";
import fn from "./fixtures/lambda-function.json";
import { mockFetch, testEnv } from "./helpers";

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
