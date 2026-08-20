# Agent Note: Desktop and mobile product clients

Status: implemented

English | [中文](2026-08-20-desktop-and-mobile-product-clients.zh.md)

## Problem

The web app is a browser surface for a local Harness runtime. It does not provide an installable macOS owner for its window lifecycle, and it cannot give a phone the local host’s privileged tools.

## Decision

The fork contains two private product workspaces under `apps/`. `apps/desktop` starts a local DSH web runtime and renders only its loopback URL in an Electron window with Node integration disabled. `apps/mobile` is an Expo native shell that accepts only an HTTPS remote-gateway address.

The mobile gateway remains the authority for user authentication, session access, streaming, files, and action policy. Desktop-only capabilities, including computer control, do not become available to mobile clients through this product topology.

The fork tracks `deepseek-ai/deepseek-harness` through the `upstream` remote. The upstream synchronization workflow opens a pull request instead of changing `master` directly.

## Alternatives considered

**Repurpose the MyOS mobile application.** It carries unrelated runtime, account, and product concerns, so it would prevent an independently maintainable DSH product.

**Wrap the web page on mobile.** A mobile web view would inherit an unauthenticated local server model and would not provide the native session navigation or policy controls required for a phone client.

**Automatically merge upstream into `master`.** An upstream change can affect the embedded runtime or client behavior, so every synchronization remains reviewable.

## Consequences

The desktop shell can supervise and contain a DSH runtime immediately, while the mobile app cannot connect until the authenticated gateway exists. Apple signing, notarization, TestFlight configuration, and the native computer-use service remain release and platform work rather than behavior hidden in the web runtime.
