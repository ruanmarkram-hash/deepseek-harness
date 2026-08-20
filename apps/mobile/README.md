# DSH Mobile

English | [中文](README.zh.md)

`@deepseek-ai/dsh-mobile` is a native Expo client for remote DSH sessions. The app accepts an HTTPS gateway address, but the gateway is intentionally not implemented in the app: it must authenticate a paired user and apply server-side session and permission policy.

Computer use remains desktop-only. The mobile app receives streamed session state and can submit user-approved actions after the remote gateway is introduced.
