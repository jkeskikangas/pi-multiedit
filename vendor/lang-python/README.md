Prebuilt tree-sitter Python parsers from [`@ast-grep/lang-python`](https://www.npmjs.com/package/@ast-grep/lang-python)
0.0.6 (`prebuilds/`, unchanged; license in `LICENSE`). Vendored so that installing pi-multiedit runs no
dependency install script: npm 11.21+ blocks those by default and warns about them. Used only when
`@ast-grep/lang-python` is not installed (`src/ast.ts`).
