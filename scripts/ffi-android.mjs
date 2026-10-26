#!/usr/bin/env node
// Package the core for Android: release Rust and JNI shared libraries for
// arm64-v8a, armeabi-v7a and x86_64, and the handwritten Kotlin facade
// compiled against android.jar, zipped into core/target/android/relayswarm-core.aar.
//
//   node scripts/ffi-android.mjs [--check] [--device]
//
// --check builds a throwaway app (core/target/android/smoke) with the Android
// Gradle plugin that depends on the AAR, as an app would, and compiles the
// Kotlin smoke program (core/relayswarm-ffi/smoke/Main.kt) into it.
// --device also runs that app's code on the device or emulator adb reaches
// (set ANDROID_SERIAL to choose one), through app_process, and checks it with
// scripts/ffi-smoke.mjs. It does not start an emulator.
//
// Needs the Android SDK (ANDROID_HOME, or ~/Library/Android/sdk), an NDK
// (ANDROID_NDK_HOME, or the newest under the SDK), cargo-ndk, kotlinc and the
// three Rust targets listed below; --check also needs gradle.
//
// The AAR names no dependencies and needs Kotlin 2.2 or later. Its consumer
// R8 rules keep the facade and its native entry-point class.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const options = new Set(process.argv.slice(2));
for (const option of options) {
  if (option !== "--check" && option !== "--device") throw new Error("usage: ffi-android.mjs [--check] [--device]");
}
if (options.has("--device")) options.add("--check");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "core");
const out = join(core, "target/android");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: core, maxBuffer: 256 * 1024 * 1024, ...options });

// Android 8.0; the bindings' callers commonly use java.util.Base64, as the
// smoke does, which arrived in API 26.
const MIN_SDK = 26;
const COMPILE_SDK = 36;
const NAMESPACE = "uniffi.relayswarm_ffi";
// Arm phones, older 32-bit Arm phones and x86_64 emulators. 64-bit
// libraries must use 16 KB pages for Android 15 devices that need them.
const ABIS = [
  { abi: "arm64-v8a", target: "aarch64-linux-android", clangTarget: "aarch64-linux-android", machine: "AArch64", pages: 0x4000 },
  { abi: "armeabi-v7a", target: "armv7-linux-androideabi", clangTarget: "armv7a-linux-androideabi", machine: "ARM", pages: 0x1000 },
  { abi: "x86_64", target: "x86_64-linux-android", clangTarget: "x86_64-linux-android", machine: "Advanced Micro Devices X86-64", pages: 0x4000 },
];
// The Android Gradle plugin for the throwaway consumer; Kotlin is built in.
const AGP = "9.2.1";

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
if (!existsSync(sdk)) throw new Error(`No Android SDK at ${sdk}; set ANDROID_HOME`);
const newest = (dir) => readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const ndk = process.env.ANDROID_NDK_HOME ?? (existsSync(join(sdk, "ndk")) ? join(sdk, "ndk", newest(join(sdk, "ndk"))) : null);
if (!ndk || !existsSync(ndk)) throw new Error("No Android NDK; set ANDROID_NDK_HOME or install one under the SDK");
const androidJar = join(sdk, "platforms", `android-${COMPILE_SDK}`, "android.jar");
if (!existsSync(androidJar)) throw new Error(`Missing ${androidJar}; install platforms;android-${COMPILE_SDK}`);
const prebuilt = join(ndk, "toolchains/llvm/prebuilt");
const readelf = join(prebuilt, readdirSync(prebuilt)[0], "bin/llvm-readelf");

const installed = run("rustup", ["target", "list", "--installed"]).toString("utf8").split("\n");
const missing = ABIS.map(({ target }) => target).filter((target) => !installed.includes(target));
if (missing.length > 0) throw new Error(`Missing Rust targets; run: rustup target add ${missing.join(" ")}`);

// Each library must be for its ABI's machine, load at the page size it
// needs, and link only the system's own libraries.
function checkLibrary(library, { abi, machine, pages }) {
  const header = run(readelf, ["-hW", library]).toString("utf8");
  if (!header.includes(`Machine:`) || !header.match(new RegExp(`Machine:\\s+${machine}\\s*$`, "m"))) throw new Error(`${library} is not built for ${abi}`);
  const loads = run(readelf, ["-lW", library]).toString("utf8").split("\n").filter((line) => line.trim().startsWith("LOAD"));
  if (loads.length === 0) throw new Error(`${library} has no LOAD segments`);
  for (const load of loads) {
    const align = Number(load.trim().split(/\s+/).at(-1));
    if (align < pages) throw new Error(`${library} has a LOAD segment aligned to ${align}, below ${pages}`);
  }
  const needed = [...run(readelf, ["-dW", library]).toString("utf8").matchAll(/\(NEEDED\)\s+Shared library: \[(.+)\]/g)].map((match) => match[1]);
  const extra = needed.filter((name) => !["libc.so", "libdl.so", "libm.so", "liblog.so", "librelayswarm_ffi.so"].includes(name));
  if (extra.length > 0) throw new Error(`${library} needs ${extra.join(", ")}, which an app would have to ship`);
}

// --- libraries -----------------------------------------------------------------

rmSync(out, { recursive: true, force: true });
const aar = join(out, "aar");
mkdirSync(aar, { recursive: true });
const ndkEnv = { ...process.env, ANDROID_HOME: sdk, ANDROID_NDK_HOME: ndk };
run("cargo", ["ndk", ...ABIS.flatMap(({ abi }) => ["-t", abi]), "-P", String(MIN_SDK), "-o", join(aar, "jni"),
  "build", "--locked", "--release", "-p", "relayswarm-ffi", "--lib"], { stdio: "inherit", env: ndkEnv });
const hostTag = readdirSync(prebuilt)[0];
for (const entry of ABIS) {
  const directory = join(aar, "jni", entry.abi);
  const clang = join(prebuilt, hostTag, "bin", `${entry.clangTarget}${MIN_SDK}-clang`);
  run(clang, ["-shared", "-fPIC", "-Wall", "-Wextra", "-Werror", `-I${join(core, "relayswarm-ffi/include")}`,
    join(core, "relayswarm-ffi/jni/relayswarm_jni.c"), `-L${directory}`, "-lrelayswarm_ffi", "-Wl,--no-undefined",
    "-Wl,-z,max-page-size=16384", "-o", join(directory, "librelayswarm_jni.so")], { stdio: "inherit" });
  for (const name of ["librelayswarm_ffi.so", "librelayswarm_jni.so"]) checkLibrary(join(directory, name), entry);
}

// Compiled against android.jar alone, with no JDK, so the facade uses only
// what Android provides; Kotlin 2.2 metadata, so older apps can read it.
run("kotlinc", ["-nowarn", "-no-jdk", "-jvm-target", "11", "-language-version", "2.2", "-api-version", "2.2",
  "-cp", androidJar, "-d", join(aar, "classes.jar"), join(core, "relayswarm-ffi/kotlin/uniffi/relayswarm_ffi/relayswarm_ffi.kt")], { stdio: "inherit" });

// --- package -------------------------------------------------------------------

writeFileSync(join(aar, "AndroidManifest.xml"), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${NAMESPACE}">
    <uses-sdk android:minSdkVersion="${MIN_SDK}" />
</manifest>
`);
writeFileSync(join(aar, "R.txt"), "");
// JNI resolves the native entry-point class and methods by name.
writeFileSync(join(aar, "proguard.txt"), `-keep class ${NAMESPACE}.** { *; }
`);
const library = join(out, "relayswarm-core.aar");
run("zip", ["-q", "-X", "-r", library, "AndroidManifest.xml", "R.txt", "proguard.txt", "classes.jar", "jni"], { cwd: aar });
console.log(`Android library: ${library} (${ABIS.map(({ abi }) => abi).join(", ")}; API ${MIN_SDK} and later)`);

if (!options.has("--check")) process.exit(0);

// --- check ---------------------------------------------------------------------

// A throwaway app that depends on the AAR as an app would, with the smoke
// program as its only source.
const smoke = join(out, "smoke");
mkdirSync(join(smoke, "app/src/main/kotlin"), { recursive: true });
writeFileSync(join(smoke, "settings.gradle.kts"), `pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "smoke"
include(":app")
`);
writeFileSync(join(smoke, "build.gradle.kts"), `plugins { id("com.android.application") version "${AGP}" apply false }\n`);
writeFileSync(join(smoke, "gradle.properties"), "android.useAndroidX=false\norg.gradle.jvmargs=-Xmx2g\n");
writeFileSync(join(smoke, "local.properties"), `sdk.dir=${sdk}\n`);
writeFileSync(join(smoke, "app/build.gradle.kts"), `plugins { id("com.android.application") }

android {
    namespace = "relayswarm.smoke"
    compileSdk = ${COMPILE_SDK}
    defaultConfig {
        applicationId = "relayswarm.smoke"
        minSdk = ${MIN_SDK}
        targetSdk = ${COMPILE_SDK}
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Stored, so the device check can push the libraries straight from it.
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation(files("${library}"))
}
`);
writeFileSync(join(smoke, "app/src/main/AndroidManifest.xml"), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" />
`);
cpSync(join(core, "relayswarm-ffi/smoke/Main.kt"), join(smoke, "app/src/main/kotlin/Main.kt"));
run("gradle", ["--quiet", "--no-daemon", "assembleDebug"], { cwd: smoke, stdio: "inherit" });
const apk = join(smoke, "app/build/outputs/apk/debug/app-debug.apk");
if (!existsSync(apk)) throw new Error("gradle left no smoke APK");
const listing = run("unzip", ["-Z1", apk]).toString("utf8").split("\n");
for (const { abi } of ABIS) {
  for (const name of ["librelayswarm_ffi.so", "librelayswarm_jni.so"]) {
    if (!listing.includes(`lib/${abi}/${name}`)) throw new Error(`The smoke APK has no lib/${abi}/${name}`);
  }
}
console.log(`smoke app built against the AAR: ${apk}`);

if (!options.has("--device")) process.exit(0);

// The APK's dex holds the smoke, facade and Kotlin library; app_process runs
// its main() with the device's Rust and JNI libraries beside it.
const adb = join(sdk, "platform-tools/adb");
const shell = (...args) => run(adb, ["shell", ...args]).toString("utf8").trim();
const abi = shell("getprop", "ro.product.cpu.abi");
const api = shell("getprop", "ro.build.version.sdk");
if (!ABIS.some((entry) => entry.abi === abi)) throw new Error(`The device's ABI ${abi} is not in the AAR`);
const remote = "/data/local/tmp/relayswarm-core-smoke";
const libs = join(out, "device");
run("unzip", ["-q", "-o", "-j", apk, `lib/${abi}/*`, "-d", libs]);
shell("rm", "-rf", remote);
shell("mkdir", "-p", remote);
try {
  run(adb, ["push", apk, `${remote}/smoke.apk`], { stdio: "ignore" });
  for (const name of readdirSync(libs)) run(adb, ["push", join(libs, name), `${remote}/${name}`], { stdio: "ignore" });
  execFileSync(process.execPath, [join(root, "scripts/ffi-smoke.mjs"), "kotlin", `Android library on API ${api} (${abi})`, "--",
    adb, "shell", `CLASSPATH=${remote}/smoke.apk`, "app_process", `-Djava.library.path=${remote}`, "/", "MainKt"], { cwd: root, stdio: "inherit" });
} finally {
  shell("rm", "-rf", remote);
}
