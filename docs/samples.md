# Sample XML

## Create Sample XML (free)

Pick a global element; a new XML document opens with a minimal sample:

* Every required element (minOccurs of 1 or more) appears as often as minOccurs asks. Optional elements are left out.
* The first option of every choice is used, unless that option would recurse into a type that is already being written.
* Required attributes are written; optional ones are left out.
* A `fixed` or `default` value of the declaration is used as the value.
* Otherwise the value is built from the type: the first enumeration value, a string matching the pattern facets, a number inside the bounds and digit limits, a date inside the date bounds, a string of an allowed length, and so on. Every value is checked against all facets of its type before it is used.
* Abstract elements are replaced by a concrete member of their substitution group; abstract types get `xsi:type` with a concrete derived type.
* Namespaces are declared once on the root element with the prefixes the schemas use.
* Recursive structures stop when a type would be repeated, and nesting stops at 14 levels.

## Create Full Sample XML (Pro)

Adds to the minimal sample:

* all optional elements and attributes (optional default values are written out),
* repeated elements: `xsdAtlas.sample.repeat` occurrences (default 2) wherever maxOccurs allows it,
* a choice strategy: the first option, rotating through the options, picking the option of each choice in a list, or random options,
* realistic values chosen by the names of elements and attributes (`email`, `city`, `currency`, `amount`, `quantity`, `name`, ...), used only when they satisfy all facets of the type (setting `xsdAtlas.sample.realisticValues`),
* a seed (`xsdAtlas.sample.seed`): the same seed, schema and options give the same document.

Repeated elements and attributes get different values where the type allows it, which keeps xs:key and xs:unique constraints satisfied in most cases.

## What is checked, and what is not

The structure of every sample follows the content of its types (order, occurrence, choices, attributes), and every value satisfies the facets of its type, except where a note says that no value could be built. During development, the minimal and full samples of every global element in the test schemas are also checked with an independent schema validator; apart from the key reference limit below, all of them pass.

Known limits, stated in a note when they apply:

* Values that must match an xs:keyref are not coordinated with their keys.
* A value of type xs:IDREF or xs:IDREFS names an ID that the sample holds when it holds one; otherwise a note asks you to replace it with an ID of your document.
* Enumeration values of type xs:QName or xs:NOTATION are written with a prefix that the sample declares on its root element.
* A string of 100,000 characters or more, or a list of more than 10,000 items, is not built; a note says so and the sample holds a placeholder there.
* A value cannot be built when the facets contradict each other or a pattern uses a Unicode block that is not known here; the sample then holds the text `value` and a note says where.
* A required wildcard (xs:any) in strict mode needs an element that the loaded schemas declare and that does not repeat the element being written; if there is none, a comment marks the place and a note says so.
* XML Schema 1.1 assertions are not evaluated.

Samples are a starting point for tests and documentation, not proof that a message is valid. XSD Atlas does not validate XML documents against a schema.
