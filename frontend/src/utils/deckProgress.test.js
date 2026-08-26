import { describe, expect, it } from 'vitest'
import { deckProgress, deckShortage, groupDeckEntries } from './deckProgress'

describe('deck progress utilities', () => {
  it('reports remaining, complete, and over deck sizes', () => {
    expect(deckProgress({ target_size: 60, current_card_count: 58 })).toMatchObject({ remaining: 2, over: 0, status: 'under' })
    expect(deckProgress({ target_size: 60, current_card_count: 60 }).status).toBe('complete')
    expect(deckProgress({ target_size: 20, current_card_count: 22 })).toMatchObject({ remaining: 0, over: 2, status: 'over' })
  })

  it('sums missing copies without treating extra ownership as negative', () => {
    expect(deckShortage([{ required_quantity: 4, owned_quantity: 2 }, { required_quantity: 1, owned_quantity: 3 }])).toBe(2)
  })

  it('groups only by card supertype and preserves unknown cards as Other', () => {
    const groups = groupDeckEntries([{ card: { supertype: 'Pokémon' } }, { card: { supertype: 'Trainer' } }, { card: { supertype: 'Energy' } }, { card: {} }])
    expect(Object.values(groups).map(group => group.length)).toEqual([1, 1, 1, 1])
  })
})
