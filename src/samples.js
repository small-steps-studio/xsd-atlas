'use strict';
// Short sample files for the Open Sample commands and the walkthrough. Invented structures and
// data; no text from any standard or vendor schema.

const ORDER_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:gc="urn:example:garden-centre:order"
           targetNamespace="urn:example:garden-centre:order"
           elementFormDefault="qualified" version="1.0">
  <xs:annotation>
    <xs:documentation>Orders that a garden centre sends to a plant nursery. Invented sample.</xs:documentation>
  </xs:annotation>
  <xs:element name="plantOrder" type="gc:PlantOrderType"/>
  <xs:complexType name="PlantOrderType">
    <xs:sequence>
      <xs:element name="orderId" type="gc:OrderIdType"/>
      <xs:element name="orderedOn" type="xs:date"/>
      <xs:element name="buyer" type="gc:PartyType"/>
      <xs:element name="line" type="gc:LineType" maxOccurs="unbounded"/>
      <xs:element name="deliveryNote" type="xs:string" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute name="currency" type="gc:CurrencyType" default="EUR"/>
  </xs:complexType>
  <xs:complexType name="PartyType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="email" type="xs:string" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute name="partyId" type="xs:token" use="required"/>
  </xs:complexType>
  <xs:complexType name="LineType">
    <xs:annotation>
      <xs:documentation>One plant variety with its pot size and quantity.</xs:documentation>
    </xs:annotation>
    <xs:sequence>
      <xs:element name="variety" type="xs:string"/>
      <xs:element name="potSize" type="gc:PotSizeType"/>
      <xs:element name="quantity" type="xs:positiveInteger"/>
      <xs:element name="unitPrice" type="gc:AmountType"/>
    </xs:sequence>
  </xs:complexType>
  <xs:simpleType name="OrderIdType">
    <xs:restriction base="xs:string">
      <xs:pattern value="GC-[0-9]{6}"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="PotSizeType">
    <xs:restriction base="xs:token">
      <xs:enumeration value="9cm"/>
      <xs:enumeration value="12cm"/>
      <xs:enumeration value="2l"/>
      <xs:enumeration value="5l"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="AmountType">
    <xs:restriction base="xs:decimal">
      <xs:minInclusive value="0"/>
      <xs:fractionDigits value="2"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="CurrencyType">
    <xs:restriction base="xs:string">
      <xs:pattern value="[A-Z]{3}"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>
`;

const ORDER_V2 = ORDER_V1
  .replace('elementFormDefault="qualified" version="1.0"', 'elementFormDefault="qualified" version="2.0"')
  .replace('<xs:element name="deliveryNote" type="xs:string" minOccurs="0"/>', '<xs:element name="deliveryDate" type="xs:date"/>\n      <xs:element name="deliveryNote" type="xs:string" minOccurs="0"/>')
  .replace('<xs:element name="email" type="xs:string" minOccurs="0"/>', '<xs:element name="email" type="xs:string" minOccurs="0"/>\n      <xs:element name="phone" type="xs:string" minOccurs="0"/>')
  .replace('<xs:enumeration value="5l"/>\n', '')
  .replace('<xs:enumeration value="2l"/>', '<xs:enumeration value="2l"/>\n      <xs:enumeration value="3l"/>')
  .replace('One plant variety with its pot size and quantity.', 'One plant variety, its pot size and the number of pots.');

const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:pc="urn:example:plant-care:service"
                  targetNamespace="urn:example:plant-care:service" name="PlantCareService">
  <wsdl:documentation>Watering advice for potted plants. Invented sample service.</wsdl:documentation>
  <wsdl:types>
    <xs:schema targetNamespace="urn:example:plant-care:service" elementFormDefault="qualified">
      <xs:element name="GetWateringAdvice">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="variety" type="xs:string"/>
            <xs:element name="potLitres" type="xs:decimal"/>
            <xs:element name="indoor" type="xs:boolean" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="WateringAdvice">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="everyDays" type="xs:positiveInteger"/>
            <xs:element name="millilitres" type="xs:positiveInteger"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="UnknownVariety" type="xs:string"/>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="AdviceRequest"><wsdl:part name="parameters" element="pc:GetWateringAdvice"/></wsdl:message>
  <wsdl:message name="AdviceResponse"><wsdl:part name="parameters" element="pc:WateringAdvice"/></wsdl:message>
  <wsdl:message name="UnknownVarietyFault"><wsdl:part name="detail" element="pc:UnknownVariety"/></wsdl:message>
  <wsdl:portType name="PlantCarePort">
    <wsdl:operation name="GetWateringAdvice">
      <wsdl:input message="pc:AdviceRequest"/>
      <wsdl:output message="pc:AdviceResponse"/>
      <wsdl:fault name="UnknownVariety" message="pc:UnknownVarietyFault"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="PlantCareSoap" type="pc:PlantCarePort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="GetWateringAdvice">
      <soap:operation soapAction="urn:example:plant-care:GetWateringAdvice"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
      <wsdl:fault name="UnknownVariety"><soap:fault name="UnknownVariety" use="literal"/></wsdl:fault>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="PlantCareService">
    <wsdl:port name="PlantCarePort" binding="pc:PlantCareSoap">
      <soap:address location="https://plant-care.example.com/soap"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>
`;

const SAMPLES = {
  schema: { title: 'garden centre order schema, version 1', text: ORDER_V1, languageId: 'xml', fileName: 'garden-centre-order-v1.xsd' },
  schemaV2: { title: 'garden centre order schema, version 2', text: ORDER_V2, languageId: 'xml', fileName: 'garden-centre-order-v2.xsd' },
  wsdl: { title: 'plant care service WSDL', text: WSDL, languageId: 'xml', fileName: 'plant-care-service.wsdl' }
};

function sampleFor(kind) { return SAMPLES[kind] || null; }

module.exports = { sampleFor: sampleFor, SAMPLES: SAMPLES };
