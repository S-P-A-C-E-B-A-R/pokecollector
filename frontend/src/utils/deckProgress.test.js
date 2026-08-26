import { describe, expect, it } from 'vitest'
import { deckComposition, deckProgress, deckShortage, groupDeckEntries, nextDeckCardIndex, previousDeckCardIndex, sortDeckEntries } from './deckProgress'

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

  it('builds target-sized composition segments for 20, 40, and 60 card decks', () => {
    const entries = [
      { required_quantity: 8, card: { supertype: 'Pokemon' } },
      { required_quantity: 10, card: { supertype: 'Trainer' } },
      { required_quantity: 6, card: { supertype: 'Energy' } },
    ]
    expect(deckComposition(entries, 40)).toMatchObject({ counts: { Pokemon: 8, Trainer: 10, Energy: 6 }, remaining: 16 })
    expect(deckComposition(entries, 20).segments.reduce((total, segment) => total + segment.visibleCount, 0)).toBe(20)
    expect(deckComposition(entries, 60).remaining).toBe(36)
  })

  it('caps composition segments at a complete or over-target deck', () => {
    const entries = [{ required_quantity: 30, card: { supertype: 'Pokemon' } }, { required_quantity: 20, card: { supertype: 'Trainer' } }]
    const composition = deckComposition(entries, 40)
    expect(composition.remaining).toBe(0)
    expect(composition.segments.reduce((total, segment) => total + segment.visibleCount, 0)).toBe(40)
  })

  it('sorts one entry per tile by category then stable card identity', () => {
    const sorted = sortDeckEntries([
      { id: 3, card: { name: 'Energy', supertype: 'Energy', set_id: 'sv1', number: '3' } },
      { id: 2, card: { name: 'Zubat', supertype: 'Pokemon', set_id: 'sv1', number: '2' } },
      { id: 1, card: { name: 'Abra', supertype: 'Pokemon', set_id: 'sv1', number: '1' } },
      { id: 4, card: { name: 'Ball', supertype: 'Trainer', set_id: 'sv1', number: '4' } },
    ])
    expect(sorted.map(entry => entry.id)).toEqual([1, 2, 4, 3])
  })

  it('wraps gallery viewer navigation in gallery order', () => {
    expect(nextDeckCardIndex(3, 4)).toBe(0)
    expect(previousDeckCardIndex(0, 4)).toBe(3)
    expect(nextDeckCardIndex(0, 0)).toBeNull()
  })
})
