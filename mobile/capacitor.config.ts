import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.newsouth.ctccoasis.schedule',
  appName: 'CTCC Oasis Schedule',
  webDir: 'www',
  server: {
    // Replace this with the live Render URL before creating native Android/iOS projects.
    url: 'https://YOUR-RENDER-URL.onrender.com',
    cleartext: false
  }
};

export default config;
