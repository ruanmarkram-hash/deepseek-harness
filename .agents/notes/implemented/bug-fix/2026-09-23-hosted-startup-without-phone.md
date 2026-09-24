# Agent Note: Hosted startup without a phone

Status: implemented

English | [中文](2026-09-23-hosted-startup-without-phone.zh.md)

## Problem

A recovered, activated ownership journal establishes who may serve phone sessions, not whether a phone is online. Making local startup wait for a phone handshake couples browser availability to an unrelated network deadline and contradicts the explicit activation control.

## Decision

The production controller uses one [lifecycle owner](../../../../native/remote-host-app/Sources/RemoteHostApp/HostedRuntimeLifecycle.swift) for local startup, explicit activation and teardown. Startup only restores the child. Activation selects fresh ownership transfer or resume according to the retained coordinator's phase. A single operation reservation prevents concurrent activation and replacement during cleanup. Stop detaches pending sessions and awaits canceled operations, including synchronous child startup, before returning.

## Alternatives considered

**Automatic resume with a longer timeout** still makes local availability depend on the phone and changes security timing without addressing ownership intent.

**Retrying the same child after a failed activation** reuses a one-shot enrollment seed. Failed activation therefore retires the child while preserving the signed journal, pairing credential and native ledger; a new explicit Start restores an inert child.

## Consequences

The phone need not be present to start the hosted Web runtime. Stop can wait for bounded startup or handshake work to finish cleanup; no replacement owner is admitted meanwhile. Credential-validation failure before session construction leaves the unseeded child available. The mobile protocol, handshake deadlines, epoch synchronization and repair eligibility rules are unchanged.

## Verification

Six deterministic tests execute the production lifecycle with injected child and phone operations: restored and fresh activation, handshake failure and restart, startup and activation cancellation, concurrent activation exclusion, and repair reservation exclusion. They assert that Stop remains pending until suspended work is released and that late work cannot retain an owner. These tests do not replace signed-bundle browser verification or a physical-phone handshake.
