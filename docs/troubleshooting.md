# Troubleshooting

**The file is not recognised.** XSD Atlas works on `.xsd` and `.wsdl` files and on XML files whose root element is `xs:schema`, `wsdl:definitions` or `wsdl:description` with the usual namespace in the first 8 KB. Check that the file's language (bottom right) is XML.

**"file over limit" in the status bar.** The file is larger than `xsdAtlas.maxFileSizeMB` (default 10 MB). Run **XSD Atlas: Check Current File** to check it on demand, or raise the setting (the highest value is 32 MB; a schema set above 32 MB, all files together, is not analysed at all, so that the editor never runs out of memory: split it into files that include each other).

**A type from an imported schema is reported as unresolved.** Check the schemaLocation: it is resolved relative to the file that contains it. If the location is on the internet or on another computer (a network share such as `\\server\share`), it is never fetched: keep a local copy and point schemaLocation at it. Without schemaLocation, the namespace must be provided by another loaded schema (for example another schema embedded in the same WSDL).

**XSD-NAMESPACE-NOT-IMPORTED although the type exists.** A schema document may only refer to its own namespace, the XML Schema namespace and namespaces it imports itself. Add `<xs:import namespace="..."/>` to the document that uses the reference.

**Go to definition finds nothing.** The reference must resolve in the loaded schema set (the file, its imports and includes); as a fallback XSD Atlas searches the schema files of the workspace (setting `xsdAtlas.workspace.include`, at most `xsdAtlas.workspace.maxFiles` files).

**Find references misses a use in another file.** Only files in the workspace folders that match `xsdAtlas.workspace.include` are searched.

**A sample contains the text `value` or a comment.** The note shown with the sample says why: contradictory facets, an unknown Unicode block in a pattern, an abstract element without a substitute or a strict wildcard without a matching element. See [samples.md](samples.md).

**Flatten refuses the schema.** Sets that use xs:redefine or xs:override are not flattened, because merging them would change their meaning.

**Compare With Git Revision says there is no repository.** The file must be inside a folder that the built-in Git extension recognises as a repository, and the revision must contain the file. Use **Compare Schema With Another File** with an exported copy instead.

**A Pro command shows the Pro message although you have a key.** Run **XSD Atlas: Show Licence Status**; it names the state and offers **Enter Licence Key** and **Lost your key?**. See [licence.md](licence.md).

**Anything else.** Run **XSD Atlas: Report A Problem**: it copies a diagnostics block (versions, platform, settings, licence state; no file contents, names or namespaces) and opens the issues page. Attach a small schema without confidential content.
