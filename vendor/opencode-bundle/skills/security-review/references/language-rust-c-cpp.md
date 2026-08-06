# Rust, C, and C++ Security Notes

Load with memory-safety-and-native-code.md for native code and FFI paths.

## C and C++

Trace untrusted sizes, indices, offsets, format strings, and lifetimes into:

- allocation and copy/move operations;
- string formatting and termination;
- pointer arithmetic and array access;
- parsers and binary structure casts;
- ownership transfer, callbacks, and cleanup;
- integer conversion and size computation;
- command, file, and dynamic library loading.

Do not flag a function solely because it is historically unsafe. Inspect actual bounds, destination size, format control, and caller constraints.

High-risk examples require proof such as attacker-controlled format string, length exceeding destination, integer wrap producing undersized allocation, or stale pointer reachable after free.

## Rust

Safe Rust provides strong memory-safety guarantees, but security flaws remain in logic, authorization, parsing, resource use, and unsafe/FFI code.

For `unsafe`, identify its safety contract and whether safe callers can violate it through ordinary inputs. Inspect:

- raw pointer validity, alignment, and lifetime;
- `from_raw_parts` length/capacity;
- uninitialized memory and transmute/layout assumptions;
- aliasing and `Send`/`Sync` guarantees;
- ownership of foreign allocations;
- panic/unwind across FFI;
- unchecked UTF-8 or enum discriminants;
- integer casts and release/debug overflow differences.

Presence of `unsafe` is not a vulnerability.

## FFI Boundaries

Verify both sides agree on:

- ownership and who frees;
- buffer lengths and units;
- nullability and sentinel rules;
- ABI/layout/alignment/endian;
- thread safety and callback lifetime;
- error and exception/panic propagation;
- string encoding and termination.

Treat foreign code as a separate trust/lifetime domain.

## Parsing and State Machines

Native parsers often combine memory and logic risk. Trace declared lengths, nested counts, recursion, duplicate fields, canonicalization, and parser differentials. Prove a memory primitive or security invariant violation.

## Build and Dependency Boundaries

Review build scripts, code generators, proc macros, native build hooks, dynamic library search paths, and CI execution when newly introduced or run with secrets/authority. Do not invent dependency vulnerabilities.

## Severity Discipline

Do not jump from crash or out-of-bounds access to remote code execution. State the proven primitive and relevant mitigations/sandbox. Elevate only with evidence of control and impact.

## Common False Positives

- bounded wrapper proven to constrain a low-level API;
- `unsafe` with a maintained, upheld safety contract;
- integer conversion where caller/schema proves range;
- local-only developer tooling not attacker-reachable;
- theoretical race without feasible concurrency and security effect.
