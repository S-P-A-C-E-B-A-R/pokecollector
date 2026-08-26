import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from database import get_db
from models import Card, CollectionItem, Deck, DeckAssemblyProgress, DeckEntry, User
from schemas import DeckAssemblyProgressResponse, DeckAssemblyProgressUpdate, DeckCreate, DeckEntryCreate, DeckEntryUpdate, DeckResponse, DeckUpdate
from services.deck_validation import is_basic_energy, validate_deck
from services.deck_analysis import analyze_deck
from services.standard_legality import is_standard_regulation_mark

router = APIRouter()


COMPOSITION_CATEGORIES = ("Pokemon", "Trainer", "Energy", "Other")


def _composition_category(supertype: str | None) -> str:
    normalized = str(supertype or "").strip().casefold()
    if normalized in ("pokemon", "pokémon"):
        return "Pokemon"
    if normalized == "trainer":
        return "Trainer"
    if normalized == "energy":
        return "Energy"
    return "Other"


def _deck_or_404(db: Session, deck_id: int, user_id: int, with_entries: bool = False) -> Deck:
    query = db.query(Deck).filter(Deck.id == deck_id, Deck.user_id == user_id)
    if with_entries:
        query = query.options(joinedload(Deck.entries).joinedload(DeckEntry.card).joinedload(Card.set_ref))
    deck = query.first()
    if not deck:
        raise HTTPException(status_code=404, detail="Deck not found")
    return deck


def _owned_quantities(db: Session, user_id: int, card_ids: list[str]) -> dict[str, int]:
    if not card_ids:
        return {}
    return {
        card_id: int(quantity or 0)
        for card_id, quantity in db.query(
            CollectionItem.card_id,
            func.coalesce(func.sum(CollectionItem.quantity), 0),
        ).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id.in_(card_ids),
        ).group_by(CollectionItem.card_id).all()
    }


def _standard_legal_fingerprints(db: Session) -> set[str]:
    return {
        fingerprint
        for fingerprint, regulation_mark in db.query(Card.playable_fingerprint, Card.regulation_mark).filter(
            Card.is_custom.is_(False),
            Card.playable_fingerprint.isnot(None),
            Card.regulation_mark.isnot(None),
        ).all()
        if fingerprint and is_standard_regulation_mark(regulation_mark)
    }


def _copy_limit_warnings(entries: list[DeckEntry]) -> list[dict]:
    """Warn only when every printing in a name group has usable gameplay metadata."""
    groups: dict[str, list[DeckEntry]] = {}
    for entry in entries:
        if entry.card and entry.card.name:
            groups.setdefault(entry.card.name, []).append(entry)

    warnings = []
    for name, named_entries in groups.items():
        cards = [entry.card for entry in named_entries]
        if any(not card or not card.supertype for card in cards):
            continue
        basic_energy = all(is_basic_energy(card) for card in cards)
        quantity = sum(int(entry.required_quantity or 0) for entry in named_entries)
        if quantity > 4 and not basic_energy:
            warnings.append({"name": name, "quantity": quantity})
    return sorted(warnings, key=lambda warning: warning["name"].lower())


def _deck_response(deck: Deck, owned_quantities: dict[str, int] | None = None, include_entries: bool = True, standard_legal_fingerprints: set[str] | None = None) -> DeckResponse:
    entries = list(deck.entries) if include_entries else []
    if owned_quantities is None:
        owned_quantities = {}
    current_card_count = sum(int(entry.required_quantity or 0) for entry in entries)
    composition_counts = {category: 0 for category in COMPOSITION_CATEGORIES}
    for entry in entries:
        composition_counts[_composition_category(entry.card.supertype if entry.card else None)] += int(entry.required_quantity or 0)
    missing_copy_count = sum(
        max(int(entry.required_quantity or 0) - int(owned_quantities.get(entry.card_id, 0)), 0)
        for entry in entries
    )
    if current_card_count < deck.target_size:
        status = "under"
    elif current_card_count > deck.target_size:
        status = "over"
    else:
        status = "complete"

    return DeckResponse(
        id=deck.id,
        name=deck.name,
        target_size=deck.target_size,
        description=deck.description,
        format=deck.format or "Casual",
        created_at=deck.created_at,
        updated_at=deck.updated_at,
        current_card_count=current_card_count,
        remaining_to_target=max(deck.target_size - current_card_count, 0),
        over_target_by=max(current_card_count - deck.target_size, 0),
        missing_copy_count=missing_copy_count,
        status=status,
        composition_counts=composition_counts,
        entries=[
            {
                "id": entry.id,
                "card_id": entry.card_id,
                "required_quantity": entry.required_quantity,
                "owned_quantity": int(owned_quantities.get(entry.card_id, 0)),
                "shortage": max(entry.required_quantity - int(owned_quantities.get(entry.card_id, 0)), 0),
                "card": entry.card,
            }
            for entry in entries
        ],
        copy_limit_warnings=_copy_limit_warnings(entries),
        validation=validate_deck(deck, owned_quantities, standard_legal_fingerprints),
        analysis=analyze_deck(deck),
    )


@router.get("/", response_model=list[DeckResponse])
def get_decks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    decks = db.query(Deck).options(joinedload(Deck.entries).joinedload(DeckEntry.card)).filter(Deck.user_id == current_user.id).order_by(Deck.updated_at.desc(), Deck.id.desc()).all()
    if not decks:
        return []

    deck_ids = [deck.id for deck in decks]
    owned_quantities = _owned_quantities(db, current_user.id, [entry.card_id for deck in decks for entry in deck.entries])
    standard_legal_fingerprints = _standard_legal_fingerprints(db)
    totals = {
        deck_id: int(quantity or 0)
        for deck_id, quantity in db.query(DeckEntry.deck_id, func.coalesce(func.sum(DeckEntry.required_quantity), 0)).filter(
            DeckEntry.deck_id.in_(deck_ids)
        ).group_by(DeckEntry.deck_id).all()
    }
    composition_counts = {deck_id: {category: 0 for category in COMPOSITION_CATEGORIES} for deck_id in deck_ids}
    for deck_id, supertype, quantity in db.query(
        DeckEntry.deck_id,
        Card.supertype,
        func.coalesce(func.sum(DeckEntry.required_quantity), 0),
    ).join(Card, DeckEntry.card_id == Card.id).filter(
        DeckEntry.deck_id.in_(deck_ids)
    ).group_by(DeckEntry.deck_id, Card.supertype).all():
        composition_counts[deck_id][_composition_category(supertype)] += int(quantity or 0)
    owned = db.query(
        CollectionItem.card_id.label("card_id"),
        func.coalesce(func.sum(CollectionItem.quantity), 0).label("owned_quantity"),
    ).filter(CollectionItem.user_id == current_user.id).group_by(CollectionItem.card_id).subquery()
    shortages = {
        deck_id: int(quantity or 0)
        for deck_id, quantity in db.query(
            DeckEntry.deck_id,
            func.coalesce(func.sum(case(
                (DeckEntry.required_quantity > func.coalesce(owned.c.owned_quantity, 0),
                 DeckEntry.required_quantity - func.coalesce(owned.c.owned_quantity, 0)),
                else_=0,
            )), 0),
        ).outerjoin(owned, DeckEntry.card_id == owned.c.card_id).filter(
            DeckEntry.deck_id.in_(deck_ids)
        ).group_by(DeckEntry.deck_id).all()
    }
    responses = []
    for deck in decks:
        current_card_count = totals.get(deck.id, 0)
        status = "under" if current_card_count < deck.target_size else "over" if current_card_count > deck.target_size else "complete"
        responses.append(DeckResponse(
            id=deck.id,
            name=deck.name,
            target_size=deck.target_size,
            description=deck.description,
            format=deck.format or "Casual",
            created_at=deck.created_at,
            updated_at=deck.updated_at,
            current_card_count=current_card_count,
            remaining_to_target=max(deck.target_size - current_card_count, 0),
            over_target_by=max(current_card_count - deck.target_size, 0),
            missing_copy_count=shortages.get(deck.id, 0),
            status=status,
            composition_counts=composition_counts[deck.id],
            validation=validate_deck(deck, owned_quantities, standard_legal_fingerprints),
        ))
    return responses


@router.post("/", response_model=DeckResponse)
def create_deck(payload: DeckCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = Deck(name=payload.name.strip(), target_size=payload.target_size, description=payload.description, format=payload.format, user_id=current_user.id)
    if not deck.name:
        raise HTTPException(status_code=422, detail="Deck name is required")
    db.add(deck)
    db.commit()
    db.refresh(deck)
    return _deck_response(deck, standard_legal_fingerprints=_standard_legal_fingerprints(db))


@router.get("/{deck_id}", response_model=DeckResponse)
def get_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    owned_quantities = _owned_quantities(db, current_user.id, [entry.card_id for entry in deck.entries])
    return _deck_response(deck, owned_quantities, standard_legal_fingerprints=_standard_legal_fingerprints(db))


@router.get("/{deck_id}/assembly-progress", response_model=list[DeckAssemblyProgressResponse])
def get_deck_assembly_progress(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    return [
        {"entry_id": entry_id, "pulled_quantity": pulled_quantity}
        for entry_id, pulled_quantity in db.query(DeckAssemblyProgress.deck_entry_id, DeckAssemblyProgress.pulled_quantity).join(
            DeckEntry, DeckAssemblyProgress.deck_entry_id == DeckEntry.id
        ).filter(DeckEntry.deck_id == deck.id).all()
    ]


@router.put("/{deck_id}/assembly-progress", response_model=DeckAssemblyProgressResponse)
def update_deck_assembly_progress(deck_id: int, payload: DeckAssemblyProgressUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    entry = db.query(DeckEntry).filter(DeckEntry.id == payload.entry_id, DeckEntry.deck_id == deck.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    owned = _owned_quantities(db, current_user.id, [entry.card_id]).get(entry.card_id, 0)
    pulled_quantity = min(payload.pulled_quantity, entry.required_quantity, owned)
    progress = db.query(DeckAssemblyProgress).filter(DeckAssemblyProgress.deck_entry_id == entry.id).first()
    if progress:
        progress.pulled_quantity = pulled_quantity
    else:
        progress = DeckAssemblyProgress(deck_entry_id=entry.id, pulled_quantity=pulled_quantity)
        db.add(progress)
    db.commit()
    return {"entry_id": entry.id, "pulled_quantity": pulled_quantity}


@router.delete("/{deck_id}/assembly-progress")
def reset_deck_assembly_progress(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    db.query(DeckAssemblyProgress).filter(DeckAssemblyProgress.deck_entry_id.in_(
        db.query(DeckEntry.id).filter(DeckEntry.deck_id == deck.id)
    )).delete(synchronize_session=False)
    db.commit()
    return {"message": "Deck assembly progress reset"}


@router.patch("/{deck_id}", response_model=DeckResponse)
def update_deck(deck_id: int, payload: DeckUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    if payload.name is not None:
        deck.name = payload.name.strip()
        if not deck.name:
            raise HTTPException(status_code=422, detail="Deck name is required")
    if payload.target_size is not None:
        deck.target_size = payload.target_size
    fields_set = getattr(payload, "model_fields_set", None)
    if fields_set is None:
        fields_set = payload.__fields_set__
    if "description" in fields_set:
        deck.description = payload.description
    if "format" in fields_set:
        deck.format = payload.format
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    db.refresh(deck)
    owned_quantities = _owned_quantities(db, current_user.id, [entry.card_id for entry in deck.entries])
    return _deck_response(deck, owned_quantities, standard_legal_fingerprints=_standard_legal_fingerprints(db))


@router.delete("/{deck_id}")
def delete_deck(deck_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    db.delete(deck)
    db.commit()
    return {"message": "Deck deleted"}


@router.post("/{deck_id}/entries", response_model=DeckResponse)
def add_deck_entry(deck_id: int, payload: DeckEntryCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id, with_entries=True)
    entry = next((entry for entry in deck.entries if entry.card_id == payload.card_id), None)
    if entry:
        entry.required_quantity += payload.required_quantity
    else:
        card = db.query(Card).filter(Card.id == payload.card_id).first()
        if not card:
            raise HTTPException(status_code=404, detail="Card not found")
        if card.is_custom and card.custom_owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Card not found")
        if not _owned_quantities(db, current_user.id, [payload.card_id]).get(payload.card_id):
            raise HTTPException(status_code=422, detail="Add cards you own to a new deck entry")
        entry = DeckEntry(deck_id=deck.id, card_id=card.id, required_quantity=payload.required_quantity)
        db.add(entry)
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.patch("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def update_deck_entry(deck_id: int, entry_id: int, payload: DeckEntryUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    entry = db.query(DeckEntry).filter(DeckEntry.id == entry_id, DeckEntry.deck_id == deck.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    entry.required_quantity = payload.required_quantity
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)


@router.delete("/{deck_id}/entries/{entry_id}", response_model=DeckResponse)
def delete_deck_entry(deck_id: int, entry_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    deck = _deck_or_404(db, deck_id, current_user.id)
    entry = db.query(DeckEntry).filter(DeckEntry.id == entry_id, DeckEntry.deck_id == deck.id).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Deck entry not found")
    db.delete(entry)
    deck.updated_at = datetime.datetime.utcnow()
    db.commit()
    return get_deck(deck_id, current_user, db)
