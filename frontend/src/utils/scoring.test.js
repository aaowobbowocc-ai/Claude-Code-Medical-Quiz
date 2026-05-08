import { describe, it, expect } from 'vitest'
import { isAnswerCorrect, isOptionCorrect } from './scoring.js'

describe('isAnswerCorrect', () => {
  it('strict single-letter match', () => {
    expect(isAnswerCorrect('A', 'A')).toBe(true)
    expect(isAnswerCorrect('B', 'A')).toBe(false)
  })

  it('送分 (一律給分) accepts any answer', () => {
    expect(isAnswerCorrect('A', '送分')).toBe(true)
    expect(isAnswerCorrect('B', '送分')).toBe(true)
    expect(isAnswerCorrect('C', '送分')).toBe(true)
    expect(isAnswerCorrect('D', '送分')).toBe(true)
  })

  it('multi-answer (A,B) accepts either', () => {
    expect(isAnswerCorrect('A', 'A,B')).toBe(true)
    expect(isAnswerCorrect('B', 'A,B')).toBe(true)
    expect(isAnswerCorrect('C', 'A,B')).toBe(false)
  })

  it('multi-answer with whitespace', () => {
    expect(isAnswerCorrect('A', 'A, B')).toBe(true)
    expect(isAnswerCorrect('B', 'A, B')).toBe(true)
  })

  it('empty/null answer falls back to 送分 behavior', () => {
    expect(isAnswerCorrect('A', '')).toBe(true)
    expect(isAnswerCorrect('A', null)).toBe(true)
  })
})

describe('isOptionCorrect', () => {
  it('single answer highlights only that letter', () => {
    expect(isOptionCorrect('A', 'A')).toBe(true)
    expect(isOptionCorrect('B', 'A')).toBe(false)
  })

  it('送分 highlights all four options', () => {
    for (const o of ['A', 'B', 'C', 'D']) {
      expect(isOptionCorrect(o, '送分')).toBe(true)
    }
  })

  it('multi-answer highlights all listed letters', () => {
    expect(isOptionCorrect('A', 'A,C')).toBe(true)
    expect(isOptionCorrect('C', 'A,C')).toBe(true)
    expect(isOptionCorrect('B', 'A,C')).toBe(false)
    expect(isOptionCorrect('D', 'A,C')).toBe(false)
  })
})
