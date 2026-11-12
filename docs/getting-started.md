# Getting started with XSD Atlas

## Install

Install **XSD Atlas** (publisher Small Steps Studio) from the Extensions view (`Ctrl+Shift+X`). It is built for VS Code 1.82 or newer (it has no native parts, so it is not tied to one operating system) and was tested with VS Code 1.146 on Windows.

## Which files

* `.xsd` files and `.wsdl` files (WSDL 1.1 and 2.0) open as XML and are recognised by their extension.
* Other XML files whose root element is `xs:schema`, `wsdl:definitions` or `wsdl:description` are recognised by their first characters.
* Imports, includes, redefines and overrides are followed through relative `schemaLocation` paths, also into other folders. Locations on the internet are never fetched; the problem `XSD-UNREACHABLE-IMPORT` says so, and references into such a namespace are not checked. Keep a local copy and point schemaLocation at it to include it.
* Files open in an editor are read from the editor, so unsaved changes count.

## First steps

1. Run **XSD Atlas: Open Sample Schema** (or open one of your schemas).
2. Click the XSD Atlas icon in the activity bar: the **Schema Outline** lists imports, elements, types, groups and attributes. Click an entry to jump to it.
3. Rest the pointer on a type name in `type="..."`: the hover shows the definition, base types, facets, child elements and documentation.
4. Press F12 on a reference to open its definition, Shift+F12 to list every use.
5. The status bar shows the path of the declaration at the cursor (for example `/plantOrder/line/quantity`); click it to copy it.
6. Run **XSD Atlas: Create Sample XML** and pick an element.
7. **Help > Welcome > Get started with XSD Atlas** repeats these steps with buttons.

## Pro

The Pro commands (comparison, full samples, documentation, flatten, SOAP envelopes, inventory) can be tried for 14 days; the trial starts with the first Pro command and needs no key, account or network. See [licence.md](licence.md).

## More

* [Problems and their codes](problems.md)
* [Comparison rules](diff-rules.md)
* [Sample XML](samples.md)
* [WSDL support](wsdl.md)
* [Licence, trial and Pro](licence.md)
* [Troubleshooting](troubleshooting.md)
