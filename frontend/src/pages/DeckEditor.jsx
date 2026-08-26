import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { deleteDeck, deleteDeckEntry, getCollection, getDeck, updateDeck } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useDeckQuantitySync } from '../hooks/useDeckQuantitySync'
import DeckCompositionBar from '../components/decks/DeckCompositionBar'
import DeckCardGallery from '../components/decks/DeckCardGallery'
import DeckCardViewer from '../components/decks/DeckCardViewer'
import DeckCollectionPicker from '../components/decks/DeckCollectionPicker'
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
  const [viewerIndex, setViewerIndex] = useState(null)
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const { data: deck, isLoading } = useQuery({ queryKey: ['deck', deckId], queryFn: () => getDeck(deckId).then(response => response.data) })
  const { data: collection = [] } = useQuery({ queryKey: ['deck-picker-collection'], queryFn: () => getCollection({}).then(response => response.data) })

  const onSuccess = () => invalidateDeck(queryClient, deckId)
  const updateMutation = useMutation({ mutationFn: data => updateDeck(deckId, data), onSuccess: () => { onSuccess(); toast.success(t('decks.updated')) }, onError: error => toast.error(error.response?.data?.detail || t('decks.updateFailed')) })
  const showDeckMutationError = error => toast.error(error.response?.status === 429 ? t('decks.tooManyRequests') : error.response?.data?.detail || error.response?.data?.error || t('common.error'))
  const handleDeckMutationError = error => { onSuccess(); showDeckMutationError(error) }
  const removeMutation = useMutation({ mutationFn: entryId => deleteDeckEntry(deckId, entryId), onSuccess, onError: handleDeckMutationError })
  const deleteMutation = useMutation({ mutationFn: () => deleteDeck(deckId), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['decks'] }); navigate('/decks') }, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const { optimisticQuantities, pendingEntryIds, changeQuantity, addCard, optimisticAddQuantities, pendingCardIds } = useDeckQuantitySync({ deckId, queryClient, onError: showDeckMutationError })

  if (isLoading) return <div className="skeleton h-96 rounded-xl" />
  if (!deck) return null

  const entries = sortDeckEntries(deck.entries.map(entry => optimisticQuantities[entry.id] === undefined ? entry : { ...entry, required_quantity: optimisticQuantities[entry.id] }))
  const progress = { ...deckProgress({ ...deck, current_card_count: entries.reduce((total, entry) => total + entry.required_quantity, 0) }), missing: deck.missing_copy_count }
  const saveDetails = event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    updateMutation.mutate({ name: form.get('name'), description: form.get('description') || null, target_size: Number(form.get('target_size')) })
  }
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_36rem]">
        <section className="order-2 space-y-3 lg:order-1">
          <DeckCompositionBar entries={entries} progress={progress} t={t} label={label} />
          {deck.copy_limit_warnings?.length > 0 && <div className="rounded-xl border border-yellow/30 bg-yellow/10 p-3 text-xs text-yellow">{deck.copy_limit_warnings.map(warning => <p key={warning.name} className="flex gap-2"><AlertTriangle size={14} aria-hidden="true" /><span>{label('decks.copyWarning', { name: warning.name, count: warning.quantity })}</span></p>)}</div>}
          <DeckCardGallery
            entries={entries}
            onOpen={setViewerIndex}
            onQuantityChange={(entry, delta) => changeQuantity(entry.id, entry.required_quantity, delta)}
            onRemove={entry => removeMutation.mutate(entry.id)}
            pendingEntryIds={pendingEntryIds}
            isRemoving={removeMutation.isPending}
            t={t}
            label={label}
          />
        </section>

        <aside className="order-1 lg:order-2 lg:sticky lg:top-20 lg:self-start">
          <DeckCollectionPicker collection={collection} entries={entries} onAdd={cardId => addCard(cardId, entries.find(entry => entry.card_id === cardId))} optimisticAddQuantities={optimisticAddQuantities} pendingCardIds={pendingCardIds} t={t} label={label} />
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
