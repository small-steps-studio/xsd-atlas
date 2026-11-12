"""Independent cross-check for the comparison tests (never shipped).

Reads a JSON request on stdin:
  {"pairs": [{"old": "<xs:schema ...>", "new": "<xs:schema ...>"}, ...],
   "names": ["a", "b", "c"], "maxLength": 4}
Every sequence of child element names up to maxLength is written as a document
<root xmlns="urn:t"><a>x</a>...</root> and validated against both schemas with the libxml2
schema processor (lxml). The answer lists, per pair:
  {"ok": false}                                    when a schema does not compile
  {"ok": true, "lost": [...], "gained": [...]}     the first sequences that were valid under the
                                                   old schema and are invalid under the new one
                                                   ("lost"), and the other way round ("gained").
"""
import io
import itertools
import json
import sys

from lxml import etree


def compile_schema(text):
    try:
        return etree.XMLSchema(etree.fromstring(text.encode("utf-8")))
    except Exception:  # noqa: BLE001 - a schema that does not compile is skipped
        return None


def document(seq):
    return etree.fromstring(('<root xmlns="urn:t">' + "".join("<%s>x</%s>" % (n, n) for n in seq) + "</root>").encode("utf-8"))


def main():
    req = json.load(io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8"))
    names = req["names"]
    seqs = [()]
    for n in range(1, req["maxLength"] + 1):
        seqs.extend(itertools.product(names, repeat=n))
    docs = [(s, document(s)) for s in seqs]
    out = []
    for pair in req["pairs"]:
        old = compile_schema(pair["old"])
        new = compile_schema(pair["new"])
        if old is None or new is None:
            out.append({"ok": False})
            continue
        lost, gained = [], []
        for s, d in docs:
            a = old.validate(d)
            b = new.validate(d)
            if a and not b and len(lost) < 3:
                lost.append(list(s))
            elif b and not a and len(gained) < 3:
                gained.append(list(s))
        out.append({"ok": True, "lost": lost, "gained": gained})
    sys.stdout.buffer.write(json.dumps(out).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
