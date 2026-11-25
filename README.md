# ECO Field Check

**Proof at the tree, even without signal.** A hybrid AI web app that verifies tree-planting claims on the device, offline, with Gemini Nano, and audits them in the cloud with Gemini when the network returns. Built with **Firebase AI Logic hybrid inference** for #BuildHybridAI 2026.

ECO (Grade AI Limited, Nairobi) pays people in Kenya and Tanzania for verified climate work. Planting sites are often far from good mobile coverage, and sending every photo to the cloud is slow and costly. ECO Field Check moves the first check onto the planter's or field coordinator's device.

## How it works

1. **Record a tree.** The planter enters their name, species and site, takes a photo and captures GPS.
2. **Check on device (hybrid).** `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE })` sends the photo and claim to **Gemini Nano** in Chrome. The model returns structured JSON (tree visible, seedling count, freshly planted, issues, verdict, reason), enforced on device with the Prompt API `responseConstraint` and in the cloud with `responseSchema`. If Gemini Nano is not available, Firebase AI Logic falls back to Gemini in the cloud automatically. The UI shows `response.inferenceSource` (`on_device` or `in_cloud`) for every check.
3. **Rule checks without AI.** A 64-bit perceptual hash flags the same photo submitted twice, even resized; claims with no GPS are flagged.
4. **Ghost Audit in the cloud.** When the device is back online, a second model (`InferenceMode.ONLY_IN_CLOUD`) tries to disprove each claim: staged or reused photos, potted plants, mature trees passed off as new.
5. **A person decides.** A reviewer approves or rejects each claim. Nothing is paid on AI alone. Claims export to CSV for the funder.

The app is an installable PWA with an offline shell (service worker), so it opens and checks on device with no signal.

## Why hybrid

| Need in the field | On device (Gemini Nano) | Cloud (Gemini) |
| --- | --- | --- |
| Works with no signal | Yes | No |
| Photo stays on the device | Yes | No |
| Cost per check | Free | Paid per token |
| Depth of scrutiny | Fast first check | Ghost Audit second opinion |

## Run it

No build step: the app is plain HTML, CSS and JavaScript, loading the Firebase JS SDK (v13.4.0) as ES modules.

1. Create a Firebase project, enable **Firebase AI Logic** with the Gemini Developer API, and register a web app.
2. Put your web config in [`config.js`](config.js). Register the app with **App Check** (reCAPTCHA v3) and set `RECAPTCHA_SITE_KEY`, or set `APPCHECK_DEBUG_TOKEN` to a debug token registered in the console for local testing.
3. Serve the folder over HTTP, for example `npx serve .` or `python3 -m http.server`, and open it in Chrome.

On-device inference needs desktop **Chrome 139+** with `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` set to **Enabled**. Click **Prepare on-device model** once to download Gemini Nano. In other browsers the app still works, with every check in the cloud.

The live demo is hosted on GitHub Pages from this repository.

## Firebase AI Logic in the code

All calls are in [`main.js`](main.js):

- `getAI(app, { backend: new GoogleAIBackend() })`
- `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams, inCloudParams })` for the field check
- `model.initializeDeviceModel(progress)` after a user click, to download Gemini Nano
- `getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams })` for the Ghost Audit
- `result.response.inferenceSource` to show where each check ran
- `initializeAppCheck(app, { provider: new ReCaptchaV3Provider(...) })`

## License

Apache License 2.0. See [LICENSE](LICENSE).
