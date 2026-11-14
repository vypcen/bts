// Линтер сервера, скриптов и тестов. Интерфейс проверяется компилятором TypeScript (npm run typecheck в web/)
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/", "web/", "public/", "data/", "import/", "load/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-useless-escape": "warn",
    },
  },
];
