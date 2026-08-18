/**
 * Serialising a value into a <script> element.
 *
 * `JSON.stringify` escapes what JSON needs escaped, and HTML is not JSON: it
 * leaves `<` alone. A string containing the literal `</script>` therefore ends
 * the script element early, and everything after it — the rest of the JSON, and
 * the rest of the page — is parsed as markup. The values that reach these pages
 * are harvested from tool-call inputs (package names, skill names, MCP server
 * names), so the shape of the data is not this module's to assume.
 *
 * Escaping `<` alone closes the injection; `>` is escaped too so a lone `-->`
 * cannot end an HTML comment, and U+2028/U+2029 because they are valid inside a
 * JSON string but are line terminators to a JavaScript parser.
 */
export function jsonForScript(value: unknown): string {
  // undefined and functions stringify to `undefined` — the value, not a string.
  // Emitting that verbatim writes a bare `undefined` into the page, so name it.
  const json = JSON.stringify(value)
  if (json === undefined) return 'null'
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
