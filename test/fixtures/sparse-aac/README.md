# Sparse audio track discovery regression

These exact MPEG-TS bytes were retained from the RelaySwarm synthetic broadcaster test on 12 October 2026. They contain generated test-pattern video and tone, not third-party programme material.

| Sequence | Bytes | SHA-256 |
| --- | ---: | --- |
|784|55084|ab187fe08ee205c5542c7d4b66fa2af56339e237de5b95b0b45c8a4654bd1639|
|785|48504|3656399c37ecf2ff9ebf58ac00e34d2251ad22d44014da4bff057e9a274acaad|

Segment 784 has 60 H.264 frames and no AAC packets. Segment 785 has 60 H.264 frames and 16 AAC packets; its first audio packet arrives roughly 1.662 seconds after its first video packet. This exposes hls.js 1.7.3 track discovery after a video-only SourceBuffer already exists.

The browser regression constructs a single-variant, two-segment VOD playlist. Its low variant preserves the retained master's `BANDWIDTH=850000,RESOLUTION=640x360,FRAME-RATE=30` and absence of `CODECS`/`AUDIO` declarations. It intentionally removes the alternative high rendition to test recovery on these low bytes alone. Bytes are never remuxed or repaired.

This reproduces a later-retained sparse-AAC failure. The original hosted failures on segments 673, 678 and 683 did not retain the required bytes/append order; this test does not establish their cause.
