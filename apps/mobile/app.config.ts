import type { ExpoConfig } from 'expo/config'

const config: ExpoConfig = {
  name: 'DSH Mobile',
  slug: 'dsh-mobile',
  scheme: 'dsh',
  version: '0.1.0',
  icon: './assets/app-icon.png',
  orientation: 'portrait',
  ios: {
    bundleIdentifier: process.env.DSH_MOBILE_BUNDLE_ID ?? 'com.example.dshmobile',
    supportsTablet: true,
  },
  android: {
    package: process.env.DSH_MOBILE_ANDROID_PACKAGE ?? 'com.example.dshmobile',
  },
}

export default config
