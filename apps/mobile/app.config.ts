import type { ExpoConfig } from 'expo/config'

const DSH_MOBILE_BUNDLE_ID = 'app.dsh.mobile'

const config: ExpoConfig = {
  name: 'DSH Mobile',
  slug: 'dsh-mobile',
  scheme: 'dsh',
  version: '0.1.0',
  icon: './assets/app-icon.png',
  orientation: 'portrait',
  extra: {
    eas: {
      projectId: 'eb81baa7-5081-4c8a-91a9-fc039d880b92',
    },
  },
  ios: {
    bundleIdentifier: DSH_MOBILE_BUNDLE_ID,
    supportsTablet: true,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: true,
    },
  },
  android: {
    package: DSH_MOBILE_BUNDLE_ID,
  },
}

export default config
