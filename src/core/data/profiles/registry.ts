import type { ParsedCsv } from '../csv'
import { aimProfile } from './aim'
import { genericProfile } from './generic'
import { solostormProfile } from './solostorm'
import type { Detection, LoggerProfile } from './types'
import { createUserProfile, type UserProfileDefinition } from './user'

export interface ProfileMatch {
  profile: LoggerProfile
  detection: Detection
}

/**
 * Known logger profiles. Detection order: user profiles (most specific),
 * then built-ins with high confidence, then any low-confidence match, then
 * the generic fallback.
 */
export class ProfileRegistry {
  private readonly builtIns: LoggerProfile[]
  private readonly userProfiles = new Map<string, { definition: UserProfileDefinition; profile: LoggerProfile }>()

  constructor(builtIns: LoggerProfile[] = [solostormProfile, aimProfile]) {
    this.builtIns = builtIns
  }

  addUserProfile(definition: UserProfileDefinition): LoggerProfile {
    if (this.builtIns.some((profile) => profile.id === definition.id) || definition.id === genericProfile.id) {
      throw new Error(`Profile id "${definition.id}" is reserved`)
    }
    const profile = createUserProfile(definition)
    this.userProfiles.set(definition.id, { definition, profile })
    return profile
  }

  removeUserProfile(id: string) {
    this.userProfiles.delete(id)
  }

  userProfileDefinitions(): UserProfileDefinition[] {
    return [...this.userProfiles.values()].map((entry) => entry.definition)
  }

  list(): LoggerProfile[] {
    return [...[...this.userProfiles.values()].map((entry) => entry.profile), ...this.builtIns, genericProfile]
  }

  get(id: string): LoggerProfile | undefined {
    return this.list().find((profile) => profile.id === id)
  }

  detect(parsed: ParsedCsv): ProfileMatch {
    for (const { profile } of this.userProfiles.values()) {
      const detection = profile.detect(parsed)
      if (detection) return { profile, detection }
    }
    let lowConfidence: ProfileMatch | null = null
    for (const profile of this.builtIns) {
      const detection = profile.detect(parsed)
      if (!detection) continue
      if (detection.confidence === 'high') return { profile, detection }
      lowConfidence ??= { profile, detection }
    }
    return (
      lowConfidence ?? {
        profile: genericProfile,
        detection: { confidence: 'low', reason: 'No known logger recognised; columns were guessed' },
      }
    )
  }
}
