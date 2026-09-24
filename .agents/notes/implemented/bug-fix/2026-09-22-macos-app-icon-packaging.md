# Agent Note: Shared macOS app icon packaging

Status: implemented

English | [中文](2026-09-22-macos-app-icon-packaging.zh.md)

## Problem

The Host lacks a declared icon resource. Desktop's ICNS contains a small mark in the corner of a large canvas, so valid file dimensions do not establish a usable app icon. Unrelated build copies in launcher search make these visually indistinct apps harder to identify.

## Decision

The [icon generator](../../../../scripts/macos-icons.ts) reuses the canonical SVG path in a centered viewport on a rounded white tile. Desktop and Host consume the same ICNS; the Host declares and copies it before the enclosing application is signed. Packaging verifies the committed resource against the generator and inspects the visible blue mark in every standard and Retina representation, including its occupied area, center, padding, and pixel dimensions.

Desktop relies on the packaged native icon instead of overriding it with an SVG loaded as an Electron NativeImage. The HTML pairing page retains its separate SVG rendering path.

## Alternatives considered

**Resize the old bitmap.** This preserves the corner placement and magnifies the original defect. Rendering from the SVG avoids accumulated raster degradation.

**Maintain separate Host and Desktop artwork.** The two apps use one existing brand mark. Separate copies add drift without fixing an identification requirement; their names distinguish their roles.

**Patch installed signed resources.** This invalidates the Host's code seal. Icon resources belong in assembly before signing, with release installation handled independently.

## Consequences

The repository adds a direct development dependency on its already-used Sharp version and one shared generated asset. PNG previews stay in an ignored, non-indexed build directory and never introduce another launchable application. Focused regressions reject tiny corner marks, off-center marks, wrong representation sizes, missing representations, and truncated containers. The icon change does not alter application runtime, pairing, identity, permissions, or credentials.
