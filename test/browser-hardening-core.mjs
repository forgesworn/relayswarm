// The loader hardening suite with every peer-first fixture on the committed
// Rust core: links, selection and verification. Works on every platform,
// unlike an environment assignment in an npm script.
process.env.RELAYSWARM_TEST_CORE = "1";
await import("./browser-hardening.test.mjs");
