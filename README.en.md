# DS Lite

An Android client for the DeepSeek API, forked from the officially open-sourced [chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT). Not an official product.

**This is a client, not a service.** It ships no API key, proxies no requests and runs no backend: you use your own key and your conversations go straight to DeepSeek's API.

Free, open source, no ads, no in-app purchases, no telemetry.

## Highlights

- Persistent context-usage banner (blue / amber / red / yellow-black) with one-tap compaction
- Overwriting long-term memory notes: every compaction rewrites a single fresh list; notes you wrote or edited by hand are preserved
- SillyTavern v2 character cards
- Peak/off-peak cost estimation from the API `usage` field
- Everything from upstream: multi-conversation, branching, attachments, voice, Markdown/KaTeX/Mermaid, i18n, import/export

## Download

Grab the latest `DS-Lite-vX.Y.Z-release.apk` from [Releases](../../releases/latest). Android 7.0+ (API 24), ~5 MB.

## Build

```sh
pnpm install
pnpm dev                 # web dev server
pnpm build               # static site -> dist/
npx cap sync android
cd android && ./gradlew assembleRelease
```

Release signing reads `android/keystore.properties`; without it `assembleRelease` produces an unsigned build.

## HarmonyOS (optional)

`harmonyos/` is a native shell that loads the same packaged React UI in ArkWeb. It is not an official Huawei or DeepSeek product. Build with `pnpm build:harmonyos` then assemble the HAP using DevEco / hvigor against HarmonyOS SDK API 26. Requires an `hdc`-visible device (API 26). Do not commit signing material; see [harmonyos/说明.md](harmonyos/说明.md) (Chinese) and the HarmonyOS section in [README.md](README.md).

## License

MIT. Upstream copyright notice retained in [LICENSE](LICENSE). See [README.md](README.md) (Chinese) for full docs.
