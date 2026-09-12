# Memory Safety and Native Code

Use for C, C++, unsafe Rust, FFI, parsers/codecs, binary protocols, manual allocation, pointer arithmetic, and integer-to-size calculations.

## Required Proof Shape

`attacker-controlled bytes/state -> reachable memory operation -> violated bound/lifetime/type invariant -> concrete corruption/read/control impact`

Do not report merely because code uses pointers, `unsafe`, casts, or manual memory management.

## Bounds and Size Calculations

Trace sizes from source to allocation, indexing, copy, parse, and serialization.

Check:

- signed/unsigned conversion;
- truncation between integer widths;
- multiplication/addition overflow before allocation;
- units mismatch (elements vs bytes, characters vs encoded bytes);
- terminator and header/payload length handling;
- validation before or after conversion;
- loop bounds and off-by-one conditions;
- attacker-controlled stride/offset/count.

Prove runtime arithmetic semantics and input range. Avoid generic "integer overflow" claims.

## Lifetime and Ownership

Look for:

- use-after-free/double-free through error, callback, async, reference-count, or ownership transfer paths;
- pointers/references surviving container reallocation or object movement;
- borrowed data crossing thread/FFI/lifetime boundaries;
- cleanup paths that free aliased resources;
- stale handles after close/reuse.

Trace all relevant owners and synchronization.

## Type and Layout Confusion

Inspect:

- unchecked casts and tag/type mismatches;
- length/type fields not validated together;
- ABI, alignment, packing, and endian assumptions across FFI/network/storage;
- union/variant access inconsistent with active tag;
- deserialized object size/layout assumptions.

## Rust `unsafe` and FFI

For each unsafe block on the path, identify the safety contract and prove callers uphold it:

- valid pointer/alignment/lifetime;
- initialized memory;
- aliasing/exclusivity;
- thread safety;
- length/capacity relationship;
- ownership of foreign allocations;
- panic/unwind behavior across FFI.

Safe callers can still trigger unsound unsafe internals; the key is whether safe or attacker-reachable inputs violate the hidden contract.

## Concurrency

For data races, atomic ordering, and lock-free code, establish a feasible interleaving and security impact. A generic race warning is insufficient.

Check lock scope, object lifetime, reference publication, and whether external callbacks occur while invariants are temporarily broken.

## Mitigations and Impact

Compiler/runtime mitigations may reduce exploitability but do not automatically remove out-of-bounds read/write or use-after-free. State mitigation uncertainty honestly rather than guessing RCE.

Classify impact based on proven primitive:

- controlled out-of-bounds write or function/control data corruption;
- sensitive out-of-bounds read;
- deterministic crash only;
- corruption constrained by bounds/sandbox.

## Remediation Direction

Use checked arithmetic, explicit size types and units, bounds-checked containers/APIs, ownership-safe abstractions, small documented unsafe blocks, validated FFI contracts, deterministic cleanup, and tests/fuzz cases for exact boundary values when available in project tooling.
