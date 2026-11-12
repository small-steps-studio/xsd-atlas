# Schema comparison: rules and classification

The comparison (Pro) loads both versions with everything they include and import, then compares them component by component: global elements, types, groups, attribute groups, attributes, notations and identity constraints, matched by kind, namespace and name.

## The three classes

| Class | Meaning |
| --- | --- |
| **BREAKING** | A document that is valid under the old version can be invalid under the new version, or the same document is read differently (for example a changed default value), or another schema that builds on this one can stop working (a removed global component, a type that no longer derives from its old base). |
| **NON-BREAKING** | Every document that is valid under the old version stays valid and means the same. The new version accepts more (an added optional element, a widened facet, a new enumeration value). |
| **DOCUMENTATION** | Only annotations, the version attribute or other text changed; documents are not affected. |

The point of view is the document: "can a document written for the old version still be sent and accepted?". The other direction (an old receiver reading documents written for the new version) is the mirror image: a NON-BREAKING change such as a new enumeration value or a new optional element can still surprise a receiver that was written for the old version. Read NON-BREAKING as "old documents stay valid", not as "nobody needs to look".

## How content is compared

* Content is compared in its **effective** form: group references are expanded and the content of an extension is appended to the content of its base type. Moving declarations into a named group, or between a type and its base, is therefore not a change for documents (the new group itself is reported as an added component).
* Child elements are matched by namespace and name (with a running number when the same name appears twice in one content).
* **Effective occurrence**: the minOccurs and maxOccurs of an element are multiplied by those of the compositors around it, and an element inside a choice with more than one option counts as optional. "Became required" and "became optional" use these effective values.
* **Requirements inside optional groups and choice branches**: an element that is required only when its optional group or its choice branch is used has a second requirement, the one inside that group or branch. When it rises (a required element is added to one branch of a choice, an element of an optional group becomes required, a minimum is raised inside an optional choice), documents that use the group or branch without the element become invalid: `child-added-conditional` and `became-required-in-group` report this as BREAKING, and `became-optional-in-group` is the NON-BREAKING mirror. `group-became-required` and `group-became-optional` report a choice or sequence that could be left out (or satisfied by no content) and no longer can, or the reverse.
* **Exact check of the child elements**: after the element-by-element comparison, the order, names and counts of the child elements of one content are compared as a whole: does the new version accept every sequence of child elements that the old version accepts? When it finds a sequence that the old version accepts and the new one refuses, and no change above says so, `content-narrowed` is added and names such a sequence as an example. When it proves that the new version accepts every old sequence, a BREAKING change about names, order or counts that the exact check disproves is taken back and `content-reorganised` (NON-BREAKING) is reported instead; this covers content moved between groups and similar rewrites. Declarations of the same name that follow each other (`maxOccurs="2"` written as one declaration followed by an optional one, for example) are compared by their total occurrence range first; when that range is unchanged, nothing is reported. The content of an `xs:all` (every child at most once, in any order) is decided directly, so wide records stay fast. For other contents the exact check works on a fixed amount of work and a fixed time (150 milliseconds per content, 3 seconds for one comparison); when a content is too large or too deeply nested for that, or the time is used up, the check gives up on that content ("not verified"). A content that changed in any way and could not be verified is then reported as `content-not-verified` (BREAKING) unless a change above already says BREAKING, so a timeout can add reports (a harmless rewrite of a very large content may be reported as breaking) but never removes one. Which contents run into the limit depends a little on the speed of the computer.
* **Order** matters only in sequences: when two elements that are in a sequence in both versions swap places, the moved element is reported once (the longest unchanged order is kept as the reference). The same holds for two elements that share one sequence inside a choice branch.
* **Wildcards**: when an element or attribute disappears at a place where the new version has a wildcard that admits its name, the change is NON-BREAKING (`child-covered-by-wildcard`, `attribute-covered-by-wildcard`) as long as the content is checked against the same declaration as before or not at all; a wildcard that checks it against another global declaration keeps the removal BREAKING.
* A change inside a named group or a named base type is reported once, under that group or type, not again under every type that uses it.
* Elements that refer to a global element (`ref=`) are compared by occurrence only; the global element's own changes are reported under the element.
* A named type is compared once, under its own name. An element that keeps the same named type reports nothing for it; an element whose type name changes reports `type-changed` or `type-widened`.
* Facet values are compared as values: `10.50` and `10.5` are the same decimal, dates are compared as dates.
* When the target namespace of the compared files changed, components are matched across the change and the change is reported once as `namespace-changed`.

## Every change code

| Code | Class | Example |
| --- | --- | --- |
| `namespace-changed` | BREAKING | targetNamespace `urn:v1` becomes `urn:v2`. |
| `element-form-changed` | BREAKING | elementFormDefault changes from qualified to unqualified. |
| `attribute-form-changed` | BREAKING | attributeFormDefault changes. |
| `version-changed` | DOCUMENTATION | The `version` attribute of xs:schema changes from 1.0 to 2.0. |
| `import-added` | NON-BREAKING | The schema imports a new namespace (its components are compared separately). |
| `import-removed` | NON-BREAKING | An import is removed (removed components are reported separately). |
| `component-removed` | BREAKING | The global type `AddressType` is removed. |
| `component-added` | NON-BREAKING | A new global element `invoiceCorrection` is added. |
| `constraint-added` | BREAKING | A new xs:key or xs:unique constraint restricts documents. |
| `constraint-removed` | NON-BREAKING | An identity constraint is removed. |
| `type-changed` | BREAKING | `quantity` changes from xs:string to xs:int, or from one named type to another. |
| `type-widened` | NON-BREAKING | `quantity` changes from xs:int to xs:long (the old built-in type derives from the new one). |
| `type-kind-changed` | BREAKING | A simple type becomes a complex type. |
| `type-inlined` | NON-BREAKING | A named type is replaced by an inline type; the content is compared as well. |
| `type-named` | NON-BREAKING | An inline type is replaced by a named type; the content is compared as well. |
| `base-type-changed` | BREAKING | A simple type moves from an xs:string base to an xs:int base, or a complex type no longer derives from its old base. |
| `base-widened` | NON-BREAKING | A simple type moves from an xs:int base to an xs:long base. |
| `variety-changed` | BREAKING | An atomic type becomes a list or a union. |
| `content-type-changed` | BREAKING | Simple content becomes element content, or empty content gains required elements. |
| `child-removed` | BREAKING | The element `fax` is removed from a sequence (documents that contain it become invalid, even if it was optional). |
| `child-added-required` | BREAKING | A required element `deliveryDate` is added. |
| `child-added-optional` | NON-BREAKING | An optional element `phone` is added. |
| `child-added-conditional` | BREAKING | A required element `lineId` is added to one branch of a choice, or to an optional group: documents that use that branch or group without it become invalid. |
| `child-covered-by-wildcard` | NON-BREAKING | The optional element `note` is replaced, at the same place, by an `xs:any` that still admits it. |
| `content-narrowed` | BREAKING | The exact check of the child elements finds content the old version accepts and the new one refuses, for example an empty element that is no longer allowed (the message names an example). |
| `content-reorganised` | NON-BREAKING | Content is rearranged (declarations moved, a repeated element written out twice) and every sequence of child elements that was accepted before still is. |
| `became-required` | BREAKING | minOccurs of `email` changes from 0 to 1. |
| `became-optional` | NON-BREAKING | minOccurs of `email` changes from 1 to 0. |
| `became-required-in-group` | BREAKING | A minimum is raised, or an element is made required, inside an optional group or a choice branch (it was needed less often, or not at all, when that group or branch was used). |
| `became-optional-in-group` | NON-BREAKING | The mirror image: an element inside an optional group or a choice branch is needed less often. |
| `group-became-required` | BREAKING | An optional `xs:choice` or `xs:sequence` (or one that could be satisfied by no content) can no longer be left out. |
| `group-min-increased` | BREAKING | A `xs:choice` or `xs:sequence` that may repeat now has to occur more often: minOccurs 1 becomes 2 on `<xs:choice maxOccurs="3">`. |
| `content-not-verified` | BREAKING | The child elements of a content changed and the exact check could not decide (the content is too large or the time for the check ran out); treated as breaking, test your documents against the new version. |
| `group-became-optional` | NON-BREAKING | A required `xs:choice` or `xs:sequence` may now be left out or be empty. |
| `occurrence-min-increased` | BREAKING | minOccurs changes from 1 to 2. |
| `occurrence-min-decreased` | NON-BREAKING | minOccurs changes from 2 to 1. |
| `occurrence-max-decreased` | BREAKING | maxOccurs changes from 5 to 3. |
| `occurrence-max-increased` | NON-BREAKING | maxOccurs changes from 3 to unbounded. |
| `moved-into-choice` | BREAKING | An element that could appear together with others becomes one option of a choice. |
| `moved-out-of-choice` | NON-BREAKING | An element is no longer an option of a choice (requirements are reported separately). |
| `order-changed` | BREAKING | Two elements of a sequence swap places. |
| `compositor-changed` | BREAKING | xs:all becomes xs:sequence, or a sequence becomes a choice (with more than one child). |
| `compositor-relaxed` | NON-BREAKING | xs:sequence becomes xs:all: the old order is still accepted. |
| `attribute-removed` | BREAKING | The attribute `channel` is removed, or its declaration becomes `use="prohibited"`. |

| `attribute-added-required` | BREAKING | A required attribute is added. |
| `attribute-added-optional` | NON-BREAKING | An optional attribute is added, or a prohibited one becomes optional. |
| `attribute-became-required` | BREAKING | use="optional" becomes use="required". |
| `attribute-became-optional` | NON-BREAKING | use="required" becomes optional. |
| `attribute-covered-by-wildcard` | NON-BREAKING | An optional attribute is replaced by an `xs:anyAttribute` that still admits it. |
| `facet-added` | BREAKING | A pattern, a length, a bound or an enumeration list is added. |
| `facet-removed` | NON-BREAKING | A pattern, length, bound or digits facet is removed. |
| `facet-narrowed` | BREAKING | maxLength 10 becomes 5; minInclusive 0 becomes 1; minInclusive 0 becomes minExclusive 0. A `length` facet written out as `minLength` and `maxLength` of the same value is not a change. |
| `facet-widened` | NON-BREAKING | maxLength 5 becomes 10; fractionDigits 2 becomes 4. |
| `facet-changed` | BREAKING | length 5 becomes 6; whiteSpace changes; assertions change (conservative: the effect cannot be decided in general). |
| `pattern-changed` | BREAKING | The pattern `[A-Z]+` becomes `[A-Z]{2}` (whether the new pattern accepts every old value cannot be decided in general, so it is treated as breaking). |
| `enumeration-removed` | BREAKING | The allowed value `5l` is removed. Values of numeric, date and similar types are compared as values (`1.0` and `1.00` are the same decimal); values of string-like types are compared as text. |
| `enumeration-added` | NON-BREAKING | The allowed value `3l` is added. |
| `enumeration-dropped` | NON-BREAKING | The whole list of allowed values is removed. |
| `list-item-changed` | BREAKING | A list of xs:int becomes a list of xs:date. |
| `union-member-removed` | BREAKING | A member type of a union is removed; members written inline are compared one by one in their order, so a removed inline member is reported too. |
| `union-member-added` | NON-BREAKING | A member type (named or inline) is added to a union. |
| `union-order-changed` | NON-BREAKING | The member types of a union are reordered (the first matching member decides the typed value). |
| `default-changed` | BREAKING | A default value changes: documents that leave the value out now mean something else. |
| `default-removed` | BREAKING | A default value is removed. |
| `default-added` | NON-BREAKING | A default value is added. |
| `fixed-added` | BREAKING | A fixed value is added. |
| `fixed-removed` | NON-BREAKING | A fixed value is removed. |
| `fixed-changed` | BREAKING | A fixed value changes. |
| `nillable-removed` | BREAKING | nillable="true" is removed. |
| `nillable-added` | NON-BREAKING | nillable="true" is added. |
| `abstract-added` | BREAKING | An element or type becomes abstract. |
| `abstract-removed` | NON-BREAKING | An element or type is no longer abstract. |
| `mixed-removed` | BREAKING | Text between child elements is no longer allowed. |
| `mixed-added` | NON-BREAKING | Text between child elements is now allowed. |
| `wildcard-added` | NON-BREAKING | An optional xs:any is added. |
| `wildcard-added-required` | BREAKING | A required xs:any is added. |
| `wildcard-removed` | BREAKING | An xs:any is removed. |
| `wildcard-narrowed` | BREAKING | processContents lax becomes strict, or fewer namespaces are allowed. |
| `wildcard-widened` | NON-BREAKING | processContents strict becomes lax, or more namespaces are allowed. |
| `any-attribute-added` | NON-BREAKING | xs:anyAttribute is added. |
| `any-attribute-removed` | BREAKING | xs:anyAttribute is removed. |
| `substitution-group-added` | NON-BREAKING | An element may now substitute for a head element. |
| `substitution-group-removed` | BREAKING | An element no longer substitutes for its head. |
| `substitution-group-changed` | BREAKING | An element substitutes for another head. |
| `block-added` | BREAKING | block="substitution" is added to an element or type. |
| `block-removed` | NON-BREAKING | A block value is removed. |
| `final-added` | BREAKING | final="extension" is added (schemas that derive from the type break). |
| `final-removed` | NON-BREAKING | A final value is removed. |
| `documentation-changed` | DOCUMENTATION | The text of xs:documentation changes (white space alone is ignored). |
| `documentation-added` | DOCUMENTATION | Documentation is added. |
| `documentation-removed` | DOCUMENTATION | Documentation is removed. |

## Limits

The comparison errs on the safe side: where it cannot decide, it reports BREAKING. It can still be wrong in both directions, so treat it as a careful reading aid and test your own documents before you rely on a NON-BREAKING verdict.

* Patterns, assertions and whiteSpace changes are classified conservatively as BREAKING, because whether one regular expression accepts everything another one accepts cannot be decided in general. Widening rewrites of a pattern (for example `[a-z]+` becomes `[a-z]*`) are therefore reported as `pattern-changed` as well.
* A change of a simple type to a wider unrelated type is reported as `type-changed` (for example xs:int to xs:string, although every integer is also a valid string); a list whose item type changes is reported as `list-item-changed` in the same way.
* Two different named types are reported as `type-changed` even when their content is the same; the content of each named type is compared under its own name.
* The exact check of the child elements (see above) looks at names, order and counts only. It does not decide whether the type or the content of a child element accepts the same values; those are compared on their own.
* Requirement changes inside optional groups and choice branches are classified by the rules above. Unusual constructions (deeply nested groups, wildcards combined with substitution groups, very large contents) can still be classified more cautiously, or in rare cases less cautiously, than a full schema processor would; the exact check gives up after a fixed amount of work or time; the content is then reported as `content-not-verified` (BREAKING) when it changed.
* Changes in WSDL documents (messages, operations, bindings) are not compared; the schemas embedded in a WSDL are.
* The comparison reads schema structure only. It does not run documents through either version.
