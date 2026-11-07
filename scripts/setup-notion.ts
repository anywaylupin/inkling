import { Client } from "@notionhq/client";
import { MODULES, NOTION_VERSION } from "../src/schema.ts";

// Adds the columns each enabled module needs; a module is enabled when its data source id is set.
const { NOTION_TOKEN } = process.env;
const enabled = Object.entries(MODULES).filter(([, m]) => process.env[m.env]);
if (!NOTION_TOKEN || enabled.length === 0) {
  console.error("Set NOTION_TOKEN and at least one data source id in .dev.vars first.");
  console.error(
    `Data source ids: ${Object.values(MODULES)
      .map((m) => m.env)
      .join(", ")}.`,
  );
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: NOTION_VERSION });

for (const [name, module] of enabled) {
  const id = process.env[module.env] ?? "";
  const source = await notion.dataSources.retrieve({ data_source_id: id });
  const existing = "properties" in source ? source.properties : {};
  const wanted = Object.entries(module.properties(id));

  const missing = wanted.filter(([prop]) => !(prop in existing));
  for (const [prop, definition] of wanted) {
    const type = Object.keys(definition ?? {})[0];
    if (prop in existing && existing[prop]?.type !== type) {
      console.warn(`${name}: ${prop} exists as ${existing[prop]?.type}, expected ${type}.`);
      console.warn("PARA leaves it alone, but writes to it will fail until you change its type.");
    }
  }

  const status = existing["Status"];
  const have = status?.type === "status" ? status.status.options.map((o) => o.name) : [];
  const lacking = module.statuses.filter((option) => !have.includes(option));
  if (module.statuses.length > 0 && (status?.type !== "status" || lacking.length > 0)) {
    console.warn(`${name}: the API cannot create status properties, so set up Status by hand:`);
    console.warn(
      `a property named Status of type Status with options ${module.statuses.join(", ")}.`,
    );
  }

  if (missing.length === 0) {
    console.log(`${name}: all PARA properties already exist.`);
    continue;
  }
  await notion.dataSources.update({ data_source_id: id, properties: Object.fromEntries(missing) });
  console.log(`${name}: added ${missing.map(([prop]) => prop).join(", ")}.`);
}
