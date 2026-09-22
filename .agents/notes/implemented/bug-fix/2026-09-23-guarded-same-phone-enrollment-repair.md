# Agent Note: Guarded same-phone enrollment repair

Status: implemented

English | [中文](2026-09-23-guarded-same-phone-enrollment-repair.zh.md)

## Problem

An approved native route can disagree with an older unused public device and Host enrollment even when the phone's public identity matches. Re-pairing or silently accepting a conflicting seed changes trust without proving which records are authoritative.

## Decision

The native credential must match the current cached, pinned XPC Host device identity, and that identity's agreement key must match the same typed protected agreement provider. Both checks occur inside the held route lease and transaction. Only this proof permits replacement of a syntactically valid stale public route Host device ID; normal activation still rejects conflicting enrollment. The check calls no identity-creation path and leaves native credentials unchanged.

The signed Host exposes a separate, twice-confirmed offline repair. Admission requires one same-phone public tuple with both incarnation mismatches, matching keys and label, internally consistent route references, supported unit versions, and unused public/native epochs. A native route lease and transaction hold admission while recovery markers and native state are checked. The Host reserves its runtime-start state and configured loopback port. The operator stops every external writer; the port reservation is not a universal file-writer lock.

A private descriptor-relative journal stores only exact public preimages and proposed images with hashes. File replacement is atomic, bounded, permission-preserving and guarded by preimage equality. Partial work rolls back only recognized original/target bytes. Unknown intervening writes fail closed. Prepared or corrupt journals block hosted startup and activation until explicit recovery; completed journals are historical backups, not permanent equality constraints on evolving runtime data. Native credentials, invitations and epoch records are never rewritten.

## Alternatives considered

**Weakening enrollment seed checks** would let an ordinary activation replace trusted lifetime identifiers. Repair has a separate operator action and strictly narrower admission.

**Deleting device or route stores** would discard unrelated metadata and lose recoverable evidence. The transaction preserves metadata and exact public originals.

**An unjournaled two-file edit** cannot distinguish a crash between replacements from an intentional mixed state. The durable journal precedes replacements and supports exact rollback.

## Consequences

The operation fixes only the diagnosed same-phone, zero-use, double-incarnation mismatch. A used or ambiguous route, alternate storage layout, unsafe file ownership, permissions, links, or any pending native recovery remains refused. Focused native tests exercise scope rejection, original preservation, permissions, partial failure, interruption recovery, concurrent changes, version validation, size growth and native lease/epoch admission without live credentials. The JSON projection remains subject to the operator's offline-writer requirement.
