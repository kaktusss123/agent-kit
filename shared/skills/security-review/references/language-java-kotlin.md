# Java and Kotlin Security Notes

Load with vulnerability-specific references for JVM services, Spring-like frameworks, persistence layers, templating, and object serialization.

## Web and Spring Security

Trace effective filter/interceptor/method-security coverage and ordering. Verify object/tenant authorization beyond coarse route authentication.

Look for:

- alternate endpoints/methods bypassing annotations or filters;
- method-level policy using the wrong argument or principal;
- proxy/self-invocation behavior that prevents intended interceptors;
- mass assignment through request binding, DTO-to-entity mapping, or generic patching;
- server trust in forwarded headers outside a verified proxy boundary.

Annotations are evidence only when the runtime proxy/config applies to the call path.

## SQL and Query Languages

Prepared statements and ORM parameters generally separate values from query syntax. Inspect string-built native queries, dynamic JPQL/HQL, criteria fragments, sort/property names, and expression languages.

## Expression and Template Injection

Review attacker control of SpEL/EL/OGNL/template source, not ordinary template data. Check custom resolvers, reflection, class access, and sandbox assumptions.

## Deserialization

High-risk paths include native Java serialization, XML/object mappers with attacker-controlled polymorphic types, unsafe YAML/object tags, and message formats invoking constructors/setters/hooks.

Prove attacker bytes reach object construction and a dangerous gadget/effect is available or the application exposes an unsafe type capability. Do not call plain JSON-to-fixed-DTO mapping RCE.

## XML

Verify parser/factory settings for DTD, external entities, XInclude, schema access, and transformer/resource resolution. Defaults and secure-processing behavior vary; inspect actual configuration.

## Paths, Archives, and Uploads

Normalize/resolve paths and verify containment with filesystem-aware APIs. Inspect zip-slip, symlinks, temp files, overwrite, executable/static serving, and later processing.

## Crypto, TLS, and Tokens

Use maintained JCA/JCE/library primitives and explicit secure modes. Check algorithm/key confusion, nonce/IV requirements, certificate/hostname verification, token issuer/audience/purpose, and signature binding. A weak digest used as a non-security checksum is not automatically a finding.

## Concurrency and Transactions

Review transaction proxy boundaries, isolation, optimistic versioning, locks, asynchronous execution, retries, and external side effects. A `synchronized` block is local to one process and may not protect distributed state.

## Common False Positives

- prepared/parameterized ORM queries;
- framework annotations assumed ineffective without checking runtime configuration;
- fixed DTO JSON parsing treated as unsafe deserialization;
- authenticated access mistaken for authorized object access;
- development profiles reported without proof they are effective defaults.
