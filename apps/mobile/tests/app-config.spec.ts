import { describe, expect, it } from 'vitest'
import config from '../app.config'

describe('DSH Mobile native configuration', () => {
  it('declares why protected mobile identity authentication may use Face ID', () => {
    expect(config.ios?.infoPlist?.NSFaceIDUsageDescription).toBe(
      'DSH Mobile uses Face ID to authenticate access to this phone’s protected pairing identity.',
    )
  })
})
