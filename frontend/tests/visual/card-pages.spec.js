import { expect, test } from '@playwright/test'

const USER = {
  id: 1,
  username: 'Visual Reviewer',
  role: 'admin',
  is_active: true,
  must_change_password: false,
}

const card = (index, overrides = {}) => ({
  id: `visual-card-${index}`,
  card_id: `visual-card-${index}`,
  name: index === 2 ? 'Pikachu with a deliberately long aligned card name' : `Visual card ${index}`,
  number: String(index).padStart(3, '0'),
  set_id: 'visual-set_en',
  set_name: 'Visual Set',
  set_ref: { id: 'visual-set_en', name: 'Visual Set', abbreviation: 'VIS' },
  rarity: index % 2 ? 'Illustration Rare' : 'Rare Holo',
  supertype: 'Pokemon',
  types: ['Lightning'],
  price_market: 4 + index,
  price_trend: 4 + index,
  variants_normal: true,
  variants_reverse: true,
  ...overrides,
})

const collection = Array.from({ length: 8 }, (_, offset) => {
  const index = offset + 1
  const variant = index % 3 === 0 ? 'Reverse Holo' : index % 2 === 0 ? 'Holo' : 'Normal'
  return {
    id: index,
    card_id: `visual-card-${index}`,
    quantity: index % 3 + 1,
    variant,
    condition: index % 2 ? 'NM' : 'Mint',
    lang: index % 4 === 0 ? 'de' : 'en',
    purchase_price: 2 + index / 2,
    added_at: `2026-07-${String(20 + index).padStart(2, '0')}T12:00:00`,
    card: card(index, index === 1 ? {
      custom_image_url: 'https://example.test/manual-card.webp',
    } : index === 2 ? {
      supertype: 'Trainer',
    } : index === 3 ? {
      supertype: 'Energy',
    } : index === 4 ? {
      set_id: 'second-set_en',
      set_name: 'Second Set',
      set_ref: { id: 'second-set_en', name: 'Second Set', abbreviation: 'SEC' },
    } : {}),
  }
})

const duplicates = collection.map(item => ({
  ...item.card,
  id: item.card_id,
  quantity: item.quantity + 1,
  total_value: (item.card.price_market || 0) * (item.quantity + 1),
}))

const deck = {
  id: 1,
  name: 'Visual Practice Deck',
  target_size: 40,
  description: 'A visual deck fixture',
  current_card_count: 24,
  remaining_to_target: 16,
  over_target_by: 0,
  missing_copy_count: 1,
  status: 'under',
  composition_counts: { Pokemon: 8, Trainer: 10, Energy: 6, Other: 0 },
  entries: [
    { id: 1, card_id: 'visual-card-1', required_quantity: 8, owned_quantity: 8, shortage: 0, card: card(1, { supertype: 'Pokemon' }) },
    { id: 2, card_id: 'visual-card-2', required_quantity: 10, owned_quantity: 9, shortage: 1, card: card(2, { supertype: 'Trainer' }) },
    { id: 3, card_id: 'visual-card-3', required_quantity: 6, owned_quantity: 6, shortage: 0, card: card(3, { supertype: 'Energy' }) },
  ],
  copy_limit_warnings: [{ name: 'Ultra Ball', quantity: 5 }],
}

const deckSummary = { ...deck, entries: [], copy_limit_warnings: [] }
const deckSummaries = [
  deckSummary,
  { ...deckSummary, id: 2, name: 'Complete Deck', current_card_count: 40, remaining_to_target: 0, status: 'complete', composition_counts: { Pokemon: 12, Trainer: 15, Energy: 13, Other: 0 } },
  { ...deckSummary, id: 3, name: 'Over Deck', current_card_count: 41, remaining_to_target: 0, over_target_by: 1, status: 'over', composition_counts: { Pokemon: 12, Trainer: 15, Energy: 14, Other: 0 } },
  { ...deckSummary, id: 4, name: 'Large Over Deck', current_card_count: 55, remaining_to_target: 0, over_target_by: 15, status: 'over', composition_counts: { Pokemon: 26, Trainer: 15, Energy: 14, Other: 0 } },
]

const trades = [{
  id: 7,
  partner_name: 'Misty',
  trade_date: '2026-08-08',
  notes: 'Original trade note',
  outgoing_value: 9,
  incoming_value: 14,
  value_delta: 5,
  items: [
    {
      id: 71,
      trade_id: 7,
      direction: 'outgoing',
      card_id: collection[0].card_id,
      original_collection_item_id: collection[0].id,
      quantity: 1,
      value_per_card: 9,
      value_total: 9,
      card_name: collection[0].card.name,
      set_id: collection[0].card.set_id,
      card_number: collection[0].card.number,
      variant: collection[0].variant,
      condition: collection[0].condition,
      lang: collection[0].lang,
      notes: 'Outgoing note',
      card: collection[0].card,
    },
    {
      id: 72,
      trade_id: 7,
      direction: 'incoming',
      card_id: collection[1].card_id,
      created_collection_item_id: collection[1].id,
      quantity: 1,
      value_per_card: 14,
      value_total: 14,
      card_name: collection[1].card.name,
      set_id: collection[1].card.set_id,
      card_number: collection[1].card.number,
      variant: collection[1].variant,
      condition: collection[1].condition,
      lang: collection[1].lang,
      card: collection[1].card,
    },
  ],
}]

async function installApiFixtures(page) {
  const cardBackResponse = await page.request.get('/cardback.jpg')
  const cardBack = await cardBackResponse.body()
  let assemblyProgress = []

  await page.addInitScript(user => {
    localStorage.setItem('token', 'visual-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname

    // The Vite source path /src/api/client.js also matches the broad glob.
    // Only mock actual backend requests.
    if (!path.startsWith('/api/')) {
      await route.continue()
      return
    }

    if (path.startsWith('/api/images/card/')) {
      await route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      return
    }

    if (path === '/api/decks/1/assembly-progress') {
      if (route.request().method() === 'PUT') {
        const next = route.request().postDataJSON()
        assemblyProgress = assemblyProgress.filter(item => item.entry_id !== next.entry_id).concat(next)
      } else if (route.request().method() === 'DELETE') {
        assemblyProgress = []
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'DELETE' ? { message: 'reset' } : route.request().method() === 'PUT' ? assemblyProgress.at(-1) : assemblyProgress) })
      return
    }

    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': USER,
      '/api/settings/': {
        language: 'en',
        price_primary: 'trend',
        price_display: '["trend","avg","avg1","avg7","avg30","low"]',
        tcgdex_sync_languages: 'en,de',
        currency: 'EUR',
      },
      '/api/settings/tcgdex-filter-languages': ['en', 'de'],
      '/api/collection/': collection,
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/analytics/duplicates': duplicates,
      '/api/analytics/top-movers': [],
      '/api/analytics/rarity-stats': [],
      '/api/analytics/investment-tracker': [],
      '/api/analytics/trades-summary': { trade_count: 0 },
      '/api/analytics/new-sets': [],
      '/api/products/': [],
      '/api/trades/': trades,
      '/api/decks/': deckSummaries,
      '/api/decks/1': deck,
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[path] ?? {}),
    })
  })
}

async function expectVisibleArtwork(page) {
  const artwork = page.locator('.unified-card-compact-artwork:visible')
  await expect(artwork.first()).toBeVisible()
  await expect.poll(async () => artwork.locator('img').evaluateAll(images => (
    images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)
  ))).toBe(true)
  await expect(artwork.locator('.unified-card-skeleton')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await installApiFixtures(page)
})

test('deck assembly supports desktop and mobile pulled-copy workflow', async ({ page }) => {
  await page.goto('/decks/1/build')
  await expect(page.getByRole('heading', { name: 'Build Deck: Visual Practice Deck' })).toBeVisible()
  await expect(page.getByText('Missing Cards')).toBeVisible()
  await page.getByRole('button', { name: 'Add pulled copy' }).first().click()
  await expect(page.getByRole('progressbar', { name: 'Pulled progress' })).toHaveAttribute('aria-valuenow', '1')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Add pulled copy' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Mark all owned copies pulled' }).first().click()
  await expect(page.getByRole('button', { name: 'Remove pulled copy' }).first()).toBeVisible()
})

test('real Collection list keeps shared artwork, identity, and fallback treatment', async ({ page }) => {
  await page.goto('/collection')
  await page.getByTitle('List view').click()
  await expectVisibleArtwork(page)

  await expect(page.locator(
    '.unified-card-frame[style*="--pc-card-border-image"]:visible',
  ).first()).toBeVisible()
  await expect(page.locator('main')).toHaveScreenshot('collection-list.png')
})

test('real Analytics duplicate list stays visually aligned with Collection', async ({ page }) => {
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible()
  await expectVisibleArtwork(page)
  await expect(page.locator('main')).toHaveScreenshot('analytics-duplicates.png')
})

test('trade history opens a prefilled edit draft and submits immutable values', async ({ page }) => {
  await page.goto('/trades')
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByText('Misty')).toBeVisible()
  await page.getByRole('button', { name: 'Edit' }).click()

  await expect(page.locator('input[placeholder="Trade partner"]')).toHaveValue('Misty')
  await expect(page.getByText('Edit: #7')).toBeVisible()
  await expect(page.locator('input[type="number"]:disabled')).toHaveCount(2)

  // Adding the same card again must create a new row. The backend then gives
  // that row a current-value snapshot instead of extending the historical row.
  await page.getByRole('button', { name: 'Add' }).first().click()

  // The mobile review shortcut must not cover the final fields or save action.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeVisible()
  await page.locator('#trade-finalize').scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Review trade' })).toBeHidden()

  const updateRequest = page.waitForRequest(request => (
    request.method() === 'PUT' && request.url().endsWith('/api/trades/7?price_field=price_trend')
  ))
  await page.locator('#trade-finalize').getByRole('button', { name: 'Save' }).click()
  const request = await updateRequest
  const payload = request.postDataJSON()

  expect(payload.outgoing[0]).toMatchObject({ trade_item_id: 71, quantity: 1, notes: 'Outgoing note' })
  expect(payload.outgoing[1]).toMatchObject({ collection_item_id: collection[0].id, quantity: 1 })
  expect(payload.outgoing).toHaveLength(2)
  expect(payload.incoming[0]).toMatchObject({ trade_item_id: 72, quantity: 1 })
  expect(payload.outgoing[0]).not.toHaveProperty('value_per_card')
  expect(payload.incoming[0]).not.toHaveProperty('value_per_card')
})

test('Deck editor presents a segmented gallery and keyboard-navigable viewer', async ({ page }) => {
  await page.goto('/decks/1')
  await expect(page.getByLabel('Deck composition').first()).toBeVisible()
  await expect(page.getByText('Pokemon 8')).toBeVisible()
  await expect(page.getByText('Trainer 10')).toBeVisible()
  await expect(page.getByText('Energy 6')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Visual card 1' })).toHaveCount(1)
  await expect(page.getByText('Missing: 1')).toBeVisible()
  await expect(page.getByText('Ultra Ball: 5 copies may exceed the normal 4-copy limit.', { exact: true })).toBeVisible()
  await expect(page.getByText('svgUltra Ball', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open Visual card 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Next card' }).click()
  await expect(page.getByRole('dialog', { name: 'Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('Deck list uses the shared segmented composition summary', async ({ page }) => {
  await page.goto('/decks')
  await expect(page.getByText('Visual Practice Deck')).toBeVisible()
  await expect(page.getByLabel('Deck composition').first()).toBeVisible()
  await expect(page.getByText('Pokemon 8')).toBeVisible()
  await expect(page.getByText('Trainer 10')).toBeVisible()
  await expect(page.getByText('Energy 6')).toBeVisible()
  await expect(page.getByText('16 remaining')).toBeVisible()
  await expect(page.getByText('40/40')).toBeVisible()
  await expect(page.getByText('41/40')).toBeVisible()
  await expect(page.getByText('55/40')).toBeVisible()
  await expect(page.getByText('15 over target')).toBeVisible()
  await expect(page.getByText('Pokemon 26')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toHaveCount(4)
})

test('Deck editor refetches after a failed quantity mutation', async ({ page }) => {
  await page.route('**/api/decks/1/entries/1', route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'Quantity update rejected' }),
  }))
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Increase Visual card 1 quantity' }).click()
  await expect(page.getByText('Quantity update rejected')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toBeVisible()
})

test('Deck editor batches rapid quantity changes and ignores stale responses', async ({ page }) => {
  const rapidDeck = JSON.parse(JSON.stringify(deck))
  rapidDeck.entries[0].required_quantity = 50
  rapidDeck.current_card_count = 66
  rapidDeck.over_target_by = 26
  rapidDeck.status = 'over'
  const requests = []

  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) }))
  await page.route('**/api/decks/1/entries/1', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    if (requests.length === 1) await new Promise(resolve => setTimeout(resolve, 300))
    rapidDeck.entries[0].required_quantity = quantity
    rapidDeck.current_card_count = quantity + 16
    rapidDeck.over_target_by = rapidDeck.current_card_count - 40
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) })
  })

  await page.goto('/decks/1')
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect.poll(() => requests).toEqual([55])
  await increase.evaluate(button => { for (let count = 0; count < 5; count += 1) button.click() })
  await expect(page.getByText('x60', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([55, 60])
  await expect(page.getByText('x60', { exact: true })).toBeVisible()

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByText('x45', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([55, 60, 45])
})

test('Deck editor preserves rapid quantity changes above a 60-card target', async ({ page }) => {
  const rapidDeck = JSON.parse(JSON.stringify(deck))
  rapidDeck.target_size = 60
  rapidDeck.entries[0].required_quantity = 50
  rapidDeck.current_card_count = 66
  rapidDeck.over_target_by = 6
  rapidDeck.status = 'over'
  const requests = []

  await page.route('**/api/decks/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) }))
  await page.route('**/api/decks/1/entries/1', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    rapidDeck.entries[0].required_quantity = quantity
    rapidDeck.current_card_count = quantity + 16
    rapidDeck.over_target_by = Math.max(rapidDeck.current_card_count - 60, 0)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rapidDeck) })
  })

  await page.goto('/decks/1')
  const increase = page.getByRole('button', { name: 'Increase Visual card 1 quantity' })
  await increase.evaluate(button => { for (let count = 0; count < 20; count += 1) button.click() })
  await expect(page.getByText('x70', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([70])

  const decrease = page.getByRole('button', { name: 'Decrease Visual card 1 quantity' })
  await decrease.evaluate(button => { for (let count = 0; count < 15; count += 1) button.click() })
  await expect(page.getByText('x55', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([70, 55])
})

test('Deck picker batches rapid adds without detail refetches', async ({ page }) => {
  const updatedDeck = JSON.parse(JSON.stringify(deck))
  const requests = []
  let detailGets = 0
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/decks/1') detailGets += 1
  })
  await page.route('**/api/decks/1/entries', async route => {
    const quantity = route.request().postDataJSON().required_quantity
    requests.push(quantity)
    updatedDeck.entries.push({ id: 4, card_id: 'visual-card-4', required_quantity: quantity, owned_quantity: 2, shortage: Math.max(quantity - 2, 0), card: collection[3].card })
    updatedDeck.current_card_count = 24 + quantity
    updatedDeck.over_target_by = Math.max(updatedDeck.current_card_count - 40, 0)
    updatedDeck.status = updatedDeck.over_target_by ? 'over' : 'under'
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updatedDeck) })
  })
  await page.goto('/decks/1')
  const add = page.getByRole('button', { name: 'Add Visual card 4' })
  await add.evaluate(button => { for (let count = 0; count < 30; count += 1) button.click() })
  await expect(page.getByText('In deck: 30', { exact: true })).toBeVisible()
  await expect.poll(() => requests).toEqual([30])
  expect(detailGets).toBe(1)
})

test('Deck picker reports a rate-limit response and remains usable', async ({ page }) => {
  await page.route('**/api/decks/1/entries', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Rate limit exceeded: 60 per 1 minute' }) }))
  await page.goto('/decks/1')
  await page.getByRole('button', { name: 'Add Visual card 4' }).click()
  await expect(page.getByText('Too many requests. Please wait a moment and try again.')).toBeVisible()
  await expect(page.getByLabel('Deck composition')).toBeVisible()
})

test('Deck editor filters the owned-card browser and requires an explicit add action', async ({ page }) => {
  await page.goto('/decks/1')

  await page.getByLabel('Filter by type').selectOption('Trainer')
  await expect(page.getByRole('button', { name: 'Preview Pikachu with a deliberately long aligned card name' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview Visual card 1' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Preview Pikachu with a deliberately long aligned card name' }).click()
  await expect(page.getByRole('button', { name: 'Add to deck' })).toBeVisible()
  const addRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/api/decks/1/entries/2'))
  await page.getByRole('button', { name: 'Add to deck' }).click()
  expect((await addRequest).postDataJSON()).toEqual({ required_quantity: 11 })
})

test('Deck editor opens a selected card preview in a mobile sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/decks/1')

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview Visual card 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Visual card 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add to deck' })).toBeVisible()
})
