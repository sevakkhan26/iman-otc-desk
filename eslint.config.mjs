import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
});

const eslintConfig = [
  {
    // ".next-*" covers the scratch build dirs (.next-preview, .next-shadow-build, …)
    // that are build output, not source.
    ignores: [".next/**", ".next-*/**", "node_modules/**", "out/**", "next-env.d.ts"]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // CommonJS Node preloads (e.g. the postgres socket shim) must use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
];

export default eslintConfig;
