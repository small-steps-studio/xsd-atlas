"""Independent cross-check for the test suite (never shipped).

Reads a JSON request on stdin:
  {"schemas": ["path.xsd", ...], "instances": [["schema.xsd", "instance.xml"], ...]}
and writes a JSON answer on stdout:
  {"schemas": {"path.xsd": "" or "error text"}, "instances": [{"schema":..., "instance":..., "error": ""}]}

Uses the libxml2 schema processor through the lxml binding. Network access is never used:
  - the parser option no_network only covers the parser itself, not the schemas that libxml2 loads
    for xs:import and xs:include, and a libxml2 build with HTTP support (the Windows wheels of lxml)
    would fetch those addresses while a build without it (Linux and macOS wheels) cannot;
  - so every schema location that is a web address goes through OfflineResolver: the published
    locations of the schema of the XML namespace are answered from the file xml-namespace.xsd next
    to this script, any other web address is refused (the import then fails with a load error).
"""
import io
import json
import os
import re
import sys

from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
XML_NAMESPACE_SCHEMA = os.path.join(HERE, "xml-namespace.xsd")
# Published locations of the schema of http://www.w3.org/XML/1998/namespace (xml:lang, xml:space, xml:base, xml:id).
XML_NAMESPACE_URLS = frozenset([
    "http://www.w3.org/2001/xml.xsd",
    "https://www.w3.org/2001/xml.xsd",
    "http://www.w3.org/2009/01/xml.xsd",
    "https://www.w3.org/2009/01/xml.xsd",
])
WEB_ADDRESS = re.compile(r"^(?:https?|ftp)://", re.IGNORECASE)


class OfflineResolver(etree.Resolver):
    """Answers web addresses locally; file paths fall through to the normal loader."""

    def resolve(self, url, pubid, context):
        if url is None:
            return None
        if url.lower() in XML_NAMESPACE_URLS:
            return self.resolve_filename(XML_NAMESPACE_SCHEMA, context)
        if WEB_ADDRESS.match(url):
            return self.resolve_string(b"", context)  # refused: nothing is fetched, the import fails to load
        return None


def new_parser():
    parser = etree.XMLParser(no_network=True, resolve_entities=False)
    parser.resolvers.add(OfflineResolver())
    return parser


def load_schema(path):
    doc = etree.parse(path, new_parser())
    return etree.XMLSchema(doc)


def main():
    # The request is UTF-8 JSON whatever the console code page is, so that paths with non-ASCII
    # characters arrive intact; the answer is written as UTF-8 for the same reason.
    req = json.load(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8"))
    out = {"schemas": {}, "instances": []}
    cache = {}
    for path in req.get("schemas", []):
        try:
            cache[path] = load_schema(path)
            out["schemas"][path] = ""
        except Exception as exc:  # noqa: BLE001 - every failure is reported as text
            out["schemas"][path] = str(exc) or exc.__class__.__name__
    for schema_path, instance_path in req.get("instances", []):
        entry = {"schema": schema_path, "instance": instance_path, "error": ""}
        try:
            schema = cache.get(schema_path) or load_schema(schema_path)
            cache[schema_path] = schema
            doc = etree.parse(instance_path, new_parser())
            if not schema.validate(doc):
                entry["error"] = "; ".join(str(e) for e in list(schema.error_log)[:5])
        except Exception as exc:  # noqa: BLE001
            entry["error"] = str(exc) or exc.__class__.__name__
        out["instances"].append(entry)
    sys.stdout.buffer.write(json.dumps(out).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
