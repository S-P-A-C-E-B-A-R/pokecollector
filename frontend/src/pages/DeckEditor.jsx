import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { addDeckEntry, deleteDeck, deleteDeckEntry, getCollection, getDeck, updateDeck, updateDeckEntry } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { CollectionCardDisplay } from '../components/CollectionCardImage'
import DeckCompositionBar from '../components/decks/DeckCompositionBar'
import DeckCardGallery from '../components/decks/DeckCardGallery'
import DeckCardViewer from '../components/decks/DeckCardViewer'
import { deckProgress, nextDeckCardIndex, previousDeckCardIndex, sortDeckEntries } from '../utils/deckProgress'

function invalidateDeck(queryClient, deckId) {
  queryClient.invalidateQueries({ queryKey: ['decks'] })
  queryClient.invalidateQueries({ queryKey: ['deck', String(deckId)] })
}

export default function DeckEditor() {
  const { deckId } = useParams()
  const { t } = useSettings()
  const navigate = useNavigate()
  const confirm = useConfirmDialog()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [viewerIndex, setViewerIndex] = useState(null)
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const { data: deck, isLoading } = useQuery({ queryKey: ['deck', deckId], queryFn: () => getDeck(deckId).then(response => response.data) })
  const { data: collection = [] } = useQuery({ queryKey: ['deck-picker-collection'], queryFn: () => getCollection({}).then(response => response.data) })

  const ownedCards = useMemo(() => Object.values(collection.reduce((cards, item) => {
    const card = item.card || item
    if (!card?.id) return cards
    cards[card.id] = cards[card.id]
      ? { ...cards[card.id], quantity: cards[card.id].quantity + Number(item.quantity || 0) }
      : { ...item, card, quantity: Number(item.quantity || 0) }
    return cards
  }, {})).filter(item => item.quantity > 0 && `${item.card.name} ${item.card.id} ${item.card.set?.name || ''}`.toLowerCase().includes(search.toLowerCase())), [collection, search])

  const onSuccess = () => invalidateDeck(queryClient, deckId)
  const updateMutation = useMutation({ mutationFn: data => updateDeck(deckId, data), onSuccess: () => { onSuccess(); toast.success(t('decks.updated')) }, onError: error => toast.error(error.response?.data?.detail || t('decks.updateFailed')) })
  const addMutation = useMutation({ mutationFn: data => addDeckEntry(deckId, data), onSuccess, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const quantityMutation = useMutation({ mutationFn: ({ entryId, required_quantity }) => updateDeckEntry(deckId, entryId, { required_quantity }), onSuccess, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const removeMutation = useMutation({ mutationFn: entryId => deleteDeckEntry(deckId, entryId), onSuccess, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const deleteMutation = useMutation({ mutationFn: () => deleteDeck(deckId), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['decks'] }); navigate('/decks') }, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })

  if (isLoading) return <div className="skeleton h-96 rounded-xl" />
  if (!deck) return null

  const progress = { ...deckProgress(deck), missing: deck.missing_copy_count }
  const entries = sortDeckEntries(deck.entries)
  const saveDetails = event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    updateMutation.mutate({ name: form.get('name'), description: form.get('description') || null, target_size: Number(form.get('target_size')) })
  }
  const changeQuantity = (entry, requiredQuantity) => quantityMutation.mutate({ entryId: entry.id, required_quantity: requiredQuantity })
  const previousCard = () => setViewerIndex(index => previousDeckCardIndex(index, entries.length))
  const nextCard = () => setViewerIndex(index => nextDeckCardIndex(index, entries.length))

  return (
    <div className="space-y-4 pb-6">
      <div className="flex items-center justify-between gap-2">
        <button className="btn-ghost" onClick={() => navigate('/decks')}><ArrowLeft size={16} /> {t('common.back')}</button>
        <button className="btn-ghost text-brand-red" onClick={async () => { if (await confirm({ title: t('common.delete'), message: label('decks.deleteConfirm', { name: deck.name }) })) deleteMutation.mutate() }}><Trash2 size={15} /> {t('common.delete')}</button>
      </div>

      <form onSubmit={saveDetails} className="card grid gap-3 md:grid-cols-[1fr_10rem_auto] md:items-end">
        <label className="text-xs text-text-muted">{t('decks.name')}<input name="name" className="input mt-1" defaultValue={deck.name} required /></label>
        <label className="text-xs text-text-muted">{t('decks.target')}<select name="target_size" className="select mt-1" defaultValue={deck.target_size}>{[20, 40, 60].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
        <button className="btn-primary" disabled={updateMutation.isPending}>{t('common.save')}</button>
        <label className="text-xs text-text-muted md:col-span-3">{t('decks.description')}<input name="description" className="input mt-1" defaultValue={deck.description || ''} /></label>
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="order-2 space-y-3 lg:order-1">
          <DeckCompositionBar entries={entries} progress={progress} t={t} label={label} />
          {deck.copy_limit_warnings?.length > 0 && <div className="rounded-xl border border-yellow/30 bg-yellow/10 p-3 text-xs text-yellow">{deck.copy_limit_warnings.map(warning => <p key={warning.name} className="flex gap-2"><AlertTriangle size={14} />{label('decks.copyWarning', warning)}</p>)}</div>}
          <DeckCardGallery
            entries={entries}
            onOpen={setViewerIndex}
            onQuantityChange={changeQuantity}
            onRemove={entry => removeMutation.mutate(entry.id)}
            isUpdating={quantityMutation.isPending || removeMutation.isPending}
            t={t}
            label={label}
          />
        </section>

        <aside className="card order-1 space-y-3 lg:order-2 lg:sticky lg:top-20 lg:self-start">
          <div className="flex items-center gap-2"><Plus size={16} className="text-brand-red" /><h2 className="font-semibold text-text-primary">{t('decks.addCards')}</h2></div>
          <input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('decks.searchOwned')} />
          <div className="max-h-[28rem] space-y-2 overflow-y-auto">
            {ownedCards.map(item => <button key={item.card.id} className="flex w-full items-center gap-2 rounded-lg p-1 text-left hover:bg-bg-elevated" disabled={addMutation.isPending} onClick={() => addMutation.mutate({ card_id: item.card.id, required_quantity: 1 })}>
              <div className="w-11 shrink-0"><CollectionCardDisplay variant="artwork" item={item} card={item.card} alt={item.card.name} /></div>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-text-primary">{item.card.name}</span><span className="block truncate text-[11px] text-text-muted">{item.card.set_ref?.name || item.card.set_id || ''} {item.card.number || ''} · {item.card.lang || item.lang || ''}</span><span className="text-[11px] text-text-muted">{label('decks.owned', { count: item.quantity })}</span></span><Plus size={15} className="text-brand-red" />
            </button>)}
            {ownedCards.length === 0 && <p className="py-4 text-center text-xs text-text-muted">{t('decks.noOwnedCards')}</p>}
          </div>
        </aside>
      </div>

      <DeckCardViewer
        entries={entries}
        activeIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onPrevious={previousCard}
        onNext={nextCard}
        t={t}
        label={label}
      />
    </div>
  )
}
