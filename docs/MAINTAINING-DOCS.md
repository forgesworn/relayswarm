# Maintaining RelaySwarm documentation

[Documentation](README.md) · [Status](STATUS.md) · [Changelog](../CHANGELOG.md)

## Public entry points

The current public documentation surface is the GitHub repository. There is no
configured standalone documentation site. README and `docs/README.md` provide
human navigation; package metadata and GitHub description/topics identify the
actual technologies and experimental status.

AI readers can use the
[raw index](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms.txt)
or [full context](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms-full.txt).
The index follows the [llms.txt proposal](https://llmstxt.org/): a title, summary,
scope notes and groups of annotated Markdown links. The optional full file is
generated from authored guides, with relative links resolved to public sources.
It excludes historical spike receipts/code; the index links that evidence separately.

These files make public information easier to retrieve. They do not prove that
search engines or assistants have crawled, indexed or recommended RelaySwarm,
and they do not grant crawler permission or change GitHub's robots policy.

## Edit and verify

1. Update authored Markdown, `llms.txt` and relevant package metadata from the
   implementation. Label dated evidence and planned work explicitly.
2. Run `npm run docs:generate` to rebuild `llms-full.txt`. Do not edit it by hand.
3. Run `npm run check:docs` and `npm run check`.
4. Commit authored and generated files together. CI runs the documentation check.
5. After merge, fetch the public raw files and compare them with the merged
   content. Check GitHub description/topics and release links separately.

`check:docs` requires only Node built-ins: it checks local/public-repository
Markdown link targets and local heading anchors, AI-index file-list structure,
documented module exports, command names and generated-context freshness. It
does not assert external website availability or rendering, and skips code
blocks when checking links. Verify external factual claims against primary sources
when updating them, rather than trusting an old comparison date.

## Release versus current documentation

Each immutable release tag (v0.1.0, v0.2.0) and its downloadable assets contain
release-time documentation.
Main-branch guides can correct examples and claims after a release.
Use [Getting started](GETTING-STARTED.md) for pinned installation and
[Status](STATUS.md) for the release checkpoint. Never retag or silently replace
release assets to make a documentation correction.

Keep package, wire, commitment and metrics versions distinct. Preserve the
original CLI's plaintext-SDP and same-peer-digest limitations. Treat signed media
integrity, upload consent, phone acceptance, NAT reachability, hosted CI and public
distribution as separate claims. `peerFirstBytes` and upload quota counters are
not total network-data or financial-savings measurements.

## Future documentation hosting

If a public documentation site is added, publish its Markdown, an applicable
`llms.txt`, canonical URLs, navigation and search metadata as part of that site's
deployment. Verify its actual public responses before claiming discovery or
deployment. Do not add fictional domains, indexing guarantees or unsupported
production/security claims to this repository's metadata.
