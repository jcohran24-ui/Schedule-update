# Optional Capacitor Store Wrapper

The main V18 app is already installable on Android and iPhone as a PWA.
Use this folder only if you later want Google Play / Apple App Store packages.

1. Edit `capacitor.config.ts` and replace `https://YOUR-RENDER-URL.onrender.com` with the live app URL.
2. Run `npm install`.
3. Run `npx cap add android` and/or `npx cap add ios`.
4. Run `npx cap sync`.
5. Android: `npx cap open android` (requires Android Studio).
6. iOS: `npx cap open ios` (requires macOS + Xcode).
