import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["dist/**", "node_modules/**"] }, js.configs.recommended, ...tseslint.configs.recommended, { linterOptions: { reportUnusedDisableDirectives: "off" }, rules: { "@typescript-eslint/no-unused-vars": "off" } }, { files: ["**/*.{ts,mjs}"], languageOptions: { globals: globals.node } });
