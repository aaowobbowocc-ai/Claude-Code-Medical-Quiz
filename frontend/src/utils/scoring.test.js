import { describe, it, expect } from 'vitest'
import { isAnswerCorrect, isOptionCorrect, togglePick, isMultiSelect, paperScoring, questionScore, questionPoints, gradePaper } from './scoring.js'

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

// 鐵路佐級國文的配分（卷頭原文見 scoring.js 的註解）
const CH = { pointsPerQ: 2, multiPointsPerQ: 3, multiPartial: [3, 1.8, 0.6] }
const single = (answer) => ({ answer })
const multi = (answer) => ({ answer, is_multi: true })

describe('考選部配分（單選 2 分 / 複選 3 分 + 選項獨立判定）', () => {
  const sc = paperScoring(CH)

  it('單選答對 2 分、答錯 0 分', () => {
    expect(questionScore(single('A'), 'A', sc)).toBe(2)
    expect(questionScore(single('A'), 'B', sc)).toBe(0)
  })

  it('複選全對 3 分', () => {
    expect(questionScore(multi('A,D'), 'AD', sc)).toBe(3)
    expect(questionScore(multi('A,C,E'), 'ACE', sc)).toBe(3)
  })

  it('少選一個 = 錯一格 → 1.8 分', () => {
    expect(questionScore(multi('A,C,E'), 'AC', sc)).toBe(1.8)
  })

  it('多選一個 = 錯一格 → 1.8 分', () => {
    expect(questionScore(multi('A,D'), 'ADE', sc)).toBe(1.8)
  })

  it('選錯一個（該選的沒選＋不該選的選了）= 錯兩格 → 0.6 分', () => {
    expect(questionScore(multi('A,D'), 'AB', sc)).toBe(0.6)
  })

  it('錯超過兩格 → 0 分', () => {
    expect(questionScore(multi('A,D'), 'BCE', sc)).toBe(0)
  })

  it('白卷不給分 —— 正解兩個字母時對稱差集剛好是 2，不能掉進 0.6 分那格', () => {
    expect(questionScore(multi('A,D'), '', sc)).toBe(0)
    expect(questionScore(multi('A,D'), undefined, sc)).toBe(0)
  })

  it('複選題送分給滿分（3 分）', () => {
    expect(questionScore(multi('送分'), '', sc)).toBe(3)
  })

  it('沒設配分的考卷照舊一題一分', () => {
    const flat = paperScoring(null)
    expect(questionScore(single('A'), 'A', flat)).toBe(1)
    expect(questionScore(multi('A,D'), 'AD', flat)).toBe(1)
    expect(questionScore(multi('A,D'), 'A', flat)).toBe(0)  // 沒有部分給分 → 全對才給分
    expect(gradePaper([single('A')], { 0: 'A' }, null).hasPoints).toBe(false)
  })

  it('整卷 35 單選 + 10 複選 = 滿分 100 分', () => {
    const qs = [...Array(35)].map(() => single('A')).concat([...Array(10)].map(() => multi('A,D')))
    const all = {}
    qs.forEach((_, i) => { all[i] = i < 35 ? 'A' : 'AD' })
    const g = gradePaper(qs, all, CH)
    expect(g.full).toBe(100)
    expect(g.score).toBe(100)
    expect(g.correct).toBe(45)
    expect(g.hasPoints).toBe(true)
  })

  it('部分給分的題不算「答對」，但分數要加進總分（且不能有浮點誤差）', () => {
    const qs = [multi('A,C,E'), multi('A,D')]
    const g = gradePaper(qs, { 0: 'AC', 1: 'AB' }, CH)  // 1.8 + 0.6
    expect(g.score).toBe(2.4)
    expect(g.full).toBe(6)
    expect(g.correct).toBe(0)
  })
})
