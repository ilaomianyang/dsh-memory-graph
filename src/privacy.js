/**
 * Write-time privacy filter.
 *
 * Every string that is about to enter the vault passes through a redactor.
 * Nothing is written and then cleaned up afterwards: if a rule matches, the
 * secret never reaches the file at all. The audit log records the rule that
 * fired, never the matched text.
 */
import os from 'node:os'
import { DEFAULT_DENY_PATTERNS } from './config.js'

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function compile(pattern) {
  let flags = 'g'
  let source = String(pattern)
  // JS has no inline flags; accept the common `(?i)` prefix as an instruction.
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    flags += 'i'
  }
  return new RegExp(source, flags)
}

/**
 * @returns {{ redact(text: string, where?: string): { text: string, hits: string[] }, ruleCount: number }}
 */
export function createRedactor(privacy) {
  const patterns = []
  if (privacy.useDefaultPatterns !== false) patterns.push(...DEFAULT_DENY_PATTERNS)
  patterns.push(...(privacy.denyPatterns || []))

  const rules = []
  for (const pattern of patterns) {
    try {
      rules.push({ pattern, re: compile(pattern) })
    } catch {
      // A malformed user rule must not break capture; it simply does not apply.
    }
  }

  const home = os.homedir()

  function redact(text) {
    if (typeof text !== 'string' || text === '') return { text: '', hits: [] }
    let out = text
    const hits = []

    for (const rule of rules) {
      rule.re.lastIndex = 0
      if (!rule.re.test(out)) continue
      rule.re.lastIndex = 0
      out = out.replace(rule.re, () => '[REDACTED]')
      hits.push(rule.pattern)
    }

    if (privacy.redactPaths !== false && home.length > 2) {
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escaped.replace(/\\\\/g, '[\\\\/]'), 'g')
      if (re.test(out)) {
        re.lastIndex = 0
        out = out.replace(re, '~')
        hits.push('home-path')
      }
    }

    if (privacy.redactEmails !== false && EMAIL.test(out)) {
      EMAIL.lastIndex = 0
      out = out.replace(EMAIL, '[email]')
      hits.push('email')
    }
    EMAIL.lastIndex = 0

    return { text: out, hits }
  }

  return { redact, ruleCount: rules.length }
}
