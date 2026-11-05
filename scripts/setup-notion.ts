import { Client } from "@notionhq/client";
import { PARA_PROPERTIES, NOTION_VERSION, STATUS_OPTIONS } from "../src/schema.ts";

const { NOTION_TOKEN, INFRA_DATA_SOURCE_ID } = process.env;
if (!NOTION_TOKEN || !INFRA_DATA_SOURCE_ID) {
  console.error("Set NOTION_TOKEN and INFRA_DATA_SOURCE_ID in .dev.vars first.");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: NOTION_VERSION });
const source = await notion.dataSources.retrieve({ data_source_id: INFRA_DATA_SOURCE_ID });
const existing = "properties" in source ? source.properties : {};

const missing = Object.entries(PARA_PROPERTIES).filter(([name]) => !(name in existing));
const mismatched = Object.entries(PARA_PROPERTIES).filter(
  ([name, definition]) => name in existing && existing[name]?.type !== Object.keys(definition)[0],
);

for (const [name, definition] of mismatched) {
  console.warn(
    `${name} exists as ${existing[name]?.type}, expected ${Object.keys(definition)[0]}.`,
  );
  console.warn("PARA leaves it alone, but writes to it will fail until you change its type.");
}

const status = existing["Status"];
const statusNames = status?.type === "status" ? status.status.options.map((o) => o.name) : [];
const missingOptions = STATUS_OPTIONS.filter((name) => !statusNames.includes(name));
if (status?.type !== "status" || missingOptions.length > 0) {
  console.warn("The API cannot create a status property, so set up Status by hand in Notion:");
  console.warn(`a property named Status of type Status with options ${STATUS_OPTIONS.join(", ")}.`);
}

if (missing.length === 0) {
  console.log("All PARA properties already exist.");
} else {
  await notion.dataSources.update({
    data_source_id: INFRA_DATA_SOURCE_ID,
    properties: Object.fromEntries(missing),
  });
  console.log(`Added ${missing.map(([name]) => name).join(", ")}.`);
}
