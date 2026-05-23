import jsdoc from "eslint-plugin-jsdoc"

export default [
  {
    files: ["bin/**/*.js"],
    plugins: { jsdoc },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...jsdoc.configs["flat/recommended"].rules,
    },
  },
]
