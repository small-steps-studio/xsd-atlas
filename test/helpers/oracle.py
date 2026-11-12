"""Independent cross-check for the test suite (never shipped).

Reads a JSON request on stdin:
  {"schemas": ["path.xsd", ...], "instances": [["schema.xsd", "instance.xml"], ...]}
and writes a JSON answer on stdout:
  {"schemas": {"path.xsd": "" or "error text"}, "instances": [{"schema":..., "instance":..., "error": ""}]}

Uses the libxml2 schema processor through the lxml binding. Network access is disabled.
"""
import io
import json
import sys

from lxml import etree


def load_schema(path):
    parser = etree.XMLParser(no_network=True, resolve_entities=False)
    doc = etree.parse(path, parser)
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
            parser = etree.XMLParser(no_network=True, resolve_entities=False)
            doc = etree.parse(instance_path, parser)
            if not schema.validate(doc):
                entry["error"] = "; ".join(str(e) for e in list(schema.error_log)[:5])
        except Exception as exc:  # noqa: BLE001
            entry["error"] = str(exc) or exc.__class__.__name__
        out["instances"].append(entry)
    sys.stdout.buffer.write(json.dumps(out).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
