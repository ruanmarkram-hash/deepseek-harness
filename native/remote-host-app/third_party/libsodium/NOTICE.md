# libsodium

This directory contains the unmodified upstream `libsodium-1.0.22-stable.tar.gz` source artifact.

The prepare script verifies the vendored official Minisign signature using `libsodium-release.minisign.pub`, then verifies the SHA-256 in `SOURCE.json` before extraction. The tracked `prebuilt/macos-arm64/libsodium.a` is the macOS-arm64 result for the inputs recorded in `prebuilt/macos-arm64/PREBUILT.json`; Package.swift pins its digest before linking. libsodium is distributed under the ISC license. The verbatim upstream license is inside the archive at `LICENSE`; distribution automation must retain it alongside every extracted or linked copy.

The vendored archive, Minisign signature, public key, and recorded hashes are authoritative for this checkout. The download URL in `SOURCE.json` records the source location only and is not consulted during verification or builds.

Only the narrow `SodiumXChaChaBridge` C wrapper may call libsodium. It exposes RFC 8439 ChaCha20-Poly1305
encrypt/decrypt and `sodium_memzero`; no generic crypto API is available to Host code.
