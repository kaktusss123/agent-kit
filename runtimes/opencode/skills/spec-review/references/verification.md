# Verification

Check whether each material behavior has an observable acceptance condition and a feasible way to verify it.

Prefer checks that observe the requested behavior directly. Flag proxy checks that can pass while the real behavior is wrong. Include relevant failure or negative cases when they are part of the contract.

Separate static contract checks from runtime behavior. A build, type check, or schema parse does not prove runtime semantics unless that is the behavior being specified.
