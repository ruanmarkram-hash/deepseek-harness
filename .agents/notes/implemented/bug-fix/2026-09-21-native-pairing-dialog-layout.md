# Agent Note: Native pairing dialog sizing

Status: implemented

English | [中文](2026-09-21-native-pairing-dialog-layout.zh.md)

## Problem

An unconstrained stack used as an NSAlert accessory can retain the QR image's intrinsic size despite a smaller image-view frame. The resulting dialog clips the QR code and manual text, preventing phone enrollment.

## Decision

The pairing presentation owns an explicitly sized accessory. QR modules use integer sizes with an opaque four-module white quiet zone, and the full selectable manual code wraps by character. QR rendering failure retains the manual code. Pairing, expiration, and fingerprint approval remain unchanged.

## Alternatives considered

**Only shrinking the image frame** does not establish the accessory's size and leaves intrinsic-size clipping possible.

**Truncated text with a tooltip** leaves manual entry dependent on hover and hides part of the credential from a person reading the screen.

## Consequences

The dialog consumes more vertical space to expose the complete credential. AppKit tests lay out the real alert and verify containment, manual fallback, and QR round-trip decoding. A standalone fixture-code rendering uses the same presentation builder without starting the Host or accessing credentials. These checks do not replace scanning a released signed app on a physical phone.
