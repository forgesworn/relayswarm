#!/usr/bin/env node
// Package the core for Apple platforms: release static libraries for iPhone,
// the iOS simulator and macOS, gathered into core/apple/relayswarm_ffiFFI.xcframework,
// with the generated Swift bindings as the RelaySwarmCore target of the
// Swift package in core/apple. Both outputs are git-ignored; run this before
// `swift build` or adding the package to an Xcode project.
//
//   node scripts/ffi-apple.mjs [--check] [--simulator]
//
// --check builds the smoke program (core/relayswarm-ffi/smoke/main.swift)
// against the package with xcodebuild for iPhone, the simulator and macOS,
// then runs the macOS build through scripts/ffi-smoke.mjs, as arm64 and, when
// Rosetta is installed, as x86_64. The iPhone build is only linked.
// --simulator also runs the simulator build in an available iPhone
// simulator, booting one and shutting it down again if none is booted.
// Needs a Mac with Xcode and the five Rust targets listed below.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const options = new Set(process.argv.slice(2));
for (const option of options) {
  if (option !== "--check" && option !== "--simulator") throw new Error("usage: ffi-apple.mjs [--check] [--simulator]");
}
if (process.platform !== "darwin") throw new Error("The Apple package needs macOS and Xcode.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "core");
const apple = join(core, "apple");
const out = join(core, "target/apple");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: core, maxBuffer: 64 * 1024 * 1024, ...options });

// The package's minimums, matching RelaySwarmKit's Package.swift.
const IOS = "16.0";
const MACOS = "14.0";
const SLICES = [
  { name: "ios", targets: ["aarch64-apple-ios"], env: { IPHONEOS_DEPLOYMENT_TARGET: IOS }, minimum: IOS },
  { name: "ios-simulator", targets: ["aarch64-apple-ios-sim", "x86_64-apple-ios"], env: { IPHONEOS_DEPLOYMENT_TARGET: IOS }, minimum: IOS },
  { name: "macos", targets: ["aarch64-apple-darwin", "x86_64-apple-darwin"], env: { MACOSX_DEPLOYMENT_TARGET: MACOS }, minimum: MACOS },
];

const installed = run("rustup", ["target", "list", "--installed"]).toString("utf8").split("\n");
const missing = SLICES.flatMap(({ targets }) => targets).filter((target) => !installed.includes(target));
if (missing.length > 0) throw new Error(`Missing Rust targets; run: rustup target add ${missing.join(" ")}`);

// Every object's minimum OS, from LC_BUILD_VERSION or the older
// LC_VERSION_MIN_* commands, must be at or below the package's.
const newer = (version, minimum) => {
  const [a, b] = [version, minimum].map((text) => text.split(".").map(Number));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
};
function checkMinimum(library, minimum) {
  const versions = new Set();
  let command = null;
  for (const line of run("otool", ["-l", library]).toString("utf8").split("\n")) {
    const field = line.trim().split(/\s+/);
    if (field[0] === "cmd") command = field[1];
    else if (command === "LC_BUILD_VERSION" && field[0] === "minos") versions.add(field[1]);
    else if (command?.startsWith("LC_VERSION_MIN_") && field[0] === "version") versions.add(field[1]);
  }
  if (versions.size === 0) throw new Error(`${library} names no minimum OS`);
  const above = [...versions].filter((version) => newer(version, minimum));
  if (above.length > 0) throw new Error(`${library} has objects for ${above.join(", ")}, above the package's ${minimum}`);
}

// --- libraries -----------------------------------------------------------------

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const libraries = SLICES.map((slice) => {
  for (const target of slice.targets) {
    run("cargo", ["build", "--locked", "--release", "-p", "relayswarm-ffi", "--lib", "--target", target],
      { stdio: "inherit", env: { ...process.env, ...slice.env } });
  }
  const built = slice.targets.map((target) => join(core, "target", target, "release/librelayswarm_ffi.a"));
  const library = join(out, slice.name, "librelayswarm_ffi.a");
  mkdirSync(dirname(library), { recursive: true });
  run("lipo", ["-create", ...built, "-output", library]);
  checkMinimum(library, slice.minimum);
  return library;
});

// The bindings come from the host's debug library, built in this same run:
// release strips the metadata the generator reads on some platforms, and the
// generated Swift checks at load time that it matches the library's API.
run("cargo", ["build", "--locked", "-p", "relayswarm-ffi", "--lib"], { stdio: "inherit" });
const bindings = join(out, "bindings");
run("cargo", ["run", "--locked", "--quiet", "--features", "bindgen", "--bin", "uniffi-bindgen", "--",
  "generate", "--library", join(core, "target/debug/librelayswarm_ffi.dylib"), "--language", "swift",
  "--no-format", "--out-dir", bindings], { stdio: "inherit" });
const headers = join(out, "headers");
mkdirSync(headers);
cpSync(join(bindings, "relayswarm_ffiFFI.h"), join(headers, "relayswarm_ffiFFI.h"));
// The XCFramework's module map must be named module.modulemap.
cpSync(join(bindings, "relayswarm_ffiFFI.modulemap"), join(headers, "module.modulemap"));

// --- package -------------------------------------------------------------------

const xcframework = join(apple, "relayswarm_ffiFFI.xcframework");
rmSync(xcframework, { recursive: true, force: true });
run("xcodebuild", ["-create-xcframework", ...libraries.flatMap((library) => ["-library", library, "-headers", headers]),
  "-output", xcframework], { stdio: "inherit" });
cpSync(join(bindings, "relayswarm_ffi.swift"), join(apple, "Sources/RelaySwarmCore/relayswarm_ffi.swift"));
console.log(`Apple package: ${apple} (iPhone arm64, simulator arm64 and x86_64, macOS arm64 and x86_64; iOS ${IOS}, macOS ${MACOS})`);

if (!options.has("--check")) process.exit(0);

// --- check ---------------------------------------------------------------------

// A throwaway package that depends on core/apple by path, so the smoke uses
// the library exactly as an app would.
const smoke = join(out, "smoke");
mkdirSync(join(smoke, "Sources/Smoke"), { recursive: true });
writeFileSync(join(smoke, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Smoke",
    platforms: [.macOS(.v14), .iOS(.v16)],
    dependencies: [.package(path: "../../../apple")],
    targets: [.executableTarget(name: "Smoke", dependencies: [.product(name: "RelaySwarmCore", package: "apple")])]
)
`);
writeFileSync(join(smoke, "Sources/Smoke/main.swift"),
  `import RelaySwarmCore\n${readFileSync(join(core, "relayswarm-ffi/smoke/main.swift"), "utf8")}`);

const derived = join(out, "derived");
const products = {};
for (const [platform, destination, folder] of [
  ["iPhone", "generic/platform=iOS", "Release-iphoneos"],
  ["iOS simulator", "generic/platform=iOS Simulator", "Release-iphonesimulator"],
  ["macOS", "generic/platform=macOS", "Release"],
]) {
  run("xcodebuild", ["build", "-quiet", "-scheme", "Smoke", "-configuration", "Release", "-destination", destination,
    "-derivedDataPath", derived, "CODE_SIGNING_ALLOWED=NO"], { cwd: smoke, stdio: "inherit" });
  products[platform] = join(derived, "Build/Products", folder, "Smoke");
  if (!existsSync(products[platform])) throw new Error(`xcodebuild left no smoke for ${platform}`);
  console.log(`smoke built for ${platform}: ${run("lipo", ["-archs", products[platform]]).toString("utf8").trim()}`);
}

const check = (label, command) => execFileSync(process.execPath, [join(root, "scripts/ffi-smoke.mjs"), "swift", label, "--", ...command],
  { cwd: root, stdio: "inherit" });
check("Apple package on macOS arm64", ["arch", "-arm64", products.macOS]);
let rosetta = true;
try {
  execFileSync("arch", ["-x86_64", "/usr/bin/true"], { stdio: "ignore" });
} catch {
  rosetta = false;
}
if (rosetta) check("Apple package on macOS x86_64 (Rosetta)", ["arch", "-x86_64", products.macOS]);
else console.log("macOS x86_64 slice built but not run: Rosetta is not installed");

if (options.has("--simulator")) {
  const { devices } = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"]).toString("utf8"));
  const phones = Object.entries(devices)
    .filter(([runtime]) => runtime.includes(".SimRuntime.iOS-"))
    .flatMap(([runtime, list]) => list.map((device) => ({ ...device, runtime: runtime.split(".SimRuntime.")[1] })))
    .filter((device) => device.deviceTypeIdentifier?.includes(".iPhone-"));
  const device = phones.find((phone) => phone.state === "Booted") ?? phones[0];
  if (!device) throw new Error("No iPhone simulator is available");
  const booted = device.state === "Booted";
  // Named by runtime and UDID only; simulator names are the machine owner's.
  if (!booted) run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  try {
    check(`Apple package in an iPhone simulator (${device.runtime})`, ["xcrun", "simctl", "spawn", device.udid, products["iOS simulator"]]);
  } finally {
    if (!booted) run("xcrun", ["simctl", "shutdown", device.udid]);
  }
}
