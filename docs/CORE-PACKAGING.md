# Native core release packaging

This workflow prepares native core assets. It creates no tag or GitHub release,
publishes nothing to npm, and leaves `core/apple/Package.swift` using `path:`.
A binary URL dependency remains a separate release decision.

## Triggers and permissions

The existing [test workflow](../.github/workflows/test.yml) calls
[native packaging](../.github/workflows/core-packages.yml) on a tag push, or
when explicitly dispatched with `core_packages: true`. Ordinary branch pushes
and pull requests do not run the release-packaging jobs. Their existing
validation jobs retain their normal behaviour.

The packaging-only dispatch skips the ordinary test matrix, builds Apple and
Android artefacts, uploads them to Actions and verifies their checksums and
source commit. Build/download jobs have read-only repository permission.
The attachment job requires **both** a tag-push event and the caller's publish
flag; a dispatch cannot attach assets, including when dispatched at a tag.

On a tag push, attachment requires an already existing GitHub release for that
tag. It fails if the release does not exist, and never creates one. Uploads
omit `--clobber`, so existing release assets are not replaced. Both platforms
must build and pass the combined verification before attachment. The caller
grants write permission only to the reusable workflow; only its attachment
job uses that permission.

## Dry run

From the candidate checkout:

```sh
gh workflow run test.yml --ref <candidate-branch> -f core_packages=true
gh run view <run-id>
gh run download <run-id> --pattern 'relayswarm-core-*' --dir artifacts/core-release-download
node scripts/package-core-release.mjs verify artifacts/core-release-download
```

The entry point already exists on the default branch, so the dispatch can test
a new reusable-workflow file on an unmerged candidate branch. Use a fresh
empty download directory and check out the exact dispatched commit before
verification. The verifier rejects mismatched source commits, missing or
unexpected assets and invalid checksums. Actions artefacts are retained for
30 days; a successful dispatch is not a release or publication.

## Assets

| File | Content |
|---|---|
| `relayswarm-core.xcframework.zip` | The binary XCFramework at the archive root, arm64 for iPhone, iOS simulator and macOS |
| `relayswarm-core.xcframework.zip.checksum` | Actual `swift package compute-checksum` result for that archive |
| `relayswarm-core-swift-bindings.zip` | Generated Swift wrapper and unchanged local-path `Package.swift` |
| `relayswarm-core.aar` | Kotlin bindings and native libraries for arm64-v8a, armeabi-v7a and x86_64 |
| `SHA256SUMS-apple`, `SHA256SUMS-android` | Digests of each platform's assets and metadata |
| `BUILD-METADATA-apple.json`, `BUILD-METADATA-android.json` | Source commit, package version, Node and Rust versions |

Extract both Apple archives into one directory to obtain the existing local
Swift package. Its minimums are macOS 14 and iOS 16. The build compiles the
Swift wrapper against the actual XCFramework before archiving it.
The SwiftPM checksum describes the binary archive, not the bindings archive.

The Android minimum is API 26. Consumers also add
`net.java.dev.jna:jna:5.14.0@aar` and Kotlin 2.2 or later; the AAR does not
embed those dependencies. The existing builder checks each ABI's machine,
16 KiB load alignment for 64-bit libraries and system-library dependencies.
Packaging checks the manifest, classes, consumer rules and all three libraries.

## Local build and scope

```sh
npm ci
node scripts/package-core-release.mjs apple
node scripts/package-core-release.mjs android
node scripts/package-core-release.mjs verify
```

Apple needs macOS/Xcode and the three Rust Apple targets. Android needs the
SDK/NDK, SDK platform 36, cargo-ndk 4.1.2, Kotlin and the three Rust Android
targets, as the existing builders require. Each build uses the worktree's own
`core/target`; it sets no separate target directory or incremental policy.
Source paths are remapped for native builds and checked before archiving.
Source commits and hashes bind each platform's outputs to the same checkout.

These checks cover build/packaging and local or CI consumption. They do not
prove physical-device, mobile battery, public-NAT or field acceptance, and add
no native WebRTC adapter, client application or transport dependency.
