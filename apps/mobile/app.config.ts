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
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription: 'DSH Mobile uses the camera only to scan a short-lived DSH Host pairing QR code.',
      NSFaceIDUsageDescription: 'DSH Mobile uses Face ID to authenticate access to this phone’s protected pairing identity.',
    },
  },
  android: {
    package: DSH_MOBILE_BUNDLE_ID,
  },
}

export default config
