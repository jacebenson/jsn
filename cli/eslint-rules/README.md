# Portable ESM specifiers

`npm run lint` enables the local `portable-esm-paths` rule. For Node's
`--import`, `--loader`, and `--experimental-loader`, use
`pathToFileURL(path).href` rather than a filesystem path. A Windows drive path
is interpreted as an unsupported URL scheme. `new URL(relative, import.meta.url).href`
is also suitable for module-relative files. Ordinary Node entrypoint arguments
and filesystem operations still use filesystem paths.

The rule recognizes imported `node:path`/`path` `join` and `resolve`,
`node:url`/`url` `fileURLToPath`, and immutable local `const` aliases. It checks
dynamic imports, Node child-process argument arrays, and simple `NODE_OPTIONS`
strings, templates, and concatenations. Absolute POSIX, Windows drive, and UNC
string paths are rejected. Relative literal specifiers, bare packages, and
`node:`, `data:`, and `file:` URLs are allowed.

This is not whole-program analysis. Unknown values, function return values,
mutable bindings, CommonJS bindings, object destructuring, computed members,
spread argument arrays, shell commands, and complex `NODE_OPTIONS` construction
are outside its coverage. Child-process arrays must be statically visible and
target `process.execPath`, `node`, or `node.exe` via an imported Node
child-process function. Scanning stops at an unknown argument or entrypoint so
ordinary CLI arguments are not treated as Node flags. Use URL conversion even
when lint cannot establish where a value came from.

`cli/test/portable-esm-paths.test.js` exercises the real ESLint configuration via
its existing npm exec command. These offline tests run as part of `npm test` and
CI. Run them alone from the repository root with:

```sh
npm exec -- node --test cli/test/portable-esm-paths.test.js
```
