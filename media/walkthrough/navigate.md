## Navigate and check

* **Go to Definition** (F12) on a type, element, attribute, group or message reference opens its declaration, also in imported and included files and, as a fallback, in any schema file of the workspace.
* **Find All References** (Shift+F12) lists every place that uses a declaration.
* The status bar shows the path of the declaration at the cursor, for example `/plantOrder/line/quantity`. Click it, or run **Copy Path At Cursor**, to copy it.

Problems such as an unresolved type, a duplicate name, an invalid facet value or a schemaLocation that points to a missing file appear in the editor and in the Problems view, each with a stable code. These are common structural checks of the schema; XSD Atlas does not validate XML documents against a schema.
