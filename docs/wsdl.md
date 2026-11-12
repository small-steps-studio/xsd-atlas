# WSDL support

## What is read

* **WSDL 1.1** (`wsdl:definitions`): imports, embedded schemas in `wsdl:types`, messages and parts, port types with operations (input, output, faults), bindings with the SOAP 1.1 (`soap:`) or SOAP 1.2 (`soap12:`) extensions or HTTP bindings, and services with ports and addresses.
* **WSDL 2.0** (`wsdl:description`): imports and includes, embedded schemas, interfaces (with `extends` and interface faults), operations with their message elements, SOAP bindings (`wsoap:version` 1.1 or 1.2) and services with endpoints.
* Embedded schemas are full schemas: outline, hover, go to definition, references and problems work inside them, and they may import each other by namespace or import external XSD files.
* `wsdl:import` loads further WSDL (or XSD) files from relative locations. Locations on the internet are never fetched.

## Outline

The Schema Outline of a WSDL file shows Imports, Types (each embedded schema with its own outline), Messages, Port types or Interfaces, Bindings and Services. Go to definition works on `message=`, `binding=`, `type=` (port type), `interface=`, `element=` and `type=` of parts.

## Problems

See the WSDL section of [problems.md](problems.md): unresolved messages, port types, interfaces, bindings, elements and types; operations that a binding names but the port type does not have; unknown parts; style mismatches; ports without an address.

## SOAP envelope samples (Pro)

**XSD Atlas: Create SOAP Envelope Samples** lists every operation of every SOAP binding. For the chosen operation it builds:

* the request envelope, with SOAP headers from `soap:header` parts and the body:
  * document style: the element of each body part (a part with `type=` is shown as an element named after the part, with a note),
  * rpc style: a wrapper element named after the operation, in the namespace of `soap:body` (or the WSDL target namespace), with one child per part;
* the response envelope (named `<operation>Response` in rpc style);
* one fault envelope per declared fault, in the SOAP 1.1 (`faultcode`, `faultstring`, `detail`) or SOAP 1.2 (`Code`, `Reason`, `Detail`) form.

A comment at the top of the request names the HTTP headers that go with it: `SOAPAction` for SOAP 1.1, the `action` parameter of the content type for SOAP 1.2, and the endpoint address when a port uses the binding.

The envelopes are built locally from the schemas; nothing is sent anywhere. `use="encoded"` (SOAP encoding) is not modelled: the body is written as literal XML.
