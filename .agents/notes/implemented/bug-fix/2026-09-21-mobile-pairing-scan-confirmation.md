# Agent Note: Mobile pairing scan confirmation

Status: implemented

English | [中文](2026-09-21-mobile-pairing-scan-confirmation.zh.md)

## Problem

The camera submitted enrollment immediately, without the confirmation offered for typed codes. Camera callbacks can repeat before React commits a busy state, allowing duplicate offers. The relay rejects duplicate offers with HTTP 409, but the phone classified every rejected offer as expired. A screenshot of the expiry message alone therefore cannot establish the actual relay response or prove a duplicate request occurred.

## Decision

Scanning validates and captures one code, closes the scanner, and requires **Pair with Host** before any enrollment request. A synchronous guard serializes explicit submissions independently of React rendering. HTTP status determines locally authored messages; relay bodies and pairing credentials never appear in errors. HTTP 404 describes an unavailable code, which may be expired or removed, rather than asserting expiry. Approval polling timeout is separate from code validity.

## Alternatives considered

**Keep automatic submission with a lock.** This prevents duplicate requests but retains the surprising difference between scanned and typed codes.

**Treat conflicts as successful retries.** The relay does not establish that the existing offer belongs to this phone in a conflict response, so silently continuing would hide uncertain state.

## Consequences

Pairing requires one explicit tap after scanning. The Host still requires local fingerprint comparison and approval. Focused regressions cover repeated camera callbacks, concurrent submission callbacks, guard release, and safe failure messages. Native camera interaction and the complete physical-device pairing sequence remain separate release checks; passing unit tests does not prove a deployed phone build or a live connection.
