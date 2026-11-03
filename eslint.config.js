import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", ".wrangler", "coverage"] },
  js.configs.recommended,
  tseslint.configs.strict,
  { rules: { "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }] } },
  prettier,
);
