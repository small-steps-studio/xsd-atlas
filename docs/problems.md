# Problems and their codes

XSD Atlas reports problems of schema and WSDL files in the editor and in the Problems view. Every problem has a stable code, so you can search for it, filter by it and refer to it in a ticket.

These are **common structural checks** of the schema documents themselves: references, names, namespaces, derivation, facets, occurrence values and the files a schema names. They do not amount to a complete check of every rule of the XML Schema specification, and XSD Atlas never validates XML documents (instances) against a schema.

Files are checked when they open, when they are saved and (setting `xsdAtlas.validateOnType`) while you type. Files above `xsdAtlas.maxFileSizeMB` are only checked with **XSD Atlas: Check Current File**.

## Well-formedness (XML)

| Code | Meaning |
| --- | --- |
| `XML-NO-ROOT` | The file has no root element. |
| `XML-MULTIPLE-ROOTS` | A second root element follows the first. |
| `XML-TEXT-OUTSIDE-ROOT` | Text or CDATA outside the root element. |
| `XML-INVALID-NAME` | A tag or processing instruction name is not a valid XML name (a literal `<` must be written `&lt;`). |
| `XML-UNCLOSED-TAG` | A start or end tag is not closed with `>`. |
| `XML-UNCLOSED-ELEMENT` | An element has no end tag. |
| `XML-UNEXPECTED-END-TAG` | An end tag without a start tag. |
| `XML-MISMATCHED-END-TAG` | An end tag that does not match the open element. |
| `XML-INVALID-ATTRIBUTE` | Unexpected character inside a tag. |
| `XML-MISSING-SPACE` | Two attributes without white space between them. |
| `XML-ATTRIBUTE-WITHOUT-VALUE` | An attribute without `="..."`. |
| `XML-UNQUOTED-ATTRIBUTE` | An attribute value without quotes. |
| `XML-UNCLOSED-ATTRIBUTE` | An attribute value without its closing quote. |
| `XML-LT-IN-ATTRIBUTE` | A `<` inside an attribute value. |
| `XML-DUPLICATE-ATTRIBUTE` | The same attribute twice on one element (also after namespace resolution). |
| `XML-UNDECLARED-PREFIX` | An element or attribute prefix without a namespace declaration. |
| `XML-BAD-NAMESPACE-DECLARATION` | A namespace declaration XML does not allow (for example binding `xmlns` or rebinding `xml`). |
| `XML-BARE-AMPERSAND` | An `&` that does not start a reference. |
| `XML-INVALID-CHAR-REF` | A character reference to a character XML does not allow. |
| `XML-UNDEFINED-ENTITY` | A reference to an entity that is not declared. |
| `XML-EXTERNAL-ENTITY` | A reference to an external entity. External entities are never loaded. |
| `XML-ENTITY-MARKUP` | An entity whose text contains markup (not expanded). |
| `XML-ENTITY-LIMIT` | An entity that is recursive or expands to more than 1,000,000 characters (not expanded). |
| `XML-BAD-DOCTYPE` | A document type declaration that cannot be read or is in the wrong place. |
| `XML-INVALID-MARKUP` | Markup starting with `<!` that is not a comment, CDATA section or document type declaration. |
| `XML-UNCLOSED-COMMENT` | A comment without `-->`. |
| `XML-COMMENT-DOUBLE-HYPHEN` | `--` inside a comment. |
| `XML-UNCLOSED-CDATA` | A CDATA section without `]]>`. |
| `XML-CDATA-END-IN-TEXT` | The text `]]>` in element content (write `]]&gt;`). |
| `XML-INVALID-CHARACTER` | A character that XML 1.0 does not allow in text, such as U+0000 or U+0001. |
| `XML-UNCLOSED-PI` | A processing instruction without `?>`. |
| `XML-DECLARATION-POSITION` | The XML declaration is not at the very start of the file. |
| `XML-BAD-DECLARATION` | The XML declaration has no or an unsupported version. |
| `XML-TOO-DEEP` | Elements are nested more than 2,048 levels deep; the rest is not read. |
| `XML-TOO-MANY-ERRORS` | More than 200 well-formedness problems; the rest are not listed. |

## Schema references and names

| Code | Meaning |
| --- | --- |
| `XSD-UNRESOLVED-TYPE` | `type`, `base`, `itemType` or `memberTypes` names a type that no loaded schema declares (or a name that is not a built-in type). |
| `XSD-UNRESOLVED-ELEMENT` | `ref` or `substitutionGroup` names an element that is not declared. |
| `XSD-UNRESOLVED-ATTRIBUTE` | `ref` names an attribute that is not declared. |
| `XSD-UNRESOLVED-GROUP` | `ref` names a group that is not declared. |
| `XSD-UNRESOLVED-ATTRIBUTE-GROUP` | `ref` names an attribute group that is not declared. |
| `XSD-UNRESOLVED-IDENTITY` | `refer` of an xs:keyref names no xs:key or xs:unique. |
| `XSD-UNDECLARED-PREFIX` | The prefix of a QName value is not declared. |
| `XSD-NAMESPACE-NOT-IMPORTED` | A reference uses a namespace that this schema document does not import (a warning inside WSDL files, where many tools accept it). |
| `XSD-DUPLICATE-NAME` | Two global declarations of the same kind share a name in one namespace. |
| `XSD-DUPLICATE-ATTRIBUTE` | A type declares the same attribute twice (also through attribute groups or extension). |
| `XSD-INVALID-NAME` | A `name` value is not a valid name without a colon. |
| `XSD-MISSING-NAME` | A top-level declaration, local element or attribute has neither a name nor a ref. |
| `XSD-REF-AND-NAME` | A local element or attribute has both a name and a ref. |
| `XSD-NOT-ALLOWED-HERE` | An attribute that is not allowed in this place (for example minOccurs on a top-level element, a name on a nested type, a type next to ref). |
| `XSD-UNKNOWN-ATTRIBUTE` | An attribute without a namespace that XML Schema does not define on this element, for example `typ` instead of `type`; the message names the closest valid attribute. Schema processors either ignore such an attribute (so the declaration silently loses its type) or refuse the schema. |
| `XSD-UNKNOWN-ELEMENT` | An element in the XML Schema namespace that XML Schema does not define (often a typing error). |
| `XSD-INCONSISTENT-ELEMENT` | (warning) The same element name appears twice in one content with different types. |

## Derivation and structure

| Code | Meaning |
| --- | --- |
| `XSD-CIRCULAR-DERIVATION` | A type derives from itself, directly or through other types. |
| `XSD-CIRCULAR-GROUP` | A group refers to itself. |
| `XSD-CIRCULAR-ATTRIBUTE-GROUP` | An attribute group refers to itself. |
| `XSD-CIRCULAR-SUBSTITUTION` | An element is, through its heads, in its own substitution group. |
| `XSD-INVALID-DERIVATION` | Complex content derived from a simple type. |
| `XSD-INVALID-OCCURS` | minOccurs or maxOccurs is not a number (or `unbounded`), or minOccurs is larger than maxOccurs. |
| `XSD-ALL-OCCURS` | (note) maxOccurs above 1 inside xs:all, which only XML Schema 1.1 allows. |
| `XSD-DEFAULT-AND-FIXED` | Both default and fixed on one declaration. |
| `XSD-INVALID-DEFAULT` | A default or fixed value that is not valid for the type (or a value on an element with element-only content). |

## Facets

| Code | Meaning |
| --- | --- |
| `XSD-INVALID-FACET` | A facet that does not apply to the base type (maxLength on xs:int), a value of the wrong form, minLength above maxLength, fractionDigits above totalDigits, a lower bound above the upper bound, a facet that loosens the base type, an enumeration value that the base type does not allow, or a pattern that is not a valid XML Schema regular expression. |
| `XSD-PATTERN-NOT-CHECKED` | (note) A pattern uses a Unicode block escape (`\p{Is...}`) that this extension does not know, or repeats a part that itself repeats (such as `(a+)+`), which could make testing values against it very slow. Values are then not tested against that pattern; samples are still built from it where possible. |

## Files, namespaces and imports

| Code | Meaning |
| --- | --- |
| `XSD-MISSING-FILE` | The file named in schemaLocation does not exist (an error for include and redefine, a warning for import). |
| `XSD-MISSING-SCHEMA-LOCATION` | xs:include or xs:redefine without schemaLocation. |
| `XSD-UNREACHABLE-IMPORT` | An import whose schema is not loaded: its location is on the internet (never fetched), or it has no schemaLocation and no loaded schema has its namespace. References into it are not checked. |
| `XSD-NOT-A-SCHEMA` | The file named in schemaLocation is not an XML Schema. |
| `XSD-TARGET-NAMESPACE` | An empty targetNamespace, an included file with another namespace, an imported file whose namespace differs from the import, or an import of the schema's own namespace. |
| `XSD-CHAMELEON-INCLUDE` | (note) An included file without targetNamespace takes the namespace of the including schema. |
| `XSD-SET-TOO-LARGE` | (note) The schema set reached the limit of 1,000 documents or 300 MB of text; some files were not loaded. |

## WSDL

| Code | Meaning |
| --- | --- |
| `WSDL-UNRESOLVED-MESSAGE` | An input, output, fault or header names a message that does not exist. |
| `WSDL-UNRESOLVED-PORT-TYPE` | A WSDL 1.1 binding names a port type that does not exist. |
| `WSDL-UNRESOLVED-INTERFACE` | A WSDL 2.0 binding, service or `extends` names an interface that does not exist. |
| `WSDL-UNRESOLVED-BINDING` | A port or endpoint names a binding that does not exist. |
| `WSDL-UNRESOLVED-ELEMENT` | A part or message element names an element that the schemas do not declare. |
| `WSDL-UNRESOLVED-TYPE` | A part names a type that the schemas do not declare. |
| `WSDL-UNRESOLVED-FAULT` | An infault or outfault names a fault the interface does not declare. |
| `WSDL-UNDECLARED-PREFIX` | The prefix of a reference is not declared. |
| `WSDL-DUPLICATE-NAME` | Two messages, port types, bindings or services share a name. |
| `WSDL-PART-ELEMENT-AND-TYPE` | A part names both an element and a type, or neither. |
| `WSDL-BINDING-OPERATION-MISSING` | A binding names an operation that its port type or interface does not have. |
| `WSDL-OPERATION-NOT-BOUND` | (note) An operation of the port type is not part of the binding. |
| `WSDL-UNKNOWN-PART` | soap:body `parts` or soap:header `part` names a part the message does not have. |
| `WSDL-NO-ADDRESS` | (warning) A port without an address. |
| `WSDL-STYLE-MISMATCH` | (warning) A document-style part that names a type, or an rpc-style part that names an element. |
| `WSDL-MISSING-FILE` | The file named by wsdl:import or wsdl:include does not exist. |
| `WSDL-UNREACHABLE-IMPORT` | (note) The import location is on the internet and is not loaded. |

## What the checks do not cover

The checks are meant to be free of false alarms rather than complete. These errors are known not to be reported (a schema processor will refuse the schema): content that is ambiguous because the same element name can be matched by two particles (the "unique particle attribution" rule), an element with `maxOccurs` above 1 inside `xs:all` (shown as a note only, because XML Schema 1.1 allows it), a list whose item type is itself a list, a substitution group member whose type does not derive from the type of the head element, and the many value-space rules that only a schema processor applies. The outline, the hovers and the sample builder keep working on such a schema as far as it can be read.
