# Agent Note: Signed Host pairing state diagnosis

Status: implemented

English | [中文](2026-09-22-native-pairing-state-diagnostic.zh.md)

## Problem

A missing hosted-child enrollment receipt identifies neither a credential read failure nor a disagreement between the native pairing and durable public enrollment. External diagnostics cannot rely on authorization to read the signed Host's Keychain item, and exporting it would expose route capabilities.

## Decision

The signed Host offers a read-only **Check pairing state** action using its existing noninteractive credential store. Only public identity fields enter the comparison. Bounded, descriptor-relative reads inspect the standard JSON public directories under the validated sealed DSH home and reject links, unexpected file types, and other-user writers. Reports contain fixed text and presence/equality booleans; errors never interpolate underlying descriptions or stored values. The startup controls retain four buttons by placing revocation only in the Host menu.

## Alternatives considered

**External credential extraction** cannot assume the signed application's authorization and unnecessarily exposes capabilities. The diagnostic stays inside the existing authorized process.

**Enrollment repair or automatic re-pairing** would mutate trust before the discrepancy is understood. This action performs neither and does not establish a network connection.

**New FD198 error messages** would widen the runtime protocol and require a coordinated child release. The local comparison needs only the outer Host executable.

## Consequences

Host device identity equality on the stored route is independent of Host enrollment-incarnation equality. Both are observable booleans; a mismatch alone does not authorize replacement. The separate [guarded repair](2026-09-23-guarded-same-phone-enrollment-repair.md) additionally proves the native credential matches the current protected Host.

Diagnosis distinguishes absent records, public tuple conflicts, and fixed read/validation failures without exporting credentials or changing runtime ownership. It covers the standard JSON storage layout, not arbitrary storage-backend overrides, and concurrent writes can change state after the observation. Matching records are not connectivity proof. Focused native tests pin the rendered report, conflict and failure handling, bounded reads, unsafe-path rejection, and preservation of file contents and modification time.
