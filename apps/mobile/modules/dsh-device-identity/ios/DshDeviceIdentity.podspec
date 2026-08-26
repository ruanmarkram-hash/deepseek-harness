require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'DshDeviceIdentity'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.homepage = 'https://dsh.rulabs.dev'
  s.authors = { 'DSH' => 'support@rulabs.dev' }
  s.license = package['license']
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://example.invalid/dsh-mobile-device-identity.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'DshDeviceIdentityModule.swift', 'Sources/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
