export function deckProgress(deck = {}) {
  const current = Number(deck.current_card_count ?? deck.entries?.reduce((sum, entry) => sum + Number(entry.required_quantity || 0), 0) ?? 0)
  const target = Number(deck.target_size || 0)
  return {
    current,
    target,
    remaining: Math.max(target - current, 0),
    over: Math.max(current - target, 0),
    status: current < target ? 'under' : current > target ? 'over' : 'complete',
  }
}

export function deckShortage(entries = []) {
  return entries.reduce((total, entry) => total + Math.max(Number(entry.required_quantity || 0) - Number(entry.owned_quantity || 0), 0), 0)
}

export function groupDeckEntries(entries = []) {
  const groups = { Pokemon: [], Trainer: [], Energy: [], Other: [] }
  entries.forEach(entry => {
    const supertype = entry.card?.supertype?.toLowerCase()
    const group = supertype === 'pokemon' || supertype === 'pokémon' ? 'Pokemon' : supertype === 'trainer' ? 'Trainer' : supertype === 'energy' ? 'Energy' : 'Other'
    groups[group].push(entry)
  })
  return groups
}
