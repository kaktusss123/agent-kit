# Injection and Code Execution

Use for SQL/NoSQL/LDAP/XPath queries, OS commands, templates, expression languages, interpreters, dynamic imports, code generation, and unsafe evaluators.

## Core Proof

Do not report because a dangerous API exists. Prove:

`attacker-controlled data -> syntactic/code context -> missing structural separation -> interpreter/executor -> impact`

The key question is whether attacker data becomes instructions rather than data.

## SQL and Database Injection

High-risk construction:

- string concatenation/interpolation into query text;
- attacker-controlled identifiers, operators, sort clauses, table/column names, or query fragments;
- raw query APIs fed dynamic strings;
- second-order injection where stored attacker data is later embedded in a query.

Usually safe when actual parameter binding is used for values. Verify the library API: formatting a string before passing it to `execute` is not parameterization.

Parameters often cannot represent identifiers or syntax. Use explicit allowlists/mappings for dynamic identifiers, directions, operators, and clauses.

For document/NoSQL queries, inspect attacker-controlled objects and operators such as comparison, regex, script, or `$`-style operators. Schema validation must reject unexpected structure, not only types of expected fields.

## OS Command Injection

Distinguish:

- direct shell evaluation of a constructed string;
- argument-vector execution without a shell;
- command selection controlled by attacker;
- option injection where a value beginning with `-` changes tool behavior;
- environment, working directory, PATH, or executable resolution manipulation.

Argument arrays reduce shell metacharacter injection but do not make an unsafe command or option design safe. Prefer fixed executables, fixed option structure, allowlisted values, and `--` where supported.

## Template and Expression Injection

Verify whether attacker input controls template source/expression text rather than template data. Server-side template injection can lead to data access or code execution depending on engine and sandbox.

Do not confuse template injection with output XSS. They occur at different interpreters and require different controls.

Inspect:

- runtime template compilation from user-controlled strings;
- expression evaluators, rule engines, query DSLs, and dynamic filters;
- sandbox escapes through objects, reflection, globals, helpers, or filters;
- unsafe custom functions exposed to templates.

## Dynamic Code and Deserialization Bridges

High-risk sinks include `eval`-like execution, dynamic module loading from attacker-controlled names/paths, scripting engines, unsafe object reconstruction hooks, and generated code compiled/executed at runtime.

Prove reachability and attacker control. A fixed expression or developer-only migration script may not be exploitable in production scope.

## LDAP, XPath, Header, and Protocol Injection

Check whether attacker values are embedded in a grammar with context-appropriate escaping or structured APIs. Generic HTML escaping does not prevent SQL/LDAP/shell injection.

For HTTP response splitting or header injection, verify whether the framework rejects control characters and whether the value reaches a raw header context.

## Canonicalization and Multi-Stage Parsing

Look for validation of one representation followed by interpretation of another:

- decoding after validation;
- Unicode normalization differences;
- escaping before later concatenation;
- parser differentials between proxy/application/database;
- double decoding;
- data stored safely but later reinterpreted as syntax.

Validate after canonicalization and preserve structural separation at the final interpreter.

## False-Positive Checks

- Is the input constant, server-controlled, or constrained to a closed enum?
- Is the API truly parameterized/structured in this library?
- Is the dynamic string only diagnostic and never executed?
- Does a safe parser/sandbox actually apply to this path?
- Is the code production-reachable with attacker input?
- Does the attacker gain capability beyond what they already possess?

## Remediation Direction

Prefer structured APIs, true parameter binding, fixed command argument vectors, explicit mappings for syntax choices, no runtime evaluation of untrusted text, least-privileged execution, and negative tests with alternate encodings and grammar-breaking input.
