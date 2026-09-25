# Signed Host-attached Desktop

English | [中文](README.zh.md)

## Summary

Open the signed DSH Host's existing Web runtime in a desktop window. This private macOS shell never starts or stops a runtime, pairs a phone, or changes Host configuration. The maintained upstream Desktop under `apps/desktop` remains a separate product with its own runtime owner.

## Table of Contents

- [Connection](#connection)
- [Verification and packaging](#verification-and-packaging)
- [Limitations](#limitations)

<a id="connection"></a>

## Connection

Start the signed Host's hosted runtime before opening this shell. The shell reads `runtime/web.json` and `runtime/web-bootstrap.json` under `DSH_HOME`, or `~/.dsh` when that variable is absent. Both records must belong to the same live process, publication instant, and exact `127.0.0.1` origin. The private bootstrap exchanges its token for the existing browser-authentication cookie; the renderer cannot navigate to a token URL afterward.

The reader refuses symlinks, hardlinked or nonregular records, records larger than 4096 bytes, unsafe owners, and unsafe modes. The runtime directory must be `0700`, both files must be `0600`, and the DSH home must not be writable by another user. Invalid records produce a fixed diagnostic that never includes the token. Restart the Host runtime to republish its records; the shell does not repair them.

<a id="verification-and-packaging"></a>

## Verification and packaging

From the repository root, the focused tests exercise the actual plain-Node reader and navigation policy:

```sh
node --test native/remote-host-app/desktop-shell/tests/*.test.mjs
```

The private [builder configuration](electron-builder.cjs) uses the installed `apps/desktop` Electron and electron-builder tools and the `DeepSeek-DESKTOP.icns` icon variant. It includes only this shell's runtime files, not a Node or DSH runtime. The release owner runs this packaging command after dependency installation, then verifies the built app against the signed Host before installation:

```sh
apps/desktop/node_modules/.bin/electron-builder --config native/remote-host-app/desktop-shell/electron-builder.cjs --mac --arm64 --dir
```

The configured output is `release.noindex/mac-arm64/DSH Desktop.app` below this directory. The `.noindex` directory excludes build artifacts from Spotlight; release owners must also unregister noninstalled app bundles from LaunchServices and archive them recoverably after testing. This command disables signing; signing, notarization, installation, and live launch remain separate release-owner operations. Packaging and live authentication require release verification; the unit tests do not establish those results.

<a id="limitations"></a>

## Limitations

The shell denies popups, embedded WebViews, renderer navigation outside its selected origin, and browser permission requests. It provides standard application, editing, view, and window menus, but does not restore window placement. Host restart requires reopening the shell to authenticate against the new runtime. The [native Host reference](../README.md) owns runtime and phone operations.
