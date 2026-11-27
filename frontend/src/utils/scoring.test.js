import { describe, it, expect } from 'vitest'
import { isAnswerCorrect, isOptionCorrect, togglePick, isMultiSelect } from './scoring.js'

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
    expect(isMultiSelect({ answer: 'A,B', disputed: true })).toBe(false)
    expect(isMultiSelect({ answer: 'A,B', is_multi: true })).toBe(true)
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

describe('複選題（q.is_multi，全對才算對）', () => {
  it('全對才給分', () => {
    expect(isAnswerCorrect('ABC', 'A,B,C')).toBe(true)
    expect(isAnswerCorrect(['C', 'A', 'B'], 'A,B,C')).toBe(true)
    expect(isAnswerCorrect('AD', 'AD')).toBe(true)
  })
  it('少選不給分（這是修掉的那個 bug：點一個就判對）', () => {
    expect(isAnswerCorrect('A', 'A,B,C', true)).toBe(false)
    expect(isAnswerCorrect('AB', 'A,B,C', true)).toBe(false)
  })
  it('多選、選錯都不給分', () => {
    expect(isAnswerCorrect('ABCD', 'A,B,C', true)).toBe(false)
    expect(isAnswerCorrect('ABD', 'A,B,C', true)).toBe(false)
  })
  it('沒有逗號的 ACE 也要標出三個正解', () => {
    expect(isOptionCorrect('A', 'ACE')).toBe(true)
    expect(isOptionCorrect('C', 'ACE')).toBe(true)
    expect(isOptionCorrect('E', 'ACE')).toBe(true)
    expect(isOptionCorrect('B', 'ACE')).toBe(false)
  })
  it('更正成雙答案的題（選一個就對）不受影響', () => {
    expect(isAnswerCorrect('A', 'A,B')).toBe(true)
    expect(isAnswerCorrect('B', 'A,B')).toBe(true)
    expect(isMultiSelect({ answer: 'A,B', disputed: true })).toBe(false)
    expect(isMultiSelect({ answer: 'A,B', is_multi: true })).toBe(true)
  })
  it('複選題送分一樣給分', () => {
    expect(isAnswerCorrect('AB', '送分')).toBe(true)
  })
  it('togglePick 加減選項並排序', () => {
    expect(togglePick('', 'C')).toBe('C')
    expect(togglePick('C', 'A')).toBe('AC')
    expect(togglePick('AC', 'C')).toBe('A')
  })
})
