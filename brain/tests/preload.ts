// Test runs default to OFFLOAD_KEYS=file: raw brain key files, no Keychain, no observer binary (docs/store-contract.md).
// Tests of the keychain path (tests/s05c-keys) unset it and point OFFLOAD_OBSERVER_BIN at tests/s05c-keys/fake-observer.sh.
process.env.OFFLOAD_KEYS ??= "file";
