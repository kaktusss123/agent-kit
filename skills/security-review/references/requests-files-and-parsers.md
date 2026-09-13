# External Requests, Files, Uploads, and Parsers

Use for SSRF, URL fetching, callbacks, filesystem access, uploads, archives, XML, image/document processors, and deserialization.

## Server-Side Request Forgery

Prove:

`attacker controls destination or redirect-relevant component -> server performs request from a privileged network/identity -> reachable sensitive target or capability`

Inspect control over scheme, host, port, path, query, DNS resolution, redirects, proxy settings, and alternate IP representations.

Server-configured base URLs are usually not attacker-controlled. A user-controlled path can still matter when it can alter authority through parsing quirks, absolute URLs, redirects, or scheme-relative forms.

Mitigations must apply after parsing and resolution. Consider:

- exact scheme allowlist;
- destination allowlist by canonical host/service identity;
- DNS/IP checks including IPv4/IPv6 and re-resolution behavior;
- redirect policy;
- egress/network restrictions;
- credential/header forwarding;
- cloud metadata and internal control-plane reachability.

## Path Traversal and Filesystem Confusion

Trace attacker-controlled path components through decoding, normalization, joining, symlink resolution, archive extraction, and final open/write/delete.

A string prefix check can be unsafe when path boundaries, case rules, symlinks, or normalization differ. Prefer resolving against an intended directory and verifying containment with path-aware semantics, plus safe file open behavior.

Check:

- absolute paths and drive/UNC forms;
- encoded or mixed separators;
- symlink/hard-link races;
- temporary-file permissions and predictable names;
- overwrite of existing or executable/configuration files;
- deletion and cleanup paths;
- user-controlled filenames used in headers or shell commands.

## Uploads

Verify both storage and later consumption:

- size and count limits where availability is security-relevant;
- content/type validation based on actual parsing needs, not only extension/header;
- generated storage names and non-executable storage location;
- authorization and tenant scoping for upload/download/delete;
- active content served with safe content type/disposition;
- image/document/archive processing by privileged libraries/services;
- malware scanning only if it is an explicit required control.

Do not claim an upload is safe solely because it is renamed.

## Archive Extraction

Look for zip/tar path traversal, absolute paths, symlinks/hard links, duplicate entries, overwrite behavior, and extraction followed by execution/import. Validate every entry against the destination after normalization.

## XML and Entity Expansion

Confirm parser configuration for external entities, DTD processing, XInclude, network/file access, and entity expansion. Library defaults vary by language/version.

Prove a sensitive file/network read or meaningful parser impact before reporting. Do not infer unsafe mode from use of XML alone.

## Deserialization

Distinguish plain data decoding from object deserialization with type construction or hooks.

High-risk paths include:

- native object formats accepting attacker bytes;
- attacker-controlled class/type metadata;
- gadget-capable libraries;
- unsafe YAML/object tags;
- untrusted signed data where the signing key or verification is compromised;
- deserialization before authentication/authorization.

JSON parsing is not generally code-executing deserialization, but parsed structure can still trigger mass assignment, prototype pollution, or logic flaws.

## Parser Differentials

Review systems where two components parse the same bytes differently: proxy/application, signature verifier/parser, extension/content detector, URL parser/DNS resolver, or validation/runtime decoder.

Security checks and use should share one canonical representation.

## Remediation Direction

Use fixed destinations or strict allowlists, network egress controls, path-aware containment, generated names, non-executable storage, safe parser modes, data-only formats, explicit schemas/type allowlists, and negative tests for alternate encodings, redirects, links, and archive entries.
